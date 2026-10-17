import { Volume2, VolumeX } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppSlices } from "../app/context.tsx";

/** Spoken volume for the slider, e.g. `60%`. */
export function volumeValueText(volume: number): string {
  return `${Math.round(volume * 100)}%`;
}

/** Mute toggle and volume slider, shared by Now Playing. Mirrors the player bar. */
export function VolumeControl(): JSX.Element {
  const state = useAppSlices("playback");
  const controller = useAppController();
  const playback = state.playback;
  const muted = playback.muted === true;
  const shownVolume = muted ? 0 : playback.volume;
  return (
    <div className="volume-control">
      <button
        className="volume-mute-button"
        type="button"
        aria-label={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
        onClick={() => controller.toggleMute()}
      >
        {muted || playback.volume === 0 ? (
          <VolumeX aria-hidden="true" size={16} strokeWidth={1.8} />
        ) : (
          <Volume2 aria-hidden="true" size={16} strokeWidth={1.8} />
        )}
      </button>
      <input
        aria-label="Volume"
        aria-valuetext={volumeValueText(shownVolume)}
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={shownVolume}
        style={{ "--range-progress": `${shownVolume * 100}%` }}
        onInput={(event) => {
          void controller.setVolume(Number(event.currentTarget.value));
        }}
      />
    </div>
  );
}
