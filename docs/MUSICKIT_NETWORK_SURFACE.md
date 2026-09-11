# MusicKit Network Surface

> Observed Apple domains required by MusicKit during Phase 0 testing.
> Update this document as new endpoints are discovered.

## Script Sources

| Domain                          | Purpose           |
|---------------------------------|-------------------|
| `js-cdn.music.apple.com`        | MusicKit JS CDN   |

## Connect/API Endpoints

| Domain                          | Purpose           |
|---------------------------------|-------------------|
| `api.music.apple.com`           | Apple Music API   |
| (add observed domains here)     |                   |

## Authorization

| Domain                          | Purpose           |
|---------------------------------|-------------------|
| `authorize.music.apple.com`     | OAuth popup       |
| (add observed domains here)     |                   |

## Media/Artwork CDN

| Domain                          | Purpose           |
|---------------------------------|-------------------|
| `*.mzstatic.com`                | Artwork/media     |
| (add observed domains here)     |                   |

## Notes

- CSP in `tauri.conf.json` must be updated to match the actual observed domains.
- Do not use broad wildcards like `https:` as a shortcut.
- The Phase 0 diagnostic webview loads `https://music.apple.com/` in a separate
  unprivileged window. That origin is not granted Tauri IPC. MusicKit JS in the
  main window still uses the table above.
