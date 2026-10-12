import { invoke } from "@tauri-apps/api/core";

/** The cache deliberately stores only normalized, non-secret library metadata. */
export const LIBRARY_CACHE_SCOPE = "current-account";

export interface CachedPage<T> {
  cursor?: string;
  items: T[];
  next?: string;
  updatedAt: number;
}

export interface CacheMeta {
  scope: string;
  storefront?: string;
  lastRefreshAt?: number;
}

export interface LibraryCache {
  initialize(): Promise<void>;
  readPage<T>(
    scope: string,
    section: string,
    cursor?: string,
  ): Promise<CachedPage<T> | undefined>;
  readSection<T>(
    scope: string,
    section: string,
  ): Promise<CachedPage<T> | undefined>;
  writePage<T>(
    scope: string,
    section: string,
    page: CachedPage<T>,
  ): Promise<void>;
  clearSection(scope: string, section: string): Promise<void>;
  setMeta(meta: CacheMeta): Promise<void>;
  getMeta(scope: string): Promise<CacheMeta | undefined>;
  clear(scope?: string): Promise<void>;
}

export type CacheInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * SQLite cache owned by Rust (src-tauri/src/library_cache.rs). The webview
 * calls fixed commands and never runs SQL itself.
 */
export class NativeLibraryCache implements LibraryCache {
  constructor(private readonly call: CacheInvoke = invoke as CacheInvoke) {}

  async initialize(): Promise<void> {
    // Rust opens and migrates the database on first use.
  }

  async readPage<T>(
    scope: string,
    section: string,
    cursor?: string,
  ): Promise<CachedPage<T> | undefined> {
    const page = await this.call<CachedPage<T> | null>(
      "library_cache_read_page",
      { scope, section, cursor },
    );
    return page ?? undefined;
  }

  async readSection<T>(
    scope: string,
    section: string,
  ): Promise<CachedPage<T> | undefined> {
    const page = await this.call<CachedPage<T> | null>(
      "library_cache_read_section",
      { scope, section },
    );
    return page ?? undefined;
  }

  async writePage<T>(
    scope: string,
    section: string,
    page: CachedPage<T>,
  ): Promise<void> {
    await this.call("library_cache_write_page", { scope, section, page });
  }

  async clearSection(scope: string, section: string): Promise<void> {
    await this.call("library_cache_clear_section", { scope, section });
  }

  async setMeta(meta: CacheMeta): Promise<void> {
    await this.call("library_cache_set_meta", { meta });
  }

  async getMeta(scope: string): Promise<CacheMeta | undefined> {
    const meta = await this.call<CacheMeta | null>("library_cache_get_meta", {
      scope,
    });
    return meta ?? undefined;
  }

  async clear(scope = LIBRARY_CACHE_SCOPE): Promise<void> {
    await this.call("library_cache_clear", { scope });
  }
}

function pageCursor(cursor: string | undefined): string {
  // The empty string is the stable key for the first page. Cursors remain
  // opaque: they are stored and sent back verbatim, never parsed or rebuilt.
  return cursor ?? "";
}

interface MemoryPage {
  page: CachedPage<unknown>;
}

/** Fast deterministic cache for unit tests and non-Tauri preview mode. */
export class MemoryLibraryCache implements LibraryCache {
  private readonly pages = new Map<string, MemoryPage>();
  private readonly metas = new Map<string, CacheMeta>();

  async initialize(): Promise<void> {
    return undefined;
  }

  async readPage<T>(
    scope: string,
    section: string,
    cursor?: string,
  ): Promise<CachedPage<T> | undefined> {
    const value = this.pages.get(
      `${scope}\u0000${section}\u0000${pageCursor(cursor)}`,
    );
    return value
      ? {
          ...value.page,
          items: value.page.items.map((item) => item as T),
        }
      : undefined;
  }

  async readSection<T>(
    scope: string,
    section: string,
  ): Promise<CachedPage<T> | undefined> {
    const prefix = `${scope}\u0000${section}\u0000`;
    const entries = [...this.pages.entries()].filter(([key]) =>
      key.startsWith(prefix),
    );
    const byCursor = new Map(
      entries.map(([key, value]) => [key.slice(prefix.length), value.page]),
    );
    const values: CachedPage<unknown>[] = [];
    const visited = new Set<string>();
    let cursor = "";
    while (!visited.has(cursor)) {
      const value = byCursor.get(cursor);
      if (!value) break;
      visited.add(cursor);
      values.push(value);
      if (!value.next) break;
      cursor = value.next;
    }
    if (values.length !== entries.length) {
      values.push(
        ...entries
          .filter(([key]) => !visited.has(key.slice(prefix.length)))
          .sort(
            (left, right) => left[1].page.updatedAt - right[1].page.updatedAt,
          )
          .map(([, value]) => value.page),
      );
    }
    const last = values.at(-1);
    if (!last) return undefined;
    return {
      items: values.flatMap((value) => value.items as T[]),
      next: last.next,
      updatedAt: last.updatedAt,
    };
  }

  async writePage<T>(
    scope: string,
    section: string,
    page: CachedPage<T>,
  ): Promise<void> {
    this.pages.set(`${scope}\u0000${section}\u0000${pageCursor(page.cursor)}`, {
      page: {
        ...page,
        items: [...page.items],
      },
    });
  }

  async clearSection(scope: string, section: string): Promise<void> {
    const prefix = `${scope}\u0000${section}\u0000`;
    for (const key of this.pages.keys()) {
      if (key.startsWith(prefix)) this.pages.delete(key);
    }
  }

  async setMeta(meta: CacheMeta): Promise<void> {
    this.metas.set(meta.scope, { ...meta });
  }

  async getMeta(scope: string): Promise<CacheMeta | undefined> {
    const meta = this.metas.get(scope);
    return meta ? { ...meta } : undefined;
  }

  async clear(scope?: string): Promise<void> {
    if (scope === undefined) {
      this.pages.clear();
      this.metas.clear();
      return;
    }
    const prefix = `${scope}\u0000`;
    for (const key of this.pages.keys()) {
      if (key.startsWith(prefix)) this.pages.delete(key);
    }
    this.metas.delete(scope);
  }
}

export function createLibraryCache(call?: CacheInvoke): LibraryCache {
  const tauri = (globalThis as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  if (!call && !tauri) return new MemoryLibraryCache();
  return new NativeLibraryCache(call);
}
