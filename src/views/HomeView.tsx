import { ArrowRight, Headphones, Search } from "lucide-preact";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import { EmptyState } from "./EmptyState.tsx";

export function HomeView(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const authorized = state.auth.status === "authorized";
  const authorizationPending = state.auth.pending === true;

  return (
    <>
      <div className="page-heading home-heading">
        <div>
          <span className="eyebrow">Your music, your space</span>
          <h1 tabIndex={-1}>Home</h1>
        </div>
        <span className="home-date">
          {new Intl.DateTimeFormat(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          }).format(new Date())}
        </span>
      </div>
      <section className="welcome-card">
        <div className="welcome-copy">
          <span className="welcome-kicker">
            <span className="pulse-dot" /> Apple Music on Arlet
          </span>
          <h2>
            {authorized ? "Ready when you are." : "A quieter way to listen."}
          </h2>
          <p>
            {authorized
              ? "Search the catalog, pick a song, and let the queue take it from there."
              : "Sign in with your Apple Music account to search and play your library."}
          </p>
          <div className="welcome-actions">
            {authorized ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => router.navigate({ kind: "search", query: "" })}
              >
                <Search aria-hidden="true" size={17} strokeWidth={2} />
                Find something to play
              </button>
            ) : (
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
            )}
            <button
              className="quiet-button"
              type="button"
              onClick={() => router.navigate({ kind: "new" })}
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
            <h2>
              {authorized ? "Your listening starts here" : "Nothing here yet"}
            </h2>
          </div>
        </div>
        <EmptyState
          icon={Headphones}
          title={
            authorized
              ? "Search for an artist, album, or song"
              : "Connect your account to begin"
          }
          description={
            authorized
              ? "Arlet keeps this space focused until you choose something you love."
              : "Your Apple Music catalog and library will be available after sign-in."
          }
          compact
          action={
            authorized ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => router.navigate({ kind: "search", query: "" })}
              >
                Open Search
              </button>
            ) : null
          }
        />
      </section>
    </>
  );
}
