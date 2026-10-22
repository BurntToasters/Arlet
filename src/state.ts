export type * from "./state-types.ts";

import type {
  PinnedPlaylist,
  PendingPlaybackRestore,
  PlaybackState,
  RatingValue,
  SleepTimerState,
  Track,
  MusicSource,
} from "./domain/music.ts";
import type { AppErrorCode } from "./domain/errors.ts";
import type { Route } from "./routing/router.ts";
import type {
  AppSettings,
  AuthState,
  InitializationState,
  SearchState,
  SearchSuggestionState,
  SearchResourceGroups,
  BrowseState,
  RadioSectionState,
  RadioState,
  LibrarySection,
  LibraryLoadStatus,
  LibraryDataSource,
  LibraryCollectionState,
  LibraryDetailState,
  HomeState,
  AccountSummary,
  LibraryDetailsState,
  LibraryState,
  UiState,
  WindowEffectState,
  UpdateState,
  RuntimeAppState,
} from "./state-types.ts";
import { redactSensitive } from "./platform/redact.ts";
import { isSameTrack } from "./domain/music.ts";

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  theme: "system",
  windowEffect: "acrylic",
  autoCheckUpdates: true,
  updateChannel: "auto",
  volume: 1,
  autoplay: true,
  restoreSession: true,
  trayIcon: true,
  launchAtStartup: false,
  debugMode: false,
};

const initialPlaybackState: PlaybackState = {
  status: "idle",
  current: undefined,
  positionSeconds: 0,
  durationSeconds: 0,
  volume: DEFAULT_SETTINGS.volume,
  queue: [],
  queueIndex: 0,
  shuffleMode: "off",
  repeatMode: "off",
  modeCapabilities: { shuffle: false, repeat: false, autoplay: false },
  muted: false,
  pendingRestore: undefined,
  sleepTimer: undefined,
  error: undefined,
};

const librarySections: LibrarySection[] = [
  "recent",
  "history",
  "artists",
  "albums",
  "songs",
  "playlists",
];

function emptyLibraryCollection(): LibraryCollectionState {
  return {
    items: [],
    status: "idle",
    source: "none",
    next: undefined,
    error: undefined,
    lastUpdatedAt: undefined,
    stale: false,
  };
}

function emptyLibraryDetail(): LibraryDetailState & Record<string, unknown> {
  return {
    status: "idle",
    source: "none",
    item: undefined,
    items: [],
    next: undefined,
    error: undefined,
    lastUpdatedAt: undefined,
    stale: false,
  };
}

export function createInitialHomeState(): HomeState {
  return {
    status: "idle",
    recentPlaylists: [],
    heavyRotation: [],
    recommendations: [],
    errors: {},
    stale: false,
  };
}

function emptySearchGroups(): SearchResourceGroups {
  return {
    songs: [],
    albums: [],
    artists: [],
    playlists: [],
    stations: [],
    curators: [],
    paging: {},
    status: "idle",
  };
}

const RECENT_SEARCHES_KEY = "arlet.search.recent";
const RECENT_SEARCH_LIMIT = 10;
const RECENT_SEARCH_MAX_LENGTH = 200;

/** Trims a term and caps its length; an empty result means nothing to keep. */
function normalizeRecentSearch(term: string): string {
  return term.trim().slice(0, RECENT_SEARCH_MAX_LENGTH).trimEnd();
}

function searchStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Blocked site data makes the accessor throw; recents then stay in memory.
    return undefined;
  }
}

