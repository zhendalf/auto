import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { api, isTerminalState } from "./client.ts";
import type { RunsCursor } from "./client.ts";
import { useConnectionState } from "./sseHook.ts";
import { useToast } from "../components/Toast.tsx";
import { errorSentence } from "../util/errors.ts";
import { formatTime, shortId } from "../util/format.ts";

/**
 * Background refresh for lists the event stream normally keeps current. It is
 * a slow safety net while connected (paused jobs come back without an event,
 * for one) and a faster poll while the stream is down.
 */
function useSafetyRefetchMs(): number {
  return useConnectionState() === "open" ? 60_000 : 10_000;
}

export const useJobs = () => {
  const refetchInterval = useSafetyRefetchMs();
  return useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval });
};

export const useJob = (name: string) => {
  const refetchInterval = useSafetyRefetchMs();
  return useQuery({
    queryKey: ["job", name],
    queryFn: () => api.job(name),
    enabled: !!name,
    refetchInterval,
  });
};

export type RunsFilter = { job?: string; state?: string; limit: number };

/**
 * Runs, newest first, as an infinite list: each "Load older" appends the next
 * page using the API's composite cursor. The previous filter's rows stay on
 * screen while a new filter loads.
 */
export const useRuns = (filter: RunsFilter) =>
  useInfiniteQuery({
    queryKey: ["runs", filter],
    queryFn: ({ pageParam }) => api.runs({ ...filter, cursor: pageParam }),
    initialPageParam: null as RunsCursor | null,
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
  });

/** A run by full id, prefix or short id. While it is in flight it refetches every 2 s as a fallback for missed events. */
export const useRun = (id: string) =>
  useQuery({
    queryKey: ["run", id],
    queryFn: () => api.run(id),
    enabled: !!id,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && !isTerminalState(state) ? 2_000 : false;
    },
  });

export const useConfigStatus = () =>
  useQuery({
    queryKey: ["config-status"],
    queryFn: api.configStatus,
    refetchInterval: 30_000,
  });

/** Refresh everything a job change can touch. */
function invalidateJobViews(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["jobs"] });
  qc.invalidateQueries({ queryKey: ["job"] });
}

export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, force, reason }: { name: string; force?: boolean; reason?: string }) =>
      api.runJob(name, { force, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      invalidateJobViews(qc);
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (_data, runId) => {
      toast.success(`Cancelled run ${shortId(runId)}.`);
    },
    onError: (err) => toast.error(`Could not cancel the run. ${errorSentence(err)}`),
    onSettled: () => {
      // Also after a failure: "already finished" means the view is stale.
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["run"] });
      invalidateJobViews(qc);
    },
  });
}

// ---------------------------------------------------------------------------
// Job and trigger switches. The round-trip is loopback-fast, so these wait for
// the server and then refetch instead of guessing the result optimistically.
// Every outcome, good or bad, is reported through the toast area.
// ---------------------------------------------------------------------------

export function useEnableJob() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (name: string) => api.enableJob(name),
    onSuccess: (_d, name) => toast.success(`Enabled ${name}.`),
    onError: (err, name) => toast.error(`Could not enable ${name}. ${errorSentence(err)}`),
    onSettled: () => invalidateJobViews(qc),
  });
}

export function useDisableJob() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (name: string) => api.disableJob(name),
    onSuccess: (_d, name) => toast.success(`Disabled ${name}. Nothing will start it until it is enabled again.`),
    onError: (err, name) => toast.error(`Could not disable ${name}. ${errorSentence(err)}`),
    onSettled: () => invalidateJobViews(qc),
  });
}

export type PauseRequest = { name: string; durationMs?: number; untilIso?: string };

export function usePauseJob() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ name, durationMs, untilIso }: PauseRequest) =>
      api.pauseJob(name, { duration_ms: durationMs, until_iso: untilIso }),
    onSuccess: (res, vars) =>
      toast.success(`Paused ${vars.name} until ${formatTime(res.paused_until)}.`),
    onError: (err, vars) => toast.error(`Could not pause ${vars.name}. ${errorSentence(err)}`),
    onSettled: () => invalidateJobViews(qc),
  });
}

export function useUnpauseJob() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (name: string) => api.unpauseJob(name),
    onSuccess: (_d, name) => toast.success(`Resumed ${name}.`),
    onError: (err, name) => toast.error(`Could not resume ${name}. ${errorSentence(err)}`),
    onSettled: () => invalidateJobViews(qc),
  });
}

export function useSetTriggerEnabled() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; label: string; enabled: boolean }) =>
      enabled ? api.enableTrigger(id) : api.disableTrigger(id),
    onSuccess: (_d, vars) =>
      toast.success(`${vars.enabled ? "Enabled" : "Disabled"} trigger ${vars.label}.`),
    onError: (err, vars) =>
      toast.error(
        `Could not ${vars.enabled ? "enable" : "disable"} trigger ${vars.label}. ${errorSentence(err)}`,
      ),
    onSettled: () => invalidateJobViews(qc),
  });
}

/** Ask the supervisor to re-read the config file now. */
export function useReloadConfig() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.configReload(),
    onSuccess: (res) => {
      const warnings = res.warnings?.length ?? 0;
      const base = `Config reloaded: ${res.jobs} ${res.jobs === 1 ? "job" : "jobs"}, ${res.triggers} ${res.triggers === 1 ? "trigger" : "triggers"}.`;
      toast.success(warnings > 0 ? `${base} ${warnings} ${warnings === 1 ? "warning" : "warnings"}.` : base);
    },
    onError: (err) => toast.error(`Config reload failed. ${errorSentence(err)}`.slice(0, 600)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["config-status"] });
      invalidateJobViews(qc);
    },
  });
}
