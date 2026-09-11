# AGENTS.md — Windows Apple Music Client (Tauri v2)

> **Status:** Architecture / implementation brief for a coding agent  
> **Primary target:** Windows 11 desktop  
> **Framework:** Tauri v2 + vanilla TypeScript + Vite + Rust  
> **Release orchestration:** Node.js, intentionally modeled after Zinnia  
> **Owner:** BurntToasters  
> **Important:** Tauri is the preferred shell, but **Apple Music protected playback is a Phase 0 go/no-go gate**. Do not build the full product until that gate passes.
> **Project Name:** Arlet | BundleID: run.rosie.arlet

---

## 1. Mission

Build a polished third-party Apple Music desktop client for Windows with a **clean Windows 11 / Fluent-inspired interface**, native Mica glass, good keyboard/accessibility behavior, Windows media controls, and the release discipline used by the owner's existing Tauri projects.

This is **not** a clone of Apple's Windows app and it is **not** a generic web wrapper.

The intended product is:

- a custom Windows-first UI;
- backed only by **documented Apple Music / MusicKit surfaces**;
- rendered in a lightweight Tauri v2 shell;
- integrated with Windows 11 system features;
- packaged for x64 and ARM64;
- built, signed, staged, verified, and released through Node.js scripts modeled on Zinnia.

The application must remain maintainable by one developer. Prefer boring, explicit architecture over framework cleverness.

---

## 2. Read this before changing code

The owner's existing projects establish a house style. **Zinnia is the primary reference implementation. IYERIS is the secondary reference.**

Zinnia is available in the parent dir of this repo for your viewing.
Zinnia's package.json scripting is considered to be stable by the user and what the user wants ported to this Tauri V2 app. Same naming, same scripting (app-specific scripting like prepare:7z for example removed).
The user uses the same Tauri V2 scripting in all their Tauri V2 apps which is why they stress the need to re-use and port the scripts to keep everything uniform.

Study these before architectural changes:

- Zinnia repository: https://github.com/BurntToasters/Zinnia
- Zinnia `package.json`: https://github.com/BurntToasters/Zinnia/blob/main/package.json
- Zinnia architecture: https://github.com/BurntToasters/Zinnia/blob/main/ARCHITECTURE.md
- Zinnia scripts: https://github.com/BurntToasters/Zinnia/tree/main/scripts
- IYERIS repository: https://github.com/BurntToasters/IYERIS
- IYERIS `package.json`: https://github.com/BurntToasters/IYERIS/blob/main/package.json

### What to copy from Zinnia conceptually

Zinnia's useful patterns are:

- Tauri v2;
- vanilla TypeScript + HTML + CSS + Vite rather than React/Svelte;
- Rust as the native backend;
- very small Rust entrypoint with focused modules;
- Node.js as the **build/release control plane**;
- version synchronization before dev/build/release;
- generated third-party license inventories;
- Vitest + jsdom frontend tests;
- Cargo tests for Rust;
- optional WebdriverIO/Tauri end-to-end tests;
- x64 and ARM64 Windows build scripts;
- release sessions bound to an exact commit/toolchain;
- explicit build → sign → verify → draft → publish → verify workflow;
- updater signatures, checksums, detached GPG signatures, and post-publish validation;
- routine CI that tests code without automatically possessing all production release/signing power;
- Windows-native effect logic isolated from general application logic.

### What NOT to copy from Zinnia

Do not carry over archive-specific complexity:

- 7-Zip preparation/updater scripts;
- archive fixtures/generators;
- Explorer archive context-menu integration;
- sparse MSIX shell-extension identity unless this app later has a concrete reason for it;
- macOS/Linux packaging during the Windows MVP;
- local file archiver abstractions.

Reuse the **release architecture**, not unrelated product code.

### Licensing note

Zinnia is currently MPL-2.0. If script files are copied verbatim rather than reimplemented, preserve any required notices and confirm that the new repository's license is compatible. Do not silently relicense third-party contributions. Reusing design/patterns is preferred unless the owner explicitly wants direct file reuse.

---

## 3. Framework decision

Use **Tauri v2** unless Phase 0 proves that protected Apple Music playback cannot be made reliable in WebView2.

Frontend default:

- TypeScript
- HTML
- CSS
- Vite
- no React
- no Svelte
- no Vue
- no Tailwind

Do not add a frontend framework simply because the app becomes larger. Zinnia and IYERIS already show that the owner is comfortable with a vanilla TypeScript architecture. If a framework becomes necessary, document the concrete failure of the existing approach before proposing it.

Backend:

- Rust
- Tauri v2
- Windows-specific integrations behind focused modules
- `windows`/WinRT bindings for native media/system integration when needed

Production runtime must **not** require Node.js. Node is for developer tooling and release automation.

---

# 4. Phase 0 — protected playback feasibility gate

## This phase comes before the real app

The hardest constraint is not the UI. It is whether Apple Music subscription playback can run reliably in a Tauri/WebView2 environment.

Apple publicly documents **MusicKit on the Web** for browser playback. It does not provide a native Windows MusicKit framework equivalent to the Apple-platform frameworks.

Current real-world Apple Music desktop projects are an important warning: Sidra uses a CastLabs Electron runtime and explicitly treats protected-media support as an architectural constraint. WebView2 also has known protected-media edge cases, including a reported PlayReady limitation with the Fixed Version runtime.

Therefore:

> **Do not spend multiple weeks building the full UI until a real Apple Music subscriber can sign in and play full protected tracks reliably in Tauri on Windows.**

## 4.1 Phase 0 deliverable

Create a tiny branch/prototype containing only:

```text
src/
  main.ts
  style.css
  musickit/
    bootstrap.ts
    player.ts
src-tauri/
  ...
```

It should have intentionally ugly/minimal UI:

- Configure MusicKit.
- Authorize the Apple Music user.
- Search for a known album/song.
- Play a **full subscription track**, not a preview.
- Pause/resume.
- Seek.
- Skip to another track.
- Play at least 20 different tracks consecutively.
- Survive minimize/restore.
- Survive app focus changes.
- Survive audio output device changes.
- Restart the app and verify the expected authentication/session behavior.
- Run a continuous playback session for at least two hours.
- Verify that errors are surfaced rather than silently hanging.

Use the normal **Evergreen WebView2** runtime first. Do not switch to a bundled Fixed Version runtime as a "stability" measure during the spike; protected-media support must be separately proven there before such a change.

