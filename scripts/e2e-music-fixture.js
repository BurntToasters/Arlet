/** Seed used by the native E2E report to make runs repeatable. */
export const MUSIC_FIXTURE_SEED = "arlet-playlist-continuation-2026-10-08";

/**
 * Live MusicKit surface (MusicKit JS v3 3.2526.0; docs/TESTING.md "MusicKit
 *   parity"). window.MusicKit.PlayerRepeatMode is { none: 0, one: 1, all: 2 }
 *   with the reverse names too. PlayerShuffleMode is { off: 0, songs: 1 } with
 *   reverse names, and PlaybackBitrate is { STANDARD: 64, HIGH: 256 } with
 *   reverse names. PlaybackStates holds live numbers: none 0, loading 1,
 *   playing 2, paused 3, stopped 4, ended 5, seeking 6, waiting 8, stalled 9,
 *   completed 10.
 * There is no instance.player. shuffle, shuffleMode, repeatMode, volume,
 *   nowPlayingItem, nowPlayingItemIndex, changeToMediaAtIndex,
 *   changeToMediaItem and queue all sit on the instance. queue is always there
 *   as a live Queue record: with configure({ nativeQueueEdit: true }) it has
 *   splice, otherwise the base record (no splice, so the app rebuilds), and
 *   the autoplay getters (header, Autoplay) read on it either way.
 * Repeat (repeatMode 0 none, 1 one, 2 all): the setter accepts only 0, 1 and 2,
 *   and a change emits repeatModeDidChange with the bare new mode.
 *   Repeat One: Next and Previous restart the playing song ("restartRepeatOne",
 *   index unchanged, time 0), and a song that ends replays ("finishRepeatOne").
 *   Repeat All: Next and a song that ends go to index 0 at the end of the
 *   queue ("finishWrap"), and Previous on index 0 goes to the last song.
 *   Repeat none: Previous on index 0 restarts the song ("restartFirst").
 * Shuffle (MusicKit v3 Shuffler; docs/TESTING.md "MusicKit parity"): shuffleMode
 *   is 0 off or 1 songs, and only those two values are accepted. setQueue
 *   with shuffle on shuffles the queue around startWith and leaves the
 *   position where it was, so the position then points at a random song.
 *   Setting shuffleMode to a new value records the add order in
 *   queue.unshuffledIds, shuffles or unshuffles the queue, moves the position
 *   to the playing song, then emits queueItemsDidChange, queuePositionDidChange
 *   (only when the position moved) and shuffleModeDidChange. shuffle = true or
 *   false is a write-only alias for shuffleMode 1 or 0. Native splice, playNext
 *   and playLater keep unshuffledIds in step; a splice does not move the queue
 *   index or refuse the playing song, as live spliceQueueItems does.
 *   While shuffle is on, Next, Previous and a finished song walk the queue in
 *   order (honouring repeat). Shuffles draw from a PRNG seeded with
 *   MUSIC_FIXTURE_SEED and re-seeded by reset(). Duplicate IDs follow
 *   unshuffleQueue's quirk: a repeated ID maps to its last add-order index,
 *   so one copy is lost when shuffle turns off.
 * Payloads as live: queueItemsDidChange is the bare item array;
 *   nowPlayingItemDidChange is { item } (stop() sends item null);
 *   shuffleModeDidChange and repeatModeDidChange are bare numbers;
 *   queuePositionDidChange is { oldPosition, position }; playbackVolumeDidChange
 *   is { type: "volumechange" } with no level, so readers use instance.volume.
 *   Queue.position is writable: its setter moves the index and emits
 *   queuePositionDidChange only when it changes.
 * Selection stop (live MKInstance.changeToMediaAtIndex and changeToMediaItem,
 *   which call instance.stop() first; configure({ selectStops: false }) turns
 *   it off, the old behaviour; default true and reset() restores it): the
 *   fixture records { type: "selectStop", index }, then emits
 *   nowPlayingItemDidChange { item: undefined } (the live nowPlayingItem setter
 *   with undefined) and, only when the state was not already stopped (live
 *   setPlaybackState returns early on no change), playbackStateDidChange
 *   { oldState, state: 4, nowPlayingItem: previous }. Until the new item is
 *   set, instance.nowPlayingItem reads undefined. The new item then plays, so
 *   playbackStateDidChange { oldState: 4, state: 2 } follows the item change.
 *   Next, Previous and a finished song do not stop, as live does not. The stop
 *   pair is not a "stop" transition: instance.stop() still records that alone.
 *   Quirk kept from live: this path sends item undefined, while instance.stop()
 *   below still sends item null.
 * Station queues (live ContinuousPlaybackController and BaseShuffler or
 *   BaseRepeatable): setQueue({ station }), or setQueue({ url }) with a
 *   /station/ URL, starts one, and snapshot().queue.isStation reads true.
 *   Shuffle and repeat then read 0 and their writes do nothing, with no event.
 *   playNext, playLater and clearQueue reject with an MKError whose errorCode
 *   is "UNSUPPORTED_ERROR" and live's text for that method (Prepending, Appending
 *   or Clearing the Queue), and record { type: "stationRejected", method }.
 *   Stored shuffle and repeat values return when the station is left. A
 *   non-station setQueue, setCurrentTrack, seedQueue or reset() leaves it.
 *   clearQueue on a songs queue empties it (live Queue.clear), recorded as
 *   { type: "clearQueue" }.
 * Autoplay (live SerialPlaybackController and PlaybackController, MusicKit
 *   3.2526.0; configure({ autoplayStation }) picks the station answer, default
 *   "refused"; reset() restores it). A songs setQueue with autoplayEnabled on
 *   and repeat none POSTs /v1/me/stations/continuous and awaits it. "refused"
 *   records that call as status 403 and adds no autoplay songs, so
 *   snapshot().queue.autoplay.hasStation stays false. "ok" records 200, then
 *   POST /v1/me/stations/next-tracks/{id} for each top-up, and keeps up to 10
 *   upcoming autoplay songs after the user songs: ids autoplay-1, autoplay-2,
 *   ..., titles "Autoplay Song N", with isAutoplay true on the item.
 *   Top-up runs only while the station exists, autoplay is on, repeat is none,
 *   the queue is not a station, and 50 or fewer unplayed user songs remain
 *   (live maxQueueSizeForAutoplay). It runs after a setQueue, after the current
 *   song advances (selectIndex, queue position), after a native splice or
 *   remove, and after autoplayEnabled turns on. It records { type:
 *   "autoplayTopUp", ids }; a removal records { type: "autoplayRemoved", ids }.
 *   Queue getters on instance.queue (live Queue): autoplayItems, userAddedItems,
 *   unplayedAutoplayItems and unplayedUserItems (both from the position on,
 *   the current song included, as live slice(position)), appendTargetIndex
 *   (the first autoplay index while the position is before it, else length) and
 *   hasAutoplayStation. snapshot().queue.autoplay is { ids, appendTargetIndex,
 *   hasStation }. playLater inserts at appendTargetIndex; playNext does not.
 *   Setting autoplayEnabled emits autoplayEnabledDidChange with the bare
 *   boolean. false removes the upcoming autoplay songs and drops the station;
 *   true starts one again, as live startAutoplay does (same POST).
 *   Setting repeatMode to one or all removes the upcoming autoplay songs; none
 *   tops up. The shuffleMode and repeatMode setters apply even while the
 *   current song is an autoplay song, as live does: live gates them through
 *   canSetShuffleMode and canSetRepeatMode, which read false there (fixture
 *   getters match). The shuffle order leaves autoplay songs at the end, as live
 *   userAddedItems does. setCurrentTrack and seedQueue end any station without
 *   starting one. finishWithAutoplay keeps its refused-mode result (it appends an
 *   "autoplay-N" song, as scripts/e2e-desktop.js expects); under "ok" it moves to
 *   the next autoplay song instead.
 *
 * Bitrate (live BitrateCalculator, MusicKit 3.2526.0; docs/TESTING.md "MusicKit
 *   parity"): instance.bitrate reads and writes 64 or 256. A change emits
 *   playbackBitrateDidChange with { bitrate } (live's payload; no previous
 *   value and no bare number) and records { type: "bitrate", value }. Setting
 *   the current value does nothing, as live does. Live's startup is STANDARD
 *   (64) unless configure({ bitrate }) passes one; the fixture starts at 256
 *   instead, so the scenarios keep the high setting. configure({
 *   startupBitrate }) sets the value that the next reset() or initialization
 *   applies, and the startup value then returns to 256. reset() sets the
 *   bitrate to that startup value without recording a transition.
 *   emitBitrateChange(value) changes the bitrate the way live's downlink
 *   calculator does on a network change (only 64 or 256) and emits the same
 *   event. snapshot().bitrate is { current, startup }.
 * Subscription (live storekit, MusicKit 3.2526.0): configure({ subscription:
 *   false }) makes instance.hasMusicSubscription() resolve false (a Promise,
 *   as live) and instance.previewOnly true. The default is subscription true,
 *   and reset() restores it. Like live, the answer needs an authorized user.
 *   Preview-only playback reports a 30-second duration in playbackTimeDidChange,
 *   since live takes the duration from the audio element, which plays the
 *   preview clip. Item durationInMillis is not rewritten, as live does not.
 *   configure({ subscriptionDelayMs }) delays that promise (default 0).
 *   instance.subscribeURL is live's storekit deeplink for subscribe:
 *   https://finance-app.itunes.apple.com/deeplink?p=subscribe.
 *   instance.storefrontCountryCode is "us". snapshot().subscription is { has,
 *   previewOnly }, where has is the value hasMusicSubscription() resolves.
 *
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
 *   library-artist-views links it; GET /v1/me/library/artists/
 *   library-artist-views/albums answers 404, as seen on a real account.
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
 *   failNextLibraryPage: { path: "playlist-big/tracks?offset=300" } }) fails
 *   the next GET whose path contains `path` (once unless once is false).
 *   configure({ rejectSkip: true }) rejects every skipToNextItem() call until
 *   cleared, so Next fails the way a failed Windows media "next" would; the
 *   rejection is recorded as { type: "skipRejected" }. reset() clears it.
 *   configure({ holdSetQueue: true }) holds queue rebuilds until releaseSetQueue() resolves
 *   them. configure({ rejectSetQueue: true }) rejects every setQueue() call
 *   (after any hold) until cleared, for a failed Play. configure({
 *   holdSeek: true }) records each seekToTime() call but
 *   holds its completion tick until releaseSeek(count) resolves the oldest.
 *   configure({ hideQueueSplice: true }) keeps native queue methods hidden
 *   while nativeQueueEdit is on, forcing the rebuild tier; configure({
 *   setQueueDelayMs: 150 }) slows every setQueue() so a queue edit races a
 *   second click in tests. snapshot().queueEdit.setQueueStarts counts entries,
 *   so a test can click while one is still delayed.
 * Event controls (payloads as the app's MusicKit events reader expects them):
 *   emitAuthorizationStatus(false) sets isAuthorized = false, then emits
 *     authorizationStatusDidChange {}; true sets it back the same way.
 *   emitPlaybackDuration(240) emits playbackDurationDidChange
 *     { currentPlaybackDuration: 240 }.
 *   emitPlaybackVolume(0.4) sets the level (recorded as a "volume" transition),
 *     then emits playbackVolumeDidChange { type: "volumechange" }. The volume
 *     setter emits the same event only when the level changes.
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
 *     playbackStateDidChange (stopped) and nowPlayingItemDidChange { item: null }.
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
 *
 * Shuffle across the collection (scripts/e2e-musickit-parity.js): album-long
 *   is a library album of six songs, long-1 to long-6, and playlist-big is
 *   1200 songs, past the 500-song shuffle limit.
 *
 * Saving a queue as a playlist (scripts/e2e-save-queue.js): POST
 *   /v1/me/library/playlists creates "saved-playlist-N" with the first track
 *   batch, and POST /v1/me/library/playlists/{id}/tracks appends the rest.
 *   Created playlists answer detail, ?ids= and paged /tracks reads like Apple.
 *   snapshot().playlistMutations has { creates, adds, created } in request
 *   order, each add carrying its IDs and a failed flag. configure({
 *   failNextPlaylistAdd: { nth: 3 } }) rejects the nth add POST once (set
 *   once: false to repeat every nth); reset() clears all playlists and counts.
 *
 * Catalog extras (scripts/e2e-catalog-extras.js; docs/TESTING.md "Catalog
 *   extras"). Replay: GET /v1/me/music-summaries with filter[year]=latest
 *   returns one music-summaries resource (year 2026) with the requested views
 *   (top-songs, top-albums, top-artists; five items each). Any other
 *   filter[year] is recorded and answered 400. configure({ replay }) takes
 *   "data" (default), "empty" ({ data: [] }, as Apple sends with no Replay) or
 *   "error" (404); reset() restores "data". snapshot().controls.replay.
 *   Record labels: GET /v1/catalog/us/record-labels/{id}?views=latest-releases,
 *   top-releases. rl-fixture-1 "Fixture Records" and rl-fixture-2 "Second
 *   Label" have three albums in each view, all distinct, and an HTML
 *   description. configure({ longLabelDescription: true }) gives rl-fixture-1
 *   a description over 160 characters, so its page collapses it behind More;
 *   reset() restores the short one. Library albums never carry a record-labels relationship, as on
 *   Apple. configure({ albumCatalogTwin: true }) makes album-1 link its catalog
 *   twin cat-album-1 under relationships.catalog when the request has
 *   include=catalog; reset() turns it off, so album-1 stays library-only.
 *   Activities: GET /v1/catalog/us/activities/{id}?include=playlists.
 *   act-fixture-1 "Workout" has 14 playlists in relationships.playlists.data
 *   and a next link (/v1/catalog/us/activities/act-fixture-1/playlists?offset=14),
 *   which answers { data: [] }. act-fixture-2 "Recovery" has 3 playlists, no next.
 *   Search: a types list naming record-labels or activities adds that group,
 *   with two results, for any term. Other search responses are unchanged.
 *   Songs: GET /v1/catalog/us/songs/{id} and ?ids= answer song-a and song-c
 *   with composerName, isrc, discNumber, trackNumber, releaseDate and genreNames.
 *   song-a has contentRating "explicit" and composerName "<b>Composer</b> A",
 *   so the app must render it as text. Apple sends no copyright or recordLabel
 *   on songs; albums carry both. include=albums on a song links the catalog
 *   album cat-album-1 (GET /v1/catalog/us/albums/cat-album-1: recordLabel,
 *   copyright, genreNames, releaseDate). Its include=record-labels links
 *   rl-fixture-1.
 *   Playlist folders: POST /v1/me/library/playlist-folders creates
 *   "saved-folder-N" under relationships.parent (or at the root) and records
 *   { id, name, parentId } in snapshot().playlistMutations.folders, with
 *   parentId null at the root. POST /v1/me/library/playlists with
 *   relationships.parent adds parentId to its playlistMutations.creates entry;
 *   with no parent the entry is unchanged. GET
 *   /v1/me/library/playlist-folders/{id}/children lists the items created under
 *   that parent in this session, after the seed children.
 */

