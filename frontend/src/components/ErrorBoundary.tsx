"use client";

/**
 * A thrown component must never blank the page.
 *
 * Everything below the journey nav is wrapped in one of these, so a bug in a
 * single panel costs the user that panel and not their session: the header,
 * the stage nav and every other stage keep working, and the failed one offers
 * a way out.
 *
 * React error boundaries have to be class components - there is still no hook
 * equivalent of `componentDidCatch`. This is the only class in the codebase
 * and that is why.
 */

import { Component, ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** What broke, in the user's words: "the risk panel", not "RiskPanel". */
  what?: string;
  /** Changing this resets the boundary - e.g. moving to another stage. */
  resetKey?: string;
  /** Offered as "Try again" when the caller can retry meaningfully. */
  onRetry?: () => void;
};

type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Moving to a different stage clears a failure that belonged to the last
    // one. Without this, one broken panel poisons the nav until a reload.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // The browser console is the only log this app has. Keep the stack there
    // where a developer can find it, and keep it off the screen.
    console.error("Component error", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const what = this.props.what ?? "This panel";
    return (
      <div className="border border-red/40 bg-red/5 rounded-lg p-4">
        <p className="text-red font-medium mb-1">{what} stopped working</p>
        <p className="text-sm text-foreground/90 mb-3">
          This is a bug on our side, not something you did. Your workflow is
          untouched — nothing here writes to it.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry?.();
            }}
            className="px-2.5 py-1 text-sm rounded border border-line hover:border-dim"
          >
            Try again
          </button>
          <button
            onClick={() => location.reload()}
            className="px-2.5 py-1 text-sm rounded border border-line hover:border-dim"
          >
            Reload the page
          </button>
        </div>
        <details className="mt-3">
          <summary className="text-xs text-dim cursor-pointer">
            Technical detail
          </summary>
          <pre className="mt-2 text-xs text-dim whitespace-pre-wrap break-words">
            {error.name}: {error.message}
          </pre>
        </details>
      </div>
    );
  }
}