## 4.2 Required Phase 0 test matrix

At minimum:

| Case                                      | Required                                    |
| ----------------------------------------- | ------------------------------------------- |
| Windows 11 x64                            | Yes                                         |
| Full protected Apple Music track          | Yes                                         |
| 20+ consecutive tracks                    | Yes                                         |
| Seek within protected track               | Yes                                         |
| Pause/resume repeatedly                   | Yes                                         |
| App minimize/restore                      | Yes                                         |
| Lock/unlock Windows                       | Yes                                         |
| Change default output device              | Yes                                         |
| Restart app                               | Yes                                         |
| Logout/login again                        | Yes                                         |
| Two-hour session                          | Yes                                         |
| Error recovery after network interruption | Yes                                         |
| ARM64 native build                        | Before public beta, not required on day one |

Do not automate Apple credentials or store account secrets in test fixtures.

## 4.3 Diagnostic experiment: `music.apple.com`

It is acceptable during Phase 0 to load `music.apple.com` in an **unprivileged diagnostic webview** solely to determine whether the WebView2 runtime can render protected Apple Music playback at all.

That diagnostic is not the desired production architecture.

Do not:

- scrape the Apple Music website DOM;
- inject production features into undocumented page internals;
- treat private Apple endpoints as a stable API;
- expose filesystem/shell/updater Tauri permissions to remote Apple pages.

If a remote webview is created, give it **zero privileged Tauri capabilities** unless a specific capability is proven necessary and narrowly scoped.

## 4.4 Phase 0 pass criteria

Tauri passes only if all of these are true:

1. Apple authorization can complete predictably.
2. A paid subscriber can play full tracks, not only previews.
3. Playback does not fail after repeated track changes.
4. The player remains usable after window lifecycle changes.
5. Authentication/session persistence is understandable and reproducible.
6. No private/undocumented DRM extraction is required.
7. The approach works with Apple's documented MusicKit model.
8. Failures can be reported to the user rather than producing a broken invisible state.

## 4.5 Phase 0 failure behavior

If this gate fails:

- **stop the main implementation;**
- do not reverse-engineer FairPlay/Widevine/PlayReady;
- do not extract/decrypt subscription audio;
- do not add a Rust/FFmpeg/libmpv workaround for Apple-protected content;
- write `docs/MUSICKIT_TAURI_FEASIBILITY.md` with reproduction steps and observed failure;
- preserve UI/domain work so it can move to another shell;
- recommend a comparison spike using a DRM-capable Electron/CastLabs runtime.

A Tauri failure is an architecture result, not a prompt to bypass Apple DRM.

---

# 5. Apple Music integration contract

## 5.1 Supported path

The preferred production path is:

```text
Custom local UI
      │
      ▼
Typed AppleMusic service
      │
      ├── Apple Music API / MusicKit catalog + user-library operations
      │
      └── MusicKit Web player for protected playback
```

MusicKit remains the authority for subscription playback.

The native Rust layer must never become an alternate decoder for Apple-protected tracks.

## 5.2 Authentication

Use Apple's documented MusicKit authorization.

There are two token classes to keep conceptually separate:

1. **Developer token**
   - signed from the developer's Media Services private key;
   - required to access Apple Music services;
   - may be supplied directly only for local development;
   - production should obtain a reasonably short-lived token from a small HTTPS token service.

2. **Music User Token / user authorization**
   - belongs to the Apple Music subscriber;
   - let MusicKit manage this wherever the web SDK supports doing so;
   - do not build an Apple ID/password form;
   - do not persist or log tokens casually.

### Absolute rule

**Never ship the `.p8` Media Services private key inside the desktop application, installer, repository, release artifact, JavaScript bundle, Rust binary, or CI log.**

Production token flow:

```text
Desktop app
   │
   │ HTTPS
   ▼
Small token service
   │
   │ Signs short-lived developer JWT
   ▼
Apple Music / MusicKit
```

The token service is intentionally tiny. It should not become a general backend.

## 5.3 Development token handling

For local Phase 0, a manually generated developer token may be used.

If a Vite-exposed development token is used:

- keep it only in `.env.local`;
- ensure `.env.local` is gitignored;
- add a release preflight check that refuses production release if a development-token environment variable is present;
- never embed the private signing key.

Prefer a local development token endpoint once the initial spike works.

## 5.4 API boundaries

Create a typed domain layer. UI files should not directly scatter Apple API calls.

Target interfaces:

```ts
export interface AppleMusicClient {
  getAuthorizationState(): Promise<AuthorizationState>;
  authorize(): Promise<AuthorizationState>;
  unauthorize(): Promise<void>;

  search(term: string, options?: SearchOptions): Promise<SearchResults>;
  getHome(): Promise<HomeFeed>;
  getBrowse(): Promise<BrowseFeed>;
  getRadio(): Promise<RadioFeed>;

  getLibrarySongs(options?: PageOptions): Promise<Page<Track>>;
  getLibraryAlbums(options?: PageOptions): Promise<Page<Album>>;
  getLibraryArtists(options?: PageOptions): Promise<Page<Artist>>;
  getLibraryPlaylists(options?: PageOptions): Promise<Page<Playlist>>;

  getAlbum(id: string): Promise<AlbumDetails>;
  getArtist(id: string): Promise<ArtistDetails>;
  getPlaylist(id: string): Promise<PlaylistDetails>;
}

export interface PlaybackController {
  getState(): PlaybackState;
  play(item: Playable): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  toggle(): Promise<void>;
  seek(seconds: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setQueue(items: Playable[], startIndex?: number): Promise<void>;
}
```

Exact Apple SDK method names must be verified against current official documentation. Do not make the domain interface mirror unstable SDK object shapes one-to-one.

## 5.5 Normalize Apple objects

Define internal types such as:

```ts
type MusicId = string;

interface Track {
  id: MusicId;
  title: string;
  artistName: string;
  albumTitle?: string;
  artwork?: Artwork;
  durationMs?: number;
  explicit?: boolean;
  catalogUrl?: string;
}

interface Album {
  id: MusicId;
  title: string;
  artistName: string;
  artwork?: Artwork;
  trackCount?: number;
}

interface PlaybackState {
  status: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
  current?: Track;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  queue: Track[];
  queueIndex: number;
  error?: PlayerError;
}
```

