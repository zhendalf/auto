import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { reconnectEvents, useConnectionState } from "../api/sseHook.ts";
import {
  describeError,
  isClientError,
  isNotFound,
  staleAction,
  TOKEN_CHANGED_ACTION,
  TOKEN_CHANGED_TITLE,
} from "../util/errors.ts";
import { BTN, BTN_PRIMARY, CODE, NOTE_WARN } from "./ui.ts";

/**
 * What a page shows when its main query has no data and failed: a friendly
 * screen for "API token changed" and "supervisor not running", a plain message
 * for anything else. `what` names the thing that could not be loaded.
 */
export function ErrorPanel({
  error,
  what,
  onRetry,
  backTo,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
  backTo?: { to: string; label: string };
}) {
  const qc = useQueryClient();
  const d = describeError(error);

  if (d.kind === "unauthorized") {
    return (
      <div role="alert" className="mx-auto max-w-xl py-12">
        <h1 className="text-xl font-semibold">{TOKEN_CHANGED_TITLE}</h1>
        <p className="mt-2 text-sm text-muted">{TOKEN_CHANGED_ACTION}</p>
        <div className="mt-4">
          <button type="button" className={BTN_PRIMARY} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (d.kind === "unreachable") {
    return (
      <div role="alert" className="mx-auto max-w-xl py-12">
        <h1 className="text-xl font-semibold">Supervisor is not running</h1>
        <p className="mt-2 text-sm text-muted">
          The dashboard could not reach the supervisor. Run <code className={CODE}>auto install</code> or{" "}
          <code className={CODE}>auto svc start</code>, then try again. <code className={CODE}>auto svc tail</code>{" "}
          shows why it stopped.
        </p>
        <div className="mt-4">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => {
              reconnectEvents();
              if (onRetry) onRetry();
              else void qc.invalidateQueries();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const missing = isNotFound(error);
  return (
    <div role="alert" className="mx-auto max-w-xl py-12">
      <h1 className="text-xl font-semibold">{missing ? `${cap(what)} not found` : `Could not load ${what}`}</h1>
      <p className="mt-2 text-sm text-muted">
        {missing
          ? what === "job"
            ? "There is no job with that name. It may have been removed from the config, or the link is wrong."
            : `There is no ${what} with that id. It may have been cleaned up by retention, or the link is wrong.`
          : [d.title, d.message].filter(Boolean).join(". ")}
      </p>
      <div className="mt-4 flex gap-2">
        {backTo && (
          <Link to={backTo.to} className={BTN}>
            {backTo.label}
          </Link>
        )}
        {!missing && !isClientError(error) && onRetry && (
          <button type="button" className={BTN} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A slim warning shown above content that is still on screen from an earlier
 * fetch when a background refetch has failed. The stale content stays; the
 * warning says it may be out of date.
 */
export function StaleWarning({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const d = describeError(error);
  const action = staleAction(error, useConnectionState());
  return (
    <div role="status" className={`${NOTE_WARN} flex flex-wrap items-center gap-x-3 gap-y-1`}>
      <span className="min-w-0 flex-1">
        Showing the last data received. Refreshing failed: {d.title.charAt(0).toLowerCase() + d.title.slice(1)}.
      </span>
      {action === "reload" && (
        <button type="button" className="font-medium underline" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
      {action === "retry" && onRetry && (
        <button type="button" className="font-medium underline" onClick={onRetry}>
          Retry now
        </button>
      )}
    </div>
  );
}

export function Loading({ what = "" }: { what?: string }) {
  return (
    <div role="status" className="py-8 text-center text-sm text-muted">
      Loading{what ? ` ${what}` : ""}…
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
