import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER_NAME = ".arlet-e2e-profile.json";

function fail(message) {
  throw new Error(`[e2e-profile] ${message}`);
}

function canonicalParent(parent) {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) {
    fail("profile parent must be an absolute path");
  }
  const absolute = path.resolve(parent);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`profile parent is not a plain directory: ${absolute}`);
  }
  return fs.realpathSync.native(absolute);
}

function expectedRoot(parent, runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(runId)) {
    fail("profile run id is invalid");
  }
  return path.join(parent, `arlet-e2e-${runId}`);
}

function removeEntryWithoutFollowingLinks(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (!new Set(["EPERM", "EISDIR", "ENOTDIR"]).has(error?.code)) {
        throw error;
      }
      // Windows may require rmdir for a directory symlink or junction. This
      // removes the reparse point itself and never walks into its target.
      fs.rmdirSync(target);
    }
    return;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const name of fs.readdirSync(target)) {
    removeEntryWithoutFollowingLinks(path.join(target, name));
  }
  fs.rmdirSync(target);
}

function validateOwnedProfile(profile) {
  if (!profile || typeof profile !== "object")
    fail("profile handle is missing");
  const parent = canonicalParent(profile.parent);
  const root = profile.root;
  const wanted = expectedRoot(parent, profile.runId);
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root !== wanted
  ) {
    fail("profile root does not match its absolute owned path");
  }
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`profile root is not a plain directory: ${root}`);
  }
  const markerPath = path.join(root, MARKER_NAME);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    fail(`profile marker is not a plain file: ${markerPath}`);
  }
  const expectedMarker = JSON.stringify({
    schemaVersion: 1,
    root,
    runId: profile.runId,
    ownerToken: profile.ownerToken,
  });
  if (fs.readFileSync(markerPath, "utf8") !== `${expectedMarker}\n`) {
    fail(`profile marker does not prove ownership: ${markerPath}`);
  }
  return { parent, root, markerPath, expectedMarker };
}

/** Creates a unique, marked root under the system temp folder (or a test parent). */
export function createE2eProfile({
  parent = os.tmpdir(),
  runId = crypto.randomUUID(),
} = {}) {
  const safeParent = canonicalParent(parent);
  const root = expectedRoot(safeParent, runId);
  fs.mkdirSync(root, { recursive: false });
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const profile = { parent: safeParent, root, runId, ownerToken };
  const markerContents = `${JSON.stringify({
    schemaVersion: 1,
    root,
    runId,
    ownerToken,
  })}\n`;
  const markerPath = path.join(root, MARKER_NAME);
  const temporaryMarker = path.join(root, `.marker-${ownerToken}.tmp`);
  try {
    fs.writeFileSync(temporaryMarker, markerContents, { flag: "wx" });
    fs.renameSync(temporaryMarker, markerPath);
  } catch (error) {
    // Only remove the exact temporary marker this call created. The new root
    // is removed only if empty; failed or unexpected contents stay untouched.
    try {
      if (fs.existsSync(temporaryMarker)) fs.unlinkSync(temporaryMarker);
      fs.rmdirSync(root);
    } catch {
      // The caller reports the setup error; an unmarked nonempty path is never
      // recursively removed on the basis of a failed setup.
    }
    throw error;
  }
  return {
    ...profile,
    markerContents,
    cleanup() {
      return cleanupE2eProfile(profile);
    },
  };
}

/** Removes only a profile whose absolute location and marker both match. */
export function cleanupE2eProfile(profile) {
  const owned = validateOwnedProfile(profile);
  if (!owned) return false;

  // Keep the ownership marker until every other entry has been removed. If a
  // locked file stops cleanup midway, a later run can still identify the root.
  for (const name of fs.readdirSync(owned.root)) {
    if (name === MARKER_NAME) continue;
    removeEntryWithoutFollowingLinks(path.join(owned.root, name));
  }
  fs.unlinkSync(owned.markerPath);
  try {
    fs.rmdirSync(owned.root);
  } catch (error) {
    // If the final directory removal is blocked, restore its marker so it is
    // still identifiable and can be cleaned safely after the lock is gone.
    try {
      fs.writeFileSync(owned.markerPath, `${owned.expectedMarker}\n`, {
        flag: "wx",
      });
    } catch {
      // Preserve the original removal error. No recursive fallback is safe.
    }
    throw error;
  }
  return true;
}

/** Cleans a marked root if setup fails before the harness takes ownership. */
export async function withE2eProfileSetup(options, setup) {
  const profile = createE2eProfile(options);
  try {
    await setup(profile);
    return profile;
  } catch (setupError) {
    try {
      profile.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        `profile setup failed and cleanup failed; inspect ${profile.root}`,
      );
    }
    throw setupError;
  }
}
