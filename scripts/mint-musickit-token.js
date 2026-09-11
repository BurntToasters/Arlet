#!/usr/bin/env node
// Mint a local MusicKit developer JWT from a Media Services .p8 that lives
// outside the repository. Never prints the token or private key. Writes
// MUSICKIT_DEVELOPER_TOKEN into `.env` for debug `tauri:dev` only.

import { createPrivateKey, createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, repoRoot } from "./phase0-preflight.js";

export const TOKEN_ENV_KEY = "MUSICKIT_DEVELOPER_TOKEN";
export const MAX_TTL_SECONDS = 180 * 24 * 60 * 60;
export const DEFAULT_TTL_SECONDS = 120 * 24 * 60 * 60;

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function mintMusicKitDeveloperToken(options) {
  const teamId = String(options.teamId ?? "").trim();
  const keyId = String(options.keyId ?? "").trim();
  const privateKeyPem = String(options.privateKeyPem ?? "");
  const nowMs = options.nowMs ?? Date.now();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!/^[A-Z0-9]{10}$/iu.test(teamId)) {
    throw new Error("MUSICKIT_TEAM_ID must be the 10-character Apple Team ID.");
  }
  if (!/^[A-Z0-9]{10}$/iu.test(keyId)) {
    throw new Error(
      "MUSICKIT_KEY_ID must be the 10-character Media Services key ID.",
    );
  }
  if (ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(
      `Token TTL must be between 60 seconds and ${MAX_TTL_SECONDS} seconds (Apple's 6-month max).`,
    );
  }
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("MUSICKIT_P8_PATH must point to a PKCS#8 .p8 private key.");
  }
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const header = b64urlJson({ alg: "ES256", kid: keyId });
  const payload = b64urlJson({ iss: teamId, iat, exp });
  const unsigned = `${header}.${payload}`;
  const key = createPrivateKey(privateKeyPem);
  const signature = createSign("SHA256")
    .update(unsigned)
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return {
    token: `${unsigned}.${Buffer.from(signature).toString("base64url")}`,
    iat,
    exp,
  };
}

export function assertP8OutsideRepo(p8Path, root = repoRoot) {
  if (!path.isAbsolute(p8Path)) {
    throw new Error(
      "MUSICKIT_P8_PATH must be an absolute path outside the repository.",
    );
  }
  const resolved = path.resolve(p8Path);
  const repo = path.resolve(root);
  const prefix = repo.endsWith(path.sep) ? repo : `${repo}${path.sep}`;
  if (resolved === repo || resolved.startsWith(prefix)) {
    throw new Error(
      "MUSICKIT_P8_PATH must be outside the repository. Media Services .p8 keys are never committed.",
    );
  }
  return resolved;
}

export function upsertEnvKey(filePath, key, value) {
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) {
    text = text.replace(pattern, () => line);
  } else {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += `${line}\n`;
  }
  fs.writeFileSync(filePath, text);
}

export function resolveMintInput(env, root = repoRoot) {
  const teamId = String(env.MUSICKIT_TEAM_ID ?? "").trim();
  const keyId = String(env.MUSICKIT_KEY_ID ?? "").trim();
  const p8Path = String(env.MUSICKIT_P8_PATH ?? "").trim();
  const ttlRaw = String(env.MUSICKIT_TOKEN_TTL_SECONDS ?? "").trim();
  const ttlSeconds = ttlRaw ? Number.parseInt(ttlRaw, 10) : DEFAULT_TTL_SECONDS;
  if (!teamId || !keyId || !p8Path) {
    throw new Error(
      "Set MUSICKIT_TEAM_ID, MUSICKIT_KEY_ID, and MUSICKIT_P8_PATH in .env, then run npm run phase0:mint-token.",
    );
  }
  if (!Number.isFinite(ttlSeconds)) {
    throw new Error("MUSICKIT_TOKEN_TTL_SECONDS must be an integer.");
  }
  const resolvedP8 = assertP8OutsideRepo(p8Path, root);
  if (!fs.existsSync(resolvedP8)) {
    throw new Error("MUSICKIT_P8_PATH does not exist.");
  }
  return { teamId, keyId, p8Path: resolvedP8, ttlSeconds };
}

export function mintDeveloperTokenIntoEnv(options = {}) {
  const root = options.root ?? repoRoot;
  const envPath = path.join(root, ".env");
  const env = parseEnvFile(envPath);
  const input = resolveMintInput(env, root);
  const privateKeyPem = fs.readFileSync(input.p8Path, "utf8");
  const minted = mintMusicKitDeveloperToken({
    teamId: input.teamId,
    keyId: input.keyId,
    privateKeyPem,
    ttlSeconds: input.ttlSeconds,
    nowMs: options.nowMs,
  });
  upsertEnvKey(envPath, TOKEN_ENV_KEY, minted.token);
  return {
    wrote: true,
    key: TOKEN_ENV_KEY,
    tokenLength: minted.token.length,
    exp: minted.exp,
    iat: minted.iat,
  };
}

function isMain() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const result = mintDeveloperTokenIntoEnv();
    console.log(
      `Wrote ${result.key} to .env (length ${result.tokenLength}, exp ${new Date(result.exp * 1000).toISOString()}). Restart npm run tauri:dev.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /eyJ[A-Za-z0-9_-]+\./u.test(message) ||
      /BEGIN PRIVATE KEY/u.test(message)
    ) {
      console.error("phase0:mint-token failed without echoing secrets.");
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}
