import { LoaderCircle, Plus, Search, X } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import type { Track } from "../domain/music.ts";
import {
  PLAYLIST_DIALOG_REQUEST,
  type PlaylistDialogMode,
  type PlaylistDialogRequestDetail,
} from "./playlist-events.ts";

interface PlaylistOption {
  id: string;
  name: string;
  description?: string;
  canEdit?: boolean;
  raw: Record<string, unknown>;
}

interface DialogState {
  mode: PlaylistDialogMode;
  tracks: readonly Track[];
  fromPicker: boolean;
  restoreFocus?: HTMLElement;
}

interface PlaylistController {
  loadLibrarySection?: (
    section: "playlists",
    options?: { refresh?: boolean },
  ) => Promise<unknown>;
  searchPlaylists?: (query: string) => Promise<unknown[]>;
  createPlaylist?: (...args: unknown[]) => Promise<unknown>;
  addTracksToPlaylist?: (
    playlistId: string,
    tracks: readonly Track[],
  ) => Promise<unknown>;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function textValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function toPlaylistOption(value: unknown): PlaylistOption | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const attributes = recordValue(raw.attributes) ?? raw;
  const id = textValue(raw.id, attributes.id);
  const name = textValue(
    raw.name,
    raw.title,
    attributes.name,
    attributes.title,
  );
  if (!id || !name) return undefined;
  return {
    id,
    name,
    description: textValue(raw.description, attributes.description),
    canEdit:
      typeof raw.canEdit === "boolean"
        ? raw.canEdit
        : typeof attributes.canEdit === "boolean"
          ? attributes.canEdit
          : undefined,
    raw,
  };
}

