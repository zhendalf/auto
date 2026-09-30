// Tiny hand-rolled router. No third-party deps.
//
// Pattern syntax: literal segments + `:param` placeholders. A `:param` never
// matches an empty segment. A trailing `*` matches the rest of the path (used
// for /assets/*). Match results expose captured params + the wildcard suffix
// as `params._rest`. A single trailing slash is ignored (`/api/jobs/` is
// `/api/jobs`), and HEAD is served by the matching GET handler with the body
// dropped.

export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
  url: URL,
) => Response | Promise<Response>;

export type Route = {
  method: string;
  pattern: string;
  handler: RouteHandler;
};

type CompiledRoute = {
  method: string;
  pattern: string;
  segments: ({ kind: "literal"; value: string } | { kind: "param"; name: string } | { kind: "wildcard" })[];
  hasWildcard: boolean;
  handler: RouteHandler;
};

function compile(route: Route): CompiledRoute {
  const raw = route.pattern;
  if (!raw.startsWith("/")) throw new Error(`pattern must start with /: ${raw}`);
  const parts = raw === "/" ? [""] : raw.slice(1).split("/");
  let hasWildcard = false;
  const segments: CompiledRoute["segments"] = parts.map((p, i) => {
    if (p === "*") {
      if (i !== parts.length - 1) {
        throw new Error(`wildcard '*' must be the final segment: ${raw}`);
      }
      hasWildcard = true;
      return { kind: "wildcard" } as const;
    }
    if (p.startsWith(":")) return { kind: "param", name: p.slice(1) } as const;
    return { kind: "literal", value: p } as const;
  });
  return {
    method: route.method.toUpperCase(),
    pattern: raw,
    segments,
    hasWildcard,
    handler: route.handler,
  };
}

export class Router {
  private readonly routes: CompiledRoute[];

  constructor(routes: Route[]) {
    this.routes = routes.map(compile);
  }

  /**
   * Look up a matching route. Returns `none` when no pattern matches the path
   * and `method_not_allowed` when at least one pattern matches the path but
   * none for this method; `allowed` is the sorted list of methods that would
   * have matched, ready for an `Allow` header (see `methodNotAllowed`).
   */
  match(
    method: string,
    pathname: string,
  ):
    | { kind: "match"; handler: RouteHandler; params: Record<string, string> }
    | { kind: "method_not_allowed"; allowed: string[] }
    | { kind: "none" } {
    const m = method.toUpperCase();
    const inputParts = splitPath(pathname);
    const pathMatches: CompiledRoute[] = [];

    for (const r of this.routes) {
      const params = matchSegments(r, inputParts);
      if (params === null) continue;
      pathMatches.push(r);
      if (r.method !== m) continue;
      return { kind: "match", handler: r.handler, params };
    }
    if (m === "HEAD") {
      const get = pathMatches.find((r) => r.method === "GET");
      if (get) {
        const params = matchSegments(get, inputParts)!;
        const handler: RouteHandler = async (req, p, url) => {
          const res = await get.handler(req, p, url);
          return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
        };
        return { kind: "match", handler, params };
      }
    }
    if (pathMatches.length === 0) return { kind: "none" };
    const allowed = new Set(pathMatches.map((r) => r.method));
    if (allowed.has("GET")) allowed.add("HEAD");
    return { kind: "method_not_allowed", allowed: [...allowed].sort() };
  }
}

function splitPath(pathname: string): string[] {
  if (pathname === "/") return [""];
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed.slice(1).split("/");
}

function matchSegments(
  route: CompiledRoute,
  inputParts: string[],
): Record<string, string> | null {
  const segs = route.segments;
  if (route.hasWildcard) {
    if (inputParts.length < segs.length - 1) return null;
  } else if (inputParts.length !== segs.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.kind === "wildcard") {
      // Capture remaining as `_rest` (URL-decoded join with /).
      const rest = inputParts.slice(i).join("/");
      try {
        params._rest = decodeURIComponent(rest);
      } catch {
        params._rest = rest;
      }
      return params;
    }
    const inp = inputParts[i] ?? "";
    if (seg.kind === "literal") {
      if (seg.value !== inp) return null;
    } else {
      if (inp === "") return null;
      // :param — URL-decode the captured segment.
      try {
        params[seg.name] = decodeURIComponent(inp);
      } catch {
        params[seg.name] = inp;
      }
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function json(body: unknown, init?: ResponseInit): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  // Allow callers to override via init.headers (Record<string, string> shape).
  if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers,
  });
}

export function errorJson(
  status: number,
  error: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return json({ error, ...(extra ?? {}) }, { status, headers });
}

/**
 * 405 with an `Allow` header. `allowed` is the list from a
 * `method_not_allowed` match result.
 */
export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: allowed.join(", ") } });
}

// ---------------------------------------------------------------------------
// Request body helpers
// ---------------------------------------------------------------------------

/** Default cap for JSON bodies on API POST handlers. */
export const API_BODY_MAX_BYTES = 64 * 1024;

export type BodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "bad_length" };

/**
 * Read a request body as a stream and stop the moment `maxBytes` is exceeded,
 * so an oversize (or chunked, length-less) upload is never fully buffered.
 * A Content-Length that is not a plain non-negative integer, that is sent
 * together with Transfer-Encoding, or that disagrees with the bytes actually
 * received is reported as `bad_length` rather than trusted.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<BodyResult> {
  const lengthHeader = req.headers.get("content-length");
  let declared: number | null = null;
  if (lengthHeader !== null) {
    if (!/^\d{1,15}$/.test(lengthHeader) || req.headers.has("transfer-encoding")) {
      return { ok: false, reason: "bad_length" };
    }
    declared = Number(lengthHeader);
    if (declared > maxBytes) return { ok: false, reason: "too_large" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, reason: "bad_length" };
    }
  }
  if (declared !== null && declared !== total) return { ok: false, reason: "bad_length" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
