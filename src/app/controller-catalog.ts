import {
  loadCuratorPage,
  loadCuratorPlaylistsPage,
  loadPlaylistCurator,
} from "../musickit/curators.ts";
import { loadRecordLabel } from "../musickit/record-labels.ts";
import { loadActivity } from "../musickit/activities.ts";
import { loadSongInfo } from "../musickit/song-info.ts";
import { safeNextPath } from "../musickit/response.ts";
import type { CuratorKind } from "../routing/router.ts";
import {
  setActivityState,
  setRecordLabelState,
  setSongInfoState,
} from "../state.ts";
import type {
  Activity,
  RecordLabel,
  SongInfo,
  Track,
} from "../domain/music.ts";
import { safeErrorMessage } from "./controller-support.ts";

/** Catalog page loads. Each loader drops a response a newer request superseded. */
export function createCatalogLoaders(deps: {
  requireMusic(): MusicKit.MusicKitInstance;
  accountGeneration(): number;
}) {
  const { requireMusic, accountGeneration } = deps;
  // Each loader counts its own requests; an older response never overwrites a newer one.
  let recordLabelRequestId = 0;
  let activityRequestId = 0;
  let songInfoRequestId = 0;
  return {
    loadCurator: (id: string, kind: CuratorKind) =>
      loadCuratorPage(requireMusic(), id, kind),
    loadMoreCuratorPlaylists: (next: string) => {
      const cursor = safeNextPath(next, ["/v1/catalog/"]);
      return cursor
        ? loadCuratorPlaylistsPage(requireMusic(), cursor)
        : Promise.resolve({ playlists: [] });
    },
    loadPlaylistCurator: (playlistId: string) =>
      loadPlaylistCurator(requireMusic(), playlistId),
    async loadRecordLabel(id: string): Promise<RecordLabel | undefined> {
      const account = accountGeneration();
      const requestId = ++recordLabelRequestId;
      const current = (): boolean =>
        requestId === recordLabelRequestId && account === accountGeneration();
      setRecordLabelState({ status: "loading", id });
      try {
        const page = await loadRecordLabel(requireMusic(), id);
        if (!current()) return undefined;
        setRecordLabelState({ status: "success", id, page });
        return page;
      } catch (error) {
        if (!current()) return undefined;
        setRecordLabelState({
          status: "error",
          id,
          error: safeErrorMessage(error),
        });
        throw error;
      }
    },
    async loadActivity(id: string): Promise<Activity | undefined> {
      const account = accountGeneration();
      const requestId = ++activityRequestId;
      const current = (): boolean =>
        requestId === activityRequestId && account === accountGeneration();
      setActivityState({ status: "loading", id });
      try {
        const page = await loadActivity(requireMusic(), id);
        if (!current()) return undefined;
        setActivityState({ status: "success", id, page });
        return page;
      } catch (error) {
        if (!current()) return undefined;
        setActivityState({
          status: "error",
          id,
          error: safeErrorMessage(error),
        });
        throw error;
      }
    },
    async loadSongInfo(track: Track): Promise<SongInfo | undefined> {
      const account = accountGeneration();
      const requestId = ++songInfoRequestId;
      const current = (): boolean =>
        requestId === songInfoRequestId && account === accountGeneration();
      setSongInfoState({ status: "loading", id: track.id });
      try {
        const info = await loadSongInfo(requireMusic(), track);
        if (!current()) return undefined;
        setSongInfoState({ status: "success", id: track.id, info });
        return info;
      } catch (error) {
        if (!current()) return undefined;
        setSongInfoState({
          status: "error",
          id: track.id,
          error: safeErrorMessage(error),
        });
        throw error;
      }
    },
  };
}