Do not leak raw MusicKit objects throughout the view layer. The wrapper is the escape hatch if Apple changes API shape.

## 5.6 Lyrics

Do **not** scrape lyrics from Apple pages or private APIs.

Until Apple exposes a supported lyrics-text surface suitable for this app, the UI should:

- hide the lyrics feature;
- or show a clearly unavailable state;
- or later integrate a separately licensed lyrics provider.

Do not ship a fragile scraper.

## 5.7 Lossless / Dolby Atmos

Do not advertise a playback quality merely because catalog metadata says a release is available in that quality.

Only show claims such as "Lossless" or "Dolby Atmos playback" after the actual Windows playback path exposes a documented, testable signal showing that the stream being rendered has that property.

MusicKit Web capability and Windows DRM behavior must be measured, not assumed.

---

# 6. Webview security model

Tauri capabilities are a real security boundary. Use them.

## 6.1 Window/webview roles

Target model after Phase 0:

```text
main
  Local application UI
  Minimal normal app capabilities

music-player
  Local player page hosting MusicKit Web
  No filesystem/shell/updater/dialog privileges
  Only narrowly scoped event/player IPC

auth child/popup
  Only if MusicKit requires it
  No privileged Tauri capabilities
```

Do not force the multi-webview design if MusicKit fails in a hidden/secondary webview. The Phase 0 evidence decides whether playback must live in the main webview.

If the app uses one webview, compensate with very narrow Tauri permissions and strict custom-command validation.

## 6.2 Capability rules

- Create explicit capability files under `src-tauri/capabilities/`.
- Grant permissions by window/webview label.
- Do not use broad default capabilities out of convenience.
- Do not grant `shell` by default.
- Do not permit arbitrary command execution.
- Do not give a remote origin filesystem access.
- Validate all custom Rust command arguments.
- For sensitive custom commands, verify the caller's expected webview/window label.
- Keep updater installation in the trusted local main UI only.
- External links should use a narrowly scoped opener mechanism.

## 6.3 CSP

Keep Content Security Policy restrictive.

Only allow the exact Apple domains needed by current MusicKit documentation/runtime and the exact token-service origin.

Do **not** write:

```text
script-src https:
connect-src https:
img-src https:
```

as a shortcut.

During Phase 0, collect the actual required origins and document them in:

```text
docs/MUSICKIT_NETWORK_SURFACE.md
```

Typical categories to expect and verify:

- MusicKit JavaScript CDN;
- Apple Music API/service endpoints;
- Apple authorization endpoints;
- Apple artwork/CDN endpoints;
- the project's developer-token endpoint.

Do not copy a stale hostname list from this document. Confirm current endpoints.

---

# 7. UI direction

## 7.1 Design goal

The app should feel like a **first-class Windows 11 music application**, not an Apple web page placed in a borderless window.

Use:

- Windows 11 Mica as the main system backdrop where supported;
- mostly opaque/translucent local surfaces over the backdrop;
- Acrylic/strong blur only for transient surfaces such as menus/flyouts when useful;
- Segoe UI Variable / Segoe UI system typography;
- Fluent-like spacing, motion, focus treatment, hit targets, and iconography;
- Windows accent color sparingly;
- responsive layout;
- high-contrast and reduced-motion handling.

Avoid:

- an entire-window CSS `backdrop-filter` blur;
- macOS traffic-light metaphors;
- oversized glass cards everywhere;
- low-contrast text on artwork;
- custom controls that lose keyboard focus or accessibility semantics;
- fake native styling that breaks at 125/150/200% DPI.

Tauri currently exposes a Windows 11-only Mica effect. Use it as a native window material, with a deliberate opaque fallback.

## 7.2 Window shell

Preferred shell:

```text
┌──────────────────────────────────────────────────────────────┐
│ custom titlebar / drag region                    _  □  ×    │
├───────────────┬──────────────────────────────────────────────┤
│ sidebar       │ page header / search / commands              │
│               │                                              │
│ Home          │ main content                                 │
│ Browse        │                                              │
│ Radio         │                                              │
│ Library       │                                              │
│ Search        │                                              │
│               │                                              │
│ Settings      │                                              │
├───────────────┴──────────────────────────────────────────────┤
│ artwork │ title / artist │ transport │ timeline │ volume    │
└──────────────────────────────────────────────────────────────┘
```

Guidance, not rigid pixel law:

- titlebar around 44–48 logical px;
- sidebar around 220–252 logical px at normal desktop width;
- persistent now-playing strip around 80–96 logical px;
- collapse navigation gracefully at narrower widths;
- minimum interactive target roughly 32–40 logical px depending context;
- never make window drag regions overlap functional controls.

## 7.3 CSS system

Use a small token system instead of ad hoc values:

```css
:root {
  --font-ui: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  --duration-fast: 100ms;
  --duration-normal: 180ms;
}
```

Color tokens should be theme-driven. Do not hardcode one giant palette into components.

## 7.4 Icons

Use a single icon system. `lucide` is already used in Zinnia and is acceptable for general app glyphs.

Where a Windows-specific symbol is important, prefer a Fluent-appropriate glyph only if licensing and rendering are straightforward.

Do not mix three icon libraries.

## 7.5 Artwork

Artwork is content, not application chrome.

- lazy-load images;
- use appropriately sized Apple artwork URLs;
- cache only where Apple terms permit;
- use neutral placeholders;
- avoid huge full-resolution images in list rows;
- handle missing art cleanly;
- do not make every background a blurred copy of album artwork.

---

# 8. MVP product scope

## Required for first meaningful beta

### Shell

- custom Windows titlebar;
- native Mica on Windows 11;
- light/dark/system theme;
- sidebar navigation;
- settings page;
- persistent now-playing bar;
- responsive window sizing;
- single-instance behavior.

### Apple Music account

- explicit sign-in action;
- signed-in state;
- sign-out;
- meaningful auth errors;
- no Apple password handling by this app.

### Discovery

- Home/Listen-style feed using documented personalized endpoints;
- Browse;
- Radio if supported cleanly;
- global search;
- album detail;
- artist detail;
- playlist detail.

### Library

- albums;
- artists;
- songs;
- playlists;
- pagination/infinite loading;
- empty/error/loading states.

### Playback

