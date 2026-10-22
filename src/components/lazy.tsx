import { AlertCircle } from "lucide-preact";
import type { ComponentType, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { EmptyState } from "../views/EmptyState.tsx";

export interface LazyViewProps {
  /** Runs once the chunk has rendered, so a route can focus the loaded page. */
  onReady?: () => void;
}

export interface LazyViewOptions<P> {
  /** Names the surface in the failure message, such as "Settings". */
  name: string;
  /** Shown while the chunk loads: the surface's Skeleton or a minimal placeholder. */
  loading: (props: P) => JSX.Element;
  /** Shown when the chunk fails. The default is an EmptyState with retry. */
  failed?: (retry: () => void, props: P) => JSX.Element;
}

type LoadState<P> =
  | { status: "loading" }
  | { status: "ready"; Component: ComponentType<P> }
  | { status: "error" };

/**
 * Wraps a dynamic import as a component. The chunk loads once per session and
 * a failed load renders the failure state instead of throwing, so a missing
 * chunk never reaches the route's error boundary.
 */
export function lazyView<P extends object>(
  load: () => Promise<ComponentType<P>>,
  options: LazyViewOptions<P>,
): (props: P & LazyViewProps) => JSX.Element {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const ensure = (): Promise<ComponentType<P>> => {
    if (loaded) return Promise.resolve(loaded);
    // A failed attempt clears the promise so a retry imports the chunk again.
    pending ??= load().then(
      (Component) => {
        loaded = Component;
        return Component;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };

  return function LazyView({
    onReady,
    ...props
  }: P & LazyViewProps): JSX.Element {
    const viewProps = props as unknown as P;
    const [state, setState] = useState<LoadState<P>>(() =>
      loaded ? { status: "ready", Component: loaded } : { status: "loading" },
    );
    const [attempt, setAttempt] = useState(0);
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const ready = state.status === "ready";

    useEffect(() => {
      if (loaded) return undefined;
      let active = true;
      ensure().then(
        (Component) => {
          if (active) setState({ status: "ready", Component });
        },
        () => {
          if (active) setState({ status: "error" });
        },
      );
      return () => {
        active = false;
      };
    }, [attempt]);

    useEffect(() => {
      if (ready) onReadyRef.current?.();
    }, [ready]);

    const retry = (): void => {
      setState({ status: "loading" });
      setAttempt((count) => count + 1);
    };

    if (state.status === "loading") return options.loading(viewProps);
    if (state.status === "error") {
      return options.failed ? (
        options.failed(retry, viewProps)
      ) : (
        <EmptyState
          icon={AlertCircle}
          title={`${options.name} couldn't be shown`}
          description="The part of Arlet that shows this didn't load. Try again, or go to another page."
          action={
            <button className="secondary-button" type="button" onClick={retry}>
              Try again
            </button>
          }
        />
      );
    }
    const View = state.Component;
    return <View {...viewProps} />;
  };
}
