#!/usr/bin/env node
"use strict";

// Arlet calls WebView2 directly (crash recovery) through the webview2-com
// crate, which must be the same version wry uses or the WebView2 types do
// not line up. A Tauri update that moves wry to a newer webview2-com leaves
// two versions in Cargo.lock, and the build then fails with type errors that
// do not name the cause. This check says it plainly.

const fs = require("node:fs");
const path = require("node:path");

const CRATE = "webview2-com";

/** Versions of `name` recorded in a Cargo.lock. */
function lockedVersions(lockText, name) {
  const versions = [];
  const pattern =
    /^\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/gmu;
  for (const match of lockText.matchAll(pattern)) {
    if (match[1] === name && match[2]) versions.push(match[2]);
  }
  return versions;
}

function main() {
  const lockPath = path.join(__dirname, "..", "src-tauri", "Cargo.lock");
  const versions = lockedVersions(fs.readFileSync(lockPath, "utf8"), CRATE);
  if (versions.length > 1) {
    console.error(
      `[deps] Cargo.lock has ${CRATE} ${versions.join(" and ")}. ` +
        `Set ${CRATE} in src-tauri/Cargo.toml to the version wry uses ` +
        `(cargo tree -i ${CRATE}), then run cargo update -p ${CRATE}.`,
    );
    process.exit(1);
  }
  console.log(
    `[deps] One ${CRATE} version locked: ${versions[0] ?? "(none)"}; Arlet and wry share it.`,
  );
}

if (require.main === module) main();

module.exports = { lockedVersions };