// The page receives this function as text, so the seed is passed in as an
// argument (see musicFixtureSource) rather than read from module scope.
function installMusicKitFixture(fixtureSeed) {
  if (window.__ARLET_E2E_MUSIC__) return;

  const PLAYING = 2;
  const PAUSED = 3;
  const STOPPED = 4;
  // Live MusicKit v3 enums. Each has its names and the reverse numbers, as
  // a TypeScript numeric enum does.
  const PlayerRepeatMode = {
    none: 0,
    one: 1,
    all: 2,
    0: "none",
    1: "one",
    2: "all",
  };
  const PlayerShuffleMode = { off: 0, songs: 1, 0: "off", 1: "songs" };
  const PlaybackBitrate = {
    STANDARD: 64,
    HIGH: 256,
    64: "STANDARD",
    256: "HIGH",
  };
  const REPEAT_MODES = [
    PlayerRepeatMode.none,
    PlayerRepeatMode.one,
    PlayerRepeatMode.all,
  ];
  const events = {
    playbackStateDidChange: "playbackStateDidChange",
    nowPlayingItemDidChange: "nowPlayingItemDidChange",
    playbackTimeDidChange: "playbackTimeDidChange",
    mediaPlaybackError: "mediaPlaybackError",
    queueItemsDidChange: "queueItemsDidChange",
    queuePositionDidChange: "queuePositionDidChange",
    shuffleModeDidChange: "shuffleModeDidChange",
    repeatModeDidChange: "repeatModeDidChange",
    autoplayEnabledDidChange: "autoplayEnabledDidChange",
    // The app's events reader (src/musickit/events.ts) listens to these; the
    // event controls in the header emit them.
    authorizationStatusDidChange: "authorizationStatusDidChange",
    playbackDurationDidChange: "playbackDurationDidChange",
    // Live bitrate event; the harness's optional-API check reads it.
    playbackBitrateDidChange: "playbackBitrateDidChange",
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

  // Library song for Get Info. Its catalog twin is numeric, so the app reads it
  // through the catalog route; it is served by id only, not in any list.
  const getInfoSong = track("get-info-song", "Info Track", "Fixture Album");
  getInfoSong.attributes.playParams = {
    id: "get-info-song",
    kind: "song",
    catalogId: "1700000001",
  };
  const resource = (id) =>
    (id === "song-no-art" ? trackWithoutArtwork : undefined) ??
    (id === "get-info-song" ? getInfoSong : undefined) ??
    playlistItems.find((item) => item.id === id) ??
    topSongItems.find((item) => item.id === id) ??
    bigItems.find((item) => item.id === id) ??
    catalogPlaylistItems.find((item) => item.id === id) ??
    albumItems.find((item) => item.id === id) ??
    longAlbumItems.find((item) => item.id === id) ??
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
  // Six songs, long-1 to long-6 in album order, for the shuffle group that
  // starts an album from its third song.
  const longAlbumItems = Array.from({ length: 6 }, (_, index) =>
    track(`long-${index + 1}`, `Long Track ${index + 1}`, "Long Album"),
  );
  const longAlbum = {
    id: "album-long",
    type: "library-albums",
    attributes: {
      name: "Long Album",
      artistName: "Fixture Artist",
      trackCount: longAlbumItems.length,
    },
  };

  // Seeded PRNG (mulberry32 over an FNV-1a hash of the seed), so a given seed
  // always produces the same shuffles.
  const createRandom = (seedText) => {
    let hash = 2166136261;
    for (const char of seedText) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return () => {
      hash = (hash + 0x6d2b79f5) | 0;
      let mixed = Math.imul(hash ^ (hash >>> 15), 1 | hash);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  };

  const state = {
    configured: false,
    listeners: new Map(),
    requests: [],
    transitions: [],
    queue: [],
    queueIndex: 0,
    // Live shuffle: shuffleMode 0 off or 1 songs, and the add-order song IDs
    // that unshuffleQueue restores (header comment).
    shuffleMode: PlayerShuffleMode.off,
    unshuffledIds: [],
    random: createRandom(fixtureSeed),
    // Live modes and volume, read and written through the instance.
    repeatMode: PlayerRepeatMode.none,
    volume: 1,
    // Bitrate (header comment). The startup value applies at the next reset().
    bitrate: PlaybackBitrate.HIGH,
    startupBitrate: PlaybackBitrate.HIGH,
    // Subscription (header comment). The delay applies to hasMusicSubscription().
    subscription: true,
    subscriptionDelayMs: 0,
    // Selection stop on changeToMediaAtIndex and changeToMediaItem (header).
    selectStops: true,
    // Station queue (header); cleared by a songs queue, reset() and clearing.
    isStation: false,
    // Autoplay (header): the station answer, the station ID while one exists
    // (null otherwise), the last autoplay song number and autoplayEnabled.
    autoplayStation: "refused",
    autoplayStationId: null,
    autoplaySerial: 0,
    autoplayEnabled: true,
    // True only while the selection stop's nowPlayingItem clear is emitted.
    nowPlayingCleared: false,
    contextTarget: undefined,
    delayPaths: [],
    rejectPaths: [],
    // Fails one matching GET before any response is served; see header.
    failNextLibraryPage: null,
    delayMs: 800,
    repeatPlaylistCursor: false,
    rejectPlay: false,
    rejectPlayTimes: 0,
    // Test-only: every skipToNextItem() rejects until cleared.
    rejectSkip: false,
    // Test-only: rl-fixture-1 gets a description over 160 characters.
    longLabelDescription: false,
    // Test-only: every setQueue() rejects until cleared, so a Play's queue
    // setup can fail deterministically.
    rejectSetQueue: false,
    // Catalog IDs the item loader cannot resolve, and IDs that resolve but
    // are not playable (MusicKit drops those silently).
    unresolvedIds: [],
    // Real MusicKit does not look up songs queued as details, so an
    // unresolvable song is only found when it plays. Off by default.
    detailsSkipLookup: false,
    unplayableIds: [],
    nativeQueueEdit: false,
    // Test-only: keep `queue` exposed but without splice, as some runtimes do.
    hideQueueSplice: false,
    queueEditDelayMs: 0,
    // Test-only: widens the window between two queue edits.
    setQueueDelayMs: 0,
    holdSetQueue: false,
    setQueueReleases: [],
    // Cumulative setQueue() entries; a delayed call is observable from here.
    setQueueStarts: 0,
    holdSeek: false,
    seekReleases: [],
    // Keyed `${type}:${id}`, e.g. `library-songs:song-a`; values are 1 or -1.
    ratings: {},
    libraryAdds: [],
    // Library playlists created through the fixture, with their saved tracks.
    createdPlaylists: [],
    nextCreatedPlaylistId: 1,
    // Create/add playlist POSTs, in request order (header comment).
    playlistCreates: [],
    playlistAdds: [],
    playlistAddAttempts: 0,
    // Test-only: fail the nth add-to-playlist POST once.
    failNextPlaylistAdd: null,
    // Generated library albums and artists; 0 keeps the seed data only.
    librarySize: 0,
    // Library songs, playlists and the playlist folder (header comment).
    libraryView: false,
    // album-1 links its catalog twin cat-album-1 (header comment); off, so
    // other suites keep a library-only album-1.
    albumCatalogTwin: false,
    // Artwork URL template for responses and queue items; "" keeps seed URLs.
    artworkTemplate: "",
    // Artwork sizing data (ARTWORK_* below); off, so other suites never see it.
    artworkGrid: false,
    // Pinned playlist artwork (header comment); off by default.
    pinArtListExpired: false,
    // Replay answer (header comment): "data", "empty" or "error".
    replay: "data",
    // Playlist folders created in this session (header comment).
    createdFolders: [],
    nextCreatedFolderId: 1,
    playlistFolderCreates: [],
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
  // Records a volume level and reports whether it changed. Callers decide
  // whether to emit playbackVolumeDidChange.
  const applyVolume = (value) => {
    const changed = state.volume !== value;
    state.volume = value;
    state.transitions.push({ type: "volume", value });
    return changed;
  };
  // Records a bitrate and emits playbackBitrateDidChange { bitrate } when it
  // changes, as live BitrateCalculator's setter does. reset() passes record
  // false, because it clears the transitions before it restores the bitrate.
  const setBitrate = (value, record = true) => {
    if (value === state.bitrate) return false;
    state.bitrate = value;
    if (record) state.transitions.push({ type: "bitrate", value });
    emit(events.playbackBitrateDidChange, { bitrate: value });
    return true;
  };
  // Live hasMusicSubscription needs an authorized user with a subscription.
  const hasSubscription = () =>
    state.subscription && instance.isAuthorized === true;
  // Preview-only playback reports the 30-second clip's duration (header).
  const playbackDurationNow = () => (instance.previewOnly ? 30 : 180);
  // Station queues read shuffle and repeat as 0 (live BaseShuffler and
  // BaseRepeatable). The stored values are kept and return after the station.
  const shuffleModeOf = () =>
    state.isStation ? PlayerShuffleMode.off : state.shuffleMode;
  const repeatModeOf = () =>
    state.isStation ? PlayerRepeatMode.none : state.repeatMode;
  // setQueue({ station }) or a station URL starts a station queue.
  const isStationOptions = (options) =>
    (options?.station !== undefined && options?.station !== null) ||
    (typeof options?.url === "string" && /\/station\//u.test(options.url));
  // Live ContinuousPlaybackController rejects with UNSUPPORTED_ERROR.
  const stationRejected = (method, message) => {
    state.transitions.push({ type: "stationRejected", method });
    const error = new Error(message);
    error.errorCode = "UNSUPPORTED_ERROR";
    error.reason = "UNSUPPORTED_ERROR";
    return error;
  };
  const queueRecord = {
    get items() {
      return state.queue;
    },
    get position() {
      return state.queue.length ? state.queueIndex : -1;
    },
    // Live Queue.position is writable: the setter moves the index and emits
    // queuePositionDidChange only when the position changes. Out-of-range
    // values are ignored, and nothing else (playback, the item) changes.
    set position(value) {
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value >= state.queue.length ||
        value === state.queueIndex
      ) {
        return;
      }
      const oldPosition = queueRecord.position;
      state.queueIndex = value;
      emit(events.queuePositionDidChange, { oldPosition, position: value });
      topUpAutoplay();
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
    // Live Queue getters (header, Autoplay). Unplayed songs start at the
    // position, as live slice(position) does, so the current song counts.
    get autoplayItems() {
      return state.queue.filter((item) => item.isAutoplay === true);
    },
    get userAddedItems() {
      return state.queue.filter((item) => item.isAutoplay !== true);
    },
    get unplayedAutoplayItems() {
      return state.queue
        .slice(Math.max(0, queueRecord.position))
        .filter((item) => item.isAutoplay === true);
    },
    get unplayedUserItems() {
      return state.queue
        .slice(Math.max(0, queueRecord.position))
        .filter((item) => item.isAutoplay !== true);
    },
    get appendTargetIndex() {
      let end = state.queue.length;
      const first = state.queue.findIndex((item) => item.isAutoplay === true);
      if (first !== -1 && queueRecord.position < first) end = first;
      return end;
    },
    get hasAutoplayStation() {
      return state.autoplayStationId !== null;
    },
  };

  const syncProviderQueue = (emitQueue = true, emitCurrent = true) => {
    if (!state.queue.length) state.queueIndex = 0;
    else
      state.queueIndex = Math.max(
        0,
        Math.min(state.queueIndex, state.queue.length - 1),
      );
    if (emitQueue) emit(events.queueItemsDidChange, [...state.queue]);
    if (emitCurrent) {
      emit(events.nowPlayingItemDidChange, { item: currentItem() });
      // A new item starts at zero with a known duration, as MusicKit reports it.
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: 0,
        currentPlaybackDuration: playbackDurationNow(),
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
    isStation: state.isStation,
    unshuffledIds: [...state.unshuffledIds],
    autoplay: {
      ids: queueRecord.autoplayItems.map((item) => item.id),
      appendTargetIndex: queueRecord.appendTargetIndex,
      hasStation: queueRecord.hasAutoplayStation,
    },
  });

  // Mirrors MusicKit's Shuffler. Each helper only rewrites state; the caller
  // emits the events.
  const shuffledCopy = (items) => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const pick = Math.floor(state.random() * (index + 1));
      [copy[index], copy[pick]] = [copy[pick], copy[index]];
    }
    return copy;
  };
  const sameOrder = (a, b) =>
    a.length === b.length && a.every((item, index) => item === b[index]);
  // The item at the current position is set aside and leads the queue; the
  // rest are shuffled, and redrawn while the order comes out unchanged. The
  // position itself is not moved.
  const shuffleQueue = () => {
    const position = state.queue.length ? state.queueIndex : -1;
    const rest = [...state.queue];
    const current =
      position > -1 &&
      position < rest.length &&
      rest[position].isAutoplay !== true
        ? rest.splice(position, 1)
        : [];
    // Live Shuffler shuffles userAddedItems only, so autoplay songs keep the end.
    const autoplay = rest.filter((item) => item.isAutoplay === true);
    const userRest = rest.filter((item) => item.isAutoplay !== true);
    let shuffled = shuffledCopy(userRest);
    while (shuffled.length > 1 && sameOrder(shuffled, userRest)) {
      shuffled = shuffledCopy(userRest);
    }
    state.queue = [...current, ...shuffled, ...autoplay];
  };
  // Restores add order from unshuffledIds. A repeated ID maps to its last
  // index, so its copies overwrite one another in the sparse array and one
  // copy is lost (the live quirk). Items not in the list follow in queue order.
  const unshuffleQueue = () => {
    const position = state.queue.length ? state.queueIndex : -1;
    const playing = position > -1 ? state.queue[position] : undefined;
    const indexById = new Map();
    state.unshuffledIds.forEach((id, index) => indexById.set(id, index));
    const sparse = [];
    const extras = [];
    let remembered;
    state.queue.forEach((item, index) => {
      const target = indexById.get(item.id);
      if (target === undefined) {
        extras.push(item);
        return;
      }
      sparse[target] = item;
      if (index === position) remembered = target;
    });
    // filter() skips the holes that the sparse array leaves.
    const compacted = sparse.filter(() => true);
    state.queue = [...compacted, ...extras];
    if (playing !== undefined) {
      // The remembered slot is filled (by the surviving copy when one was
      // lost), so its position among the compacted items is always in range.
      // A playing extra has no add-order slot, so it sits after the compacted
      // items. Live quirk, on purpose (docs/TESTING.md "Shuffle model"): the
      // remembered value is the UNcompacted slot from the id-to-index map, so
      // it can be past the end, or point at another copy, once a repeated copy
      // is lost. Readers tolerate that: currentItem() is null-safe and
      // shuffleQueue ignores a position outside the queue.
      state.queueIndex =
        remembered ?? compacted.length + extras.indexOf(playing);
    }
  };
  // Replaces the queue as setQueue does: add order is recorded, then with
  // shuffle on the queue is shuffled around `index`.
  const replaceQueue = (items, index) => {
    state.queue = items;
    state.queueIndex = index;
    state.unshuffledIds = items.map((item) => item.id);
    if (shuffleModeOf() === PlayerShuffleMode.songs) shuffleQueue();
  };

  // Autoplay (header comment). Live bag defaults: maxQueueSizeForAutoplay 50
  // and maxUpcomingTracksToMaintain 10.
  const AUTOPLAY_STATION_ID = "ra.autoplay-fixture";
  const AUTOPLAY_QUEUE_LIMIT = 50;
  const AUTOPLAY_UPCOMING_LIMIT = 10;
  const recordAutoplayRequest = (method, path, status) => {
    state.requests.push({ method, path, status, startedAt: Date.now() });
  };
  const autoplayMediaItem = (id, number) => {
    const item = track(id, `Autoplay Song ${number}`);
    item.isAutoplay = true;
    if (!state.artworkTemplate) return item;
    const templated = templateArtwork(item, id);
    return { ...templated, artwork: clone(templated.attributes.artwork) };
  };
  // Live Queue.splice per song, so each removal emits queueItemsDidChange.
  // Only songs after the position go, as live stopAutoplay and repeat do.
  // Autoplay runs inside playback calls (setQueue, selectIndex, splice, the
  // repeat and autoplay setters). A fixture bug there must not throw into the
  // app, so a failure is recorded as an autoplayError transition instead.
  const guardAutoplay = (step, work) => {
    try {
      work();
    } catch (error) {
      state.transitions.push({
        type: "autoplayError",
        step,
        message: String(error?.message ?? error),
      });
    }
  };
  const removeUpcomingAutoplay = () =>
    guardAutoplay("remove", () => {
      const removed = [];
      for (
        let index = state.queue.length - 1;
        index > queueRecord.position;
        index -= 1
      ) {
        if (state.queue[index].isAutoplay !== true) continue;
        removed.unshift(state.queue[index].id);
        state.queue.splice(index, 1);
        emit(events.queueItemsDidChange, [...state.queue]);
      }
      if (removed.length > 0) {
        state.transitions.push({ type: "autoplayRemoved", ids: removed });
      }
    });
  // Live SerialPlaybackController.queueAutoplayTracks: the limit counts the
  // upcoming autoplay songs after the position, then the songs are appended
  // at appendTargetIndex (one queueItemsDidChange, as one splice).
  const topUpAutoplay = () =>
    guardAutoplay("topUp", () => {
      if (
        state.autoplayStationId === null ||
        state.isStation ||
        !state.autoplayEnabled ||
        state.repeatMode !== PlayerRepeatMode.none ||
        queueRecord.length === 0 ||
        queueRecord.unplayedUserItems.length > AUTOPLAY_QUEUE_LIMIT
      ) {
        return;
      }
      const playingAutoplay = currentItem()?.isAutoplay === true ? 1 : 0;
      const need =
        AUTOPLAY_UPCOMING_LIMIT -
        queueRecord.unplayedAutoplayItems.length +
        playingAutoplay;
      if (need <= 0) return;
      const ids = [];
      const items = [];
      for (let count = 0; count < need; count += 1) {
        state.autoplaySerial += 1;
        const id = `autoplay-${state.autoplaySerial}`;
        ids.push(id);
        items.push(autoplayMediaItem(id, state.autoplaySerial));
      }
      recordAutoplayRequest(
        "POST",
        `/v1/me/stations/next-tracks/${AUTOPLAY_STATION_ID}`,
        200,
      );
      state.queue.splice(queueRecord.appendTargetIndex, 0, ...items);
      state.transitions.push({ type: "autoplayTopUp", ids });
      emit(events.queueItemsDidChange, [...state.queue]);
    });
  // Live startAutoplay: a songs queue with autoplay on, repeat none and no
  // station yet asks for one. "refused" answers 403 and the queue gets none.
  const startAutoplayStation = () =>
    guardAutoplay("start", () => {
      if (
        state.autoplayStationId !== null ||
        state.isStation ||
        !state.autoplayEnabled ||
        state.repeatMode !== PlayerRepeatMode.none ||
        queueRecord.length === 0
      ) {
        return;
      }
      const ok = state.autoplayStation === "ok";
      recordAutoplayRequest(
        "POST",
        "/v1/me/stations/continuous",
        ok ? 200 : 403,
      );
      if (!ok) return;
      state.autoplayStationId = AUTOPLAY_STATION_ID;
      topUpAutoplay();
    });
  // Live stopAutoplay: the station goes, and unplayed autoplay songs with it.
  const stopAutoplayStation = () => {
    state.autoplayStationId = null;
    removeUpcomingAutoplay();
  };
  // Live autoplayEnabled setter: it publishes the bare boolean only on a
  // change, and the controller then starts or stops autoplay.
  const setAutoplayEnabled = (value) => {
    const next = Boolean(value);
    if (next === state.autoplayEnabled) return;
    state.autoplayEnabled = next;
    emit(events.autoplayEnabledDidChange, next);
    if (next) startAutoplayStation();
    else stopAutoplayStation();
  };
  const readAutoplayEnabled = () => state.autoplayEnabled;

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

  // Catalog extras (header comment). Built once here; the routes pick from
  // these lists. Replay first.
  const REPLAY_MODES = ["data", "empty", "error"];
  const REPLAY_TOP_SONGS = [
    ["Glass Harbor", "Mira Vale", "Harbor Lights"],
    ["Paper Moons Rising", "Kenji Holt", "Paper Moons"],
    ["Lantern Road", "Ada Ruiz", "Lantern Road"],
    ["Quiet Engine Hum", "Tom Ostrander", "Quiet Engine"],
    ["Night Cargo Blues", "The Lantern Choir", "Night Cargo"],
  ];
  const REPLAY_TOP_ALBUMS = [
    ["Harbor Lights", "Mira Vale"],
    ["Paper Moons", "Kenji Holt"],
    ["Lantern Road", "Ada Ruiz"],
    ["Quiet Engine", "Tom Ostrander"],
    ["Night Cargo", "The Lantern Choir"],
  ];
  const REPLAY_TOP_ARTISTS = [
    "Mira Vale",
    "Kenji Holt",
    "Ada Ruiz",
    "Tom Ostrander",
    "The Lantern Choir",
  ];
  const replaySong = (index) => {
    const [name, artistName, albumName] = REPLAY_TOP_SONGS[index];
    const id = `replay-song-${index + 1}`;
    return {
      id,
      type: "songs",
      attributes: {
        name,
        artistName,
        albumName,
        durationInMillis: 200_000 + index * 7_000,
        trackNumber: index + 1,
        genreNames: ["Pop"],
        url: `https://music.apple.com/us/song/${id}/${id}`,
        artwork: polishArtwork(id),
        playParams: { id, kind: "song", catalogId: id },
      },
    };
  };
  const replayAlbum = (index) => {
    const [name, artistName] = REPLAY_TOP_ALBUMS[index];
    const id = `replay-album-${index + 1}`;
    return {
      id,
      type: "albums",
      attributes: {
        name,
        artistName,
        releaseDate: `${2019 + index}-06-01`,
        trackCount: 10,
        genreNames: ["Pop"],
        url: `https://music.apple.com/us/album/${id}/${id}`,
        artwork: polishArtwork(id),
        playParams: { id, kind: "album" },
      },
    };
  };
  const replayArtist = (index) => {
    const id = `replay-artist-${index + 1}`;
    return {
      id,
      type: "artists",
      attributes: {
        name: REPLAY_TOP_ARTISTS[index],
        genreNames: ["Pop"],
        url: `https://music.apple.com/us/artist/${id}/${id}`,
        artwork: polishArtwork(id),
      },
    };
  };
  const REPLAY_VIEWS = {
    "top-songs": [0, 1, 2, 3, 4].map(replaySong),
    "top-albums": [0, 1, 2, 3, 4].map(replayAlbum),
    "top-artists": [0, 1, 2, 3, 4].map(replayArtist),
  };
  // Requested views only; a view the fixture lacks answers { data: [] }.
  const replayResponse = (params) => {
    const requested = listParam(params.views);
    const names = requested.length ? requested : Object.keys(REPLAY_VIEWS);
    return {
      data: [
        {
          id: "music-summary-2026",
          type: "music-summaries",
          attributes: { year: 2026 },
          views: Object.fromEntries(
            names.map((name) => [
              name,
              {
                data: Object.hasOwn(REPLAY_VIEWS, name)
                  ? REPLAY_VIEWS[name].map(clone)
                  : [],
              },
            ]),
          ),
        },
      ],
    };
  };
  // A wrong filter[year] is refused whatever configure({ replay }) says.
  const fixtureHttpError = (status, code) => {
    const error = new Error(String(status));
    error.errorCode = code;
    error.reason = code;
    error.status = status;
    error.data = { status, errors: [{ status: String(status), code }] };
    return error;
  };
  const replayFailureFor = (pathname, params) => {
    if (pathname !== "/v1/me/music-summaries") return undefined;
    if (params["filter[year]"] !== "latest") {
      return { status: 400, code: "INVALID_ARGUMENT" };
    }
    if (state.replay === "error") return { status: 404, code: "NOT_FOUND" };
    return undefined;
  };

  // Record labels: three distinct albums per view, for each label.
  const RECORD_LABELS = {
    "rl-fixture-1": {
      name: "Fixture Records",
      artistName: "Fixture Artist",
      description: {
        standard: "Independent <b>fixture</b> releases & reissues.",
        short: "Fixture releases",
      },
    },
    "rl-fixture-2": {
      name: "Second Label",
      artistName: "Second Artist",
      description: {
        standard: "A <i>second</i> label, for the label views.",
        short: "Second label",
      },
    },
  };
  const LABEL_VIEWS = {
    "latest-releases": { title: "Latest", year: 2026 },
    "top-releases": { title: "Top", year: 2020 },
  };
  const recordLabelAlbum = (labelId, view, number) => {
    const label = RECORD_LABELS[labelId];
    const { title, year } = LABEL_VIEWS[view];
    const id = `${labelId}-${view}-${number}`;
    return {
      id,
      type: "albums",
      attributes: {
        name: `${label.name} ${title} ${number}`,
        artistName: label.artistName,
        releaseDate: `${year}-0${number}-01`,
        trackCount: 10,
        recordLabel: label.name,
        copyright: `℗ ${year} ${label.name}`,
        url: `https://music.apple.com/us/album/${id}/${id}`,
        artwork: polishArtwork(id),
        playParams: { id, kind: "album" },
      },
    };
  };
  const RECORD_LABEL_ALBUMS = Object.fromEntries(
    Object.keys(RECORD_LABELS).map((labelId) => [
      labelId,
      Object.fromEntries(
        Object.keys(LABEL_VIEWS).map((view) => [
          view,
          [1, 2, 3].map((number) => recordLabelAlbum(labelId, view, number)),
        ]),
      ),
    ]),
  );
  const LONG_LABEL_DESCRIPTION =
    "Independent <b>fixture</b> releases, reissues, and archival collections from working artists across several decades, curated for listeners who want the complete catalogue of one small imprint.";
  const recordLabelResource = (id) => ({
    id,
    type: "record-labels",
    attributes: {
      name: RECORD_LABELS[id].name,
      description:
        id === "rl-fixture-1" && state.longLabelDescription
          ? { standard: LONG_LABEL_DESCRIPTION, short: "Fixture releases" }
          : clone(RECORD_LABELS[id].description),
      url: `https://music.apple.com/us/record-label/${id}/${id}`,
      artwork: polishArtwork(id),
    },
  });
  // The relationship form, as album detail links a label.
  const recordLabelRef = (id) => ({
    id,
    type: "record-labels",
    href: `/v1/catalog/us/record-labels/${id}`,
    attributes: { name: RECORD_LABELS[id].name },
  });
  const recordLabelResponse = (id, params) => {
    const resource = recordLabelResource(id);
    const views = listParam(params.views);
    if (views.length) {
      resource.views = Object.fromEntries(
        views.map((name) => [
          name,
          {
            data: Object.hasOwn(RECORD_LABEL_ALBUMS[id], name)
              ? RECORD_LABEL_ALBUMS[id][name].map(clone)
              : [],
          },
        ]),
      );
    }
    return { data: [resource] };
  };

  // Activities: act-fixture-1 pages 14 playlists in one response, so a client
  // that caps at 10, or follows `next`, is detectable.
  const ACTIVITIES = {
    "act-fixture-1": {
      name: "Workout",
      description: {
        standard: "Playlists for <b>training</b> days.",
        short: "Training",
      },
      playlistCount: 14,
      paged: true,
    },
    "act-fixture-2": {
      name: "Recovery",
      description: { standard: "Slow songs for rest days.", short: "Rest" },
      playlistCount: 3,
      paged: false,
    },
  };
  const activityResource = (id) => ({
    id,
    type: "activities",
    attributes: {
      name: ACTIVITIES[id].name,
      description: clone(ACTIVITIES[id].description),
      url: `https://music.apple.com/us/activity/${id}/${id}`,
      artwork: polishArtwork(id),
      playParams: { id, kind: "activity" },
    },
  });
  const activityPlaylist = (activityId, number) => {
    const id = `${activityId}-pl-${String(number).padStart(2, "0")}`;
    return {
      id,
      type: "playlists",
      attributes: {
        name: `${ACTIVITIES[activityId].name} Mix ${number}`,
        curatorName: "Apple Music",
        trackCount: 10,
        artwork: polishArtwork(id),
        playParams: { id, kind: "playlist" },
      },
    };
  };
  const activityResponse = (id, params) => {
    const resource = activityResource(id);
    if (listParam(params.include).includes("playlists")) {
      const { playlistCount, paged } = ACTIVITIES[id];
      const playlists = {
        data: Array.from({ length: playlistCount }, (_, index) =>
          activityPlaylist(id, index + 1),
        ),
      };
      if (paged) {
        playlists.next = `/v1/catalog/us/activities/${id}/playlists?offset=${playlistCount}`;
      }
      resource.relationships = { playlists };
    }
    return { data: [resource] };
  };

  // Search groups for record labels and activities: two results each, and only
  // for the types the request names.
  const catalogExtraSearchGroups = (params) => {
    const types = listParam(params.types);
    const groups = {};
    if (types.includes("record-labels")) {
      groups["record-labels"] = {
        data: Object.keys(RECORD_LABELS).map((id) => recordLabelResource(id)),
      };
    }
    if (types.includes("activities")) {
      groups.activities = {
        data: Object.keys(ACTIVITIES).map((id) => activityResource(id)),
      };
    }
    return groups;
  };

  // Catalog song details. song-a is the library song "Track A" in its catalog
  // form; songs carry no copyright or recordLabel from Apple.
  const CATALOG_SONGS = {
    "song-a": {
      name: "Track A",
      trackNumber: 1,
      discNumber: 1,
      isrc: "USFIX2600001",
      composerName: "<b>Composer</b> A",
      genreNames: ["Pop", "Alternative"],
      releaseDate: "2026-03-01",
      contentRating: "explicit",
    },
    "song-c": {
      name: "Track C",
      trackNumber: 3,
      discNumber: 1,
      isrc: "USFIX2600003",
      composerName: "Composer C",
      genreNames: ["Alternative"],
      releaseDate: "2026-03-01",
    },
    // Get Info's catalog twin for get-info-song: a numeric ID, as Apple sends.
    1700000001: {
      name: "Info Track",
      trackNumber: 1,
      discNumber: 1,
      isrc: "USFIX2600009",
      composerName: "<b>Composer</b> A",
      genreNames: ["Pop", "Alternative"],
      releaseDate: "2026-03-01",
      contentRating: "explicit",
    },
  };
  const catalogSongResource = (id) => {
    const { name, ...details } = CATALOG_SONGS[id];
    return {
      id,
      type: "songs",
      attributes: {
        name,
        artistName: "Fixture Artist",
        albumName: "Fixture Album",
        durationInMillis: 180_000,
        ...details,
        artwork: polishArtwork(id),
        playParams: { id, kind: "song", catalogId: id },
      },
    };
  };

  // The catalog album that song-a and song-c belong to (include=albums).
  const catalogAlbumRef = () => ({
    id: "cat-album-1",
    type: "albums",
    href: "/v1/catalog/us/albums/cat-album-1",
    attributes: { name: "Fixture Album" },
  });
  const catalogAlbumResource = (params) => {
    const resource = {
      id: "cat-album-1",
      type: "albums",
      attributes: {
        name: "Fixture Album",
        artistName: "Fixture Artist",
        releaseDate: "2026-03-01",
        trackCount: albumItems.length,
        genreNames: ["Pop", "Alternative"],
        recordLabel: RECORD_LABELS["rl-fixture-1"].name,
        copyright: "℗ 2026 Fixture Records",
        url: "https://music.apple.com/us/album/fixture-album/cat-album-1",
        artwork: polishArtwork("cat-album-1"),
        playParams: { id: "cat-album-1", kind: "album" },
      },
    };
    if (listParam(params.include).includes("record-labels")) {
      resource.relationships = {
        "record-labels": { data: [recordLabelRef("rl-fixture-1")] },
      };
    }
    return resource;
  };
  // include=albums links the song's catalog album; Get Info reads it.
  const catalogSongWithIncludes = (id, params) => {
    const resource = catalogSongResource(id);
    if (listParam(params.include).includes("albums")) {
      resource.relationships = { albums: { data: [catalogAlbumRef()] } };
    }
    return resource;
  };

  // Library albums have no record-labels relationship on Apple. With
  // configure({ albumCatalogTwin: true }), album-1 links its catalog twin when
  // the request asks include=catalog; the label is read from that twin.
  const albumRelationships = (pathname, path, call) => {
    const relationships = {};
    if (
      state.albumCatalogTwin &&
      pathname === "/v1/me/library/albums/album-1" &&
      listParam(requestParams(path, call).include).includes("catalog")
    ) {
      relationships.catalog = { data: [catalogAlbumRef()] };
    }
    return relationships;
  };
  const albumDetailResponse = (pathname, path, call) => {
    const resource = clone(album);
    const relationships = albumRelationships(pathname, path, call);
    if (Object.keys(relationships).length) {
      resource.relationships = relationships;
    }
    return { data: [resource] };
  };
  // include=tracks carries the track page; record-labels may ride along.
  const includesTrackPage = (call) => {
    const include = listParam(call.query?.include);
    return (
      include.includes("tracks") &&
      include.every((name) => name === "tracks" || name === "record-labels")
    );
  };

  // Playlist folders and the playlists created under them (header comment).
  const parentIdOf = (payload) => {
    const ref = payload.relationships?.parent?.data?.[0];
    return ref && typeof ref.id === "string" && ref.id.length > 0
      ? ref.id
      : undefined;
  };
  const createLibraryFolder = (body) => {
    const payload = body && typeof body === "object" ? body : {};
    const attributes =
      payload.attributes && typeof payload.attributes === "object"
        ? payload.attributes
        : {};
    const name =
      typeof attributes.name === "string" && attributes.name.trim()
        ? attributes.name.trim()
        : "Untitled Folder";
    const parentId = parentIdOf(payload) ?? null;
    const id = `saved-folder-${state.nextCreatedFolderId}`;
    state.nextCreatedFolderId += 1;
    const folder = {
      id,
      parentId,
      resource: {
        id,
        type: "library-playlist-folders",
        attributes: { name },
      },
    };
    state.createdFolders.push(folder);
    state.playlistFolderCreates.push({ id, name, parentId });
    return folder;
  };
  const createdChildrenFor = (pathname) => {
    const match = pathname.match(/\/playlist-folders\/([^/]+)\/children$/u);
    if (!match) return [];
    const parentId = decodeURIComponent(match[1]);
    return [
      ...state.createdFolders
        .filter((entry) => entry.parentId === parentId)
        .map((entry) => clone(entry.resource)),
      ...state.createdPlaylists
        .filter((entry) => entry.parentId === parentId)
        .map((entry) => clone(entry.resource)),
    ];
  };

  // Routes for the catalog extras; undefined means "not one of these".
  const catalogExtrasResponse = (pathname, path, call) => {
    const params = requestParams(path, call);
    if (pathname === "/v1/me/music-summaries") {
      return state.replay === "empty" ? { data: [] } : replayResponse(params);
    }
    const labelRoute = pathname.match(
      /^\/v1\/catalog\/us\/record-labels\/([^/]+)$/u,
    );
    if (labelRoute) {
      const id = decodeURIComponent(labelRoute[1]);
      return Object.hasOwn(RECORD_LABELS, id)
        ? recordLabelResponse(id, params)
        : { data: [] };
    }
    const activityRoute = pathname.match(
      /^\/v1\/catalog\/us\/activities\/([^/]+)$/u,
    );
    if (activityRoute) {
      const id = decodeURIComponent(activityRoute[1]);
      return Object.hasOwn(ACTIVITIES, id)
        ? activityResponse(id, params)
        : { data: [] };
    }
    if (pathname === "/v1/catalog/us/songs" && params.ids !== undefined) {
      const ids = listParam(params.ids).filter((id) =>
        Object.hasOwn(CATALOG_SONGS, id),
      );
      if (ids.length) {
        return {
          data: ids.map((id) => catalogSongWithIncludes(id, params)),
        };
      }
    }
    if (pathname === "/v1/catalog/us/albums/cat-album-1") {
      return { data: [catalogAlbumResource(params)] };
    }
    const songRoute = pathname.match(/^\/v1\/catalog\/us\/songs\/([^/]+)$/u);
    if (songRoute) {
      const id = decodeURIComponent(songRoute[1]);
      if (Object.hasOwn(CATALOG_SONGS, id)) {
        return { data: [catalogSongWithIncludes(id, params)] };
      }
    }
    return undefined;
  };

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
    Object.assign(results, catalogExtraSearchGroups(params));
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
    "/v1/me/library/albums/album-long",
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

  // Playlist creates and track adds are recorded so save-as-playlist can prove
  // its batching. Created playlists answer detail and track reads below.
  const PLAYLIST_MUTATION_PAGE_SIZE = 100;
  const playlistAddRequest = (pathname, body) => {
    const match = pathname.match(
      /^\/v1\/me\/library\/playlists\/([^/]+)\/tracks$/u,
    );
    if (!match) return undefined;
    const payload = body && typeof body === "object" ? body : {};
    const data = Array.isArray(payload.data) ? payload.data : [];
    const refs = data.filter(
      (ref) => ref && typeof ref.id === "string" && ref.id.length > 0,
    );
    return {
      playlistId: decodeURIComponent(match[1]),
      refs,
      ids: refs.map((ref) => ref.id),
    };
  };
  const savedPlaylistTrack = (ref, index) => {
    const item = track(ref.id, ref.id, "Saved Playlist Album");
    if (typeof ref.type === "string" && ref.type) item.type = ref.type;
    item.attributes.trackNumber = index + 1;
    return item;
  };
  const createLibraryPlaylist = (body) => {
    const payload = body && typeof body === "object" ? body : {};
    const attributes =
      payload.attributes && typeof payload.attributes === "object"
        ? payload.attributes
        : {};
    const name =
      typeof attributes.name === "string" && attributes.name.trim()
        ? attributes.name.trim()
        : "Untitled Playlist";
    const description =
      typeof attributes.description === "string" && attributes.description
        ? attributes.description
        : undefined;
    const relationship = payload.relationships?.tracks;
    const data = Array.isArray(relationship?.data) ? relationship.data : [];
    const refs = data.filter(
      (ref) => ref && typeof ref.id === "string" && ref.id.length > 0,
    );
    const parentId = parentIdOf(payload);
    const id = `saved-playlist-${state.nextCreatedPlaylistId}`;
    state.nextCreatedPlaylistId += 1;
    const playlist = {
      id,
      resource: {
        id,
        type: "library-playlists",
        attributes: {
          name,
          artistName: "Arlet E2E",
          trackCount: refs.length,
          canEdit: true,
          ...(description ? { description } : {}),
        },
      },
      tracks: refs.map(savedPlaylistTrack),
      parentId,
    };
    state.createdPlaylists.push(playlist);
    state.playlistCreates.push({
      id,
      name,
      trackIds: playlist.tracks.map((item) => item.id),
      ...(parentId ? { parentId } : {}),
    });
    return playlist;
  };
  const createdPlaylistFor = (pathname) => {
    const match = pathname.match(
      /^\/v1\/me\/library\/playlists\/([^/]+)(\/tracks)?$/u,
    );
    if (!match) return undefined;
    const playlist = state.createdPlaylists.find(
      (entry) => entry.id === decodeURIComponent(match[1]),
    );
    return playlist ? { playlist, tracks: Boolean(match[2]) } : undefined;
  };
  const createdPlaylistTracksPage = (playlist, path) => {
    const pathname = String(path).split("?", 1)[0];
    const offset =
      Math.max(
        0,
        Math.floor(
          Number(
            new URLSearchParams(String(path).split("?")[1] ?? "").get(
              "offset",
            ) ?? 0,
          ),
        ),
      ) || 0;
    const end = Math.min(
      playlist.tracks.length,
      offset + PLAYLIST_MUTATION_PAGE_SIZE,
    );
    return {
      data: playlist.tracks.slice(offset, end).map(clone),
      ...(end < playlist.tracks.length
        ? { next: `${pathname}?offset=${end}` }
        : {}),
    };
  };
  const playlistMutationResponse = (pathname, call) => {
    if (call.method !== "POST") return undefined;
    if (pathname === "/v1/me/library/playlists") {
      return { data: [clone(createLibraryPlaylist(call.body).resource)] };
    }
    if (pathname === "/v1/me/library/playlist-folders") {
      return { data: [clone(createLibraryFolder(call.body).resource)] };
    }
    const add = playlistAddRequest(pathname, call.body);
    if (!add) return undefined;
    state.playlistAdds.push({
      playlistId: add.playlistId,
      ids: add.ids,
      failed: false,
    });
    const playlist = state.createdPlaylists.find(
      (entry) => entry.id === add.playlistId,
    );
    if (playlist) {
      const start = playlist.tracks.length;
      playlist.tracks.push(
        ...add.refs.map((ref, index) => savedPlaylistTrack(ref, start + index)),
      );
      playlist.resource.attributes.trackCount = playlist.tracks.length;
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
      ratingResponse(pathname, call) ??
      libraryResponse(pathname, call) ??
      playlistMutationResponse(pathname, call);
    if (mutation) return mutation;
    const pinArt = pinArtResponse(pathname, path, call);
    if (pinArt !== undefined) return pinArt;
    const artwork = artworkGridResponse(pathname, path, call);
    if (artwork !== undefined) return artwork;
    const discovered = discoveryResponse(pathname, path, call);
    if (discovered !== undefined) return discovered;
    const extras = catalogExtrasResponse(pathname, path, call);
    if (extras !== undefined) return extras;
    if (pathname === "/v1/me/storefront") {
      return { data: [{ id: "us", type: "storefronts" }] };
    }
    // `include=tracks` carries the first track page in `relationships.tracks`,
    // with the same `next` as the tracks endpoint, so callers page on as before.
    if (
      includesTrackPage(call) &&
      (TRACK_DETAIL_PATHS.has(pathname) || createdPlaylistFor(pathname))
    ) {
      const detail = responseFor(pathname, { method: "GET" });
      const page = responseFor(`${pathname}/tracks`, { method: "GET" });
      const [resource] = detail.data ?? [];
      if (resource) {
        resource.relationships = {
          ...albumRelationships(pathname, pathname, call),
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
          ? [
              ...libraryViewPlaylists,
              ...state.createdPlaylists.map((entry) => entry.resource),
            ]
          : [
              playlist,
              bigPlaylist,
              ...state.createdPlaylists.map((entry) => entry.resource),
            ];
      const ids = String(call.query.ids).split(",").filter(Boolean);
      // Ids come back in the order asked for; unknown ids are skipped.
      return {
        data: ids.flatMap((id) => {
          const match = playlists.find((entry) => entry.id === id);
          return match ? [clone(match)] : [];
        }),
      };
    }
    const createdPlaylist = createdPlaylistFor(pathname);
    if (createdPlaylist) {
      return createdPlaylist.tracks
        ? createdPlaylistTracksPage(createdPlaylist.playlist, path)
        : itemResponse(createdPlaylist.playlist.resource);
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
      return albumDetailResponse(pathname, path, call);
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
    if (pathname === "/v1/me/library/albums/album-long") {
      return itemResponse(longAlbum);
    }
    if (pathname === "/v1/me/library/albums/album-long/tracks") {
      return { data: longAlbumItems.map(clone) };
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
      // Items created under this folder in the session follow the seed items.
      const created = createdChildrenFor(pathname);
      if (state.libraryView) {
        if (pathname.includes("/fixture-playlists-root/")) {
          return { data: [clone(libraryViewFolder), ...created] };
        }
        if (pathname.includes(`/${LIBRARY_VIEW_FOLDER_ID}/`)) {
          return {
            data: [
              ...libraryViewPlaylists
                .filter((item) => libraryViewFolderMembers.includes(item.id))
                .map(clone),
              ...created,
            ],
          };
        }
      }
      return { data: created };
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
      listed.push(
        ...state.createdPlaylists.map((entry) => clone(entry.resource)),
      );
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
      const extras = catalogExtraSearchGroups(requestParams(path, call));
      // Only a term containing "polish" reaches the polish ids.
      if (/polish/iu.test(String(call.query?.term ?? ""))) {
        return {
          results: {
            albums: { data: [clone(polishAlbum), clone(polishSparseAlbum)] },
            playlists: { data: [clone(polishPlaylist)] },
            songs: { data: polishAlbumTracks.map(clone) },
            ...extras,
          },
        };
      }
      return {
        results: { songs: { data: topSongItems.map(clone) }, ...extras },
      };
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
    const failingPage = state.failNextLibraryPage;
    if (
      failingPage &&
      request.method === "GET" &&
      pathText.includes(failingPage.path)
    ) {
      if (failingPage.once) state.failNextLibraryPage = null;
      request.failedPage = true;
      request.error = `Fixture page rejected: ${pathText}`;
      throw new Error(request.error);
    }
    const playlistAdd =
      request.method === "POST"
        ? playlistAddRequest(pathText.split("?", 1)[0], request.body)
        : undefined;
    if (playlistAdd) {
      state.playlistAddAttempts += 1;
      const fail = state.failNextPlaylistAdd;
      if (fail && state.playlistAddAttempts === fail.nth) {
        if (fail.once !== false) state.failNextPlaylistAdd = null;
        state.playlistAdds.push({
          playlistId: playlistAdd.playlistId,
          ids: playlistAdd.ids,
          failed: true,
        });
        request.failedPlaylistAdd = true;
        request.error = `Fixture playlist add rejected: ${pathText}`;
        throw new Error(request.error);
      }
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
    // On a real account, a library artist's albums relationship answered 404.
    if (
      pathText.split("?", 1)[0] ===
      "/v1/me/library/artists/library-artist-views/albums"
    ) {
      const error = fixtureHttpError(404, "NOT_FOUND");
      request.error = error.message;
      request.status = 404;
      throw error;
    }
    const replayFailure = replayFailureFor(pathText.split("?", 1)[0], params);
    if (replayFailure) {
      const error = fixtureHttpError(replayFailure.status, replayFailure.code);
      request.error = error.message;
      request.status = replayFailure.status;
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

  const assertSelectable = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) {
      throw new Error(`Fixture queue index unavailable: ${index}`);
    }
  };
  const selectIndex = async (index, transitionType = "selectIndex") => {
    assertSelectable(index);
    state.queueIndex = index;
    state.transitions.push({
      type: transitionType,
      index,
      id: currentItem()?.id,
      total: state.queue.length,
    });
    syncProviderQueue(true, true);
    topUpAutoplay();
    return index;
  };
  // Live MKInstance.changeToMediaAtIndex and changeToMediaItem call stop()
  // first (header comment). The nowPlayingItem clear comes before the state
  // change, as in live stopMediaAndCleanup. Then the new item plays.
  const selectWithStop = async (index) => {
    if (!state.selectStops) return selectIndex(index);
    assertSelectable(index);
    const previous = currentItem();
    const oldState = instance.playbackState;
    state.transitions.push({ type: "selectStop", index });
    state.nowPlayingCleared = true;
    emit(events.nowPlayingItemDidChange, { item: undefined });
    if (oldState !== STOPPED) {
      instance.playbackState = STOPPED;
      emit(events.playbackStateDidChange, {
        oldState,
        state: STOPPED,
        nowPlayingItem: previous,
      });
    }
    state.nowPlayingCleared = false;
    const pending = selectIndex(index);
    instance.playbackState = PLAYING;
    emit(events.playbackStateDidChange, {
      oldState: STOPPED,
      state: PLAYING,
      nowPlayingItem: currentItem(),
    });
    return pending;
  };
  // Repeat One (Next, Previous) and Previous on the first song restart the
  // playing song in place: the index stays put and the time goes to zero.
  const restartCurrent = (type) => {
    state.transitions.push({
      type,
      index: state.queueIndex,
      id: currentItem()?.id ?? null,
      total: state.queue.length,
    });
    emit(events.playbackTimeDidChange, {
      currentPlaybackTime: 0,
      currentPlaybackDuration: 180,
    });
    return state.queueIndex;
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
  // which is synchronous and returns the removed MediaItems. Like the live
  // spliceQueueItems, it leaves the queue index alone and does not refuse to
  // remove the playing item; the app decides what plays next. A configured
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
    const removed = state.queue.splice(start, deleteCount, ...items);
    // The live splice applies the same arguments to the add-order IDs, so a
    // repeated song loses only the occurrence at `start`, not every copy.
    state.unshuffledIds.splice(
      start,
      deleteCount,
      ...items.map((item) => item.id),
    );
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
    topUpAutoplay();
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

  instance = {
    developerToken: "fixture-developer-token",
    musicUserToken: "fixture-music-user-token",
    isAuthorized: true,
    storefrontId: "us",
    storefrontCountryCode: "us",
    // Live instance.bitrate: 64 or 256 (header comment). Setting it emits only
    // on a change.
    get bitrate() {
      return state.bitrate;
    },
    set bitrate(value) {
      setBitrate(value);
    },
    // Live hasMusicSubscription: a Promise that resolves after subscriptionDelayMs.
    async hasMusicSubscription() {
      if (state.subscriptionDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, state.subscriptionDelayMs),
        );
      }
      return hasSubscription();
    },
    // Live preview-only mode is the no-subscription mode (header comment).
    get previewOnly() {
      return !state.subscription;
    },
    // The live storekit deeplink for subscribe, with no extra parameters.
    get subscribeURL() {
      return "https://finance-app.itunes.apple.com/deeplink?p=subscribe";
    },
    // Removing this property simulates a runtime without autoplay support.
    get autoplayEnabled() {
      return readAutoplayEnabled();
    },
    set autoplayEnabled(value) {
      setAutoplayEnabled(value);
    },
    // Live Capabilities: Shuffle and Repeat are not settable while the current
    // song is an autoplay song (header comment).
    get canSetShuffleMode() {
      return currentItem()?.isAutoplay !== true;
    },
    get canSetRepeatMode() {
      return currentItem()?.isAutoplay !== true;
    },
    playbackState: STOPPED,
    // Live v3 keeps these on the instance; there is no `player` object.
    // `shuffle` is write-only in live v3: it is an alias for shuffleMode.
    set shuffle(value) {
      instance.shuffleMode =
        value === true ? PlayerShuffleMode.songs : PlayerShuffleMode.off;
    },
    // MusicKit v3 reads shuffle through `shuffleMode` (0 off, 1 songs).
    get shuffleMode() {
      return shuffleModeOf();
    },
    set shuffleMode(value) {
      // Live BaseShuffler ignores the write on a station: no change, no event.
      if (
        state.isStation ||
        value === state.shuffleMode ||
        (value !== PlayerShuffleMode.off && value !== PlayerShuffleMode.songs)
      ) {
        return;
      }
      const playingId = currentItem()?.id;
      const oldPosition = queueRecord.position;
      state.shuffleMode = value;
      if (value === PlayerShuffleMode.songs) shuffleQueue();
      else unshuffleQueue();
      // Live quirk, on purpose (docs/TESTING.md "Shuffle model"): live sets the
      // position to queue.indexForItem(nowPlayingItem.id), which is the FIRST
      // copy of a repeated song, so the playing copy can change here.
      // The position moves to the playing song before any event fires.
      if (playingId !== undefined) {
        const index = state.queue.findIndex((item) => item.id === playingId);
        if (index > -1) state.queueIndex = index;
      }
      state.transitions.push({
        type: "shuffleMode",
        mode: value,
        index: queueRecord.position,
        id: currentItem()?.id ?? null,
      });
      emit(events.queueItemsDidChange, [...state.queue]);
      if (queueRecord.position !== oldPosition) {
        emit(events.queuePositionDidChange, {
          oldPosition,
          position: queueRecord.position,
        });
      }
      emit(events.shuffleModeDidChange, value);
    },
    get repeatMode() {
      return repeatModeOf();
    },
    // Only the live values 0, 1 and 2 are accepted. A change emits the new mode.
    // On a station the write is ignored (live BaseRepeatable), with no event.
    set repeatMode(value) {
      if (
        state.isStation ||
        !REPEAT_MODES.includes(value) ||
        value === state.repeatMode
      ) {
        return;
      }
      state.repeatMode = value;
      emit(events.repeatModeDidChange, value);
      // Live onRepeatModeChange: none tops up, one and all drop upcoming autoplay.
      if (value === PlayerRepeatMode.none) topUpAutoplay();
      else removeUpcomingAutoplay();
    },
    get nowPlayingItemIndex() {
      return state.queue.length ? state.queueIndex : -1;
    },
    changeToMediaItem: (descriptor) => {
      const id = typeof descriptor === "string" ? descriptor : descriptor?.id;
      const index = state.queue.findIndex((item) => item.id === id);
      return selectWithStop(index);
    },
    api: createApi(0),
    get queueItems() {
      return state.queue;
    },
    get queue() {
      // Live always has instance.queue, and Arlet reads the autoplay flags
      // from it (hasAutoplayStation, autoplayItems). Without nativeQueueEdit
      // it is the base record, which has no splice, so the app rebuilds.
      // Test-only: hideQueueSplice does the same with the flags present.
      if (!state.nativeQueueEdit || state.hideQueueSplice) return queueRecord;
      return nativeQueue;
    },
    get currentPlaybackQueueItemIndex() {
      return state.queue.length ? state.queueIndex : -1;
    },
    get currentPlaybackQueueItem() {
      return currentItem();
    },
    get nowPlayingItem() {
      return state.nowPlayingCleared ? undefined : currentItem();
    },
    get volume() {
      return state.volume;
    },
    // The event carries no level, so readers take it from instance.volume.
    set volume(value) {
      if (applyVolume(value)) {
        emit(events.playbackVolumeDidChange, { type: "volumechange" });
      }
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
      state.setQueueStarts += 1;
      if (state.setQueueDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, state.setQueueDelayMs),
        );
      }
      if (state.holdSetQueue) {
        await new Promise((resolve) => state.setQueueReleases.push(resolve));
      }
      if (state.rejectSetQueue) {
        state.transitions.push({ type: "setQueueRejected" });
        const error = new Error("Fixture queue setup failed");
        error.errorCode = "UNKNOWN_ERROR";
        error.reason = "UNKNOWN_ERROR";
        throw error;
      }
      const itemIds = loadQueueItems(
        "setQueue",
        idsFromOptions(options),
        options,
      );
      const items = itemIds.map(mediaItem);
      // MusicKit positions the new queue on `startWith` (index or item ID).
      // With shuffle on, the position then points at whatever song the shuffle
      // left there.
      const startWith = options?.startWith;
      const startIndex =
        typeof startWith === "string"
          ? items.findIndex((item) => item.id === startWith)
          : Number.isInteger(startWith)
            ? startWith
            : 0;
      // A station replaces the queue as a station; any other setQueue leaves it.
      state.isStation = isStationOptions(options);
      // A new queue ends the old station (live replaceQueue, stopAutoplay).
      state.autoplayStationId = null;
      replaceQueue(
        items,
        startIndex >= 0 && startIndex < items.length ? startIndex : 0,
      );
      state.transitions.push({
        type: "setQueue",
        ids: [...itemIds],
        index: state.queueIndex,
        options: clone(options),
        shape: Object.keys(options ?? {}),
        shuffle: shuffleModeOf() === PlayerShuffleMode.songs,
      });
      syncProviderQueue(true, true);
      // Live setQueue awaits the station requests before it resolves.
      startAutoplayStation();
      return queueRecord;
    },
    changeToMediaAtIndex: (index) => selectWithStop(index),
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
      emit(events.nowPlayingItemDidChange, { item: null });
    },
    async skipToNextItem() {
      if (state.rejectSkip) {
        state.transitions.push({ type: "skipRejected" });
        throw new Error("Fixture skip rejected");
      }
      if (!state.queue.length) return -1;
      if (state.repeatMode === PlayerRepeatMode.one) {
        return restartCurrent("restartRepeatOne");
      }
      // Linear under shuffle too: the queue already holds the shuffled order.
      const index =
        state.queueIndex + 1 < state.queue.length
          ? state.queueIndex + 1
          : state.repeatMode === PlayerRepeatMode.all
            ? 0
            : state.queueIndex;
      return selectIndex(index, "next");
    },
    async skipToPreviousItem() {
      if (!state.queue.length) return -1;
      if (state.repeatMode === PlayerRepeatMode.one) {
        return restartCurrent("restartRepeatOne");
      }
      const index =
        state.queueIndex > 0
          ? state.queueIndex - 1
          : state.repeatMode === PlayerRepeatMode.all
            ? state.queue.length - 1
            : undefined;
      if (index === undefined) return restartCurrent("restartFirst");
      return selectIndex(index, "previous");
    },
    async seekToTime(time) {
      state.transitions.push({ type: "seekToTime", seconds: time });
      if (state.holdSeek) {
        await new Promise((resolve) => state.seekReleases.push(resolve));
      }
      emit(events.playbackTimeDidChange, {
        currentPlaybackTime: time,
        currentPlaybackDuration: playbackDurationNow(),
      });
    },
    async playNext(options) {
      const itemIds = loadQueueItems(
        "playNext",
        idsFromOptions(options),
        options,
      );
      if (state.isStation) {
        throw stationRejected(
          "playNext",
          "Prepending to the Queue is not supported for this type of playback",
        );
      }
      const start = Math.min(state.queue.length, state.queueIndex + 1);
      const added = itemIds.map(mediaItem);
      state.queue.splice(start, 0, ...added);
      state.unshuffledIds.splice(start, 0, ...added.map((item) => item.id));
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
      if (state.isStation) {
        throw stationRejected(
          "playLater",
          "Appending to the Queue is not supported for this type of playback",
        );
      }
      // Live appendToQueue splices at appendTargetIndex, before autoplay songs.
      // Add order only tracks user songs, so the IDs go on the end of it.
      const start = queueRecord.appendTargetIndex;
      const added = itemIds.map(mediaItem);
      state.queue.splice(start, 0, ...added);
      state.unshuffledIds.push(...added.map((item) => item.id));
      state.transitions.push({
        type: "playLater",
        ids: [...itemIds],
        shape: Object.keys(options ?? {}),
      });
      syncProviderQueue(true, false);
    },
    // Live Queue.clear empties the queue. A station rejects it instead.
    async clearQueue() {
      if (state.isStation) {
        throw stationRejected(
          "clearQueue",
          "Clearing the Queue is not supported for this type of playback",
        );
      }
      state.queue = [];
      state.unshuffledIds = [];
      state.queueIndex = 0;
      state.transitions.push({ type: "clearQueue" });
      syncProviderQueue(true, true);
      return queueRecord;
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
    seed: fixtureSeed,
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
      if (
        Object.prototype.hasOwnProperty.call(options, "failNextLibraryPage")
      ) {
        const value = options.failNextLibraryPage;
        state.failNextLibraryPage = value
          ? {
              path: String(value.path ?? value.endpoint ?? value),
              once: value.once !== false,
            }
          : null;
      }
      if (
        Object.prototype.hasOwnProperty.call(options, "failNextPlaylistAdd")
      ) {
        const value = options.failNextPlaylistAdd;
        state.failNextPlaylistAdd = value
          ? {
              nth: Math.max(1, Math.floor(Number(value.nth ?? value)) || 1),
              once: value.once !== false,
            }
          : null;
        state.playlistAddAttempts = 0;
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
      if (Object.prototype.hasOwnProperty.call(options, "rejectSetQueue")) {
        state.rejectSetQueue = options.rejectSetQueue === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "rejectSkip")) {
        state.rejectSkip = options.rejectSkip === true;
      }
      if (
        Object.prototype.hasOwnProperty.call(options, "longLabelDescription")
      ) {
        state.longLabelDescription = options.longLabelDescription === true;
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
      if (Object.prototype.hasOwnProperty.call(options, "albumCatalogTwin")) {
        state.albumCatalogTwin = options.albumCatalogTwin === true;
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
      if (Object.prototype.hasOwnProperty.call(options, "replay")) {
        if (!REPLAY_MODES.includes(options.replay)) {
          throw new Error(
            `Fixture replay mode unknown: ${String(options.replay)}`,
          );
        }
        state.replay = options.replay;
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
      if (Object.prototype.hasOwnProperty.call(options, "hideQueueSplice")) {
        state.hideQueueSplice = options.hideQueueSplice === true;
      }
      if (Object.prototype.hasOwnProperty.call(options, "setQueueDelayMs")) {
        state.setQueueDelayMs = Math.max(
          0,
          Number(options.setQueueDelayMs) || 0,
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
      if (Object.prototype.hasOwnProperty.call(options, "selectStops")) {
        state.selectStops = options.selectStops !== false;
      }
      if (Object.prototype.hasOwnProperty.call(options, "autoplayStation")) {
        const value = options.autoplayStation;
        if (value !== "refused" && value !== "ok") {
          throw new Error(
            `Fixture autoplayStation must be "refused" or "ok": ${value}`,
          );
        }
        state.autoplayStation = value;
      }
      if (Object.prototype.hasOwnProperty.call(options, "startupBitrate")) {
        const value = Number(options.startupBitrate);
        if (
          value !== PlaybackBitrate.STANDARD &&
          value !== PlaybackBitrate.HIGH
        ) {
          throw new Error(
            `Fixture startupBitrate must be 64 or 256: ${options.startupBitrate}`,
          );
        }
        state.startupBitrate = value;
      }
      if (Object.prototype.hasOwnProperty.call(options, "subscription")) {
        state.subscription = options.subscription !== false;
      }
      if (
        Object.prototype.hasOwnProperty.call(options, "subscriptionDelayMs")
      ) {
        state.subscriptionDelayMs = Math.max(
          0,
          Number(options.subscriptionDelayMs) || 0,
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
      state.failNextLibraryPage = null;
      state.failNextPlaylistAdd = null;
      state.playlistAddAttempts = 0;
      state.playlistCreates = [];
      state.playlistAdds = [];
      state.createdPlaylists = [];
      state.nextCreatedPlaylistId = 1;
      state.createdFolders = [];
      state.nextCreatedFolderId = 1;
      state.playlistFolderCreates = [];
      state.delayMs = 800;
      state.repeatPlaylistCursor = false;
      state.rejectPlay = false;
      state.rejectPlayTimes = 0;
      state.rejectSetQueue = false;
      state.rejectSkip = false;
      state.longLabelDescription = false;
      state.playlistPrepended = false;
      state.unresolvedIds = [];
      state.detailsSkipLookup = false;
      state.unplayableIds = [];
      state.nativeQueueEdit = false;
      state.hideQueueSplice = false;
      state.queueEditDelayMs = 0;
      state.setQueueDelayMs = 0;
      state.holdSetQueue = false;
      releaseHeldSetQueue();
      state.setQueueStarts = 0;
      state.holdSeek = false;
      releaseHeldSeeks();
      state.ratings = {};
      state.libraryAdds = [];
      state.librarySize = 0;
      state.libraryView = false;
      state.albumCatalogTwin = false;
      state.artworkTemplate = "";
      state.artworkGrid = false;
      state.pinArtListExpired = false;
      state.replay = "data";
      state.delayTerms = {};
      state.rejectQueryKeys = [];
      state.repeatViewCursor = false;
      state.liveMetadata = null;
      state.rejectMeStatus = 0;
      state.rejectAuthorize = false;
      state.hangAuthorize = false;
      releaseHeldAuthorize();
      state.selectStops = true;
      state.subscription = true;
      state.subscriptionDelayMs = 0;
      // The configured startup applies here, then the startup returns to 256.
      setBitrate(state.startupBitrate, false);
      state.startupBitrate = PlaybackBitrate.HIGH;
      state.nowPlayingCleared = false;
      state.isStation = false;
      state.autoplayStation = "refused";
      state.autoplayStationId = null;
      state.autoplaySerial = 0;
      state.queue = [];
      state.queueIndex = 0;
      const shuffleChanged = state.shuffleMode !== PlayerShuffleMode.off;
      state.shuffleMode = PlayerShuffleMode.off;
      state.unshuffledIds = [];
      state.random = createRandom(fixtureSeed);
      // The setter emits only when the mode actually changes.
      instance.repeatMode = PlayerRepeatMode.none;
      state.volume = 1;
      instance.playbackState = STOPPED;
      syncProviderQueue(true, true);
      if (shuffleChanged) {
        emit(events.shuffleModeDidChange, PlayerShuffleMode.off);
      }
      return true;
    },
    setCurrentTrack(id) {
      const item = mediaItem(String(id));
      // A single song replaces any station queue, as a songs queue does. It
      // ends the autoplay station too, but starts none (header comment).
      state.isStation = false;
      state.autoplayStationId = null;
      replaceQueue([item], 0);
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
    // Turning shuffle on mid-song, as the app does it: the playing song keeps
    // its place as the position moves to it (shuffleMode setter). Returns
    // false with nothing playing.
    shuffleLikeMusicKit() {
      if (!currentItem()) return false;
      instance.shuffleMode = PlayerShuffleMode.songs;
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
      if (state.repeatMode === PlayerRepeatMode.one) {
        // Repeat One replays the same song when it ends naturally.
      } else if (state.queueIndex + 1 < state.queue.length) {
        nextIndex = state.queueIndex + 1;
        transitionType = "finishNext";
      } else if (state.repeatMode === PlayerRepeatMode.all) {
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
      if (state.autoplayStation === "ok") {
        // With a station the autoplay songs are already queued (header comment).
        const next = state.queueIndex + 1;
        if (
          next < state.queue.length &&
          state.queue[next].isAutoplay === true &&
          state.repeatMode === PlayerRepeatMode.none
        ) {
          return selectIndex(next, "finishAutoplay");
        }
        return this.finishCurrentTrack();
      }
      // Refused mode keeps the old result the desktop check relies on.
      if (
        state.queueIndex + 1 >= state.queue.length &&
        state.repeatMode === PlayerRepeatMode.none &&
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
        if (!("autoplayEnabled" in instance)) {
          // Puts back the accessor that delete removed, and keeps the old
          // result of true (no event, as a plain assignment had none).
          Object.defineProperty(instance, "autoplayEnabled", {
            configurable: true,
            enumerable: true,
            get: readAutoplayEnabled,
            set: setAutoplayEnabled,
          });
          state.autoplayEnabled = true;
        }
      } else {
        delete instance.autoplayEnabled;
      }
      emit(events.shuffleModeDidChange, shuffleModeOf());
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
      // Only numeric catalog IDs, the form Apple sends; other fixture IDs keep
      // the target they had, so their menus are unchanged.
      const catalogId = String(item.attributes?.playParams?.catalogId ?? "");
      if (/^\d+$/u.test(catalogId)) {
        target.dataset.contextCatalogId = catalogId;
      }
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
    // A bitrate change as live's downlink calculator makes it (header comment).
    // Returns whether the value changed.
    emitBitrateChange(value) {
      const bitrate = Number(value);
      if (
        bitrate !== PlaybackBitrate.STANDARD &&
        bitrate !== PlaybackBitrate.HIGH
      ) {
        throw new Error(`Fixture bitrate change must be 64 or 256: ${value}`);
      }
      return setBitrate(bitrate);
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
      applyVolume(value);
      emit(events.playbackVolumeDidChange, { type: "volumechange" });
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
      state.isStation = false;
      state.autoplayStationId = null;
      replaceQueue(
        Array.from({ length: count }, (_, index) => mediaItem(`bulk-${index}`)),
        0,
      );
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
          spliceHidden: state.hideQueueSplice,
          delayMs: state.queueEditDelayMs,
          setQueueDelayMs: state.setQueueDelayMs,
          setQueueStarts: state.setQueueStarts,
          setQueueHeld: state.setQueueReleases.length,
        },
        seekHeld: state.seekReleases.length,
        queue: captureQueue(),
        playlistMutations: {
          creates: clone(state.playlistCreates),
          adds: clone(state.playlistAdds),
          folders: clone(state.playlistFolderCreates),
          created: state.createdPlaylists.map((entry) => ({
            id: entry.id,
            trackIds: entry.tracks.map((item) => item.id),
            trackCount: entry.resource.attributes.trackCount,
          })),
        },
        modes: {
          shuffle: shuffleModeOf() === PlayerShuffleMode.songs,
          repeat: repeatModeOf(),
        },
        volume: state.volume,
        bitrate: { current: state.bitrate, startup: state.startupBitrate },
        subscription: {
          has: hasSubscription(),
          previewOnly: instance.previewOnly,
        },
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
          failNextLibraryPage: state.failNextLibraryPage
            ? clone(state.failNextLibraryPage)
            : null,
          failNextPlaylistAdd: state.failNextPlaylistAdd
            ? clone(state.failNextPlaylistAdd)
            : null,
          rejectQueryKeys: clone(state.rejectQueryKeys),
          rejectMeStatus: state.rejectMeStatus,
          rejectAuthorize: state.rejectAuthorize,
          rejectPlay: state.rejectPlay,
          rejectPlayTimes: state.rejectPlayTimes,
          rejectSetQueue: state.rejectSetQueue,
          rejectSkip: state.rejectSkip,
          longLabelDescription: state.longLabelDescription,
          repeatPlaylistCursor: state.repeatPlaylistCursor,
          repeatViewCursor: state.repeatViewCursor,
          pinArtListExpired: state.pinArtListExpired,
          replay: state.replay,
          selectStops: state.selectStops,
          autoplayStation: state.autoplayStation,
          subscription: state.subscription,
          subscriptionDelayMs: state.subscriptionDelayMs,
          startupBitrate: state.startupBitrate,
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
    PlayerRepeatMode,
    PlayerShuffleMode,
    PlaybackBitrate,
    PlaybackStates: {
      none: 0,
      loading: 1,
      playing: PLAYING,
      paused: PAUSED,
      stopped: STOPPED,
      ended: 5,
      seeking: 6,
      waiting: 8,
      stalled: 9,
      completed: 10,
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

export const musicFixtureSource = `(${installMusicKitFixture.toString()})(${JSON.stringify(MUSIC_FIXTURE_SEED)});`;
