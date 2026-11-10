import type { Track } from "../domain/music.ts";

export const PLAYLIST_DIALOG_REQUEST = "arlet:playlist-dialog";

export type PlaylistDialogMode = "picker" | "create" | "folder";

export interface PlaylistDialogRequestDetail {
  mode: PlaylistDialogMode;
  tracks?: readonly Track[];
  restoreFocus?: HTMLElement;
  /** Preselects this folder in the dialog's Folder choice. */
  parentFolderId?: string;
}

export function requestPlaylistDialog(
  mode: PlaylistDialogMode,
  tracks: readonly Track[] = [],
  restoreFocus?: HTMLElement,
  parentFolderId?: string,
): void {
  window.dispatchEvent(
    new CustomEvent<PlaylistDialogRequestDetail>(PLAYLIST_DIALOG_REQUEST, {
      detail: {
        mode,
        tracks,
        restoreFocus,
        ...(parentFolderId ? { parentFolderId } : {}),
      },
    }),
  );
}
