// Process-level safety net: last-resort handlers for errors nothing else caught.
//
// - An unhandled rejection is logged and recorded, and the supervisor keeps
//   running: one failed write must never orphan running workers.
// - An uncaught exception leaves the process in an unknown state, so it is
//   logged and recorded, then the supervisor tears down gracefully and exits
//   non-zero so the watchdog starts a fresh one.

export type SafetyNetDeps = {
  log: (line: string) => void;
  recordError: (err: unknown) => void;
  /** Graceful teardown, then exit with `code`. */
  fatal: (code: number) => void;
  exitCode: number;
  now?: () => number;
};

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`;
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createSafetyNet(deps: SafetyNetDeps) {
  const stamp = (): string => new Date((deps.now ?? Date.now)()).toISOString();
  let fatalInProgress = false;

  const record = (err: unknown): void => {
    try {
      deps.recordError(err);
    } catch {
      // recording the error must not raise another one
    }
  };

  const onUnhandledRejection = (reason: unknown): void => {
    deps.log(`[supervisor] ${stamp()} unhandled rejection (continuing): ${describe(reason)}`);
    record(reason);
  };

  const onUncaughtException = (err: unknown): void => {
    deps.log(`[supervisor] ${stamp()} uncaught exception: ${describe(err)}`);
    record(err);
    if (fatalInProgress) return;
    fatalInProgress = true;
    deps.fatal(deps.exitCode);
  };

  return {
    onUnhandledRejection,
    onUncaughtException,
    install(): void {
      process.on("unhandledRejection", onUnhandledRejection);
      process.on("uncaughtException", onUncaughtException);
    },
  };
}
