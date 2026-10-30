import {
  friendlyPlaybackMessage,
  httpStatusOf,
  mapErrorToCode,
} from "../musickit/errors.ts";
import {
  changeToMediaAtIndex,
  queueDescriptorsForTracks,
  queueOptionsForTracks,
  preparePlaybackModesForPlay,
  readMusicKitQueue,
  readPlaybackModes,
} from "../musickit/player.ts";
import { isSameTrack, type Track } from "../domain/music.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
import {
  keptStartIndex,
  NONE_AVAILABLE_MESSAGE,
  skippedMessage,
  unresolvedIds,
  withResolvableTracks,
} from "../musickit/unresolved.ts";
import { reportActionError } from "../components/action-errors.ts";
import type { PlayTiming } from "./collection-playback.ts";
import {
  FIRST_BATCH_LENGTH,
  startWindow,
  type PlayOptions,
} from "./queue-window.ts";
import {
  clearPlaybackError,
  getState,
  setPlaybackError,
  setPlaybackPosition,
  setPlaybackStatus,
  setQueue,
  subscribe,
} from "../state.ts";
import { errorMessage, safeErrorMessage } from "./controller-support.ts";
import type { PlaybackContext } from "./playback.ts";
import type { QueueContinuation } from "./queue-continuation.ts";

/** A Play that is not audible by then is not timed. */
const PLAY_TIMING_TIMEOUT_MS = 60_000;

