// `auto ui` — open the dashboard.
//
// The supervisor serves the dashboard at its base URL for any allowed Host, so
// there is nothing to sign in to: this prints the URL and opens it. It talks
// to the supervisor only to check it is up (`/healthz`, no token needed).

import { ApiClient } from "../client.ts";
import { EX, getApiClient, globals, printJson, println, status } from "../runtime.ts";

/** Command line that opens `url` in the default browser, or null on an unknown platform. */
export function openerCommand(platform: NodeJS.Platform, url: string): string[] | null {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "linux":
    case "freebsd":
    case "openbsd":
      return ["xdg-open", url];
    case "win32":
      // The empty string is `start`'s window-title argument.
      return ["cmd", "/c", "start", "", url];
    default:
      return null;
  }
}

async function openInBrowser(url: string): Promise<boolean> {
  const cmd = openerCommand(process.platform, url);
  if (!cmd) return false;
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    // Opener not installed (e.g. no xdg-open on a headless box).
    return false;
  }
}

export type UiDeps = {
  client?: ApiClient;
  /** Returns true when the browser was launched. */
  open?: (url: string) => Promise<boolean>;
};

export async function runUi(deps: UiDeps = {}): Promise<number> {
  const client = deps.client ?? getApiClient();
  const open = deps.open ?? openInBrowser;
  const url = client.baseUrl + "/";

  // The URL always goes to stdout so it can be copied or piped; with --json
  // stdout carries JSON only.
  if (globals().json) printJson({ url });
  else println(url);

  if (!(await client.reachable())) {
    status(`supervisor unreachable at ${client.baseUrl}`);
    status("run `auto install` (first time) or `auto svc start` to start it");
    return EX.UNREACHABLE;
  }

  // A script asking for JSON wants the URL, not a browser window.
  if (globals().json) return EX.OK;

  if (!(await open(url))) status("could not open a browser; open the URL yourself");
  return EX.OK;
}