- play/pause;
- previous/next;
- seek;
- queue;
- volume;
- shuffle/repeat when supported;
- loading/buffering/error state;
- state survives route navigation;
- track changes reflected immediately throughout the app.

### Windows integration

- System Media Transport Controls (SMTC);
- title/artist/album artwork in system now-playing UI;
- hardware media buttons;
- taskbar app identity/icon;
- notifications only for meaningful events, not every track change;
- installer + updater.

### Quality

- keyboard navigation;
- visible focus;
- basic screen-reader semantics;
- 125%, 150%, and 200% scale smoke tests;
- clean behavior on multi-monitor setups;
- clean fresh-install flow.

## Explicitly not MVP

- Apple Music offline downloads;
- DRM extraction;
- custom protected audio decoder;
- lyric scraping;
- cross-platform builds;
- plugin ecosystem;
- local-file music library;
- audio DSP/equalizer that requires intercepting protected Apple audio;
- Discord Rich Presence;
- Last.fm;
- AirPlay;
- remote control server;
- custom mini-player window;
- Store publication.

Those can be evaluated after the playback and release foundations are solid.

---

# 9. Repository layout

Use the Zinnia philosophy: thin entrypoints and focused modules.

Suggested initial layout:

```text
.
├── .githooks/
├── .github/
│   └── workflows/
├── docs/
│   ├── MUSICKIT_TAURI_FEASIBILITY.md
│   ├── MUSICKIT_NETWORK_SURFACE.md
│   ├── RELEASE.md
│   ├── SECURITY.md
│   └── WINDOWS_MEDIA_INTEGRATION.md
├── e2e/
├── public/
├── scripts/
│   ├── release/
│   ├── dist-tools.js
│   ├── gpg-sign.js
│   ├── install-git-hooks.js
│   ├── launch-vs-devshell.ps1
│   ├── lint-comments.mjs
│   ├── release-preflight.js
│   ├── release-session.js
│   ├── run-release.js
│   ├── setup-windows-artifact-signing.ps1
│   ├── sync-version.js
│   ├── tauri-windows-build.js
│   ├── test-all.js
│   ├── test-e2e.js
│   ├── validate-updater-manifest.js
│   ├── verify-release-draft.js
│   ├── verify-windows-authenticode.ps1
│   └── windows-artifact-sign.js
├── src/
│   ├── app-init.ts
│   ├── main.ts
│   ├── state.ts
│   ├── styles/
│   │   ├── tokens.css
│   │   ├── base.css
│   │   ├── layout.css
│   │   └── components.css
│   ├── domain/
│   │   ├── music.ts
│   │   ├── playback.ts
│   │   └── errors.ts
│   ├── musickit/
│   │   ├── client.ts
│   │   ├── auth.ts
│   │   ├── catalog.ts
│   │   ├── library.ts
│   │   ├── player.ts
│   │   ├── normalize.ts
│   │   └── events.ts
│   ├── platform/
│   │   ├── tauri.ts
│   │   └── windows-media.ts
│   ├── routing/
│   │   └── router.ts
│   ├── views/
│   │   ├── home/
│   │   ├── browse/
│   │   ├── radio/
│   │   ├── library/
│   │   ├── search/
│   │   ├── album/
│   │   ├── artist/
│   │   ├── playlist/
│   │   └── settings/
│   ├── components/
│   │   ├── app-shell/
│   │   ├── sidebar/
│   │   ├── titlebar/
│   │   ├── now-playing/
│   │   ├── media-grid/
│   │   ├── track-list/
│   │   ├── menu/
│   │   └── toast/
│   └── __tests__/
├── src-tauri/
│   ├── capabilities/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands.rs
│   │   ├── logging.rs
│   │   ├── settings.rs
│   │   ├── single_instance.rs
│   │   ├── updater.rs
│   │   ├── window_fx.rs
│   │   └── windows/
│   │       ├── mod.rs
│   │       ├── media_controls.rs
│   │       └── taskbar.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json (incl. bundle.windows.signCommand)
├── .env.example
├── AGENTS.md
├── ARCHITECTURE.md
├── package.json
├── package-lock.json
├── rust-toolchain.toml
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

Do not create every directory before it is needed. This is the target shape, not an instruction to add empty scaffolding.

---

# 10. Frontend architecture

## 10.1 Entry point

`main.ts` should be boring:

```ts
import { initializeApplication } from "./app-init";

void initializeApplication();
```

Keep setup elsewhere.

## 10.2 State

Follow Zinnia's preference for explicit state, but do not create an unbounded god object.

A reasonable split:

```ts
interface AppState {
  session: SessionState;
  navigation: NavigationState;
  library: LibraryState;
  search: SearchState;
  playback: PlaybackState;
  settings: SettingsState;
  ui: UiState;
}
```

Use dedicated mutation/action functions:

```ts
setPlaybackState(...)
setCurrentRoute(...)
setSearchResults(...)
setAuthorizationState(...)
```

Views should render from typed state and invoke services/actions.

Do not let every component independently register raw MusicKit listeners.

## 10.3 Event flow

Desired flow:

```text
MusicKit/player event
      │
      ▼
musickit/events.ts
      │ normalize
      ▼
Playback action/state
      │
      ├──► now-playing UI
      ├──► queue UI
      └──► Windows media bridge
```

The Windows media bridge should receive a normalized app track/state, never a raw Apple SDK object.

## 10.4 Async work

All network-facing views need:

- loading state;
- cancellation or stale-request protection;
- retry where appropriate;
- typed user-facing error;
- no "catch and console.log" as the final behavior.

For search, debounce input and discard stale responses.

For long paginated lists, virtualize only if measurements show DOM size is a problem. Do not add a large virtualization dependency preemptively.

---

# 11. Rust architecture

## 11.1 `main.rs` / `lib.rs`

As in Zinnia, entrypoints are glue.

Do not put:

- a 500-line command registry;
- Windows COM/WinRT implementation;
- updater logic;
- settings persistence;
- titlebar effects

inside `main.rs`.

## 11.2 Windows media module

Create a narrow Rust adapter for Windows system media integration.

Responsibilities:

- create/update the app's SMTC integration;
- set title, artist, album title, and artwork;
- update play/pause state;
- expose play/pause/previous/next commands from Windows back to the frontend;
- update timeline/position if practical;
- clear stale metadata on logout/stop.

The frontend remains the source of truth for Apple/MusicKit playback.

Bridge shape:

```text
frontend normalized state
    │ Tauri command/event
    ▼
