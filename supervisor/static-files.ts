// Which request paths name a file. A miss on one of those is a 404, never the
// SPA shell, so a browser probing /favicon.ico is not handed HTML.

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
