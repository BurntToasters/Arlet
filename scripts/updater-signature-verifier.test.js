import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyUpdaterSignatures } from "./updater-signature-verifier.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeZeroSignature() {
  const packet = Buffer.concat([Buffer.from([0x45, 0x64]), Buffer.alloc(72)]);
  const global = Buffer.alloc(64);
  const envelope = [
    "untrusted comment: signature",
    packet.toString("base64"),
    "trusted comment: timestamp:0",
    global.toString("base64"),
  ].join("\n");
  return Buffer.from(envelope, "utf8").toString("base64");
}

test("cryptographic updater verification rejects a zero-filled fake signature", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-updater-signature-test-"),
  );
  try {
    const artifact = path.join(directory, "Arlet_0.1.0_x64-setup.exe");
    const signature = `${artifact}.sig`;
    fs.writeFileSync(artifact, "fake installer");
    fs.writeFileSync(signature, fakeZeroSignature());
    assert.throws(
      () =>
        verifyUpdaterSignatures({
          root,
          releaseDir: directory,
          byName: new Map([[path.basename(artifact), artifact]]),
          signatureByBaseName: new Map([[path.basename(artifact), signature]]),
          resolveUpdaterTargets: (name) =>
            /-setup\.exe$/i.test(name) ? [{ os: "windows" }] : [],
        }),
      /Updater artifact signature verification failed/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cryptographic updater verification rejects unsupported artifact names", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-updater-name-test-"),
  );
  try {
    const artifact = path.join(directory, "Arlet_0.1.0_x64-setup.exe");
    const unexpected = path.join(directory, "Arlet_0.1.0_x86-setup.exe");
    const signature = `${artifact}.sig`;
    fs.writeFileSync(artifact, "valid-looking installer");
    fs.writeFileSync(unexpected, "unexpected installer");
    fs.writeFileSync(signature, fakeZeroSignature());
    assert.throws(
      () =>
        verifyUpdaterSignatures({
          root,
          releaseDir: directory,
          byName: new Map([
            [path.basename(artifact), artifact],
            [path.basename(unexpected), unexpected],
          ]),
          signatureByBaseName: new Map([[path.basename(artifact), signature]]),
          resolveUpdaterTargets: (name) =>
            /^Arlet_[^/\\]+_(?:x64|arm64)-setup\.exe$/i.test(name)
              ? [{ os: "windows" }]
              : [],
          runner: () => ({ status: 0 }),
        }),
      /Unsupported updater artifact name/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
