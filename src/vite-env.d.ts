/// <reference types="vite/client" />

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
    setQueue(options: {
      songs?: string[];
      album?: string;
      url?: string;
    }): Promise<void>;
    play(): Promise<void>;
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
      music?(path: string, query?: Record<string, unknown>): Promise<unknown>;
      v3?: {
        music(path: string, query?: Record<string, unknown>): Promise<unknown>;
      };
    };
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
