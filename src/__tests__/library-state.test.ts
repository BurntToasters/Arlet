import { beforeEach, describe, expect, it } from "vitest";
import {
  appendLibraryCollectionItems,
  getState,
  resetApplicationState,
  setAccountSummary,
  setLibraryCollectionItems,
} from "../state.ts";

beforeEach(() => resetApplicationState());

describe("library state", () => {
  it("stores provider metadata without an Apple identity", () => {
    setAccountSummary({ storefront: "us", connectedAt: 123 });
    const state = getState();
    expect(state.account).toEqual({
      provider: "Apple Music",
      label: "Apple Music account",
      storefront: "us",
      connectedAt: 123,
    });
    expect("displayName" in state.account).toBe(false);
  });

  it("replaces a page and deduplicates loaded pages", () => {
    setLibraryCollectionItems("songs", [{ id: "one" }], {
      source: "cache",
      stale: true,
      lastUpdatedAt: 10,
    });
    appendLibraryCollectionItems("songs", [{ id: "one" }, { id: "two" }], {
      source: "network",
      lastUpdatedAt: 20,
    });
    expect(
      getState().library.collections.songs.items.map((item) => item.id),
    ).toEqual(["one", "two"]);
    expect(getState().library.collections.songs.stale).toBe(false);
    expect(getState().library.collections.songs.source).toBe("network");
  });
});
