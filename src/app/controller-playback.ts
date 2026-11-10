import type { Station } from "../domain/music.ts";
import { getState } from "../state.ts";
import type { createPlayback } from "./playback.ts";

/** Commands that count as user activity for the unattended playback cap. */
export const ACTIVITY_COMMANDS = [
  "togglePlayback",
  "play",
  "pause",
  "next",
  "previous",
  "seek",
  "seekBy",
  "setShuffleMode",
  "cycleRepeatMode",
  "setRepeatMode",
  "playCollection",
  "playPlaylist",
  "playAlbum",
  "playStation",
  "startStation",
  "playNextTracks",
  "playLaterTracks",
  "playQueueItem",
  "removeQueueItem",
  "moveQueueItem",
  "clearUpNext",
  "playTracksShuffled",
  "queueCollection",
] as const;
/** How long after a song Play starts before its autoplay station is checked. */
const AUTOPLAY_STATION_CHECK_MS = 10_000;

/** Calls a controller command, counting it as user activity first. */
export function withActivity<A extends unknown[], R>(
  noteActivity: () => void,
  command: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    noteActivity();
    return command(...args);
  };
}

/** Plays songs and stations through one path that arms the autoplay check. */
export function createPlaybackWrappers(deps: {
  playback: ReturnType<typeof createPlayback>;
  log(message: string): void;
}) {
  const { playback, log } = deps;
  // MusicKit refuses its autoplay station without saying so, and the UI shows
  // no sign of it. After a song Play starts, log once if the queue has none.
  let autoplayCheckTimer: ReturnType<typeof setTimeout> | undefined;
  let playSequence = 0;
  /** A newer Play, or a station, takes over from the Play that armed the check. */
  const cancelAutoplayCheck = (): void => {
    playSequence += 1;
    if (autoplayCheckTimer !== undefined) clearTimeout(autoplayCheckTimer);
    autoplayCheckTimer = undefined;
  };
  const checkAutoplayStation = (): void => {
    autoplayCheckTimer = undefined;
    const state = getState();
    if (!state.settings.autoplay) return;
    if (state.playback.modeCapabilities?.autoplay !== true) return;
    if (state.playback.autoplayStation !== false) return;
    log(
      "Autoplay station unavailable for this account; Autoplay songs are off for this queue.",
    );
  };
  /** Every song Play goes through here, so each one arms the check. */
  const playSongs = async (
    ...args: Parameters<typeof playback.playTracks>
  ): Promise<number | undefined> => {
    cancelAutoplayCheck();
    const mine = playSequence;
    const token = await playback.playTracks(...args);
    // A superseded Play, or one that started nothing, arms no check.
    if (mine === playSequence && token !== undefined) {
      autoplayCheckTimer = setTimeout(
        checkAutoplayStation,
        AUTOPLAY_STATION_CHECK_MS,
      );
    }
    return token;
  };
  const playStationAndCheck = (station: Station): Promise<void> => {
    cancelAutoplayCheck();
    return playback.playStation(station);
  };
  return { cancelAutoplayCheck, playSongs, playStationAndCheck };
}
