// `auto secret list | set | remove` — the named secrets webhook triggers sign with.
//
// Secrets live in <data dir>/secrets.json (mode 0600), which the supervisor
// re-reads whenever the file changes. Values are never printed.
//
// Every change is a read-modify-write, so it runs under an exclusive lock
// file (created with O_EXCL) and publishes the new file with write-to-temp,
// fsync and rename: two `auto secret set` commands running at once both
// persist, and a reader never sees a half-written file.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR, EX, ask, globals, isStdinTty, printJson, println, status } from "../runtime.ts";

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** The supervisor only redacts secret values of at least this many characters from run logs. */
const MIN_REDACTED_LENGTH = 4;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 20;

type SecretFile = { version: 1; secrets: Record<string, string> };

function secretsPath(): string {
  return resolve(DATA_DIR, "secrets.json");
}

/** A problem with the secrets file the user has to resolve; the message says how. */
export class SecretsFileError extends Error {}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > LOCK_STALE_MS) return true;
    const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 && !isAlive(pid);
  } catch {
    // gone already, or unreadable: let the caller retry the exclusive create
    return false;
  }
}

/** Run `fn` while holding the secrets lock. Exported for tests. */
export function withSecretsLock<T>(fn: () => T, path: string = secretsPath()): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // someone else removed it first
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new SecretsFileError(
          `another \`auto secret\` command has held ${lockPath} for over ${LOCK_WAIT_MS / 1000}s; ` +
            "if none is running, delete that file and retry",
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

/** Read and validate the secrets file. A missing file is an empty store; a damaged one is an error, never overwritten. */
export function readSecrets(path: string = secretsPath()): SecretFile {
  if (!existsSync(path)) return { version: 1, secrets: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The parser's message can quote the offending token, and here that is a
    // secret value, so it is deliberately not repeated.
    throw new SecretsFileError(`${path} is not valid JSON; fix or remove it by hand. Nothing was changed`);
  }
  const value = parsed as Partial<SecretFile> | null;
  const ok =
    value !== null &&
    typeof value === "object" &&
    value.version === 1 &&
    value.secrets !== null &&
    typeof value.secrets === "object" &&
    !Array.isArray(value.secrets) &&
    Object.values(value.secrets).every((v) => typeof v === "string");
  if (!ok) {
    throw new SecretsFileError(
      `${path} does not look like an Auto secrets file (expected {"version":1,"secrets":{...}}); nothing was changed`,
    );
  }
  return { version: 1, secrets: { ...(value as SecretFile).secrets } };
}

/** Note (and repair, when we are about to rewrite the file anyway) a secrets file readable by others. */
function checkMode(path: string, repair: boolean): void {
  if (!existsSync(path) || process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) === 0) return;
  const octal = mode.toString(8).padStart(3, "0");
  if (repair) {
    chmodSync(path, 0o600);
    status(`warning: ${path} was mode ${octal}; tightened to 600`);
  } else {
    status(`warning: ${path} is mode ${octal}, readable by other users; the supervisor ignores it until it is 600 (chmod 600 it)`);
  }
}

/** Publish `value` as the secrets file: private temp file, fsync, rename, fsync of the directory. */
export function writeSecrets(value: SecretFile, path: string = secretsPath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // ignore
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // ignore
    }
    throw err;
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // directory fsync is best effort
    }
  }
}

export async function runSecretList(): Promise<number> {
  const path = secretsPath();
  try {
    checkMode(path, false);
    const names = Object.keys(readSecrets(path).secrets).sort();
    if (globals().json) printJson({ secrets: names });
    else if (names.length === 0) status("no secrets set; add one with `auto secret set <name>`");
    else names.forEach((name) => println(name));
    return EX.OK;
  } catch (err) {
    if (err instanceof SecretsFileError) {
      status(err.message);
      return EX.ERR;
    }
    throw err;
  }
}

async function readValue(name: string, forceStdin: boolean): Promise<string> {
  if (forceStdin || !isStdinTty()) {
    // One trailing newline is the shell's, not part of the secret.
    return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  }
  const answer = await ask<{ value?: string }>({ type: "password", name: "value", message: `value for ${name}` });
  return answer.value ?? "";
}

export async function runSecretSet(name: string, opts: { stdin?: boolean } = {}): Promise<number> {
  if (!SECRET_NAME_RE.test(name)) {
    status("secret name must be lowercase letters, numbers and hyphens, starting with a letter or number");
    return EX.USAGE;
  }
  const value = await readValue(name, Boolean(opts.stdin));
  if (!value) {
    status("secret value is empty; not saved");
    return EX.ERR;
  }
  const path = secretsPath();
  try {
    const existed = withSecretsLock(() => {
      checkMode(path, true);
      const file = readSecrets(path);
      const had = name in file.secrets;
      file.secrets[name] = value;
      writeSecrets(file, path);
      return had;
    }, path);
    status(`secret ${name} ${existed ? "updated" : "saved"}; the supervisor picks it up on the next request`);
    if (value.length < MIN_REDACTED_LENGTH) {
      status(`warning: values shorter than ${MIN_REDACTED_LENGTH} characters are not hidden in run logs`);
    }
    if (globals().json) printJson({ ok: true, name, updated: existed });
    return EX.OK;
  } catch (err) {
    if (err instanceof SecretsFileError) {
      status(err.message);
      return EX.ERR;
    }
    throw err;
  }
}

export async function runSecretRemove(name: string): Promise<number> {
  const path = secretsPath();
  try {
    const removed = withSecretsLock(() => {
      checkMode(path, true);
      const file = readSecrets(path);
      if (!(name in file.secrets)) return false;
      delete file.secrets[name];
      writeSecrets(file, path);
      return true;
    }, path);
    if (!removed) {
      status(`secret ${name} not found (see \`auto secret list\`)`);
      return EX.ERR;
    }
    status(`secret ${name} removed`);
    if (globals().json) printJson({ ok: true, name });
    return EX.OK;
  } catch (err) {
    if (err instanceof SecretsFileError) {
      status(err.message);
      return EX.ERR;
    }
    throw err;
  }
}
