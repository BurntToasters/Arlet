import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "preact/test-utils";
import { h, render } from "preact";
import {
  VIRTUALIZE_THRESHOLD,
  VirtualList,
} from "../components/VirtualList.tsx";

const ROW = 65;

// Failure modes: a 5,000-song library renders 5,000 rows and re-diffs them
// on every state change; scrolling shows blank space because the window
// does not follow the scroll position; spacers drift so the scrollbar
// jumps; small lists change behavior they do not need to.
describe("VirtualList", () => {
  let scroller: HTMLDivElement;
  let root: HTMLDivElement;
  let scrolledBy = 0;

  beforeEach(() => {
    scrolledBy = 0;
    scroller = document.createElement("div");
    scroller.className = "content-scroll";
    Object.defineProperty(scroller, "clientHeight", { value: 650 });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    root = document.createElement("div");
    scroller.append(root);
    document.body.append(scroller);
  });

  afterEach(() => {
    void act(() => render(null, root));
    scroller.remove();
  });

  const mount = (count: number) => {
    const items = Array.from({ length: count }, (_, index) => `song-${index}`);
    void act(() => {
      render(
        h(VirtualList<string>, {
          items,
          getKey: (item: string) => item,
          rowHeight: ROW,
          className: "library-track-list",
          renderRow: (item: string) => h("li", { class: "row" }, item),
        }),
        root,
      );
    });
    const list = root.querySelector("ol")!;
    list.getBoundingClientRect = () => ({ top: -scrolledBy }) as DOMRect;
    return list;
  };

  const rendered = () =>
    [...root.querySelectorAll(".row")].map((node) => node.textContent);
  const spacers = () =>
    [...root.querySelectorAll<HTMLElement>("li[aria-hidden='true']")].map(
      (node) => node.style.height,
    );

  it("renders small lists in full", () => {
    mount(VIRTUALIZE_THRESHOLD);
    expect(rendered()).toHaveLength(VIRTUALIZE_THRESHOLD);
    expect(spacers()).toEqual([]);
  });

  it("renders only the visible window of a large list", () => {
    mount(5000);
    expect(rendered().length).toBeLessThan(40);
    expect(rendered()[0]).toBe("song-0");
    const [top, bottom] = spacers();
    expect(top).toBe("0px");
    expect(Number.parseInt(bottom, 10) + rendered().length * ROW).toBe(
      5000 * ROW,
    );
  });

  it("moves the window with the scroll position", () => {
    mount(5000);
    scrolledBy = 2000 * ROW;
    void act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    const rows = rendered();
    expect(rows).toContain("song-2000");
    expect(rows).not.toContain("song-0");
    const [top, bottom] = spacers();
    const first = Number(rows[0]?.replace("song-", ""));
    expect(top).toBe(`${first * ROW}px`);
    expect(
      Number.parseInt(top, 10) +
        rows.length * ROW +
        Number.parseInt(bottom, 10),
    ).toBe(5000 * ROW);
  });
});
