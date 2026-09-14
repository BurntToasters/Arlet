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
