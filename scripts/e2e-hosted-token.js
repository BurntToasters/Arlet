// Local stand-in for Arlet's hosted MusicKit token file, for native E2E runs.
// Each run generates two throwaway minisign keys in a private temp directory,
// signs token files with them, and serves those files from 127.0.0.1 in the
// hosted shape: { version, token, signature }. close() stops the server and
// deletes the keys; the harness calls it on every path.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHostedTokenFile,
  signMusicKitTokenPayload,
} from "./publish-musickit-token.js";
import { signedMusicKitTokenPayload } from "./release-preflight.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CLI = path.join(
  root,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const TOKEN_PATH = "/arlet-token.json";
const DAY_SECONDS = 86_400;
const GENERATE_TIMEOUT_MS = 60_000;

/**
 * What the server answers. "stopped" is not a mode: stop() closes the listener,
 * so the app sees a refused connection.
 */
export const HOSTED_TOKEN_MODES = Object.freeze([
  "valid",
  "badSignature",
  "older",
  "missing",
]);

const encodeSegment = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An ES256 JWT with an integer exp and no origin claim. The JWT's own
 * signature segment is a dummy: Arlet checks the minisign signature over the
 * whole token, and only the hosted file's signature proves it came from here.
 */
export function syntheticMusicKitToken({ exp }) {
  return [
    encodeSegment({ alg: "ES256", kid: "E2E" }),
    encodeSegment({ iss: "E2E", exp, jti: crypto.randomUUID() }),
    Buffer.from("e2e-signature").toString("base64url"),
  ].join(".");
}

/**
 * Generates a throwaway minisign key with `tauri signer generate`. The
 * generator's output is never echoed: it contains the key and the password.
 */
function generateSigningKey(dir, name) {
  const keyPath = path.join(dir, `${name}.key`);
  const password = crypto.randomBytes(24).toString("hex");
  const result = spawnSync(
    process.execPath,
    [
      TAURI_CLI,
      "signer",
      "generate",
      "--ci",
      "-p",
      password,
      "-w",
      keyPath,
      "-f",
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GENERATE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not generate a throwaway signing key (exit ${result.status ?? result.error?.code ?? "unknown"})`,
    );
  }
  const privateKey = fs.readFileSync(keyPath, "utf8").trim();
  // The .pub file is base64 of minisign text, the format plugins.updater.pubkey
  // uses in tauri.conf.json, so it is passed to Arlet unchanged.
  const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  if (
    !Buffer.from(publicKey, "base64")
      .toString("utf8")
      .startsWith("untrusted comment:")
  ) {
    throw new Error("the generated public key is not a minisign key");
  }
  return { privateKey, password, publicKey };
}

/** Signs with the throwaway key only, never with a key from the environment. */
function signingEnv(key) {
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: key.privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: key.password,
  };
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  return env;
}

function signTokenFile(key, token) {
  const signature = signMusicKitTokenPayload({
    payload: signedMusicKitTokenPayload(token),
    env: signingEnv(key),
  });
  return buildHostedTokenFile({ token, signature });
}

/**
 * Starts the fixture for one run. `realToken` (from --real-token) becomes the
 * "valid" token; every other token is synthetic. Tokens:
 *   valid  exp +120 days, served in "valid" mode and cached by the app
 *   older  exp +60 days, served in "older" mode (must not replace a newer cache)
 *   newer  exp +200 days, seeded as a cache by the checks, never served
 *   bad    exp +120 days, served in "badSignature" mode, signed by another key
 */
export async function startHostedTokenFixture({
  realToken = "",
  tempRoot = os.tmpdir(),
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const dir = fs.mkdtempSync(path.join(tempRoot, "arlet-e2e-token-"));
  let server = null;
  const stopServer = () =>
    new Promise((resolve) => {
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
  try {
    const signing = generateSigningKey(dir, "signing");
    const impostor = generateSigningKey(dir, "impostor");
    const tokens = {
      valid:
        realToken ||
        syntheticMusicKitToken({ exp: nowSeconds + 120 * DAY_SECONDS }),
      older: syntheticMusicKitToken({ exp: nowSeconds + 60 * DAY_SECONDS }),
      newer: syntheticMusicKitToken({ exp: nowSeconds + 200 * DAY_SECONDS }),
      bad: syntheticMusicKitToken({ exp: nowSeconds + 120 * DAY_SECONDS }),
    };
    const signedByFixture = new Map();
    const signFile = (token) => {
      if (!signedByFixture.has(token)) {
        signedByFixture.set(token, signTokenFile(signing, token));
      }
      return signedByFixture.get(token);
    };
    const files = {
      valid: signFile(tokens.valid),
      older: signFile(tokens.older),
      badSignature: signTokenFile(impostor, tokens.bad),
    };
    const requests = Object.fromEntries(
      HOSTED_TOKEN_MODES.map((name) => [name, 0]),
    );
    let mode = "valid";
    server = http.createServer((request, response) => {
      if (request.method !== "GET" || request.url !== TOKEN_PATH) {
        response.writeHead(404, { Connection: "close" });
        response.end();
        return;
      }
      requests[mode] += 1;
      if (mode === "missing") {
        response.writeHead(404, {
          "Content-Type": "text/plain",
          Connection: "close",
        });
        response.end("not found");
        return;
      }
      const body = files[mode];
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        Connection: "close",
      });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    return {
      url: `http://127.0.0.1:${port}${TOKEN_PATH}`,
      publicKey: signing.publicKey,
      tokens,
      requests,
      get mode() {
        return mode;
      },
      setMode(next) {
        if (!HOSTED_TOKEN_MODES.includes(next)) {
          throw new Error(`unknown hosted token mode: ${next}`);
        }
        mode = next;
      },
      /** A file signed with the fixture key, for seeding the app's cache. */
      signFile,
      /** Closes the listener, so the app's next download is refused. */
      stop: stopServer,
      /** Stops the server and deletes the keys. Safe to call more than once. */
      async close() {
        await stopServer();
        fs.rmSync(dir, { recursive: true, force: true });
        return {
          serverStopped: !server.listening,
          keyRemoved: !fs.existsSync(dir),
        };
      },
    };
  } catch (error) {
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
