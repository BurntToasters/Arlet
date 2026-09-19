import type {
  Album,
  Artist,
  DiscoveryResource,
  PinnedPlaylist,
  PlaybackState,
  Playlist,
  RecommendationSection,
  Station,
  Track,
  MusicSource,
} from "./domain/music.ts";
import type { AppErrorCode } from "./domain/errors.ts";
import type { Route } from "./routing/router.ts";
import { redactSensitive } from "./platform/redact.ts";

export type ThemePreference = "system" | "light" | "dark";
export type WindowEffectPreference = "acrylic" | "mica" | "solid";
export type UpdateChannel = "auto" | "stable" | "beta";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error"
  | "installing";

export interface AppSettings {
  schemaVersion: 1;
  theme: ThemePreference;
  windowEffect: WindowEffectPreference;
  autoCheckUpdates: boolean;
  updateChannel: UpdateChannel;
  volume: number;
  /** Reserved for forward-compatible settings owned by other versions. */
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  theme: "system",
  windowEffect: "acrylic",
  autoCheckUpdates: true,
  updateChannel: "auto",
  volume: 1,
};

export type AuthState =
  | {
      status: "unauthorized";
      /** True while the MusicKit authorization popup is in flight. */
      pending?: boolean;
      [key: string]: unknown;
    }
  | {
      status: "authorized";
      /** True while the MusicKit authorization popup is in flight. */
      pending?: boolean;
      /** Source-compatibility index for older Phase 0 report fixtures. */
      [key: string]: unknown;
    };

export type InitializationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

export interface SearchState {
  query: string;
  status: "idle" | "loading" | "success" | "error";
  results: Track[];
  activeSource: "catalog" | "library";
  catalog: SearchResourceGroups;
  library: SearchResourceGroups;
  error?: string;
  requestId: number;
}

export interface SearchResourceGroups {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  status: "idle" | "loading" | "success" | "error";
  error?: string;
}

export type DiscoveryLoadStatus =
  "idle" | "loading" | "refreshing" | "success" | "error";

export interface BrowseState {
  status: DiscoveryLoadStatus;
  songs: Track[];
  albums: Album[];
  playlists: Playlist[];
  error?: string;
  lastUpdatedAt?: number;
}

export interface RadioSectionState {
  status: DiscoveryLoadStatus;
  items: Station[];
  error?: string;
}

export interface RadioState {
  status: DiscoveryLoadStatus;
  personal: RadioSectionState;
  live: RadioSectionState;
  recent: RadioSectionState;
  error?: string;
  lastUpdatedAt?: number;
}

export type LibrarySection =
  "recent" | "history" | "artists" | "albums" | "songs" | "playlists";

export type LibraryLoadStatus =
  "idle" | "loading" | "refreshing" | "success" | "error";

export type LibraryDataSource = "none" | "cache" | "network";

/**
 * Normalized resources are intentionally structural here. The API/domain
 * layer owns the richer resource types, while the store can remain stable as
 * Apple adds resource kinds.
 */
export interface LibraryEntity {
  id: string;
  type?: string;
  name?: string;
  title?: string;
  [key: string]: unknown;
}

export interface LibraryCollectionState<
  T extends { id: string } = LibraryEntity,
> {
  items: T[];
  status: LibraryLoadStatus;
  source: LibraryDataSource;
  next?: string;
  error?: string;
  lastUpdatedAt?: number;
  /** True when network refresh failed but cached items remain renderable. */
  stale: boolean;
}

export interface LibraryDetailState<T extends { id: string } = LibraryEntity> {
  status: LibraryLoadStatus;
  source: LibraryDataSource;
  item?: T;
  items: T[];
  next?: string;
  error?: string;
  lastUpdatedAt?: number;
  stale: boolean;
  /** Compatibility aliases consumed by detail views. */
  resource?: T;
  tracks?: T[];
  albums?: T[];
}

export type HomeLoadStatus =
  "idle" | "loading" | "refreshing" | "success" | "error";

export interface HomeErrors {
  recentPlaylists?: string;
  heavyRotation?: string;
  recommendations?: string;
}

export interface HomeState {
  status: HomeLoadStatus;
  recentPlaylists: Playlist[];
  heavyRotation: DiscoveryResource[];
  recommendations: RecommendationSection[];
  errors: HomeErrors;
  lastUpdatedAt?: number;
  /** True when a prior session snapshot remains after refresh failure. */
  stale: boolean;
}

export interface AccountSummary {
  /** Generic provider label; Apple identity is not exposed by MusicKit. */
  provider: "Apple Music";
  label: "Apple Music account";
  storefront?: string;
  connectedAt?: number;
  lastRefreshAt?: number;
}

export interface LibraryDetailsState {
  album: LibraryDetailState & Record<string, unknown>;
  artist: LibraryDetailState & Record<string, unknown>;
  playlist: LibraryDetailState & Record<string, unknown>;
  playlistFolder: LibraryDetailState & Record<string, unknown>;
}

export interface LibraryState {
  account: AccountSummary;
  hydrated: boolean;
  collections: Record<LibrarySection, LibraryCollectionState>;
  details: LibraryDetailsState;
}

