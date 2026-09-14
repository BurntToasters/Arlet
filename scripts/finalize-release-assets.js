#!/usr/bin/env node
// Arlet release mirror entry point. Workflow modeled on Zinnia's
// finalize-release-assets; implementation is original.
//
// Cleans build-only files from `release/`, then mirrors the verified entries
// to AFTER_PACK_LOC. Stable releases require the mirror (artifacts must
// survive the `git clean` in `release:finalize`); betas skip it by default.

import fs from "node:fs";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import {
  finalizeReleaseAssets,
  getAfterPackLocation,
  readPackageVersion,
  shouldSkipBetaMirror,
} from "./post-release-assets.js";

function banner(message) {
  fs.writeSync(2, `[release:mirror] ${message}\n`);
}

const version = readPackageVersion();
assertStableReleaseOverridesAllowed(process.env, version);
banner("starting");
banner(`platform=${process.platform}; node=${process.version}`);
banner(`cwd=${process.cwd()}`);
banner(`version=${JSON.stringify(version)}`);
banner(`AFTER_PACK_LOC=${JSON.stringify(getAfterPackLocation())}`);
banner(
  `OVERRIDE_BETA_MIRROR_SKIP=${JSON.stringify(process.env.OVERRIDE_BETA_MIRROR_SKIP ?? "")}`,
);
if (shouldSkipBetaMirror(process.env, version) && getAfterPackLocation()) {
  banner(
    `beta version ${version}; AFTER_PACK_LOC mirror will be skipped unless OVERRIDE_BETA_MIRROR_SKIP=1`,
  );
}

function allowSkipMirror(env = process.env) {
  return /^(1|true|yes|on)$/i.test(
    String(env.SKIP_RELEASE_MIRROR ?? "").trim(),
  );
}

try {
  const skipBeta = shouldSkipBetaMirror(process.env, version);
  const skipForced = allowSkipMirror();
  if (!skipBeta && !skipForced && !getAfterPackLocation()) {
    throw new Error(
      `Stable release ${version} requires AFTER_PACK_LOC so artifacts are mirrored before git clean. Set AFTER_PACK_LOC. Beta versions (X.Y.Z-beta.N) skip the mirror by default.`,
    );
  }
  const result = finalizeReleaseAssets({ version });
  if (!skipBeta && !skipForced && !result.mirrored) {
    throw new Error(
      `Stable release ${version} did not mirror to AFTER_PACK_LOC.`,
    );
  }
  banner(
    `finished ok; copied=${result.copiedEntries ?? 0}; dest=${result.destination}; skippedBetaMirror=${result.skippedBetaMirror}`,
  );
  process.exit(0);
} catch (error) {
  banner(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
