import { loadReplay } from "../musickit/replay.ts";
import { getState, setHomeState, type HomeState } from "../state.ts";
import {
  asLibraryEntities,
  asRecord,
  libraryMethod,
  safeErrorMessage,
} from "./controller-support.ts";
import {
  OFFLINE_MESSAGE,
  type LibraryLoaderDeps,
} from "./library-loader-helpers.ts";

export function createHomeLoader(deps: LibraryLoaderDeps) {
  const { context, cache, requireLibrary, isOffline } = deps;
  const { requireMusic, now, log } = context;
  const { isAccountGenerationCurrent } = cache;
  let homeRequestId = 0;

  const loadHome = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    const generation = cache.currentGeneration();
    if (isOffline()) throw new Error(OFFLINE_MESSAGE);
    requireLibrary();
    const current = getState().home;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++homeRequestId;
    const isCurrent = (): boolean =>
      isAccountGenerationCurrent(generation) && homeRequestId === requestId;
    setHomeState({
      status:
        current.recentPlaylists.length ||
        current.heavyRotation.length ||
        current.recommendations.length
          ? "refreshing"
          : "loading",
      errors: {},
    });
    const client = requireLibrary();
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        libraryMethod(client, "getRecentlyPlayed")(20),
      ),
      Promise.resolve().then(() =>
        libraryMethod(client, "getHeavyRotation")(10),
      ),
      Promise.resolve().then(() =>
        libraryMethod(client, "getRecommendations")(10),
      ),
      // Replay runs beside the Home shelves. Its failure is logged and reads as
      // no Replay, so it never fails Home or counts toward its status.
      Promise.resolve()
        .then(() => loadReplay(requireMusic()))
        .catch((error: unknown) => {
          log(`Replay unavailable: ${safeErrorMessage(error)}`);
          return undefined;
        }),
    ]);
    if (!isCurrent()) return;

    const errors: HomeState["errors"] = {};
    let successful = 0;
    let recentPlaylists = current.recentPlaylists;
    let heavyRotation = current.heavyRotation;
    let recommendations = current.recommendations;
    const [recentResult, heavyResult, recommendationResult, replayResult] =
      results;
    const replay =
      replayResult.status === "fulfilled" ? replayResult.value : undefined;
    if (recentResult.status === "fulfilled") {
      successful += 1;
      // Home resources include stations, which HomeState does not type yet.
      recentPlaylists = asLibraryEntities(
        asRecord(recentResult.value)?.items ?? recentResult.value,
      ) as HomeState["recentPlaylists"];
    } else {
      errors.recentPlaylists = safeErrorMessage(recentResult.reason);
    }
    if (heavyResult.status === "fulfilled") {
      successful += 1;
      heavyRotation = asLibraryEntities(
        asRecord(heavyResult.value)?.items ?? heavyResult.value,
      ) as HomeState["heavyRotation"];
    } else {
      errors.heavyRotation = safeErrorMessage(heavyResult.reason);
    }
    if (recommendationResult.status === "fulfilled") {
      successful += 1;
      recommendations = Array.isArray(recommendationResult.value)
        ? (recommendationResult.value as HomeState["recommendations"])
        : [];
    } else {
      errors.recommendations = safeErrorMessage(recommendationResult.reason);
    }
    const hasData =
      recentPlaylists.length > 0 ||
      heavyRotation.length > 0 ||
      recommendations.length > 0;
    const updatedAt = now();
    setHomeState({
      status: successful > 0 ? "success" : "error",
      recentPlaylists,
      heavyRotation,
      recommendations,
      errors,
      lastUpdatedAt: successful > 0 ? updatedAt : current.lastUpdatedAt,
      stale: hasData && successful < 3,
      replay: replay ?? null,
    });
    if (successful === 0) {
      throw new Error(
        Object.values(errors).filter(Boolean).join("; ") ||
          "Apple Music Home is unavailable.",
      );
    }
  };
  return {
    loadHome,
    /** Stops a Home load in flight, so its result is ignored. */
    invalidate(): void {
      homeRequestId += 1;
    },
  };
}
