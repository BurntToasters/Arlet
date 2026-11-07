#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDirectExecutionOf } from "./direct-execution.mjs";

const exactVersion = /^\d+\.\d+\.\d+$/u;

function fail(filePath, detail) {
  throw new Error(`rust-toolchain.toml ${detail}: ${filePath}`);
}

function readToolchainConfig(root) {
  const filePath = path.join(root, "rust-toolchain.toml");
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Rust toolchain pin is missing: ${filePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  let channel;
  let profile;
  let components;
  let inToolchain = false;
  for (const rawLine of contents.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    const section = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/u)?.[1];
    if (section) {
      inToolchain = section === "toolchain";
      continue;
    }
    if (!inToolchain || line.startsWith("#") || !line) continue;

    const channelValue = line.match(
      /^channel\s*=\s*"([^"]*)"\s*(?:#.*)?$/u,
    )?.[1];
    if (channelValue !== undefined) {
      if (channel !== undefined) fail(filePath, "declares channel twice");
      channel = channelValue;
      continue;
    }
    if (/^channel\s*=/u.test(line)) {
      fail(filePath, "has a malformed channel");
    }

    const profileValue = line.match(
      /^profile\s*=\s*"([^"]*)"\s*(?:#.*)?$/u,
    )?.[1];
    if (profileValue !== undefined) {
      if (profile !== undefined) fail(filePath, "declares profile twice");
      profile = profileValue;
      continue;
    }

    if (/^components\s*=/u.test(line)) {
      if (components !== undefined) {
        fail(filePath, "declares components twice");
      }
      const array = line.match(/^components\s*=\s*\[(.*)\]\s*(?:#.*)?$/u)?.[1];
      if (array === undefined) fail(filePath, "has malformed components");
      const entries = array
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.some((entry) => !/^"[^"]+"$/u.test(entry))) {
        fail(filePath, "has malformed components");
      }
      components = entries.map((entry) => entry.slice(1, -1));
    }
  }

  if (!channel) fail(filePath, "has no channel");
  if (!exactVersion.test(channel)) {
    fail(filePath, `must pin an exact Rust version; found ${channel}`);
  }
  return {
    channel,
    profile: profile || "minimal",
    components: components ?? [],
  };
}

/**
 * Reads the single Rust pin. Root is explicit so callers can resolve the
 * repository independently of the current working directory.
 */
export function readPinnedRustToolchain(root) {
  return readToolchainConfig(root).channel;
}

function rustup(args, cwd) {
  const result = spawnSync("rustup", args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rustup ${args.join(" ")} failed (${result.status})`);
  }
}

function parseArguments(argv) {
  const options = { install: false, defaultToolchain: false, targets: [] };
  let print = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--print") {
      print = true;
    } else if (argument === "--install") {
      options.install = true;
    } else if (argument === "--default") {
      options.defaultToolchain = true;
    } else if (argument === "--target") {
      const targets = [];
      while (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        targets.push(argv[(index += 1)]);
      }
      if (targets.length === 0) throw new Error("--target needs a triple");
      options.targets.push(...targets);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (
    print &&
    (options.install || options.defaultToolchain || options.targets.length > 0)
  ) {
    throw new Error("--print cannot be combined with an action");
  }
  if (options.defaultToolchain && !options.install) {
    throw new Error("--default requires --install");
  }
  return options;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = readToolchainConfig(root);
  const options = parseArguments(argv);

  if (
    !options.install &&
    !options.defaultToolchain &&
    options.targets.length === 0
  ) {
    console.log(config.channel);
    return;
  }

  if (options.install) {
    const installArgs = [
      "toolchain",
      "install",
      config.channel,
      "--profile",
      config.profile,
    ];
    if (config.components.length > 0) {
      installArgs.push("--component", config.components.join(","));
    }
    rustup(installArgs, root);
    if (options.defaultToolchain) {
      rustup(["default", config.channel], root);
    }
  }
  if (options.targets.length > 0) {
    rustup(
      ["target", "add", "--toolchain", config.channel, ...options.targets],
      root,
    );
  }
}

if (process.argv[1] && isDirectExecutionOf(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`rust-toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
