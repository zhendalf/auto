import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DATA_DIR } from "./db/connection.ts";

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export const TOKEN_PATH = resolve(DATA_DIR, ".token");

const HEX_RE = /^[0-9a-f]{64}$/;

function isValidTokenShape(s: string): boolean {
  return HEX_RE.test(s);
}

function warn(message: string): void {
  process.stderr.write(`auth: ${message}\n`);
}

/**
 * Write `token` to `path` atomically with mode 0o600. A stale `<path>.tmp`
 * (from a crashed write, possibly with loose permissions or a planted
 * symlink) is removed first and the new temp file is created exclusively, so
 * the secret is never written through a pre-existing inode.
 */
export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  try {
    unlinkSync(tmp);
  } catch {
    // no stale temp file
  }
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    // The umask can only remove bits, but be explicit anyway.
    fchmodSync(fd, 0o600);
    // Trailing newline so `cat .token | wc -c` == 65.
    writeSync(fd, token + "\n");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Load the token from `<DATA_DIR>/.token` or generate a new one (32 random
 * bytes hex-encoded → 64 hex chars). Mode 0o600. Atomic write via .tmp + rename.
 *
 * An existing token file with group/other permission bits is tightened to
 * 0o600 with a warning; if that is not possible the token is treated as
 * exposed and replaced.
 */
export function loadOrCreateToken(opts?: { tokenPath?: string }): string {
  const path = opts?.tokenPath ?? TOKEN_PATH;
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (isValidTokenShape(raw)) {
        const mode = statSync(path).mode & 0o777;
        if ((mode & 0o077) === 0) return raw;
        try {
          chmodSync(path, 0o600);
          warn(`token file had mode ${mode.toString(8)}; tightened to 600`);
          return raw;
        } catch {
          warn("token file has loose permissions and could not be tightened; generating a new token");
        }
      }
      // Malformed token — overwrite. This shouldn't happen in practice.
    } catch {
      // fall through to regenerate
    }
  }
  const token = generateToken();
  writeTokenFile(path, token);
  return token;
}

/** Generate a new token, persist it atomically at `path`, and return it. */
export function rotateTokenFile(path: string = TOKEN_PATH): string {
  const token = generateToken();
  writeTokenFile(path, token);
  return token;
}

/**
 * Constant-time compare of two tokens. Returns false if either side is the
 * wrong length (constant-time comparison requires equal-length inputs).
 */
export function verifyToken(provided: string, expected: string): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

/**
 * The live API token for one server. It can be swapped at runtime (rotation,
 * or the token file being replaced by hand); the page served at `/` embeds
 * whatever is current, and every request is checked against it.
 *
 * When given the token file's path the state follows that file: it is stat()ed
 * on every use and re-read when it changed, so replacing the file revokes the
 * old token immediately and the CLI (which reads the file) and the server agree.
 * A deleted file is recreated with a fresh token, which also revokes. A file
 * that does not hold a valid token is ignored (the current token stays) so a
 * half-written replacement cannot lock everything out; the next change is
 * picked up.
 */
export class AuthState {
  private tokenValue: string;
  private signature: string | null;
  private complained: string | null = null;

  constructor(
    token: string,
    private readonly opts: { tokenPath?: string; onChange?: () => void } = {},
  ) {
    this.tokenValue = token;
    this.signature = this.opts.tokenPath ? fileSignature(this.opts.tokenPath) : null;
  }

  get token(): string {
    this.refresh();
    return this.tokenValue;
  }

  /** Adopt a token that was just written to the token file (rotation). */
  setToken(token: string): void {
    this.tokenValue = token;
    this.signature = this.opts.tokenPath ? fileSignature(this.opts.tokenPath) : null;
  }

  /** True when the request carries `Authorization: Bearer <current token>`. */
  authenticate(req: Request): boolean {
    const presented = extractApiToken(req);
    if (presented === null) return false;
    this.refresh();
    return verifyToken(presented, this.tokenValue);
  }

