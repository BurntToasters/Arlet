import assert from "node:assert/strict";
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
// build.rs would only reject later; error text echoes the token.
test("checkMusicKitToken rejects tokens build.rs would refuse", () => {
  const cases = [
    {},
    { MUSICKIT_DEVELOPER_TOKEN: "" },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 90 * DAY }),
      ARLET_SKIP_MUSICKIT_TOKEN: "1",
    },
    { MUSICKIT_DEVELOPER_TOKEN: "not.a.jwt" },
    {
      MUSICKIT_DEVELOPER_TOKEN: token(
        { exp: NOW + 90 * DAY },
        { alg: "HS256" },
      ),
    },
    { MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 29 * DAY }) },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 90 * DAY,
        origin: ["http://localhost:5173"],
      }),
    },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 90 * DAY,
        origin: ["http://tauri.localhost", "http://127.0.0.1:5173"],
      }),
    },
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 90 * DAY,
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

test("checkMusicKitToken reports origin restriction", () => {
  const scoped = checkMusicKitToken(
    {
      MUSICKIT_DEVELOPER_TOKEN: token({
        exp: NOW + 90 * DAY,
        origin: ["http://tauri.localhost"],
      }),
    },
    NOW,
  );
  assert.deepEqual(scoped, { exp: NOW + 90 * DAY, originRestricted: true });
  const open = checkMusicKitToken(
    { MUSICKIT_DEVELOPER_TOKEN: token({ exp: NOW + 90 * DAY }) },
    NOW,
  );
  assert.deepEqual(open, { exp: NOW + 90 * DAY, originRestricted: false });
});
