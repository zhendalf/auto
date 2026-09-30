import { Link, useParams } from "react-router-dom";
import { useCancelRun, useJob } from "../api/hooks.ts";
import { Chip } from "../components/Chip.tsx";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { JobActions } from "../components/JobActions.tsx";
import { ErrorPanel, Loading, StaleWarning } from "../components/QueryError.tsx";
import { RunStateBadge } from "../components/RunStateBadge.tsx";
import { RunsTable } from "../components/RunsTable.tsx";
import { Elapsed, RelativeTime } from "../components/Time.tsx";
import { TriggerList } from "../components/TriggerList.tsx";
import { CARD, CODE, H2, NOTE_WARN } from "../components/ui.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useNowWithPauseExpiry } from "../hooks/useNow.ts";
import { isNotFound } from "../util/errors.ts";
import { formatTimeWithZone, formatTimeoutMs, shortId } from "../util/format.ts";
import { isPausedAt, jobChips, nextRunAt } from "../util/jobs.ts";
import { shellWord } from "../util/shell.ts";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function JobDetailRoute() {
  const { name = "" } = useParams();
  const q = useJob(name);
  const cancel = useCancelRun();
  const now = useNowWithPauseExpiry([q.data?.paused_until]);
  useDocumentTitle(name ? `${name} · Jobs` : "Job");

  if (q.isPending) return <Loading what="job" />;
  if (!q.data) {
    return (
      <ErrorPanel
        error={q.error}
        what="job"
        onRetry={() => void q.refetch()}
        backTo={{ to: "/jobs", label: "Back to jobs" }}
      />
    );
  }

  const job = q.data;
  // The job left the config after this page loaded: what is shown is its last
  // known state, and nothing can be started, disabled or paused any more.
  const removed = q.isError && isNotFound(q.error);
  const paused = isPausedAt(job.paused_until, now);
  const next = nextRunAt(job.triggers);
  const active = job.active_run;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link to="/jobs" className="text-xs text-muted hover:underline">
          ← Jobs
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="break-all text-2xl font-semibold">{job.name}</h1>
          {(removed ? [] : jobChips(job, now)).map((c) => (
            <Chip key={c.label} tone={c.tone} live={c.live} title={c.title}>
              {c.label}
            </Chip>
          ))}
        </div>
        {job.description && <p className="mt-1 max-w-3xl text-sm text-muted">{job.description}</p>}
      </div>

      {removed ? (
        <div role="status" className={NOTE_WARN}>
          This job is no longer in the config, so it cannot be run, disabled or paused. Its recent runs are
          below. If it is added back, this page updates by itself.
        </div>
      ) : (
        q.isError && <StaleWarning error={q.error} onRetry={() => void q.refetch()} />
      )}

      {active && (
        <div role="status" className={`${NOTE_WARN} flex flex-wrap items-center gap-x-4 gap-y-2`}>
          <span className="font-medium">
            {active.state === "queued" ? "A run is queued" : "A run is in progress"}
          </span>
          <Link to={`/runs/${active.run_id}`} className="font-mono underline">
            {shortId(active.run_id)}
          </Link>
          {active.started_at != null && (
            <span>
              running for <Elapsed since={active.started_at} />
            </span>
          )}
          <span className="ml-auto">
            <ConfirmButton
              small
              tone="danger"
              label="Cancel run"
              question="Cancel this run?"
              confirmLabel="Cancel run"
              cancelLabel="Keep running"
              pending={cancel.isPending}
              onConfirm={() => cancel.mutate(active.run_id)}
            />
          </span>
        </div>
      )}

      {!removed && (
        <section aria-labelledby="h-actions">
          <h2 id="h-actions" className={H2}>Actions</h2>
          <JobActions key={job.name} job={job} />
        </section>
      )}

      <section aria-labelledby="h-state" className={CARD}>
        <h2 id="h-state" className={H2}>{removed ? "Last known state" : "State"}</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Field label="Enabled">
            {job.enabled ? "yes" : "no"}
            {job.config_enabled === false && <span className="text-muted"> (off in config)</span>}
          </Field>
          <Field label="Paused until">
            {paused ? (
              <>
                {formatTimeWithZone(job.paused_until)} (<RelativeTime at={job.paused_until} />)
              </>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Next run">{next != null ? <RelativeTime at={next} upcoming /> : "—"}</Field>
          <Field label="If already running">
            <code className={CODE}>{job.reentrancy}</code>
          </Field>
          <Field label="Queue depth">
            <span className="tabular-nums">{job.queueDepth}</span>
          </Field>
          <Field label="Timeout">
            <span className="tabular-nums" title={`${job.timeoutMs} ms`}>{formatTimeoutMs(job.timeoutMs)}</span>
          </Field>
          <Field label="Kill grace">
            <span className="tabular-nums" title={`${job.killGraceMs} ms`}>{formatTimeoutMs(job.killGraceMs)}</span>
          </Field>
          <Field label="Last run">
            {job.last_run ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Link to={`/runs/${job.last_run.run_id}`} className="hover:underline">
                  <RelativeTime at={job.last_run.finished_at} />
                </Link>
                <RunStateBadge state={job.last_run.state} />
              </span>
            ) : (
              "never"
            )}
          </Field>
        </dl>
      </section>

      {!removed && (
        <section aria-labelledby="h-triggers">
          <h2 id="h-triggers" className={H2}>Triggers</h2>
          <TriggerList job={job} now={now} />
        </section>
      )}

      <section aria-labelledby="h-runs">
        <h2 id="h-runs" className={H2}>Recent runs</h2>
        <RunsTable
          runs={job.recent_runs}
          showJob={false}
          emptyText={
            removed ? (
              "No runs recorded."
            ) : (
              <>
                No runs yet. Start one with Run now, or <code className={CODE}>auto run {shellWord(job.name)}</code>.
              </>
            )
          }
        />
        {job.recent_runs.length > 0 && (
          <p className="mt-2 text-sm">
            <Link to={`/runs?job=${encodeURIComponent(job.name)}`} className="text-link hover:underline">
              All runs of {job.name}
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
