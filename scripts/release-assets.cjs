"use strict";

// One place for Arlet's installer names. Tauri builds versioned files
// (Arlet_<version>_<arch>-setup.exe); releases publish them under fixed names
// (Arlet-Windows-<arch>.exe) like the other rosie.run apps, so
// /releases/latest/download/ links never go stale. Version binding stays in
// the /releases/download/v<version>/ path of every manifest and notes link.

const INSTALLER_ARCHES = ["x64", "arm64"];
const UPDATER_ARCH = { x64: "x86_64", arm64: "aarch64" };

const PUBLISHED_INSTALLER = /^Arlet-Windows-(x64|arm64)\.exe$/i;
const BUILT_INSTALLER = /^Arlet_(.+)_(x64|arm64)-setup\.exe$/i;

function publishedInstallerName(arch) {
  if (!INSTALLER_ARCHES.includes(arch)) {
    throw new Error(`Unsupported installer architecture: ${arch}`);
  }
  return `Arlet-Windows-${arch}.exe`;
}

/** "x64" | "arm64" for a published installer name, else null. */
function publishedInstallerArch(name) {
  const match = PUBLISHED_INSTALLER.exec(String(name));
  return match ? match[1].toLowerCase() : null;
}

function builtInstallerName(version, arch) {
  if (!INSTALLER_ARCHES.includes(arch)) {
    throw new Error(`Unsupported installer architecture: ${arch}`);
  }
  return `Arlet_${version}_${arch}-setup.exe`;
}

/** { version, arch } for a Tauri-built installer name, else null. */
function builtInstallerInfo(name) {
  const match = BUILT_INSTALLER.exec(String(name));
  return match ? { version: match[1], arch: match[2].toLowerCase() } : null;
}

/** Published name for a Tauri build output (installer or its .sig sidecar). */
function publishedNameForBuilt(name) {
  const text = String(name);
  const isSig = /\.sig$/i.test(text);
  const info = builtInstallerInfo(isSig ? text.slice(0, -4) : text);
  if (!info) return null;
  return `${publishedInstallerName(info.arch)}${isSig ? ".sig" : ""}`;
}

module.exports = {
  INSTALLER_ARCHES,
  UPDATER_ARCH,
  builtInstallerInfo,
  builtInstallerName,
  publishedInstallerArch,
  publishedInstallerName,
  publishedNameForBuilt,
};
