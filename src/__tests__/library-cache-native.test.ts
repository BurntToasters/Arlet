import { describe, expect, it, vi } from "vitest";
import {
  LIBRARY_CACHE_SCOPE,
  NativeLibraryCache,
  type CacheInvoke,
} from "../library/cache.ts";

// The SQL itself is tested in src-tauri/src/library_cache.rs. Failure modes
// here: command names or argument keys drift from the Rust commands; Rust
// `None` (JSON null) leaks out where callers expect `undefined`; clear()
// without a scope wipes nothing or everything.
describe("native library cache client", () => {
  const setup = (responses: Record<string, unknown> = {}) => {
    const invoke = vi.fn(async (command: string) => responses[command] ?? null);
    return {
      invoke,
      cache: new NativeLibraryCache(invoke as unknown as CacheInvoke),
    };
  };

  it("maps every operation to its Rust command", async () => {
    const { invoke, cache } = setup();
    const page = { cursor: "c", items: [{ id: "a" }], next: "n", updatedAt: 1 };
    await cache.readPage("s", "songs", "c");
    await cache.readSection("s", "songs");
    await cache.writePage("s", "songs", page);
    await cache.clearSection("s", "songs");
    await cache.setMeta({ scope: "s", storefront: "us", lastRefreshAt: 2 });
    await cache.getMeta("s");
    await cache.clear("s");
    expect(invoke.mock.calls).toEqual([
      [
        "library_cache_read_page",
        { scope: "s", section: "songs", cursor: "c" },
      ],
      ["library_cache_read_section", { scope: "s", section: "songs" }],
      ["library_cache_write_page", { scope: "s", section: "songs", page }],
      ["library_cache_clear_section", { scope: "s", section: "songs" }],
      [
        "library_cache_set_meta",
        { meta: { scope: "s", storefront: "us", lastRefreshAt: 2 } },
      ],
      ["library_cache_get_meta", { scope: "s" }],
      ["library_cache_clear", { scope: "s" }],
    ]);
  });

  it("turns Rust None into undefined and defaults the clear scope", async () => {
    const { invoke, cache } = setup();
    await expect(cache.readPage("s", "songs")).resolves.toBeUndefined();
    await expect(cache.readSection("s", "songs")).resolves.toBeUndefined();
    await expect(cache.getMeta("s")).resolves.toBeUndefined();
    await cache.clear();
    expect(invoke).toHaveBeenLastCalledWith("library_cache_clear", {
      scope: LIBRARY_CACHE_SCOPE,
    });
    await cache.initialize();
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("returns pages and meta from Rust unchanged", async () => {
    const page = { items: [{ id: "a" }], updatedAt: 3 };
    const meta = { scope: "s", storefront: "us" };
    const { cache } = setup({
      library_cache_read_section: page,
      library_cache_get_meta: meta,
    });
    await expect(cache.readSection("s", "songs")).resolves.toEqual(page);
    await expect(cache.getMeta("s")).resolves.toEqual(meta);
  });
});