export interface DiagnosticsState {
  logs: string[];
  failures: string[];
  sessionStartedAt: number;
}

export interface UiState {
  queueOpen: boolean;
  diagnosticsOpen: boolean;
  sidebarOpen: boolean;
}

export interface WindowEffectState {
  requested: WindowEffectPreference;
  applied: WindowEffectPreference | "solid";
  fallbackReason?: string;
}

export interface UpdateState {
  status: UpdateStatus;
  channel: UpdateChannel;
  /** The concrete feed selected by the channel preference and installed version. */
  resolvedChannel: "stable" | "beta";
  target?: string;
  version?: string;
  progress?: number;
  downloadedBytes?: number;
  contentLength?: number;
  message?: string;
  error?: string;
  /** True while the ready-to-install prompt is visible. */
  promptOpen: boolean;
  lastCheckedAt?: number;
}

export interface AppState {
  auth: AuthState;
  playback: PlaybackState;
  tracksPlayed: number;
  account?: AccountSummary;
  library?: LibraryState;
  home?: HomeState;
  browse?: BrowseState;
  radio?: RadioState;
  /** Milestone 0-compatible snapshots may omit the shell fields. */
  initialization?: InitializationState;
  navigation?: Route;
  search?: SearchState;
  settings?: AppSettings;
  windowEffect?: WindowEffectState;
  updates?: UpdateState;
  pins?: PinnedPlaylist[];
  ui?: UiState;
  diagnostics?: DiagnosticsState;
}

export interface RuntimeAppState extends AppState {
  initialization: InitializationState;
  navigation: Route;
  search: SearchState;
  settings: AppSettings;
  windowEffect: WindowEffectState;
  updates: UpdateState;
  pins: PinnedPlaylist[];
  ui: UiState;
  diagnostics: DiagnosticsState;
  library: LibraryState;
  home: HomeState;
  browse: BrowseState;
  radio: RadioState;
  account: AccountSummary;
}

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
  modeCapabilities: { shuffle: false, repeat: false },
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
    status: "idle",
  };
}

export function createInitialBrowseState(): BrowseState {
  return { status: "idle", songs: [], albums: [], playlists: [] };
}

export function createInitialRadioState(): RadioState {
  const section = (): RadioSectionState => ({ status: "idle", items: [] });
  return {
    status: "idle",
    personal: section(),
    live: section(),
    recent: section(),
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
  };
}

let state: RuntimeAppState = cloneInitialState();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
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
  update({
    ...state,
    auth: { status: state.auth.status, pending },
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

export function setLibraryDetailState(
  kind: LibraryDetailKind,
  patch: Partial<LibraryDetailState>,
  id?: string,
  source?: MusicSource,
): void {
  const current = state.library.details[kind];
  const next = {
    ...current,
    ...patch,
    ...(patch.error === undefined
      ? {}
      : { error: sanitizeRenderableError(patch.error) }),
  };
  const key = id ? libraryDetailKey(id, source) : id;
  const details = key
    ? {
        ...state.library.details,
        [kind]: {
          ...current,
          [key]: next,
        },
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
  update({
    ...state,
    diagnostics: { ...state.diagnostics, logs, failures },
  });
}

export function clearDiagnosticLogs(): void {
  update({
    ...state,
    diagnostics: { ...state.diagnostics, logs: [], failures: [] },
  });
}

export function setPlaybackStatus(status: PlaybackState["status"]): void {
  update({
    ...state,
    playback: { ...state.playback, status },
  });
}

export function setCurrentTrack(
  track: Track | undefined,
  explicitQueueIndex?: number,
): void {
  const isNewTrack =
    track !== undefined && track.id !== state.playback.current?.id;
  const queueIndex =
    track &&
    explicitQueueIndex !== undefined &&
    explicitQueueIndex >= 0 &&
    explicitQueueIndex < state.playback.queue.length
      ? explicitQueueIndex
      : track
        ? state.playback.queue.findIndex((item) => item.id === track.id)
        : -1;
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

export function setPlaybackPosition(
  positionSeconds: number,
  durationSeconds: number,
): void {
  update({
    ...state,
    playback: {
      ...state.playback,
      positionSeconds: Math.max(0, positionSeconds),
      durationSeconds: Math.max(0, durationSeconds),
    },
  });
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

/** Replace queue while preserving explicit position for duplicate track IDs. */
export function setQueueSnapshot(queue: Track[], queueIndex = 0): void {
  setQueue(queue, queueIndex);
  const current = queue[queueIndex];
  if (current) setCurrentTrack(current, Math.max(0, queueIndex));
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

export function resetState(): void {
  const settings = state.settings;
  const windowEffect = state.windowEffect;
  const updates = state.updates;
  // Sign-out resets account/playback data without moving the router behind
  // its back. The hash router owns navigation, so preserving these shell
  // fields keeps the rendered route and URL synchronized.
  const navigation = state.navigation;
  const ui = state.ui;
  state = {
    ...cloneInitialState(),
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