Rust WindowsMediaSession
    │ WinRT
    ▼
Windows SMTC
```

And:

```text
hardware key / system command
    │
    ▼
Rust WindowsMediaSession
    │ Tauri event
    ▼
frontend PlaybackController
    │
    ▼
MusicKit player
```

Do not create a second independent playback state machine in Rust.

Microsoft's System Media Transport Controls are the target native surface. Use current official Windows documentation when implementing.

## 11.3 Window effects

`window_fx.rs` owns Windows backdrop behavior.

Priority:

1. native Mica on supported Windows 11;
2. clean opaque/translucent fallback;
3. optional Acrylic only where performance is acceptable.

Do not rely on undocumented DWM hacks when Tauri's supported Mica effect works.

If a transparent webview causes rendering/DRM instability, correctness wins over glass. Document the tradeoff and use an opaque shell.

## 11.4 Settings

Persist only ordinary app settings locally:

- theme;
- backdrop preference;
- close/minimize behavior;
- update channel;
- volume if appropriate;
- window state.

Do not put Apple credentials/private keys in the settings file.

---

# 12. Windows media-control requirements

Treat media integration as a first-class feature, not a post-MVP hack.

Required behaviors:

- system Play button resumes MusicKit;
- Pause pauses;
- Next/Previous map to the app queue/player;
- Windows now-playing metadata updates quickly on track transition;
- old artwork does not linger after logout;
- keyboard media keys work when the app is unfocused;
- user-initiated app volume and system media state do not fight each other.

Test with:

- standard keyboard media keys;
- Bluetooth headset controls if available;
- Windows volume flyout/system media surface;
- lock/unlock;
- minimized app.

---

# 13. Proposed `package.json`

This intentionally keeps the **shape and release philosophy of Zinnia** while removing 7-Zip/shell-extension/platform scripts that do not belong here.

Before implementing, compare this against Zinnia's current `main` branch and use the owner's currently preferred Node/npm versions.

```json
{
  "name": "winmusic-client",
  "version": "0.1.0",
  "license": "UNLICENSED",
  "private": true,
  "packageManager": "npm@12.0.2",
  "description": "A Windows-first Apple Music client built with Tauri v2.",
  "type": "module",
  "engines": {
    "node": "^22.22.2 || ^24.15.0 || >=26.0.0",
    "npm": ">=12.0.1"
  },
  "scripts": {
    "prepare": "node scripts/install-git-hooks.js",

    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",

    "test": "vitest run",
    "test:watch": "vitest",
    "test:cov": "npm run licenses && vitest run --coverage",
    "test:rust": "cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets",
    "test:e2e": "node scripts/test-e2e.js",
    "test:all": "node scripts/test-all.js",

    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ scripts/ e2e/ && npm run lint:comments",
    "lint:comments": "node scripts/lint-comments.mjs src src-tauri/src scripts e2e",
    "lint:fix": "eslint src/ scripts/ e2e/ --fix",
    "format": "prettier --write \"src/**/*.{ts,css,html,json}\" \"scripts/**/*.{js,mjs,cjs,ts,json}\" \"e2e/**/*.{ts,js}\" \"*.{json,md,ts}\"",
    "format:check": "prettier --check \"src/**/*.{ts,css,html,json}\" \"scripts/**/*.{js,mjs,cjs,ts,json}\" \"e2e/**/*.{ts,js}\" \"*.{json,md,ts}\"",

    "start": "npm run tauri:dev",
    "tauri": "tauri",
    "tauri:dev": "npm run sync-version && npm run licenses && tauri dev",
    "tauri:build": "npm run sync-version && npm run licenses && tauri build -- --locked",

    "sync-version": "node scripts/sync-version.js",

    "licenses": "npm run licenses:npm && npm run licenses:cargo",
    "licenses:npm": "node scripts/generate-npm-licenses.js",
    "licenses:cargo": "node scripts/generate-cargo-licenses.js",
    "release:licenses": "npm run licenses",

    "dist:clean": "node scripts/dist-tools.js clean",
    "dist:clean-release-artifacts": "node scripts/dist-tools.js clean-release-artifacts",
    "dist:list": "node scripts/dist-tools.js list",

    "wc": "npm run win-compiler:x64",
    "vi": "node scripts/vi.js",
    "b": "git fetch origin && git switch -C beta origin/beta && npm run vi",
    "r": "git fetch origin && git switch -C main origin/main && npm run vi && npm run gitprune:force",
    "u": "node scripts/npm-safe-update.mjs && node scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml && node scripts/sync-version.js",
    "u2": "node scripts/npm-safe-update.mjs && node scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml && node scripts/sync-version.js",

    "win-compiler:x64": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-vs-devshell.ps1 -Arch x64",
    "win-compiler:arm64": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-vs-devshell.ps1 -Arch arm64",

    "setup:win:artifact-signing": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows-artifact-signing.ps1",

    "build:win:x64:prepared": "dotenv -e .env -- node scripts/tauri-windows-build.js --target x86_64-pc-windows-msvc --bundles nsis",
    "build:win:arm64:prepared": "dotenv -e .env -- node scripts/tauri-windows-build.js --target aarch64-pc-windows-msvc --bundles nsis",
    "build:win:prepared": "npm run build:win:x64:prepared && npm run build:win:arm64:prepared",
    "build:win:x64": "npm run sync-version && npm run licenses && npm run build:win:x64:prepared",
    "build:win:arm64": "npm run sync-version && npm run licenses && npm run build:win:arm64:prepared",
    "build:win": "npm run sync-version && npm run licenses && npm run build:win:prepared",

    "rust:update": "rustup toolchain install stable --profile minimal --component cargo,clippy,rustfmt",
    "rust:targets:win": "rustup target add --toolchain stable x86_64-pc-windows-msvc aarch64-pc-windows-msvc",

    "workspace:bootstrap": "npm run rust:update && npm ci --ignore-scripts && npm run sync-version",
    "workspace:prepare": "npm run workspace:bootstrap && npm run test:all -- --require-clean-proof",

    "release:prepare": "npm run workspace:bootstrap && npm run test:all -- --require-clean-proof --skip-e2e && npm run dist:clean-release-artifacts",
    "release:session:verify": "node scripts/release-session.js",
    "release:draft": "dotenv -e .env -- node scripts/ensure-draft-release.cjs",
    "release:publish": "dotenv -e .env -- node scripts/publish-release.cjs",
    "release:wait-draft": "dotenv -e .env -- node scripts/wait-for-draft-release.cjs",
    "release:preflight": "node scripts/release-preflight.js",
    "prerelease:prepare": "node scripts/release-warning.js && npm run release:preflight && npm run release:licenses",

    "release:sign:gpg": "dotenv -e .env -- node scripts/gpg-sign.js",
    "release:verify:draft": "dotenv -e .env -- node scripts/verify-release-draft.js",
    "release:verify:published": "dotenv -e .env -- node scripts/verify-release-published.js",

    "release:win:continue": "npm run release:session:verify && npm run release:licenses && npm run release:draft && npm run rust:targets:win && npm run build:win:prepared && npm run release:sign:gpg && npm run release:verify:draft",
    "release:win:resume": "node scripts/run-release.js win --resume",
    "release:win": "node scripts/run-release.js win",

    "gitprune": "git remote prune origin",
    "gitprune:force": "git fetch --prune origin"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.11.0",
    "@tauri-apps/plugin-dialog": "^2.6.0",
    "@tauri-apps/plugin-notification": "^2.3.3",
    "@tauri-apps/plugin-process": "^2.0.0",
    "@tauri-apps/plugin-updater": "^2.10.1",
    "lucide": "^1.17.0",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.11.0",
    "@types/node": "^24.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vitest/coverage-v8": "^4.0.0",
    "dotenv-cli": "^11.0.0",
    "eslint": "^9.0.0",
    "jsdom": "^27.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.9.0",
    "vite": "^7.0.0",
    "vitest": "^4.0.0"
  }
}
```

### Important package-file rule

Do not blindly pin the exact example dependency versions above months later.

The **script names and structure** are the durable part. When bootstrapping, use versions compatible with the then-current Zinnia/Tauri stack and commit the resulting lockfile.

### Dependencies intentionally omitted

Do not add by default:

- `@tauri-apps/plugin-shell`
- React
- Svelte
- Vue
- Tailwind
- Electron
- media decoding libraries
- libmpv/FFmpeg bindings

Every privileged plugin increases security surface.

---

# 14. Zinnia script-porting map

Use this table when bringing over release tooling.

| Zinnia concept/script            | Action here                                       |
| -------------------------------- | ------------------------------------------------- |
| `install-git-hooks.js`           | Port/reuse                                        |
| `sync-version.js`                | Port and adapt manifest paths/names               |
| npm/cargo license generators     | Port/reuse                                        |
| `test-all.js`                    | Port and adapt required suites                    |
| `test-e2e.js`                    | Port after UI shell exists                        |
| `npm-safe-update.mjs`            | Port/reuse                                        |
| `cargo-safe-update.mjs`          | Port/reuse                                        |
| `launch-vs-devshell.ps1`         | Port/reuse                                        |
| `windows-vs-toolchain.js`        | Port/reuse                                        |
| `tauri-windows-build.js`         | Port and remove 7-Zip/shell-extension assumptions |
| Windows Artifact Signing setup   | Port/reuse architecture                           |
| Windows artifact signer/verifier | Port/reuse architecture                           |
| `release-preflight.js`           | Port and add MusicKit credential leak checks      |
| `release-session.js`             | Port/reuse exact-commit/toolchain concept         |
| `run-release.js`                 | Port, Windows only initially                      |
| draft release helpers            | Port/reuse                                        |
| updater manifest validation      | Port/reuse                                        |
| updater live validation          | Port/reuse                                        |
| GPG detached signature script    | Port/reuse if release policy keeps GPG            |
| beta/stable manifest sync        | Port if beta channel is retained                  |
| 7-Zip download/update scripts    | Drop                                              |
| archive/context-menu scripts     | Drop                                              |
| macOS/Linux release scripts      | Defer                                             |
| sparse shell MSIX integration    | Drop unless future feature requires it            |

Do not add a script name to `package.json` before its backing script exists and at least has a smoke test. Avoid a package file full of dead aliases.

---

# 15. Release engineering

## 15.1 Principle

Keep Node.js as the release state machine.

The application itself is Tauri/Rust/TypeScript. Node coordinates:

```text
preflight
  ↓
