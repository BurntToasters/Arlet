import { initializeMusicKit } from "./musickit/bootstrap.ts";
import { authorize, unauthorize, isAuthorized } from "./musickit/auth.ts";
import { playSong, toggle, seekToTime, skipToNext, skipToPrevious, setVolume } from "./musickit/player.ts";
import { registerMusicKitEvents } from "./musickit/events.ts";
import { normalizeTrack } from "./musickit/normalize.ts";
import { getState, setAuthState, resetState } from "./state.ts";

let music: MusicKit.MusicKitInstance | null = null;

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function log(message: string): void {
  const output = $("diag-output");
  const timestamp = new Date().toISOString();
  output.textContent += `[${timestamp}] ${message}\n`;
  output.scrollTop = output.scrollHeight;
}

function updateUI(): void {
  const state = getState();
  const authStatus = $("auth-status");
  const playbackState = $("playback-state");
  const npTitle = $("np-title");
  const npArtist = $("np-artist");
  const trackCounter = $("track-counter");
  const errorDisplay = $("error-display");

  authStatus.textContent =
    state.auth.status === "authorized" ? "Signed in ✓" : "Not signed in";

  playbackState.textContent = `Playback: ${state.playback.status}`;

  if (state.playback.current) {
    npTitle.textContent = state.playback.current.title;
    npArtist.textContent = state.playback.current.artistName;
  } else {
    npTitle.textContent = "—";
    npArtist.textContent = "—";
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

export async function initializeApplication(): Promise<void> {
  const initStatus = $("init-status");
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

  // Enable controls
  const enableIds = [
    "btn-authorize", "btn-unauthorize", "search-input",
    "btn-search", "btn-prev", "btn-play", "btn-next", "seek-slider",
  ];
  for (const id of enableIds) {
    ($(id) as HTMLButtonElement | HTMLInputElement).disabled = false;
  }

  if (isAuthorized(music)) {
    setAuthState({ status: "authorized", musicUserToken: music.musicUserToken });
    log("Already authorized from previous session.");
    updateUI();
  }

  $("btn-authorize").addEventListener("click", async () => {
    if (!music) return;
    try {
      log("Authorizing…");
      const token = await authorize(music);
      setAuthState({ status: "authorized", musicUserToken: token });
      log("Authorization successful.");
      updateUI();
    } catch (error) {
      log(`Authorization failed: ${error instanceof Error ? error.message : String(error)}`);
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
      log(`Sign out failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  $("btn-search").addEventListener("click", async () => {
    if (!music) return;
    const input = $("search-input") as HTMLInputElement;
    const term = input.value.trim();
    if (!term) return;
    log(`Searching: "${term}"`);
    try {
      const response = await music.api.search(term, { types: "songs", limit: 10 });
      const songs = response.songs?.data ?? [];
      const resultsEl = $("search-results");
      resultsEl.innerHTML = "";
      if (songs.length === 0) {
        resultsEl.textContent = "No results found.";
        return;
      }
      for (const song of songs) {
        const track = normalizeTrack(song);
        const btn = document.createElement("button");
        btn.className = "search-result";
        btn.textContent = `${track.title} — ${track.artistName}`;
        btn.addEventListener("click", async () => {
          if (!music) return;
          log(`Playing: ${track.title} by ${track.artistName}`);
          try {
            await playSong(music, track.id);
          } catch (error) {
            log(`Play failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
        resultsEl.appendChild(btn);
      }
      log(`Found ${songs.length} results.`);
    } catch (error) {
      log(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  $("btn-play").addEventListener("click", async () => {
    if (!music) return;
    try {
      await toggle(music);
    } catch (error) {
      log(`Toggle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  $("btn-prev").addEventListener("click", async () => {
    if (!music) return;
    try {
      await skipToPrevious(music);
    } catch (error) {
      log(`Previous failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  $("btn-next").addEventListener("click", async () => {
    if (!music) return;
    try {
      await skipToNext(music);
    } catch (error) {
      log(`Next failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const seekSlider = $("seek-slider") as HTMLInputElement;
  seekSlider.addEventListener("change", async () => {
    if (!music) return;
    const seconds = Number(seekSlider.value);
    try {
      await seekToTime(music, seconds);
    } catch (error) {
      log(`Seek failed: ${error instanceof Error ? error.message : String(error)}`);
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
}
