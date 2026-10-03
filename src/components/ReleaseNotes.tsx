import type { JSX } from "preact";

export const RELEASE_NOTES_FALLBACK = "Release notes unavailable.";

type InlineChild = string | JSX.Element;

interface LinkMatch {
  end: number;
  label: string;
}

function appendText(children: InlineChild[], value: string): void {
  if (!value) return;
  const previous = children[children.length - 1];
  if (typeof previous === "string") {
    children[children.length - 1] = previous + value;
  } else {
    children.push(value);
  }
}

type Finder = (needle: string, from: number) => number;

/**
 * indexOf that remembers misses. Scans only move forward, so once a closer
 * is missing it stays missing; without this, hostile input with thousands of
 * unmatched openers rescans the rest of the text from every position.
 */
function createFinder(source: string): Finder {
  const missing = new Set<string>();
  return (needle, from) => {
    if (missing.has(needle)) return -1;
    const found = source.indexOf(needle, from);
    if (found < 0) missing.add(needle);
    return found;
  };
}

function linkAt(
  source: string,
  start: number,
  find: Finder,
): LinkMatch | undefined {
  if (source[start] !== "[") return undefined;
  const labelEnd = find("]", start + 1);
  if (labelEnd <= start + 1 || source[labelEnd + 1] !== "(") return undefined;
  const destinationEnd = find(")", labelEnd + 2);
  if (destinationEnd < 0) return undefined;
  const label = source.slice(start + 1, labelEnd);
  const destination = source.slice(labelEnd + 2, destinationEnd);
  if (!destination || /[\r\n]/u.test(destination)) return undefined;
  return { end: destinationEnd + 1, label };
}

function inlineChildren(source: string, keyPrefix: string): InlineChild[] {
  const children: InlineChild[] = [];
  const find = createFinder(source);
  let index = 0;
  while (index < source.length) {
    // Keep HTML-like input as literal text, including any markdown-looking
    // characters inside the tag. JSX text nodes escape it automatically.
    if (source[index] === "<") {
      const tagEnd = find(">", index + 1);
      if (tagEnd >= 0) {
        appendText(children, source.slice(index, tagEnd + 1));
        index = tagEnd + 1;
        continue;
      }
    }

    if (source[index] === "`") {
      let tickCount = 1;
      while (source[index + tickCount] === "`") tickCount += 1;
      const marker = "`".repeat(tickCount);
      const codeEnd = find(marker, index + tickCount);
      if (codeEnd > index + tickCount) {
        children.push(
          <code key={`${keyPrefix}-${children.length}-code`}>
            {source.slice(index + tickCount, codeEnd)}
          </code>,
        );
        index = codeEnd + tickCount;
        continue;
      }
    }

    // Images intentionally stay literal: release notes never create image
    // elements or request remote resources.
    if (source[index] === "!" && source[index + 1] === "[") {
      const image = linkAt(source, index + 1, find);
      if (image) {
        appendText(children, source.slice(index, image.end));
        index = image.end;
        continue;
      }
    }

    if (source[index] === "[") {
      const link = linkAt(source, index, find);
      if (link) {
        // Links are deliberately rendered as their label without navigation.
        children.push(
          <span key={`${keyPrefix}-${children.length}-link`}>
            {inlineChildren(link.label, `${keyPrefix}-${children.length}-link`)}
          </span>,
        );
        index = link.end;
        continue;
      }
    }

    const marker = source[index];
    if (marker === "*" || marker === "_") {
      const strongMarker = marker.repeat(2);
      if (source.startsWith(strongMarker, index)) {
        const strongEnd = find(strongMarker, index + 2);
        if (strongEnd > index + 2) {
          const content = source.slice(index + 2, strongEnd);
          if (!/^\s|\s$/u.test(content)) {
            children.push(
              <strong key={`${keyPrefix}-${children.length}-strong`}>
                {inlineChildren(
                  content,
                  `${keyPrefix}-${children.length}-strong`,
                )}
              </strong>,
            );
            index = strongEnd + 2;
            continue;
          }
        }
      }

      const emphasisEnd = find(marker, index + 1);
      if (
        emphasisEnd > index + 1 &&
        !/^\s|\s$/u.test(source.slice(index + 1, emphasisEnd))
      ) {
        children.push(
          <em key={`${keyPrefix}-${children.length}-emphasis`}>
            {inlineChildren(
              source.slice(index + 1, emphasisEnd),
              `${keyPrefix}-${children.length}-emphasis`,
            )}
          </em>,
        );
        index = emphasisEnd + 1;
        continue;
      }
    }

    appendText(children, source[index]);
    index += 1;
  }
  return children;
}

