# MusicKit Feature Coverage

This page maps what Arlet uses from MusicKit JS v3 and the Apple Music API as of
v0.4.0-beta.5. It has three parts: what Arlet supports, what it leaves out on
purpose, and what Apple's public API cannot do. The runtime facts (enums,
bitrates, event behavior) were checked against live MusicKit JS 3.2526.0. The
hosts and endpoints are in [MUSICKIT_NETWORK_SURFACE.md](MUSICKIT_NETWORK_SURFACE.md),
and the checks that prove each feature are in [TESTING.md](TESTING.md).

## Supported

### Features

| Feature                   | How it works                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeat All and Repeat One | MusicKit repeat modes. With Repeat One, Next and Previous move between songs. With Repeat All, the last song loops to the first song of the list.                      |
| Shuffle                   | Apple-style shuffle of the whole collection. Turning it on mid-album keeps the earlier songs. Turning it off returns to collection order after the playing occurrence. |
| Selecting a song          | A chosen song in Playing Next starts without flashing the player or Windows media controls. Arlet ignores the `stop()` echo MusicKit sends first.                      |
| Stations                  | Shuffle and Repeat are hidden. Play Next, Play Later, and Clear explain that they are not available.                                                                   |
| Autoplay                  | Autoplay songs show under an "Autoplay" heading with an on/off toggle. They are left out of saved sessions, stream handoff, and Save as playlist.                      |
| Audio quality             | High (256 kbps, the default), Standard (64 kbps), or Automatic (MusicKit's choice). The setting applies from the next song, and Settings shows "Streaming at N kbps".  |
| Previews only             | Non-subscribers see a "Previews only" notice with a Subscribe button. `open_subscribe_link` opens only Apple's own https pages.                                        |
| Replay                    | Home shows the latest Replay shelves (top songs, albums, and artists). An account with no Replay data sees no shelves and no error.                                    |
| Record labels             | Album pages link to the record label. The label page shows its latest and top releases.                                                                                |
| Activities                | Activity pages list up to 10 playlists. Search has record-label and activity groups.                                                                                   |
| Get Info                  | A plain-text dialog for a song: composer, genre, release date, disc and track, duration, content rating, ISRC, label, and copyright.                                   |
| Folder choice             | A new playlist or folder can be created inside a parent folder.                                                                                                        |

### MusicKit instance members

| Member                                                                                                             | Use in Arlet                                                                                               | Main files                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `authorize()`, `unauthorize()`                                                                                     | Sign in and sign out                                                                                       | `auth.ts`                                                                 |
| `isAuthorized`                                                                                                     | Sign-in state checks                                                                                       | `auth.ts`, `controller-account.ts`, `session-health.ts`                   |
| `musicUserToken`, `developerToken`                                                                                 | Read by the request layer and for token expiry. Both values are registered for redaction and never logged. | `catalog.ts`, `controller.ts`, `token.ts`                                 |
| `storefrontId`                                                                                                     | Storefront for catalog and library requests                                                                | `catalog.ts`, `controller.ts`, `library-loader.ts`                        |
| `api.music(path, query, options)`                                                                                  | Every Apple Music API request. Falls back to `api.v3.music` when the first form is missing.                | `catalog.ts`, `response.ts`                                               |
| `setQueue(options)`                                                                                                | Starts playback from songs, a page, or a chosen row                                                        | `player.ts`, `playback-play.ts`, `queue-edit.ts`, `queue-continuation.ts` |
| `playNext(options)`, `playLater(options)`                                                                          | Play Next and Play Later for songs, albums, and playlists                                                  | `controller.ts`, `playback-insert.ts`, `queue-continuation.ts`            |
| `play()`, `pause()`, `stop()`                                                                                      | Transport, and `stop()` before a stream handoff                                                            | `player.ts`, `stream-release.ts`, `controller.ts`                         |
| `seekToTime(time)`                                                                                                 | Seek bar and Windows timeline                                                                              | `player.ts`                                                               |
| `skipToNextItem()`, `skipToPreviousItem()`                                                                         | Next and Previous. Previous restarts a song that has played past 3 seconds.                                | `player.ts`                                                               |
| `player.changeToMediaAtIndex(index)`                                                                               | Choosing a row in Playing Next or a playlist                                                               | `player.ts`, `queue-edit.ts`                                              |
| `queue` (`items`, `length`, `currentItem`, `autoplayItems`, `hasAutoplayStation`, `splice`)                        | Queue reads and autoplay rows. In-place edits use `splice` when the runtime has it.                        | `player.ts`, `queue-edit.ts`, `playback-insert.ts`                        |
| `queueItems`, `currentPlaybackQueueItem`, `currentPlaybackQueueItemIndex`, `nowPlayingItem`, `nowPlayingItemIndex` | The current song and its queue position. Fallbacks when one shape is missing.                              | `player.ts`                                                               |
| `playbackState`                                                                                                    | Player state, using `PlaybackStates`                                                                       | `player.ts`, `events.ts`, `queue-edit.ts`                                 |
| `currentPlaybackTime`, `currentPlaybackDuration`                                                                   | Position and length                                                                                        | `events.ts`, `player.ts`                                                  |
| `volume`                                                                                                           | Volume control. External volume changes are saved.                                                         | `player.ts`, `events.ts`, `controller.ts`                                 |
| `shuffleMode` (read and write), `shuffle`                                                                          | Shuffle state and button. `shuffle` is a fallback for runtimes without `shuffleMode`.                      | `player.ts`                                                               |
| `repeatMode`                                                                                                       | Repeat state and button                                                                                    | `player.ts`                                                               |
| `autoplayEnabled`                                                                                                  | Autoplay toggle in Playing Next                                                                            | `player.ts`, `events.ts`                                                  |
| `bitrate`                                                                                                          | Read for the "Streaming at N kbps" line. Written for High and Standard.                                    | `player.ts`, `events.ts`                                                  |
| `hasMusicSubscription()`                                                                                           | Previews only notice                                                                                       | `controller-account.ts`                                                   |
| `subscribeURL`                                                                                                     | The Subscribe button. The page opens through `open_subscribe_link`, which checks the URL in Rust.          | `controller.ts`                                                           |
| `addEventListener`, `removeEventListener`                                                                          | Event wiring. Listeners are removed on teardown.                                                           | `events.ts`, `bootstrap.ts`, `controller.ts`                              |

Declared in `src/vite-env.d.ts` but not read by Arlet: `previewOnly`,
`storefrontCountryCode`, `librarySongs`, and `playlist`. Preview state comes
from `hasMusicSubscription()`, not from `previewOnly`. `MusicKit.getInstance()`
is not called.

### Global enums and constants

| Name                | Values                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `PlaybackStates`    | none 0, loading 1, playing 2, paused 3, stopped 4, ended 5, seeking 6, waiting 8, stalled 9, completed 10 |
| `PlayerRepeatMode`  | none 0, one 1, all 2. The global is read when it exists; the same numbers are the fallback.               |
| `PlayerShuffleMode` | off 0, songs 1. The global is read when it exists; the same numbers are the fallback.                     |
| `PlaybackBitrate`   | STANDARD 64, HIGH 256                                                                                     |

### Events

| Event                                            | Use                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `playbackStateDidChange`                         | Player status                                                                                   |
| `nowPlayingItemDidChange`                        | Current song, and the Windows media overlay                                                     |
| `playbackTimeDidChange`                          | Position updates                                                                                |
| `mediaPlaybackError`                             | Playback errors                                                                                 |
| `queueItemsDidChange`                            | Queue rows and autoplay rows, when the runtime sends it                                         |
| `queuePositionDidChange` (optional, not typed)   | Queue position after shuffle moves it                                                           |
| `shuffleModeDidChange`, `repeatModeDidChange`    | Shuffle and Repeat buttons follow MusicKit                                                      |
| `playbackDurationDidChange` (optional)           | Late duration, so seek becomes available                                                        |
| `authorizationStatusDidChange` (optional)        | Sign-out or revoked token from another source. The handler checks `isAuthorized` before acting. |
| `playbackBitrateDidChange` (optional)            | Bitrate in Settings                                                                             |
| `autoplayEnabledDidChange` (optional)            | Autoplay toggle follows MusicKit                                                                |
| `playbackVolumeDidChange` (optional)             | External volume changes                                                                         |
| `timedMetadataDidChange`, or `metadataDidChange` | Live radio text. The first name the runtime has is used.                                        |
| `musickitloaded` (DOM event on `document`)       | Startup waits for MusicKit JS to load                                                           |

Not subscribed: `storefrontCountryCodeDidChange` and
`storefrontIdentifierDidChange`.

### Apple Music API groups

| Group                           | Endpoints Arlet calls                                                                                                                                                                                                                     | Main files                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Library                         | `/v1/me/library/songs`, `albums`, `artists`, `playlists`, `recently-added`, `search`; library album, artist, and playlist details with `/tracks` and `/albums`                                                                            | `library.ts`, `library-detail.ts`, `library-pages.ts`            |
| Library playlists and folders   | `POST /v1/me/library/playlists` (create, with an optional parent folder and tracks); `POST /v1/me/library/playlists/{id}/tracks` (add songs); `GET` and `POST /v1/me/library/playlist-folders` (list and create, with an optional parent) | `library-folders.ts`, `library-mutations.ts`                     |
| Add to library                  | `POST /v1/me/library`                                                                                                                                                                                                                     | `library-mutations.ts`                                           |
| Ratings (Favorite, Dislike)     | `GET /v1/me/ratings/{type}`, `PUT` and `DELETE /v1/me/ratings/{type}/{id}`                                                                                                                                                                | `library-ratings.ts`                                             |
| Recent and recommendations      | `/v1/me/recent/played`, `/v1/me/recent/played/tracks`, `/v1/me/history/heavy-rotation`, `/v1/me/recommendations`, `/v1/me/recent/radio-stations`                                                                                          | `library-home.ts`, `library.ts`, `catalog.ts`                    |
| Replay                          | `/v1/me/music-summaries?filter[year]=latest`                                                                                                                                                                                              | `replay.ts`                                                      |
| Catalog content                 | Songs, albums, artists, and playlists with their tracks and views; artist top songs; `include=albums` on songs; `include=record-labels` on albums                                                                                         | `catalog.ts`, `library-detail.ts`, `song-info.ts`, `stations.ts` |
| Catalog search                  | `/v1/catalog/{sf}/search` (overview and See all), `/search/suggestions`, `/v1/me/library/search`                                                                                                                                          | `search.ts`, `catalog.ts`                                        |
| Browse and radio                | `/v1/catalog/{sf}/charts`, `/genres`, `/station-genres`, `/station-genres/{id}/stations`, `/stations` (personal, live, and featured filters)                                                                                              | `browse.ts`, `catalog.ts`                                        |
| Stations from songs and artists | `?include=station` on catalog songs and artists                                                                                                                                                                                           | `stations.ts`                                                    |
| Curators                        | `curators/{id}` and `apple-curators/{id}` with grouped playlists; `playlists?ids=` batches of up to 25                                                                                                                                    | `curators.ts`                                                    |
| Record labels                   | `/v1/catalog/{sf}/record-labels/{id}?views=latest-releases,top-releases`                                                                                                                                                                  | `record-labels.ts`                                               |
| Activities                      | `/v1/catalog/{sf}/activities/{id}?include=playlists`, then `playlists?ids=` for bare references                                                                                                                                           | `activities.ts`                                                  |
| Storefront                      | `/v1/me/storefront` (sign-in expiry probe), `/v1/storefronts/{sf}`                                                                                                                                                                        | `catalog.ts`                                                     |
| Autoplay stations (MusicKit's)  | `POST /v1/me/stations/continuous` and `POST /v1/me/stations/next-tracks/{id}`. MusicKit JS sends these itself and they are undocumented. Arlet's code does not call them.                                                                 | MusicKit JS                                                      |

## Intentionally left out

| Item                            | Status      | Reason                                                                                                                                                                                                          |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lyrics                          | Not offered | Plan decision (`docs/history/plan.md`, section 5.6). No scraping and no private APIs. The feature stays hidden until Apple exposes a supported lyrics text surface, or a separately licensed provider is added. |
| Music videos and motion artwork | Not offered | Arlet has no video screen and shows no motion artwork. A list that holds only music videos is queued by ID as `musicVideos` (`queueOptionsForTracks` in `player.ts`).                                           |
| Lossless and Atmos              | Not offered | MusicKit JS has no path to either. Audio quality offers High (256 kbps), Standard (64 kbps), and Automatic.                                                                                                     |
| `playbackRate`                  | Not offered | Arlet has no playback speed control.                                                                                                                                                                            |
| AirPlay                         | Not offered | Arlet has no AirPlay picker.                                                                                                                                                                                    |
| `changeUserStorefront`          | Not offered | The storefront is the signed-in account's (`storefrontId`). Arlet has no storefront switch.                                                                                                                     |
| `/v1/me/favorites`              | Not used    | Favorite is a rating (`/v1/me/ratings/{type}`), not the favorites endpoint.                                                                                                                                     |

## Not possible through the public API

Apple's public Apple Music API has no endpoints for these actions, so Arlet does
not offer them.

| Action                          | Public API status | What Arlet does                                                              |
| ------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| Rename a playlist               | No endpoint       | Not offered                                                                  |
| Delete a playlist               | No endpoint       | Not offered                                                                  |
| Reorder playlist tracks         | No endpoint       | Not offered                                                                  |
| Remove a track from a playlist  | No endpoint       | Not offered. Removing a song in Playing Next changes only the playing queue. |
| Remove an item from the library | No endpoint       | Not offered                                                                  |
