import { Component } from "preact";
import type { ComponentChildren, JSX } from "preact";

export interface ErrorBoundaryProps {
  children: ComponentChildren;
  /** Told about the error so it reaches the log and support reports. */
  onError: (error: unknown) => void;
  /** Shown instead of the children; `retry` renders them again. */
  fallback: (retry: () => void) => JSX.Element;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * Stops a render error from unmounting everything above it. Without one, a
 * single throw in any view blanks the whole frameless window, leaving no
 * title bar to close it with.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static override getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ComponentChildren {
    return this.state.failed
      ? this.props.fallback(this.retry)
      : this.props.children;
  }
}
