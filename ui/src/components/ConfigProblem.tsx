import type { ConfigIssue } from "../util/configIssue.ts";
import { RelativeTime } from "./Time.tsx";
import { CODE, NOTE_BAD, NOTE_WARN } from "./ui.ts";

/**
 * The config error in full: `kind: message`, what it means for the running
 * jobs, and how to fix it. The message can be several lines (one per
 * problem), so it is shown verbatim in a scrollable block.
 */
export function ConfigProblem({ issue, compact }: { issue: ConfigIssue; compact?: boolean }) {
  const degraded = issue.mode === "degraded";
  return (
    <div role={degraded ? "alert" : "status"} className={degraded ? NOTE_BAD : NOTE_WARN}>
      <p className="font-medium">
        {degraded
          ? "The supervisor could not load your config, so no jobs are scheduled."
          : "The last config change was rejected. The previous config is still running."}
        {issue.at != null && (
          <span className="ml-2 font-normal">
            (<RelativeTime at={issue.at} />)
          </span>
        )}
      </p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface/60 p-2 font-mono text-xs">
        {issue.kind}: {issue.message}
      </pre>
      {!compact && (
        <p className="mt-2 text-sm">
          Fix the config file and save it; the supervisor reloads on save. <code className={CODE}>auto config check</code>{" "}
          validates it without touching the running config, and <code className={CODE}>auto config edit</code> opens it
          in your editor.
        </p>
      )}
    </div>
  );
}
