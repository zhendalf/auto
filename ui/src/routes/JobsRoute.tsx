import { Link } from "react-router-dom";
import { useConfigStatus, useJobs } from "../api/hooks.ts";
import type { Job } from "../api/client.ts";
import { Chip } from "../components/Chip.tsx";
import { ConfigProblem } from "../components/ConfigProblem.tsx";
import { configIssue } from "../util/configIssue.ts";
import { ErrorPanel, Loading, StaleWarning } from "../components/QueryError.tsx";
import { RunStateBadge } from "../components/RunStateBadge.tsx";
import { RelativeTime } from "../components/Time.tsx";
import { CODE, TH } from "../components/ui.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useNowWithPauseExpiry } from "../hooks/useNow.ts";
import { idleReason, jobChips, nextRunAt, triggerBadges } from "../util/jobs.ts";

function NextRun({ job, now }: { job: Job; now: number }) {
  const idle = idleReason(job, now);
  if (idle) return <span className="text-subtle">{idle === "paused" ? "paused" : idle}</span>;
  const next = nextRunAt(job.triggers);
  if (next === null) return <span className="text-subtle">—</span>;
  return <RelativeTime at={next} upcoming />;
}

function JobChips({ job, now }: { job: Job; now: number }) {
  return (
    <span className="flex flex-wrap gap-1">
      {jobChips(job, now).map((c) => (
        <Chip key={c.label} tone={c.tone} live={c.live} title={c.title}>
          {c.label}
        </Chip>
      ))}
    </span>
  );
}

function TriggerChips({ job }: { job: Job }) {
  const badges = triggerBadges(job.triggers);
  if (badges.length === 0) return <span className="text-subtle">manual only</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Chip key={b.label} tone="neutral" title={b.off ? "This trigger is off" : undefined}>
          {b.label}
        </Chip>
      ))}
    </span>
  );
}

function LastRun({ job }: { job: Job }) {
  if (!job.last_run) return <span className="text-subtle">never</span>;
  return (
    <Link to={`/runs/${job.last_run.run_id}`} className="inline-flex items-center gap-2 hover:underline">
      <RelativeTime at={job.last_run.finished_at} className="text-muted" />
      <RunStateBadge state={job.last_run.state} />
    </Link>
  );
}

export function JobsRoute() {
  useDocumentTitle("Jobs");
  const q = useJobs();
  const status = useConfigStatus();
  const now = useNowWithPauseExpiry((q.data ?? []).map((j) => j.paused_until));

  if (q.isPending) return <Loading what="jobs" />;
  if (!q.data) return <ErrorPanel error={q.error} what="jobs" onRetry={() => void q.refetch()} />;

  const issue = configIssue(status.data);
  const jobs = q.data.slice().sort((a, b) => a.name.localeCompare(b.name));

  if (jobs.length === 0) {
    // "No jobs" is the wrong message when the real story is a broken config.
    if (issue) {
      return (
        <div className="flex max-w-3xl flex-col gap-4">
          <h1 className="text-xl font-semibold">Jobs</h1>
          <ConfigProblem issue={issue} />
        </div>
      );
    }
    return (
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <div className="mt-6 rounded-lg border border-dashed border-line-strong p-6">
          <h2 className="font-medium">No jobs yet</h2>
          <p className="mt-2 text-sm text-muted">
            A job is a script the supervisor runs for you, on a schedule or on demand. Create one from the terminal:
          </p>
          <p className="mt-3 text-sm">
            <code className={CODE}>auto create &lt;name&gt; --add</code>
          </p>
          <p className="mt-3 text-sm text-muted">
            Then start it once with <code className={CODE}>auto run &lt;job&gt;</code>. It appears here as soon as the
            supervisor has reloaded the config.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <span className="text-sm text-muted">{jobs.length}</span>
      </div>

      {q.isError && <StaleWarning error={q.error} onRetry={() => void q.refetch()} />}

      <ul className="flex flex-col gap-2 sm:hidden" aria-label="Jobs">
        {jobs.map((j) => (
          <li key={j.name} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/jobs/${encodeURIComponent(j.name)}`} className="break-all font-medium text-link hover:underline">
                {j.name}
              </Link>
              <JobChips job={j} now={now} />
            </div>
            {j.description && <p className="mt-1 text-sm text-subtle">{j.description}</p>}
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Triggers</dt>
              <dd><TriggerChips job={j} /></dd>
              <dt className="text-muted">Last run</dt>
              <dd><LastRun job={j} /></dd>
              <dt className="text-muted">Next run</dt>
              <dd><NextRun job={j} now={now} /></dd>
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Jobs</caption>
          <thead className="border-b border-line text-left">
            <tr>
              <th scope="col" className={TH}>Name</th>
              <th scope="col" className={TH}>State</th>
              <th scope="col" className={TH}>Triggers</th>
              <th scope="col" className={TH}>Last run</th>
              <th scope="col" className={TH}>Next run</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.name} className="border-b border-line/70 hover:bg-sunken/60">
                <td className="py-2.5 pr-4">
                  <Link to={`/jobs/${encodeURIComponent(j.name)}`} className="font-medium text-link hover:underline">
                    {j.name}
                  </Link>
                  {j.description && <div className="max-w-xs truncate text-xs text-subtle">{j.description}</div>}
                </td>
                <td className="py-2.5 pr-4"><JobChips job={j} now={now} /></td>
                <td className="py-2.5 pr-4"><TriggerChips job={j} /></td>
                <td className="py-2.5 pr-4"><LastRun job={j} /></td>
                <td className="whitespace-nowrap py-2.5 pr-4 text-muted"><NextRun job={j} now={now} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
