/**
 * DORMANT legacy override implementation. Keep out of production imports and
 * runtime entry points; beta 2 handles Clean in Arlet's queue layer instead.
 */
import type { ExplicitContentPreference } from "../state-types.ts";
import { isAuthorized } from "./auth.ts";

type LegacyExplicitContentPreference = ExplicitContentPreference | "allow";

export const EXPLICIT_RESTRICTED_MESSAGE =
  "Explicit songs are restricted for this Apple Account. See Settings > Playback.";

export interface ExplicitContentStatus {
  /** MusicKit currently restricts explicit songs. */
  restricted: boolean;
  /** Arlet wrote a restriction value this page session; MusicKit keeps it until restart. */
  overridden: boolean;
}

interface StoredRestriction {
  key: string;
  value: string | null;
}

interface StoredRestrictionSnapshot {
  /** Every matching key that existed before the write. */
  keys: string[];
  /** The raw value of each key that could be read. */
  values: StoredRestriction[];
}

/** MusicKit's localStorage key for the restriction it was given: music.<team>.itre. */
const STORED_RESTRICTION_KEY = /^music\.[^.]+\.itre$/u;

// Explicit-content fix: user-confirmed override of MusicKit's restriction flag (see docs/explicit-content-fix.md).
let overrideApplied = false;

function storedRestrictionKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && STORED_RESTRICTION_KEY.test(key)) keys.push(key);
    }
    return keys;
  } catch {
    // Storage is unavailable, so there is no stored value to keep.
    return [];
  }
}

function readStoredRestrictions(): StoredRestrictionSnapshot {
  const keys = storedRestrictionKeys();
  const values: StoredRestriction[] = [];
  for (const key of keys) {
    try {
      values.push({ key, value: localStorage.getItem(key) });
    } catch {
      // An unreadable value is left as MusicKit wrote it.
    }
  }
  return { keys, values };
}

/**
 * MusicKit stores each value it is given, which would make the override
 * survive a restart. Puts back the raw value of every key saved before the
 * write, and removes each matching key MusicKit created since.
 */
function restoreStoredRestrictions(before: StoredRestrictionSnapshot): void {
  try {
    for (const { key, value } of before.values) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    for (const key of storedRestrictionKeys()) {
      if (!before.keys.includes(key)) localStorage.removeItem(key);
    }
  } catch {
    // Storage is unavailable; MusicKit's own write then stands.
  }
}

/** True only when MusicKit reports a signed-in user token. A throw counts as signed out. */
export function isInstanceAuthorized(
  instance: MusicKit.MusicKitInstance,
): boolean {
  try {
    return isAuthorized(instance) === true;
  } catch {
    return false;
  }
}

/**
 * Apple's stored restriction report for this page's account, as MusicKit reads
 * it: "0" is unrestricted, any other value is restricted, and no value is unknown.
 */
export function appleReportedRestriction(): boolean | undefined {
  const [key] = storedRestrictionKeys();
  if (key === undefined) return undefined;
  try {
    const value = localStorage.getItem(key);
    if (value === null) return undefined;
    return value !== "0";
  } catch {
    return undefined;
  }
}

/**
 * Writes MusicKit's `restrictedEnabled` for the preference: Allow turns the
 * restriction off, Clean turns it on, and Auto leaves MusicKit alone. The
 * in-memory value stays for this session, while MusicKit's stored report is
 * kept. Signed out, nothing is written: MusicKit's latch would drop the report
 * of the next sign-in. Returns false when the runtime rejects the write.
 */
export function applyExplicitContent(
  instance: MusicKit.MusicKitInstance,
  preference: LegacyExplicitContentPreference,
): boolean {
  if (preference === "auto") return true;
  if (!isInstanceAuthorized(instance)) return true;
  const restricted = preference === "clean";
  const record = instance as unknown as Record<string, unknown>;
  const stored = readStoredRestrictions();
  let applied = false;
  try {
    record.restrictedEnabled = restricted;
    applied = record.restrictedEnabled === restricted;
  } catch {
    applied = false;
  }
  restoreStoredRestrictions(stored);
  if (!applied) return false;
  overrideApplied = true;
  return true;
}

/**
 * A Clean write held back during playback. MusicKit stops the song playing
 * when its status turns restricted, so the write waits for the next Play,
 * which replaces the queue anyway.
 */
let cleanWriteHeld = false;

export function holdCleanWriteForNextPlay(): void {
  cleanWriteHeld = true;
}

export function releaseHeldCleanWrite(): void {
  cleanWriteHeld = false;
}

/** Writes a held Clean at the start of a Play. True when none was held or it applied. */
export function applyHeldCleanWrite(
  instance: MusicKit.MusicKitInstance,
): boolean {
  if (!cleanWriteHeld) return true;
  cleanWriteHeld = false;
  return applyExplicitContent(instance, "clean");
}

export function explicitContentStatus(
  instance: MusicKit.MusicKitInstance | null,
): ExplicitContentStatus {
  const record = instance as unknown as Record<string, unknown> | null;
  return {
    restricted: record?.restrictedEnabled === true,
    overridden: overrideApplied,
  };
}
