import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

// Failure modes: a floating "stable" channel lets each new Rust release break
// CI with new lints; CI and local builds use different compilers; the npm
// helper scripts install a toolchain other than the pinned one.
test("Rust toolchain is pinned to one exact version everywhere", () => {
  const channel = /^channel\s*=\s*"([^"]+)"/mu.exec(
    read("rust-toolchain.toml"),
  )?.[1];
  assert.match(channel ?? "", /^\d+\.\d+\.\d+$/u, "pin an exact x.y.z");

  const ci = /^\s*RUST_VERSION:\s*"([^"]+)"/mu.exec(
    read(".github/workflows/ci.yml"),
  )?.[1];
  assert.equal(ci, channel, "CI RUST_VERSION must match rust-toolchain.toml");

  const scripts = JSON.parse(read("package.json")).scripts;
  assert.doesNotMatch(scripts["rust:update"], /\bstable\b/u);
  assert.doesNotMatch(scripts["rust:targets:win"], /\bstable\b/u);
});
