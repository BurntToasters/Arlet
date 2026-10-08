export function updateCargoLockPackageVersion(
  lockfile: string,
  packageName: string,
  version: string,
): string;

export function syncCargoManifestVersion(
  manifest: string,
  packageName: string,
  version: string,
): string;

export function readCargoManifestVersion(
  manifest: string,
  packageName: string,
): string | null;

export function readCargoLockPackageVersion(
  lockfile: string,
  packageName: string,
): string | null;

export function syncNpmLockfileVersion(
  lockText: string,
  version: string,
): string;
export const CHANGELOG_INTRO_ANCHOR: string;
export const README_DOWNLOADS_START: string;
export const README_DOWNLOADS_END: string;
export function syncChangelogForVersion(
  changelog: string,
  version: string,
): string;
export function syncReadmeDownloads(readme: string, version: string): string;
