// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlLibraryCache } from "../library/cache.ts";

// Real SQLite (Node's built-in driver) behind the plugin-sql call shape.
// Failure modes covered:
// 1. Reads issue one query per item (N+1 IPC round trips per library load).
// 2. Writes issue two queries per item.
// 3. Items without an id collapse onto one "unknown" row and render twice.
// 4. A duplicate id inside one page breaks a batched upsert
//    ("ON CONFLICT DO UPDATE command cannot affect row a second time").
// 5. Large pages exceed SQLite's bound-parameter limit.
// 6. Rewriting a page leaves stale items behind.
// 7. Section reads lose page order or in-page position order.
// 8. Clearing one scope touches another.
function sqliteAdapter() {
  const db = new DatabaseSync(":memory:");
  const calls = { select: 0, execute: 0 };
  return {
    calls,
    loadDatabase: async () => ({
      async execute(query: string, bindValues: unknown[] = []) {
        calls.execute += 1;
        db.prepare(query).run(...(bindValues as never[]));
        return undefined;
      },
      async select<T>(query: string, bindValues: unknown[] = []) {
        calls.select += 1;
        return db.prepare(query).all(...(bindValues as never[])) as T[];
      },
    }),
  };
}

function songs(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: "library-songs",
    title: `Song ${index}`,
  }));
}

describe("SqlLibraryCache on SQLite", () => {
  it("reads a multi-page section with a bounded query count", async () => {
    const adapter = sqliteAdapter();
    const cache = new SqlLibraryCache({ loadDatabase: adapter.loadDatabase });
    await cache.writePage("s", "songs", {
      items: songs("a", 300),
      next: "page-2",
      updatedAt: 1,
    });
    await cache.writePage("s", "songs", {
      cursor: "page-2",
      items: songs("b", 300),
      updatedAt: 2,
    });
    const writeQueries = adapter.calls.execute;
    expect(writeQueries).toBeLessThan(40);

    adapter.calls.select = 0;
    const section = await cache.readSection<{ id: string }>("s", "songs");
    expect(adapter.calls.select).toBeLessThanOrEqual(3);
    expect(section?.items).toHaveLength(600);
    expect(section?.items[0].id).toBe("a-0");
    expect(section?.items[299].id).toBe("a-299");
    expect(section?.items[300].id).toBe("b-0");
    expect(section?.items[599].id).toBe("b-299");

    adapter.calls.select = 0;
    const page = await cache.readPage<{ id: string }>("s", "songs", "page-2");
    expect(adapter.calls.select).toBeLessThanOrEqual(3);
    expect(page?.items.map((item) => item.id)).toEqual(
      songs("b", 300).map((item) => item.id),
    );
  });

  it("keeps id-less items distinct and tolerates duplicate ids", async () => {
    const adapter = sqliteAdapter();
    const cache = new SqlLibraryCache({ loadDatabase: adapter.loadDatabase });
    await cache.writePage("s", "mixed", {
      items: [
        { title: "No id one" },
        { id: "dup", type: "songs", title: "First" },
        { title: "No id two" },
        { id: "dup", type: "songs", title: "Second" },
      ],
      updatedAt: 1,
    });
    const page = await cache.readPage<{ title: string }>("s", "mixed");
    expect(page?.items.map((item) => item.title)).toEqual([
      "No id one",
      "Second",
      "No id two",
      "Second",
    ]);
  });

  it("writes pages larger than the bound-parameter limit", async () => {
    const adapter = sqliteAdapter();
    const cache = new SqlLibraryCache({ loadDatabase: adapter.loadDatabase });
    await cache.writePage("s", "songs", {
      items: songs("big", 7000),
      updatedAt: 1,
    });
    const page = await cache.readPage<{ id: string }>("s", "songs");
    expect(page?.items).toHaveLength(7000);
    expect(page?.items[6999].id).toBe("big-6999");
  });

  it("replaces a rewritten page and isolates scopes", async () => {
    const adapter = sqliteAdapter();
    const cache = new SqlLibraryCache({ loadDatabase: adapter.loadDatabase });
    await cache.writePage("a", "songs", {
      items: songs("old", 5),
      updatedAt: 1,
    });
    await cache.writePage("b", "songs", {
      items: songs("other", 2),
      updatedAt: 1,
    });
    await cache.writePage("a", "songs", {
      items: songs("new", 2),
      updatedAt: 2,
    });
    const page = await cache.readPage<{ id: string }>("a", "songs");
    expect(page?.items.map((item) => item.id)).toEqual(["new-0", "new-1"]);

    await cache.clear("a");
    await expect(cache.readSection("a", "songs")).resolves.toBeUndefined();
    const other = await cache.readSection<{ id: string }>("b", "songs");
    expect(other?.items.map((item) => item.id)).toEqual(["other-0", "other-1"]);
  });
});
