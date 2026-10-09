/** Seed used by the native E2E report to make runs repeatable. */
export const MUSIC_FIXTURE_SEED = "arlet-playlist-continuation-2026-10-08";

function installMusicKitFixture() {
  if (window.__ARLET_E2E_MUSIC__) return;

  const PLAYING = 5;
  const PAUSED = 4;
  const STOPPED = 8;
  const events = {
    playbackStateDidChange: "playbackStateDidChange",
    nowPlayingItemDidChange: "nowPlayingItemDidChange",
    playbackTimeDidChange: "playbackTimeDidChange",
    mediaPlaybackError: "mediaPlaybackError",
    queueItemsDidChange: "queueItemsDidChange",
    shuffleModeDidChange: "shuffleModeDidChange",
    repeatModeDidChange: "repeatModeDidChange",
  };

  const track = (id, name, albumName = "Fixture Album") => ({
    id,
    type: "library-songs",
    attributes: {
      name,
      artistName: "Fixture Artist",
      albumName,
      durationInMillis: 180_000,
      playParams: { id, kind: "song", catalogId: id },
      artwork: {
        url: "https://example.invalid/{w}x{h}bb.jpg",
        width: 300,
        height: 300,
      },
    },
  });

  const playlistItems = [
    track("song-a", "Track A"),
    track("song-duplicate", "Duplicate Occurrence"),
    track("song-c", "Track C"),
    track("song-duplicate", "Duplicate Occurrence"),
    track("song-e", "Track E"),
    track("song-f", "Track F"),
  ];
  const albumItems = [
    track("album-a", "Album Track A", "Fixture Album"),
    track("album-b", "Album Track B", "Fixture Album"),
    track("album-c", "Album Track C", "Fixture Album"),
    track("album-d", "Album Track D", "Fixture Album"),
  ];

  const navTrack = (id, name, relationships) => {
    const resource = track(id, name, "Navigation Album");
    resource.attributes.playParams = { id, kind: "song", catalogId: id };
    if (relationships) resource.relationships = relationships;
    return resource;
  };
  const navResources = {
    "nav-multi": navTrack("nav-multi", "Navigation Multi Artist Song", {
      albums: { data: [{ id: "nav-album", type: "albums" }] },
      artists: {
        data: [
          { id: "nav-artist-one", type: "library-artists" },
          { id: "nav-artist-two", type: "artists" },
        ],
      },
    }),
    "nav-missing": navTrack("nav-missing", "Navigation Without Relationships"),
    "nav-delayed": navTrack("nav-delayed", "Navigation Delayed Song"),
    "nav-race": navTrack("nav-race", "Navigation Race Song"),
    "nav-error": navTrack("nav-error", "Navigation Error Song"),
  };

  const resource = (id) =>
    playlistItems.find((item) => item.id === id) ??
    albumItems.find((item) => item.id === id) ??
    navResources[id] ??
    track(id, id);
  const playlist = {
    id: "playlist-1",
    type: "library-playlists",
    attributes: {
      name: "Fixture Playlist",
      artistName: "Arlet E2E",
      trackCount: playlistItems.length,
      canEdit: true,
    },
  };
  const album = {
    id: "album-1",
    type: "library-albums",
    attributes: {
      name: "Fixture Album",
      artistName: "Fixture Artist",
      trackCount: albumItems.length,
    },
  };

  const state = {
    configured: false,
    listeners: new Map(),
    requests: [],
    transitions: [],
    queue: [],
    queueIndex: 0,
    shuffleHistory: [],
    contextTarget: undefined,
    delayPaths: [],
    rejectPaths: [],
    delayMs: 800,
    repeatPlaylistCursor: false,
  };
  let instance;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const emit = (name, event = {}) => {
    for (const callback of [...(state.listeners.get(name) ?? [])]) {
      try {
        callback(event);
      } catch (error) {
        state.transitions.push({
          type: "listenerError",
          event: name,
          error: String(error?.message ?? error),
        });
      }
    }
  };
  const currentItem = () => state.queue[state.queueIndex] ?? null;
  const queueRecord = {
    get items() {
      return state.queue;
    },
    get position() {
      return state.queue.length ? state.queueIndex : -1;
    },
    get length() {
      return state.queue.length;
    },
    get isEmpty() {
      return state.queue.length === 0;
    },
    item(index) {
      return state.queue[index] ?? null;
    },
  };

  const syncProviderQueue = (emitQueue = true, emitCurrent = true) => {
    if (!state.queue.length) state.queueIndex = 0;
    else
      state.queueIndex = Math.max(
        0,
        Math.min(state.queueIndex, state.queue.length - 1),
      );
    if (emitQueue) {
      emit(events.queueItemsDidChange, {
        queue: queueRecord,
        items: state.queue,
        currentItemIndex: state.queueIndex,
        currentItem: currentItem(),
      });
    }
    if (emitCurrent) {
      emit(events.nowPlayingItemDidChange, {
        item: currentItem(),
        queue: queueRecord,
        currentItemIndex: state.queueIndex,
      });
    }
  };

  const idsFromOptions = (options) => {
    const list = options?.songs ?? options?.musicVideos ?? [];
    return Array.isArray(list) ? list.map(String) : [];
  };
  const mediaItem = (id) => clone(resource(String(id)));
  const captureQueue = () => ({
    items: state.queue.map((item) => ({
      id: item.id,
      title: item.attributes?.name ?? item.title ?? item.id,
      artistName: item.attributes?.artistName ?? item.artistName,
      resourceType: item.type,
    })),
    index: state.queue.length ? state.queueIndex : -1,
    activeId: currentItem()?.id ?? null,
  });

  const itemResponse = (item) => ({ data: [clone(item)] });
  const secondPlaylistPage =
    "/v1/me/library/playlists/playlist-1/tracks?offset=4";
  const secondAlbumPage = "/v1/me/library/albums/album-1/tracks?offset=2";

  const responseFor = (path) => {
    const pathname = String(path).split("?", 1)[0];
    if (pathname === "/v1/me/storefront") {
      return { data: [{ id: "us", type: "storefronts" }] };
    }
    if (pathname === "/v1/me/library/playlists/playlist-1") {
      return itemResponse(playlist);
    }
    if (String(path).includes(secondPlaylistPage)) {
      return {
        data: playlistItems.slice(4).map(clone),
        ...(state.repeatPlaylistCursor ? { next: secondPlaylistPage } : {}),
      };
    }
    if (pathname === "/v1/me/library/playlists/playlist-1/tracks") {
      return {
        data: playlistItems.slice(0, 4).map(clone),
        next: secondPlaylistPage,
      };
    }
    if (pathname === "/v1/me/library/albums/album-1") {
      return itemResponse(album);
    }
    if (String(path).includes(secondAlbumPage)) {
      return { data: albumItems.slice(2).map(clone) };
    }
    if (pathname === "/v1/me/library/albums/album-1/tracks") {
      return {
        data: albumItems.slice(0, 2).map(clone),
        next: secondAlbumPage,
      };
    }
    const songMatch = pathname.match(
      /^\/v1\/(?:me\/library|catalog\/us)\/songs\/([^/]+)$/u,
    );
    if (songMatch) {
      const id = decodeURIComponent(songMatch[1]);
      const nav = navResources[id];
      if (!nav) return { data: [] };
      const relation = {
        "nav-multi": {
          albums: { data: [{ id: "nav-album", type: "albums" }] },
          artists: {
            data: [
              { id: "nav-artist-one", type: "library-artists" },
              { id: "nav-artist-two", type: "artists" },
            ],
          },
        },
        "nav-delayed": {
          albums: { data: [{ id: "nav-delayed-album", type: "albums" }] },
          artists: { data: [] },
        },
        "nav-race": {
          albums: { data: [{ id: "nav-race-album", type: "albums" }] },
          artists: { data: [] },
        },
      }[id];
      return itemResponse({
        ...clone(nav),
        ...(relation ? { relationships: clone(relation) } : {}),
      });
    }
    if (/\/playlist-folders(?:\/[^/]+)?\/children$/u.test(pathname)) {
      return { data: [] };
    }
    if (pathname === "/v1/me/library/playlist-folders") {
      return {
        data: [
          {
            id: "fixture-playlists-root",
            type: "library-playlist-folders",
            attributes: { name: "Playlists" },
          },
        ],
      };
    }
    if (pathname === "/v1/me/library/playlists") {
      return itemResponse(playlist);
    }
    if (pathname === "/v1/me/library/songs") {
      return { data: Object.values(navResources).map(clone) };
    }
    return { data: [] };
  };

  const musicRequest = async (path, query, options) => {
    const request = {
      path: String(path),
      query: query ? clone(query) : undefined,
      options: options ? clone(options) : undefined,
      startedAt: Date.now(),
    };
    state.requests.push(request);
    const pathText = String(path);
    const shouldReject = state.rejectPaths.some((entry) =>
      pathText.includes(String(entry)),
    );
    const delay = state.delayPaths.some((entry) =>
      pathText.includes(String(entry)),
    );
    if (delay)
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (shouldReject) {
      request.error = `Fixture request rejected: ${pathText}`;
      throw new Error(request.error);
    }
    const response = responseFor(pathText);
    request.completedAt = Date.now();
    request.response = clone(response);
    return clone(response);
  };

  const selectIndex = async (index, transitionType = "selectIndex") => {
    if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) {
      throw new Error(`Fixture queue index unavailable: ${index}`);
    }
    state.queueIndex = index;
    if (transitionType === "selectIndex") state.shuffleHistory = [index];
    else if (transitionType === "next" || transitionType === "finishNext") {
      state.shuffleHistory.push(index);
    } else if (transitionType === "previous" && state.shuffleHistory.length) {
      state.shuffleHistory.pop();
    }
    state.transitions.push({
      type: transitionType,
      index,
      id: currentItem()?.id,
      total: state.queue.length,
    });
    syncProviderQueue(true, true);
    return index;
  };

  const player = {
    queue: queueRecord,
    shuffle: false,
    repeatMode: 0,
    volume: 1,
    get nowPlayingItem() {
      return currentItem();
    },
    get nowPlayingItemIndex() {
      return state.queue.length ? state.queueIndex : -1;
    },
    changeToMediaAtIndex: (index) => selectIndex(index),
    changeToMediaItem: (descriptor) => {
      const id = typeof descriptor === "string" ? descriptor : descriptor?.id;
      const index = state.queue.findIndex((item) => item.id === id);
      return selectIndex(index);
    },
  };

  instance = {
    developerToken: "fixture-developer-token",
    musicUserToken: "fixture-music-user-token",
    isAuthorized: true,
    storefrontId: "us",
    // Removing this property simulates a runtime without autoplay support.
    autoplayEnabled: true,
    playbackState: STOPPED,
    player,
    api: { music: musicRequest, v3: { music: musicRequest } },
    get queueItems() {
      return state.queue;
    },
    get currentPlaybackQueueItemIndex() {
      return state.queue.length ? state.queueIndex : -1;
    },
    get currentPlaybackQueueItem() {
      return currentItem();
    },
    get nowPlayingItem() {
      return currentItem();
    },
    get volume() {
      return player.volume;
    },
    set volume(value) {
      player.volume = value;
    },
    addEventListener(name, callback) {
      const callbacks = state.listeners.get(name) ?? new Set();
      callbacks.add(callback);
      state.listeners.set(name, callbacks);
    },
    removeEventListener(name, callback) {
      if (callback) state.listeners.get(name)?.delete(callback);
      else state.listeners.delete(name);
    },
    async authorize() {
      this.isAuthorized = true;
      return this.musicUserToken;
    },
    async unauthorize() {
      this.isAuthorized = false;
    },
    async setQueue(options) {
      const itemIds = idsFromOptions(options);
      state.queue = itemIds.map(mediaItem);
      state.queueIndex = 0;
      state.shuffleHistory = [0];
      state.transitions.push({
        type: "setQueue",
        ids: [...itemIds],
        options: clone(options),
        shuffle: player.shuffle,
      });
      syncProviderQueue(true, true);
      return queueRecord;
    },
    changeToMediaAtIndex: (index) => selectIndex(index),
    async play() {
      this.playbackState = PLAYING;
      state.transitions.push({
        type: "play",
        index: state.queue.length ? state.queueIndex : -1,
        id: currentItem()?.id ?? null,
      });
      emit(events.playbackStateDidChange, { state: PLAYING });
      return state.queueIndex;
    },
    pause() {
      this.playbackState = PAUSED;
      state.transitions.push({ type: "pause" });
      emit(events.playbackStateDidChange, { state: PAUSED });
    },
    stop() {
      this.playbackState = STOPPED;
      emit(events.playbackStateDidChange, { state: STOPPED });
    },
    async skipToNextItem() {
      if (!state.queue.length) return -1;
      const index = player.shuffle
        ? state.queueIndex > 0
          ? state.queueIndex - 1
          : state.queue.length - 1
        : state.queueIndex + 1 < state.queue.length
          ? state.queueIndex + 1
          : player.repeatMode === 1
            ? 0
            : state.queueIndex;
      return selectIndex(index, "next");
    },
    async skipToPreviousItem() {
      if (!state.queue.length) return -1;
      const priorShuffleIndex =
        player.shuffle && state.shuffleHistory.length > 1
          ? state.shuffleHistory[state.shuffleHistory.length - 2]
          : undefined;
      const index =
        priorShuffleIndex ??
        (state.queueIndex > 0
          ? state.queueIndex - 1
          : player.repeatMode === 1
            ? state.queue.length - 1
            : 0);
      return selectIndex(index, "previous");
    },
    async seekToTime(time) {
      state.transitions.push({ type: "seek", seconds: time });
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: time,
        currentPlaybackDuration: 180,
      });
    },
    async playNext(options) {
      const itemIds = idsFromOptions(options);
      const start = Math.min(state.queue.length, state.queueIndex + 1);
      state.queue.splice(start, 0, ...itemIds.map(mediaItem));
      state.transitions.push({
        type: "playNext",
        ids: [...itemIds],
        index: start,
      });
      syncProviderQueue(true, false);
    },
    async playLater(options) {
      const itemIds = idsFromOptions(options);
      state.queue.push(...itemIds.map(mediaItem));
      state.transitions.push({ type: "playLater", ids: [...itemIds] });
      syncProviderQueue(true, false);
    },
  };

  const fixture = {
    seed: "arlet-playlist-continuation-2026-10-08",
    configure(options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, "delayPaths")) {
        state.delayPaths = [...(options.delayPaths ?? [])];
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectPaths")) {
        state.rejectPaths = [...(options.rejectPaths ?? [])];
      }
      if (Object.prototype.hasOwnProperty.call(options, "delayMs")) {
        state.delayMs = Math.max(0, Number(options.delayMs) || 0);
      }
      if (
        Object.prototype.hasOwnProperty.call(options, "repeatPlaylistCursor")
      ) {
        state.repeatPlaylistCursor = options.repeatPlaylistCursor === true;
      }
      return this.snapshot();
    },
    reset() {
      state.requests.length = 0;
      state.transitions.length = 0;
      state.contextTarget = undefined;
      state.delayPaths = [];
      state.rejectPaths = [];
      state.delayMs = 800;
      state.repeatPlaylistCursor = false;
      state.queue = [];
      state.queueIndex = 0;
      state.shuffleHistory = [];
      player.shuffle = false;
      player.repeatMode = 0;
      instance.playbackState = STOPPED;
      syncProviderQueue(true, true);
      emit(events.shuffleModeDidChange, { shuffle: false });
      emit(events.repeatModeDidChange, { repeatMode: 0 });
      return true;
    },
    setCurrentTrack(id) {
      const item = mediaItem(String(id));
      state.queue = [item];
      state.queueIndex = 0;
      state.shuffleHistory = [0];
      instance.playbackState = PLAYING;
      state.transitions.push({ type: "seedCurrent", id: item.id });
      syncProviderQueue(true, true);
      emit(events.playbackStateDidChange, { state: PLAYING });
      return true;
    },
    stripCurrentRelationships() {
      const item = currentItem();
      if (!item) return false;
      const bare = clone(item);
      delete bare.relationships;
      delete bare.albumRef;
      delete bare.artistRefs;
      state.queue[state.queueIndex] = bare;
      state.transitions.push({ type: "providerBareMedia", id: bare.id });
      syncProviderQueue(true, true);
      return true;
    },
    finishCurrentTrack() {
      if (!state.queue.length) return false;
      let nextIndex = state.queueIndex;
      let transitionType = "finishRepeatOne";
      if (player.repeatMode === 2) {
        // Repeat one retains the current occurrence on natural completion.
      } else if (player.shuffle) {
        nextIndex =
          state.queueIndex > 0 ? state.queueIndex - 1 : state.queue.length - 1;
        transitionType = "finishNext";
      } else if (state.queueIndex + 1 < state.queue.length) {
        nextIndex = state.queueIndex + 1;
        transitionType = "finishNext";
      } else if (player.repeatMode === 1) {
        nextIndex = 0;
        transitionType = "finishWrap";
      } else {
        instance.playbackState = STOPPED;
        state.transitions.push({
          type: "finishEnd",
          index: state.queueIndex,
          id: currentItem()?.id ?? null,
        });
        emit(events.playbackStateDidChange, { state: STOPPED });
        return true;
      }
      return selectIndex(nextIndex, transitionType);
    },
    /**
     * Ends the current track; at queue end with autoplay on, MusicKit appends
     * an item and keeps playing, as the real runtime does.
     */
    finishWithAutoplay() {
      if (!state.queue.length) return false;
      if (
        state.queueIndex + 1 >= state.queue.length &&
        player.repeatMode === 0 &&
        !player.shuffle &&
        instance.autoplayEnabled === true
      ) {
        state.queue.push(mediaItem(`autoplay-${state.queue.length + 1}`));
        return selectIndex(state.queue.length - 1, "finishAutoplay");
      }
      return this.finishCurrentTrack();
    },
    /** Adds or removes `autoplayEnabled` and emits a mode change so the app re-reads it. */
    setAutoplayAvailable(available) {
      if (available) {
        if (!("autoplayEnabled" in instance)) instance.autoplayEnabled = true;
      } else {
        delete instance.autoplayEnabled;
      }
      emit(events.shuffleModeDidChange, { shuffle: player.shuffle });
      return "autoplayEnabled" in instance;
    },
    selectContext(idOrTarget) {
      const id = typeof idOrTarget === "string" ? idOrTarget : idOrTarget?.id;
      const item = resource(String(id ?? ""));
      const title = item.attributes?.name ?? String(id ?? "");
      const target = document.createElement("div");
      target.dataset.contextKind = "track";
      target.dataset.contextId = String(id ?? "");
      target.dataset.contextTitle = title;
      target.dataset.contextArtist =
        item.attributes?.artistName ?? "Fixture Artist";
      target.dataset.contextAlbum = item.attributes?.albumName ?? "";
      target.dataset.contextResourceType = item.type ?? "library-songs";
      if (id === "nav-multi") {
        target.dataset.contextAlbumRef = JSON.stringify({
          id: "nav-album",
          name: "Navigation Album",
          source: "catalog",
        });
        target.dataset.contextArtistRefs = JSON.stringify([
          { id: "nav-artist-one", name: "Artist One", source: "library" },
          { id: "nav-artist-two", name: "Artist Two", source: "catalog" },
        ]);
      }
      target.style.cssText =
        "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      document.body.append(target);
      state.contextTarget = {
        kind: "track",
        id: String(id ?? ""),
        title,
        albumRef:
          id === "nav-multi"
            ? { id: "nav-album", source: "catalog" }
            : undefined,
      };
      window.dispatchEvent(
        new CustomEvent("arlet:open-context-menu", {
          detail: {
            target,
            x: 8,
            y: 8,
            restoreFocus: target,
          },
        }),
      );
      return true;
    },
    snapshot() {
      return {
        seed: this.seed,
        requests: clone(state.requests),
        transitions: clone(state.transitions),
        queue: captureQueue(),
        modes: {
          shuffle: player.shuffle === true,
          repeat: player.repeatMode,
        },
        contextTarget: state.contextTarget ? clone(state.contextTarget) : null,
      };
    },
  };

  const musicKit = {
    Events: events,
    PlaybackStates: {
      completed: 0,
      ended: 1,
      loading: 2,
      none: 3,
      paused: PAUSED,
      playing: PLAYING,
      seeking: 6,
      stalled: 7,
      stopped: STOPPED,
      waiting: 9,
    },
    configure() {
      state.configured = true;
      return instance;
    },
    getInstance() {
      return state.configured ? instance : undefined;
    },
  };

  window.__ARLET_E2E_MUSIC__ = fixture;
  window.MusicKit = musicKit;
}

export const musicFixtureSource = `(${installMusicKitFixture.toString()})();`;
