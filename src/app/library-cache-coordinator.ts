import {
  LIBRARY_CACHE_SCOPE,
  type CachedPage,
  type LibraryCache,
} from "../library/cache.ts";
import {
  accountDataReadVersion,
  assertAccountDataAvailable,
  isAccountDataReadCurrent,
} from "../platform/account-data.ts";
import { getState, setAccountSummary, setLibraryHydrated } from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";

export interface LibraryCacheCoordinatorDependencies {
  storedCache: LibraryCache;
}

/**
 * Coordinates the SQLite library cache: opens it once, tracks the account
 * generation that stale work is checked against, and queues cache writes so
 * they run in order and never land after a sign-out.
 */
export function createLibraryCacheCoordinator(
  context: ControllerContext,
  deps: LibraryCacheCoordinatorDependencies,
) {
  const { log } = context;
  const { storedCache } = deps;
  let cacheReady: Promise<void> | undefined;
  /**
   * False after a clear failed: the file may still hold the previous
   * account's library, so reads skip it until a clear succeeds.
   */
  let cacheTrusted = true;
  const libraryCache: LibraryCache = {
    initialize: () => storedCache.initialize(),
    readPage: async <T>(
      scope: string,
      section: string,
      cursor?: string,
    ): Promise<CachedPage<T> | undefined> => {
      if (!cacheTrusted) return undefined;
      const version = accountDataReadVersion("library");
      if (version === undefined) return undefined;
      const page = await storedCache.readPage<T>(scope, section, cursor);
      return cacheTrusted && isAccountDataReadCurrent("library", version)
        ? page
        : undefined;
    },
    readSection: async <T>(
      scope: string,
      section: string,
    ): Promise<CachedPage<T> | undefined> => {
      if (!cacheTrusted) return undefined;
      const version = accountDataReadVersion("library");
      if (version === undefined) return undefined;
      const page = await storedCache.readSection<T>(scope, section);
      return cacheTrusted && isAccountDataReadCurrent("library", version)
        ? page
        : undefined;
    },
    writePage: async (scope, section, page) => {
      assertAccountDataAvailable("library");
      await storedCache.writePage(scope, section, page);
      assertAccountDataAvailable("library");
    },
    clearSection: async (scope, section) => {
      assertAccountDataAvailable("library");
      await storedCache.clearSection(scope, section);
      assertAccountDataAvailable("library");
    },
    setMeta: async (meta) => {
      assertAccountDataAvailable("library");
      await storedCache.setMeta(meta);
      assertAccountDataAvailable("library");
    },
    getMeta: async (scope) => {
      if (!cacheTrusted) return undefined;
      const version = accountDataReadVersion("library");
      if (version === undefined) return undefined;
      const meta = await storedCache.getMeta(scope);
      return cacheTrusted && isAccountDataReadCurrent("library", version)
        ? meta
        : undefined;
    },
    clear: async (scope) => {
      try {
        await storedCache.clear(scope);
      } catch (first) {
        // One retry covers a briefly locked file.
        try {
          await storedCache.clear(scope);
        } catch {
          cacheTrusted = false;
          throw first;
        }
      }
      cacheTrusted = true;
    },
  };
  /** Account generation whose cache metadata is already in state. */
  let hydratedGeneration: number | undefined;
  let accountGeneration = 0;
  let cacheMutationQueue: Promise<void> = Promise.resolve();
  let cacheResetBarrier: Promise<void> = Promise.resolve();

  const currentGeneration = (): number => accountGeneration;

  const isAccountGenerationCurrent = (generation: number): boolean =>
    accountGeneration === generation;

  const waitForCacheReset = async (generation: number): Promise<boolean> => {
    const barrier = cacheResetBarrier;
    await barrier;
    return isAccountGenerationCurrent(generation);
  };

  const enqueueCacheMutation = (
    isCurrent: () => boolean,
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    const queued = cacheMutationQueue.then(async () => {
      if (!isCurrent()) return false;
      await operation();
      return true;
    });
    cacheMutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  /** Opens the SQLite file once. Shows nothing, so it is safe before sign-in. */
  const openLibraryCache = (): Promise<void> => {
    cacheReady ??= libraryCache.initialize().catch((error: unknown) => {
      log(`Library cache unavailable: ${safeErrorMessage(error)}`);
    });
    return cacheReady;
  };

  const ensureLibraryCache = async (
    generation = accountGeneration,
  ): Promise<void> => {
    if (!(await waitForCacheReset(generation))) return;
    await openLibraryCache();
    if (!isAccountGenerationCurrent(generation)) return;
    // Meta is read once per account; repeating it on every load cost two
    // full-app notifies each time.
    if (hydratedGeneration === generation) return;
    hydratedGeneration = generation;
    if (!getState().library.hydrated) setLibraryHydrated(true);
    try {
      const meta = await libraryCache.getMeta(LIBRARY_CACHE_SCOPE);
      if (
        isAccountGenerationCurrent(generation) &&
        (meta?.storefront || meta?.lastRefreshAt)
      ) {
        setAccountSummary({
          storefront: meta.storefront,
          lastRefreshAt: meta.lastRefreshAt,
        });
      }
    } catch (error) {
      log(`Library cache metadata unavailable: ${safeErrorMessage(error)}`);
    }
  };

  /**
   * Starts a new account generation. `resetAccountState` runs first so the
   * loader drops its in-flight bookkeeping; then the cache file is cleared.
   */
  const clearLibraryCache = async (
    resetAccountState: () => void,
  ): Promise<void> => {
    const generation = ++accountGeneration;
    resetAccountState();
    const clear = enqueueCacheMutation(
      () => isAccountGenerationCurrent(generation),
      () => libraryCache.clear(LIBRARY_CACHE_SCOPE),
    );
    cacheResetBarrier = clear.then(
      () => undefined,
      () => undefined,
    );
    try {
      if (!(await clear)) {
        throw new Error("Library cache clear was superseded.");
      }
    } catch (error) {
      log(`Library cache clear failed: ${safeErrorMessage(error)}`);
      throw error;
    }
  };

  /** Settles once the latest cache clear has finished. */
  const awaitCacheReset = (): Promise<void> => cacheResetBarrier;

  return {
    libraryCache,
    currentGeneration,
    isAccountGenerationCurrent,
    enqueueCacheMutation,
    openLibraryCache,
    ensureLibraryCache,
    clearLibraryCache,
    awaitCacheReset,
  };
}

export type LibraryCacheCoordinator = ReturnType<
  typeof createLibraryCacheCoordinator
>;
