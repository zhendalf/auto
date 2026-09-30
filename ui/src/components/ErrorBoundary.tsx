import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { BTN, BTN_PRIMARY } from "./ui.ts";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Catches a render error anywhere below it so a bug shows a message and a way
 * out, not a blank page. Used twice: around the whole app (last resort) and
 * around the routed content, keyed by URL so navigating away recovers.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ui] render error", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-xl py-12 text-fg">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">
          The page hit an unexpected error. Your jobs are not affected. Try again, or reload the page.
        </p>
        <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-line bg-sunken p-3 text-xs text-fg">
          {error.message || String(error)}
        </pre>
        <div className="mt-4 flex gap-2">
          <button type="button" className={BTN} onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
