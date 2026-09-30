import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { api, isTerminalState } from "../api/client.ts";
import type { AnsiSegment } from "../util/ansi.ts";
import { formatBytes } from "../util/format.ts";
import { LogFollower } from "../util/logFollower.ts";
import type { LogSource } from "../util/logFollower.ts";
import type { LogLine } from "../util/logBuffer.ts";
import { errorSentence } from "../util/errors.ts";
import { useToast } from "./Toast.tsx";
import { BTN, BTN_SM, TOGGLE } from "./ui.ts";

/** Within this many pixels of the bottom counts as "at the bottom". */
const BOTTOM_SLOP_PX = 24;

const source: LogSource = {
  info: (id) => api.runLogInfo(id),
  chunk: (id, offset) => api.runLogChunk(id, offset),
};

/**
 * Follows one run's log. While the run is queued or running it fetches only
 * the new bytes each second (`?offset=`), and stops as soon as the run is
 * over. It keeps a bounded tail in memory, renders ANSI colors as spans
 * (never as HTML), and follows the bottom unless the user scrolls up.
 */
export function LogViewer({
  runId,
  runState,
  filename,
}: {
  runId: string;
  runState: string;
  filename: string;
}) {
  const toast = useToast();
  const active = !isTerminalState(runState);
  const activeRef = useRef(active);
  activeRef.current = active;

  const followerRef = useRef<LogFollower | null>(null);
  if (followerRef.current === null) followerRef.current = new LogFollower(runId, source);
  const follower = followerRef.current;

  const [version, rerender] = useReducer((n: number) => n + 1, 0);
  // Each run of the polling effect gets a number; a poll that finishes after a
  // newer effect started is discarded so the same bytes are never appended twice.
  const epochRef = useRef(0);
  const [fullEpoch, setFullEpoch] = useState(0);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(readWrapPreference);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const epoch = ++epochRef.current;
    const stale = () => cancelled || epoch !== epochRef.current;

    // A queued run has no log yet and a skipped one never will; when the run
    // starts, `runState` changes and this effect runs again.
    if (runState === "queued" || runState === "skipped") {
      if (follower.noLogExpected()) rerender();
      return;
    }

    const loop = async () => {
      const result = await follower.step(activeRef.current, stale);
      if (stale()) return;
      if (result.changed) rerender();
      if (result.delayMs === null) return;
      timer = window.setTimeout(loop, result.delayMs);
    };

    void loop();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // A change of run state re-runs the poll: once more when the run ends, to read the last bytes.
  }, [follower, active, runState, fullEpoch]);

  // Stick to the bottom after new content lands, but only while following.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [version, follow, wrap]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLOP_PX);
  }, []);

  const toggleWrap = () => {
    setWrap((w) => {
      writeWrapPreference(!w);
      return !w;
    });
  };

  const loadFull = () => {
    follower.loadFull();
    setFollow(false);
    setFullEpoch((n) => n + 1);
    rerender();
  };

  const copy = async () => {
    const text = follower.buffer.plainText();
    if (!text) {
      toast.info("There is no log text to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(follower.cutAtTop ? "Copied the part of the log that is shown." : "Copied the log.");
    } catch {
      toast.error("The browser did not allow copying. Select the text and copy it instead.");
    }
  };

  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await api.downloadRunLog(runId, filename);
    } catch (err) {
      toast.error(`Could not download the log. ${errorSentence(err)}`);
    } finally {
      setDownloading(false);
    }
  };

  const { buffer, notice, total } = follower;
  const partial = buffer.partial();
  const empty = buffer.isEmpty;
  const noLog = notice?.kind === "none" && empty;
  const emptyText = emptyMessage(runState, notice?.kind === "none" ? notice.reason : null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {active && (
          <span className="flex items-center gap-1.5 text-ok-fg">
            <span aria-hidden="true" className="pulse-dot inline-block h-2 w-2 rounded-full bg-ok-fg" />
            live
          </span>
        )}
        {total > 0 && <span className="tabular-nums">{formatBytes(total)}</span>}
        <span className={`ml-auto flex-wrap items-center gap-1.5 ${noLog ? "hidden" : "flex"}`}>
          <button
            type="button"
            className={`${BTN} ${BTN_SM} ${TOGGLE}`}
            aria-pressed={follow}
            onClick={() => setFollow((f) => !f)}
          >
            Follow
          </button>
          <button type="button" className={`${BTN} ${BTN_SM} ${TOGGLE}`} aria-pressed={wrap} onClick={toggleWrap}>
            Wrap lines
          </button>
          <button type="button" className={`${BTN} ${BTN_SM}`} onClick={copy}>
            Copy
          </button>
          <button type="button" className={`${BTN} ${BTN_SM}`} disabled={downloading} onClick={download}>
            Download
          </button>
        </span>
      </div>

      {follower.cutAtTop && (
        <div role="note" className="rounded-md border border-line bg-sunken px-3 py-1.5 text-xs text-muted">
          {follower.tailStart > 0
            ? `Showing the end of a large log (${formatBytes(total)} in all). `
            : `Earlier output (${buffer.dropped.toLocaleString()} lines) is not shown to keep the page fast. `}
          {follower.canLoadFull && (
            <>
              <button type="button" className="font-medium text-link underline" onClick={loadFull}>
                Load full log
              </button>{" "}
              or{" "}
            </>
          )}
          <button type="button" className="font-medium text-link underline" disabled={downloading} onClick={download}>
            download it
          </button>
          .
        </div>
      )}

      {notice?.kind === "error" && (
        <div role="status" className="rounded-md border border-warn-fg/40 bg-warn-bg px-3 py-1.5 text-xs text-warn-fg">
          Could not load the log{notice.message ? `: ${notice.message}` : ""}
          {notice.retrying ? " Retrying…" : ""}
        </div>
      )}

      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          role="log"
          aria-label="Run log"
          aria-live="off"
          tabIndex={0}
          className="max-h-[60vh] min-h-24 overflow-auto rounded-md border border-line bg-log-bg p-3 font-mono text-xs leading-relaxed text-log-fg"
        >
          {empty ? (
            <p className="font-sans text-sm text-log-fg/80">{emptyText}</p>
          ) : (
            <div className={wrap ? "whitespace-pre-wrap break-words" : "w-max min-w-full whitespace-pre"}>
              {buffer.lines.map((line) => (
                <LogLineView key={line.no} line={line} />
              ))}
              {partial && <Segments segments={partial} block />}
            </div>
          )}
        </div>
        {!follow && !empty && (
          <button
            type="button"
            className={`${BTN} ${BTN_SM} absolute bottom-3 right-5 shadow-md`}
            onClick={() => setFollow(true)}
          >
            Jump to bottom
          </button>
        )}
      </div>
    </div>
  );
}

