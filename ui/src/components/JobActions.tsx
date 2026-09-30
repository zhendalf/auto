import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { JobDetail } from "../api/client.ts";
import {
  useDisableJob,
  useEnableJob,
  usePauseJob,
  useRunJob,
  useUnpauseJob,
} from "../api/hooks.ts";
import { useConnectionState } from "../api/sseHook.ts";
import { relativeTickMs, useNow } from "../hooks/useNow.ts";
import { formatTimeWithZone, shortId } from "../util/format.ts";
import { idleReason, isPausedAt } from "../util/jobs.ts";
import { PAUSE_PRESETS, resolvePause } from "../util/pause.ts";
import type { PauseChoice } from "../util/pause.ts";
import { canForce, classifyRunFailure, refusalAfter, runAcceptedMessage } from "../util/runNow.ts";
import type { RunRefusal } from "../util/runNow.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { RelativeTime } from "./Time.tsx";
import { useToast } from "./Toast.tsx";
import { BTN, BTN_PRIMARY, CARD, INPUT, NOTE_BAD, NOTE_WARN } from "./ui.ts";

type PauseMode = "preset" | "custom" | "until";
const CUSTOM = "custom";
const UNTIL = "until";

/**
 * Action panel for one job. Render it with `key={job.name}` so nothing typed
 * or shown here can carry over to another job.
 *
 * Run now never forces: if the job is already running (409) or would be
 * skipped (422) it says so and offers an explicit, confirmed "Run anyway".
 * The button is disabled while a request is in flight, so a double click
 * cannot start two copies.
 */
