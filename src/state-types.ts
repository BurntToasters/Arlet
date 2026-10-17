import type {
  Album,
  Artist,
  DiscoveryResource,
  PinnedPlaylist,
  PlaybackState,
  Playlist,
  RatingValue,
  RecommendationSection,
  Station,
  Track,
} from "./domain/music.ts";
import type {
  SearchCurator,
  SearchGroupKind,
  SearchItem,
  SearchSuggestion,
} from "./musickit/search.ts";
import type { BrowseGenre, BrowseShelfKind } from "./musickit/browse.ts";
import type { Route } from "./routing/router.ts";

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
  /** Ask MusicKit to keep playing similar music after the queue ends. */
  autoplay: boolean;
  /** Restore the last queue and position, paused, after restart. */
  restoreSession: boolean;
  /** Show the tray icon; closing the window then hides to it instead of quitting. */
  trayIcon: boolean;
  /** Write the app log to disk (`arlet.log`). Off by default. */
  debugMode: boolean;
  /** Reserved for forward-compatible settings owned by other versions. */
  [key: string]: unknown;
}

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
  /** Submitted terms, newest first, kept on this PC; never holds tokens. */
  recent: string[];
  suggestions: SearchSuggestionState;
}

export interface SearchSuggestionState {
  term: string;
  status: "idle" | "loading" | "success" | "error";
  items: SearchSuggestion[];
}

/** Paging for one "See all" group; `offset` is Apple's raw item offset. */
export interface SearchPagingState {
  status: "idle" | "loading" | "done" | "error";
  offset: number;
  error?: string;
}

export interface SearchResourceGroups {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  /** Catalog-only; the library source leaves these empty. */
  stations: Station[];
  curators: SearchCurator[];
  /** Catalog top result (`with=topResults`); absent for the library. */
  top?: SearchItem;
  paging: Partial<Record<SearchGroupKind, SearchPagingState>>;
  status: "idle" | "loading" | "success" | "error";
  error?: string;
}

export type DiscoveryLoadStatus =
  "idle" | "loading" | "refreshing" | "success" | "error";

/** Paging for one Browse shelf: Apple's cursor for the next page, if any. */
export interface BrowseShelfPaging {
  next?: string;
  status: "idle" | "loading" | "error";
  error?: string;
}

export interface BrowseState {
  status: DiscoveryLoadStatus;
  /** Genre the charts are filtered to; "" means every genre. */
  genreId: string;
  genres: BrowseGenre[];
  songs: Track[];
  albums: Album[];
  playlists: Playlist[];
  cityCharts: Playlist[];
  dailyCharts: Playlist[];
  paging: Partial<Record<BrowseShelfKind, BrowseShelfPaging>>;
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
  /** Station genres for the Genres shelf. */
  genres: BrowseGenre[];
  /** Selected station genre; "" when none is selected. */
  genreId: string;
  genreStations: RadioSectionState;
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
  /** MusicKit could not start; views show the cached library read-only. */
  offline: boolean;
  collections: Record<LibrarySection, LibraryCollectionState>;
  details: LibraryDetailsState;
}

export interface DiagnosticsState {
  logs: string[];
  failures: string[];
  sessionStartedAt: number;
}

export interface PendingCollectionPlay {
  kind: "album" | "playlist";
  id: string;
}

export interface UiState {
  queueOpen: boolean;
  diagnosticsOpen: boolean;
  sidebarOpen: boolean;
  nowPlayingOpen: boolean;
  /** Collection whose pages load before playback starts. */
  pendingCollection?: PendingCollectionPlay;
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
  /** Sanitized, bounded release notes retained for the downloaded update. */
  releaseNotes?: string;
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
  /** Ratings keyed by `ratingKey(type, id)`. */
  ratings?: Record<string, RatingValue>;
}

export interface RuntimeAppState extends AppState {
  initialization: InitializationState;
  /** Embedded MusicKit developer token expiry (epoch ms), when known. */
  developerTokenExpiresAt?: number;
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
  ratings: Record<string, RatingValue>;
}
