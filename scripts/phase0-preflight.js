#!/usr/bin/env node
// Phase 0 manual gate preflight. Checks MusicKit dev token presence (never
// prints token value), toolchain versions, and Windows build when available.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..");
const TOKEN_KEY = "VITE_MUSICKIT_DEVELOPER_TOKEN";

export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function resolveDeveloperTokenEnv(root = repoRoot) {
  return {
    ...parseEnvFile(path.join(root, ".env")),
    ...parseEnvFile(path.join(root, ".env.local")),
  };
}

export function hasDeveloperToken(root = repoRoot) {
  const token = resolveDeveloperTokenEnv(root)[TOKEN_KEY];
  return typeof token === "string" && token.trim().length > 0;
}

export function readRustToolchainChannel(root = repoRoot) {
  const filePath = path.join(root, "rust-toolchain.toml");
  if (!fs.existsSync(filePath)) return "unknown";
  const text = fs.readFileSync(filePath, "utf8");
  const match = text.match(/^channel\s*=\s*"([^"]+)"/mu);
  return match?.[1] ?? "unknown";
}

export function readRustcVersion() {
  try {
    return nonempty(
      execFileSync("rustc", ["-V"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return null;
  }
}

export const WEBVIEW2_RUNTIME_GUID = "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5";

function nonempty(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readWindowsBuild() {
  if (process.platform !== "win32") return null;
  try {
    return nonempty(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "$v=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; \"$($v.DisplayVersion) build $($v.CurrentBuild).$($v.UBR)\"",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch {
    return null;
  }
}

export function readWebView2Version() {
  if (process.platform !== "win32") return null;
  const guid = `{${WEBVIEW2_RUNTIME_GUID}}`;
  const script = `$guid='${guid}'; $keys=@("HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\$guid","HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\$guid","HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\$guid","HKCU:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\$guid"); foreach ($k in $keys) { if (Test-Path $k) { $pv=(Get-ItemProperty $k).pv; if ($pv) { $pv; break } } }`;
  try {
    return nonempty(
      execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return null;
  }
}

export function readNpmVersion() {
  if (process.platform === "win32") {
    try {
      return nonempty(
        execFileSync("cmd.exe", ["/d", "/s", "/c", "npm -v"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {
      // Fall through to execFile candidates.
    }
  }
  const commands = [];
  if (process.platform === "win32") {
    commands.push(path.join(path.dirname(process.execPath), "npm.cmd"));
  }
  commands.push("npm");
  for (const command of commands) {
    try {
      return nonempty(
        execFileSync(command, ["-v"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          shell: command.endsWith(".cmd"),
        }),
      );
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function collectPhase0Environment(root = repoRoot) {
  return {
    nodeVersion: process.version,
    npmVersion: readNpmVersion(),
    rustToolchain: readRustToolchainChannel(root),
    rustcVersion: readRustcVersion(),
    windowsBuild: readWindowsBuild(),
    webview2Version: readWebView2Version(),
    developerTokenConfigured: hasDeveloperToken(root),
  };
}

export function formatPhase0PreflightReport(env) {
  const lines = [
    "Phase 0 manual gate preflight",
    "",
    `Developer token configured: ${env.developerTokenConfigured ? "yes" : "NO — add VITE_MUSICKIT_DEVELOPER_TOKEN to .env.local"}`,
    `Node: ${env.nodeVersion}`,
    `npm: ${env.npmVersion ?? "(npm not on PATH)"}`,
    `Rust toolchain channel: ${env.rustToolchain}`,
    `rustc: ${env.rustcVersion ?? "(rustc not on PATH)"}`,
    `Windows build: ${env.windowsBuild ?? "(not on Windows or unreadable)"}`,
    `WebView2 (registry): ${env.webview2Version ?? "(not on Windows or unreadable)"}`,
    "",
    "Next:",
    "  1. npm run tauri:dev",
    "  2. Sign in, search, play full tracks (not previews)",
    "  3. Complete the Feasibility Matrix checklist in the app",
    "  4. Copy feasibility report -> docs/MUSICKIT_TAURI_FEASIBILITY.md",
    "  5. Copy network surface -> docs/MUSICKIT_NETWORK_SURFACE.md",
  ];
  return lines.join("\n");
}

export function runPhase0Preflight(options = {}) {
  const { root = repoRoot, requireToken = false } = options;
  const env = collectPhase0Environment(root);
  const report = formatPhase0PreflightReport(env);
  if (requireToken && !env.developerTokenConfigured) {
    throw new Error(
      "VITE_MUSICKIT_DEVELOPER_TOKEN is missing. Create .env.local with your Apple Music developer token.",
    );
  }
  return { env, report };
}

function isMain() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const requireToken = process.argv.includes("--require-token");
  try {
    const { report } = runPhase0Preflight({ requireToken });
    console.log(report);
    process.exit(requireToken && !hasDeveloperToken() ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
