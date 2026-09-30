// Safe lookup of built UI files under a fixed root directory.
//
// The request path is decoded, split into segments and validated per segment
// (so a legitimate name such as `logo..v2.svg` is fine while a `..` segment is
// not), then the resolved real path must stay inside the real root. Symlinks
// that point outside the root are therefore rejected.

import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Extensions that mark a request as "for a file", so a miss is a 404, not the SPA shell. */
const FILE_EXT_RE =
  /\.(?:js|mjs|css|map|json|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|eot|txt|xml|webmanifest|wasm|pdf|zip|gz|mp3|mp4|webm)$/i;

/**
 * Client-side routes whose last segment is a name the user chose (a job named
 * `export.json` is valid), so an extension there does not make it a file.
 */
const SPA_ROUTE_PREFIXES = ["/jobs/", "/runs/"];

export function looksLikeFileRequest(pathname: string): boolean {
  if (SPA_ROUTE_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return FILE_EXT_RE.test(last);
}

/**
 * Decode `rel` (the URL path below the root, without leading slash) into safe
 * segments, or null when it contains anything that could escape or confuse
 * the file system: empty/`.`/`..` segments, backslashes, NUL/control chars.
 */
export function safeSegments(rel: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) return null;
  const segments = decoded.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null;
  }
  return segments;
}

/**
 * Resolve `rel` under `rootDir` to the real path of a regular file that is
 * contained in the real root, or null. `maxDepth` bounds how many path
 * segments are allowed (1 = root-level files only).
 */
export function resolveStaticFile(
  rootDir: string,
  rel: string,
  maxDepth = Number.POSITIVE_INFINITY,
): string | null {
  const segments = safeSegments(rel);
  if (!segments || segments.length > maxDepth) return null;
  try {
    const realRoot = realpathSync(rootDir);
    const real = realpathSync(resolve(realRoot, ...segments));
    if (!real.startsWith(realRoot + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