  private refresh(): void {
    const path = this.opts.tokenPath;
    if (!path) return;
    const sig = fileSignature(path);
    if (sig === this.signature) return;
    try {
      if (sig === null) {
        // Deleted: treat it as a revocation and mint a new token.
        const fresh = generateToken();
        writeTokenFile(path, fresh);
        this.tokenValue = fresh;
        this.signature = fileSignature(path);
        warn("token file was removed; generated a new token (the old one no longer works)");
        this.opts.onChange?.();
        return;
      }
      const raw = readFileSync(path, "utf8").trim();
      if (!isValidTokenShape(raw)) {
        if (this.complained !== sig) {
          this.complained = sig;
          warn("token file does not hold a 64-character hex token; keeping the current token");
        }
        return;
      }
      this.signature = sig;
      this.complained = null;
      try {
        if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
      } catch {
        // best effort
      }
      if (raw !== this.tokenValue) {
        this.tokenValue = raw;
        warn("token file changed on disk; using the new token (the old one no longer works)");
        this.opts.onChange?.();
      }
    } catch (err) {
      warn(`could not re-read the token file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Identity of the file's current contents (inode, size, mtime), or null when it is absent. */
function fileSignature(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Host / Origin allowlists
// ---------------------------------------------------------------------------

/**
 * Parse the optional `AUTO_ALLOWED_HOSTS` list (comma-separated exact `Host`
 * header values, for example a tunnel or reverse-proxy name). Entries that
 * are not a bare host[:port] are ignored with a warning.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim().toLowerCase();
    if (!entry) continue;
    if (!/^[a-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/.test(entry)) {
      warn(`ignoring AUTO_ALLOWED_HOSTS entry ${JSON.stringify(entry)} (expected host or host:port)`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

export type HostPolicy = {
  hosts: Set<string>;
  origins: Set<string>;
  /** The built-in loopback names, as opposed to operator-supplied entries. */
  loopbackHosts: Set<string>;
};

/**
 * The names the dashboard answers to by default: the IPv4 and `localhost`
 * literals (the server listens on 127.0.0.1 only, so `[::1]` is not one) plus
 * `auto.localhost`, a friendly address that needs no setup. Browsers
 * resolve every `*.localhost` name to loopback themselves (RFC 6761) and never
 * ask DNS, so `auto.localhost` cannot be rebound to another address the way an
 * ordinary name can.
 */
export function buildHostPolicy(port: number, extraHosts: readonly string[] = []): HostPolicy {
  const loopbackHosts = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `auto.localhost:${port}`,
  ]);
  const hosts = new Set<string>(loopbackHosts);
  const origins = new Set<string>([...hosts].map((h) => `http://${h}`));
  for (const h of extraHosts) {
    hosts.add(h);
    // A tunnel or proxy may terminate TLS in front of the loopback listener.
    origins.add(`http://${h}`);
    origins.add(`https://${h}`);
  }
  return { hosts, origins, loopbackHosts };
}

/** `Host` must be present and exactly one of the allowed values. */
export function hostAllowed(req: Request, policy: HostPolicy): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  return policy.hosts.has(host.toLowerCase());
}

/** A missing `Origin` is fine (CLI, curl, same-origin GET); a present one must match, for every method. */
export function originAllowed(req: Request, policy: HostPolicy): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  return policy.origins.has(origin.toLowerCase());
}

/**
 * A browser tells the server what triggered a request (`Sec-Fetch-*`, which a
 * page cannot forge or strip). A request from another site or origin that is
 * not a top-level navigation (a `<script>`, `<img>`, `<link>`, `fetch`, ...)
 * has no business here: it could only be after the token page. Clients that
 * send no such headers (CLI, curl) are unaffected.
 */
export function crossSiteSubresource(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return false;
  const mode = req.headers.get("sec-fetch-mode")?.toLowerCase();
  const dest = req.headers.get("sec-fetch-dest")?.toLowerCase();
  return !(mode === "navigate" && dest === "document");
}

/**
 * Headers that a reverse proxy or tunnel adds; a browser or the CLI talking
 * straight to loopback never sends them. Whole families are matched by prefix
 * (`X-Forwarded-*`, Cloudflare's `Cf-*`, `X-Real-*`, `Tailscale-*`, `Ngrok-*`,
 * `X-Envoy-*`) because proxies add and strip individual members freely, so
 * any one of them is proof enough.
 */
const FORWARDING_HEADER_PREFIXES = ["x-forwarded-", "x-real-", "cf-", "tailscale-", "ngrok-", "x-envoy-"];
const FORWARDING_HEADERS = new Set([
  "forwarded",
  "via",
  "cdn-loop",
  "client-ip",
  "x-client-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-original-forwarded-for",
  "x-original-forwarded-host",
]);

function looksForwarded(name: string): boolean {
  return FORWARDING_HEADERS.has(name) || FORWARDING_HEADER_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * A request that came in through a proxy or tunnel while claiming one of the
 * built-in loopback names. The dashboard page carries the API token, so a
 * tunnel that rewrites `Host` to `127.0.0.1:<port>` would otherwise hand it to
 * the whole internet. Hosts the operator listed in `AUTO_ALLOWED_HOSTS` are
 * expected to be proxied and are exempt.
 */
export function proxiedLoopbackRequest(req: Request, policy: HostPolicy): boolean {
  const host = req.headers.get("host")?.toLowerCase();
  if (!host || !policy.loopbackHosts.has(host)) return false;
  for (const name of req.headers.keys()) {
    if (looksForwarded(name.toLowerCase())) return true;
  }
  return false;
}

/**
 * Extract the token from `Authorization: Bearer <t>`. It is the only accepted
 * form: no query parameter and no custom header. Returns null when the
 * header is absent or not a Bearer credential.
 */
export function extractApiToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m && m[1] ? m[1].trim() : null;
}