version sync
  ↓
licenses
  ↓
tests / lint / typecheck
  ↓
x64 build
  ↓
ARM64 build
  ↓
Authenticode signing
  ↓
signature verification
  ↓
Tauri updater signatures
  ↓
SHA-256
  ↓
detached GPG signatures (if retained)
  ↓
GitHub draft
  ↓
download/re-verify draft
  ↓
explicit publish gate
  ↓
verify public assets/updater manifest
```

Do not collapse this into one opaque CI action.

## 15.2 Release-session fingerprint

As in Zinnia, a resumable release must be tied to enough state to prove it is still the same release:

- Git commit;
- package-lock hash;
- Cargo.lock hash;
- app version;
- release channel;
- target architecture;
- Node version;
- npm version;
- Rust toolchain;
- Tauri CLI version;
- clean worktree;
- release-session creation timestamp.

Expire/resist stale sessions rather than resuming a release against changed source.

## 15.3 Windows artifacts

Initial direct distribution:

- x64 NSIS installer;
- ARM64 NSIS installer;
- Tauri updater artifacts/signatures;
- SHA-256 checksums;
- Authenticode-signed executable/installer;
- detached `.asc` signatures if keeping the Zinnia convention.

A Microsoft Store/MSIX path can be added later. It should not block MVP.

## 15.4 Signing

Keep these concerns separate:

1. Windows Authenticode / Microsoft Artifact Signing;
2. Tauri updater signing;
3. optional GPG release-file signatures.

A valid updater signature is not an Authenticode signature and vice versa.

Never put production signing credentials in ordinary PR CI.

## 15.5 Release preflight additions

Add checks that fail a release if:

- `.p8` files exist under the repository/worktree;
- a known developer private-key marker is detected;
- a development MusicKit token variable is configured for the production build;
- unexpected `.env.local`/credential files are staged;
- the worktree is dirty;
- version fields disagree;
- updater public key is missing;
- x64/ARM64 target configuration is incomplete.

---

# 16. CI

Routine GitHub Actions should:

- `npm ci --ignore-scripts`;
- run version/config validation;
- typecheck;
- lint;
- format-check;
- Vitest;
- Cargo fmt/clippy/test;
- build a Windows x64 smoke artifact where practical;
- optionally exercise ARM64 compilation;
- never log Apple auth material.

Routine CI should not require:

- the MusicKit `.p8` signing key;
- Apple account credentials;
- production Authenticode signing credentials;
- Tauri updater private key unless running a protected release workflow.

For MusicKit integration, keep automated tests at the wrapper/normalization layer and use a documented **manual protected-playback matrix** for the real subscriber flow.

---

# 17. Test strategy

## 17.1 Frontend unit tests

Vitest + jsdom.

Test:

- state transitions;
- API normalization;
- artwork URL sizing helpers;
- queue actions;
- stale search-response protection;
- router behavior;
- error mapping;
- settings;
- media-event translation.

Mock the `AppleMusicClient` interface rather than mocking dozens of MusicKit internals in every test.

## 17.2 Rust tests

Test:

- settings parsing/persistence;
- command validation;
- sensitive-value redaction;
- media metadata mapping;
- updater/release helpers where applicable.

Windows COM/WinRT integration may require targeted integration tests rather than pure unit tests.

## 17.3 E2E

Use the same general WebdriverIO/Tauri approach as Zinnia if it remains healthy.

Automate local UI flows:

- navigation;
- search input with mocked service;
- album/playlist rendering;
- player controls using a fake player;
- settings;
- update dialog behavior.

Do not automate real Apple account login in public CI.

## 17.4 Manual quality matrix

Before beta:

- Windows 11 current stable x64;
- Windows 11 ARM64;
- 100/125/150/200% scaling;
- two monitors with different scale factors;
- dark/light;
- high contrast;
- reduced motion;
- keyboard-only;
- screen-reader smoke test;
- Bluetooth media controls;
- sleep/wake;
- network loss/recovery;
- clean install;
- in-place update;
- uninstall/reinstall;
- app update while logged in;
- stale/expired developer token handling.

---

# 18. Logging and diagnostics

Create useful logs, but treat auth data as toxic.

Never log:

- Apple password;
- Music User Token;
- developer private key;
- cookies;
- complete Authorization headers;
- Tauri updater private key;
- full token-service bearer values.

If request logging is needed, log:

```text
GET /v1/catalog/{storefront}/...
status=200
duration=...
request-id=...
```

without sensitive headers.

Add a redaction helper and unit tests for it.

A diagnostics page can later show:

- app version;
- commit hash;
- Windows version/build;
- architecture;
- WebView2 version;
- Tauri version;
- updater channel;
- signed-in yes/no;
- MusicKit initialized yes/no;
- last player error code/message sanitized.

This will be extremely valuable when DRM behavior varies by system.

---

# 19. Error behavior

Do not hide errors behind toasts that disappear.

Error categories:

```ts
type AppErrorCode =
  | "NETWORK"
  | "AUTH_REQUIRED"
  | "SUBSCRIPTION_REQUIRED"
  | "TOKEN_EXPIRED"
  | "MUSICKIT_INIT_FAILED"
  | "PLAYBACK_FAILED"
  | "CONTENT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPDATER_FAILED"
  | "UNKNOWN";
