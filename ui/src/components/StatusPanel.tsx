import { useEffect, useId, useRef, useState } from "react";
import { useConfigStatus, useReloadConfig } from "../api/hooks.ts";
import { useConnectionState } from "../api/sseHook.ts";
import { statusHealth, type Health } from "../util/statusHealth.ts";
import { formatTimeWithZone } from "../util/format.ts";
import { ConfigProblem } from "./ConfigProblem.tsx";
import { configIssue } from "../util/configIssue.ts";
import { RelativeTime } from "./Time.tsx";
import { BTN, BTN_PRIMARY } from "./ui.ts";

const DOT: Record<Health, string> = {
  ok: "bg-ok-fg",
  warn: "bg-warn-fg",
  bad: "bg-bad-fg",
  unknown: "bg-subtle",
};
const LABEL: Record<Health, string> = {
  ok: "healthy",
  warn: "warnings",
  bad: "problem",
  unknown: "unknown",
};

/**
 * "Status" in the header: a dot for the supervisor's health and a small panel
 * with what `auto config status` would say (when the config was loaded, how
 * many jobs and triggers, any degraded reason or rejected edit, warnings) and
 * a Reload config button.
 */
export function StatusPanel() {
  const status = useConfigStatus();
  const reload = useReloadConfig();
  const connection = useConnectionState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const data = status.data;
  const issue = configIssue(data);
  const warnings = data?.warnings ?? [];
  const connectionDown = connection === "retrying" || connection === "unauthorized";
  // react-query keeps the last data while a refetch fails; that data may be old.
  const stale = status.isError || connectionDown;
  const health: Health = statusHealth({
    data,
    issue,
    refreshFailed: status.isError,
    connectionDown,
  });

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={`${BTN} !px-2.5 !py-1`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT[health]}`} />
        Status
        <span className="sr-only">: {LABEL[health]}</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Supervisor status"
          className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-line-strong bg-surface p-4 text-sm shadow-lg"
        >
          {!data ? (
            <p className="text-muted">
              {status.isError ? "Could not read the supervisor's status." : "Loading…"}
            </p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              {stale && (
                <>
                  <dt className="text-muted">Connection</dt>
                  <dd className="text-warn-fg">
                    {connection === "unauthorized"
                      ? "the API token changed; reload the page"
                      : "cannot reach the supervisor; this is the last status received"}
                  </dd>
                </>
              )}
              <dt className="text-muted">Config loaded</dt>
              <dd title={formatTimeWithZone(data.loadedAt)}>
                {data.loadedAt ? <RelativeTime at={data.loadedAt} /> : "never"}
              </dd>
              <dt className="text-muted">Jobs</dt>
              <dd className="tabular-nums">{data.jobs}</dd>
              <dt className="text-muted">Triggers</dt>
              <dd className="tabular-nums">{data.triggers}</dd>
              <dt className="text-muted">State</dt>
              <dd>
                {data.degraded.active
                  ? "degraded: no jobs are scheduled"
                  : data.ok
                    ? "running normally"
                    : "running the last good config"}
                {stale && <span className="text-muted"> (last known)</span>}
              </dd>
            </dl>
          )}

          {issue && (
            <div className="mt-3">
              <ConfigProblem issue={issue} compact />
            </div>
          )}

          {warnings.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Warnings</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {warnings.map((w) => (
                  <li key={`${w.trigger_id}:${w.code}`} className="break-words">
                    {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={reload.isPending}
              onClick={() => reload.mutate()}
            >
              {reload.isPending ? "Reloading…" : "Reload config"}
            </button>
            <button type="button" className={BTN} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
