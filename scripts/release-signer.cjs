"use strict";

/**
 * The release key, from GPG_RELEASE_FINGERPRINT (preferred) or GPG_KEY_ID.
 * Short 8-hex ids collide easily, so at least a 16-hex long id is required.
 * Shared by the draft step (fails before any build) and the draft verifier.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function expectedReleaseSigner(env = process.env) {
  const raw = String(env.GPG_RELEASE_FINGERPRINT || env.GPG_KEY_ID || "")
    .replace(/^0x/i, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!/^[0-9A-F]{16,40}$/.test(raw)) {
    throw new Error(
      "Set GPG_RELEASE_FINGERPRINT (or GPG_KEY_ID) to the release key's full fingerprint so SHA256SUMS.asc is checked against that key, not any key in the local keyring.",
    );
  }
  return raw;
}

module.exports = {
  expectedReleaseSigner,
};
