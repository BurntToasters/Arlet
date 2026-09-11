# Arlet Project Tasklist & Context

This document tracks our progress through the Arlet `plan.md` architecture brief to easily pick up where we left off.

## ✅ Phase 0 Scaffolding (Completed)
- [x] **Project Scaffolding:** Initialized Tauri v2 project with vanilla TypeScript and Vite.
- [x] **Zinnia Script Porting:** Replicated Zinnia's script architecture, `package.json` configurations, and Git hooks (e.g., `pre-commit`, `commit-msg`, `sync-version`).
- [x] **Rust Backend Scaffolding:** Implemented core backend modules (`logging.rs`, `settings.rs`, `window_fx.rs` for Mica/Acrylic), matching Zinnia's best practices.
- [x] **MusicKit Frontend Integration:** Created a minimal, isolated test UI.
  - Implemented strong domain typing (`Track`, `Album`, `PlaybackState`).
  - Created strict wrappers around MusicKit JS (`auth.ts`, `player.ts`, `events.ts`, `normalize.ts`).
  - Unit tested MusicKit normalizers and application state machine (Vitest).
- [x] **Security & Tooling:** Configured strict CSP allowing Apple Music domains, configured `vitest`, `eslint`, and `tsc` which are currently fully passing.

## ⏳ Phase 0 Manual Feasibility Gate (Next Steps)
> **Goal:** Prove or disprove reliable full Apple Music subscriber playback in Evergreen WebView2 before investing in the full UI.

- [ ] Create a `.env.local` file at the repository root and add your developer token:
  ```env
  VITE_MUSICKIT_DEVELOPER_TOKEN=your_token_here
  ```
- [ ] Launch the app via `npm run tauri:dev`.
- [ ] Click "Sign In" to authorize your Apple Music account.
- [ ] Search for a track and attempt playback.
- [ ] Verify the following functionality:
  - Full playback (not just 30-second previews).
  - Seeking, volume control, and skipping.
  - 20+ consecutive tracks without DRM/Media errors.
- [ ] Record the precise testing environment, network calls, and pass/fail status in:
  - `docs/MUSICKIT_TAURI_FEASIBILITY.md`
  - `docs/MUSICKIT_NETWORK_SURFACE.md`

## 🚀 Future Milestones (Pending Feasibility Gate)
*See `plan.md` for full milestone details.*

- [ ] **Milestone 1:** Core structure (Navigation, Window management, layout shell)
- [ ] **Milestone 2:** Playback & Queue (Robust state synchronization, media session integration)
- [ ] **Milestone 3:** User Library (Albums, playlists, infinite scroll fetching)
- [ ] **Milestone 4:** OS Integration (Windows SMTC, Mica effects refinement)
- [ ] **Milestone 5:** Polish & Performance
- [ ] **Milestone 6:** Release Engineering
