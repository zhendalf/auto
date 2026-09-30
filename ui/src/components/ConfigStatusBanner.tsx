import { useConfigStatus } from "../api/hooks.ts";
import { RelativeTime } from "./Time.tsx";
import { configIssue, summaryLine } from "../util/configIssue.ts";

/** One line under the header when the config is broken; the full text is in the Status panel. */
export function ConfigStatusBanner() {
  const q = useConfigStatus();
  const issue = configIssue(q.data);
  if (!issue) return null;
  const firstLine = summaryLine(issue.message);
  const degraded = issue.mode === "degraded";
  return (
    <div
      role={degraded ? "alert" : "status"}
      className={`border-b px-4 py-1.5 text-sm ${
        degraded ? "border-bad-fg/30 bg-bad-bg text-bad-fg" : "border-warn-fg/30 bg-warn-bg text-warn-fg"
      }`}
    >
      <span className="font-medium">
        {degraded ? "Supervisor is degraded" : "Last config reload failed"}
      </span>
      {issue.at != null && (
        <span>
          {" "}
          (<RelativeTime at={issue.at} />)
        </span>
      )}
      : <span className="break-words">{issue.kind}: {firstLine}.</span>{" "}
      <span className="opacity-90">Open Status for details and to reload.</span>
    </div>
  );
}
