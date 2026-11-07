import { LoaderCircle, Search, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useModalDialog } from "./use-modal-dialog.ts";

export interface LicenseEntry {
  name: string;
  licenses: string;
  licenseText?: string;
}

type FetchJson = (url: string) => Promise<unknown>;

const INVENTORIES = ["/licenses.json", "/licenses-cargo.json"];

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

/**
 * npm and cargo notices generated at build time into the bundle. A missing
 * or malformed inventory contributes nothing instead of failing the screen.
 */
export async function loadLicenseInventory(
  fetchJson: FetchJson = defaultFetchJson,
): Promise<LicenseEntry[]> {
  const results = await Promise.allSettled(INVENTORIES.map(fetchJson));
  const entries: LicenseEntry[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const inventory = result.value;
    if (!inventory || typeof inventory !== "object") continue;
    for (const [name, raw] of Object.entries(inventory)) {
      const record = raw as Record<string, unknown> | null;
      if (!record || typeof record !== "object") continue;
      entries.push({
        name,
        licenses:
          typeof record.licenses === "string" ? record.licenses : "UNKNOWN",
        ...(typeof record.licenseText === "string"
          ? { licenseText: record.licenseText }
          : {}),
      });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export interface LicensesDialogProps {
  onClose: () => void;
  load?: () => Promise<LicenseEntry[]>;
}

/** Open-source notices for everything bundled into Arlet. */
export function LicensesDialog({
  onClose,
  load = loadLicenseInventory,
}: LicensesDialogProps): JSX.Element {
  const [entries, setEntries] = useState<LicenseEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The effect runs once; this keeps it on the latest props without
  // reloading the inventory when a parent re-renders.
  const loadRef = useRef(load);
  loadRef.current = load;

  useModalDialog(dialogRef, {
    escapeAnywhere: true,
    initialFocus: () => searchRef.current,
    onEscape: (event) => {
      event.preventDefault();
      onClose();
    },
  });

  useEffect(() => {
    let active = true;
    void loadRef.current().then(
      (loaded) => {
        if (active) setEntries(loaded);
      },
      () => {
        if (!active) return;
        setLoadFailed(true);
        setEntries([]);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (entries ?? []).filter(
      (entry) =>
        !needle ||
        entry.name.toLowerCase().includes(needle) ||
        entry.licenses.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  return (
    <div
      className="playlist-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="playlist-dialog licenses-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="licenses-dialog-title"
      >
        <header className="playlist-dialog-header">
          <div>
            <span className="eyebrow">Arlet</span>
            <h2 id="licenses-dialog-title">Open-source licenses</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close licenses"
            onClick={onClose}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <p className="licenses-intro">
          Arlet is free software under the GNU General Public License v3.0 only.
          It includes the open-source packages below.
        </p>
        <label className="playlist-dialog-search">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">Search packages</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search packages or licenses"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="licenses-list">
          {entries === null ? (
            <p className="playlist-dialog-feedback" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={16} />
              Loading licenses…
            </p>
          ) : loadFailed ? (
            <p className="playlist-dialog-feedback" role="alert">
              Licenses could not be loaded.
            </p>
          ) : visible.length === 0 ? (
            <p className="playlist-dialog-feedback">No packages found.</p>
          ) : (
            visible.map((entry) => (
              <details className="licenses-entry" key={entry.name}>
                <summary>
                  <strong>{entry.name.replace(/^cargo:/u, "")}</strong>
                  <small>{entry.licenses}</small>
                </summary>
                <pre>{entry.licenseText ?? entry.licenses}</pre>
              </details>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