const FENCE_PATTERN = /^\s*(`{3,}|~{3,})(.*)$/u;
// Linear: closing hashes are stripped by headingText, not by backtracking.
const HEADING_PATTERN = /^\s{0,3}(#{1,6})[ \t]+(\S.*)$/u;
const UNORDERED_ITEM_PATTERN = /^\s{0,3}[-+*][ \t]+(.+)$/u;
const ORDERED_ITEM_PATTERN = /^\s{0,3}\d+[.)][ \t]+(.+)$/u;
const QUOTE_PATTERN = /^\s{0,3}>[ \t]?(.*)$/u;
/** Deeper `>` nesting renders as text instead of recursing. */
const MAX_QUOTE_DEPTH = 6;

/** Drops an optional closing `#` sequence, as CommonMark does. */
function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === text.length || (end > 0 && !/[ \t]/u.test(text[end - 1]))) {
    return text;
  }
  return text.slice(0, end).trimEnd() || text;
}

function isBlockStart(line: string): boolean {
  return (
    FENCE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    UNORDERED_ITEM_PATTERN.test(line) ||
    ORDERED_ITEM_PATTERN.test(line) ||
    QUOTE_PATTERN.test(line)
  );
}

function renderBlocks(
  lines: string[],
  keyPrefix: string,
  depth = 0,
): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_PATTERN.exec(lines[index]);
    if (fence) {
      const fenceMarker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !lines[index].trimStart().startsWith(fenceMarker)
      ) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      elements.push(
        <pre key={`${keyPrefix}-${elements.length}-code`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING_PATTERN.exec(lines[index]);
    if (heading) {
      const level = heading[1].length;
      const content = inlineChildren(
        headingText(heading[2]),
        `${keyPrefix}-${elements.length}-heading`,
      );
      const key = `${keyPrefix}-${elements.length}-heading`;
      if (level === 1) elements.push(<h1 key={key}>{content}</h1>);
      else if (level === 2) elements.push(<h2 key={key}>{content}</h2>);
      else if (level === 3) elements.push(<h3 key={key}>{content}</h3>);
      else if (level === 4) elements.push(<h4 key={key}>{content}</h4>);
      else if (level === 5) elements.push(<h5 key={key}>{content}</h5>);
      else elements.push(<h6 key={key}>{content}</h6>);
      index += 1;
      continue;
    }

    const quote =
      depth < MAX_QUOTE_DEPTH ? QUOTE_PATTERN.exec(lines[index]) : null;
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const nextQuote = QUOTE_PATTERN.exec(lines[index]);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]);
        index += 1;
      }
      elements.push(
        <blockquote key={`${keyPrefix}-${elements.length}-quote`}>
          {renderBlocks(
            quoteLines,
            `${keyPrefix}-${elements.length}-quote`,
            depth + 1,
          )}
        </blockquote>,
      );
      continue;
    }

    const unordered = UNORDERED_ITEM_PATTERN.exec(lines[index]);
    const ordered = ORDERED_ITEM_PATTERN.exec(lines[index]);
    if (unordered || ordered) {
      const listItems: JSX.Element[] = [];
      const listIsOrdered = Boolean(ordered);
      while (index < lines.length) {
        const next = (
          listIsOrdered ? ORDERED_ITEM_PATTERN : UNORDERED_ITEM_PATTERN
        ).exec(lines[index]);
        if (!next) break;
        listItems.push(
          <li key={`${keyPrefix}-${elements.length}-item-${listItems.length}`}>
            {inlineChildren(
              next[1],
              `${keyPrefix}-${elements.length}-item-${listItems.length}`,
            )}
          </li>,
        );
        index += 1;
      }
      const listKey = `${keyPrefix}-${elements.length}-list`;
      elements.push(
        listIsOrdered ? (
          <ol key={listKey}>{listItems}</ol>
        ) : (
          <ul key={listKey}>{listItems}</ul>
        ),
      );
      continue;
    }

    const paragraphLines: string[] = [lines[index]];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    elements.push(
      <p key={`${keyPrefix}-${elements.length}-paragraph`}>
        {inlineChildren(
          paragraphLines.join("\n"),
          `${keyPrefix}-${elements.length}-paragraph`,
        )}
      </p>,
    );
  }
  return elements;
}

export interface ReleaseNotesProps {
  markdown?: string;
}

/** Render untrusted release notes with a deliberately small, safe Markdown subset. */
export function ReleaseNotes({ markdown }: ReleaseNotesProps): JSX.Element {
  if (typeof markdown !== "string" || !markdown.trim()) {
    return (
      <p className="update-modal-notes-fallback">{RELEASE_NOTES_FALLBACK}</p>
    );
  }
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  return <>{renderBlocks(lines, "release-notes")}</>;
}

export default ReleaseNotes;
