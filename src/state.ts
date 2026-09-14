import type { PlaybackState, Track } from "./domain/music.ts";
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
  /** Reserved for forward-compatible settings owned by other versions. */
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  theme: "system",
  windowEffect: "acrylic",
  autoCheckUpdates: true,
  updateChannel: "auto",
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
  error?: string;
  requestId: number;
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
  /** Milestone 0-compatible snapshots may omit the shell fields. */
  initialization?: InitializationState;
  navigation?: Route;
  search?: SearchState;
  settings?: AppSettings;
  windowEffect?: WindowEffectState;
  updates?: UpdateState;
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
  ui: UiState;
  diagnostics: DiagnosticsState;
}

const initialPlaybackState: PlaybackState = {
  status: "idle",
  current: undefined,
  positionSeconds: 0,
  durationSeconds: 0,
  volume: 0.5,
  queue: [],
  queueIndex: 0,
  error: undefined,
};

const initialState: RuntimeAppState = {
  auth: { status: "unauthorized", pending: false },
  initialization: { status: "idle" },
  navigation: { kind: "home" },
  playback: { ...initialPlaybackState },
  search: {
    query: "",
    status: "idle",
    results: [],
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
};

function cloneInitialState(): RuntimeAppState {
  return {
    ...initialState,
    playback: { ...initialPlaybackState },
    search: { ...initialState.search, results: [] },
    settings: { ...DEFAULT_SETTINGS },
    windowEffect: { ...initialState.windowEffect },
    updates: { ...initialState.updates },
    ui: { ...initialState.ui },
    diagnostics: {
      ...initialState.diagnostics,
      logs: [],
      failures: [],
      sessionStartedAt: Date.now(),
    },
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

export function setCurrentTrack(track: Track | undefined): void {
  const isNewTrack =
    track !== undefined && track.id !== state.playback.current?.id;
  const queueIndex = track
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
