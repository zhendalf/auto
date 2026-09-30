import { reconnectEvents, useConnectionState } from "../api/sseHook.ts";
import { TOKEN_CHANGED_MESSAGE } from "../util/errors.ts";

/**
 * A slim bar under the header while the live event stream is down. The page
 * keeps working from its last data (and polls faster); the bar says why it
 * may be stale. It refetches everything once the stream is back (see
 * useSSE), and disappears.
 */
export function ConnectionBar() {
  const state = useConnectionState();
  if (state === "retrying") {
    return (
      <div role="status" className="border-b border-warn-fg/30 bg-warn-bg px-4 py-1.5 text-sm text-warn-fg">
        Disconnected from the supervisor, retrying. What you see may be out of date.
        <button type="button" className="ml-3 font-medium underline" onClick={reconnectEvents}>
          Retry now
        </button>
      </div>
    );
  }
  if (state === "unauthorized") {
    return (
      <div role="alert" className="border-b border-bad-fg/30 bg-bad-bg px-4 py-1.5 text-sm text-bad-fg">
        {TOKEN_CHANGED_MESSAGE}
        <button type="button" className="ml-3 font-medium underline" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  return null;
}
