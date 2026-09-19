import {
  AlertCircle,
  LoaderCircle,
  Play,
  Radio as RadioIcon,
  RefreshCw,
} from "lucide-preact";
import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { Track } from "../domain/music.ts";
import type { RadioSectionState } from "../state.ts";

function StationCard({
  section,
  title,
  onPlay,
  omitWhenEmpty,
}: {
  section: RadioSectionState;
  title: string;
  onPlay: (id: string) => void;
  omitWhenEmpty?: boolean;
}): JSX.Element | null {
  const headingId = `radio-${title.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-heading`;
  if (section.status === "error" && section.items.length === 0) {
    return (
      <p className="library-stale-note" role="status">
        {title} unavailable: {section.error}
      </p>
    );
  }
  if (!section.items.length && section.status === "loading") return null;
  if (!section.items.length && omitWhenEmpty) return null;
  return (
    <section className="home-feed-section" aria-labelledby={headingId}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">Apple Music</span>
          <h2 id={headingId}>{title}</h2>
        </div>
        {section.status === "loading" ? (
          <LoaderCircle className="spin" size={16} />
        ) : null}
      </div>
      {section.items.length ? (
        <div className="home-discovery-grid">
          {section.items.map((station) => {
            const track: Track = {
              id: station.id,
              title: station.name,
              artistName: station.isLive ? "Live Radio" : "Apple Music",
              artwork: station.artwork,
            };
            return (
              <button
                className="home-discovery-card"
                key={station.id}
                type="button"
                disabled={!station.url}
                onClick={() => onPlay(station.id)}
              >
                <Artwork
                  track={track}
                  size="lg"
                  alt={`${station.name} artwork`}
                  className="home-discovery-art"
                />
                <span className="home-discovery-copy">
                  <strong>{station.name}</strong>
                  <small>
                    {station.description ??
                      (station.isLive ? "Live radio" : "Personal station")}
                  </small>
                </span>
                <span className="home-discovery-source">
                  <Play size={14} fill="currentColor" /> Play
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={RadioIcon}
          title={`No ${title.toLowerCase()}`}
          description="Apple Music returned no stations for this section."
          compact
        />
      )}
    </section>
  );
}

export function RadioView(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const radio = state.radio;
  const authorized = state.auth.status === "authorized";
  const loading = radio.status === "loading" || radio.status === "refreshing";
  const hasStations =
    radio.personal.items.length > 0 ||
    radio.live.items.length > 0 ||
    radio.recent.items.length > 0;

  useEffect(() => {
    if (authorized) {
      void Promise.resolve(controller.loadRadio?.()).catch(() => undefined);
    }
  }, [authorized, controller]);

  if (!authorized) {
    return (
      <EmptyState
        icon={RadioIcon}
        title="Sign in to listen to Radio"
        description="Connect your Apple Music account to play stations."
        action={
          <button
            className="primary-button"
            type="button"
            onClick={() => void controller.authorize().catch(() => undefined)}
          >
            Sign in
          </button>
        }
      />
    );
  }
  if (
    radio.status === "error" &&
    !radio.personal.items.length &&
    !radio.live.items.length &&
    !radio.recent.items.length
  ) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Radio could not be loaded"
        description={radio.error ?? "Try again in a moment."}
        action={
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              void Promise.resolve(
                controller.loadRadio?.({ refresh: true }),
              ).catch(() => undefined)
            }
          >
            Try again
          </button>
        }
      />
    );
  }

  const stations = [
    ...radio.personal.items,
    ...radio.live.items,
    ...radio.recent.items,
  ];
  const play = (id: string): void => {
    const station = stations.find((item) => item.id === id);
    if (station) {
      void Promise.resolve(controller.playStation?.(station)).catch(
        () => undefined,
      );
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Stations</span>
          <h1 tabIndex={-1}>Radio</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh Radio"
          disabled={loading}
          onClick={() =>
            void Promise.resolve(
              controller.loadRadio?.({ refresh: true }),
            ).catch(() => undefined)
          }
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>
      {radio.error ? (
        <p className="library-stale-note" role="status">
          Some stations could not be refreshed: {radio.error}
        </p>
      ) : null}
      {loading && !hasStations ? (
        <div className="search-feedback" role="status">
          <LoaderCircle className="spin" size={22} /> Loading Radio…
        </div>
      ) : (
        <>
          <StationCard
            section={radio.personal}
            title="Your Station"
            onPlay={play}
            omitWhenEmpty
          />
          <StationCard section={radio.live} title="Live Radio" onPlay={play} />
          <StationCard
            section={radio.recent}
            title="Recently Played Stations"
            onPlay={play}
            omitWhenEmpty
          />
        </>
      )}
    </>
  );
}
