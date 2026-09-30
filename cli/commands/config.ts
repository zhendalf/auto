// `auto config check | status | reload | edit`.

import { existsSync } from "node:fs";
import { ApiError, type ConfigWarning } from "../client.ts";
import { checkConfigOffline } from "../config-file.ts";
import {
  CONFIG_PATH,
  EX,
  ask,
  fmtTime,
  getApiClient,
  globals,
  isStdinTty,
  plural,
  printJson,
  println,
  requireSupervisor,
  status,
  writeErr,
  writeOut,
} from "../runtime.ts";

function printWarnings(warnings: ConfigWarning[] | undefined): void {
  for (const w of warnings ?? []) status(`warning: ${w.message}`);
}

export async function runConfigStatus(): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  const s = await client.configStatus();
  // Exit 1 when the supervisor is degraded or its last config edit was
  // rejected, so a script can tell (like `config check` and `doctor` do).
  const code = s.ok && !s.degraded.active ? EX.OK : EX.ERR;
  if (globals().json) {
    printJson(s);
    return code;
  }

  const loadedAt = s.loadedAt ? fmtTime(s.loadedAt) : "-";
  if (s.degraded.active) {
    println(`CONFIG       error`);
    const reason = s.degraded.reason
      ? `${s.degraded.reason.kind}: ${s.degraded.reason.message}`
      : "unknown";
    println(`DEGRADED     yes  ${reason}`);
    println(`JOBS         ${s.jobs}`);
    println(`TRIGGERS     ${s.triggers}`);
    println(`LAST ERROR   ${s.lastError ? s.lastError.message : "-"}`);
    printWarnings(s.warnings);
    return code;
  }
  println(`CONFIG       ${s.ok ? "ok" : "error"}  (loaded ${loadedAt})`);
  println(`DEGRADED     no`);
  println(`JOBS         ${s.jobs}`);
  println(`TRIGGERS     ${s.triggers}`);
  println(`LAST ERROR   ${s.lastError ? s.lastError.message : "-"}`);
  printWarnings(s.warnings);
  return code;
}

export async function runConfigReload(): Promise<number> {
  const client = getApiClient();
  await requireSupervisor(client);

  try {
    const r = await client.configReload();
    if (globals().json) {
      printJson(r);
    } else {
      const c = r.changes;
      const delta =
        c && c.added.length + c.removed.length + c.changed.length > 0
          ? `; added ${c.added.length}, removed ${c.removed.length}, changed ${c.changed.length}`
          : "";
      status(`reloaded: ${plural(r.jobs, "job")}, ${plural(r.triggers, "trigger")}${delta}`);
      printWarnings(r.warnings);
    }
    return EX.OK;
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const body = err.body as { details?: string } | null;
      status(`config invalid; the previous version keeps running:\n${body?.details ?? "(no details)"}`);
      return EX.ERR;
    }
    throw err;
  }
}

/** Validate the config without a supervisor. Says to run `auto init` when there is no workspace yet. */
export async function runConfigCheck(): Promise<number> {
  if (!existsSync(CONFIG_PATH)) {
    if (globals().json) printJson({ ok: false, error: "config_missing", path: CONFIG_PATH });
    status(`no config found at ${CONFIG_PATH}`);
    status("run `auto init` to create a workspace with a starter job");
    return EX.ERR;
  }
  const r = await checkConfigOffline();
  const summary = parseCheckSummary(r.stdout);
  if (globals().json) {
    printJson({
      ok: r.code === 0,
      jobs: summary?.jobs ?? null,
      triggers: summary?.triggers ?? null,
      migrations_pending: summary?.migrationsPending ?? null,
      // Warnings and errors, one per line, as the checker reported them.
      messages: r.stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
      // Kept for older consumers: the checker's raw output.
      output: r.stdout.trim(),
      errors: r.stderr.trim(),
    });
  } else {
    if (summary) println(`config valid: ${plural(summary.jobs, "job")}, ${plural(summary.triggers, "trigger")}`);
    else writeOut(r.stdout);
    writeErr(r.stderr);
  }
  return r.code === 0 ? EX.OK : EX.ERR;
}

/** Pick the counts out of the supervisor's `--check` line (`OK config=valid jobs=N triggers=M migrations_pending=K ...`). */
export function parseCheckSummary(stdout: string): { jobs: number; triggers: number; migrationsPending: number } | null {
  const m = /config=valid jobs=(\d+) triggers=(\d+) migrations_pending=(\d+)/.exec(stdout);
  return m ? { jobs: Number(m[1]), triggers: Number(m[2]), migrationsPending: Number(m[3]) } : null;
}

/**
 * Split `$VISUAL`/`$EDITOR` ("code --wait") into a command and its arguments.
 * Shell-style quoting is understood ("'/Applications/Visual Studio Code.app/.../code' --wait",
 * or backslash-escaped spaces), and an unquoted leading path with spaces is
 * recognized when that file exists ("/Applications/Visual Studio Code.app/.../code --wait").
 */
export function editorCommand(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const raw = (env.VISUAL || env.EDITOR || "vi").trim();
  if (raw.includes(" ") && !/^['"\\]/.test(raw)) {
    const words = raw.split(/ +/);
    for (let k = words.length; k >= 2; k--) {
      const candidate = words.slice(0, k).join(" ");
      if (exists(candidate)) return [candidate, ...words.slice(k)];
    }
  }
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < raw.length) current += raw[++i]!;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < raw.length) {
      current += raw[++i]!;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) parts.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current) parts.push(current);
  return parts.length > 0 ? parts : ["vi"];
}

/** Run the editor. Null when it could not be started (already reported). */
async function edit(editor: string[]): Promise<number | null> {
  let child;
  try {
    child = Bun.spawn([...editor, CONFIG_PATH], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    status(`could not start the editor '${editor[0]}' (from $VISUAL or $EDITOR); set one that exists, for example EDITOR="code --wait"`);
    return null;
  }
  return await child.exited;
}

export async function runConfigEdit(): Promise<number> {
  if (!existsSync(CONFIG_PATH)) {
    status(`no config found at ${CONFIG_PATH}; run \`auto init\` first`);
    return EX.ERR;
  }

  const editor = editorCommand();
  const interactive = !globals().yes && isStdinTty();
  let code = await edit(editor);
  if (code === null) return EX.ERR;
  if (code !== 0) {
    status(`editor exited with code ${code}; config not checked`);
    return EX.ERR;
  }

  // Check offline first: it works whether or not the supervisor is running.
  for (;;) {
    const check = await checkConfigOffline();
    if (check.code === 0) break;
    writeErr(check.stderr);
    if (!interactive) return EX.ERR;
    const again = await reEditPrompt();
    if (!again) return EX.ERR;
    code = await edit(editor);
    if (code !== 0) return EX.ERR; // null (editor missing) was reported by edit()
  }

  const client = getApiClient();
  if (!(await client.reachable())) {
    status("saved and valid; the supervisor is not running, so it will load this when it starts (`auto install`)");
    return EX.OK;
  }
  return await runConfigReload();
}

async function reEditPrompt(): Promise<boolean> {
  const r = await ask<{ value?: boolean }>({
    type: "confirm",
    name: "value",
    message: "edit again?",
    initial: true,
  });
  return Boolean(r.value);
}