function localPlaylists(
  state: ReturnType<typeof useAppState>,
): PlaylistOption[] {
  return state.library.collections.playlists.items
    .map(toPlaylistOption)
    .filter((item): item is PlaylistOption => Boolean(item))
    .filter((item) => item.canEdit !== false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createPlaylistWithTracks(
  controller: PlaylistController,
  name: string,
  description: string,
  tracks: readonly Track[],
): Promise<void> {
  const create = controller.createPlaylist;
  if (!create) throw new Error("Playlist creation is not available.");
  const input = {
    name,
    description: description || undefined,
    tracks: tracks.length ? tracks : undefined,
  };
  await create(input);
}

export function PlaylistDialogs(): JSX.Element | null {
  const controller = useAppController() as PlaylistController;
  const state = useAppState();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaylistOption[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onRequest = (event: Event): void => {
      const detail = (event as CustomEvent<PlaylistDialogRequestDetail>).detail;
      if (!detail || (detail.mode !== "picker" && detail.mode !== "create"))
        return;
      setDialog({
        mode: detail.mode,
        tracks: detail.tracks ?? [],
        fromPicker: false,
        restoreFocus: detail.restoreFocus,
      });
      setQuery("");
      setResults([]);
      setName("");
      setDescription("");
      setError(undefined);
      setBusy(false);
      setLoadingPlaylists(detail.mode === "picker");
      if (detail.mode === "picker" && controller.loadLibrarySection) {
        void Promise.resolve()
          .then(() => controller.loadLibrarySection?.("playlists"))
          .catch((reason: unknown) => setError(errorMessage(reason)))
          .finally(() => setLoadingPlaylists(false));
      } else {
        setLoadingPlaylists(false);
      }
      window.setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener(PLAYLIST_DIALOG_REQUEST, onRequest);
    return () => window.removeEventListener(PLAYLIST_DIALOG_REQUEST, onRequest);
  }, []);

  const availablePlaylists = useMemo(
    () => localPlaylists(state),
    [state.library.collections.playlists.items],
  );

  useEffect(() => {
    if (dialog?.mode !== "picker") return undefined;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(availablePlaylists);
      setSearching(false);
      return undefined;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (controller.searchPlaylists?.(trimmed) ?? Promise.resolve([]))
        .then((values) => {
          if (!active) return;
          setResults(
            values
              .map(toPlaylistOption)
              .filter((item): item is PlaylistOption => Boolean(item))
              .filter((item) => item.canEdit !== false),
          );
          setSearching(false);
        })
        .catch((reason: unknown) => {
          if (!active) return;
          setSearching(false);
          setError(errorMessage(reason));
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [availablePlaylists, controller, dialog, query]);

  useEffect(() => {
    if (!dialog) return undefined;
    const focusableSelector =
      "a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ??
          [],
      );
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(
        document.activeElement as HTMLElement,
      );
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialog]);

  const closeDialog = (): void => {
    const focusTarget = dialog?.restoreFocus;
    setDialog(null);
    if (focusTarget) window.setTimeout(() => focusTarget.focus(), 0);
  };

  const addToPlaylist = (playlist: PlaylistOption): void => {
    if (!dialog?.tracks.length || !controller.addTracksToPlaylist) {
      closeDialog();
      return;
    }
    setBusy(true);
    setError(undefined);
    void controller
      .addTracksToPlaylist(playlist.id, dialog.tracks)
      .then(() => closeDialog())
      .catch((reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      });
  };

  const submitCreate = (event: JSX.TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Playlist name is required.");
      return;
    }
    if (!controller.createPlaylist) {
      setError("Playlist creation is not available.");
      return;
    }
    setBusy(true);
    setError(undefined);
    void createPlaylistWithTracks(
      controller,
      trimmed,
      description.trim(),
      dialog?.tracks ?? [],
    )
      .then(() => closeDialog())
      .catch((reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      });
  };

  if (!dialog) return null;
  const picker = dialog.mode === "picker";
  return (
    <div
      className="playlist-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <section
        ref={dialogRef}
        className="playlist-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-dialog-title"
      >
        <header className="playlist-dialog-header">
          <div>
            <span className="eyebrow">Apple Music</span>
            <h2 id="playlist-dialog-title">
              {picker ? "Add to playlist" : "New playlist"}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close playlist dialog"
            onClick={closeDialog}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {picker ? (
          <>
            <label className="playlist-dialog-search">
              <Search aria-hidden="true" size={16} />
              <span className="sr-only">Search playlists</span>
              <input
                ref={inputRef}
                type="search"
                value={query}
                placeholder="Search your playlists"
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </label>
            <div
              className="playlist-dialog-list"
              role="listbox"
              aria-label="Editable playlists"
            >
              {searching || (loadingPlaylists && results.length === 0) ? (
                <p className="playlist-dialog-feedback" role="status">
                  <LoaderCircle className="spin" aria-hidden="true" size={16} />
                  {loadingPlaylists
                    ? "Loading playlists…"
                    : "Searching playlists…"}
                </p>
              ) : results.length ? (
                results.map((playlist) => (
                  <button
                    className="playlist-dialog-option"
                    type="button"
                    role="option"
                    key={playlist.id}
                    disabled={busy}
                    onClick={() => addToPlaylist(playlist)}
                  >
                    <span>
                      <strong>{playlist.name}</strong>
                      {playlist.description ? (
                        <small>{playlist.description}</small>
                      ) : null}
                    </span>
                    <Plus aria-hidden="true" size={16} />
                  </button>
                ))
              ) : (
                <p className="playlist-dialog-feedback">
                  No editable playlists found.
                </p>
              )}
            </div>
            <div className="playlist-dialog-footer">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDialog({ ...dialog, mode: "create", fromPicker: true });
                  setError(undefined);
                  window.setTimeout(() => inputRef.current?.focus(), 0);
                }}
              >
                <Plus aria-hidden="true" size={15} /> New playlist
              </button>
            </div>
          </>
        ) : (
          <form className="playlist-dialog-form" onSubmit={submitCreate}>
            <label>
              <span>Name</span>
              <input
                ref={inputRef}
                type="text"
                value={name}
                required
                maxLength={255}
                placeholder="Playlist name"
                onInput={(event) => {
                  setName(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </label>
            <label>
              <span>
                Description <small>(optional)</small>
              </span>
              <textarea
                value={description}
                rows={3}
                maxLength={1000}
                placeholder="What is this playlist for?"
                onInput={(event) => setDescription(event.currentTarget.value)}
              />
            </label>
            {dialog.tracks.length ? (
              <p className="playlist-dialog-seed">
                {dialog.tracks.length === 1
                  ? "The selected song will be added."
                  : `${dialog.tracks.length} selected songs will be added.`}
              </p>
            ) : null}
            <div className="playlist-dialog-footer">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!dialog.fromPicker) {
                    closeDialog();
                    return;
                  }
                  setDialog({ ...dialog, mode: "picker" });
                  setError(undefined);
                  setQuery("");
                }}
              >
                {dialog.fromPicker ? "Back to playlists" : "Cancel"}
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create playlist"}
              </button>
            </div>
          </form>
        )}
        {error ? (
          <p className="playlist-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
