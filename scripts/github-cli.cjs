"use strict";

// Small GitHub CLI adapter shared by release scripts. Credentials stay in the
// gh keyring; token environment variables are deliberately not forwarded.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
    maxBuffer: 32 * 1024 * 1024,
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
  return runGitHub(
    [
      "api",
      "--method",
      method,
      endpoint,
      "--header",
      "Accept: application/octet-stream",
    ],
    { encoding: null },
  );
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
  githubCliEnvironment,
  githubStatusCode,
  runGitHub,
  uploadReleaseAsset,
};
