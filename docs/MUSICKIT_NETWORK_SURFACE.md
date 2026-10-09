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

| Method | Path                            | Purpose                                         |
| ------ | ------------------------------- | ----------------------------------------------- |
| GET    | `/v1/me/ratings/{type}?ids=a,b` | Load Love/Dislike for song, album, playlist IDs |
| PUT    | `/v1/me/ratings/{type}/{id}`    | Set Love (`value: 1`) or Dislike (`-1`)         |
| DELETE | `/v1/me/ratings/{type}/{id}`    | Clear a rating                                  |
| POST   | `/v1/me/library?ids[songs]=…`   | Add a catalog song, album, or playlist          |

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
or remove tracks from playlists, so Arlet does not offer those actions.

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

## Notes

- CSP in `tauri.conf.json` must be updated to match the actual observed domains.
- Do not use broad wildcards like `https:` as a shortcut.
- The Phase 0 diagnostic webview loads `https://music.apple.com/` in a separate
  unprivileged window. That origin is not granted Tauri IPC. MusicKit JS in the
  main window still uses the table above.
