"use strict";

// Small GitHub CLI adapter shared by release scripts. Credentials stay in the
// gh keyring; token environment variables are deliberately not forwarded.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Textual metadata responses are intentionally bounded. Binary release
// assets never use runGitHub: githubApiToFile streams them to disk below.
const TEXT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

function githubCliEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.GH_TOKEN;
  delete childEnvironment.GITHUB_TOKEN;
  return childEnvironment;
}

function githubStatusCode(detail) {
  const match = String(detail || "").match(
    /\bHTTP\s+(\d{3})\b|\bstatus(?: code)?\s+(\d{3})\b/i,
  );
  return match ? Number(match[1] || match[2]) : undefined;
}

function runGitHub(args, { input, encoding = "utf8" } = {}) {
  const result = spawnSync("gh", args, {
    cwd: process.cwd(),
    encoding,
    env: githubCliEnvironment(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: TEXT_RESPONSE_MAX_BYTES,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "GitHub CLI is required. Install gh and run `gh auth login` on this release VM.",
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .map(String)
      .join("\n")
      .trim();
    const error = new Error(
      `gh ${args.join(" ")} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  return result.stdout;
}

function githubApiArgs(method, endpoint, body = undefined) {
  const args = ["api", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  return args;
}

function githubApi(method, endpoint, body = undefined) {
  const output = runGitHub(githubApiArgs(method, endpoint, body), {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = String(output || "").trim();
  return text ? JSON.parse(text) : {};
}

function githubApiBuffer(method, endpoint) {
  // Compatibility helper for callers that explicitly need a Buffer. Binary
  // release assets must use githubApiToFile below; this wrapper still avoids
  // gh's stdout maxBuffer by letting the child write to a temporary file.
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-gh-buffer-"),
  );
  const destination = path.join(temporaryDirectory, "asset");
  try {
    githubApiToFile(method, endpoint, destination);
    return fs.readFileSync(destination);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function githubApiToFile(
  method,
  endpoint,
  destination,
  { runner = spawnSync } = {},
) {
  const resolvedDestination = path.resolve(destination);
  const parent = path.dirname(resolvedDestination);
  const partial = path.join(
    parent,
    `.${path.basename(resolvedDestination)}.part-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let descriptor;
  let completed = false;
  try {
    descriptor = fs.openSync(partial, "wx");
    const result = runner(
      "gh",
      [
        "api",
        "--method",
        method,
        endpoint,
        "--header",
        "Accept: application/octet-stream",
      ],
      {
        cwd: process.cwd(),
        env: githubCliEnvironment(),
        // stdout is an ordinary file descriptor, so asset size is bounded by
        // available disk space rather than a fixed in-memory maxBuffer.
        stdio: ["ignore", descriptor, "pipe"],
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.error) {
      if (result.error.code === "ENOENT") {
        throw new Error(
          "GitHub CLI is required. Install gh and run `gh auth login` on this release VM.",
        );
      }
      throw result.error;
    }
    if (result.status !== 0) {
      const detail = [result.stderr]
        .filter(Boolean)
        .map(String)
        .join("\n")
        .trim();
      const error = new Error(
        `gh api --method ${method} ${endpoint} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
      );
      error.statusCode = githubStatusCode(detail);
      throw error;
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    // Refuse to overwrite an existing path so an old download cannot be
    // mistaken as fresh. Release callers use disposable destinations.
    if (fs.existsSync(resolvedDestination)) {
      throw new Error(
        `Refusing to overwrite existing download: ${resolvedDestination}`,
      );
    }
    fs.renameSync(partial, resolvedDestination);
    completed = true;
    return resolvedDestination;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original gh/IO error.
      }
    }
    if (!completed) fs.rmSync(partial, { force: true });
  }
}

function uploadReleaseAsset(uploadUrl, filePath) {
  const url = new URL(String(uploadUrl).replace("{?name,label}", ""));
  if (url.protocol !== "https:" || url.hostname !== "uploads.github.com") {
    throw new Error(`Refusing unexpected GitHub upload URL: ${uploadUrl}`);
  }
  url.searchParams.set("name", path.basename(filePath));
  const contentType = /\.(json|asc|txt)$/i.test(filePath)
    ? "text/plain"
    : "application/octet-stream";
  const output = runGitHub([
    "api",
    "--method",
    "POST",
    url.toString(),
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `Content-Type: ${contentType}`,
    "--input",
    filePath,
  ]);
  const text = String(output || "").trim();
  return text ? JSON.parse(text) : {};
}

function assertGitHubCliAuthenticated() {
  runGitHub(["auth", "status", "--hostname", "github.com"]);
}

module.exports = {
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiArgs,
  githubApiBuffer,
  githubApiToFile,
  githubCliEnvironment,
  githubStatusCode,
  runGitHub,
  uploadReleaseAsset,
};
