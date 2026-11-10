import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Failure modes: vi resets or cleans tracked, staged, or untracked user work;
// b/r switches over a dirty tree before vi gets a chance to refuse; current or
// target branch commits ahead of their origin refs are lost; detached HEAD,
// missing upstreams, missing branches, malformed remotes/refs, or a stale
// remote ref are treated as safe; a failed npm setup happens after an unsafe
// switch; or npm is invoked through a shell. Every destructive-path proof runs
// in a temporary clone and confirms refused files, commits, and branches stay.

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function removeTestDirectory(directory) {
  const relative = path.relative(os.tmpdir(), path.resolve(directory));
  assert(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "test cleanup target must stay inside the OS temp directory",
  );
  fs.rmSync(directory, { recursive: true, force: true });
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arlet-branch-guard-"));
  t.after(() => removeTestDirectory(temp));
  const repo = path.join(temp, "repo");
  const remote = path.join(temp, "origin.git");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "package.json"), '{"type":"module"}\n');
  for (const file of ["branch-setup.js", "vi.js", "npm-cli.cjs"]) {
    fs.copyFileSync(
      path.join(scriptsDir, file),
      path.join(repo, "scripts", file),
    );
  }

  git(temp, ["init", "--bare", "--initial-branch=main", remote]);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Arlet Script Test"]);
  git(repo, ["config", "user.email", "script-test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["switch", "-c", "beta"]);
  git(repo, ["push", "-u", "origin", "beta"]);
  git(repo, ["switch", "main"]);

  const fakeNpm = path.join(temp, "npm-cli.mjs");
  fs.writeFileSync(
    fakeNpm,
    "import fs from 'node:fs'; fs.writeFileSync(process.env.ARLET_NPM_STUB_MARKER, process.argv.slice(2).join(' '));\n",
  );
  const marker = path.join(temp, "npm-args.txt");
  const env = {
    ...process.env,
    npm_execpath: fakeNpm,
    ARLET_NPM_STUB_MARKER: marker,
  };

  return { temp, repo, remote, fakeNpm, marker, env };
}

function runScript(f, script, args = []) {
  return spawnSync(
    process.execPath,
    [path.join(f.repo, "scripts", script), ...args],
    { cwd: f.repo, env: f.env, encoding: "utf8", shell: false },
  );
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function advanceRemoteBeta(f) {
  git(f.repo, ["switch", "beta"]);
  fs.writeFileSync(path.join(f.repo, "beta.txt"), "remote beta\n");
  git(f.repo, ["add", "beta.txt"]);
  git(f.repo, ["commit", "-m", "advance beta"]);
  git(f.repo, ["push", "origin", "beta"]);
  const remoteTip = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["switch", "main"]);
  git(f.repo, ["branch", "-f", "beta", "main"]);
  return remoteTip;
}

test("branch setup uses the requested origin branch and no shell for npm", (t) => {
  const f = fixture(t);
  const expectedTip = advanceRemoteBeta(f);
  const result = runScript(f, "branch-setup.js", ["origin", "beta"]);

  assert.equal(result.status, 0, output(result));
  assert.equal(git(f.repo, ["branch", "--show-current"]), "beta");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), expectedTip);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "run vi");
  const source = fs.readFileSync(
    path.join(scriptsDir, "branch-setup.js"),
    "utf8",
  );
  assert.match(source, /shell:\s*false/);
});

test("branch setup refuses tracked, staged, and untracked work before switching", (t) => {
  for (const kind of ["tracked", "staged", "untracked"]) {
    const f = fixture(t);
    const trackedFile = path.join(f.repo, "tracked.txt");
    if (kind === "untracked") {
      fs.writeFileSync(path.join(f.repo, "untracked.txt"), "keep\n");
    } else {
      fs.writeFileSync(trackedFile, "local edits\n");
      if (kind === "staged") git(f.repo, ["add", "tracked.txt"]);
    }
    const head = git(f.repo, ["rev-parse", "HEAD"]);
    const result = runScript(f, "branch-setup.js", ["origin", "beta"]);

    assert.notEqual(result.status, 0, `${kind}: ${output(result)}`);
    assert.match(output(result), /Working tree is not clean/);
    assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), head);
    if (kind === "untracked") {
      assert.equal(
        fs.readFileSync(path.join(f.repo, "untracked.txt"), "utf8"),
        "keep\n",
      );
    } else {
      assert.equal(fs.readFileSync(trackedFile, "utf8"), "local edits\n");
    }
  }
});

