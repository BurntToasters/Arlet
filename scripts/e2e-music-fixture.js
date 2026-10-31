/** Seed used by the native E2E report to make runs repeatable. */
export const MUSIC_FIXTURE_SEED = "arlet-playlist-continuation-2026-10-08";

/**
 * UI polish ids (scripts/e2e-polish.js; docs/TESTING.md "UI polish"). Served
 * only at their own catalog paths, and the search term "polish" finds them.
 * album-polish: 2 discs, 4 tracks (703 s), editorial notes with HTML and a
 * script that sets window.__ARLET_POLISH_XSS__, label, copyright, genres.
 * Its tracks carry artwork with bgColor, so Now Playing tints when they play.
 * polish-bloom-blue, -orange, -dark and -pale carry deterministic artwork
 * colors for the Now Playing bloom screenshots.
 * album-polish-sparse: no release date, genres, label, notes or durations.
 * pl.polish-fixture: 2 songs and a description with HTML-looking text.
 *
 * Discovery ids (scripts/e2e-discovery.js; docs/TESTING.md "Apple Music
 * discovery features"). Search finds them with a term containing "discovery";
 * suggestions answer terms starting "pol" or "fix"; other terms get none.
 * artist-views: every view populated; editorialNotes with HTML and a script
 *   that sets window.__ARLET_DISCOVERY_XSS__; editorialArtwork.bannerUber.
 *   top-songs (8) and full-albums (30) page at 5 and 25 for the inline view.
 * artist-views-sparse: only top-songs and full-albums; no notes or artwork.
 *   Other requested views come back as { data: [] }.
 * album-discover: 4 tracks; other-versions (1), related-albums (3) and
 *   more-by-artist (0, so its shelf must stay hidden).
 * Search "discovery": top results; 60 albums (25 a page); station
 *   ra.discover-station-1; curator cur.discovery-fixture.
 * Genres 14 Pop, 20 Alternative, 21 Rock, 7 Electronic. Charts give songs
 *   per genre: no genre gets chart-song (30), genre 14 pop-chart (12) and
 *   genre 21 rock-chart (3). Only the no-genre and 14 charts carry the
 *   cityCharts and dailyGlobalTopCharts shelves; 21 never does.
 * Station genres sg-pop (ra.genre-pop-1 with url, ra.genre-pop-2 without)
 *   and sg-rock (ra.genre-rock-1).
 * cur.discovery-fixture (curators) and apple.discovery-fixture
 *   (apple-curators): grouped-playlists view and include=playlists.
 * pl.discovery-curated-1, -curated-2, pl.discovery-apple-1, and the
 *   featured playlists: 2 songs each, with a curator relationship.
 * Request controls: configure({ delayTerms: { pol: 1200 } }) delays a
 *   suggestions term; configure({ rejectQueryKeys: ["views"] }) rejects any
 *   request carrying that query key; configure({ repeatViewCursor: true })
 *   makes every page after the first point at itself. configure({
 *   holdSetQueue: true }) holds queue rebuilds until releaseSetQueue() resolves
 *   them. configure({ holdSeek: true }) records each seekToTime() call but
 *   holds its completion tick until releaseSeek(count) resolves the oldest.
 * Event controls (payloads as the app's MusicKit events reader expects them):
 *   emitAuthorizationStatus(false) sets isAuthorized = false, then emits
 *     authorizationStatusDidChange {}; true sets it back the same way.
 *   emitPlaybackDuration(240) emits playbackDurationDidChange
 *     { currentPlaybackDuration: 240 }.
 *   emitPlaybackVolume(0.4) sets instance.volume, then emits
 *     playbackVolumeDidChange { volume: 0.4 }.
 *   setLive(true) marks the current item attributes.isLive; the app clears
 *     live metadata when nowPlayingItemDidChange carries a non-live item.
 *   emitTimedMetadata({ title, artist }) emits timedMetadataDidChange
 *     { timedMetadata: { title, artist } }; it emits whether or not the item
 *     is live, so a test sets live first.
 *   emitMetadata({ title, artist }) emits metadataDidChange with the same
 *     payload, as the alias the app listens for.
 *
 * Stream handoff and sign-in expiry (scripts/e2e-account-session.js;
 * docs/TESTING.md "Stream handoff and sign-in expiry"):
 *   MusicKit.configure(options) records the option names and
 *     suppressErrorDialog (never a token) in snapshot().configure.
 *   stop() records a "stop" transition and, like MusicKit, emits
 *     playbackStateDidChange (stopped) and nowPlayingItemDidChange {}.
 *   configure({ rejectMeStatus: 403 }) makes every /v1/me request reject
 *     with an MKError-shaped error (errorCode "ACCESS_DENIED", status and
 *     data.status); the request is still recorded. 0 or null clears it.
 *   authorize() while isAuthorized returns the stale token without a popup,
 *     as MusicKit does, and records { type: "authorize", popup: false }.
 *     Otherwise it records popup: true and clears rejectMeStatus, or throws
 *     AUTHORIZATION_ERROR when configure({ rejectAuthorize: true }) is set.
 *   unauthorize() records "unauthorize", sets isAuthorized = false and emits
 *     authorizationStatusDidChange.
 *   reset() clears rejectMeStatus and rejectAuthorize.
 *
 * Audit fixes (scripts/e2e-audit-fixes.js; docs/TESTING.md "Audit fixes"):
 *   configure({ hangAuthorize: true }) makes authorize() record
 *     { type: "authorize", popup: true, hung: true } and wait, like a sign-in
 *     window whose closed-window poll never fires. Each held call is counted
 *     in snapshot().authorizeHeld until releaseAuthorize() (returns how many
 *     it released) lets it finish through the normal path. reset() releases
 *     any held call too.
 *
 * API object (docs/TESTING.md "Audit fixes"): like MusicKit, every sign-in,
 *   sign-out and authorizationStatusDidChange replaces instance.api with a
 *   new object and records { type: "apiReset", generation }. A replaced
 *   object still answers catalog paths, but rejects /v1/me with a bare "403"
 *   MKError (ACCESS_DENIED), as the old token it carries would; those
 *   requests are recorded with staleApi: true. snapshot().apiGeneration is
 *   the current generation.
 *
 * Library view (scripts/e2e-library-view.js): configure({ librarySize }) also
 *   gives each album a dateAdded cycling through 37 days, with none on every
 *   7th item. Every 5th album is contentRating "explicit". Album titles
 *   "Écho" (i % 50 = 4) and "echo" (i % 50 = 9) tie under base collation.
 *   configure({ libraryView: true }) pages 120 library songs (titles, album
 *   and artist names, dateAdded, contentRating on some), serves six playlists
 *   (two named "Sunday Drive") and a "Road Trip" folder holding two of them.
 *   configure({ ratings: { "library-albums:<id>": 1 } }) replaces the rating
 *   map; reset() clears it and libraryView.
 *
 * Pinned playlist artwork (scripts/e2e-pin-artwork.js; docs/TESTING.md
 *   "Pinned playlist artwork"): playlist-pin-art has an uploaded cover signed
 *   when answered; playlist-pin-nocover has no artwork. Neither is in the plain
 *   library list unless configure({ pinArtListExpired: true }) adds
 *   playlist-pin-art there with its cover signed 2026-01-01, so the link has
 *   expired. Unknown library ids answer { data: [] } on detail and ?ids=.
 */

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
    queuePositionDidChange: "queuePositionDidChange",
    shuffleModeDidChange: "shuffleModeDidChange",
    repeatModeDidChange: "repeatModeDidChange",
    // Not listened to by the app yet; the discovery controls emit them.
    authorizationStatusDidChange: "authorizationStatusDidChange",
    playbackDurationDidChange: "playbackDurationDidChange",
    playbackVolumeDidChange: "playbackVolumeDidChange",
    timedMetadataDidChange: "timedMetadataDidChange",
    metadataDidChange: "metadataDidChange",
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
  const libraryDiscoverySong = track(
    "library-discovery-song",
    "Discovery Library Song",
  );
  libraryDiscoverySong.attributes.playParams = {
    id: libraryDiscoverySong.id,
    kind: "song",
  };
  const navTrack = (id, name, relationships) => {
    const resource = track(id, name, "Navigation Album");
    resource.attributes.playParams = { id, kind: "song", catalogId: id };
    if (relationships) resource.relationships = relationships;
    return resource;
  };
  const navResources = {
    // Two unnamed artist links whose names the artist text supplies.
    "nav-multi": (() => {
      const item = navTrack("nav-multi", "Navigation Multi Artist Song", {
        albums: { data: [{ id: "nav-album", type: "albums" }] },
        artists: {
          data: [
            { id: "nav-artist-one", type: "library-artists" },
            { id: "nav-artist-two", type: "artists" },
          ],
        },
      });
      item.attributes.artistName = "Artist One & Artist Two";
      return item;
    })(),
    "nav-missing": navTrack("nav-missing", "Navigation Without Relationships"),
    "nav-delayed": navTrack("nav-delayed", "Navigation Delayed Song"),
    "nav-race": navTrack("nav-race", "Navigation Race Song"),
    "nav-error": navTrack("nav-error", "Navigation Error Song"),
    // Artist links without names, as Apple sometimes returns them.
    "nav-unnamed": navTrack("nav-unnamed", "Navigation Unnamed Artists", {
      artists: {
        data: [
          { id: "nav-artist-one", type: "library-artists" },
          { id: "nav-artist-two", type: "artists" },
        ],
      },
    }),
  };

  // A library-only song: no catalog ID in playParams or relationships.
  const libraryOnlyItem = track("i.library-only", "Library Only Song");
  libraryOnlyItem.attributes.playParams = {
    id: "i.library-only",
    kind: "song",
  };
  navResources[libraryOnlyItem.id] = libraryOnlyItem;

  const stationResource = (id, name, url) => ({
    id,
    type: "stations",
    attributes: { name, ...(url ? { url } : {}) },
  });
  const songStation = stationResource(
    "ra.song-one",
    "Navigation Song Station",
    "https://music.apple.com/us/station/navigation-song-station/ra.song-one",
  );
  // No url: playback must fall back to the station ID.
  const artistStation = stationResource("ra.artist-two", "Artist Two Station");
  const topSongItems = ["top-1", "top-2", "top-3"].map((id, index) => ({
    id,
    type: "songs",
    attributes: {
      name: `Top Song ${index + 1}`,
      artistName: "Artist Two",
      albumName: "Top Album",
      durationInMillis: 180_000,
      playParams: { id, kind: "song", catalogId: id },
    },
  }));

  // Apple can serve a song without artwork; the bloom must then render nothing.
  const trackWithoutArtwork = track("song-no-art", "Track Without Artwork");
  delete trackWithoutArtwork.attributes.artwork;

  const resource = (id) =>
    (id === "song-no-art" ? trackWithoutArtwork : undefined) ??
    playlistItems.find((item) => item.id === id) ??
    topSongItems.find((item) => item.id === id) ??
    bigItems.find((item) => item.id === id) ??
    catalogPlaylistItems.find((item) => item.id === id) ??
    albumItems.find((item) => item.id === id) ??
    [
      ...polishAlbumTracks,
      ...polishSparseTracks,
      ...polishPlaylistTracks,
      ...polishBloomTracks,
    ].find((item) => item.id === id) ??
    navResources[id] ??
    discoveryTrackItems.find((item) => item.id === id) ??
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
    rejectPlayTimes: 0,
    // Catalog IDs the item loader cannot resolve, and IDs that resolve but
    // are not playable (MusicKit drops those silently).
    unresolvedIds: [],
    // Real MusicKit does not look up songs queued as details, so an
    // unresolvable song is only found when it plays. Off by default.
    detailsSkipLookup: false,
    unplayableIds: [],
    nativeQueueEdit: false,
    queueEditDelayMs: 0,
    holdSetQueue: false,
    setQueueReleases: [],
    holdSeek: false,
    seekReleases: [],
    // Keyed `${type}:${id}`, e.g. `library-songs:song-a`; values are 1 or -1.
    ratings: {},
    libraryAdds: [],
    // Generated library albums and artists; 0 keeps the seed data only.
    librarySize: 0,
    // Library songs, playlists and the playlist folder (header comment).
    libraryView: false,
    // Artwork URL template for responses and queue items; "" keeps seed URLs.
    artworkTemplate: "",
    // Artwork sizing data (ARTWORK_* below); off, so other suites never see it.
    artworkGrid: false,
    // Pinned playlist artwork (header comment); off by default.
    pinArtListExpired: false,
    // Discovery controls (header comment); all off by default.
    delayTerms: {},
    rejectQueryKeys: [],
    repeatViewCursor: false,
    liveMetadata: null,
    // Sign-in expiry controls (header comment).
    rejectMeStatus: 0,
    rejectAuthorize: false,
    // Sign-in window that never reports back (audit fixes, cancel a stuck
    // sign-in). Held calls wait in authorizeReleases until releaseAuthorize().
    hangAuthorize: false,
    authorizeReleases: [],
    configureOptions: null,
  };
  // Lets every held authorize() call finish through the normal path.
  const releaseHeldAuthorize = () => {
    const releases = state.authorizeReleases.splice(0);
    for (const release of releases) release();
    return releases.length;
  };
  const releaseHeldSetQueue = () => {
    const releases = state.setQueueReleases.splice(0);
    for (const release of releases) release();
    return releases.length;
  };
  const releaseHeldSeeks = (count = Infinity) => {
    const releases = state.seekReleases.splice(0, count);
    for (const release of releases) release();
    return releases.length;
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
  // With an artwork template set, each artwork URL is replaced by it, with
  // `{id}` standing for the resource ID. Without one, the copy is unchanged.
  const templateArtwork = (value, owner) => {
    if (!state.artworkTemplate || value === undefined) return value;
    const copy = clone(value);
    const visit = (node, inherited) => {
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry, inherited);
        return;
      }
      if (!node || typeof node !== "object") return;
      const id = typeof node.id === "string" ? node.id : inherited;
      if (typeof node.artwork?.url === "string") {
        node.artwork.url = state.artworkTemplate.replace(
          "{id}",
          encodeURIComponent(id ?? "artwork"),
        );
      }
      for (const child of Object.values(node)) visit(child, id);
    };
    visit(copy, owner);
    return copy;
  };
  // A queue item also gets the top-level `artwork` that MusicKit's MediaItem
  // carries, which is where the app reads queue artwork from.
  const mediaItem = (id) => {
    const item = clone(resource(String(id)));
    if (!state.artworkTemplate || !item.attributes?.artwork) return item;
    const templated = templateArtwork(item, String(id));
    return { ...templated, artwork: clone(templated.attributes.artwork) };
  };
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

  // A playlist past the queue cap. "big-0001" is a catalog song Apple marks
  // unstreamable (no playParams), as removed songs appear in the API.
  const BIG_PLAYLIST_SIZE = 1200;
  const BIG_PAGE_SIZE = 300;
  const bigItems = Array.from({ length: BIG_PLAYLIST_SIZE }, (_, index) => {
    const id = `big-${String(index).padStart(4, "0")}`;
    const item = track(id, `Big Track ${index}`, "Big Album");
    if (index === 1) {
      item.type = "songs";
      delete item.attributes.playParams;
    }
    // Long text must truncate instead of widening rows.
    if (index === 2) {
      item.attributes.name = `${"A Very Long Song Title ".repeat(8)}(Remastered)`;
      item.attributes.albumName = `${"An Extremely Long Album Name ".repeat(8)}(Deluxe)`;
    }
    return item;
  });
  const bigPlaylist = {
    id: "playlist-big",
    type: "library-playlists",
    attributes: {
      name: "Big Playlist With A Very Long Name That Keeps Going To Test Truncation",
      artistName: "Arlet E2E",
      trackCount: BIG_PLAYLIST_SIZE,
      canEdit: true,
    },
  };
  const bigPlaylistPage = (path) => {
    const offset = Number(
      new URLSearchParams(String(path).split("?")[1] ?? "").get("offset") ?? 0,
    );
    const next = offset + BIG_PAGE_SIZE;
    return {
      data: bigItems.slice(offset, next).map(clone),
      ...(next < BIG_PLAYLIST_SIZE
        ? {
            next: `/v1/me/library/playlists/playlist-big/tracks?offset=${next}`,
          }
        : {}),
    };
  };

  // A catalog playlist of 30 songs, paged 25 at a time like Apple. Its ID is
  // used only here, so the seed lookups for other IDs are unchanged.
  const catalogPlaylistItems = Array.from({ length: 30 }, (_, index) => ({
    ...track(
      `pl-catalog-${String(index + 1).padStart(2, "0")}`,
      `Catalog Playlist Track ${index + 1}`,
      "Catalog Playlist Album",
    ),
    type: "songs",
  }));
  const catalogPlaylist = {
    id: "pl.catalog-fixture",
    type: "playlists",
    attributes: {
      name: "Catalog Fixture Playlist",
      curatorName: "Apple Music",
      trackCount: catalogPlaylistItems.length,
      playParams: { id: "pl.catalog-fixture", kind: "playlist" },
    },
  };
  // `next` names the following page with the same path and a new offset.
  const catalogTrackPage = (path) => {
    const [pathname, search = ""] = String(path).split("?");
    const offset = Number(new URLSearchParams(search).get("offset") ?? 0);
    const next = offset + 25;
    return {
      data: catalogPlaylistItems.slice(offset, next).map(clone),
      ...(next < catalogPlaylistItems.length
        ? { next: `${pathname}?offset=${next}` }
        : {}),
    };
  };
  // UI polish data (ids in the header comment). Shaped as Apple returns
  // catalog resources: notes and descriptions are `{ standard, short }` text.
  const polishTrack = (id, name, { disc, number, ms, url, album }) => ({
    id,
    type: "songs",
    attributes: {
      name,
      artistName: "Fixture Artist",
      albumName: album,
      ...(ms === undefined ? {} : { durationInMillis: ms }),
      ...(disc === undefined ? {} : { discNumber: disc }),
      trackNumber: number,
      ...(url ? { url } : {}),
      // Queue items get this at top level (where the app reads it) once
      // configure({ artworkTemplate }) is set; see mediaItem.
      artwork: polishArtwork(id),
      playParams: { id, kind: "song", catalogId: id },
    },
  });
  const polishArtwork = (id) => ({
    url: `https://is1-ssl.mzstatic.com/image/thumb/Music/e2e/${id}/{w}x{h}bb.jpg`,
    width: 1200,
    height: 1200,
    bgColor: "1c2b3a",
    textColor1: "f2f2f7",
    textColor2: "d1d1d6",
    textColor3: "aeaeb2",
    textColor4: "8e8e93",
  });
  const polishBloomTracks = [
    { id: "polish-bloom-blue", name: "Bloom Blue", bgColor: "0756d8" },
    { id: "polish-bloom-orange", name: "Bloom Orange", bgColor: "e84b08" },
    { id: "polish-bloom-dark", name: "Bloom Dark", bgColor: "17191e" },
    { id: "polish-bloom-pale", name: "Bloom Pale", bgColor: "f4ead7" },
  ].map(({ id, name, bgColor }, index) => {
    const item = polishTrack(id, name, {
      number: index + 1,
      album: "Now Playing Bloom Fixtures",
    });
    item.attributes.artwork = { ...polishArtwork(id), bgColor };
    return item;
  });
  const POLISH_ALBUM_SLUG = "polish-fixture-album";
  const polishAlbumTracks = [
    polishTrack("polish-d1-t1", "Polish Disc One Track One", {
      disc: 1,
      number: 1,
      ms: 215_000,
      album: "Polish Fixture Album",
      url: `https://music.apple.com/us/album/${POLISH_ALBUM_SLUG}/album-polish?i=polish-d1-t1`,
    }),
    polishTrack("polish-d1-t2", "Polish Disc One Track Two", {
      disc: 1,
      number: 2,
      ms: 187_000,
      album: "Polish Fixture Album",
      url: `https://music.apple.com/us/album/${POLISH_ALBUM_SLUG}/album-polish?i=polish-d1-t2`,
    }),
    polishTrack("polish-d2-t1", "Polish Disc Two Track One", {
      disc: 2,
      number: 1,
      ms: 240_000,
      album: "Polish Fixture Album",
      url: `https://music.apple.com/us/album/${POLISH_ALBUM_SLUG}/album-polish?i=polish-d2-t1`,
    }),
    polishTrack("polish-d2-t2", "Polish Disc Two Track Two", {
      disc: 2,
      number: 2,
      ms: 61_000,
      album: "Polish Fixture Album",
      url: `https://music.apple.com/us/album/${POLISH_ALBUM_SLUG}/album-polish?i=polish-d2-t2`,
    }),
  ];
  const polishAlbum = {
    id: "album-polish",
    type: "albums",
    attributes: {
      name: "Polish Fixture Album",
      artistName: "Fixture Artist",
      releaseDate: "2019-05-17",
      trackCount: polishAlbumTracks.length,
      genreNames: ["Alternative", "Rock"],
      recordLabel: "Fixture Records",
      copyright: "℗ 2019 Fixture Records",
      url: `https://music.apple.com/us/album/${POLISH_ALBUM_SLUG}/album-polish`,
      editorialNotes: {
        standard:
          "<i>Bold</i> & notes<br>line 2 <script>window.__ARLET_POLISH_XSS__ = true</script>",
        short: "Short <b>notes</b> & more",
      },
      artwork: polishArtwork("album-polish"),
      playParams: { id: "album-polish", kind: "album" },
    },
  };
  // No release date, genres, label, notes or durations: nothing may be invented.
  const polishSparseAlbum = {
    id: "album-polish-sparse",
    type: "albums",
    attributes: {
      name: "Polish Sparse Album",
      artistName: "Fixture Artist",
      trackCount: 1,
      playParams: { id: "album-polish-sparse", kind: "album" },
    },
  };
  const polishSparseTracks = [
    polishTrack("polish-sparse-t1", "Polish Sparse Track", {
      number: 1,
      album: "Polish Sparse Album",
    }),
  ];
  const polishAlbums = {
    "album-polish": { album: polishAlbum, tracks: polishAlbumTracks },
    "album-polish-sparse": {
      album: polishSparseAlbum,
      tracks: polishSparseTracks,
    },
  };
  const polishPlaylistTracks = [
    polishTrack("polish-pl-01", "Polish Playlist Track One", {
      number: 1,
      ms: 200_000,
      album: "Polish Playlist Album",
      url: "https://music.apple.com/us/album/polish-playlist-album/polish-pl-01",
    }),
    polishTrack("polish-pl-02", "Polish Playlist Track Two", {
      number: 1,
      ms: 185_000,
      album: "Polish Playlist Album",
      url: "https://music.apple.com/us/album/polish-playlist-album/polish-pl-02",
    }),
  ];
  const polishPlaylist = {
    id: "pl.polish-fixture",
    type: "playlists",
    attributes: {
      name: "Polish Fixture Playlist",
      curatorName: "Apple Music",
      trackCount: polishPlaylistTracks.length,
      description: {
        standard:
          'Plain <em>text</em> & a <img src="x" onerror="window.__ARLET_POLISH_XSS__ = true">',
        short: "Short note",
      },
      url: "https://music.apple.com/us/playlist/polish-fixture-playlist/pl.polish-fixture",
      artwork: polishArtwork("pl.polish-fixture"),
      playParams: { id: "pl.polish-fixture", kind: "playlist" },
    },
  };

  // Discovery data (ids in the header comment). Shaped as Apple returns
  // catalog resources; the routes below read only what the request asks for.
  const nonNegativeInt = (value) => {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const pagingOf = (params, fallbackLimit, cap) => {
    const requested = Math.floor(Number(params.limit));
    return {
      offset: nonNegativeInt(params.offset),
      limit:
        Number.isFinite(requested) && requested > 0
          ? Math.min(requested, cap)
          : fallbackLimit,
    };
  };
  const listParam = (value) =>
    String(value ?? "")
      .split(",")
      .filter(Boolean);
  // Query parameters from the path's own `?` and from the call. Extra keys
  // such as `l=` or `limit` are simply ignored by the routes that do not use
  // them.
  const requestParams = (path, call = {}) => ({
    ...Object.fromEntries(
      new URLSearchParams(String(path).split("?")[1] ?? ""),
    ),
    ...Object.fromEntries(
      Object.entries(call?.query ?? {}).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
  });
  // Pages a list the way Apple does: `next` repeats the path with the next
  // offset. With repeatViewCursor set, each page after the first points back
  // at itself, so following `next` never reaches the end.
  const pageResponse = (items, base, params, offset, limit) => {
    const following = offset + limit;
    const more = state.repeatViewCursor ? offset > 0 : following < items.length;
    const target = state.repeatViewCursor && offset > 0 ? offset : following;
    const query = new URLSearchParams({
      ...params,
      offset: String(target),
      limit: String(limit),
    });
    return {
      data: items.slice(offset, following).map(clone),
      ...(more ? { next: `${base}?${query}` } : {}),
    };
  };

  const discoveryTrack = (id, name, album, number) => ({
    id,
    type: "songs",
    attributes: {
      name,
      artistName: "Discovery Artist",
      albumName: album,
      durationInMillis: 200_000,
      trackNumber: number,
      playParams: { id, kind: "song", catalogId: id },
    },
  });
  const discoveryAlbum = (id, name, attributes = {}) => ({
    id,
    type: "albums",
    attributes: {
      name,
      artistName: "Discovery Artist",
      releaseDate: "2020-01-01",
      trackCount: 1,
      playParams: { id, kind: "album" },
      ...attributes,
    },
  });
  const discoveryArtistResource = (id, name) => ({
    id,
    type: "artists",
    attributes: { name },
  });

  const discoverAlbumTracks = [1, 2, 3, 4].map((number) =>
    discoveryTrack(
      `discover-album-t${number}`,
      `Discovery Album Track ${number}`,
      "Fixture Discovery Album",
      number,
    ),
  );
  const discoverAlbum = discoveryAlbum(
    "album-discover",
    "Fixture Discovery Album",
    {
      releaseDate: "2021-03-05",
      trackCount: 4,
      url: "https://music.apple.com/us/album/fixture-discovery-album/album-discover",
    },
  );
  // Shelves on the album page. more-by-artist is empty on purpose.
  const DISCOVERY_ALBUM_VIEWS = {
    "other-versions": [
      discoveryAlbum(
        "album-discover-deluxe",
        "Fixture Discovery Album (Deluxe)",
      ),
    ],
    "related-albums": [1, 2, 3].map((number) =>
      discoveryAlbum(
        `album-discover-related-${number}`,
        `Related Discovery Album ${number}`,
      ),
    ),
    "more-by-artist": [],
  };

  const artistAlbums = Array.from({ length: 30 }, (_, index) =>
    discoveryAlbum(
      `artist-views-album-${String(index + 1).padStart(2, "0")}`,
      `Artist Views Album ${index + 1}`,
      { releaseDate: `${1995 + index}-06-01` },
    ),
  );
  const artistTopSongs = Array.from({ length: 8 }, (_, index) =>
    discoveryTrack(
      `artist-views-song-${index + 1}`,
      `Artist Views Song ${index + 1}`,
      "Artist Views Top Songs",
      index + 1,
    ),
  );
  const sparseTopSongs = [
    discoveryTrack("sparse-song-1", "Sparse Song One", "Sparse Album", 1),
    discoveryTrack("sparse-song-2", "Sparse Song Two", "Sparse Album", 2),
  ];
  const sparseAlbums = [
    discoveryAlbum("sparse-album-1", "Sparse Album One"),
    discoveryAlbum("sparse-album-2", "Sparse Album Two"),
  ];

  // Playlists that catalog curators and the featured shelves point at.
  const discoveryPlaylists = {
    "pl.discovery-curated-1": {
      name: "Discovery Mix One",
      curator: { id: "cur.discovery-fixture", type: "curators" },
    },
    "pl.discovery-curated-2": {
      name: "Discovery Mix Two",
      curator: { id: "cur.discovery-fixture", type: "curators" },
    },
    "pl.discovery-apple-1": {
      name: "Discovery Editors Pick",
      curator: { id: "apple.discovery-fixture", type: "apple-curators" },
      curatorName: "Apple Discovery Editors",
    },
    "pl.discovery-featured-1": {
      name: "Discovery Featured One",
      curator: { id: "cur.discovery-fixture", type: "curators" },
    },
    "pl.discovery-featured-2": {
      name: "Discovery Featured Two",
      curator: { id: "apple.discovery-fixture", type: "apple-curators" },
      curatorName: "Apple Discovery Editors",
    },
  };
  const discoveryPlaylistTracks = (id) =>
    [1, 2].map((number) =>
      discoveryTrack(
        `${id}-t${number}`,
        `${discoveryPlaylists[id].name} Track ${number}`,
        discoveryPlaylists[id].name,
        number,
      ),
    );
  const discoveryPlaylistResource = (id) => ({
    id,
    type: "playlists",
    attributes: {
      name: discoveryPlaylists[id].name,
      curatorName: discoveryPlaylists[id].curatorName ?? "Discovery Curator",
      trackCount: 2,
      playParams: { id, kind: "playlist" },
    },
  });
  const playlistRef = (id) => ({ id, type: "playlists" });

  // Artwork sizing data (scripts/e2e-artwork.js; docs/TESTING.md "Artwork
  // sizing"). Served only after configure({ artworkGrid: true }), so no other
  // suite sees it. Titles run from one letter to very long, so a card that
  // sized to its title would show it. Artwork URLs carry `{id}` and load only
  // with configure({ artworkTemplate }).
  const ARTWORK_LONG_TITLE =
    "An Extraordinarily Long Title That Keeps Going Well Past Any Card Width";
  const artworkAt = (id) => ({
    url: `https://is1-ssl.mzstatic.com/image/thumb/Music/e2e/${id}/{w}x{h}bb.jpg`,
    width: 300,
    height: 300,
  });
  const artworkAlbum = (
    id,
    name,
    { artwork = true, type = "library-albums" } = {},
  ) => ({
    id,
    type,
    attributes: {
      name,
      artistName: "Artwork Fixture",
      trackCount: 10,
      playParams: { id, kind: "album" },
      ...(artwork ? { artwork: artworkAt(id) } : {}),
    },
  });
  const artworkPlaylist = (
    id,
    name,
    { artwork = true, type = "library-playlists" } = {},
  ) => ({
    id,
    type,
    attributes: {
      name,
      artistName: "Artwork Fixture",
      canEdit: false,
      playParams: { id, kind: "playlist" },
      ...(artwork ? { artwork: artworkAt(id) } : {}),
    },
  });
  // Library albums and playlists; the bare album has no artwork at all.
  const ARTWORK_ALBUMS = [
    artworkAlbum("lib-album-art-1", "Hi"),
    artworkAlbum("lib-album-art-2", "Second Album Title"),
    artworkAlbum("lib-album-art-3", ARTWORK_LONG_TITLE),
    artworkAlbum("lib-album-art-4", "X"),
    artworkAlbum("lib-album-bare", "Quiet Sleeve", { artwork: false }),
  ];
  const ARTWORK_PLAYLISTS = [
    artworkPlaylist("lib-pl-art-1", "Mix"),
    artworkPlaylist("lib-pl-art-2", "Playlist Of Medium Length"),
    artworkPlaylist("lib-pl-art-3", ARTWORK_LONG_TITLE),
    artworkPlaylist("lib-pl-art-4", "Q"),
  ];
  // Library artists have no artwork of their own. Their catalog artist does,
  // under relationships.catalog, and only when the request asks include=catalog.
  // catalogId null: no catalog artist, so the tile has no picture at all.
  const ARTWORK_ARTISTS = [
    {
      id: "lib-artist-art-1",
      name: "Art Artist",
      catalogId: "cat-artist-art-1",
    },
    { id: "lib-artist-art-2", name: "Al", catalogId: "cat-artist-art-2" },
    {
      id: "lib-artist-art-3",
      name: ARTWORK_LONG_TITLE,
      catalogId: "cat-artist-art-3",
    },
    { id: "lib-artist-bare", name: "Quiet Artist", catalogId: null },
  ];
  const artworkLibraryArtist = (entry, include) => ({
    id: entry.id,
    type: "library-artists",
    attributes: { name: entry.name },
    ...(entry.catalogId && include.includes("catalog")
      ? {
          relationships: {
            catalog: {
              data: [
                {
                  id: entry.catalogId,
                  type: "artists",
                  attributes: {
                    name: entry.name,
                    artwork: artworkAt(entry.catalogId),
                  },
                },
              ],
            },
          },
        }
      : {}),
  });
  // Home's heavy rotation: catalog albums and playlists, short and long titles.
  const ARTWORK_HOME = [
    artworkAlbum("home-art-1", "Hi", { type: "albums" }),
    artworkAlbum("home-art-2", ARTWORK_LONG_TITLE, { type: "albums" }),
    artworkPlaylist("home-art-3", "Mix", { type: "playlists" }),
    artworkPlaylist("home-art-4", "Playlist Of Medium Length", {
      type: "playlists",
    }),
  ];
  // Radio's personal stations; the last has no URL on purpose, so its Play is disabled.
  const ARTWORK_STATIONS = [
    {
      id: "ra.art-1",
      type: "stations",
      attributes: {
        name: "FM",
        url: "https://music.apple.com/us/station/art-fm/ra.art-1",
        artwork: artworkAt("ra.art-1"),
      },
    },
    {
      id: "ra.art-2",
      type: "stations",
      attributes: {
        name: ARTWORK_LONG_TITLE,
        url: "https://music.apple.com/us/station/art-long/ra.art-2",
        artwork: artworkAt("ra.art-2"),
      },
    },
    {
      id: "ra.art-3",
      type: "stations",
      attributes: { name: "Pop", artwork: artworkAt("ra.art-3") },
    },
  ];
  // Search for a term containing "artwork": top result, albums, playlists, stations.
  const ARTWORK_SEARCH = {
    albums: ARTWORK_ALBUMS.map((item) => ({ ...item, type: "albums" })),
    playlists: ARTWORK_PLAYLISTS.map((item) => ({
      ...item,
      type: "playlists",
    })),
    stations: ARTWORK_STATIONS,
  };
  // The library artist lib-artist-art-1 reads its catalog artist, cat-artist-art-1.
  const ARTIST_ARTWORK = { "cat-artist-art-1": artworkAt("cat-artist-art-1") };
  const ARTIST_ARTWORK_VIEWS = {
    "full-albums": [
      artworkAlbum("cat-album-art-1", "Hi", { type: "albums" }),
      artworkAlbum("cat-album-art-2", ARTWORK_LONG_TITLE, { type: "albums" }),
      artworkAlbum("cat-album-art-3", "Ok", { type: "albums" }),
    ],
    "similar-artists": [
      {
        id: "cat-similar-art-1",
        type: "artists",
        attributes: { name: "Al", artwork: artworkAt("cat-similar-art-1") },
      },
      {
        id: "cat-similar-art-2",
        type: "artists",
        attributes: {
          name: ARTWORK_LONG_TITLE,
          artwork: artworkAt("cat-similar-art-2"),
        },
      },
      {
        id: "cat-similar-art-3",
        type: "artists",
        attributes: { name: "Quiet Artist" },
      },
    ],
    "featured-playlists": [
      artworkPlaylist("cat-pl-art-1", "Mix", { type: "playlists" }),
      artworkPlaylist("cat-pl-art-2", ARTWORK_LONG_TITLE, {
        type: "playlists",
      }),
    ],
  };

  // Artist views by artist ID. Requested views that are absent from an
  // artist's entry answer as { data: [] }.
  const ARTIST_VIEWS = {
    "cat-artist-art-1": ARTIST_ARTWORK_VIEWS,
    "artist-views": {
      "latest-release": [artistAlbums[29]],
      "top-songs": artistTopSongs,
      "full-albums": artistAlbums,
      singles: [1, 2, 3].map((number) =>
        discoveryAlbum(
          `artist-views-single-${number}`,
          `Artist Views Single ${number}`,
          {
            isSingle: true,
            trackCount: 1,
          },
        ),
      ),
      "live-albums": [
        discoveryAlbum("artist-views-live-1", "Artist Views Live Album"),
      ],
      "compilation-albums": [1, 2].map((number) =>
        discoveryAlbum(
          `artist-views-comp-${number}`,
          `Artist Views Compilation ${number}`,
        ),
      ),
      "appears-on-albums": [
        discoveryAlbum("artist-views-appears-1", "Artist Views Appears On"),
      ],
      "similar-artists": [1, 2, 3].map((number) =>
        discoveryArtistResource(
          `artist-views-similar-${number}`,
          `Similar Artist ${number}`,
        ),
      ),
      "featured-playlists": [
        discoveryPlaylistResource("pl.discovery-featured-1"),
        discoveryPlaylistResource("pl.discovery-featured-2"),
      ],
    },
    "artist-views-sparse": {
      "top-songs": sparseTopSongs,
      "full-albums": sparseAlbums,
    },
  };
  const DISCOVERY_ARTIST_NAMES = {
    "cat-artist-art-1": "Art Artist",
    "artist-views": "Discovery Artist",
    "artist-views-sparse": "Sparse Discovery Artist",
  };
  const ARTIST_NOTES = {
    "artist-views": {
      standard:
        'Bio with <b>markup</b> and <a href="https://example.invalid">a link</a><script>window.__ARLET_DISCOVERY_XSS__ = true</script>',
      short: "Short <i>bio</i>",
    },
  };
  const ARTIST_BANNERS = {
    "artist-views": {
      bannerUber: {
        url: "https://is1-ssl.mzstatic.com/image/thumb/Music/e2e/artist-views/{w}x{h}bb.jpg",
        width: 3000,
        height: 1000,
      },
    },
  };
  // Views sent inline with the artist; the rest of a view comes by `next`.
  const INLINE_VIEW_LIMIT = { "top-songs": 5, "full-albums": 25 };

  // Curators by ID; the type must match the route (curators or apple-curators).
  const discoveryCurators = {
    "cur.discovery-fixture": {
      type: "curators",
      name: "Discovery Curator",
      playlists: [
        "pl.discovery-curated-1",
        "pl.discovery-curated-2",
        "pl.discovery-featured-1",
      ],
      groups: [
        {
          id: "discovery-group-new",
          name: "New Mixes",
          playlists: ["pl.discovery-curated-1", "pl.discovery-curated-2"],
        },
        {
          id: "discovery-group-featured",
          name: "Featured",
          playlists: ["pl.discovery-featured-1"],
        },
      ],
    },
    "apple.discovery-fixture": {
      type: "apple-curators",
      name: "Apple Discovery Editors",
      playlists: ["pl.discovery-apple-1", "pl.discovery-featured-2"],
      groups: [
        {
          id: "discovery-group-editors",
          name: "Editors' Picks",
          playlists: ["pl.discovery-apple-1"],
        },
      ],
    },
  };

  const DISCOVERY_STATION_URL = (slug, id) =>
    `https://music.apple.com/us/station/${slug}/${id}`;
  const discoveryStation = (id, name, url) => ({
    id,
    type: "stations",
    attributes: { name, ...(url ? { url } : {}) },
  });
  const STATION_GENRES = [
    { id: "sg-pop", type: "station-genres", attributes: { name: "Pop" } },
    { id: "sg-rock", type: "station-genres", attributes: { name: "Rock" } },
  ];
  const DISCOVERY_STATIONS = {
    "sg-pop": [
      discoveryStation(
        "ra.genre-pop-1",
        "Pop Station One",
        DISCOVERY_STATION_URL("pop-station-one", "ra.genre-pop-1"),
      ),
      discoveryStation("ra.genre-pop-2", "Pop Station Two"),
    ],
    "sg-rock": [
      discoveryStation(
        "ra.genre-rock-1",
        "Rock Station One",
        DISCOVERY_STATION_URL("rock-station-one", "ra.genre-rock-1"),
      ),
    ],
  };
  const SEARCH_STATIONS = [
    discoveryStation(
      "ra.discover-station-1",
      "Discovery Station One",
      DISCOVERY_STATION_URL("discovery-station-one", "ra.discover-station-1"),
    ),
  ];

  const GENRES = [
    { id: "14", type: "genres", attributes: { name: "Pop" } },
    { id: "20", type: "genres", attributes: { name: "Alternative" } },
    { id: "21", type: "genres", attributes: { name: "Rock" } },
    { id: "7", type: "genres", attributes: { name: "Electronic" } },
  ];
  const chartSongs = (prefix, label, count) =>
    Array.from({ length: count }, (_, index) =>
      discoveryTrack(
        `${prefix}-${String(index + 1).padStart(2, "0")}`,
        `${label} ${index + 1}`,
        `${label} Album`,
        index + 1,
      ),
    );
  // Charts by genre ID ("" = no genre). A missing key is a shelf Apple left
  // out of the response. City and daily charts hold playlists, as Apple sends.
  const CHARTS = {
    "": {
      songs: chartSongs("chart-song", "Chart Song", 30),
      albums: [1, 2, 3].map((number) =>
        discoveryAlbum(`chart-album-${number}`, `Chart Album ${number}`),
      ),
      playlists: [
        "pl.discovery-curated-1",
        "pl.discovery-curated-2",
        "pl.discovery-apple-1",
        "pl.discovery-featured-1",
        "pl.discovery-featured-2",
      ],
      cityCharts: ["pl.discovery-curated-1", "pl.discovery-featured-1"],
      dailyGlobalTopCharts: ["pl.discovery-apple-1", "pl.discovery-featured-2"],
    },
    14: {
      songs: chartSongs("pop-chart", "Pop Chart Song", 12),
      albums: [1, 2].map((number) =>
        discoveryAlbum(`pop-album-${number}`, `Pop Album ${number}`),
      ),
      cityCharts: ["pl.discovery-curated-2"],
      dailyGlobalTopCharts: ["pl.discovery-curated-1"],
    },
    21: {
      songs: chartSongs("rock-chart", "Rock Chart Song", 3),
    },
  };

  // Search results by Apple type. Each list pages at the request's offset.
  const SEARCH_RESULTS = {
    songs: Array.from({ length: 12 }, (_, index) =>
      discoveryTrack(
        `search-song-${String(index + 1).padStart(2, "0")}`,
        `Discovery Search Song ${index + 1}`,
        "Discovery Search Album",
        index + 1,
      ),
    ),
    albums: Array.from({ length: 60 }, (_, index) =>
      discoveryAlbum(
        `discovery-album-${String(index + 1).padStart(2, "0")}`,
        `Discovery Search Album ${index + 1}`,
      ),
    ),
    artists: [1, 2, 3].map((number) =>
      discoveryArtistResource(
        `discovery-artist-${number}`,
        `Discovery Artist ${number}`,
      ),
    ),
    playlists: [
      "pl.discovery-curated-1",
      "pl.discovery-curated-2",
      "pl.discovery-apple-1",
      "pl.discovery-featured-1",
      "pl.discovery-featured-2",
    ].map((id) => discoveryPlaylistResource(id)),
    stations: SEARCH_STATIONS,
    "apple-curators": [
      {
        id: "apple.discovery-fixture",
        type: "apple-curators",
        attributes: { name: "Apple Discovery Editors" },
      },
    ],
  };

  // Home lists. Recent played pages 4 at a time, so `next` is followed once.
  const RECENT_PLAYED = [
    discoverAlbum,
    discoveryStation(
      "ra.discover-station-1",
      "Discovery Station One",
      DISCOVERY_STATION_URL("discovery-station-one", "ra.discover-station-1"),
    ),
    discoveryPlaylistResource("pl.discovery-curated-1"),
    discoveryAlbum("recent-album-1", "Recent Album One"),
    discoveryStation(
      "ra.genre-rock-1",
      "Rock Station One",
      DISCOVERY_STATION_URL("rock-station-one", "ra.genre-rock-1"),
    ),
    discoveryAlbum("recent-album-2", "Recent Album Two"),
  ];
  // Heavy rotation is unfiltered: albums, stations and playlists together.
  const HEAVY_ROTATION = [
    clone(discoverAlbum),
    discoveryStation(
      "ra.genre-pop-1",
      "Pop Station One",
      DISCOVERY_STATION_URL("pop-station-one", "ra.genre-pop-1"),
    ),
    discoveryPlaylistResource("pl.discovery-featured-1"),
    discoveryAlbum("heavy-album-2", "Heavy Rotation Album"),
  ];
  // Groups carry their contents inline. The nested group becomes its own shelf.
  const RECOMMENDATIONS = [
    {
      id: "rec-discover-albums",
      type: "personal-recommendation",
      attributes: { title: { stringForDisplay: "Discovery Albums" } },
      relationships: {
        contents: {
          data: [
            clone(discoverAlbum),
            discoveryAlbum("rec-album-2", "Recommended Album Two"),
          ],
        },
      },
    },
    {
      id: "rec-discover-mixed",
      type: "personal-recommendation",
      attributes: { title: { stringForDisplay: "Mixed Picks" } },
      relationships: {
        contents: {
          data: [
            discoveryStation(
              "ra.discover-station-1",
              "Discovery Station One",
              DISCOVERY_STATION_URL(
                "discovery-station-one",
                "ra.discover-station-1",
              ),
            ),
            discoveryPlaylistResource("pl.discovery-curated-1"),
            {
              id: "rec-discover-nested",
              type: "personal-recommendation",
              attributes: { title: { stringForDisplay: "Nested Picks" } },
              relationships: {
                contents: {
                  data: [discoveryAlbum("rec-album-3", "Nested Album Three")],
                },
              },
            },
          ],
        },
      },
    },
  ];

  // Suggestion terms and top results by prefix; each term is [search, display].
  const SUGGESTIONS = {
    pol: {
      terms: [
        ["polish fixture", "Polish Fixture"],
        ["polka", "Polka"],
      ],
      topResults: [polishAlbum],
    },
    fix: {
      terms: [
        ["fixture discovery", "Fixture Discovery"],
        ["fixture", "Fixture"],
      ],
      topResults: [discoverAlbum],
    },
  };

  // Every discovery track, so queued items get their names.
  const discoveryTrackItems = [
    libraryDiscoverySong,
    ...discoverAlbumTracks,
    ...artistTopSongs,
    ...sparseTopSongs,
    ...Object.keys(discoveryPlaylists).flatMap(discoveryPlaylistTracks),
  ];

  const artistResponse = (id, params) => {
    const attributes = { name: DISCOVERY_ARTIST_NAMES[id] };
    if (ARTIST_ARTWORK[id]) attributes.artwork = clone(ARTIST_ARTWORK[id]);
    const extend = listParam(params.extend);
    if (extend.includes("editorialNotes") && ARTIST_NOTES[id]) {
      attributes.editorialNotes = clone(ARTIST_NOTES[id]);
    }
    if (extend.includes("editorialArtwork") && ARTIST_BANNERS[id]) {
      attributes.editorialArtwork = clone(ARTIST_BANNERS[id]);
    }
    const resource = { id, type: "artists", attributes };
    const views = listParam(params.views);
    if (views.length) {
      resource.views = Object.fromEntries(
        views.map((name) => [
          name,
          pageResponse(
            ARTIST_VIEWS[id][name] ?? [],
            `/v1/catalog/us/artists/${id}/view/${name}`,
            {},
            0,
            INLINE_VIEW_LIMIT[name] ?? 25,
          ),
        ]),
      );
    }
    return { data: [resource] };
  };
  const albumResponse = (params) => {
    const resource = clone(discoverAlbum);
    if (listParam(params.include).includes("tracks")) {
      resource.relationships = {
        tracks: { data: discoverAlbumTracks.map(clone) },
      };
    }
    const views = listParam(params.views);
    if (views.length) {
      resource.views = Object.fromEntries(
        views.map((name) => [
          name,
          pageResponse(
            DISCOVERY_ALBUM_VIEWS[name] ?? [],
            `/v1/catalog/us/albums/album-discover/view/${name}`,
            {},
            0,
            25,
          ),
        ]),
      );
    }
    return { data: [resource] };
  };
  const playlistResponse = (id, params) => {
    const resource = discoveryPlaylistResource(id);
    const include = listParam(params.include);
    const relationships = {};
    if (include.includes("curator") || include.includes("curators")) {
      relationships.curator = {
        data: [clone(discoveryPlaylists[id].curator)],
      };
    }
    if (include.includes("tracks")) {
      relationships.tracks = { data: discoveryPlaylistTracks(id).map(clone) };
    }
    if (Object.keys(relationships).length)
      resource.relationships = relationships;
    return { data: [resource] };
  };
  const curatorResponse = (curator, id, params) => {
    const resource = {
      id,
      type: curator.type,
      attributes: { name: curator.name, artwork: polishArtwork(id) },
    };
    const include = listParam(params.include);
    if (include.includes("playlists")) {
      resource.relationships = {
        playlists: { data: curator.playlists.map(playlistRef) },
      };
    }
    const views = listParam(params.views);
    if (views.length) {
      resource.views = Object.fromEntries(
        views.map((name) => [
          name,
          {
            data:
              name === "grouped-playlists"
                ? curator.groups.map((group) => ({
                    id: group.id,
                    type: "playlist-groups",
                    attributes: { name: group.name },
                    relationships: {
                      playlists: { data: group.playlists.map(playlistRef) },
                    },
                  }))
                : [],
          },
        ]),
      );
    }
    return { data: [resource] };
  };
  const chartsResponse = (params) => {
    const genre = CHARTS[params.genre ?? ""] ?? {};
    const withList = listParam(params.with);
    const types = listParam(params.types);
    const wanted = (type) => types.length === 0 || types.includes(type);
    const { offset, limit } = pagingOf(params, 25, 100);
    const results = {};
    // Only the most-played songs page; each shelf follows its own `next`.
    if (genre.songs && wanted("songs")) {
      results.songs = [
        {
          chart: "most-played",
          name: "Top Songs",
          ...pageResponse(
            genre.songs,
            "/v1/catalog/us/charts",
            params,
            offset,
            limit,
          ),
        },
      ];
    }
    if (genre.albums && wanted("albums")) {
      results.albums = [
        {
          chart: "most-played",
          name: "Top Albums",
          data: genre.albums.map(clone),
        },
      ];
    }
    if (genre.playlists && wanted("playlists")) {
      results.playlists = [
        {
          chart: "most-played",
          name: "Top Playlists",
          data: genre.playlists.map((id) => discoveryPlaylistResource(id)),
        },
      ];
    }
    // Playlist charts sit beside the songs, and only when the request asks.
    if (genre.cityCharts && withList.includes("cityCharts")) {
      results.cityCharts = [
        {
          chart: "city-charts",
          name: "City Charts",
          data: genre.cityCharts.map((id) => discoveryPlaylistResource(id)),
        },
      ];
    }
    if (
      genre.dailyGlobalTopCharts &&
      withList.includes("dailyGlobalTopCharts")
    ) {
      results.dailyGlobalTopCharts = [
        {
          chart: "daily-global-top-charts",
          name: "Daily Top 100",
          data: genre.dailyGlobalTopCharts.map((id) =>
            discoveryPlaylistResource(id),
          ),
        },
      ];
    }
    return { results };
  };
  const searchResponse = (params) => {
    const { offset, limit } = pagingOf(params, 10, 25);
    const results = {};
    if (listParam(params.with).includes("topResults")) {
      results.top = {
        data: [
          clone(discoverAlbum),
          discoveryArtistResource("artist-views", "Discovery Artist"),
          discoveryPlaylistResource("pl.discovery-featured-1"),
        ],
      };
    }
    const types = listParam(params.types);
    for (const type of types.length ? types : ["albums"]) {
      if (!Object.hasOwn(SEARCH_RESULTS, type)) continue;
      results[type] = pageResponse(
        SEARCH_RESULTS[type],
        "/v1/catalog/us/search",
        params,
        offset,
        limit,
      );
    }
    return { results };
  };
  const suggestionsResponse = (params) => {
    const term = String(params.term ?? "")
      .trim()
      .toLowerCase();
    const prefix = Object.keys(SUGGESTIONS).find((key) => term.startsWith(key));
    const entry = prefix ? SUGGESTIONS[prefix] : undefined;
    const { limit } = pagingOf({ limit: params.limit }, 10, 25);
    const suggestions = entry
      ? [
          ...entry.terms.map(([searchTerm, displayTerm]) => ({
            kind: "terms",
            searchTerm,
            displayTerm,
          })),
          ...entry.topResults.map((content) => ({
            kind: "topResults",
            content: clone(content),
          })),
        ]
      : [];
    return { results: { suggestions: suggestions.slice(0, limit) } };
  };

  // Routes for the discovery ids. Undefined means "not a discovery route", so
  // the existing handlers answer it as before.
  const discoveryResponse = (pathname, path, call) => {
    const params = requestParams(path, call);
    if (pathname === "/v1/catalog/us/genres") {
      return { data: GENRES.map(clone) };
    }
    if (pathname === "/v1/catalog/us/station-genres") {
      return { data: STATION_GENRES.map(clone) };
    }
    const stationRoute = pathname.match(
      /^\/v1\/catalog\/us\/station-genres\/([^/]+)\/stations$/u,
    );
    if (stationRoute) {
      return { data: (DISCOVERY_STATIONS[stationRoute[1]] ?? []).map(clone) };
    }
    if (pathname === "/v1/catalog/us/playlists" && params.ids !== undefined) {
      const ids = listParam(params.ids);
      // Discovery ids resolve here; the catalog and polish playlists resolve
      // as before. Ids nothing answers are skipped, in request order.
      if (ids.some((id) => Object.hasOwn(discoveryPlaylists, id))) {
        const known = [catalogPlaylist, polishPlaylist];
        return {
          data: ids.flatMap((id) => {
            if (Object.hasOwn(discoveryPlaylists, id)) {
              return [discoveryPlaylistResource(id)];
            }
            const match = known.find((entry) => entry.id === id);
            return match ? [clone(match)] : [];
          }),
        };
      }
    }
    if (pathname === "/v1/me/library/artists/library-artist-views") {
      return {
        data: [
          {
            id: "library-artist-views",
            type: "library-artists",
            attributes: { name: "Discovery Artist" },
            relationships: {
              catalog: {
                data: [
                  discoveryArtistResource("artist-views", "Discovery Artist"),
                ],
              },
            },
          },
        ],
      };
    }
    if (pathname === "/v1/me/library/albums/library-album-discover") {
      return {
        data: [
          {
            id: "library-album-discover",
            type: "library-albums",
            attributes: {
              name: "Fixture Discovery Album",
              artistName: "Discovery Artist",
              trackCount: 4,
            },
            relationships: {
              tracks: { data: discoverAlbumTracks.map(clone) },
              catalog: { data: [{ id: "album-discover", type: "albums" }] },
            },
          },
        ],
      };
    }
    if (
      pathname === "/v1/me/library/search" &&
      /discovery/iu.test(String(params.term ?? ""))
    ) {
      return {
        results: {
          "library-songs": { data: [clone(libraryDiscoverySong)] },
        },
      };
    }
    if (pathname === "/v1/me/recent/played") {
      const { offset } = pagingOf(params, 10, 10);
      return pageResponse(
        RECENT_PLAYED,
        "/v1/me/recent/played",
        {
          types: params.types ?? "albums,playlists,library-playlists,stations",
          limit: params.limit ?? "10",
        },
        offset,
        4,
      );
    }
    if (pathname === "/v1/me/history/heavy-rotation") {
      return { data: HEAVY_ROTATION.map(clone) };
    }
    if (pathname === "/v1/me/recommendations") {
      return { data: RECOMMENDATIONS.map(clone) };
    }
    if (pathname === "/v1/catalog/us/charts") return chartsResponse(params);
    if (pathname === "/v1/catalog/us/search/suggestions") {
      return suggestionsResponse(params);
    }
    if (
      pathname === "/v1/catalog/us/search" &&
      /discovery/iu.test(String(params.term ?? ""))
    ) {
      return searchResponse(params);
    }
    const artistRoute = pathname.match(
      /^\/v1\/catalog\/us\/artists\/([^/]+)(?:\/(albums)|\/view\/([^/]+))?$/u,
    );
    if (artistRoute && Object.hasOwn(ARTIST_VIEWS, artistRoute[1])) {
      const [, id, albums, view] = artistRoute;
      const paging = pagingOf(params, 25, 100);
      if (albums) {
        return pageResponse(
          ARTIST_VIEWS[id]["full-albums"] ?? [],
          `/v1/catalog/us/artists/${id}/albums`,
          {},
          paging.offset,
          paging.limit,
        );
      }
      if (view) {
        return pageResponse(
          ARTIST_VIEWS[id][view] ?? [],
          `/v1/catalog/us/artists/${id}/view/${view}`,
          {},
          paging.offset,
          paging.limit,
        );
      }
      return artistResponse(id, params);
    }
    if (pathname === "/v1/catalog/us/albums/album-discover") {
      return albumResponse(params);
    }
    if (pathname === "/v1/catalog/us/albums/album-discover/tracks") {
      return { data: discoverAlbumTracks.map(clone) };
    }
    const playlistRoute = pathname.match(
      /^\/v1\/catalog\/us\/playlists\/([^/]+)(\/tracks)?$/u,
    );
    if (playlistRoute && Object.hasOwn(discoveryPlaylists, playlistRoute[1])) {
      return playlistRoute[2]
        ? { data: discoveryPlaylistTracks(playlistRoute[1]).map(clone) }
        : playlistResponse(playlistRoute[1], params);
    }
    const curatorRoute = pathname.match(
      /^\/v1\/catalog\/us\/(curators|apple-curators)\/([^/]+)$/u,
    );
    if (curatorRoute && Object.hasOwn(discoveryCurators, curatorRoute[2])) {
      const curator = discoveryCurators[curatorRoute[2]];
      if (curator.type !== curatorRoute[1]) return { data: [] };
      return curatorResponse(curator, curatorRoute[2], params);
    }
    return undefined;
  };

  // Detail paths whose `include=tracks` form carries the first track page.
  const TRACK_DETAIL_PATHS = new Set([
    "/v1/me/library/albums/album-1",
    "/v1/me/library/playlists/playlist-1",
    "/v1/me/library/playlists/playlist-big",
    "/v1/catalog/us/playlists/pl.catalog-fixture",
    "/v1/catalog/us/albums/album-polish",
    "/v1/catalog/us/albums/album-polish-sparse",
    "/v1/catalog/us/playlists/pl.polish-fixture",
  ]);
  // Batched `?ids=` lookups; the library and catalog roots are separate.
  const BATCH_PLAYLIST_PATHS = new Set([
    "/v1/me/library/playlists",
    "/v1/catalog/us/playlists",
  ]);

  const itemResponse = (item) => ({ data: [clone(item)] });

  // Generated library for the large-library scenario. Names and IDs depend
  // only on the index, so a run is repeatable. Artwork uses the mzstatic
  // template; the URLs never load in the test, only their src is read.
  const LIBRARY_PAGE_SIZE = 25;
  // Apple caps a library page at 100 items.
  const LIBRARY_MAX_PAGE_SIZE = 100;
  const DAY_MS = 86_400_000;
  // Cycles through 37 days, so many items tie; every 7th item has no dateAdded.
  const dateAddedFor = (index) =>
    index % 7 === 6
      ? undefined
      : new Date(
          Date.UTC(2024, 0, 1) + ((index * 17) % 37) * DAY_MS,
        ).toISOString();
  // "Écho" and "echo" tie under base collation; their order is Apple order.
  const libraryAlbumName = (index) => {
    if (index % 50 === 4) return "Écho";
    if (index % 50 === 9) return "echo";
    return `Library Album ${index + 1}`;
  };
  const libraryItem = (type, index) => {
    const id = `lib-${type}-${String(index).padStart(5, "0")}`;
    const album = type === "library-albums";
    const dateAdded = dateAddedFor(index);
    return {
      id,
      type,
      attributes: {
        name: album ? libraryAlbumName(index) : `Library Artist ${index + 1}`,
        artistName: `Library Artist ${(index % 50) + 1}`,
        ...(album ? { trackCount: 10 } : {}),
        ...(album && index % 5 === 0 ? { contentRating: "explicit" } : {}),
        ...(dateAdded ? { dateAdded } : {}),
        artwork: {
          url: `https://is1-ssl.mzstatic.com/image/thumb/Music/e2e/${id}/{w}x{h}bb.jpg`,
          width: 300,
          height: 300,
        },
      },
    };
  };
  // configure({ libraryView: true }) data. Songs page 100 then 20; Apple's
  // flat playlist list is in this order, and the folder holds lv-pl-01 and -06.
  const LIBRARY_SONG_COUNT = 120;
  const LIBRARY_SONG_ALBUMS = [
    "Harbor Lights",
    "Night Cargo",
    "Paper Moons",
    "Quiet Engine",
    "Glass Orchard",
    "Lantern Road",
  ];
  const LIBRARY_SONG_ARTISTS = [
    "Mira Vale",
    "Kenji Holt",
    "Ada Ruiz",
    "Tom Ostrander",
  ];
  const librarySong = (index) => {
    const item = track(
      `lv-song-${String(index).padStart(5, "0")}`,
      index % 40 === 7 ? `Écho Song ${index + 1}` : `Song ${index + 1}`,
      LIBRARY_SONG_ALBUMS[index % LIBRARY_SONG_ALBUMS.length],
    );
    item.attributes.artistName =
      LIBRARY_SONG_ARTISTS[index % LIBRARY_SONG_ARTISTS.length];
    const dateAdded = dateAddedFor(index);
    if (dateAdded) item.attributes.dateAdded = dateAdded;
    if (index % 4 === 0) item.attributes.contentRating = "explicit";
    if (index % 4 === 1) item.attributes.contentRating = "clean";
    return item;
  };
  const LIBRARY_VIEW_FOLDER_ID = "lv-folder-road";
  const libraryViewFolder = {
    id: LIBRARY_VIEW_FOLDER_ID,
    type: "library-playlist-folders",
    attributes: { name: "Road Trip" },
  };
  const libraryViewPlaylists = [
    ["lv-pl-01", "Sunday Drive", "2024-02-10T00:00:00.000Z"],
    ["lv-pl-02", "Afterglow", "2024-05-01T00:00:00.000Z"],
    ["lv-pl-03", "Sunday Drive", undefined],
    ["lv-pl-04", "Sunday Drive", "2024-03-01T00:00:00.000Z"],
    ["lv-pl-05", "Études Mix", "2024-04-01T00:00:00.000Z"],
    ["lv-pl-06", "Bravo Hits", "2024-06-01T00:00:00.000Z"],
  ].map(([id, name, dateAdded]) => ({
    id,
    type: "library-playlists",
    attributes: {
      name,
      artistName: "Arlet E2E",
      trackCount: 2,
      canEdit: true,
      ...(dateAdded ? { dateAdded } : {}),
    },
  }));
  const libraryViewFolderMembers = ["lv-pl-01", "lv-pl-06"];
  // Pages a generated list the way Apple does: `next` carries the offset.
  const pagedLibraryItems = (path, call, total, makeItem) => {
    const [pathname] = String(path).split("?");
    const params = requestParams(path, call);
    const offset = Math.max(0, Math.floor(Number(params.offset ?? 0))) || 0;
    const requested = Math.floor(Number(params.limit ?? LIBRARY_MAX_PAGE_SIZE));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, LIBRARY_MAX_PAGE_SIZE)
        : LIBRARY_MAX_PAGE_SIZE;
    const end = Math.min(total, offset + limit);
    return {
      data: Array.from({ length: Math.max(0, end - offset) }, (_, index) =>
        makeItem(offset + index),
      ),
      ...(end < total
        ? { next: `${pathname}?offset=${end}&limit=${limit}` }
        : {}),
    };
  };
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

  // Artwork sizing routes; undefined unless configure({ artworkGrid: true }).
  const artworkSearchResponse = (params) => {
    const { offset, limit } = pagingOf(params, 10, 25);
    const results = {};
    if (listParam(params.with).includes("topResults")) {
      results.top = { data: [clone(ARTWORK_SEARCH.albums[0])] };
    }
    const types = listParam(params.types);
    for (const type of types.length ? types : ["albums"]) {
      if (!Object.hasOwn(ARTWORK_SEARCH, type)) continue;
      results[type] = pageResponse(
        ARTWORK_SEARCH[type],
        "/v1/catalog/us/search",
        params,
        offset,
        limit,
      );
    }
    return { results };
  };
  const artworkGridResponse = (pathname, path, call) => {
    if (!state.artworkGrid || (call?.method ?? "GET") !== "GET") {
      return undefined;
    }
    const params = requestParams(path, call);
    // Batched `?ids=` lookups keep their own answers, as they do without the flag.
    if (params.ids !== undefined) return undefined;
    if (pathname === "/v1/me/library/albums") {
      return { data: ARTWORK_ALBUMS.map(clone) };
    }
    if (pathname === "/v1/me/library/playlists") {
      return { data: ARTWORK_PLAYLISTS.map(clone) };
    }
    if (pathname === "/v1/me/library/recently-added") {
      return {
        data: [
          ...ARTWORK_ALBUMS.slice(0, 4),
          ...ARTWORK_PLAYLISTS.slice(0, 2),
        ].map(clone),
      };
    }
    if (pathname === "/v1/me/library/artists") {
      const include = listParam(params.include);
      return {
        data: ARTWORK_ARTISTS.map((entry) =>
          artworkLibraryArtist(entry, include),
        ),
      };
    }
    const libraryArtist = pathname.match(
      /^\/v1\/me\/library\/artists\/([^/]+)$/u,
    );
    if (libraryArtist) {
      const id = decodeURIComponent(libraryArtist[1]);
      const entry = ARTWORK_ARTISTS.find((item) => item.id === id);
      if (!entry) return undefined;
      return {
        data: [artworkLibraryArtist(entry, listParam(params.include))],
      };
    }
    if (pathname === "/v1/catalog/us/stations") {
      return { data: ARTWORK_STATIONS.map(clone) };
    }
    if (pathname === "/v1/me/history/heavy-rotation") {
      return { data: ARTWORK_HOME.map(clone) };
    }
    if (
      pathname === "/v1/catalog/us/search" &&
      /artwork/iu.test(String(params.term ?? ""))
    ) {
      return artworkSearchResponse(params);
    }
    return undefined;
  };

  // A library playlist with an uploaded cover. Apple serves such covers from
  // signed links that expire after 24 hours, so each answer is signed now.
  // The host never resolves, so the image always fails to load.
  const PIN_ART_PLAYLIST_ID = "playlist-pin-art";
  // A library playlist whose custom cover was removed: no artwork at all.
  const PIN_NOCOVER_PLAYLIST_ID = "playlist-pin-nocover";
  const PIN_EXPIRED_SIGNED_AT = Date.UTC(2026, 0, 1);
  const pinArtPlaylist = (id, signedAtMs = Date.now()) => {
    if (id === PIN_NOCOVER_PLAYLIST_ID) {
      return {
        id,
        type: "library-playlists",
        attributes: { name: "Pinned Without Cover", canEdit: true },
      };
    }
    const signedAt = new Date(signedAtMs)
      .toISOString()
      .replace(/[-:]/gu, "")
      .replace(/\.\d{3}/u, "");
    return {
      id,
      type: "library-playlists",
      attributes: {
        name: "Pinned Cover Art",
        canEdit: true,
        artwork: {
          url: `https://e2e-blobstore.invalid/${id}.jpg?X-Amz-Date=${signedAt}&X-Amz-Expires=86400&X-Amz-Signature=e2e`,
        },
      },
    };
  };
  const pinArtResponse = (pathname, path, call) => {
    const detail = pathname.match(
      /^\/v1\/me\/library\/playlists\/(playlist-pin-(?:art|nocover))$/u,
    );
    if (detail) return { data: [pinArtPlaylist(detail[1])] };
    if (pathname !== "/v1/me/library/playlists") return undefined;
    const ids = String(requestParams(path, call).ids ?? "").split(",");
    const known = [PIN_ART_PLAYLIST_ID, PIN_NOCOVER_PLAYLIST_ID].filter((id) =>
      ids.includes(id),
    );
    return known.length
      ? { data: known.map((id) => pinArtPlaylist(id)) }
      : undefined;
  };

  const responseFor = (path, call = { method: "GET" }) => {
    const pathname = String(path).split("?", 1)[0];
    const mutation =
      ratingResponse(pathname, call) ?? libraryResponse(pathname, call);
    if (mutation) return mutation;
    const pinArt = pinArtResponse(pathname, path, call);
    if (pinArt !== undefined) return pinArt;
    const artwork = artworkGridResponse(pathname, path, call);
    if (artwork !== undefined) return artwork;
    const discovered = discoveryResponse(pathname, path, call);
    if (discovered !== undefined) return discovered;
    if (pathname === "/v1/me/storefront") {
      return { data: [{ id: "us", type: "storefronts" }] };
    }
    // `include=tracks` carries the first track page in `relationships.tracks`,
    // with the same `next` as the tracks endpoint, so callers page on as before.
    if (call.query?.include === "tracks" && TRACK_DETAIL_PATHS.has(pathname)) {
      const detail = responseFor(pathname, { method: "GET" });
      const page = responseFor(`${pathname}/tracks`, { method: "GET" });
      const [resource] = detail.data ?? [];
      if (resource) {
        resource.relationships = {
          tracks: {
            data: page.data,
            ...(page.next ? { next: page.next } : {}),
          },
        };
      }
      return detail;
    }
    if (BATCH_PLAYLIST_PATHS.has(pathname) && call.query?.ids !== undefined) {
      const playlists = pathname.startsWith("/v1/catalog/")
        ? [catalogPlaylist, polishPlaylist]
        : state.libraryView
          ? libraryViewPlaylists
          : [playlist, bigPlaylist];
      const ids = String(call.query.ids).split(",").filter(Boolean);
      // Ids come back in the order asked for; unknown ids are skipped.
      return {
        data: ids.flatMap((id) => {
          const match = playlists.find((entry) => entry.id === id);
          return match ? [clone(match)] : [];
        }),
      };
    }
    if (pathname === "/v1/me/library/playlists/playlist-1") {
      return itemResponse(playlist);
    }
    if (pathname === "/v1/me/library/playlists/playlist-big") {
      return itemResponse(bigPlaylist);
    }
    if (pathname === "/v1/me/library/playlists/playlist-big/tracks") {
      return bigPlaylistPage(path);
    }
    if (pathname === "/v1/catalog/us/playlists/pl.catalog-fixture") {
      return itemResponse(catalogPlaylist);
    }
    if (pathname === "/v1/catalog/us/playlists/pl.catalog-fixture/tracks") {
      return catalogTrackPage(path);
    }
    // Catalog album detail, with or without `/tracks`; the tracks endpoint
    // returns every track in one page (no `next`).
    const polishAlbumRoute = pathname.match(
      /^\/v1\/catalog\/us\/albums\/(album-polish(?:-sparse)?)(\/tracks)?$/u,
    );
    if (polishAlbumRoute) {
      const entry = polishAlbums[polishAlbumRoute[1]];
      return polishAlbumRoute[2]
        ? { data: entry.tracks.map(clone) }
        : itemResponse(entry.album);
    }
    if (pathname === "/v1/catalog/us/playlists/pl.polish-fixture") {
      return itemResponse(polishPlaylist);
    }
    if (pathname === "/v1/catalog/us/playlists/pl.polish-fixture/tracks") {
      return { data: polishPlaylistTracks.map(clone) };
    }
    if (String(path).includes(secondPlaylistPage)) {
      return {
        data: playlistItems.slice(4).map(clone),
        ...(state.repeatPlaylistCursor ? { next: secondPlaylistPage } : {}),
      };
    }
    if (pathname === "/v1/me/library/playlists/playlist-1/tracks") {
      // `playlistPrepended` models the playlist changing on another device
      // after its page was shown: one new song now comes first.
      return {
        data: [
          ...(state.playlistPrepended
            ? [track("song-new", "Newly Added Song")]
            : []),
          ...playlistItems.slice(0, 4),
        ].map(clone),
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
          station: { data: [songStation] },
        },
        "nav-delayed": {
          albums: { data: [{ id: "nav-delayed-album", type: "albums" }] },
          artists: { data: [] },
          station: { data: [songStation] },
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
    // A catalog artist's albums: 30, paged 25 at a time like Apple, with
    // release dates (newest is Album 30).
    if (pathname === "/v1/catalog/us/artists/nav-artist-two/albums") {
      const offset = Number(
        new URLSearchParams(String(path).split("?")[1] ?? "").get("offset") ??
          0,
      );
      const albums = Array.from({ length: 30 }, (_, index) => ({
        id: `artist-two-album-${index + 1}`,
        type: "albums",
        attributes: {
          name: `Artist Two Album ${index + 1}`,
          artistName: "Artist Two",
          releaseDate: `${1995 + index}-06-01`,
          playParams: { id: `artist-two-album-${index + 1}`, kind: "album" },
        },
      }));
      return {
        data: albums.slice(offset, offset + 25),
        ...(offset + 25 < albums.length
          ? {
              next: `/v1/catalog/us/artists/nav-artist-two/albums?offset=${offset + 25}`,
            }
          : {}),
      };
    }
    const artistMatch = pathname.match(
      /^\/v1\/(me\/library|catalog\/us)\/artists\/([^/]+)(\/view\/top-songs)?$/u,
    );
    if (artistMatch) {
      const library = artistMatch[1] === "me/library";
      const id = decodeURIComponent(artistMatch[2]);
      if (artistMatch[3]) {
        return { data: id === "nav-artist-two" ? clone(topSongItems) : [] };
      }
      const known = library ? id === "nav-artist-one" : id === "nav-artist-two";
      if (!known) return { data: [] };
      const relationships = library
        ? call.query?.include === "catalog"
          ? { catalog: { data: [{ id: "nav-artist-two", type: "artists" }] } }
          : undefined
        : call.query?.include === "station"
          ? { station: { data: [clone(artistStation)] } }
          : undefined;
      return itemResponse({
        id,
        type: library ? "library-artists" : "artists",
        attributes: { name: library ? "Artist One" : "Artist Two" },
        ...(relationships ? { relationships } : {}),
      });
    }
    if (/\/playlist-folders(?:\/[^/]+)?\/children$/u.test(pathname)) {
      if (state.libraryView) {
        if (pathname.includes("/fixture-playlists-root/")) {
          return { data: [clone(libraryViewFolder)] };
        }
        if (pathname.includes(`/${LIBRARY_VIEW_FOLDER_ID}/`)) {
          return {
            data: libraryViewPlaylists
              .filter((item) => libraryViewFolderMembers.includes(item.id))
              .map(clone),
          };
        }
      }
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
      const listed = state.libraryView
        ? libraryViewPlaylists.map(clone)
        : [clone(playlist)];
      // configure({ pinArtListExpired: true }) lists the pin-art playlist with
      // its cover link already expired.
      if (state.pinArtListExpired) {
        listed.push(pinArtPlaylist(PIN_ART_PLAYLIST_ID, PIN_EXPIRED_SIGNED_AT));
      }
      return { data: listed };
    }
    // Paged like Apple: `next` carries the offset and limit for the next call.
    const libraryKind = {
      "/v1/me/library/albums": "library-albums",
      "/v1/me/library/artists": "library-artists",
    }[pathname];
    if (libraryKind && state.librarySize > 0) {
      const params = new URLSearchParams(String(path).split("?")[1] ?? "");
      const offset =
        Math.max(
          0,
          Math.floor(Number(params.get("offset") ?? call.query?.offset ?? 0)),
        ) || 0;
      // A missing or unusable limit keeps the default; larger ones are capped.
      const requested = Math.floor(
        Number(params.get("limit") ?? call.query?.limit ?? LIBRARY_PAGE_SIZE),
      );
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(requested, LIBRARY_MAX_PAGE_SIZE)
          : LIBRARY_PAGE_SIZE;
      const end = Math.min(state.librarySize, offset + limit);
      return {
        data: Array.from({ length: Math.max(0, end - offset) }, (_, index) =>
          libraryItem(libraryKind, offset + index),
        ),
        ...(end < state.librarySize
          ? { next: `${pathname}?offset=${end}&limit=${limit}` }
          : {}),
      };
    }
    if (pathname === "/v1/me/library/songs") {
      if (state.libraryView) {
        return pagedLibraryItems(path, call, LIBRARY_SONG_COUNT, (index) =>
          clone(librarySong(index)),
        );
      }
      return { data: Object.values(navResources).map(clone) };
    }
    if (pathname === "/v1/catalog/us/search") {
      // Only a term containing "polish" reaches the polish ids.
      if (/polish/iu.test(String(call.query?.term ?? ""))) {
        return {
          results: {
            albums: { data: [clone(polishAlbum), clone(polishSparseAlbum)] },
            playlists: { data: [clone(polishPlaylist)] },
            songs: { data: polishAlbumTracks.map(clone) },
          },
        };
      }
      return { results: { songs: { data: topSongItems.map(clone) } } };
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
    const params = requestParams(pathText, request);
    const shouldReject =
      state.rejectPaths.some((entry) => pathText.includes(String(entry))) ||
      state.rejectQueryKeys.some((key) =>
        Object.prototype.hasOwnProperty.call(params, key),
      );
    const delay = state.delayPaths.some((entry) =>
      pathText.includes(String(entry)),
    );
    if (delay)
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    // Suggestions for a term listed in delayTerms answer late.
    const termDelay = pathText.includes("/search/suggestions")
      ? state.delayTerms[
          String(params.term ?? "")
            .trim()
            .toLowerCase()
        ]
      : undefined;
    if (typeof termDelay === "number" && termDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, termDelay));
    }
    if (shouldReject) {
      request.error = `Fixture request rejected: ${pathText}`;
      throw new Error(request.error);
    }
    if (
      state.rejectMeStatus &&
      String(path).split("?", 1)[0].startsWith("/v1/me")
    ) {
      const status = state.rejectMeStatus;
      // MusicKit's message for a refused request is the bare status.
      const error = new Error(String(status));
      error.errorCode = "ACCESS_DENIED";
      error.reason = "ACCESS_DENIED";
      error.status = status;
      error.data = { status };
      request.error = error.message;
      request.status = status;
      throw error;
    }
    const response = templateArtwork(responseFor(pathText, request));
    request.completedAt = Date.now();
    request.response = clone(response);
    // MusicKit v3 `api.music` resolves to an envelope around the JSON body.
    return {
      request: { path: pathText },
      response: { ok: true, status: response === undefined ? 204 : 200 },
      data: clone(response),
    };
  };

  // MusicKit rebuilds its API object, and the user token in its headers, on
  // every authorization change; a caller holding the old one sends that token.
  let apiGeneration = 0;
  const createApi = (generation) => {
    const music = async (path, query, options) => {
      const pathText = String(path);
      if (
        generation !== apiGeneration &&
        pathText.split("?", 1)[0].startsWith("/v1/me")
      ) {
        state.requests.push({
          path: pathText,
          method: String(options?.method ?? "GET").toUpperCase(),
          query: query ? clone(query) : undefined,
          staleApi: true,
          status: 403,
          error: "403",
          startedAt: Date.now(),
        });
        const error = new Error("403");
        error.errorCode = "ACCESS_DENIED";
        error.reason = "ACCESS_DENIED";
        error.status = 403;
        error.data = { status: 403 };
        throw error;
      }
      return musicRequest(path, query, options);
    };
    return { music, v3: { music } };
  };
  const resetApi = () => {
    apiGeneration += 1;
    instance.api = createApi(apiGeneration);
    state.transitions.push({ type: "apiReset", generation: apiGeneration });
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
  // Mirrors MusicKit v3 `Queue.splice(start, deleteCount, mediaItems)`,
  // which is synchronous and returns the removed MediaItems. A configured
  // delay makes it async so a provider change can land mid-edit.
  const spliceNative = (start, deleteCount, items) => {
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      start > state.queue.length ||
      !Number.isInteger(deleteCount) ||
      deleteCount < 0
    ) {
      throw new Error(`Fixture queue splice unavailable: ${start}`);
    }
    const end = Math.min(state.queue.length, start + deleteCount);
    if (
      deleteCount > 0 &&
      start <= state.queueIndex &&
      state.queueIndex < end
    ) {
      throw new Error("Fixture queue cannot remove the current item.");
    }
    const removed = state.queue.splice(start, deleteCount, ...items);
    if (start < state.queueIndex) {
      state.queueIndex += items.length - removed.length;
    } else if (start === state.queueIndex && items.length > 0) {
      state.queueIndex += items.length;
    }
    if (removed.length > 0) {
      state.transitions.push({
        type: "nativeRemove",
        index: start,
        ids: removed.map((item) => item.id),
      });
    }
    if (items.length > 0) {
      state.transitions.push({
        type: "nativeSplice",
        index: start,
        ids: items.map((item) => item.id),
      });
    }
    syncProviderQueue(true, false);
    return removed;
  };
  const nativeQueue = Object.create(queueRecord);
  Object.assign(nativeQueue, {
    splice(start, deleteCount, items = []) {
      if (state.queueEditDelayMs > 0) {
        return queueEditDelay().then(() =>
          spliceNative(start, deleteCount, items),
        );
      }
      return spliceNative(start, deleteCount, items);
    },
  });

  // Mirrors MusicKit's item loader: any unresolved ID rejects the whole call
  // with NOT_FOUND, and unplayable items are dropped without an error.
  const loadQueueItems = (type, itemIds, options) => {
    const lookedUp = !(
      state.detailsSkipLookup && Array.isArray(options?.items)
    );
    const missing = lookedUp
      ? itemIds.filter((id) => state.unresolvedIds.includes(id))
      : [];
    if (missing.length) {
      state.transitions.push({ type: `${type}Unresolved`, ids: missing });
      const error = new Error(
        `One or more items could not be resolved: ${missing.join(", ")}`,
      );
      error.errorCode = "NOT_FOUND";
      error.reason = "NOT_FOUND";
      error.data = missing.map((id) => ({ id, kind: "song" }));
      throw error;
    }
    return itemIds.filter((id) => !state.unplayableIds.includes(id));
  };

  const player = {
    queue: queueRecord,
    shuffle: false,
    // MusicKit v3 reads shuffle through `shuffleMode` (0 off, 1 songs).
    get shuffleMode() {
      return this.shuffle ? 1 : 0;
    },
    set shuffleMode(value) {
      this.shuffle = value === 1;
    },
    repeatMode: 0,
    volume: 1,
    get nowPlayingItem() {
      return state.playingOverride ?? currentItem();
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
    api: createApi(0),
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
      return state.playingOverride ?? currentItem();
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
      // MusicKit returns the stale token with no popup while it looks valid.
      if (this.isAuthorized) {
        state.transitions.push({ type: "authorize", popup: false });
        return this.musicUserToken;
      }
      const held = state.hangAuthorize;
      if (held) {
        state.transitions.push({ type: "authorize", popup: true, hung: true });
        await new Promise((resolve) => state.authorizeReleases.push(resolve));
      }
      if (state.rejectAuthorize) {
        state.transitions.push({
          type: "authorize",
          popup: true,
          rejected: true,
        });
        const error = new Error("Fixture sign-in window closed");
        error.errorCode = "AUTHORIZATION_ERROR";
        error.reason = "AUTHORIZATION_ERROR";
        throw error;
      }
      // A held call already recorded its popup when it started.
      if (!held) state.transitions.push({ type: "authorize", popup: true });
      state.rejectMeStatus = 0;
      this.isAuthorized = true;
      resetApi();
      return this.musicUserToken;
    },
    async unauthorize() {
      this.isAuthorized = false;
      state.transitions.push({ type: "unauthorize" });
      resetApi();
      emit(events.authorizationStatusDidChange, {});
    },
    async setQueue(options) {
      if (state.holdSetQueue) {
        await new Promise((resolve) => state.setQueueReleases.push(resolve));
      }
      const itemIds = loadQueueItems(
        "setQueue",
        idsFromOptions(options),
        options,
      );
      state.queue = itemIds.map(mediaItem);
      // MusicKit positions the new queue on `startWith` (index or item ID).
      const startWith = options?.startWith;
      const startIndex =
        typeof startWith === "string"
          ? state.queue.findIndex((item) => item.id === startWith)
          : Number.isInteger(startWith)
            ? startWith
            : 0;
      state.queueIndex =
        startIndex >= 0 && startIndex < state.queue.length ? startIndex : 0;
      state.shuffleHistory = [state.queueIndex];
      state.transitions.push({
        type: "setQueue",
        ids: [...itemIds],
        index: state.queueIndex,
        options: clone(options),
        shape: Object.keys(options ?? {}),
        shuffle: player.shuffle,
      });
      syncProviderQueue(true, true);
      return queueRecord;
    },
    changeToMediaAtIndex: (index) => selectIndex(index),
    async play() {
      // `rejectPlayTimes` rejects only the next N plays, as a song MusicKit
      // queued but could not start.
      if (state.rejectPlayTimes > 0) {
        state.rejectPlayTimes -= 1;
        state.transitions.push({ type: "playRejected" });
        throw new Error("Fixture play rejected once");
      }
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
      state.transitions.push({ type: "stop" });
      emit(events.playbackStateDidChange, { state: STOPPED });
      emit(events.nowPlayingItemDidChange, {});
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
      if (state.holdSeek) {
        await new Promise((resolve) => state.seekReleases.push(resolve));
      }
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: time,
        currentPlaybackDuration: 180,
      });
    },
    async playNext(options) {
      const itemIds = loadQueueItems(
        "playNext",
        idsFromOptions(options),
        options,
      );
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
      const itemIds = loadQueueItems(
        "playLater",
        idsFromOptions(options),
        options,
      );
      state.queue.push(...itemIds.map(mediaItem));
      state.transitions.push({
        type: "playLater",
        ids: [...itemIds],
        shape: Object.keys(options ?? {}),
      });
      syncProviderQueue(true, false);
    },
  };

  // Live radio metadata as MusicKit reports it: `{ timedMetadata: { title,
  // artist? } }` for both event names. The last payload is kept in snapshot.
  const emitLiveMetadata = (name, metadata) => {
    if (typeof metadata?.title !== "string") {
      throw new Error("Fixture live metadata needs a string title");
    }
    const fields = {
      title: metadata.title,
      ...(metadata.artist === undefined
        ? {}
        : { artist: String(metadata.artist) }),
    };
    state.liveMetadata = { event: name, ...clone(fields) };
    state.transitions.push({ type: "liveMetadata", event: name, ...fields });
    emit(name, { timedMetadata: clone(fields) });
    return true;
  };

  const fixture = {
    seed: "arlet-playlist-continuation-2026-10-08",
    /** Lets every held authorize() call finish; returns how many it released. */
    releaseAuthorize() {
      return releaseHeldAuthorize();
    },
    /** Lets every held setQueue() call finish; returns how many it released. */
    releaseSetQueue() {
      return releaseHeldSetQueue();
    },
    /** Finishes the oldest held seekToTime() calls; returns how many. */
    releaseSeek(count = Infinity) {
      return releaseHeldSeeks(count);
    },
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
      for (const key of ["unresolvedIds", "unplayableIds"]) {
        if (Object.prototype.hasOwnProperty.call(options, key)) {
          state[key] = [...(options[key] ?? [])].map(String);
        }
      }
      if (Object.prototype.hasOwnProperty.call(options, "playlistPrepended")) {
        state.playlistPrepended = options.playlistPrepended === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectPlayTimes")) {
        state.rejectPlayTimes = Math.max(
          0,
          Number(options.rejectPlayTimes) || 0,
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "detailsSkipLookup")) {
        state.detailsSkipLookup = options.detailsSkipLookup === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectPlay")) {
        state.rejectPlay = options.rejectPlay === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "nativeQueueEdit")) {
        state.nativeQueueEdit = options.nativeQueueEdit === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "librarySize")) {
        state.librarySize = Math.max(
          0,
          Math.floor(Number(options.librarySize)) || 0,
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "libraryView")) {
        state.libraryView = options.libraryView === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "ratings")) {
        // Replaces the whole map; keys are `${type}:${id}`, values 1 or -1.
        state.ratings = Object.fromEntries(
          Object.entries(options.ratings ?? {}).map(([key, value]) => [
            String(key),
            Number(value),
          ]),
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "artworkTemplate")) {
        state.artworkTemplate = String(options.artworkTemplate ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(options, "artworkGrid")) {
        state.artworkGrid = options.artworkGrid === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "pinArtListExpired")) {
        state.pinArtListExpired = options.pinArtListExpired === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "queueEditDelayMs")) {
        state.queueEditDelayMs = Math.max(
          0,
          Number(options.queueEditDelayMs) || 0,
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "holdSetQueue")) {
        state.holdSetQueue = options.holdSetQueue === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "holdSeek")) {
        state.holdSeek = options.holdSeek === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "delayTerms")) {
        state.delayTerms = Object.fromEntries(
          Object.entries(options.delayTerms ?? {}).map(([term, ms]) => [
            String(term).trim().toLowerCase(),
            Math.max(0, Number(ms) || 0),
          ]),
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectQueryKeys")) {
        state.rejectQueryKeys = [...(options.rejectQueryKeys ?? [])].map(
          String,
        );
      }
      if (Object.prototype.hasOwnProperty.call(options, "repeatViewCursor")) {
        state.repeatViewCursor = options.repeatViewCursor === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectMeStatus")) {
        state.rejectMeStatus = Math.max(0, Number(options.rejectMeStatus) || 0);
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectAuthorize")) {
        state.rejectAuthorize = options.rejectAuthorize === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "hangAuthorize")) {
        state.hangAuthorize = options.hangAuthorize === true;
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
      state.rejectPlayTimes = 0;
      state.playlistPrepended = false;
      state.unresolvedIds = [];
      state.detailsSkipLookup = false;
      state.unplayableIds = [];
      state.nativeQueueEdit = false;
      state.queueEditDelayMs = 0;
      state.holdSetQueue = false;
      releaseHeldSetQueue();
      state.holdSeek = false;
      releaseHeldSeeks();
      state.ratings = {};
      state.libraryAdds = [];
      state.librarySize = 0;
      state.libraryView = false;
      state.artworkTemplate = "";
      state.artworkGrid = false;
      state.pinArtListExpired = false;
      state.delayTerms = {};
      state.rejectQueryKeys = [];
      state.repeatViewCursor = false;
      state.liveMetadata = null;
      state.rejectMeStatus = 0;
      state.rejectAuthorize = false;
      state.hangAuthorize = false;
      releaseHeldAuthorize();
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
    // Mirrors MusicKit turning shuffle on mid-song: the current item moves to
    // the front and items are published while the position is still stale;
    // the position moves afterwards. The playing item never changes.
    shuffleLikeMusicKit() {
      const playing = currentItem();
      if (!playing) return false;
      const staleIndex = state.queueIndex;
      const others = state.queue.filter((_, index) => index !== staleIndex);
      others.reverse();
      state.playingOverride = playing;
      state.queue = [playing, ...others];
      player.shuffle = true;
      state.transitions.push({ type: "shuffleReorder", staleIndex });
      emit(events.queueItemsDidChange, {
        items: state.queue,
        currentItemIndex: staleIndex,
      });
      state.queueIndex = 0;
      state.playingOverride = undefined;
      emit(events.queuePositionDidChange, { position: 0 });
      emit(events.shuffleModeDidChange, { shuffle: true });
      return true;
    },
    // MusicKit publishes an MKError when a song fails as it starts playing.
    failCurrentItem(reason) {
      const error = new Error(`Fixture playback failure (${reason})`);
      error.errorCode = reason;
      error.reason = reason;
      state.transitions.push({
        type: "playbackError",
        reason,
        id: currentItem()?.id ?? null,
      });
      emit(events.mediaPlaybackError, error);
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
      const kind = idOrTarget?.kind ?? "track";
      const item = resource(String(id ?? ""));
      const title = item.attributes?.name ?? String(id ?? "");
      const target = document.createElement("div");
      target.dataset.contextKind = kind;
      target.dataset.contextId = String(id ?? "");
      if (idOrTarget?.source) target.dataset.contextSource = idOrTarget.source;
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
        kind,
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
    emitPlaybackTime(seconds, duration = 180) {
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: seconds,
        currentPlaybackDuration: duration,
      });
      return true;
    },
    // A late duration: the app learns it after the first time events.
    emitPlaybackDuration(seconds = 240) {
      const duration = Number(seconds);
      if (!Number.isFinite(duration) || duration < 0) {
        throw new Error(`Fixture duration out of range: ${seconds}`);
      }
      state.transitions.push({ type: "playbackDuration", seconds: duration });
      emit(events.playbackDurationDidChange, {
        currentPlaybackDuration: duration,
      });
      return true;
    },
    // An external sign-in change: isAuthorized flips, then the event fires.
    emitAuthorizationStatus(authorized) {
      instance.isAuthorized = authorized === true;
      state.transitions.push({
        type: "authorizationStatus",
        authorized: instance.isAuthorized,
      });
      resetApi();
      emit(events.authorizationStatusDidChange, {});
      return instance.isAuthorized;
    },
    // An external volume change: instance.volume is set first (recorded as a
    // "volume" transition), then the event carries the same value.
    emitPlaybackVolume(volume) {
      const value = Number(volume);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Fixture volume out of range: ${volume}`);
      }
      instance.volume = value;
      emit(events.playbackVolumeDidChange, { volume: value });
      return true;
    },
    // Marks the current item live or not. A live item is station-type with
    // attributes.isLive, as the app reads live radio. The item is re-announced
    // so the app picks up the change.
    setLive(isLive) {
      const item = currentItem();
      if (!item) return false;
      const live = isLive === true;
      const type = live
        ? "stations"
        : item.type === "stations"
          ? "library-songs"
          : item.type;
      state.queue[state.queueIndex] = {
        ...item,
        type,
        attributes: { ...item.attributes, isLive: live },
      };
      state.transitions.push({ type: "setLive", id: item.id, isLive: live });
      syncProviderQueue(true, true);
      return true;
    },
    emitTimedMetadata(metadata) {
      return emitLiveMetadata(events.timedMetadataDidChange, metadata);
    },
    emitMetadata(metadata) {
      return emitLiveMetadata(events.metadataDidChange, metadata);
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
          setQueueHeld: state.setQueueReleases.length,
        },
        seekHeld: state.seekReleases.length,
        queue: captureQueue(),
        modes: {
          shuffle: player.shuffle === true,
          repeat: player.repeatMode,
        },
        volume: player.volume,
        authorized: instance.isAuthorized === true,
        apiGeneration,
        authorizeHeld: state.authorizeReleases.length,
        // Request controls a scenario can leave set; the runner's isolation
        // guard compares them with the defaults after each scenario.
        controls: {
          holdSetQueue: state.holdSetQueue,
          holdSeek: state.holdSeek,
          hangAuthorize: state.hangAuthorize,
          delayPaths: clone(state.delayPaths),
          delayMs: state.delayMs,
          delayTerms: clone(state.delayTerms),
          queueEditDelayMs: state.queueEditDelayMs,
          rejectPaths: clone(state.rejectPaths),
          rejectQueryKeys: clone(state.rejectQueryKeys),
          rejectMeStatus: state.rejectMeStatus,
          rejectAuthorize: state.rejectAuthorize,
          rejectPlay: state.rejectPlay,
          rejectPlayTimes: state.rejectPlayTimes,
          repeatPlaylistCursor: state.repeatPlaylistCursor,
          repeatViewCursor: state.repeatViewCursor,
          pinArtListExpired: state.pinArtListExpired,
        },
        configure: state.configureOptions
          ? clone(state.configureOptions)
          : null,
        liveMetadata: state.liveMetadata ? clone(state.liveMetadata) : null,
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
    configure(options) {
      state.configured = true;
      // Option names and the dialog flag only; the tokens never get recorded.
      state.configureOptions = {
        keys: Object.keys(options ?? {}),
        suppressErrorDialog: options?.suppressErrorDialog === true,
      };
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
