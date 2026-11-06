import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MINIMUM_NPM_VERSION,
  isSupportedNodeVersion,
  isVersionAtLeast,
  parseVersion,
  readPinnedRustToolchain,
} from "./npm-safe-update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const rustPinStep =
  /- name: Read pinned Rust version\n\s+id: rust-pin\n\s+shell: bash\n\s+run: echo "version=\$\(node scripts\/rust-toolchain\.mjs\)" >> "\$GITHUB_OUTPUT"/u;
const pinnedToolchain =
  /toolchain: \$\{\{ steps\.rust-pin\.outputs\.version \}\}/gu;

// Failure modes: a floating "stable" channel lets each new Rust release break
// CI with new lints; CI and local builds use different compilers; the npm
// helper scripts install a toolchain other than the pinned one; a workflow
// reads the pin before checkout or skips it entirely.
test("Rust toolchain is pinned to one exact version everywhere", () => {
  const channel = readPinnedRustToolchain(root);
  assert.match(channel, /^\d+\.\d+\.\d+$/u, "pin an exact x.y.z");

  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/musickit-canary.yml",
  ]) {
    const workflow = read(file);
    assert.doesNotMatch(workflow, /RUST_VERSION/u, `${file} uses a pin env`);
    assert.match(workflow, rustPinStep, `${file} must extract the pin`);
    assert.equal(
      workflow.match(pinnedToolchain)?.length ?? 0,
      workflow.match(/uses: dtolnay\/rust-toolchain/gu)?.length ?? 0,
      `${file} must pass the extracted pin to every Rust toolchain step`,
    );
  }

  for (const [name, command] of Object.entries(
    JSON.parse(read("package.json")).scripts,
  ).filter(([name]) => name.startsWith("rust:"))) {
    assert.doesNotMatch(
      command,
      /\b\d+\.\d+\.\d+\b/u,
      `${name} pins a version`,
    );
    assert.match(
      command,
      /node scripts\/rust-toolchain\.mjs/u,
      `${name} must derive the pin`,
    );
  }
});

test("Node and npm update environment versions fail closed at exact boundaries", () => {
  assert.deepEqual(parseVersion("12.2.1"), [12, 2, 1]);
  assert.equal(isVersionAtLeast("12.2.1", MINIMUM_NPM_VERSION), true);
  assert.equal(isVersionAtLeast("12.3.0", MINIMUM_NPM_VERSION), true);
  assert.equal(isVersionAtLeast("12.2.0", MINIMUM_NPM_VERSION), false);
  assert.equal(isVersionAtLeast("11.99.99", MINIMUM_NPM_VERSION), false);
  assert.equal(isSupportedNodeVersion("22.22.2"), false);
  assert.equal(isSupportedNodeVersion("23.99.99"), false);
  assert.equal(isSupportedNodeVersion("24.22.0"), false);
  assert.equal(isSupportedNodeVersion("24.22.1"), true);
  assert.equal(isSupportedNodeVersion("25.99.99"), false);
  assert.equal(isSupportedNodeVersion("26.12.9"), false);
  assert.equal(isSupportedNodeVersion("26.13.0"), true);
  assert.equal(isSupportedNodeVersion("27.0.0"), true);
  assert.throws(() => parseVersion("latest"), /Invalid semantic version/);
});
