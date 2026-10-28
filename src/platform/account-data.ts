/** Categories of account-owned data that can survive a process restart. */
export const ACCOUNT_DATA_CATEGORIES = ["library", "pins", "queue"] as const;

export type AccountDataCategory = (typeof ACCOUNT_DATA_CATEGORIES)[number];

const FENCE_KEY = "arlet.account-data-invalidated";
const FENCE_VERSION = 1;

let memoryBlocked = new Set<AccountDataCategory>();
let storageFailedClosed = false;
let fenceRevision = 0;

export interface AccountDataInvalidation {
  revision: number;
  previousBlocked: AccountDataCategory[];
}

interface StoredFence {
  blocked: Set<AccountDataCategory>;
  valid: boolean;
}

function allCategories(): Set<AccountDataCategory> {
  return new Set(ACCOUNT_DATA_CATEGORIES);
}

function storage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("Account data storage is unavailable.");
  }
  return window.localStorage;
}

function readStoredFence(): StoredFence {
  const raw = storage().getItem(FENCE_KEY);
  if (raw === null) return { blocked: new Set(), valid: true };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== FENCE_VERSION ||
      !("blocked" in value) ||
      !Array.isArray(value.blocked) ||
      !value.blocked.every((item) =>
        ACCOUNT_DATA_CATEGORIES.some((category) => category === item),
      )
    ) {
      return { blocked: allCategories(), valid: false };
    }
    return {
      blocked: new Set(value.blocked as AccountDataCategory[]),
      valid: true,
    };
  } catch {
    return { blocked: allCategories(), valid: false };
  }
}

function writeFence(blocked: ReadonlySet<AccountDataCategory>): void {
  const ordered = ACCOUNT_DATA_CATEGORIES.filter((category) =>
    blocked.has(category),
  );
  const serialized = JSON.stringify({
    version: FENCE_VERSION,
    blocked: ordered,
  });
  try {
    const store = storage();
    store.setItem(FENCE_KEY, serialized);
    if (store.getItem(FENCE_KEY) !== serialized) {
      throw new Error("Account data fence did not persist.");
    }
  } catch {
    memoryBlocked = allCategories();
    storageFailedClosed = true;
    throw new Error("Account data fence could not be persisted.");
  }
  memoryBlocked = new Set(blocked);
  storageFailedClosed = false;
  fenceRevision += 1;
}

function unionCategories(
  left: ReadonlySet<AccountDataCategory>,
  right: ReadonlySet<AccountDataCategory>,
): Set<AccountDataCategory> {
  return new Set([...left, ...right]);
}

/**
 * Persistently fences categories before an account transition starts. A
 * returned lease can undo only this transition's fence if authorization fails
 * before the account changes.
 */
export function beginAccountDataInvalidation(
  categories: readonly AccountDataCategory[] = ACCOUNT_DATA_CATEGORIES,
): AccountDataInvalidation {
  let stored: StoredFence;
  try {
    stored = readStoredFence();
  } catch {
    memoryBlocked = allCategories();
    storageFailedClosed = true;
    throw new Error("Account data fence could not be read reliably.");
  }
  const previous = stored.valid
    ? unionCategories(stored.blocked, memoryBlocked)
    : allCategories();
  const blocked = unionCategories(previous, new Set(categories));
  writeFence(blocked);
  return {
    revision: fenceRevision,
    previousBlocked: ACCOUNT_DATA_CATEGORIES.filter((category) =>
      previous.has(category),
    ),
  };
}

/** Clears a pre-transition fence only if no later fence operation superseded it. */
export function cancelAccountDataInvalidation(
  invalidation: AccountDataInvalidation,
): void {
  if (storageFailedClosed || invalidation.revision !== fenceRevision) return;
  writeFence(new Set(invalidation.previousBlocked));
}

/** Unblocks a category only after its persisted data clear has succeeded. */
export function completeAccountDataClear(category: AccountDataCategory): void {
  if (storageFailedClosed) {
    throw new Error(
      "Account data remains blocked because its fence is unreadable.",
    );
  }
  let stored: StoredFence;
  try {
    stored = readStoredFence();
  } catch {
    memoryBlocked = allCategories();
    storageFailedClosed = true;
    throw new Error("Account data fence could not be read reliably.");
  }
  if (
    !stored.valid ||
    ![...memoryBlocked].every((item) => stored.blocked.has(item))
  ) {
    memoryBlocked = allCategories();
    storageFailedClosed = true;
    throw new Error("Account data fence changed before its clear completed.");
  }
  const blocked = new Set(stored.blocked);
  blocked.delete(category);
  writeFence(blocked);
}

/** Returns true on malformed, unavailable, or outstanding fences. */
export function isAccountDataBlocked(category: AccountDataCategory): boolean {
  if (storageFailedClosed) return true;
  let stored: StoredFence;
  try {
    stored = readStoredFence();
  } catch {
    memoryBlocked = allCategories();
    storageFailedClosed = true;
    return true;
  }
  if (
    !stored.valid ||
    ![...memoryBlocked].every((item) => stored.blocked.has(item))
  ) {
    memoryBlocked = allCategories();
    storageFailedClosed = true;
    return true;
  }
  return stored.blocked.has(category) || memoryBlocked.has(category);
}

/** Captures the fence version so an in-flight read cannot outlive a clear. */
export function accountDataReadVersion(
  category: AccountDataCategory,
): number | undefined {
  return isAccountDataBlocked(category) ? undefined : fenceRevision;
}

/** Confirms a read started and finished under the same durable fence state. */
export function isAccountDataReadCurrent(
  category: AccountDataCategory,
  version: number,
): boolean {
  return version === fenceRevision && !isAccountDataBlocked(category);
}

/** Rejects a persistence operation while its account data is fenced. */
export function assertAccountDataAvailable(
  category: AccountDataCategory,
): void {
  if (isAccountDataBlocked(category)) {
    throw new Error(`Account ${category} data is being cleared.`);
  }
}
