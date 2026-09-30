// Config loader subprocess: `bun supervisor/config-loader.ts <config-path>`.
//
// Imports the user's config file and prints its default export as one JSON
// line on stdout, prefixed with CONFIG_JSON_MARKER (the config may print its
// own output; the parent reads the last marked line). Runs in a short-lived
// process for two reasons: Bun caches modules by URL and ignores a `?ts=`
// cache-buster on file URLs (an edited config would keep returning the old
// export), and it keeps the user's code out of the supervisor process.
//
// Exit codes: 0 ok, 1 the file threw while loading, 2 the export is not a
// serializable config.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_JSON_MARKER = "@@auto-config-json@@";

/** Throw on anything JSON.stringify would silently drop or distort. */
function strictReplacer(key: string, value: unknown): unknown {
  const where = key === "" ? "the export" : `"${key}"`;
  switch (typeof value) {
    case "function":
      throw new Error(`${where} is a function; config must be plain data`);
    case "symbol":
      throw new Error(`${where} is a symbol; config must be plain data`);
    case "bigint":
      throw new Error(`${where} is a bigint; config must be plain data`);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${where} is ${value}; config numbers must be finite`);
      break;
  }
  return value;
}

/** Diagnostics listed for a build failure; more than this is noise. */
const MAX_DIAGNOSTICS = 8;

/**
 * Text for an error thrown while importing the config. A Bun syntax error is
 * an AggregateError whose own message is only "N errors building <path>"; the
 * reasons and positions are on `errors`, so list them.
 */
export function describeLoadError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const list = (err as { errors?: unknown }).errors;
  if (!Array.isArray(list) || list.length === 0) return err.stack ?? err.message;
  const lines = [err.message];
  for (const item of list.slice(0, MAX_DIAGNOSTICS)) {
    const message = item instanceof Error ? item.message : String((item as { message?: unknown })?.message ?? item);
    const pos = (item as { position?: { file?: string; line?: number; column?: number; lineText?: string } | null })?.position;
    const where = pos && typeof pos.line === "number" ? `line ${pos.line}, column ${pos.column ?? 0}: ` : "";
    lines.push(`  ${where}${message}`);
    if (pos?.lineText) lines.push(`    ${pos.lineText.trim()}`);
  }
  if (list.length > MAX_DIAGNOSTICS) lines.push(`  ... and ${list.length - MAX_DIAGNOSTICS} more`);
  return lines.join("\n");
}

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) fail(2, "usage: bun supervisor/config-loader.ts <config-path>");

  let exported: unknown;
  try {
    const mod = (await import(pathToFileURL(resolve(target)).href)) as { default?: unknown };
    exported = mod.default;
  } catch (err) {
    fail(1, describeLoadError(err));
  }
  if (exported === undefined) fail(2, "config file has no default export (expected `export default [...]`)");

  let json: string;
  try {
    json = JSON.stringify(exported, strictReplacer);
  } catch (err) {
    fail(2, `config is not serializable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Exit explicitly after the flush: stray timers or handles left behind by
  // the config file must not keep this process alive.
  process.stdout.write(`\n${CONFIG_JSON_MARKER}${json}\n`, () => process.exit(0));
}

if (import.meta.main) void main();
