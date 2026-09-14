"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { githubApiToFile } = require("./github-cli.cjs");

test("githubApiToFile streams assets larger than the old stdout ceiling", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-gh-stream-test-"),
  );
  try {
    const payloadBytes = 33 * 1024 * 1024;
    const destination = path.join(directory, "asset.bin");
    githubApiToFile("GET", "/fake/asset", destination, {
      runner: (_command, _args, options) => {
        assert.equal(Object.hasOwn(options, "maxBuffer"), false);
        fs.writeSync(options.stdio[1], Buffer.alloc(payloadBytes, 0x61));
        return { status: 0 };
      },
    });
    assert.equal(fs.statSync(destination).size, payloadBytes);
    const descriptor = fs.openSync(destination, "r");
    try {
      const prefix = Buffer.alloc(16);
      fs.readSync(descriptor, prefix, 0, prefix.length, 0);
      assert.equal(prefix.toString("utf8"), "a".repeat(16));
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("githubApiToFile preserves an existing destination on replacement", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-gh-existing-test-"),
  );
  try {
    const destination = path.join(directory, "asset.bin");
    fs.writeFileSync(destination, "old asset");
    assert.throws(
      () =>
        githubApiToFile("GET", "/fake/asset", destination, {
          runner: (_command, _args, options) => {
            fs.writeSync(options.stdio[1], "new asset");
            return { status: 0 };
          },
        }),
      /Refusing to overwrite existing download/,
    );
    assert.equal(fs.readFileSync(destination, "utf8"), "old asset");
    assert.deepEqual(
      fs.readdirSync(directory),
      ["asset.bin"],
      "failed downloads must clean their partial file",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
