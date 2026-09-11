#!/usr/bin/env node
// Phase 0 manual gate preflight. Checks MusicKit dev token presence (never
// prints token value), toolchain versions, and Windows build when available.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..");
const TOKEN_KEYS = [
  "MUSICKIT_DEVELOPER_TOKEN",
  "VITE_MUSICKIT_DEVELOPER_TOKEN",
];

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
  return parseEnvFile(path.join(root, ".env"));
}

export function developerTokenValue(env) {
  for (const key of TOKEN_KEYS) {
    const token = env[key];
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
  }
  return null;
}

export function hasDeveloperToken(root = repoRoot) {
  return developerTokenValue(resolveDeveloperTokenEnv(root)) !== null;
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
    `Developer token configured: ${env.developerTokenConfigured ? "yes" : "NO — add MUSICKIT_DEVELOPER_TOKEN to .env (or npm run phase0:mint-token)"}`,
    `Node: ${env.nodeVersion}`,
    `npm: ${env.npmVersion ?? "(npm not on PATH)"}`,
    `Rust toolchain channel: ${env.rustToolchain}`,
    `rustc: ${env.rustcVersion ?? "(rustc not on PATH)"}`,
    `Windows build: ${env.windowsBuild ?? "(not on Windows or unreadable)"}`,
    `WebView2 (registry): ${env.webview2Version ?? "(not on Windows or unreadable)"}`,
    "",
    "Next:",
    "  1. If the token is missing: set MUSICKIT_TEAM_ID, MUSICKIT_KEY_ID, MUSICKIT_P8_PATH (p8 outside the repo) then npm run phase0:mint-token",
    "  2. npm run tauri:dev",
    "  3. Sign in, search, play full tracks (not previews)",
    "  4. Complete the Feasibility Matrix checklist in the app",
    "  5. Copy feasibility report -> docs/MUSICKIT_TAURI_FEASIBILITY.md",
    "  6. Copy network surface -> docs/MUSICKIT_NETWORK_SURFACE.md",
  ];
  return lines.join("\n");
}

export function runPhase0Preflight(options = {}) {
  const { root = repoRoot, requireToken = false } = options;
  const envLocal = path.join(root, ".env.local");
  if (fs.existsSync(envLocal)) {
    console.warn(
      "phase0-preflight: warning: .env.local is ignored. House style is `.env` (postal-snap).",
    );
  }
  const env = collectPhase0Environment(root);
  const report = formatPhase0PreflightReport(env);
  if (requireToken && !env.developerTokenConfigured) {
    throw new Error(
      "MUSICKIT_DEVELOPER_TOKEN is missing. Copy .env.example to .env and set your Apple Music developer token.",
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
