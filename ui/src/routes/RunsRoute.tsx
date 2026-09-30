import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useJobs, useRuns } from "../api/hooks.ts";
import { ErrorPanel, Loading, StaleWarning } from "../components/QueryError.tsx";
import { RunsTable } from "../components/RunsTable.tsx";
import { BTN, CODE, INPUT } from "../components/ui.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  RUN_STATES,
  filterRunsByText,
  parseLimitParam,
  parseStateParam,
} from "../util/runsFilter.ts";

/**
 * The URL is the source of truth for the filters, so a refresh or a shared
 * link keeps them. The list is infinite: "Load older runs" appends the next
 * page (the API's cursor is remembered by the query, not the URL).
 */
export function RunsRoute() {
  useDocumentTitle("Runs");
  const [searchParams, setSearchParams] = useSearchParams();
  const jobsQuery = useJobs();

  const job = searchParams.get("job") ?? "";
  const rawState = searchParams.get("state");
  const state = parseStateParam(rawState);
  const limit = parseLimitParam(searchParams.get("limit"));
  const urlText = searchParams.get("q") ?? "";

  // The text box keeps its own value so typing never waits on the router; the
  // URL follows a moment later, and changes made elsewhere (Clear filters,
  // back button) flow into the box.
  const [text, setText] = useState(urlText);
  const pushedText = useRef(urlText);

  const runsQuery = useRuns({ job: job || undefined, state: state || undefined, limit });

  useEffect(() => {
    if (urlText !== pushedText.current) {
      pushedText.current = urlText;
      setText(urlText);
    }
  }, [urlText]);

  const setParam = (key: string, value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const clearFilters = () => {
    pushedText.current = "";
    setText("");
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of ["job", "state", "q"]) next.delete(k);
        return next;
      },
      { replace: true },
    );
  };

  // The timer below fires up to 250 ms after the render that scheduled it.
  // React Router's functional setSearchParams starts from the params of the
  // render it came from, so a Job or State picked in that window would be
  // overwritten by a stale copy. The timer calls the latest render's setter.
  const latestSetParam = useRef(setParam);
  latestSetParam.current = setParam;

  useEffect(() => {
    if (text === pushedText.current) return;
    const timer = window.setTimeout(() => {
      pushedText.current = text;
      latestSetParam.current("q", text);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  const loaded = useMemo(() => runsQuery.data?.pages.flatMap((p) => p.runs) ?? [], [runsQuery.data]);
  const shown = useMemo(() => filterRunsByText(loaded, text), [loaded, text]);

  const jobNames = useMemo(() => (jobsQuery.data ?? []).map((j) => j.name).sort((a, b) => a.localeCompare(b)), [jobsQuery.data]);
  const jobKnown = !job || jobNames.includes(job);
  // An unknown ?job= stays selectable (the job may have been removed from the
  // config while its history is still there).
  const jobOptions = jobKnown || jobsQuery.isPending ? jobNames : [job, ...jobNames];

  const activeFilters: { key: string; label: string }[] = [];
  if (job) activeFilters.push({ key: "job", label: `job: ${job}` });
  if (state) activeFilters.push({ key: "state", label: `state: ${state.replace(/_/g, " ")}` });
  if (text) activeFilters.push({ key: "q", label: `text: ${text}` });

  const invalidState = rawState !== null && rawState !== "" && !state;
  const filtered = activeFilters.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Runs</h1>

      <form
        className="flex flex-wrap items-end gap-3 text-sm"
        role="search"
        aria-label="Filter runs"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Job</span>
          <select value={job} onChange={(e) => setParam("job", e.target.value)} className={INPUT}>
            <option value="">All jobs</option>
            {jobOptions.map((n) => (
              <option key={n} value={n}>
                {n}
                {jobsQuery.data && !jobNames.includes(n) ? " (not in config)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">State</span>
          <select value={state} onChange={(e) => setParam("state", e.target.value)} className={INPUT}>
            <option value="">All states</option>
            {RUN_STATES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Page size</span>
          <select
            value={limit}
            onChange={(e) => setParam("limit", Number(e.target.value) === DEFAULT_PAGE_SIZE ? "" : e.target.value)}
            className={INPUT}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 sm:max-w-xs">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Find in loaded runs</span>
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="job name or run id"
            className={INPUT}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </form>

      {invalidState && (
        <p role="status" className="text-sm text-warn-fg">
          “{rawState}” is not a run state, so it is ignored. States: {RUN_STATES.join(", ")}.
        </p>
      )}

      {filtered && (
        <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Active filters" role="group">
          <span className="text-muted">Filtering by</span>
          {activeFilters.map((f) => (
            <span
              key={f.key}
              className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface py-0.5 pl-3 pr-1"
            >
              {f.label}
              <button
                type="button"
                aria-label={`Remove filter ${f.label}`}
                className="rounded-full px-1.5 text-base leading-none text-muted hover:bg-sunken hover:text-fg"
                onClick={() => {
                  if (f.key === "q") {
                    pushedText.current = "";
                    setText("");
                  }
                  setParam(f.key, "");
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
          <button type="button" className="font-medium text-link underline" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {runsQuery.isPending ? (
        <Loading what="runs" />
      ) : !runsQuery.data ? (
        <ErrorPanel error={runsQuery.error} what="runs" onRetry={() => void runsQuery.refetch()} />
      ) : (
        <>
          {runsQuery.isError && !runsQuery.isFetchNextPageError && (
            <StaleWarning error={runsQuery.error} onRetry={() => void runsQuery.refetch()} />
          )}
          <RunsTable
            runs={shown}
            busy={runsQuery.isPlaceholderData}
            emptyText={
              loaded.length > 0 ? (
                <>No loaded run matches “{text}”. {runsQuery.hasNextPage ? "Load older runs to search further." : ""}</>
              ) : filtered ? (
                <>No runs match these filters.</>
              ) : (
                <>
                  No runs yet. Start one from a job page, or run <code className={CODE}>auto run &lt;job&gt;</code>.
                </>
              )
            }
          />
          {text && loaded.length > 0 && (
            <p className="text-xs text-muted">
              Showing {shown.length} of {loaded.length} loaded runs.
            </p>
          )}
          <div className="flex flex-col items-center gap-2">
            {runsQuery.isFetchNextPageError && (
              <p role="alert" className="text-sm text-bad-fg">
                Could not load older runs. Try again.
              </p>
            )}
            {runsQuery.hasNextPage ? (
              <button
                type="button"
                className={BTN}
                disabled={runsQuery.isFetchingNextPage}
                onClick={() => void runsQuery.fetchNextPage()}
              >
                {runsQuery.isFetchingNextPage ? "Loading…" : "Load older runs"}
              </button>
            ) : (
              loaded.length > 0 && <p className="text-xs text-subtle">That is every run{filtered ? " matching the filters" : ""}.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
