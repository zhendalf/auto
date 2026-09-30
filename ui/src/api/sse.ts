import { getBootstrap } from "../bootstrap.ts";
import { backoffDelay, createEventStream } from "../util/eventStream.ts";
import type { ConnectionState, SSEEvent } from "../util/eventStream.ts";

export { backoffDelay };
export type { ConnectionState, SSEEvent };

export type SSEConnection = {
  close: () => void;
  /** Reconnect immediately, including after `unauthorized`. */
  reconnect: () => void;
};

export type ConnectOptions = {
  /**
   * Called every time the stream (re)opens. Events emitted while the browser
   * was disconnected are gone, so use it to invalidate every cached query.
   */
  onOpen?: () => void;
};

// ---------------------------------------------------------------------------
// Connection state (subscribable; shaped for React's useSyncExternalStore)
// ---------------------------------------------------------------------------

let connectionState: ConnectionState = "connecting";
const stateListeners = new Set<() => void>();

export function getConnectionState(): ConnectionState {
  return connectionState;
}

/** Subscribe to state changes. Returns the unsubscribe function. */
export function subscribeConnectionState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

function setConnectionState(next: ConnectionState): void {
  if (next === connectionState) return;
  connectionState = next;
  for (const l of [...stateListeners]) l();
}

/**
 * Subscribes to the supervisor's `/events` stream (see util/eventStream.ts):
 * `Authorization: Bearer` from the page's bootstrap tag, reconnect with
 * backoff, stop on 401. Only one connection should be open at a time: the
 * exported state describes the latest one. Call `close()` on unmount.
 */
export function connectEvents(
  onEvent: (ev: SSEEvent) => void,
  options: ConnectOptions = {},
): SSEConnection {
  setConnectionState("connecting");
  return createEventStream({
    url: `${getBootstrap().baseUrl}/events`,
    getToken: () => getBootstrap().token,
    onEvent,
    onOpen: options.onOpen,
    onState: setConnectionState,
    wakeOn: (wake) => {
      window.addEventListener("online", wake);
      return () => window.removeEventListener("online", wake);
    },
  });
}
