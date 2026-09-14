import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Shape checks in validate-updater-manifest.js intentionally stay cheap. This
// release-only gate performs the cryptographic check against the public key
// pinned in src-tauri/tauri.conf.json, so a zero-filled or otherwise forged
// minisign envelope cannot pass by looking structurally valid.
export function normalizeUpdaterSignature(signaturePath) {
  const trimmed = fs.readFileSync(signaturePath, "utf8").trim();
  if (!trimmed) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("untrusted comment:")) return trimmed;
  } catch {
    // Fall through to the raw-envelope normalization below.
  }
  return trimmed.includes("untrusted comment:")
    ? Buffer.from(trimmed, "utf8").toString("base64")
    : trimmed;
}

function readPinnedPublicKey(root) {
  const configPath = path.join(root, "src-tauri", "tauri.conf.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read src-tauri/tauri.conf.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const encoded = config.plugins?.updater?.pubkey;
  if (typeof encoded !== "string" || !encoded.trim()) {
    throw new Error("tauri.conf.json is missing plugins.updater.pubkey.");
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded.trim(), "base64");
    if (
      !decoded.length ||
      decoded.toString("base64") !== encoded.trim() ||
      !decoded.toString("utf8").startsWith("untrusted comment:")
    ) {
      throw new Error("not a canonical base64 minisign key");
    }
  } catch (error) {
    throw new Error(
      `tauri.conf.json has an invalid updater public key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return decoded;
}

export function verifyUpdaterSignatures({
  root,
  releaseDir,
  byName,
  signatureByBaseName,
  resolveUpdaterTargets,
  runner = spawnSync,
}) {
  if (!(byName instanceof Map) || !(signatureByBaseName instanceof Map)) {
    throw new Error("Updater signature verification requires artifact maps.");
  }
  if (typeof resolveUpdaterTargets !== "function") {
    throw new Error(
      "Updater signature verification requires a target resolver.",
    );
  }

  const pairs = [];
  const eligibleArtifacts = [];
  const missingSignatures = [];
  const unsupportedArtifacts = [];
  for (const [name, artifactPath] of byName) {
    if (name.endsWith(".sig")) {
      continue;
    }
    const targets = resolveUpdaterTargets(name);
    if (targets.length === 0) {
      unsupportedArtifacts.push(name);
      continue;
    }
    eligibleArtifacts.push(name);
    const signaturePath = signatureByBaseName.get(name);
    if (signaturePath) pairs.push([artifactPath, signaturePath]);
    else missingSignatures.push(`${name}.sig`);
  }
  if (missingSignatures.length > 0) {
    throw new Error(
      `Missing updater signature file(s): ${missingSignatures.sort().join(", ")}.`,
    );
  }
  if (unsupportedArtifacts.length > 0) {
    throw new Error(
      `Unsupported updater artifact name(s) cannot be cryptographically verified: ${unsupportedArtifacts.sort().join(", ")}.`,
    );
  }
  if (eligibleArtifacts.length === 0) {
    throw new Error(
      "Updater signature verification found no updater-eligible artifacts.",
    );
  }
  if (pairs.length === 0) {
    throw new Error(
      "Updater signature verification found zero eligible pairs.",
    );
  }

  const publicKey = readPinnedPublicKey(root);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(releaseDir, ".updater-verify-"),
  );
  try {
    const publicKeyPath = path.join(temporaryDirectory, "updater.pub");
    fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });
    const verifierArgs = [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      path.join(root, "src-tauri", "Cargo.toml"),
      "--example",
      "verify_updater_signatures",
      "--",
      publicKeyPath,
    ];
    for (const [index, [artifactPath, signaturePath]] of pairs.entries()) {
      const normalizedPath = path.join(
        temporaryDirectory,
        `signature-${index}.minisig`,
      );
      fs.writeFileSync(
        normalizedPath,
        Buffer.from(
          normalizeUpdaterSignature(signaturePath),
          "base64",
        ).toString("utf8"),
        { mode: 0o600 },
      );
      verifierArgs.push(artifactPath, normalizedPath);
    }
    const result = runner("cargo", verifierArgs, {
      cwd: root,
      stdio: "inherit",
      timeout: 180_000,
      windowsHide: true,
    });
    if (result?.error) throw result.error;
    if (result?.status !== 0) {
      throw new Error(
        `Updater artifact signature verification failed (cargo exit ${result?.status ?? "unknown"}).`,
      );
    }
    return true;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
