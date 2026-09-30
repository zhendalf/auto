import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "./db/connection.ts";
import type { Secret } from "./log-capture.ts";

const SecretsSchema = z.object({
  version: z.literal(1),
  secrets: z.record(z.string(), z.string().min(1)),
});

/** Identity of the file contents we last parsed. `null` means "no file". */
type Signature = string | null;

/**
 * Secrets loaded from `<DATA_DIR>/secrets.json` (mode 0600).
 *
 * The parsed values are cached against the file's identity (inode, size,
 * mtime), so `load()` is a cheap `stat` when nothing changed. `get()` and
 * `redactionValues()` re-check the file on every call: a secret added with
 * the CLI is picked up (and redacted from run logs) without a restart or a
 * webhook arriving first. A file that fails validation is remembered by its
 * identity too, so a hand-edited, half-typed `secrets.json` costs one read
 * until it changes instead of one per log chunk or webhook request. The CLI
 * writes the file with an atomic rename, so no retry is needed.
 */
export class SecretStore {
  readonly path: string;
  private values = new Map<string, string>();
  private signature: Signature | undefined;
  /** Identity of a file that failed validation; it is not read again until it changes. */
  private badSignature: string | undefined;

  constructor(path = resolve(DATA_DIR, "secrets.json")) {
    this.path = path;
  }

  /**
   * (Re)load if the file changed since the last successful load. Throws when
   * the file is unreadable, has group/other permission bits, or is not a valid
   * secrets document; the previously loaded values are kept in that case so a
   * half-written file can never drop redaction.
   */
  load(): void {
    if (!existsSync(this.path)) {
      this.values.clear();
      this.signature = null;
      this.badSignature = undefined;
      return;
    }
    const st = statSync(this.path);
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`secrets file must be mode 0600: ${this.path}`);
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (sig === this.signature) return;
    if (sig === this.badSignature) throw new Error(invalidMessage(this.path));
    let parsed: Record<string, string>;
    try {
      parsed = SecretsSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).secrets;
    } catch {
      this.badSignature = sig;
      // The parser's own message can quote the offending token, which in this
      // file is a secret value: report only that the file is bad.
      throw new Error(invalidMessage(this.path));
    }
    this.badSignature = undefined;
    this.values = new Map(Object.entries(parsed));
    this.signature = sig;
  }

  get(name: string): string | null {
    this.refresh();
    return this.values.get(name) ?? null;
  }

  /** Current secrets for log redaction. Never throws; falls back to the last good values. */
  redactionValues(): Secret[] {
    this.refresh();
    return [...this.values.entries()].map(([name, value]) => ({ name, value }));
  }

  private refresh(): void {
    try {
      this.load();
    } catch {
      // Keep whatever was loaded last: redacting with stale values is better
      // than redacting with none.
    }
  }
}

function invalidMessage(path: string): string {
  return `secrets file is not valid JSON of the form {"version":1,"secrets":{...}}: ${path}`;
}