test("branch setup preserves unpublished commits on the current branch", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, "current-only.txt"), "keep\n");
  git(f.repo, ["add", "current-only.txt"]);
  git(f.repo, ["commit", "-m", "unpublished current commit"]);
  const head = git(f.repo, ["rev-parse", "HEAD"]);

  const result = runScript(f, "branch-setup.js", ["origin", "beta"]);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /unpublished commit/);
  assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), head);
  assert.equal(
    fs.readFileSync(path.join(f.repo, "current-only.txt"), "utf8"),
    "keep\n",
  );
});

test("branch setup preserves unpublished commits on the target branch", (t) => {
  const f = fixture(t);
  git(f.repo, ["switch", "beta"]);
  fs.writeFileSync(path.join(f.repo, "target-only.txt"), "keep\n");
  git(f.repo, ["add", "target-only.txt"]);
  git(f.repo, ["commit", "-m", "unpublished target commit"]);
  const targetHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["switch", "main"]);

  const result = runScript(f, "branch-setup.js", ["origin", "beta"]);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /target branch beta has 1 unpublished commit/);
  assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
  assert.equal(git(f.repo, ["rev-parse", "refs/heads/beta"]), targetHead);
  assert.equal(
    git(f.repo, ["show", "refs/heads/beta:target-only.txt"]),
    "keep",
  );
});

test("branch setup refuses a missing target even when its remote-tracking ref is stale", (t) => {
  const f = fixture(t);
  git(f.temp, ["--git-dir", f.remote, "update-ref", "-d", "refs/heads/beta"]);
  assert.notEqual(
    git(f.repo, ["show-ref", "--verify", "refs/remotes/origin/beta"]),
    "",
  );
  const head = git(f.repo, ["rev-parse", "HEAD"]);

  const result = runScript(f, "branch-setup.js", ["origin", "beta"]);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /origin\/beta.*does not exist/);
  assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), head);
});

test("vi refuses dirty work and unpublished commits before reset or clean", (t) => {
  const dirty = fixture(t);
  fs.writeFileSync(path.join(dirty.repo, "untracked.txt"), "keep\n");
  const dirtyHead = git(dirty.repo, ["rev-parse", "HEAD"]);
  const dirtyResult = runScript(dirty, "vi.js");
  assert.notEqual(dirtyResult.status, 0, output(dirtyResult));
  assert.equal(git(dirty.repo, ["rev-parse", "HEAD"]), dirtyHead);
  assert.equal(
    fs.readFileSync(path.join(dirty.repo, "untracked.txt"), "utf8"),
    "keep\n",
  );

  const ahead = fixture(t);
  fs.writeFileSync(path.join(ahead.repo, "local-commit.txt"), "keep\n");
  git(ahead.repo, ["add", "local-commit.txt"]);
  git(ahead.repo, ["commit", "-m", "keep local commit"]);
  const aheadHead = git(ahead.repo, ["rev-parse", "HEAD"]);
  const aheadResult = runScript(ahead, "vi.js");
  assert.notEqual(aheadResult.status, 0, output(aheadResult));
  assert.match(output(aheadResult), /unpublished commit/);
  assert.equal(git(ahead.repo, ["rev-parse", "HEAD"]), aheadHead);
  assert.equal(
    fs.readFileSync(path.join(ahead.repo, "local-commit.txt"), "utf8"),
    "keep\n",
  );
});

test("branch setup fails closed for invalid refs, detached HEAD, and no upstream", (t) => {
  const f = fixture(t);
  for (const args of [
    ["github", "beta"],
    ["origin", "origin/beta"],
    ["origin", "feature/name"],
    ["origin", "beta", "--discard-local"],
  ]) {
    const head = git(f.repo, ["rev-parse", "HEAD"]);
    const result = runScript(f, "branch-setup.js", args);
    assert.notEqual(result.status, 0, `${args.join(" ")}: ${output(result)}`);
    assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), head);
  }

  git(f.repo, ["checkout", "--detach"]);
  const detachedHead = git(f.repo, ["rev-parse", "HEAD"]);
  const detached = runScript(f, "branch-setup.js", ["origin", "beta"]);
  assert.notEqual(detached.status, 0, output(detached));
  assert.match(output(detached), /detached HEAD/);
  assert.equal(git(f.repo, ["branch", "--show-current"]), "");
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), detachedHead);

  const noUpstream = fixture(t);
  git(noUpstream.repo, ["switch", "-c", "local-only"]);
  const localHead = git(noUpstream.repo, ["rev-parse", "HEAD"]);
  const noUpstreamResult = runScript(noUpstream, "branch-setup.js", [
    "origin",
    "beta",
  ]);
  assert.notEqual(noUpstreamResult.status, 0, output(noUpstreamResult));
  assert.match(output(noUpstreamResult), /upstream/);
  assert.equal(
    git(noUpstream.repo, ["branch", "--show-current"]),
    "local-only",
  );
  assert.equal(git(noUpstream.repo, ["rev-parse", "HEAD"]), localHead);
});
