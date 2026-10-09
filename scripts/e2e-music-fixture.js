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

  // Catalog (not library) song: its rating and library add use the plain `songs` kind.
  const catalogSong = {
    id: "catalog-song",
    type: "songs",
    attributes: {
      name: "Catalog Song",
      artistName: "Fixture Artist",
      albumName: "Fixture Album",
      durationInMillis: 180_000,
      playParams: {
        id: "catalog-song",
        kind: "song",
        catalogId: "catalog-song",
      },
    },
  };
  // Lyrics fixtures. "song-a" serves hostile TTML, "song-c" is denied with 403,
  // and "song-e" has lyrics but is never requested once the 403 disables them.
  const LYRICS_SONGS = new Set(["song-a", "song-c", "song-e"]);
  for (const item of [...playlistItems, ...albumItems]) {
    if (LYRICS_SONGS.has(item.id)) item.attributes.hasLyrics = true;
  }
  const LYRICS_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Line">
<head><metadata><script>window.__ARLET_TTML_SENTINEL = true</script></metadata></head>
<body><div>
<p begin="00:00:01.000" end="00:00:04.000">Opening line</p>
<p begin="bad-time" end="00:00:08.000"><img src="x" onerror="window.__ARLET_TTML_SENTINEL = true"/>Unsynced hostile line</p>
<p begin="6.5s" end="00:00:09.000">Offset line</p>
<p begin="00:10.000" end="00:00:14.000"><![CDATA[<b>Markup stays text</b>]]></p>
<p begin="20.000" end="00:00:22.000">Script line<script>window.__ARLET_TTML_SENTINEL = true</script></p>
<p begin="00:00:40.000" end="00:00:45.000">Chorus line at forty</p>
<p begin="00:50.000" end="00:55.000">Final line</p>
</div></body></tt>`;

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

  // A library-only song: no catalog ID in playParams or relationships.
  const libraryOnlyItem = track("i.library-only", "Library Only Song");
  libraryOnlyItem.attributes.playParams = {
    id: "i.library-only",
    kind: "song",
  };
  navResources[libraryOnlyItem.id] = libraryOnlyItem;

  const resource = (id) =>
    playlistItems.find((item) => item.id === id) ??
    albumItems.find((item) => item.id === id) ??
    navResources[id] ??
    (id === catalogSong.id ? catalogSong : undefined) ??
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
    rejectPlay: false,
    nativeQueueEdit: false,
    queueEditDelayMs: 0,
    // Keyed `${type}:${id}`, e.g. `library-songs:song-a`; values are 1 or -1.
    ratings: {},
    libraryAdds: [],
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
      // A new item starts at zero with a known duration, as MusicKit reports it.
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: 0,
        currentPlaybackDuration: 180,
      });
    }
  };

  const idsFromOptions = (options) => {
    if (Array.isArray(options?.items)) {
      return options.items.map((item) => String(item?.id));
    }
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

  // Ratings honor the method: GET reads `query.ids`, PUT/DELETE edit state.
  const ratingResponse = (pathname, call) => {
    const match = pathname.match(/^\/v1\/me\/ratings\/([^/]+)(?:\/([^/]+))?$/u);
    if (!match) return undefined;
    const type = match[1];
    const id =
      match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (call.method === "GET") {
      const ids = String(call.query?.ids ?? "")
        .split(",")
        .filter(Boolean);
      return {
        data: ids
          .filter((itemId) => state.ratings[`${type}:${itemId}`] !== undefined)
          .map((itemId) => ({
            id: itemId,
            type: "ratings",
            attributes: { value: state.ratings[`${type}:${itemId}`] },
          })),
      };
    }
    if (id === undefined) return undefined;
    if (call.method === "PUT") {
      state.ratings[`${type}:${id}`] = call.body?.attributes?.value;
      return {};
    }
    if (call.method === "DELETE") {
      delete state.ratings[`${type}:${id}`];
      return {};
    }
    return undefined;
  };

  const libraryResponse = (pathname, call) => {
    if (pathname !== "/v1/me/library" || call.method !== "POST")
      return undefined;
    for (const [key, value] of Object.entries(call.query ?? {})) {
      const type = key.match(/^ids\[(\w+)\]$/u)?.[1];
      if (!type) continue;
      for (const id of String(value).split(",").filter(Boolean)) {
        state.libraryAdds.push({ type, id });
      }
    }
    return {};
  };

  const responseFor = (path, call = { method: "GET" }) => {
    const pathname = String(path).split("?", 1)[0];
    const mutation =
      ratingResponse(pathname, call) ?? libraryResponse(pathname, call);
    if (mutation) return mutation;
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
    const lyricsMatch = pathname.match(
      /^\/v1\/catalog\/us\/songs\/([^/]+)\/lyrics$/u,
    );
    if (lyricsMatch) {
      const id = decodeURIComponent(lyricsMatch[1]);
      return {
        data: [{ id, type: "lyrics", attributes: { ttml: LYRICS_TTML } }],
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

  // MusicKit v3 callers pass the method and body under `fetchOptions`.
  const requestBody = (raw) => {
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(String(raw));
    } catch {
      return String(raw);
    }
  };

  const musicRequest = async (path, query, options) => {
    const request = {
      path: String(path),
      method: String(
        options?.method ?? options?.fetchOptions?.method ?? "GET",
      ).toUpperCase(),
      query: query ? clone(query) : undefined,
      body: requestBody(options?.body ?? options?.fetchOptions?.body),
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
    if (/^\/v1\/catalog\/us\/songs\/song-c\/lyrics$/u.test(pathText)) {
      request.error = "Fixture lyrics forbidden";
      const error = new Error(request.error);
      error.status = 403;
      throw error;
    }
    const response = responseFor(pathText, request);
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

  // Native queue edits exist only when configure({ nativeQueueEdit: true }),
  // so both the native and rebuild tiers run against the same fixture.
  const queueEditDelay = async () => {
    if (state.queueEditDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, state.queueEditDelayMs),
      );
    }
  };
  const insertNative = async (type, index, options) => {
    const ids = idsFromOptions(options);
    if (!Number.isInteger(index) || index < 0 || index > state.queue.length) {
      throw new Error(`Fixture queue index unavailable: ${index}`);
    }
    await queueEditDelay();
    state.queue.splice(index, 0, ...ids.map(mediaItem));
    if (index <= state.queueIndex) state.queueIndex += ids.length;
    state.transitions.push({ type, index, ids: [...ids] });
    syncProviderQueue(true, false);
  };
  const nativeQueue = Object.create(queueRecord);
  Object.assign(nativeQueue, {
    async remove(index) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= state.queue.length
      ) {
        throw new Error(`Fixture queue index unavailable: ${index}`);
      }
      await queueEditDelay();
      if (index >= state.queue.length) {
        throw new Error(`Fixture queue index unavailable: ${index}`);
      }
      const [removed] = state.queue.splice(index, 1);
      if (index < state.queueIndex) state.queueIndex -= 1;
      state.transitions.push({
        type: "nativeRemove",
        index,
        id: removed?.id,
      });
      syncProviderQueue(true, false);
    },
    splice(index, options) {
      return insertNative("nativeSplice", index, options);
    },
    append(options) {
      return insertNative("nativeAppend", state.queue.length, options);
    },
    prepend(options) {
      return insertNative("nativePrepend", 0, options);
    },
  });

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
    playbackState: STOPPED,
    player,
    api: { music: musicRequest, v3: { music: musicRequest } },
    get queueItems() {
      return state.queue;
    },
    get queue() {
      return state.nativeQueueEdit ? nativeQueue : undefined;
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
      state.transitions.push({ type: "volume", value });
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
        shape: Object.keys(options ?? {}),
        shuffle: player.shuffle,
      });
      syncProviderQueue(true, true);
      return queueRecord;
    },
    changeToMediaAtIndex: (index) => selectIndex(index),
    async play() {
      if (state.rejectPlay) {
        state.transitions.push({ type: "playRejected" });
        throw new Error("Fixture play rejected");
      }
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
      state.transitions.push({ type: "seekToTime", seconds: time });
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
      if (Object.prototype.hasOwnProperty.call(options, "rejectPlay")) {
        state.rejectPlay = options.rejectPlay === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "nativeQueueEdit")) {
        state.nativeQueueEdit = options.nativeQueueEdit === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "queueEditDelayMs")) {
        state.queueEditDelayMs = Math.max(
          0,
          Number(options.queueEditDelayMs) || 0,
        );
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
      state.rejectPlay = false;
      state.nativeQueueEdit = false;
      state.queueEditDelayMs = 0;
      state.ratings = {};
      state.libraryAdds = [];
      state.queue = [];
      state.queueIndex = 0;
      state.shuffleHistory = [];
      player.shuffle = false;
      player.repeatMode = 0;
      player.volume = 1;
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
    emitPlaybackTime(seconds) {
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: seconds,
        currentPlaybackDuration: 180,
      });
      return true;
    },
    seedQueue(count) {
      state.queue = Array.from({ length: count }, (_, index) =>
        mediaItem(`bulk-${index}`),
      );
      state.queueIndex = 0;
      state.shuffleHistory = [0];
      state.transitions.push({ type: "seedQueue", total: count });
      syncProviderQueue(true, true);
      return true;
    },
    snapshot() {
      return {
        seed: this.seed,
        requests: clone(state.requests),
        transitions: clone(state.transitions),
        queueEdit: {
          native: state.nativeQueueEdit,
          delayMs: state.queueEditDelayMs,
        },
        queue: captureQueue(),
        modes: {
          shuffle: player.shuffle === true,
          repeat: player.repeatMode,
        },
        volume: player.volume,
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
