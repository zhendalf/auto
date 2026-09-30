import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client.ts";
import { isTerminalState } from "../api/client.ts";
import { useCancelRun, useRun } from "../api/hooks.ts";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { LogViewer } from "../components/LogViewer.tsx";
import { ErrorPanel, Loading, StaleWarning } from "../components/QueryError.tsx";
import { RunStateBadge } from "../components/RunStateBadge.tsx";
import { Elapsed, RelativeTime } from "../components/Time.tsx";
import { useToast } from "../components/Toast.tsx";
import { BTN, BTN_SM, CARD, CODE, H2 } from "../components/ui.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { reasonLabel } from "../util/errors.ts";
import { formatDuration, formatTimeWithZone, shortHash, shortId } from "../util/format.ts";
import { triggerLocalId } from "../util/jobs.ts";
import { metaEntries } from "../util/runMeta.ts";

function MetaRow({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words text-sm" title={title}>
        {children}
      </dd>
    </div>
  );
}

function When({ at }: { at: number | null }) {
  if (at == null) return <>—</>;
  return (
    <>
      {formatTimeWithZone(at)} <span className="text-muted">(<RelativeTime at={at} />)</span>
    </>
  );
}

export function RunDetailRoute() {
  const { run_id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useRun(run_id);
  const cancel = useCancelRun();
  const run = q.data;
  useDocumentTitle(run ? `Run ${shortId(run.run_id)} · ${run.job_name}` : "Run");

  // /runs/<short id> is a lookup; once resolved, the address becomes the full id.
  useEffect(() => {
    if (run && run.run_id !== run_id) navigate(`/runs/${run.run_id}`, { replace: true });
  }, [run, run_id, navigate]);

  if (q.isPending) return <Loading what="run" />;

  // Ambiguous short id (409): the API lists the candidates; offer them as links.
  if (!run && q.error instanceof ApiError && q.error.code === "ambiguous_prefix") {
    const candidates = (q.error.body as { candidates?: string[] } | null)?.candidates ?? [];
    return (
      <div className="flex max-w-xl flex-col gap-3 py-8">
        <h1 className="text-lg font-semibold">Ambiguous run id</h1>
        <p className="text-sm text-muted">
          More than one run matches <code className={CODE}>{run_id}</code>. Pick one:
        </p>
        <ul className="flex flex-col gap-1 font-mono text-sm">
          {candidates.map((c) => (
            <li key={c}>
              <Link to={`/runs/${c}`} className="text-link hover:underline">
                {c}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!run) {
    return (
      <ErrorPanel
        error={q.error}
        what="run"
        onRetry={() => void q.refetch()}
        backTo={{ to: "/runs", label: "Back to runs" }}
      />
    );
  }

  const live = !isTerminalState(run.state);
  const running = run.state === "running";
  const entries = metaEntries(run.trigger_meta);
  const trigger = run.trigger_id ? `${run.trigger_kind} / ${triggerLocalId(run.trigger_id)}` : run.trigger_kind;
  const exit =
    run.signal != null
      ? `killed by ${run.signal}`
      : run.exit_code != null
        ? String(run.exit_code)
        : "—";
  const why = reasonLabel(run.skip_reason);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(run.run_id);
      toast.success("Copied the run id.");
    } catch {
      toast.error("The browser did not allow copying. Select the id and copy it instead.");
    }
  };

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to="/runs" className="text-xs text-muted hover:underline">
          ← Runs
        </Link>
        <h1 className="break-all font-mono text-xl font-semibold">{shortId(run.run_id)}</h1>
        <RunStateBadge state={run.state} />
        <Link to={`/jobs/${encodeURIComponent(run.job_name)}`} className="break-all text-sm text-link hover:underline">
          {run.job_name}
        </Link>
        {live && (
          <span className="ml-auto">
            <ConfirmButton
              tone="danger"
              label="Cancel run"
              question="Cancel this run?"
              confirmLabel="Cancel run"
              cancelLabel="Keep running"
              pending={cancel.isPending}
              onConfirm={() => cancel.mutate(run.run_id)}
            />
          </span>
        )}
      </div>

      {q.isError && <StaleWarning error={q.error} onRetry={() => void q.refetch()} />}

      {why && (
        <p role="note" className="text-sm text-muted">
          <span className="font-medium text-fg">Why:</span> {why}.
        </p>
      )}

      <section aria-labelledby="h-meta" className={CARD}>
        <h2 id="h-meta" className={H2}>Details</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <MetaRow label="Trigger">{trigger}</MetaRow>
          <MetaRow label="Duration">
            <span className="tabular-nums">
              {running ? <Elapsed since={run.started_at ?? run.enqueued_at} /> : live ? "—" : formatDuration(run.duration_ms)}
            </span>
          </MetaRow>
          <MetaRow label="Exit">{exit}</MetaRow>
          <MetaRow label="Queued"><When at={run.enqueued_at} /></MetaRow>
          <MetaRow label="Started"><When at={run.started_at} /></MetaRow>
          <MetaRow label="Finished"><When at={run.finished_at} /></MetaRow>
          <MetaRow label="Definition" title={run.definition_hash ?? undefined}>
            <span className="font-mono">{shortHash(run.definition_hash)}</span>
          </MetaRow>
          {entries.map((e) => (
            <MetaRow key={e.label} label={e.label}>
              <span className={e.mono ? "font-mono text-xs" : ""}>{e.value}</span>
            </MetaRow>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
          <span>Full run id</span>
          <code className="break-all font-mono text-fg">{run.run_id}</code>
          <button type="button" className={`${BTN} ${BTN_SM}`} onClick={copyId}>
            Copy id
          </button>
        </div>
      </section>

      <section aria-labelledby="h-log">
        <h2 id="h-log" className={H2}>Log</h2>
        <LogViewer
          key={run.run_id}
          runId={run.run_id}
          runState={run.state}
          filename={`${run.job_name.replace(/[^\w.-]+/g, "_")}-${shortId(run.run_id)}.log`}
        />
      </section>
    </div>
  );
}