function emptyMessage(runState: string, reason: "no_log" | "log_missing" | null): string {
  if (runState === "queued") return "Waiting to start. The log appears when the run does.";
  if (runState === "running") return "No output yet.";
  if (reason === "log_missing") return "The log file for this run is no longer on disk.";
  if (runState === "skipped" || reason === "no_log") return "No log yet. This run never started a worker.";
  return "The run finished without printing anything.";
}

const LogLineView = memo(function LogLineView({ line }: { line: LogLine }) {
  return <Segments segments={line.segments} block />;
});

function Segments({ segments, block }: { segments: AnsiSegment[]; block?: boolean }) {
  const inner =
    segments.length === 0
      ? " "
      : segments.map((s, i) => {
          const cls = segmentClass(s);
          return cls ? (
            <span key={i} className={cls}>
              {s.text}
            </span>
          ) : (
            s.text
          );
        });
  return block ? <div>{inner}</div> : <>{inner}</>;
}

function segmentClass(s: AnsiSegment): string {
  const parts: string[] = [];
  if (s.fg !== null) parts.push(`ansi-fg-${s.fg}`);
  if (s.bg !== null) parts.push(`ansi-bg-${s.bg}`);
  if (s.bold) parts.push("font-bold");
  if (s.dim) parts.push("opacity-70");
  if (s.italic) parts.push("italic");
  if (s.underline) parts.push("underline");
  return parts.join(" ");
}

const WRAP_KEY = "auto.log.wrap";

function readWrapPreference(): boolean {
  try {
    return window.localStorage.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeWrapPreference(value: boolean): void {
  try {
    window.localStorage.setItem(WRAP_KEY, value ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the preference just does not persist.
  }
}
