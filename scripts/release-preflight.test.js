import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { checkMusicKitToken } from "./release-preflight.js";

const NOW = 1_800_000_000;
const DAY = 86_400;

function token(payload, header = { alg: "ES256", kid: "KEYID12345" }) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode(header)}.${encode(payload)}.c2lnbmF0dXJl`;
}

// Failure modes: a release starts (and a draft is created) with a missing,
// skipped, non-ES256, nearly expired, or wrongly origin-scoped token, which
// build.rs would only reject later; a token expires too close to the weekly
// canary warning; the exact minimum boundary drifts; or an error echoes the
// token. Policy leaves 40 days after the 130-day canary age threshold and at
// least 33 days after the next weekly check.
test("checkMusicKitToken rejects tokens build.rs would refuse", () => {
  const cases = [
    {},
    { MUSICKIT_DEVELOPER_TOKEN: "" },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 170 * DAY }),
      ARLET_SKIP_MUSICKIT_TOKEN: "1",
    },
    { MUSICKIT_DEVELOPER_TOKEN: "not.a.jwt" },
    {
      MUSICKIT_DEVELOPER_TOKEN: token(
        { exp: NOW + 170 * DAY },
        { alg: "HS256" },
      ),
    },
    { MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 29 * DAY }) },
    { MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 170 * DAY - 1 }) },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 170 * DAY,
        origin: ["http://tauri.localhost"],
      }),
    },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 170 * DAY,
        origin: ["http://localhost:5173"],
      }),
    },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 170 * DAY,
        origin: ["http://tauri.localhost", "http://127.0.0.1:5173"],
      }),
    },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 170 * DAY,
        origin: "http://tauri.localhost",
      }),
    },
  ];
  for (const env of cases) {
    assert.throws(
      () => checkMusicKitToken(env, NOW),
      (error) => {
        const secret = String(env.MUSICKIT_DEVELOPER_TOKEN ?? "").split(".")[1];
        return !secret || secret.length < 8 || !error.message.includes(secret);
      },
      JSON.stringify(env),
    );
  }
});

test("checkMusicKitToken accepts a token without an origin claim", () => {
  const open = checkMusicKitToken(
    { MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 170 * DAY }) },
    NOW,
  );
  assert.deepEqual(open, { exp: NOW + 170 * DAY });
});

test("release token policy preserves a weekly canary safety margin", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/musickit-canary.yml", import.meta.url),
    "utf8",
  );
  const guide = fs.readFileSync(
    new URL("../docs/RELEASE.md", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /MAX_RELEASE_AGE_DAYS: "130"/);
  assert.match(workflow, /if \[ "\$age_days" -ge "\$MAX_RELEASE_AGE_DAYS" \]/);
  assert.match(guide, /at least 170 days/);
  assert.match(guide, /weekly canary warns at 130 days/);
});
