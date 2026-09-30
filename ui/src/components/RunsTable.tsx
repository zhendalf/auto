import { Link } from "react-router-dom";
import type { Run } from "../api/client.ts";
import { RunStateBadge } from "./RunStateBadge.tsx";
import { Elapsed, RelativeTime } from "./Time.tsx";
import { reasonLabel } from "../util/errors.ts";
import { formatDuration, shortId } from "../util/format.ts";
import { isTerminalState } from "../api/client.ts";
import { TH } from "./ui.ts";

/**
 * Reusable table for run summaries. Used on the Runs page and the job page.
 * `showJob=false` is convenient on the job page where the column would just
 * repeat the job name.
 */
export function RunsTable({
  runs,
  showJob = true,
  emptyText = "No runs.",
  busy = false,
}: {
  runs: Run[] | undefined;
  showJob?: boolean;
  emptyText?: React.ReactNode;
  /** Dims the rows while a new filter is loading. */
  busy?: boolean;
}) {
  if (!runs || runs.length === 0) {
    return <div className="py-4 text-sm text-muted">{emptyText}</div>;
  }
  return (
    <div className={busy ? "opacity-60" : ""} aria-busy={busy}>
      <ul className="flex flex-col gap-2 sm:hidden" aria-label="Runs, newest first">
        {runs.map((r) => (
          <li key={r.run_id} className="rounded-lg border border-line bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/runs/${r.run_id}`} className="font-mono text-xs text-link hover:underline" title={r.run_id}>
                {shortId(r.run_id)}
              </Link>
              <RunStateBadge state={r.state} />
              {showJob && (
                <Link to={`/jobs/${encodeURIComponent(r.job_name)}`} className="break-all hover:underline">
                  {r.job_name}
                </Link>
              )}
            </div>
            <p className="mt-1 text-muted">
              {triggerText(r)} · <RelativeTime at={r.started_at ?? r.enqueued_at} /> · <DurationCell run={r} />
              {r.signal ? ` · sig ${r.signal}` : r.exit_code !== null ? ` · exit ${r.exit_code}` : ""}
            </p>
            <WhyNote run={r} />
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
      <table className="min-w-full text-sm">
        <caption className="sr-only">Runs, newest first</caption>
        <thead className="border-b border-line text-left">
          <tr>
            <th scope="col" className={TH}>Run</th>
            {showJob && <th scope="col" className={TH}>Job</th>}
            <th scope="col" className={TH}>State</th>
            <th scope="col" className={TH}>Trigger</th>
            <th scope="col" className={TH}>Started</th>
            <th scope="col" className={TH}>Duration</th>
            <th scope="col" className={TH}>Exit</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.run_id} className="border-b border-line/70 hover:bg-sunken/60">
              <td className="whitespace-nowrap py-2 pr-4 font-mono text-xs">
                <Link to={`/runs/${r.run_id}`} className="text-link hover:underline" title={r.run_id}>
                  {shortId(r.run_id)}
                </Link>
              </td>
              {showJob && (
                <td className="py-2 pr-4">
                  <Link to={`/jobs/${encodeURIComponent(r.job_name)}`} className="hover:underline">
                    {r.job_name}
                  </Link>
                </td>
              )}
              <td className="py-2 pr-4">
                <RunStateBadge state={r.state} />
                <WhyNote run={r} />
              </td>
              <td className="py-2 pr-4 text-muted">
                {r.trigger_kind}
                {r.trigger_id ? (
                  <span className="text-subtle"> / {r.trigger_id.slice(r.trigger_id.indexOf(":") + 1)}</span>
                ) : null}
              </td>
              <td className="whitespace-nowrap py-2 pr-4 text-muted">
                <RelativeTime at={r.started_at ?? r.enqueued_at} />
              </td>
              <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted">
                <DurationCell run={r} />
              </td>
              <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted">
                {r.signal ? `sig ${r.signal}` : r.exit_code === null ? "—" : String(r.exit_code)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Why the run was skipped or ended abnormally, when the supervisor recorded a reason. */
function WhyNote({ run }: { run: Run }) {
  const why = reasonLabel(run.skip_reason);
  if (!why) return null;
  return <p className="mt-0.5 max-w-[16rem] text-xs text-muted">{why.charAt(0).toUpperCase() + why.slice(1)}</p>;
}

function triggerText(r: Run): string {
  return r.trigger_id ? `${r.trigger_kind} / ${r.trigger_id.slice(r.trigger_id.indexOf(":") + 1)}` : r.trigger_kind;
}

function DurationCell({ run: r }: { run: Run }) {
  if (r.state === "running") return <Elapsed since={r.started_at ?? r.enqueued_at} />;
  if (isTerminalState(r.state)) return <>{formatDuration(r.duration_ms)}</>;
  return <>—</>;
}
