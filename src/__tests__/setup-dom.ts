// Minimal Tauri mock for jsdom test environment
const tauriMock = {
  invoke: async (_cmd: string, _args?: Record<string, unknown>) => ({}),
  listen: async (_event: string, _handler: unknown) => () => {},
};

(globalThis as Record<string, unknown>).__TAURI__ = tauriMock;

// Minimal MusicKit mock
const PlaybackStates = {
  none: 0,
  loading: 1,
  playing: 2,
  paused: 3,
  stopped: 4,
  ended: 5,
  seeking: 6,
  waiting: 8,
  stalled: 9,
  completed: 10,
};

const Events = {
  playbackStateDidChange: "playbackStateDidChange",
  nowPlayingItemDidChange: "nowPlayingItemDidChange",
  authorizationStatusDidChange: "authorizationStatusDidChange",
  mediaPlaybackError: "mediaPlaybackError",
  queueItemsDidChange: "queueItemsDidChange",
  playbackTimeDidChange: "playbackTimeDidChange",
  playbackDurationDidChange: "playbackDurationDidChange",
};

(globalThis as Record<string, unknown>).MusicKit = {
  PlaybackStates,
  Events,
  configure: () => ({}),
  getInstance: () => ({}),
};
