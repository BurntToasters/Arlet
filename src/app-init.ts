import { invoke } from "@tauri-apps/api/core";
import { initializeMusicKit } from "./musickit/bootstrap.ts";
import {
  authorize,
  unauthorize,
  isAuthorized,
  installAuthPopupProbe,
} from "./musickit/auth.ts";
import {
  CONSECUTIVE_TRACK_TARGET,
  playQueue,
  toggle,
  seekToTime,
  skipToNext,
  skipToPrevious,
  setVolume,
} from "./musickit/player.ts";
import { registerMusicKitEvents } from "./musickit/events.ts";
import { searchCatalogSongs } from "./musickit/catalog.ts";
import { classifyPlaybackKind } from "./musickit/preview.ts";
import { normalizeTrack } from "./musickit/normalize.ts";
import { getState, setAuthState, resetState, setQueue } from "./state.ts";
import { redactSensitive } from "./platform/redact.ts";
import {
  GATE_CHECKLIST,
  copyTextToClipboard,
  formatFeasibilityReport,
  formatNetworkSurfaceMarkdown,
  formatSessionDuration,
  getObservedHosts,
  getSessionStartedAt,
  loadChecklistState,
  saveChecklistState,
  startNetworkObserver,
  toggleChecklistItem,
  type GateEnvironment,
} from "./phase0/gate-session.ts";
import { registerLifecycleDiagnostics } from "./phase0/lifecycle.ts";