export function JobActions({ job }: { job: JobDetail }) {
  const navigate = useNavigate();
  const toast = useToast();
  const runJob = useRunJob();
  const enable = useEnableJob();
  const disable = useDisableJob();
  const pause = usePauseJob();
  const unpause = useUnpauseJob();
  const now = useNow(relativeTickMs(job.paused_until));

  const inFlight = useRef(false);
  // Disable and Enable swap one button for another, so focus would fall to the
  // page body. `focusAfterToggle` holds the state the job is expected to reach;
  // when it does, focus goes to the button that replaced the one just used.
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterToggle = useRef<boolean | null>(null);
  const [refusal, setRefusal] = useState<RunRefusal | null>(null);

  const [pauseSelect, setPauseSelect] = useState<string>(String(PAUSE_PRESETS[1]!.ms));
  const [customText, setCustomText] = useState("");
  const [untilLocal, setUntilLocal] = useState("");
  const [pauseError, setPauseError] = useState<string | null>(null);

  // "Already running" is stale once that run has finished and is the job's last run.
  const lastRunId = job.last_run?.run_id ?? null;
  useEffect(() => {
    setRefusal((r) => (r?.kind === "conflict" && r.runningRunId && r.runningRunId === lastRunId ? null : r));
  }, [lastRunId]);

  const paused = isPausedAt(job.paused_until, now);
  const idle = idleReason(job, now);

  // A "not started" note is about the state the job was in; enabling or
  // resuming it makes the note wrong. An error note goes once the supervisor
  // is reachable again.
  useEffect(() => {
    setRefusal((r) => refusalAfter(r, "job-state-changed"));
  }, [job.enabled, job.config_enabled, paused]);
  useEffect(() => {
    if (focusAfterToggle.current === job.enabled) {
      focusAfterToggle.current = null;
      toggleRef.current?.focus();
    }
  }, [job.enabled]);
  const connectionOpen = useConnectionState() === "open";
  useEffect(() => {
    if (connectionOpen) setRefusal((r) => refusalAfter(r, "connection-restored"));
  }, [connectionOpen]);

  const run = (force: boolean) => {
    // The mutation's isPending flips a render later; the ref closes that gap.
    if (inFlight.current) return;
    inFlight.current = true;
    setRefusal(null);
    runJob.mutate(
      { name: job.name, force, reason: force ? "manual via UI (run anyway)" : "manual via UI" },
      {
        onSuccess: (res) => {
          toast.success(runAcceptedMessage(res));
          navigate(`/runs/${res.run_id}`);
        },
        onError: (err) => {
          // The note below the buttons carries the message, including errors.
          setRefusal(classifyRunFailure(err));
        },
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const mode: PauseMode =
    pauseSelect === CUSTOM ? "custom" : pauseSelect === UNTIL ? "until" : "preset";

  const submitPause = () => {
    const choice: PauseChoice =
      mode === "custom"
        ? { mode: "custom", text: customText }
        : mode === "until"
          ? { mode: "until", local: untilLocal }
          : { mode: "preset", ms: Number(pauseSelect) };
    const body = resolvePause(choice, Date.now());
    if (!body.ok) {
      setPauseError(body.error);
      return;
    }
    setPauseError(null);
    pause.mutate({ name: job.name, durationMs: body.durationMs, untilIso: body.untilIso });
  };

  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run(false)}
          disabled={runJob.isPending}
          aria-busy={runJob.isPending}
          className={BTN_PRIMARY}
        >
          {runJob.isPending ? "Starting…" : "Run now"}
        </button>

        {job.enabled ? (
          <ConfirmButton
            label="Disable"
            ariaLabel={`Disable job ${job.name}`}
            question={`Disable ${job.name}? Nothing will start it until it is enabled again.`}
            confirmLabel="Disable job"
            pending={disable.isPending}
            buttonRef={toggleRef}
            onConfirm={() => {
              focusAfterToggle.current = false;
              disable.mutate(job.name);
            }}
          />
        ) : (
          <button
            type="button"
            ref={toggleRef}
            onClick={() => {
              focusAfterToggle.current = true;
              enable.mutate(job.name);
            }}
            disabled={enable.isPending}
            aria-label={`Enable job ${job.name}`}
            className={BTN}
          >
            Enable
          </button>
        )}

        {paused && (
          <button type="button" onClick={() => unpause.mutate(job.name)} disabled={unpause.isPending} className={BTN}>
            Resume
          </button>
        )}
      </div>

      {idle && idle !== "paused" && (
        <p className="text-sm text-muted">
          {idle === "disabled"
            ? "This job is disabled: its triggers do not fire, and Run now is skipped unless you choose Run anyway."
            : "This job is switched off in the config file (enabled: false). Edit the config to turn it on."}
        </p>
      )}

      {refusal && <RefusalNote refusal={refusal} onRunAnyway={() => run(true)} pending={runJob.isPending} />}

      <div className="border-t border-line pt-3">
        {paused ? (
          <p className="text-sm">
            Paused until{" "}
            <time dateTime={new Date(job.paused_until!).toISOString()}>
              {formatTimeWithZone(job.paused_until)}
            </time>{" "}
            (<RelativeTime at={job.paused_until} />). Triggers do not fire while paused, and Run now is skipped unless you choose Run anyway.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Pause</legend>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`pause-for-${job.name}`}>
                Pause for
              </label>
              <select
                id={`pause-for-${job.name}`}
                value={pauseSelect}
                onChange={(e) => {
                  setPauseSelect(e.target.value);
                  setPauseError(null);
                }}
                className={INPUT}
              >
                {PAUSE_PRESETS.map((o) => (
                  <option key={o.ms} value={o.ms}>
                    {o.label}
                  </option>
                ))}
                <option value={CUSTOM}>Custom duration…</option>
                <option value={UNTIL}>Until a date and time…</option>
              </select>
              {mode === "custom" && (
                <>
                  <label className="sr-only" htmlFor={`pause-custom-${job.name}`}>
                    Custom pause duration
                  </label>
                  <input
                    id={`pause-custom-${job.name}`}
                    type="text"
                    value={customText}
                    onChange={(e) => {
                      setCustomText(e.target.value);
                      setPauseError(null);
                    }}
                    placeholder="45m, 2h30m, 1d"
                    aria-describedby={pauseError ? `pause-error-${job.name}` : undefined}
                    className={`${INPUT} w-36`}
                    autoComplete="off"
                  />
                </>
              )}
              {mode === "until" && (
                <>
                  <label className="sr-only" htmlFor={`pause-until-${job.name}`}>
                    Pause until
                  </label>
                  <input
                    id={`pause-until-${job.name}`}
                    type="datetime-local"
                    value={untilLocal}
                    onChange={(e) => {
                      setUntilLocal(e.target.value);
                      setPauseError(null);
                    }}
                    aria-describedby={pauseError ? `pause-error-${job.name}` : undefined}
                    className={INPUT}
                  />
                </>
              )}
              <button type="button" onClick={submitPause} disabled={pause.isPending} className={BTN}>
                {pause.isPending ? "Pausing…" : "Pause"}
              </button>
            </div>
            {pauseError && (
              <p id={`pause-error-${job.name}`} role="alert" className="text-sm text-bad-fg">
                {pauseError}
              </p>
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
}

function RefusalNote({
  refusal,
  onRunAnyway,
  pending,
}: {
  refusal: RunRefusal;
  onRunAnyway: () => void;
  pending: boolean;
}) {
  if (refusal.kind === "error") {
    return (
      <div role="alert" className={NOTE_BAD}>
        {refusal.message}
      </div>
    );
  }
  return (
    <div role="status" className={`${NOTE_WARN} flex flex-col gap-2`}>
      {refusal.kind === "conflict" ? (
        <p>
          <strong>Already running.</strong>{" "}
          {refusal.runningRunId ? (
            <>
              Run{" "}
              <Link to={`/runs/${refusal.runningRunId}`} className="font-mono font-medium underline">
                {shortId(refusal.runningRunId)}
              </Link>{" "}
              is still in flight. Nothing new was started.
            </>
          ) : (
            "A run is still in flight. Nothing new was started."
          )}
        </p>
      ) : (
        <p>
          <strong>Not started:</strong> {refusal.label}.{" "}
          {refusal.runId && (
            <>
              The skip was recorded as run{" "}
              <Link to={`/runs/${refusal.runId}`} className="font-mono font-medium underline">
                {shortId(refusal.runId)}
              </Link>
              .
            </>
          )}
        </p>
      )}
      {canForce(refusal) && (
        <div>
          <ConfirmButton
            label="Run anyway"
            question={
              refusal.kind === "conflict"
                ? "Start a second, parallel copy?"
                : "Start it regardless, ignoring that?"
            }
            confirmLabel="Run anyway"
            cancelLabel="Don't run"
            pending={pending}
            onConfirm={onRunAnyway}
          />
        </div>
      )}
    </div>
  );
}
