import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectEvents, getConnectionState, subscribeConnectionState } from "./sse.ts";
import type { ConnectionState, SSEConnection } from "./sse.ts";
import { invalidateForEvent } from "./invalidate.ts";

let current: SSEConnection | null = null;

/** Reconnect the event stream now (from a "retry" button). */
export function reconnectEvents(): void {
  current?.reconnect();
}

/** The event stream's state, live, for a status bar. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeConnectionState, getConnectionState, getConnectionState);
}

/**
 * Subscribes once at app mount to the supervisor's `/events` SSE stream and
 * invalidates the relevant React Query caches based on event names. Mount via
 * a tiny `<SSEMount />` component inside the QueryClientProvider exactly once
 * — the connection auto-reconnects, so unmount/remount cycles are wasteful.
 * Every (re)open refetches everything: events sent while the stream was down
 * are gone, and the first open covers anything that changed while the page loaded.
 */
export function useSSE() {
  const qc = useQueryClient();
  useEffect(() => {
    const conn = connectEvents(
      ({ name }) => invalidateForEvent(qc, name),
      { onOpen: () => void qc.invalidateQueries() },
    );
    current = conn;
    return () => {
      conn.close();
      if (current === conn) current = null;
    };
  }, [qc]);
}
