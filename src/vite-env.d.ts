/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_NODE_VERSION__: string;
declare const __BUILD_NPM_VERSION__: string;

// MusicKit JS global types (minimal for Phase 0)
declare namespace MusicKit {
  interface Config {
    developerToken: string;
    app: {
      name: string;
      build: string;
    };
  }

  interface MusicKitInstance {
    authorize(): Promise<string>;
    unauthorize(): Promise<void>;
    isAuthorized: boolean;
    musicUserToken: string;
    setQueue(options: QueueOptions): Promise<void>;
    /** Recently loaded library songs exposed by MusicKit JS when available. */
    librarySongs?: MediaItem[];
    /** Current playlist/resource descriptor exposed by MusicKit JS. */
    playlist?: ResourceDescriptor | MediaItem | string;
    play(): Promise<void>;
    playNext?(
      options?: QueueOptions | string | MediaItem,
    ): Promise<void> | void;
    playLater?(
      options?: QueueOptions | string | MediaItem,
    ): Promise<void> | void;
    pause(): void;
    stop(): void;
    seekToTime(time: number): Promise<void>;
    skipToNextItem(): Promise<void>;
    skipToPreviousItem(): Promise<void>;
    volume: number;
    currentPlaybackTime: number;
    currentPlaybackDuration: number;
    nowPlayingItem: MediaItem | null;
    playbackState: number;
    storefrontId: string;
    addEventListener(
      name: string,
      callback: (event: Record<string, unknown>) => void,
    ): void;
    removeEventListener(
      name: string,
      callback: (event: Record<string, unknown>) => void,
    ): void;
    api: {
      music?(
        path: string,
        query?: Record<string, unknown>,
        options?: RequestOptions,
      ): Promise<unknown>;
      v3?: {
        music(
          path: string,
          query?: Record<string, unknown>,
          options?: RequestOptions,
        ): Promise<unknown>;
      };
    };
  }

  interface RequestOptions {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  }

  interface QueueOptions {
    songs?: string[];
    librarySongs?: string[];
    musicVideos?: string[];
    libraryMusicVideos?: string[];
    album?: string;
    url?: string;
    [key: string]: unknown;
  }

  interface ResourceDescriptor {
    id: string;
    type: string;
    href?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }

  type Resource = ResourceDescriptor;

  interface ResourceResponse {
    data?: ResourceDescriptor | ResourceDescriptor[];
    next?: string;
    meta?: Record<string, unknown>;
    links?: { next?: string };
  }

  interface MediaItem {
    id: string;
    title: string;
    artistName: string;
    albumName: string;
    artworkURL: string;
    playbackDuration: number;
    attributes?: {
      durationInMillis?: number;
      [key: string]: unknown;
    };
    artwork?: { url: string; width: number; height: number };
  }

  const PlaybackStates: {
    none: number;
    loading: number;
    playing: number;
    paused: number;
    stopped: number;
    ended: number;
    seeking: number;
    waiting: number;
    stalled: number;
    completed: number;
  };

  const Events: {
    playbackStateDidChange: string;
    nowPlayingItemDidChange: string;
    authorizationStatusDidChange: string;
    mediaPlaybackError: string;
    queueItemsDidChange: string;
    playbackTimeDidChange: string;
    playbackDurationDidChange: string;
  };

  function configure(config: Config): MusicKitInstance;
  function getInstance(): MusicKitInstance;
}

declare interface Window {
  MusicKit: typeof MusicKit;
}
