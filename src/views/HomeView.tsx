import {
  AlertCircle,
  ArrowRight,
  Disc3,
  Headphones,
  ListMusic,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-preact";
import { useEffect, useMemo } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { toResource, toTrack, type ResourceLike } from "./LibraryView.tsx";

type DiscoverySource = "library" | "catalog";
type HomeStatus = "idle" | "loading" | "refreshing" | "success" | "error";

interface HomeSectionLike {
  items: unknown[];
  status: HomeStatus;
  error?: string;
  source?: DiscoverySource;
}

interface RecommendationGroupLike extends HomeSectionLike {
  id: string;
  title: string;
}

interface HomeModelLike {
  recentPlaylists: HomeSectionLike;
  recommendations: RecommendationGroupLike[];
  heavyRotation: HomeSectionLike;
  status: HomeStatus;
  stale: boolean;
  error?: string;
}

interface DiscoveryCard {
  id: string;
  kind: "album" | "playlist";
  source: DiscoverySource;
  resource: ResourceLike;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function sourceValue(value: unknown): DiscoverySource | undefined {
  return value === "library" || value === "catalog" ? value : undefined;
}

function readHome(state: ReturnType<typeof useAppState>): HomeModelLike {
  const home = state.home;
  const section = (
    items: unknown[],
    error?: string,
    source?: DiscoverySource,
  ): HomeSectionLike => ({
    items,
    error,
    source,
    status: error
      ? "error"
      : home.status === "loading" || home.status === "refreshing"
        ? home.status
        : items.length
          ? "success"
          : home.status === "error"
            ? "error"
            : "idle",
  });
  const recommendationGroups = home.recommendations.map(
    (group): RecommendationGroupLike => ({
      ...section(group.items, home.errors.recommendations, "catalog"),
      id: group.id,
      title: group.title,
    }),
  );
  return {
    recentPlaylists: section(
      home.recentPlaylists,
      home.errors.recentPlaylists,
      "library",
    ),
    recommendations: recommendationGroups,
    heavyRotation: section(
      home.heavyRotation,
      home.errors.heavyRotation,
      "catalog",
    ),
    status: home.status,
    stale: home.stale,
    error: home.errors.recommendations,
  };
}

function cardSource(
  value: unknown,
  fallback: DiscoverySource = "catalog",
): DiscoverySource {
  const raw = objectValue(value);
  const attributes = objectValue(raw?.attributes);
  const explicit = sourceValue(raw?.source) ?? sourceValue(attributes?.source);
  if (explicit) return explicit;
  const type = stringValue(
    raw?.type,
    raw?.resourceType,
    attributes?.type,
    attributes?.resourceType,
  );
  return type?.toLowerCase().startsWith("library-") ? "library" : fallback;
}

function discoveryCards(
  section: HomeSectionLike,
  fallbackSource: DiscoverySource,
): DiscoveryCard[] {
  const seen = new Set<string>();
  const cards: DiscoveryCard[] = [];
  for (const item of section.items) {
    const resource = toResource(item);
    if (!resource || seen.has(resource.id)) continue;
    const type = `${resource.type ?? ""} ${resource.kind ?? ""}`.toLowerCase();
    const kind = type.includes("playlist")
      ? "playlist"
      : type.includes("album")
        ? "album"
        : undefined;
    if (!kind || type.includes("folder")) continue;
    seen.add(resource.id);
    cards.push({
      id: resource.id,
      kind,
      source: cardSource(item, section.source ?? fallbackSource),
      resource,
    });
  }
  return cards;
}

function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

function DiscoveryCardView({
  card,
  onOpen,
}: {
  card: DiscoveryCard;
  onOpen: () => void;
}): JSX.Element {
  const track = toTrack(card.resource);
  const Icon = card.kind === "playlist" ? ListMusic : Disc3;
  return (
    <button
      className="home-discovery-card"
      type="button"
      data-context-kind={card.kind}
      data-context-id={card.id}
      data-context-title={card.resource.title}
      data-context-route-kind={card.kind}
      data-context-source={card.source}
      onClick={onOpen}
    >
      {track ? (
        <Artwork
          track={track}
          size="lg"
          alt={`${card.resource.title} artwork`}
          className="home-discovery-art"
        />
      ) : (
        <span className="home-discovery-art home-discovery-art-icon">
          <Icon aria-hidden="true" size={27} strokeWidth={1.5} />
        </span>
      )}
      <span className="home-discovery-copy">
        <strong title={card.resource.title}>{card.resource.title}</strong>
        <small title={card.resource.artistName}>
          {card.resource.artistName ??
            (card.kind === "playlist" ? "Playlist" : "Album")}
        </small>
      </span>
      <span className="home-discovery-source">
        {card.source === "library" ? "Library" : "Apple Music"}
      </span>
    </button>
  );
}

function SectionMessage({
  status,
  error,
  emptyTitle,
  emptyDescription,
  onRetry,
}: {
  status: HomeStatus;
  error?: string;
  emptyTitle: string;
  emptyDescription: string;
  onRetry: () => void;
}): JSX.Element | null {
  if ((status === "loading" || status === "refreshing") && !error) {
    return (
      <div className="home-section-feedback" role="status">
        <LoaderCircle className="spin" aria-hidden="true" size={18} /> Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="home-section-feedback home-section-error" role="alert">
        <AlertCircle aria-hidden="true" size={18} />
        <span>{error}</span>
        <button className="quiet-button" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (status !== "loading") {
    return (
      <EmptyState
        icon={ListMusic}
        title={emptyTitle}
        description={emptyDescription}
        compact
      />
    );
  }
  return null;
}

function DiscoverySection({
  id,
  eyebrow,
  title,
  description,
  section,
  cards,
  onOpen,
  onRetry,
  emptyTitle,
  emptyDescription,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  section: HomeSectionLike;
  cards: DiscoveryCard[];
  onOpen: (card: DiscoveryCard) => void;
  onRetry: () => void;
  emptyTitle: string;
  emptyDescription: string;
}): JSX.Element {
  return (
    <section className="home-feed-section" aria-labelledby={`${id}-heading`}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2 id={`${id}-heading`}>{title}</h2>
          <p className="home-feed-description">{description}</p>
        </div>
        {section.status === "refreshing" ? (
          <LoaderCircle
            className="home-section-refresh spin"
            aria-label={`Refreshing ${title}`}
            size={16}
          />
        ) : null}
      </div>
      {cards.length ? (
        <div className="home-discovery-grid">
          {cards.map((card) => (
            <DiscoveryCardView
              key={`${card.source}:${card.kind}:${card.id}`}
              card={card}
              onOpen={() => onOpen(card)}
            />
          ))}
        </div>
      ) : (
        <SectionMessage
          status={section.status}
          error={section.error}
          emptyTitle={emptyTitle}
          emptyDescription={emptyDescription}
          onRetry={onRetry}
        />
      )}
      {section.error && cards.length ? (
        <p className="home-section-stale" role="status">
          Showing saved data. Refresh failed: {section.error}
        </p>
      ) : null}
    </section>
  );
}

function RecommendationSection({
  group,
  onOpen,
  onRetry,
}: {
  group: RecommendationGroupLike;
  onOpen: (card: DiscoveryCard) => void;
  onRetry: () => void;
}): JSX.Element {
  const cards = discoveryCards(group, "catalog");
  return (
    <section
      className="home-feed-section home-recommendation-group"
      aria-labelledby={`${group.id}-heading`}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">Recommendations</span>
          <h3 id={`${group.id}-heading`}>{group.title}</h3>
        </div>
        {group.status === "refreshing" ? (
          <LoaderCircle
            className="home-section-refresh spin"
            aria-label={`Refreshing ${group.title}`}
            size={16}
          />
        ) : null}
      </div>
      {cards.length ? (
        <div className="home-discovery-grid">
          {cards.map((card) => (
            <DiscoveryCardView
              key={`${card.source}:${card.kind}:${card.id}`}
              card={card}
              onOpen={() => onOpen(card)}
            />
          ))}
        </div>
      ) : (
        <SectionMessage
          status={group.status}
          error={group.error}
          emptyTitle="No recommendations yet"
          emptyDescription="Apple Music will show recommendations after you listen to more music."
          onRetry={onRetry}
        />
      )}
    </section>
  );
}

export function HomeView(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const authorized = state.auth.status === "authorized";
  const authorizationPending = state.auth.pending === true;
  const home = readHome(state);
  const recentCards = useMemo(
    () =>
      discoveryCards(home.recentPlaylists, "library").filter(
        (card) => card.kind === "playlist",
      ),
    [home.recentPlaylists],
  );
  const heavyCards = useMemo(
    () => discoveryCards(home.heavyRotation, "catalog"),
    [home.heavyRotation],
  );
  const loading = home.status === "loading" || home.status === "refreshing";

  useEffect(() => {
    if (!authorized) return;
    run(() => controller.loadHome());
  }, [authorized, controller]);

  const refresh = (): void => {
    run(() => controller.loadHome({ refresh: true }));
  };

  const openCard = (card: DiscoveryCard): void => {
    router.navigate({
      kind: card.kind,
      id: card.id,
      source: card.source,
    } as Parameters<typeof router.navigate>[0]);
  };

  return (
    <>
      <div className="page-heading home-heading">
        <div>
          <span className="eyebrow">Your music, your space</span>
          <h1 tabIndex={-1}>Home</h1>
        </div>
        <div className="home-heading-actions">
          <span className="home-date">
            {new Intl.DateTimeFormat(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            }).format(new Date())}
          </span>
          {authorized ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh Home"
              disabled={loading}
              onClick={refresh}
            >
              <RefreshCw
                aria-hidden="true"
                size={16}
                className={loading ? "spin" : ""}
              />
            </button>
          ) : null}
        </div>
      </div>

      {!authorized ? (
        <>
          <section className="welcome-card">
            <div className="welcome-copy">
              <span className="welcome-kicker">
                <span className="pulse-dot" /> Apple Music on Arlet
              </span>
              <h2>A quieter way to listen.</h2>
              <p>
                Sign in with your Apple Music account to search and play your
                library.
              </p>
              <div className="welcome-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    state.initialization.status !== "ready" ||
                    authorizationPending
                  }
                  onClick={() =>
                    void controller.authorize().catch(() => undefined)
                  }
                >
                  <Headphones aria-hidden="true" size={17} strokeWidth={2} />
                  {authorizationPending
                    ? "Signing in…"
                    : state.initialization.status === "ready"
                      ? "Sign in to Apple Music"
                      : "Connecting…"}
                </button>
                <button
                  className="quiet-button"
                  type="button"
                    onClick={() => router.navigate({ kind: "browse" })}
                >
                  Explore new music{" "}
                  <ArrowRight aria-hidden="true" size={16} strokeWidth={1.8} />
                </button>
              </div>
            </div>
            <div className="welcome-art" aria-hidden="true">
              <span className="orb orb-one" />
              <span className="orb orb-two" />
              <span className="orb orb-three" />
            </div>
          </section>
          <section className="home-empty-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Library</span>
                <h2>Nothing here yet</h2>
              </div>
            </div>
            <EmptyState
              icon={Headphones}
              title="Connect your account to begin"
              description="Your Apple Music catalog and library will be available after sign-in."
              compact
            />
          </section>
        </>
      ) : (
        <div className="home-feed" aria-live="polite">
          <DiscoverySection
            id="recent-playlists"
            eyebrow="Recently played"
            title="Recent Playlists"
            description="Pick up where you left off."
            section={home.recentPlaylists}
            cards={recentCards}
            onOpen={openCard}
            onRetry={refresh}
            emptyTitle="No recent playlists"
            emptyDescription="Play a playlist in Apple Music and it will appear here."
          />
          <section
            className="home-feed-section"
            aria-labelledby="recommendations-heading"
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">For you</span>
                <h2 id="recommendations-heading">Recommendations</h2>
                <p className="home-feed-description">
                  Albums and playlists chosen from your Apple Music listening.
                </p>
              </div>
            </div>
            {home.recommendations.length ? (
              <div className="home-recommendations">
                {home.recommendations.map((group) => (
                  <RecommendationSection
                    key={group.id}
                    group={group}
                    onOpen={openCard}
                    onRetry={refresh}
                  />
                ))}
              </div>
            ) : home.status === "loading" || home.status === "refreshing" ? (
              <SectionMessage
                status={home.status}
                emptyTitle="No recommendations yet"
                emptyDescription="Apple Music will show recommendations after you listen to more music."
                onRetry={refresh}
              />
            ) : (
              <SectionMessage
                status={home.error ? "error" : "success"}
                error={home.error}
                emptyTitle="No recommendations yet"
                emptyDescription="Apple Music will show recommendations after you listen to more music."
                onRetry={refresh}
              />
            )}
          </section>
          <DiscoverySection
            id="heavy-rotation"
            eyebrow="Your rotation"
            title="Heavy Rotation"
            description="Favorites worth another listen."
            section={home.heavyRotation}
            cards={heavyCards}
            onOpen={openCard}
            onRetry={refresh}
            emptyTitle="Heavy Rotation is empty"
            emptyDescription="Your most-played albums and playlists will appear here."
          />
          {home.stale ? (
            <p className="home-section-stale" role="status">
              Some Home sections could not be refreshed. Try again.
            </p>
          ) : null}
          <div className="home-feed-search">
            <button
              className="secondary-button"
              type="button"
              onClick={() => router.navigate({ kind: "search", query: "" })}
            >
              <Search aria-hidden="true" size={16} /> Find something else
            </button>
          </div>
        </div>
      )}
    </>
  );
}
