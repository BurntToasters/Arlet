import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readCargoLockPackageVersion,
  readCargoManifestVersion,
  syncCargoManifestVersion,
  syncNpmLockfileVersion,
  updateCargoLockPackageVersion,
} from "../../scripts/sync-version-helpers.js";

describe("Cargo manifest version synchronization", () => {
  const manifest = `[package]\nname = "arlet"\nversion = "0.1.0"\n\n[dependencies]\ntauri = { version = "2" }\n`;

  it("updates only the root package version", () => {
    const updated = syncCargoManifestVersion(manifest, "arlet", "0.2.0");
    expect(readCargoManifestVersion(updated, "arlet")).toBe("0.2.0");
    expect(updated).toContain('tauri = { version = "2" }');
  });

  it("fails closed when the root package shape drifts", () => {
    expect(() =>
      syncCargoManifestVersion(
        manifest.replace('name = "arlet"', 'name = "other"'),
        "arlet",
        "0.2.0",
      ),
    ).toThrow(/name does not match/);
    expect(() =>
      syncCargoManifestVersion(
        manifest.replace(
          'version = "0.1.0"',
          'version = "0.1.0"\nversion = "0.1.1"',
        ),
        "arlet",
        "0.2.0",
      ),
    ).toThrow(/version must appear exactly once/);
  });
});

describe("Cargo.lock package version synchronization", () => {
  const lockfile = `[[package]]\nname = "arlet"\nversion = "0.1.0"\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n`;

  it("updates only the named package entry", () => {
    const updated = updateCargoLockPackageVersion(lockfile, "arlet", "0.2.0");
    expect(readCargoLockPackageVersion(updated, "arlet")).toBe("0.2.0");
    expect(updated).toContain('name = "other"\nversion = "1.0.0"');
  });

  it("fails closed when the named package is absent or duplicated", () => {
    expect(() =>
      updateCargoLockPackageVersion(lockfile, "missing", "0.2.0"),
    ).toThrow(/must appear exactly once/);
    expect(() =>
      updateCargoLockPackageVersion(`${lockfile}${lockfile}`, "arlet", "0.2.0"),
    ).toThrow(/must appear exactly once/);
  });
});

describe("package-lock.json version synchronization", () => {
  const lockfile = `{
  "name": "arlet",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "arlet", "version": "0.1.0" },
    "node_modules/example": { "version": "1.0.0" }
  }
}
`;

  it("updates the lock root and workspace package only", () => {
    const updated = JSON.parse(syncNpmLockfileVersion(lockfile, "0.2.0"));
    expect(updated.version).toBe("0.2.0");
    expect(updated.packages[""].version).toBe("0.2.0");
    expect(updated.packages["node_modules/example"].version).toBe("1.0.0");
  });

  it("leaves an already synchronized lockfile byte-for-byte unchanged", () => {
    const current = lockfile.replaceAll("0.1.0", "0.2.0");
    expect(syncNpmLockfileVersion(current, "0.2.0")).toBe(current);
  });
});

describe("release version drift gates", () => {
  it("uses sync-version --check without adding a mutating path", () => {
    const preflight = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "release-preflight.js"),
      "utf8",
    );
    const testAll = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "test-all.js"),
      "utf8",
    );
    expect(preflight).toContain('"sync-version.js"');
    expect(preflight).toContain('"--check"');
    expect(testAll).toContain('"version",');
    expect(testAll).toContain('"--check"');
  });
});