```

UI should distinguish:

- retryable;
- requires sign-in;
- unavailable in storefront;
- subscription required;
- app restart recommended;
- unsupported runtime/DRM condition.

If protected playback fails due to a runtime capability, do not report "song unavailable" unless that is actually known.

---

# 20. Performance rules

The point of choosing Tauri is not to recreate an Electron-sized frontend through accidental complexity.

Rules:

- no heavyweight frontend framework without evidence;
- no 20 MB icon package;
- lazy-load large route modules where useful;
- debounce search;
- avoid decoding giant artwork in tiny rows;
- batch DOM updates;
- avoid continuous JS animation for decorative glass;
- prefer native Mica over a full-window CSS blur filter;
- measure startup, memory, and route latency before optimizing.

Useful targets, not release guarantees:

- shell visible quickly from warm launch;
- navigation should feel immediate once data is cached;
- no noticeable jank while resizing the main window;
- now-playing UI must update within a fraction of a second after track change.

---

# 21. Accessibility

Do not leave accessibility for the end.

Requirements:

- semantic buttons, headings, lists, and landmarks;
- every icon-only control has an accessible label;
- keyboard focus order follows visual order;
- focus rings are visible in light/dark/high-contrast;
- transport buttons expose pressed/disabled state correctly;
- sliders expose name/value/min/max;
- queue rows can be operated without a mouse;
- no information is communicated only by color;
- respect `prefers-reduced-motion`;
- test at large Windows text scaling.

---

# 22. Update behavior

Use Tauri v2's updater.

Required:

- signed updater artifacts;
- stable and optional beta channel;
- non-blocking update check after launch;
- explicit user-facing install/restart action unless the owner chooses otherwise;
- release notes link;
- exact-version validation after update;
- graceful offline behavior.

Port Zinnia's draft/public manifest validation approach.

Do not trust "upload succeeded" as proof that the updater is functional. After publishing, download/validate the live metadata and artifact/signature pair.

---

# 23. Development milestones

## Milestone 0 — playback feasibility

**Deliverable:** `docs/MUSICKIT_TAURI_FEASIBILITY.md`

- Tauri v2 skeleton;
- MusicKit initialization;
- Apple authorization;
- full protected playback;
- reliability matrix;
- WebView2 version captured;
- pass/fail recommendation.

**No visual polish beyond what is needed to test.**

## Milestone 1 — shell

- repository hygiene;
- package scripts;
- titlebar;
- Mica;
- sidebar/router;
- theme;
- basic app state;
- settings;
- test infrastructure.

## Milestone 2 — Apple domain layer

- token endpoint abstraction;
- authorization service;
- typed MusicKit wrapper;
- normalization;
- search;
- album/artist/playlist models;
- library pagination;
- unit tests with fixtures.

## Milestone 3 — playback productization

- persistent now-playing bar;
- queue;
- seek;
- volume;
- repeat/shuffle if supported;
- error recovery;
- playback state normalization;
- restart/auth behavior.

## Milestone 4 — Windows integration

- SMTC;
- hardware media keys;
- artwork metadata;
- taskbar polish;
- single-instance behavior;
- optional notifications;
- DPI/multi-monitor fixes.

## Milestone 5 — release system

- port Zinnia Node orchestration;
- x64/ARM64 builds;
- Authenticode;
- Tauri updater signing;
- draft releases;
- checksums;
- GPG if retained;
- publish verification;
- clean VM install/update test.

## Milestone 6 — beta quality

- accessibility;
- high contrast;
- reduced motion;
- network failure handling;
- rate-limit UX;
- crash/diagnostic logs;
- onboarding/sign-in flow;
- documentation.

---

# 24. Commit and agent working rules

When operating as a coding agent:

1. Read this file and `ARCHITECTURE.md` before structural changes.
2. Read the relevant Zinnia implementation before porting release tooling.
3. Make small, reviewable changes.
4. Do not casually change the framework choice.
5. Do not add a frontend framework without explicit approval.
6. Do not weaken CSP/capabilities merely to make a bug disappear.
7. Do not add broad shell/process access.
8. Do not put secrets into `.env.example`.
9. Never commit `.p8`, auth cookies, tokens, or production signing material.
10. Keep `main.ts` and Rust entrypoints thin.
11. Split files when they accumulate unrelated responsibilities.
12. Add tests with behavior changes.
13. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:rust` before calling a task done.
14. Update `ARCHITECTURE.md` when boundaries change.
15. Update release docs when scripts change.
16. Prefer documented public APIs.
17. If MusicKit behavior contradicts assumptions, document evidence rather than hacking around it.
18. Do not claim lossless/Atmos/lyrics/offline features without verified supported implementation.
19. Keep Windows-specific code behind `platform`/`windows` modules.
20. Preserve an escape route to another desktop shell.

