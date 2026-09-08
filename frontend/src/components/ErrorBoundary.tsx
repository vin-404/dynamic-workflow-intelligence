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
 * equivalent of `componentDidCatch` (Next 16 documents the same pattern in
 * `docs/01-app/03-api-reference/03-file-conventions/error.md`). This is the
 * only class in the codebase and that is why.
 *
 * The fallback is restyled, not re-behaved: `getDerivedStateFromError`,
 * the reset-on-`resetKey` in `componentDidUpdate` and the console-only stack
 * in `componentDidCatch` are unchanged.
 */

import { Component, ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

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
      <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-severity-high">
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          {what} stopped working
        </p>
        <p className="mt-1 max-w-2xl text-sm text-foreground/90">
          This is a bug on our side, not something you did. Your workflow is
          untouched — nothing here writes to it.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry?.();
            }}
          >
            Try again
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => location.reload()}
          >
            Reload the page
          </Button>
        </div>
        <details className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground marker:content-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            Technical detail
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
            {error.name}: {error.message}
          </pre>
        </details>
      </div>
    );
  }
}
