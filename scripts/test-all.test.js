import assert from "node:assert/strict";
import test from "node:test";
import { main } from "./test-all.js";

// Failure modes covered before production edits:
// - ordinary runs (including --skip-e2e) pass but never create release proof;
// - --require-clean-proof cannot pass with --skip-e2e or unavailable native E2E;
// - non-Windows release runs cannot record incomplete native coverage;
// - SSH release runs (the release VM) skip only the native app E2E and record
//   it as deferred, never as verified; every other stage must still pass;
// - only a desktop run with every mandatory stage passed may record proof;
// - a runner reporting a skipped required stage cannot bypass proof coverage.

function successfulRunner(calls, { skipped = [] } = {}) {
  return (name, _command, _args, _parser, results) => {
    calls.push(name);
    results[name].status = skipped.includes(name) ? "skipped" : "passed";
    return true;
  };
}

function runQuietly(options) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return main(options);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function baseOptions(overrides = {}) {
  return {
    platform: "win32",
    sshSession: false,
    clearProof() {},
    recordProof() {
      return { recorded: true, dirtyFiles: null };
    },
    ...overrides,
  };
}

test("ordinary runs can pass without creating release-quality proof", () => {
  const calls = [];
  let proofAttempts = 0;
  const status = runQuietly(
    baseOptions({
      runner: successfulRunner(calls),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 0);
  assert.ok(calls.includes("e2e"));
  assert.ok(!calls.includes("e2eApp"));
  assert.equal(proofAttempts, 0);
});

test("ordinary --skip-e2e runs pass without creating release-quality proof", () => {
  let proofAttempts = 0;
  const status = runQuietly(
    baseOptions({
      skipE2e: true,
      runner: successfulRunner([]),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 0);
  assert.equal(proofAttempts, 0);
});

test("required proof rejects --skip-e2e", () => {
  let proofAttempts = 0;
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      skipE2e: true,
      runner: successfulRunner([]),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(proofAttempts, 0);
});

test("required proof fails when native E2E is unavailable off Windows", () => {
  let proofAttempts = 0;
  const calls = [];
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      platform: "linux",
      runner: successfulRunner(calls),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 1);
  assert.ok(!calls.includes("e2eApp"));
  assert.equal(proofAttempts, 0);
});

test("SSH release runs defer only the native E2E in the recorded proof", () => {
  const calls = [];
  let recorded;
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      sshSession: true,
      runner: successfulRunner(calls),
      recordProof(_root, results, options) {
        recorded = { results, options };
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 0);
  assert.ok(calls.includes("e2e"));
  assert.ok(!calls.includes("e2eApp"));
  assert.equal(recorded.results.e2eApp.status, "skipped");
  assert.deepEqual(recorded.options, { deferredStages: ["e2eApp"] });
});

test("SSH release runs still fail when another stage fails or is skipped", () => {
  let proofAttempts = 0;
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      sshSession: true,
      runner: successfulRunner([], { skipped: ["e2e"] }),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(proofAttempts, 0);
});

test("SSH release runs still reject --skip-e2e", () => {
  let proofAttempts = 0;
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      sshSession: true,
      skipE2e: true,
      runner: successfulRunner([]),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(proofAttempts, 0);
});

test("required proof records only after every stage passes on desktop", () => {
  const calls = [];
  let recordedResults;
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      runner: successfulRunner(calls),
      recordProof(_root, results, options) {
        recordedResults = results;
        assert.deepEqual(options, { deferredStages: [] });
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 0);
  assert.ok(calls.includes("e2e"));
  assert.ok(calls.includes("e2eApp"));
  assert.ok(
    Object.values(recordedResults).every(
      (result) => result.status === "passed",
    ),
  );
});

test("required proof cannot be recorded when a required stage is skipped", () => {
  let proofAttempts = 0;
  const status = runQuietly(
    baseOptions({
      requireCleanProof: true,
      runner: successfulRunner([], { skipped: ["e2eApp"] }),
      recordProof() {
        proofAttempts += 1;
        return { recorded: true, dirtyFiles: null };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(proofAttempts, 0);
});
