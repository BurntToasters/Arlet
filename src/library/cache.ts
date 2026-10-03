import Database from "@tauri-apps/plugin-sql";

/** The cache deliberately stores only normalized, non-secret library metadata. */
export const LIBRARY_CACHE_SCOPE = "current-account";
export const LIBRARY_CACHE_DB = "sqlite:arlet-library.db";

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

interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T[]>;
}

interface LibraryCacheDependencies {
  loadDatabase?: () => Promise<SqlDatabase>;
  now?: () => number;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS music_resources (
    scope TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, resource_type, resource_id)
  )`,
  `CREATE TABLE IF NOT EXISTS music_pages (
    scope TEXT NOT NULL,
    section TEXT NOT NULL,
    cursor TEXT NOT NULL,
    next_cursor TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, section, cursor)
  )`,
  `CREATE TABLE IF NOT EXISTS music_page_items (
    scope TEXT NOT NULL,
    section TEXT NOT NULL,
    cursor TEXT NOT NULL,
    position INTEGER NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    PRIMARY KEY (scope, section, cursor, position),
    FOREIGN KEY (scope, section, cursor)
      REFERENCES music_pages(scope, section, cursor)
      ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cache_meta (
    scope TEXT PRIMARY KEY,
    storefront TEXT,
    last_refresh_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS music_page_items_lookup
    ON music_page_items(scope, section, cursor, position)`,
];

interface PageRow {
  cursor: string;
  next_cursor: string | null;
  updated_at: number;
}

interface PageItemPayloadRow {
  cursor: string;
  payload: string;
}

/**
 * Rows per multi-row INSERT. Six bound values per row stays under SQLite's
 * historical 999-parameter limit.
 */
const ROWS_PER_STATEMENT = 150;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

interface MetaRow {
  scope: string;
  storefront: string | null;
  last_refresh_at: number | null;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function resourceType(value: unknown): string {
  const record = asObject(value);
  const type = record?.resourceType ?? record?.type;
  return typeof type === "string" && type.length > 0 ? type : "resource";
}

function resourceId(value: unknown): string | undefined {
  const id = asObject(value)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function pageCursor(cursor: string | undefined): string {
  // The empty string is the stable key for the first page. Cursors remain
  // opaque: they are stored and sent back verbatim, never parsed or rebuilt.
  return cursor ?? "";
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * SQLite-backed cache used by the authenticated library session. The adapter
 * is lazy so browser-only tests and the sign-in screen never open a database.
 */
export class SqlLibraryCache implements LibraryCache {
  private database: Promise<SqlDatabase> | undefined;
  private initialized = false;
  private readonly loadDatabase: () => Promise<SqlDatabase>;
  private readonly now: () => number;

  constructor(dependencies: LibraryCacheDependencies = {}) {
    this.loadDatabase =
      dependencies.loadDatabase ??
      (async () => (await Database.load(LIBRARY_CACHE_DB)) as SqlDatabase);
    this.now = dependencies.now ?? Date.now;
  }

  private async db(): Promise<SqlDatabase> {
    this.database ??= this.loadDatabase();
    const database = await this.database;
    await this.initializeWith(database);
    return database;
  }

  private async initializeWith(database: SqlDatabase): Promise<void> {
    if (this.initialized) return;
    for (const statement of schemaStatements) await database.execute(statement);
    this.initialized = true;
  }

  async initialize(): Promise<void> {
    await this.db();
  }

  async readPage<T>(
    scope: string,
    section: string,
    cursor?: string,
  ): Promise<CachedPage<T> | undefined> {
    const database = await this.db();
    const key = pageCursor(cursor);
    const pages = await database.select<PageRow>(
      `SELECT cursor, next_cursor, updated_at
       FROM music_pages WHERE scope = ? AND section = ? AND cursor = ?`,
      [scope, section, key],
    );
    const page = pages[0];
    if (!page) return undefined;
    const items = await this.readItems<T>(database, scope, section, [page]);
    return {
      cursor: key || undefined,
      items,
      next: optionalString(page.next_cursor),
      updatedAt: page.updated_at,
    };
  }

  async readSection<T>(
    scope: string,
    section: string,
  ): Promise<CachedPage<T> | undefined> {
    const database = await this.db();
    const pages = await database.select<PageRow>(
      `SELECT cursor, next_cursor, updated_at
       FROM music_pages WHERE scope = ? AND section = ?
       ORDER BY updated_at ASC`,
      [scope, section],
    );
    if (pages.length === 0) return undefined;
    const byCursor = new Map(pages.map((page) => [page.cursor, page]));
    const ordered: PageRow[] = [];
    const visited = new Set<string>();
    let cursor = "";
    while (!visited.has(cursor)) {
      const page = byCursor.get(cursor);
      if (!page) break;
      visited.add(cursor);
      ordered.push(page);
      const next = optionalString(page.next_cursor);
      if (!next) break;
      cursor = next;
    }
    const selected = ordered.length === pages.length ? ordered : pages;
    const items = await this.readItems<T>(database, scope, section, selected);
    const newest = selected[selected.length - 1];
    return {
      items,
      next: optionalString(newest.next_cursor),
      updatedAt: newest.updated_at,
    };
  }

  /** One joined query per read; per-item lookups cost an IPC round trip each. */
  private async readItems<T>(
    database: SqlDatabase,
    scope: string,
    section: string,
    pages: PageRow[],
  ): Promise<T[]> {
    if (pages.length === 0) return [];
    const single = pages.length === 1;
    const rows = await database.select<PageItemPayloadRow>(
      `SELECT i.cursor, r.payload
       FROM music_page_items i
       JOIN music_resources r
         ON r.scope = i.scope
        AND r.resource_type = i.resource_type
        AND r.resource_id = i.resource_id
       WHERE i.scope = ? AND i.section = ?${single ? " AND i.cursor = ?" : ""}
       ORDER BY i.cursor, i.position`,
      single ? [scope, section, pages[0].cursor] : [scope, section],
    );
    const byCursor = new Map<string, PageItemPayloadRow[]>();
    for (const row of rows) {
      const list = byCursor.get(row.cursor);
      if (list) list.push(row);
      else byCursor.set(row.cursor, [row]);
    }
    const output: T[] = [];
    for (const page of pages) {
      for (const row of byCursor.get(page.cursor) ?? []) {
        const parsed = parsePayload(row.payload);
        if (parsed !== undefined) output.push(parsed as T);
      }
    }
    return output;
  }

  async writePage<T>(
    scope: string,
    section: string,
    page: CachedPage<T>,
  ): Promise<void> {
    const database = await this.db();
    const cursor = pageCursor(page.cursor);
    const updatedAt = page.updatedAt ?? this.now();
    await database.execute(
      `INSERT INTO music_pages(scope, section, cursor, next_cursor, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, section, cursor) DO UPDATE SET
         next_cursor = excluded.next_cursor,
         updated_at = excluded.updated_at`,
      [scope, section, cursor, page.next ?? null, updatedAt],
    );
    await database.execute(
      `DELETE FROM music_page_items WHERE scope = ? AND section = ? AND cursor = ?`,
      [scope, section, cursor],
    );
    const rows = page.items.map((item, position) => ({
      position,
      type: resourceType(item),
      // Id-less items get a slot-scoped key so they cannot overwrite each other.
      id: resourceId(item) ?? `slot:${section}:${cursor}:${position}`,
      payload: JSON.stringify(item),
    }));
    // One upsert may not touch the same row twice; the last copy wins.
    const resources = new Map(rows.map((row) => [`${row.type} ${row.id}`, row]));
    for (const chunk of chunks([...resources.values()], ROWS_PER_STATEMENT)) {
      await database.execute(
        `INSERT INTO music_resources(scope, resource_type, resource_id, payload, updated_at)
         VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT(scope, resource_type, resource_id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        chunk.flatMap((row) => [
          scope,
          row.type,
          row.id,
          row.payload,
          updatedAt,
        ]),
      );
    }
    for (const chunk of chunks(rows, ROWS_PER_STATEMENT)) {
      await database.execute(
        `INSERT INTO music_page_items(scope, section, cursor, position, resource_type, resource_id)
         VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
        chunk.flatMap((row) => [
          scope,
          section,
          cursor,
          row.position,
          row.type,
          row.id,
        ]),
      );
    }
  }

  async clearSection(scope: string, section: string): Promise<void> {
    const database = await this.db();
    await database.execute(
      `DELETE FROM music_page_items WHERE scope = ? AND section = ?`,
      [scope, section],
    );
    await database.execute(
      `DELETE FROM music_pages WHERE scope = ? AND section = ?`,
      [scope, section],
    );
  }

  async setMeta(meta: CacheMeta): Promise<void> {
    const database = await this.db();
    await database.execute(
      `INSERT INTO cache_meta(scope, storefront, last_refresh_at)
       VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         storefront = excluded.storefront,
         last_refresh_at = excluded.last_refresh_at`,
      [meta.scope, meta.storefront ?? null, meta.lastRefreshAt ?? null],
    );
  }

  async getMeta(scope: string): Promise<CacheMeta | undefined> {
    const database = await this.db();
    const rows = await database.select<MetaRow>(
      `SELECT scope, storefront, last_refresh_at
       FROM cache_meta WHERE scope = ?`,
      [scope],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      scope: row.scope,
      storefront: optionalString(row.storefront),
      lastRefreshAt:
        typeof row.last_refresh_at === "number"
          ? row.last_refresh_at
          : undefined,
    };
  }

  async clear(scope = LIBRARY_CACHE_SCOPE): Promise<void> {
    const database = await this.db();
    await database.execute(`DELETE FROM music_page_items WHERE scope = ?`, [
      scope,
    ]);
    await database.execute(`DELETE FROM music_pages WHERE scope = ?`, [scope]);
    await database.execute(`DELETE FROM music_resources WHERE scope = ?`, [
      scope,
    ]);
    await database.execute(`DELETE FROM cache_meta WHERE scope = ?`, [scope]);
  }
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
    if (values.length === 0) return undefined;
    const last = values[values.length - 1];
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

export function createLibraryCache(
  dependencies: LibraryCacheDependencies = {},
): LibraryCache {
  const tauri = (globalThis as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  if (!dependencies.loadDatabase && !tauri) return new MemoryLibraryCache();
  return new SqlLibraryCache(dependencies);
}
