import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { h, render } from "preact";
import { ReleaseNotes } from "../components/ReleaseNotes.tsx";

// Release notes come from the updater manifest, which the installer signature
// does not cover. Failure modes for hostile 64 KiB input: unmatched `[`, `<`,
// `*`, or backticks rescanning the rest of the text from every position
// (quadratic); a heading with a long space run backtracking catastrophically;
// deeply nested `>` quotes overflowing the stack during render.
const LIMIT = 64 * 1024;
const BUDGET_MS = 1500;

describe("release notes with hostile input", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
  });

  afterEach(() => {
    render(null, root);
  });

  const renderTimed = (markdown: string): number => {
    const started = performance.now();
    render(h(ReleaseNotes, { markdown }), root);
    return performance.now() - started;
  };

  it.each([
    ["unmatched brackets", "[".repeat(LIMIT)],
    ["bracket without destination", "[a]".repeat(LIMIT / 3)],
    ["unmatched angle brackets", "<".repeat(LIMIT)],
    ["unmatched emphasis", "*a".repeat(LIMIT / 2)],
    ["unmatched code", "`a".repeat(LIMIT / 2)],
    ["heading space run", `# a${" ".repeat(LIMIT - 8)}b`],
  ])("renders %s within budget", (_name, markdown) => {
    expect(renderTimed(markdown)).toBeLessThan(BUDGET_MS);
    expect(root.textContent?.length).toBeGreaterThan(0);
  });

  it("caps quote nesting instead of overflowing the stack", () => {
    const markdown = `${">".repeat(20_000)} deep`;
    expect(() => renderTimed(markdown)).not.toThrow();
    expect(root.textContent).toContain("deep");
    expect(root.querySelectorAll("blockquote").length).toBeLessThanOrEqual(8);
  });

  it("still renders ordinary notes", () => {
    render(
      h(ReleaseNotes, {
        markdown: "## New\n\n- **Bold** and *em* with `code` and [link](x)",
      }),
      root,
    );
    expect(root.querySelector("h2")?.textContent).toBe("New");
    expect(root.querySelector("strong")?.textContent).toBe("Bold");
    expect(root.querySelector("em")?.textContent).toBe("em");
    expect(root.querySelector("code")?.textContent).toBe("code");
    expect(root.querySelector("a")).toBeNull();
  });
});
