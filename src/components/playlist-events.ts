import type { Track } from "../domain/music.ts";

export const PLAYLIST_DIALOG_REQUEST = "arlet:playlist-dialog";

export type PlaylistDialogMode = "picker" | "create";

export interface PlaylistDialogRequestDetail {
  mode: PlaylistDialogMode;
  tracks?: readonly Track[];
  restoreFocus?: HTMLElement;
}

export function requestPlaylistDialog(
  mode: PlaylistDialogMode,
  tracks: readonly Track[] = [],
  restoreFocus?: HTMLElement,
): void {
  window.dispatchEvent(
    new CustomEvent<PlaylistDialogRequestDetail>(PLAYLIST_DIALOG_REQUEST, {
      detail: { mode, tracks, restoreFocus },
    }),
  );
}