/** First batches tried when every song in one is unavailable. */
const MAX_UNAVAILABLE_BATCHES = 4;
/** Pause before retrying a queue setup that failed on a song lookup. */
const SET_QUEUE_RETRY_DELAY_MS = 600;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A lookup that returned no usable body, as opposed to a real refusal. */
function isTransientLookupFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = httpStatusOf(error);
  return (
    /Unable to read body as JSON/iu.test(message) ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

/** Shared request tokens and failure reporting for every play path. */
export function createPlayRequests(context: PlaybackContext) {
  const { log, session, suspectSession } = context;
  const { requireMusic } = context;

  const reportPlayFailure = (label: string, error: unknown): void => {
    const message = safeErrorMessage(error);
    setPlaybackError(mapErrorToCode(error), friendlyPlaybackMessage(error));
    log(`${label}: ${message}`);
    suspectSession?.(error);
  };

  /** One play request. `current` gates state writes; `mayStart` gates audio. */
  const beginPlayRequest = (instance?: MusicKit.MusicKitInstance) => {
    const intent = ++session.playIntent;
    // Any new play replaces a station; playStation sets it again after this.
    session.station = undefined;
    const shuffleReady = preparePlaybackModesForPlay(
      instance ?? requireMusic(),
    );
    const pauses = session.pauseCount;
    return {
      current: (): boolean => intent === session.playIntent,
      shuffleReady,
      mayStart: (): boolean =>
        intent === session.playIntent &&
        (pauses === session.pauseCount ||
          session.playPressedAt === session.pauseCount),
    };
  };

  /**
   * Starts audio only while the request may. A request paused during setup
   * stays paused, even if MusicKit started playing after its selection.
   */
  const startAudio = async (
    instance: MusicKit.MusicKitInstance,
    request: ReturnType<typeof beginPlayRequest>,
  ): Promise<void> => {
    if (request.mayStart()) await instance.play();
    else if (request.current()) instance.pause();
  };

  return { beginPlayRequest, startAudio, reportPlayFailure };
}

export type PlayRequests = ReturnType<typeof createPlayRequests>;

/** The Play path: queue setup, the first batch, and the rest of a playlist. */
export function createPlayTracks(
  context: PlaybackContext,
  continuation: QueueContinuation,
  requests: PlayRequests,
) {
  const { requireMusic, log, session } = context;
  const { beginPlayRequest, startAudio, reportPlayFailure } = requests;
  const { clearContinuation, setRest, maybeRefillQueue } = continuation;

  /**
   * Index to select after `setQueue`, or undefined when MusicKit already sits
   * on the chosen song. MusicKit drops unplayable songs and, with shuffle on,
   * reorders the rest, so the chosen occurrence is located by ID.
   */
  const providerStartIndex = (
    instance: MusicKit.MusicKitInstance,
    queue: readonly Track[],
    startIndex: number,
  ): number | undefined => {
    const chosen = queue[startIndex];
    const provider = readMusicKitQueue(instance);
    if (!provider) return startIndex;
    const shuffled = readPlaybackModes(instance).shuffleMode === "songs";
    const matches: number[] = [];
    provider.items.forEach((item, index) => {
      if (isSameTrack(normalizeTrack(item), chosen)) matches.push(index);
    });
    if (matches.length === 0) return startIndex;
    // Without shuffle the order is kept, so pick the same duplicate occurrence.
    const occurrence = queue
      .slice(0, startIndex)
      .filter((track) => isSameTrack(track, chosen)).length;
    const expected = shuffled
      ? undefined
      : (matches[occurrence] ?? matches[matches.length - 1]);
    const onChosen = shuffled
      ? matches.includes(provider.index)
      : provider.index === expected;
    if (onChosen) return undefined;
    return expected ?? matches[0];
  };

  /**
   * Logs how long a Play took from the request to audible playback, step by
   * step, so slow starts can be diagnosed from a support report. Gives up
   * quietly if the play is replaced or nothing plays within the timeout.
   */
  const logWhenAudible = (
    request: ReturnType<typeof beginPlayRequest>,
    startedAt: number,
    steps: readonly string[],
  ): void => {
    let stop = (): void => undefined;
    const check = (): void => {
      if (!request.current()) {
        stop();
        return;
      }
      if (getState().playback.status !== "playing") return;
      stop();
      log(
        `Play timing: audible after ${Math.round(performance.now() - startedAt)}ms (${steps.join(", ")}).`,
      );
    };
    const unsubscribe = subscribe(check);
    const timer = setTimeout(() => stop(), PLAY_TIMING_TIMEOUT_MS);
    stop = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    check();
  };

  const playTracks = async (
    requestedTracks: readonly Track[],
    requestedStart = 0,
    timing?: PlayTiming,
    options: PlayOptions = {},
  ): Promise<number | undefined> => {
    const startedAt = timing?.startedAt ?? performance.now();
    const steps = [...(timing?.steps ?? [])];
    let stepStartedAt = performance.now();
    const step = (name: string): void => {
      const now = performance.now();
      steps.push(`${name} ${Math.round(now - stepStartedAt)}ms`);
      stepStartedAt = now;
    };
    const instance = requireMusic();
    if (requestedTracks.length === 0) throw new Error("Queue is empty");
    if (
      !Number.isInteger(requestedStart) ||
      requestedStart < 0 ||
      requestedStart >= requestedTracks.length
    ) {
      throw new Error("The selected song is unavailable.");
    }
    const request = beginPlayRequest(instance);
    if (!request.shuffleReady) {
      const error = new Error("Shuffle could not be restored before playback.");
      reportPlayFailure("Play failed", error);
      throw error;
    }
    const shuffled = readPlaybackModes(instance).shuffleMode === "songs";
    const split = startWindow(
      requestedTracks,
      requestedStart,
      shuffled,
      options,
    );
    let batch = split.batch;
    let rest = split.rest;
    clearContinuation();
    const generation = session.restGeneration;
    const setProviderQueue = async (
      options: MusicKit.QueueOptions,
    ): Promise<void> => {
      if (!request.current()) {
        throw new Error("Play request is no longer current.");
      }
      await instance.setQueue(options);
    };
    if (rest.length) {
      log(
        `Queued ${batch.length} of ${requestedTracks.length} songs; the rest load as the queue plays.`,
      );
    }
    clearPlaybackError();
    let batchStart = split.startIndex;
    setQueue([...batch], batchStart);
    // The previous song's position would otherwise show until MusicKit's
    // first time event, and Previous would read it as past the restart point.
    setPlaybackPosition(0, (batch[batchStart]?.durationMs ?? 0) / 1000);
    setPlaybackStatus("loading");
    try {
      // MusicKit's queue starts at the chosen song, so it never prepares a
      // different item first. A batch with no playable song moves on to the
      // next one rather than failing a Play that later songs could satisfy.
      let resolved: Awaited<ReturnType<typeof withResolvableTracks>>;
      let usedDetails = false;
      const skippedBefore: Track[] = [];
      for (let attempt = 1; ; attempt += 1) {
        try {
          resolved = await withResolvableTracks(
            batch,
            async (entries) => {
              const queued = entries.map((entry) => entry.track);
              const startWith = keptStartIndex(entries, batchStart);
              const options = { ...queueOptionsForTracks(queued), startWith };
              // Song details skip MusicKit's lookup; IDs are the fallback.
              const detailed = queueDescriptorsForTracks(queued);
              if (detailed) {
                try {
                  await setProviderQueue({ ...detailed, startWith });
                  usedDetails = true;
                  return;
                } catch (error) {
                  // Named unavailable songs go to the skip logic as with IDs.
                  if (!request.current() || unresolvedIds(error)) throw error;
                  log(
                    `Queue setup with song details failed; using IDs: ${errorMessage(error)}`,
                  );
                }
              }
              usedDetails = false;
              try {
                await setProviderQueue(options);
              } catch (error) {
                // One of MusicKit's song lookups can fail with an empty or
                // HTML body (Apple throttling); try once more.
                if (!isTransientLookupFailure(error) || !request.current()) {
                  throw error;
                }
                log(
                  `Queue setup failed once; retrying: ${errorMessage(error)}`,
                );
                await delay(SET_QUEUE_RETRY_DELAY_MS);
                // A newer Play during the pause owns MusicKit's queue now.
                if (!request.current()) throw error;
                await setProviderQueue(options);
              }
            },
            request.current,
          );
          break;
        } catch (error) {
          const unavailable =
            error instanceof Error && error.message === NONE_AVAILABLE_MESSAGE;
          if (
            !unavailable ||
            rest.length === 0 ||
            attempt >= MAX_UNAVAILABLE_BATCHES ||
            !request.current()
          ) {
            throw error;
          }
          skippedBefore.push(...batch);
          batch = rest.slice(0, FIRST_BATCH_LENGTH);
          rest = rest.slice(FIRST_BATCH_LENGTH);
          batchStart = 0;
          if (request.current()) setQueue([...batch], 0);
        }
      }
      step(`setQueue (${batch.length} songs${usedDetails ? ", details" : ""})`);
      let queue = resolved.entries.map((entry) => entry.track);
      let start = keptStartIndex(resolved.entries, batchStart);
      const skipped = [...skippedBefore, ...resolved.skipped];
      if (skipped.length) {
        log(`Skipped ${skipped.length} unavailable songs.`);
        if (request.current()) {
          setQueue(queue, start);
          const message = skippedMessage(skipped.length);
          if (message) reportActionError(new Error(message));
        }
      }
      if (request.current()) {
        session.startHistory = split.history;
        session.historyAnchor = queue[start];
      }
      // Normally undefined: MusicKit already sits on the chosen song. Kept
      // as a safety net for a runtime that reorders or drops items, and shows
      // as a "select" step in the timing log when it is needed.
      const index = providerStartIndex(instance, queue, start);
      if (index !== undefined && request.current()) {
        const selected = await changeToMediaAtIndex(instance, index);
        if (!selected) {
          throw new Error(
            "Selecting a song in the MusicKit queue is not available in this runtime.",
          );
        }
        step("select");
      }
      // The rest of the playlist is still recorded below for a paused queue.
      let retriedById = false;
      try {
        await startAudio(instance, request);
      } catch (error) {
        // MusicKit took the song details but could not start them: queue the
        // same songs by ID once, which makes it look them up first.
        if (!usedDetails || !request.current()) throw error;
        log(
          `Playback from song details failed; retrying by ID: ${errorMessage(error)}`,
        );
        usedDetails = false;
        retriedById = true;
        // By ID MusicKit looks the songs up, so one it cannot resolve is
        // dropped (or retried by its library ID) as on the first setup.
        const retried = await withResolvableTracks(
          queue,
          async (entries) => {
            await setProviderQueue({
              ...queueOptionsForTracks(entries.map((entry) => entry.track)),
              startWith: keptStartIndex(entries, start),
            });
          },
          request.current,
        );
        const retriedStart = keptStartIndex(retried.entries, start);
        queue = retried.entries.map((entry) => entry.track);
        start = retriedStart;
        if (retried.skipped.length) {
          log(`Skipped ${retried.skipped.length} unavailable songs.`);
          if (request.current()) {
            setQueue(queue, start);
            const message = skippedMessage(retried.skipped.length);
            if (message) reportActionError(new Error(message));
          }
        }
        if (request.current()) session.historyAnchor = queue[start];
        await startAudio(instance, request);
      }
      step(retriedById ? "play() after ID retry" : "play()");
      if (generation === session.restGeneration) {
        setRest(rest, queue.at(-1));
        // The first batch is under the refill threshold; append the next
        // songs now rather than on MusicKit's next event.
        maybeRefillQueue();
      }
      logWhenAudible(request, startedAt, steps);
      // Identifies this Play's queue for later pages (`appendContinuation`);
      // undefined once a newer Play replaced it.
      return request.current() && generation === session.restGeneration
        ? generation
        : undefined;
    } catch (error) {
      // A superseded or signed-out play reports nothing.
      if (!request.current()) return undefined;
      reportPlayFailure("Play failed", error);
      throw error;
    }
  };

  return { playTracks };
}