---

# 25. Escape strategy

The domain/UI architecture must not make a failed Tauri playback experiment destroy the project.

Keep these layers conceptually separable:

```text
UI components + CSS
        │
        ▼
Application state/actions
        │
        ▼
AppleMusicClient + PlaybackController interfaces
        │
        ├── MusicKit implementation
        └── test/fake implementation

Platform bridge
        ├── Tauri/Rust Windows implementation
        └── future alternative shell implementation
```

If Tauri/WebView2 cannot provide sustainable protected playback:

- retain TypeScript domain models;
- retain most HTML/CSS components;
- retain tests around normalized services;
- replace the shell/native bridge;
- evaluate CastLabs Electron as the leading fallback;
- keep the Node release orchestration model.

This is one reason to avoid framework-specific UI state libraries and direct Tauri calls from every view.

---

# 26. Open questions that must remain explicit

The agent must not silently guess these.

### Must be resolved by Phase 0

- Does current MusicKit Web authorize correctly inside Tauri's WebView2?
- Does full subscriber playback work?
- Does DRM continue working across repeated playback and restarts?
- Can playback live in a dedicated low-privilege webview, or must it share the main webview?
- Which exact MusicKit/Apple origins are required by CSP?
- What happens to auth on logout/restart?
- Does background/minimized playback remain reliable?

### Before public beta

- Supported minimum Windows 11 build.
- Whether Windows 10 gets best-effort fallback or is unsupported.
- ARM64 protected-playback parity.
- Exact SMTC implementation details.
- Production developer-token service hosting.
- Stable vs beta updater channels.
- Code-signing provider/account.
- Project license and final application branding.

### Do not promise yet

- lossless playback;
- Dolby Atmos;
- synced lyrics;
- offline Apple Music tracks;
- Apple Music Classical parity.

---

# 27. Recommended support policy

For development:

- Windows 11 is the product target.
- x64 is the first implementation target.
- ARM64 is a required release target.
- Windows 10 compatibility may remain best-effort only if it costs almost nothing.

Do not distort the Windows 11 UI to preserve old backdrop behavior.

Before first public release, pick and document an exact supported Windows build after testing current WebView2 and MusicKit behavior.

---

# 28. Branding rule

Until the owner picks a name:

- use a neutral placeholder app name;
- use a placeholder icon;
- do not use the Apple logo as the app icon;
- do not imply the app is published by Apple;
- avoid hardcoding the temporary project name into protocol IDs or package identity where it will be painful to migrate.

---

# 29. Research anchors

Use primary sources first.

### Tauri

- Architecture: https://v2.tauri.app/concept/architecture/
- Capabilities: https://v2.tauri.app/security/capabilities/
- CSP: https://v2.tauri.app/security/csp/
- Window API/effects: https://v2.tauri.app/reference/javascript/api/namespacewindow/
- Windows installer: https://v2.tauri.app/distribute/windows-installer/
- Updater: https://v2.tauri.app/plugin/updater/
- Windows signing: https://v2.tauri.app/distribute/sign/windows/

### Apple

- MusicKit overview: https://developer.apple.com/musickit/
- MusicKit on the Web: https://developer.apple.com/musickit/web/
- Apple Music API: https://developer.apple.com/documentation/AppleMusicAPI
- Developer tokens: https://developer.apple.com/documentation/AppleMusicAPI/generating-developer-tokens
- User authentication: https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit

### Windows

- SMTC integration: https://learn.microsoft.com/en-us/windows/apps/develop/media-playback/integrate-with-systemmediatransportcontrols
- Manual SMTC: https://learn.microsoft.com/en-us/windows/apps/develop/media-playback/system-media-transport-controls
- WebView2 docs: https://learn.microsoft.com/en-us/microsoft-edge/webview2/

### Existing clients / lessons

- Sidra: https://github.com/wimpysworld/sidra
- Sidra specification: https://github.com/wimpysworld/sidra/blob/main/SPECIFICATION.md

Sidra is not a blueprint for the desired UI; it is useful evidence that protected Apple Music playback can dictate the desktop runtime. Its architectural lesson is **validate DRM first**.

---

# 30. Definition of done for the first agent assignment

The first coding-agent task should **not** be "build the Apple Music app."

It should be:

> Create a minimal Tauri v2 Windows-only MusicKit feasibility prototype following this repository's conventions. Prove or disprove reliable full Apple Music subscriber playback in Evergreen WebView2. Keep the UI intentionally minimal. Add no undocumented DRM workaround. Record the exact environment, authorization flow, playback results, failures, WebView2 version, Windows build, and recommendation in `docs/MUSICKIT_TAURI_FEASIBILITY.md`. Only after the gate passes should the agent begin Milestone 1.

A successful first milestone gives the rest of the project permission to exist.
