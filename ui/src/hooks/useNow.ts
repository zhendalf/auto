import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { expiryDelayMs, nextPauseExpiry } from "../util/pause.ts";

type Ticker = { now: number; listeners: Set<() => void>; timer: number | undefined };

// One shared timer per interval, however many components ask for it.
const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  let t = tickers.get(intervalMs);
  if (!t) {
    t = { now: Date.now(), listeners: new Set(), timer: undefined };
    tickers.set(intervalMs, t);
  }
  return t;
}

function refresh(t: Ticker) {
  t.now = Date.now();
  for (const l of [...t.listeners]) l();
}

/**
 * The current time, re-rendered every `intervalMs`: 1000 for the elapsed time
 * of a running run, 30_000 for relative times ("5m ago", "paused"). All
 * subscribers of an interval share one timer, and returning to a hidden tab
 * refreshes at once instead of showing minutes-old values.
 */
export function useNow(intervalMs: number = 30_000): number {
  const t = tickerFor(intervalMs);
  return useSyncExternalStore(
    (listener) => {
      t.listeners.add(listener);
      if (t.timer === undefined) t.timer = window.setInterval(() => refresh(t), intervalMs);
      // The snapshot may be stale if the ticker sat idle with no subscribers.
      if (Date.now() - t.now >= intervalMs) refresh(t);
      const onVisible = () => {
        if (document.visibilityState === "visible") refresh(t);
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        t.listeners.delete(listener);
        if (t.listeners.size === 0 && t.timer !== undefined) {
          window.clearInterval(t.timer);
          t.timer = undefined;
        }
      };
    },
    () => t.now,
    () => t.now,
  );
}

/**
 * Interval for a relative time: every second while it is under a minute old
 * (so "5s ago" counts), then every 30 seconds.
 */
export function relativeTickMs(epochMs: number | null | undefined, now: number = Date.now()): number {
  if (epochMs == null) return 30_000;
  return Math.abs(now - epochMs) < 60_000 ? 1_000 : 30_000;
}

/**
 * `useNow`, plus a refresh the moment a pause ends. Nothing on the server
 * announces that: without this the "paused" chip and the state card would lag
 * by up to a tick, and the next run (unscheduled while paused) would only come
 * back with the slow safety poll. When the soonest pause in `pausedUntil`
 * runs out this re-renders with a fresh clock and refetches the job queries.
 */
export function useNowWithPauseExpiry(pausedUntil: Iterable<number | null | undefined>): number {
  const now = useNow();
  const qc = useQueryClient();
  const [bumped, setBumped] = useState(0);
  const expiry = nextPauseExpiry(pausedUntil, Math.max(now, bumped));
  useEffect(() => {
    if (expiry === null) return;
    const timer = window.setTimeout(() => {
      setBumped(Date.now());
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["job"] });
    }, expiryDelayMs(expiry, Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiry, qc]);
  return Math.max(now, bumped);
}