/** Reads the saved terms; anything malformed is treated as no history. */
function readRecentSearches(): string[] {
  try {
    const raw = searchStorage()?.getItem(RECENT_SEARCHES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map(normalizeRecentSearch)
      .filter((value) => value.length > 0)
      .slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
}

function writeRecentSearches(terms: string[]): void {
  try {
    const storage = searchStorage();
    if (!storage) return;
    if (terms.length) {
      storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(terms));
    } else {
      storage.removeItem(RECENT_SEARCHES_KEY);
    }
  } catch {
    // A failed write only loses history across restarts.
  }
}

function emptySearchSuggestions(): SearchSuggestionState {
  return { term: "", status: "idle", items: [] };
}

export function createInitialBrowseState(): BrowseState {
  return {
    status: "idle",
    genreId: "",
    genres: [],
    songs: [],
    albums: [],
    playlists: [],
    cityCharts: [],
    dailyCharts: [],
    paging: {},
  };
}

export function createInitialRadioState(): RadioState {
  const section = (): RadioSectionState => ({ status: "idle", items: [] });
  return {
    status: "idle",
    personal: section(),
    live: section(),
    recent: section(),
    genres: [],
    genreId: "",
    genreStations: section(),
  };
}

export function createInitialLibraryState(): LibraryState {
  const collections = {} as Record<LibrarySection, LibraryCollectionState>;
  for (const section of librarySections) {
    collections[section] = emptyLibraryCollection();
  }
  return {
    account: {
      provider: "Apple Music",
      label: "Apple Music account",
    },
    hydrated: false,
    offline: false,
    collections,
    details: {
      album: emptyLibraryDetail(),
      artist: emptyLibraryDetail(),
      playlist: emptyLibraryDetail(),
      playlistFolder: emptyLibraryDetail(),
    },
  };
}

const initialState: RuntimeAppState = {
  auth: { status: "unauthorized", pending: false },
  initialization: { status: "idle" },
  navigation: { kind: "home" },
  playback: { ...initialPlaybackState },
  search: {
    query: "",
    status: "idle",
    results: [],
    activeSource: "catalog",
    catalog: emptySearchGroups(),
    library: emptySearchGroups(),
    error: undefined,
    requestId: 0,
    recent: readRecentSearches(),
    suggestions: emptySearchSuggestions(),
  },
  settings: { ...DEFAULT_SETTINGS },
  windowEffect: {
    requested: DEFAULT_SETTINGS.windowEffect,
    applied: "solid",
  },
  updates: {
    status: "idle",
    channel: DEFAULT_SETTINGS.updateChannel,
    resolvedChannel: "stable",
    promptOpen: false,
  },
  pins: [],
  ui: {
    queueOpen: false,
    diagnosticsOpen: false,
    sidebarOpen: false,
    nowPlayingOpen: false,
    miniPlayer: false,
  },
  diagnostics: {
    logs: [],
    failures: [],
    sessionStartedAt: Date.now(),
  },
  tracksPlayed: 0,
  account: createInitialLibraryState().account,
  library: createInitialLibraryState(),
  home: createInitialHomeState(),
  browse: createInitialBrowseState(),
  radio: createInitialRadioState(),
  ratings: {},
};

function cloneInitialState(): RuntimeAppState {
  return {
    ...initialState,
    playback: { ...initialPlaybackState },
    search: {
      ...initialState.search,
      results: [],
      catalog: emptySearchGroups(),
      library: emptySearchGroups(),
      recent: [],
      suggestions: emptySearchSuggestions(),
    },
    settings: { ...DEFAULT_SETTINGS },
    windowEffect: { ...initialState.windowEffect },
    updates: { ...initialState.updates },
    pins: [],
    ui: { ...initialState.ui },
    diagnostics: {
      ...initialState.diagnostics,
      logs: [],
      failures: [],
      sessionStartedAt: Date.now(),
    },
    library: createInitialLibraryState(),
    account: { ...initialState.account },
    home: createInitialHomeState(),
    browse: createInitialBrowseState(),
    radio: createInitialRadioState(),
    ratings: {},
  };
}

let state: RuntimeAppState = cloneInitialState();
const subscribers = new Set<() => void>();
// Playback ticks arrive several times a second. They notify only this
// channel so library views do not re-render while music plays.
const positionSubscribers = new Set<() => void>();

/**
 * Runs every listener even when one throws. A throw would otherwise skip the
 * rest (the UI, session saving, the sleep timer) and surface in whichever
 * MusicKit event changed the state. The error is rethrown asynchronously, so
 * it still reaches the uncaught-error log.
 */
function runListeners(listeners: Iterable<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function notify(): void {
  runListeners(subscribers);
}

function update(next: RuntimeAppState): void {
  state = next;
  notify();
}

function sanitizeRenderableError(message: string): string {
  return redactSensitive(message)
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function getState(): Readonly<RuntimeAppState> {
  return state;
}

export function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function subscribePlaybackPosition(listener: () => void): () => void {
  positionSubscribers.add(listener);
  return () => positionSubscribers.delete(listener);
}

export function setAuthState(auth: AuthState): void {
  // Never copy the Music User Token into the renderable application store.
  update({
    ...state,
    auth:
      auth.status === "authorized"
        ? { status: "authorized", pending: false }
        : { status: "unauthorized", pending: false },
  });
}

export function setAuthPending(pending: boolean): void {
  // A cancelled sign-in window leaves an expired session expired.
  const expired =
    state.auth.status === "authorized" && state.auth.sessionExpired === true;
  update({
    ...state,
    auth: {
      status: state.auth.status,
      pending,
      ...(expired ? { sessionExpired: true } : {}),
    },
  });
}

export function setSessionExpired(expired: boolean): void {
  if (state.auth.status !== "authorized") return;
  update({
    ...state,
    auth: {
      status: "authorized",
      pending: state.auth.pending,
      ...(expired ? { sessionExpired: true } : {}),
    },
  });
}

export function setAccountSummary(patch: Partial<AccountSummary>): void {
  const account = {
    ...state.account,
    ...state.library.account,
    ...patch,
    provider: "Apple Music" as const,
    label: "Apple Music account" as const,
  };
  update({
    ...state,
    account,
    library: {
      ...state.library,
      account: {
        ...account,
      },
    },
  });
}

export function setDeveloperTokenExpiry(expiresAt: number | undefined): void {
  update({ ...state, developerTokenExpiresAt: expiresAt });
}

export function setLibraryOffline(offline: boolean): void {
  update({
    ...state,
    library: { ...state.library, offline },
  });
}

export function setLibraryHydrated(hydrated: boolean): void {
  update({
    ...state,
    library: { ...state.library, hydrated },
  });
}

export function setLibraryCollectionState(
  section: LibrarySection,
  patch: Partial<LibraryCollectionState>,
): void {
  const current = state.library.collections[section];
  const next = {
    ...current,
    ...patch,
    ...(patch.error === undefined
      ? {}
      : { error: sanitizeRenderableError(patch.error) }),
  };
  update({
    ...state,
    library: {
      ...state.library,
      collections: { ...state.library.collections, [section]: next },
    },
  });
}

export function setLibraryCollectionItems<T extends { id: string }>(
  section: LibrarySection,
  items: readonly T[],
  options: {
    source?: LibraryDataSource;
    status?: LibraryLoadStatus;
    next?: string;
    error?: string;
    lastUpdatedAt?: number;
    stale?: boolean;
  } = {},
): void {
  setLibraryCollectionState(section, {
    items: [...items],
    source: options.source ?? "network",
    status: options.status ?? "success",
    next: options.next,
    error: options.error,
    lastUpdatedAt: options.lastUpdatedAt,
    stale: options.stale ?? false,
  });
}

export function appendLibraryCollectionItems<T extends { id: string }>(
  section: LibrarySection,
  items: readonly T[],
  options: {
    next?: string;
    source?: LibraryDataSource;
    lastUpdatedAt?: number;
  } = {},
): void {
  const current = state.library.collections[section];
  const seen = new Set(current.items.map((item) => item.id));
  const appended = items.filter((item) => !seen.has(item.id));
  setLibraryCollectionItems(section, [...current.items, ...appended], {
    source: options.source ?? current.source,
    status: "success",
    next: options.next,
    lastUpdatedAt: options.lastUpdatedAt ?? current.lastUpdatedAt,
    stale: false,
  });
}

export type LibraryDetailKind = keyof LibraryDetailsState;

export function libraryDetailKey(
  id: string,
  source: MusicSource = "library",
): string {
  return source === "catalog" ? `catalog:${id}` : id;
}

/** Detail entries kept per kind; each can hold thousands of songs. */
const MAX_DETAIL_ENTRIES = 24;

/**
 * Writes `key` as the newest entry and drops the oldest ones past the cap,
 * so visiting many albums or playlists does not grow memory all session.
 */
function withRecentDetail<T>(
  entries: T,
  key: string,
  next: LibraryDetailState,
): T {
  const recent = { ...(entries as Record<string, unknown>) };
  delete recent[key];
  recent[key] = next;
  // The kind object also carries its own unkeyed detail fields.
  const baseFields = new Set(Object.keys(emptyLibraryDetail()));
  const keys = Object.keys(recent).filter((name) => !baseFields.has(name));
  for (const old of keys.slice(
    0,
    Math.max(0, keys.length - MAX_DETAIL_ENTRIES),
  )) {
    delete recent[old];
  }
  return recent as T;
}

export function setLibraryDetailState(
  kind: LibraryDetailKind,
  patch: Partial<LibraryDetailState>,
  id?: string,
  source?: MusicSource,
): void {
  // Keyed kinds hold one entry per ID; merge into that entry, not the map.
  const key = id ? libraryDetailKey(id, source) : undefined;
  const kindState = state.library.details[kind];
  const current = key
    ? ((kindState as unknown as Record<string, LibraryDetailState | undefined>)[
        key
      ] ?? emptyLibraryDetail())
    : kindState;
  const next = {
    ...current,
    ...patch,
    ...(patch.error === undefined
      ? {}
      : { error: sanitizeRenderableError(patch.error) }),
  };
  const details = key
    ? {
        ...state.library.details,
        [kind]: withRecentDetail(kindState, key, next),
      }
    : { ...state.library.details, [kind]: next };
  update({
    ...state,
    library: {
      ...state.library,
      details,
    },
  });
}

export function setHomeState(patch: Partial<HomeState>): void {
  const errors =
    patch.errors === undefined
      ? state.home.errors
      : Object.fromEntries(
          Object.entries(patch.errors).map(([key, value]) => [
            key,
            value === undefined ? undefined : sanitizeRenderableError(value),
          ]),
        );
  const next = {
    ...state.home,
    ...patch,
    errors,
  };
  update({ ...state, home: next });
}

export function clearHomeState(): void {
  update({ ...state, home: createInitialHomeState() });
}

export function clearLibraryState(): void {
  const library = createInitialLibraryState();
  update({
    ...state,
    account: library.account,
    library,
  });
}

export function setInitializationState(
  initialization: InitializationState,
): void {
  update({
    ...state,
    initialization:
      initialization.status === "error"
        ? {
            ...initialization,
            message: sanitizeRenderableError(initialization.message),
          }
        : initialization,
  });
}

export function setNavigation(route: Route): void {
  update({ ...state, navigation: route });
}

export function setSearchState(patch: Partial<SearchState>): void {
  const nextSearch = {
    ...state.search,
    ...patch,
    requestId: patch.requestId ?? state.search.requestId,
  };
  update({
    ...state,
    search:
      nextSearch.error === undefined
        ? nextSearch
        : { ...nextSearch, error: sanitizeRenderableError(nextSearch.error) },
  });
}

export function setBrowseState(patch: Partial<BrowseState>): void {
  update({ ...state, browse: { ...state.browse, ...patch } });
}

export function setRadioState(patch: Partial<RadioState>): void {
  update({ ...state, radio: { ...state.radio, ...patch } });
}

/** Recent searches are per account, so they are dropped with the results. */
export function addRecentSearch(term: string): void {
  const trimmed = normalizeRecentSearch(term);
  if (!trimmed) return;
  const key = trimmed.toLocaleLowerCase();
  const recent = [
    trimmed,
    ...state.search.recent.filter((entry) => entry.toLocaleLowerCase() !== key),
  ].slice(0, RECENT_SEARCH_LIMIT);
  writeRecentSearches(recent);
  setSearchState({ recent });
}

export function removeRecentSearch(term: string): void {
  const recent = state.search.recent.filter((entry) => entry !== term);
  writeRecentSearches(recent);
  setSearchState({ recent });
}

export function clearRecentSearches(): void {
  writeRecentSearches([]);
  setSearchState({ recent: [] });
}

/**
 * Drops Browse, Radio, and search results for an account change. Requests in
 * flight were invalidated, so their loading states would never settle; the
 * views reload from idle. The search query and source stay as typed. Suggestions
 * go too. Recent searches are not touched: sign-in runs this reset, and recents
 * are cleared only on sign-out (clearRecentSearches).
 */
export function resetDiscoveryState(): void {
  update({
    ...state,
    browse: createInitialBrowseState(),
    radio: createInitialRadioState(),
    search: {
      ...state.search,
      status: "idle",
      results: [],
      catalog: emptySearchGroups(),
      library: emptySearchGroups(),
      error: undefined,
      suggestions: emptySearchSuggestions(),
    },
  });
}

export function setPlaybackModes(
  patch: Partial<
    Pick<PlaybackState, "shuffleMode" | "repeatMode" | "modeCapabilities">
  >,
): void {
  update({ ...state, playback: { ...state.playback, ...patch } });
}

export function setSettings(settings: AppSettings): void {
  update({
    ...state,
    settings: { ...settings },
    windowEffect: {
      ...state.windowEffect,
      requested: settings.windowEffect,
    },
  });
}

export function setWindowEffectState(windowEffect: WindowEffectState): void {
  update({ ...state, windowEffect: { ...windowEffect } });
}

export function setUpdateState(patch: Partial<UpdateState>): void {
  const next = { ...state.updates, ...patch };
  update({
    ...state,
    updates: {
      ...next,
      ...(next.message === undefined
        ? {}
        : { message: sanitizeRenderableError(next.message) }),
      ...(next.error === undefined
        ? {}
        : { error: sanitizeRenderableError(next.error) }),
    },
  });
}

export function setPins(pins: readonly PinnedPlaylist[]): void {
  update({ ...state, pins: [...pins] });
}

export function setUiState(patch: Partial<UiState>): void {
  update({ ...state, ui: { ...state.ui, ...patch } });
}

export function appendDiagnosticLog(line: string, failure = false): void {
  const safeLine = redactSensitive(line);
  const logs = [...state.diagnostics.logs, safeLine].slice(-500);
  const failures = failure
    ? [...state.diagnostics.failures, safeLine].slice(-100)
    : state.diagnostics.failures;
  state = {
    ...state,
    diagnostics: { ...state.diagnostics, logs, failures },
  };
  // Only failures are rendered; notifying for every log line re-rendered
  // the whole shell.
  if (failure) notify();
}

export function clearDiagnosticLogs(): void {
  update({
    ...state,
    diagnostics: { ...state.diagnostics, logs: [], failures: [] },
  });
}

export function setPlaybackStatus(status: PlaybackState["status"]): void {
  // A playing provider state proves the last failure is no longer current.
  const error = status === "playing" ? undefined : state.playback.error;
  // Any real playback start replaces a restored queue that was never resumed.
  const pendingRestore =
    status === "playing" || status === "loading"
      ? undefined
      : state.playback.pendingRestore;
  update({
    ...state,
    playback: { ...state.playback, status, error, pendingRestore },
  });
}

export function setCurrentTrack(
  track: Track | undefined,
  explicitQueueIndex?: number,
  countAsPlayed = true,
): void {
  // MusicKit may report a library song by its catalog ID, so match either.
  const isNewTrack =
    countAsPlayed &&
    track !== undefined &&
    !isSameTrack(track, state.playback.current);
  const queue = state.playback.queue;
  const exactIndex = track
    ? queue.findIndex((item) => item.id === track.id)
    : -1;
  const queueIndex =
    track &&
    explicitQueueIndex !== undefined &&
    explicitQueueIndex >= 0 &&
    explicitQueueIndex < state.playback.queue.length
      ? explicitQueueIndex
      : exactIndex >= 0
        ? exactIndex
        : queue.findIndex((item) => isSameTrack(item, track));
  update({
    ...state,
    playback: {
      ...state.playback,
      current: track,
      queueIndex: queueIndex >= 0 ? queueIndex : state.playback.queueIndex,
    },
    tracksPlayed: isNewTrack ? state.tracksPlayed + 1 : state.tracksPlayed,
  });
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function setPlaybackPosition(
  positionSeconds: number,
  durationSeconds: number,
): void {
  state = {
    ...state,
    playback: {
      ...state.playback,
      // MusicKit reports NaN before media metadata loads.
      positionSeconds: finiteNonNegative(positionSeconds),
      durationSeconds: finiteNonNegative(durationSeconds),
    },
  };
  runListeners(positionSubscribers);
}

export function setVolume(volume: number): void {
  update({
    ...state,
    playback: {
      ...state.playback,
      volume: Math.max(0, Math.min(1, volume)),
    },
  });
}

export function setQueue(queue: Track[], queueIndex = 0): void {
  const safeIndex =
    queue.length === 0
      ? 0
      : Math.max(0, Math.min(queueIndex, queue.length - 1));
  update({
    ...state,
    playback: {
      ...state.playback,
      queue: [...queue],
      queueIndex: safeIndex,
    },
  });
}

/**
 * Replace queue while preserving explicit position for duplicate track IDs.
 * A restored queue passes `countAsPlayed: false`; nothing has played yet.
 */
export function setQueueSnapshot(
  queue: Track[],
  queueIndex = 0,
  countAsPlayed = true,
): void {
  setQueue(queue, queueIndex);
  // setQueue clamps the index; read the song at the clamped position.
  const index = state.playback.queueIndex;
  const current = queue[index];
  if (current) setCurrentTrack(current, index, countAsPlayed);
}

export function setPlaybackError(code: AppErrorCode, message: string): void {
  update({
    ...state,
    playback: {
      ...state.playback,
      status: "error",
      error: { code, message: sanitizeRenderableError(message) },
    },
  });
}

export function clearPlaybackError(): void {
  if (state.playback.error === undefined) return;
  update({
    ...state,
    playback: { ...state.playback, error: undefined },
  });
}

export function setMuted(muted: boolean): void {
  update({ ...state, playback: { ...state.playback, muted } });
}

export function setPendingRestore(
  pendingRestore: PendingPlaybackRestore | undefined,
): void {
  update({ ...state, playback: { ...state.playback, pendingRestore } });
}

export function setSleepTimer(sleepTimer: SleepTimerState | undefined): void {
  update({ ...state, playback: { ...state.playback, sleepTimer } });
}

export function setQueueRest(queueRest: number): void {
  if ((state.playback.queueRest ?? 0) === queueRest) return;
  update({ ...state, playback: { ...state.playback, queueRest } });
}

/** Stable key for the ratings map, e.g. `library-songs:i.abc`. */
export function ratingKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function setRating(key: string, value: RatingValue): void {
  update({ ...state, ratings: { ...state.ratings, [key]: value } });
}

/** Writes many ratings in one update, and skips the update when none change. */
export function setRatings(
  entries: ReadonlyArray<[string, RatingValue]>,
): void {
  let ratings: Record<string, RatingValue> | undefined;
  for (const [key, value] of entries) {
    if ((ratings ?? state.ratings)[key] === value) continue;
    ratings ??= { ...state.ratings };
    ratings[key] = value;
  }
  if (ratings) update({ ...state, ratings });
}

export function clearRatings(): void {
  if (Object.keys(state.ratings).length === 0) return;
  update({ ...state, ratings: {} });
}

export function resetState(): void {
  const settings = state.settings;
  const windowEffect = state.windowEffect;
  const updates = state.updates;
  // Sign-out resets account/playback data without moving the router behind
  // its back. The hash router owns navigation, so preserving these shell
  // fields keeps the rendered route and URL synchronized.
  const navigation = state.navigation;
  const ui = state.ui;
  // These describe the MusicKit instance and the app build, not the
  // account. The instance outlives sign-out, so resetting them would leave
  // the volume slider, mode buttons, and token notice out of sync.
  const { volume, muted, modeCapabilities, shuffleMode, repeatMode } =
    state.playback;
  const developerTokenExpiresAt = state.developerTokenExpiresAt;
  const initial = cloneInitialState();
  state = {
    ...initial,
    playback: {
      ...initial.playback,
      volume,
      muted,
      modeCapabilities,
      shuffleMode,
      repeatMode,
    },
    developerTokenExpiresAt,
    settings,
    windowEffect,
    updates,
    navigation,
    ui,
  };
  notify();
}

export function resetApplicationState(): void {
  update(cloneInitialState());
}
