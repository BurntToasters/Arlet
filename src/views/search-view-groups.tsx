import type { JSX } from "preact";
import type { AppController } from "../app/controller.ts";
import { reportActionError } from "../components/action-errors.ts";
import { CuratorSearchTile, SearchTile } from "../components/SearchCards.tsx";
import { serializeRoute } from "../routing/router.ts";
import type { SearchGroupKind } from "../musickit/search.ts";
import type { SearchResourceGroups } from "../state-types.ts";
import { ResourceCard, TrackRow } from "./search-view-rows.tsx";

export interface SearchGroupsContext {
  groups: SearchResourceGroups;
  source: "catalog" | "library";
  canPlay: boolean;
  controller: AppController;
}

/** Rows or cards for one group; the overview caps it, See all does not. */
export function searchGroupItems(
  { groups, source, canPlay, controller }: SearchGroupsContext,
  kind: SearchGroupKind,
  limit?: number,
): JSX.Element {
  const shown = <T,>(items: T[]): T[] =>
    limit === undefined ? items : items.slice(0, limit);
  switch (kind) {
    case "songs":
      return (
        <ol className="search-results-list">
          {shown(groups.songs).map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              index={index}
              disabled={!canPlay}
              onPlay={() =>
                void controller.playFromSearch(index).catch(reportActionError)
              }
              onPlayNext={() =>
                void controller.playNextTracks([track]).catch(reportActionError)
              }
            />
          ))}
        </ol>
      );
    case "albums":
      return (
        <div className="home-discovery-grid">
          {shown(groups.albums).map((item) => (
            <ResourceCard
              key={item.id}
              item={item}
              kind="album"
              source={source}
              canPlay={canPlay}
            />
          ))}
        </div>
      );
    case "artists":
      return (
        <div className="home-discovery-grid">
          {shown(groups.artists).map((item) => (
            <ResourceCard
              key={item.id}
              item={item}
              kind="artist"
              source={source}
              canPlay={canPlay}
            />
          ))}
        </div>
      );
    case "playlists":
      return (
        <div className="home-discovery-grid">
          {shown(groups.playlists).map((item) => (
            <ResourceCard
              key={item.id}
              item={item}
              kind="playlist"
              source={source}
              canPlay={canPlay}
            />
          ))}
        </div>
      );
    case "stations":
      return (
        <div className="home-discovery-grid">
          {shown(groups.stations).map((station) => {
            const play =
              canPlay && station.url
                ? () =>
                    void Promise.resolve(controller.playStation(station)).catch(
                      reportActionError,
                    )
                : undefined;
            return (
              <SearchTile
                key={station.id}
                title={station.name}
                subtitle={
                  station.isLive
                    ? "Live radio"
                    : (station.description ?? "Station")
                }
                kindLabel="Station"
                artwork={station.artwork}
                onOpen={play}
                onPlay={play}
              />
            );
          })}
        </div>
      );
    case "curators":
      return (
        <div className="home-discovery-grid">
          {shown(groups.curators).map((curator) => (
            <CuratorSearchTile key={curator.id} curator={curator} />
          ))}
        </div>
      );
    case "record-labels":
      return (
        <div className="home-discovery-grid">
          {shown(groups.recordLabels ?? []).map((label) => (
            <SearchTile
              key={label.id}
              title={label.name}
              subtitle="Record label"
              kindLabel="Record Label"
              artwork={label.artwork}
              href={serializeRoute({ kind: "label", id: label.id })}
            />
          ))}
        </div>
      );
    case "activities":
      return (
        <div className="home-discovery-grid">
          {shown(groups.activities ?? []).map((activity) => (
            <SearchTile
              key={activity.id}
              title={activity.name}
              subtitle="Activity"
              kindLabel="Activity"
              artwork={activity.artwork}
              href={serializeRoute({ kind: "activity", id: activity.id })}
            />
          ))}
        </div>
      );
  }
}
