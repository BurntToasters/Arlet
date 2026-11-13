# MusicKit Network Surface

> **Status:** PENDING — the 2026-09-13 run has not yet exported its observed host list.
> The table below remains the provisional Phase 0 surface from earlier testing;
> update it after copying a fresh report from the diagnostics drawer.

## Script Sources

| Domain                   | Purpose         |
| ------------------------ | --------------- |
| `js-cdn.music.apple.com` | MusicKit JS CDN |

## Connect/API Endpoints

| Domain                      | Purpose         |
| --------------------------- | --------------- |
| `api.music.apple.com`       | Apple Music API |
| (add observed domains here) |                 |

### Library and Ratings Endpoints

All calls go through MusicKit's `api.music` to `api.music.apple.com`. Mutations
(PUT, POST, DELETE) are sent once per user action and are never retried.

| Method | Path                            | Purpose                                             |
| ------ | ------------------------------- | --------------------------------------------------- |
| GET    | `/v1/me/ratings/{type}?ids=a,b` | Load Favorite/Dislike for song, album, playlist IDs |
| PUT    | `/v1/me/ratings/{type}/{id}`    | Set Favorite (`value: 1`) or Dislike (`-1`)         |
| DELETE | `/v1/me/ratings/{type}/{id}`    | Clear a rating                                      |
| POST   | `/v1/me/library?ids[songs]=…`   | Add a catalog song, album, or playlist              |

### Radio and Artist Endpoints

| Method | Path                                            | Purpose                                |
| ------ | ----------------------------------------------- | -------------------------------------- |
| GET    | `/v1/catalog/{sf}/songs/{id}?include=station`   | Song station for `Start Station`       |
| GET    | `/v1/catalog/{sf}/artists/{id}?include=station` | Artist station for `Start Station`     |
| GET    | `/v1/catalog/{sf}/artists/{id}/view/top-songs`  | Artist Top Songs                       |
| GET    | `/v1/me/library/artists/{id}?include=catalog`   | Catalog artist behind a library artist |

A 404 from these lookups means "none available" and is not reported as an
error.

`{type}` is `library-songs`, `library-albums`, or `library-playlists` for
library IDs (`i.`, `l.`, `p.` prefixes), and `songs`, `albums`, or `playlists`
for catalog IDs. Apple's public API has no endpoint to rename, delete, reorder,
or remove tracks from playlists, so Arlet does not offer those actions. The
playlist right-click menu's "Edit in Apple Music" instead opens the playlist on
music.apple.com in the default browser, through `open_subscribe_link`.

### Beta.5 Catalog and Library Endpoints

| Method | Path                                                                                | Purpose                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/me/music-summaries?filter[year]=latest&views=top-artists,top-albums,top-songs` | Replay shelves on Home. A 404, an empty `data` list, or three empty shelves shows nothing and no error.                                    |
| GET    | `/v1/catalog/{sf}/record-labels/{id}?views=latest-releases,top-releases`            | Record label page                                                                                                                          |
| GET    | `/v1/catalog/{sf}/albums/{id}?include=record-labels`                                | Catalog album: the record label link and copyright, with its views. A library album reads its label from this request on its catalog twin. |
| GET    | `/v1/catalog/{sf}/songs/{id}?include=albums`                                        | Get Info: the song, then its album                                                                                                         |
| GET    | `/v1/catalog/{sf}/activities/{id}?include=playlists`                                | Activity page. At most 10 playlists are read.                                                                                              |
| GET    | `/v1/catalog/{sf}/playlists?ids=…`                                                  | Activity playlists that Apple sends as bare references, in one batch                                                                       |
| GET    | `/v1/catalog/{sf}/search?with=topResults&limit=10&types=…`                          | Overview search. Its `types` list includes `record-labels` and `activities`, which have no See all page.                                   |
| POST   | `/v1/me/library/playlists`                                                          | Create a playlist. A chosen folder is sent as a `parent` relationship.                                                                     |
| POST   | `/v1/me/library/playlist-folders`                                                   | Create a folder. A chosen parent folder is sent as a `parent` relationship.                                                                |

### MusicKit-Initiated Requests

MusicKit JS sends these itself, and Arlet's code does not call them. They are
undocumented by Apple.

| Method | Path                               | Purpose                                                                             |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------- |
| POST   | `/v1/me/stations/continuous`       | Autoplay station. A refusal is logged once per Play, and no Autoplay heading shows. |
| POST   | `/v1/me/stations/next-tracks/{id}` | Autoplay top-up for the station                                                     |

## Authorization

| Domain                      | Purpose                               |
| --------------------------- | ------------------------------------- |
| `authorize.music.apple.com` | MusicKit `window.open` auth sheet     |
| `appleid.apple.com`         | Apple ID sign-in (if a further popup) |
| `idmsa.apple.com`           | Apple ID auth (if a further popup)    |
| (add observed domains here) |                                       |

## Media/Artwork CDN

| Domain                      | Purpose       |
| --------------------------- | ------------- |
| `*.mzstatic.com`            | Artwork/media |
| (add observed domains here) |               |

## Native Token Download (Rust, Release Builds)

Rust makes this request, not the webview, so it needs no CSP entry and the
webview gets no access to it. Release builds start it at launch, and each
`get_developer_token` call retries it until one download succeeds in the
process. Debug builds make no request.

| Domain                         | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `music-api.arlet.rosiecdn.win` | Hosted MusicKit developer token, `GET /musickit/arlet-token.json` |

The request is HTTPS only, with no redirects, no cookies, a 5 s total timeout,
and a 16 KiB body cap. A verified copy is cached locally, so the app can serve
the token offline until it expires. E2E builds can point this at a loopback
HTTP fixture; ordinary builds cannot.

## Notes

- CSP in `tauri.conf.json` must be updated to match the actual observed domains.
- Do not use broad wildcards like `https:` as a shortcut.
- The Phase 0 diagnostic webview loads `https://music.apple.com/` in a separate
  unprivileged window. That origin is not granted Tauri IPC. MusicKit JS in the
  main window still uses the table above.
- Sign-in expiry probe: when a request or playback error suggests the user
  token was rejected, Arlet sends one `GET /v1/me/storefront` (cooldown 30 s,
  one at a time). Only a 401 or 403 marks the sign-in expired; `/v1/me`
  requests then stop until the user signs in again.
- The 1-minute stream handoff sends the DRM lease `stop` through MusicKit's
  own `stop()`. Arlet makes no separate lease request.
- Subscribe: MusicKit's `subscribeURL` opens in the default browser through
  `open_subscribe_link`, not in the webview, so it needs no CSP entry. The Rust
  command accepts only https links on `apple.com` or its subdomains.
