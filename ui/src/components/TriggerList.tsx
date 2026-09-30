import type { JobDetail, Trigger } from "../api/client.ts";
import { shellWord } from "../util/shell.ts";
import { useSetTriggerEnabled } from "../api/hooks.ts";
import { describeCron } from "../util/cron.ts";
import { formatBytes, formatTimeWithZone, formatTimeoutMs } from "../util/format.ts";
import { idleReason, triggerLocalId } from "../util/jobs.ts";
import { Chip } from "./Chip.tsx";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { RelativeTime } from "./Time.tsx";
import { BTN, BTN_SM, CODE } from "./ui.ts";

/** Every trigger of a job with what it does, when it fires next, and an on/off switch. */
export function TriggerList({ job, now }: { job: JobDetail; now: number }) {
  if (job.triggers.length === 0) {
    return (
      <p className="text-sm text-muted">
        No triggers. This job only runs when you start it (Run now, or <code className={CODE}>auto run {shellWord(job.name)}</code>).
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {job.triggers.map((t) => (
        <TriggerCard key={t.trigger_id} trigger={t} job={job} now={now} />
      ))}
    </ul>
  );
}

function TriggerCard({ trigger, job, now }: { trigger: Trigger; job: JobDetail; now: number }) {
  const setEnabled = useSetTriggerEnabled();
  const localId = triggerLocalId(trigger.trigger_id);
  const toggle = (enabled: boolean) =>
    setEnabled.mutate({ id: trigger.trigger_id, label: localId, enabled });

  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="neutral" upper>
          {trigger.kind}
        </Chip>
        <span className="font-mono text-sm">{localId}</span>
        {trigger.enabled ? (
          <Chip tone="ok">on</Chip>
        ) : (
          <Chip tone="neutral" title="This trigger is switched off">
            off
          </Chip>
        )}
        <span className="ml-auto">
          {trigger.enabled ? (
            <ConfirmButton
              small
              label="Disable"
              ariaLabel={`Disable trigger ${localId}`}
              question={`Disable trigger ${localId}?`}
              confirmLabel="Disable trigger"
              pending={setEnabled.isPending}
              onConfirm={() => toggle(false)}
              className="!px-2"
            />
          ) : (
            <button
              type="button"
              className={`${BTN} ${BTN_SM}`}
              aria-label={`Enable trigger ${localId}`}
              disabled={setEnabled.isPending}
              onClick={() => toggle(true)}
            >
              Enable
            </button>
          )}
        </span>
      </div>

      <div className="mt-2 text-sm">
        {trigger.kind === "cron" ? (
          <CronDetails trigger={trigger} job={job} now={now} />
        ) : trigger.kind === "webhook" ? (
          <WebhookDetails trigger={trigger} />
        ) : null}
      </div>
    </li>
  );
}

function CronDetails({ trigger, job, now }: { trigger: Trigger; job: JobDetail; now: number }) {
  const schedule = trigger.schedule;
  const phrase = describeCron(schedule);
  const idle = idleReason(job, now);
  let next: React.ReactNode;
  if (typeof trigger.next_run_at === "number") {
    next = (
      <>
        <RelativeTime at={trigger.next_run_at} upcoming />{" "}
        <span className="text-muted">({formatTimeWithZone(trigger.next_run_at)})</span>
      </>
    );
  } else if (!trigger.enabled) {
    next = <span className="text-muted">not scheduled: this trigger is off</span>;
  } else if (idle) {
    next = <span className="text-muted">not scheduled: the job is {idle}</span>;
  } else {
    next = <span className="text-muted">not scheduled</span>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted">Schedule</dt>
      <dd>
        {schedule ? <code className={CODE}>{schedule}</code> : "—"}
        {phrase && <span className="ml-2">{phrase}</span>}
        <span className="ml-2 text-muted">(machine local time)</span>
      </dd>
      <dt className="text-muted">Next run</dt>
      <dd>{next}</dd>
      {trigger.condition && (
        <>
          <dt className="text-muted">Condition</dt>
          <dd>
            Fires only when the checker <code className={CODE}>{trigger.condition.checker}</code> says so (timeout{" "}
            {formatTimeoutMs(trigger.condition.timeoutMs)}).
          </dd>
        </>
      )}
    </dl>
  );
}

function WebhookDetails({ trigger }: { trigger: Trigger }) {
  const present = trigger.secret_present;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted">Path</dt>
      <dd className="break-all">
        POST <code className={CODE}>{trigger.public_path ?? `/hooks/${String(trigger.path ?? "")}`}</code>
      </dd>
      <dt className="text-muted">Secret</dt>
      <dd>
        {trigger.secretRef ? <code className={CODE}>{trigger.secretRef}</code> : "—"}{" "}
        {present === true && <Chip tone="ok">set</Chip>}
        {present === false && (
          <>
            <Chip tone="bad">not set</Chip>{" "}
            <span className="text-muted">
              Deliveries are refused until you run <code className={CODE}>auto secret set {trigger.secretRef ?? "<name>"}</code>.
            </span>
          </>
        )}
      </dd>
      <dt className="text-muted">Signature</dt>
      <dd>
        HMAC-SHA256 in header <code className={CODE}>{trigger.signatureHeader ?? "—"}</code>
      </dd>
      {trigger.deliveryIdHeader && (
        <>
          <dt className="text-muted">Delivery id</dt>
          <dd>
            Header <code className={CODE}>{trigger.deliveryIdHeader}</code> (repeats are ignored)
          </dd>
        </>
      )}
      <dt className="text-muted">Accepts</dt>
      <dd>
        {(trigger.contentTypes ?? []).length > 0 ? (trigger.contentTypes ?? []).join(", ") : "—"}
        {typeof trigger.maxBodyBytes === "number" && (
          <span className="text-muted"> · up to {formatBytes(trigger.maxBodyBytes)}</span>
        )}
      </dd>
    </dl>
  );
}
