import { NOT_SERVED_MESSAGE } from "../bootstrap.ts";
import { CODE } from "./ui.ts";

/**
 * Shown instead of the app when the page carries no bootstrap data: it was
 * opened from a saved copy or a static file server, so there
 * is no supervisor (and no token) behind it.
 */
export function NotServed() {
  return (
    <main role="alert" className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-xl font-semibold">Auto is not connected</h1>
      <p className="mt-2 text-sm text-muted">{NOT_SERVED_MESSAGE}</p>
      <p className="mt-4 text-xs text-subtle">
        Running the Vite dev server? Start the supervisor first (<code className={CODE}>auto install</code>, or{" "}
        <code className={CODE}>bun supervisor/main.ts</code>) so its token file exists, then reload.
      </p>
    </main>
  );
}
