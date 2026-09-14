import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readAppVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json must contain a non-empty string version");
  }
  return packageJson.version;
}

function readNpmVersion(): string {
  if (process.platform === "win32") {
    try {
      return execFileSync("cmd.exe", ["/d", "/s", "/c", "npm -v"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // Fall through.
    }
  }
  const commands = [
    ...(process.platform === "win32"
      ? [resolve(process.execPath, "..", "npm.cmd")]
      : []),
    "npm",
  ];
  for (const command of commands) {
    try {
      return execFileSync(command, ["-v"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // Try the next candidate; Windows needs npm.cmd for execFile.
    }
  }
  return "unknown";
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
    __BUILD_NODE_VERSION__: JSON.stringify(process.version),
    __BUILD_NPM_VERSION__: JSON.stringify(readNpmVersion()),
  },
  // Vite `root` is `src/`; keep envDir at the repo root like postal-snap.
  // MusicKit developer tokens are NOT Vite env vars; Rust reads them from `.env`.
  envDir: resolve(import.meta.dirname),
  envPrefix: "VITE_",
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