let music: MusicKit.MusicKitInstance | null = null;
let gateEnvironment: GateEnvironment | null = null;
let sessionStartedAt = getSessionStartedAt();
let checklistState = loadChecklistState();
let lastSearchTracks: ReturnType<typeof normalizeTrack>[] = [];
const recordedFailures: string[] = [];

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function log(message: string): void {
  const output = $("diag-output");
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${redactSensitive(message)}`;
  output.textContent += `${line}\n`;
  output.scrollTop = output.scrollHeight;
  if (/failed|error|drm|denied|unavailable/i.test(message)) {
    recordedFailures.push(line);
  }
}

function updateGateProgress(): void {
  const checked = Object.values(checklistState).filter(Boolean).length;
  $("gate-progress").textContent =
    `${checked} / ${GATE_CHECKLIST.length} checklist items complete`;
}

function renderGateChecklist(): void {
  const container = $("gate-checklist");
  container.innerHTML = "";
  for (const item of GATE_CHECKLIST) {
    const label = document.createElement("label");
    label.className = "gate-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checklistState[item.id] ?? false;
    input.addEventListener("change", () => {
      checklistState = toggleChecklistItem(checklistState, item.id);
      updateGateProgress();
    });
    const text = document.createElement("span");
    text.textContent = item.label;
    label.append(input, text);
    container.appendChild(label);
  }
  updateGateProgress();
}

function updateSessionTimer(): void {
  $("session-timer").textContent =
    `Session: ${formatSessionDuration(sessionStartedAt)}`;
}

function buildFeasibilityReport(): string {
  const env = gateEnvironment ?? {
    version: "unknown",
    tauriVersion: "unknown",
    os: "unknown",
    arch: "unknown",
    webviewVersion: null,
    windowsBuild: null,
    debug: true,
    nodeVersion: __BUILD_NODE_VERSION__,
    npmVersion: __BUILD_NPM_VERSION__,
    rustToolchain: "stable",
    rustcVersion: null,
  };
  return formatFeasibilityReport({
    environment: env,
    appState: getState(),
    sessionStartedAt,
    diagLog: ($("diag-output").textContent ?? "").trim(),
    checklist: checklistState,
    observedHosts: getObservedHosts(),
    failures: recordedFailures,
  });
}

function updateUI(): void {
  const state = getState();
  const authStatus = $("auth-status");
  const playbackState = $("playback-state");
  const npTitle = $("np-title");
  const npArtist = $("np-artist");
  const npKind = $("np-kind");
  const trackCounter = $("track-counter");
  const errorDisplay = $("error-display");

  authStatus.textContent =
    state.auth.status === "authorized" ? "Signed in ✓" : "Not signed in";

  playbackState.textContent = `Playback: ${state.playback.status}`;

  if (state.playback.current) {
    npTitle.textContent = state.playback.current.title;
    npArtist.textContent = state.playback.current.artistName;
    const catalogSeconds = state.playback.current.durationMs
      ? state.playback.current.durationMs / 1000
      : undefined;
    const kind = classifyPlaybackKind({
      catalogDurationSeconds: catalogSeconds,
      playbackDurationSeconds: state.playback.durationSeconds,
    });
    if (kind === "preview") {
      npKind.textContent = `Playback kind: PREVIEW (${Math.round(state.playback.durationSeconds)}s stream vs catalog ${Math.round(catalogSeconds ?? 0)}s)`;
      npKind.classList.add("is-preview");
    } else if (kind === "full") {
      npKind.textContent = `Playback kind: full (${Math.round(state.playback.durationSeconds)}s)`;
      npKind.classList.remove("is-preview");
    } else {
      npKind.textContent = "Playback kind: —";
      npKind.classList.remove("is-preview");
    }
  } else {
    npTitle.textContent = "—";
    npArtist.textContent = "—";
    npKind.textContent = "Playback kind: —";
    npKind.classList.remove("is-preview");
  }

  trackCounter.textContent = `Tracks played: ${state.tracksPlayed}`;

  if (state.playback.error) {
    errorDisplay.textContent = `Error [${state.playback.error.code}]: ${state.playback.error.message}`;
    errorDisplay.style.display = "block";
  } else {
    errorDisplay.style.display = "none";
  }

  const seekSlider = $("seek-slider") as HTMLInputElement;
  if (state.playback.durationSeconds > 0) {
    seekSlider.max = String(Math.floor(state.playback.durationSeconds));
    seekSlider.value = String(Math.floor(state.playback.positionSeconds));
  }
}

interface NativeDiagnostics {
  version: string;
  tauri_version: string;
  os: string;
  arch: string;
  webview_version: string | null;
  rustc_version: string | null;
  windows_build: string | null;
  debug: boolean;
}

async function logDiagnostics(): Promise<void> {
  try {
    const info = await invoke<NativeDiagnostics>("get_app_info");
    gateEnvironment = {
      version: info.version,
      tauriVersion: info.tauri_version,
      os: info.os,
      arch: info.arch,
      webviewVersion: info.webview_version,
      windowsBuild: info.windows_build,
      debug: info.debug,
      nodeVersion: __BUILD_NODE_VERSION__,
      npmVersion: __BUILD_NPM_VERSION__,
      rustToolchain: "stable",
      rustcVersion: info.rustc_version,
    };
    log(
      `App ${info.version} / Tauri ${info.tauri_version} / ` +
        `${info.os}-${info.arch} / WebView2 ${info.webview_version ?? "unknown"} / ` +
        `Windows ${info.windows_build ?? "unknown"} / ` +
        `${info.debug ? "debug" : "release"}`,
    );
  } catch {
    log("Running outside the Tauri shell; native diagnostics unavailable.");
  }
}

function wireGateControls(): void {
  renderGateChecklist();
  updateSessionTimer();
  window.setInterval(updateSessionTimer, 1000);

  const enableIds = [
    "btn-copy-feasibility",
    "btn-copy-network",
    "btn-reset-checklist",
    "btn-music-diagnostic",
  ];
  for (const id of enableIds) {
    ($(id) as HTMLButtonElement).disabled = false;
  }

  $("btn-copy-feasibility").addEventListener("click", async () => {
    try {
      await copyTextToClipboard(buildFeasibilityReport());
      log("Feasibility report copied to clipboard.");
    } catch (error) {
      log(
        `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-copy-network").addEventListener("click", async () => {
    try {
      await copyTextToClipboard(
        formatNetworkSurfaceMarkdown(getObservedHosts()),
      );
      log("Network surface copied to clipboard.");
    } catch (error) {
      log(
        `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-reset-checklist").addEventListener("click", () => {
    checklistState = Object.fromEntries(
      GATE_CHECKLIST.map((item) => [item.id, false]),
    );
    saveChecklistState(checklistState);
    renderGateChecklist();
    log("Feasibility checklist reset.");
  });

  $("btn-music-diagnostic").addEventListener("click", async () => {
    try {
      log("Opening unprivileged music.apple.com diagnostic webview…");
      const result = await invoke<string>("open_music_diagnostic");
      log(
        `Diagnostic window ${result}. Sign in on music.apple.com — no developer token on this path.`,
      );
    } catch (error) {
      log(
        `Diagnostic window failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export async function initializeApplication(): Promise<void> {
  const initStatus = $("init-status");
  startNetworkObserver();
  registerLifecycleDiagnostics(log);
  wireGateControls();
  await logDiagnostics();
  log("Initializing MusicKit…");

  try {
    music = await initializeMusicKit();
    initStatus.textContent = "MusicKit: ready ✓";
    log("MusicKit initialized successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    initStatus.textContent = `MusicKit: failed — ${message}`;
    log(`MusicKit init failed: ${message}`);
    return;
  }

  registerMusicKitEvents(music, updateUI);
  installAuthPopupProbe(log);

  // Enable controls
  const enableIds = [
    "btn-authorize",
    "btn-unauthorize",
    "search-input",
    "btn-search",
    "btn-prev",
    "btn-play",
    "btn-next",
    "seek-slider",
  ];
  for (const id of enableIds) {
    ($(id) as HTMLButtonElement | HTMLInputElement).disabled = false;
  }

  if (isAuthorized(music)) {
    setAuthState({
      status: "authorized",
      musicUserToken: music.musicUserToken,
    });
    log("Already authorized from previous session.");
    updateUI();
  }

  let authorizing = false;
  $("btn-authorize").addEventListener("click", async () => {
    if (!music || authorizing) return;
    authorizing = true;
    const button = $("btn-authorize") as HTMLButtonElement;
    button.disabled = true;
    try {
      log("Authorizing… waiting for Apple Music sign-in window.");
      const token = await authorize(music);
      setAuthState({ status: "authorized", musicUserToken: token });
      log("Authorization successful.");
      updateUI();
    } catch (error) {
      log(
        `Authorization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      authorizing = false;
      button.disabled = false;
    }
  });

  $("btn-unauthorize").addEventListener("click", async () => {
    if (!music) return;
    try {
      await unauthorize(music);
      resetState();
      log("Signed out.");
      updateUI();
    } catch (error) {
      log(
        `Sign out failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-search").addEventListener("click", async () => {
    if (!music) return;
    const input = $("search-input") as HTMLInputElement;
    const term = input.value.trim();
    if (!term) return;
    log(`Searching: "${term}"`);
    try {
      lastSearchTracks = await searchCatalogSongs(music, term, { limit: 25 });
      const resultsEl = $("search-results");
      resultsEl.innerHTML = "";
      const consecutiveButton = $("btn-play-consecutive") as HTMLButtonElement;
      consecutiveButton.disabled =
        lastSearchTracks.length < CONSECUTIVE_TRACK_TARGET;
      if (lastSearchTracks.length === 0) {
        resultsEl.textContent = "No results found.";
        return;
      }
      lastSearchTracks.forEach((track, index) => {
        const btn = document.createElement("button");
        btn.className = "search-result";
        btn.textContent = `${track.title} — ${track.artistName}`;
        btn.addEventListener("click", async () => {
          if (!music) return;
          log(
            `Playing queue from "${track.title}" (${lastSearchTracks.length} results)`,
          );
          try {
            setQueue(lastSearchTracks, index);
            await playQueue(
              music,
              lastSearchTracks.map((item) => item.id),
              index,
            );
          } catch (error) {
            log(
              `Play failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        });
        resultsEl.appendChild(btn);
      });
      log(
        `Found ${lastSearchTracks.length} results.` +
          (lastSearchTracks.length >= CONSECUTIVE_TRACK_TARGET
            ? ` Consecutive ${CONSECUTIVE_TRACK_TARGET}-track queue is ready.`
            : ` Search a catalog term with at least ${CONSECUTIVE_TRACK_TARGET} songs for the consecutive-track matrix.`),
      );
    } catch (error) {
      log(
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-play").addEventListener("click", async () => {
    if (!music) return;
    try {
      await toggle(music);
    } catch (error) {
      log(
        `Toggle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-prev").addEventListener("click", async () => {
    if (!music) return;
    try {
      await skipToPrevious(music);
    } catch (error) {
      log(
        `Previous failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-next").addEventListener("click", async () => {
    if (!music) return;
    try {
      await skipToNext(music);
    } catch (error) {
      log(
        `Next failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  $("btn-play-consecutive").addEventListener("click", async () => {
    if (!music) return;
    if (lastSearchTracks.length < CONSECUTIVE_TRACK_TARGET) {
      log(
        `Need at least ${CONSECUTIVE_TRACK_TARGET} search results for the consecutive-track matrix.`,
      );
      return;
    }
    const queue = lastSearchTracks.slice(0, CONSECUTIVE_TRACK_TARGET);
    log(`Queuing ${queue.length} consecutive tracks.`);
    try {
      setQueue(queue, 0);
      await playQueue(
        music,
        queue.map((track) => track.id),
      );
    } catch (error) {
      log(
        `Consecutive play failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const seekSlider = $("seek-slider") as HTMLInputElement;
  seekSlider.addEventListener("change", async () => {
    if (!music) return;
    const seconds = Number(seekSlider.value);
    try {
      await seekToTime(music, seconds);
    } catch (error) {
      log(
        `Seek failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const volumeSlider = $("volume-slider") as HTMLInputElement;
  volumeSlider.addEventListener("input", () => {
    if (!music) return;
    setVolume(music, Number(volumeSlider.value) / 100);
  });

  $("search-input").addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") {
      $("btn-search").click();
    }
  });

  log("Phase 0 UI ready. Sign in to begin testing.");
  log(
    "Use the feasibility matrix checklist, then copy reports into docs/MUSICKIT_TAURI_FEASIBILITY.md and docs/MUSICKIT_NETWORK_SURFACE.md.",
  );
}
