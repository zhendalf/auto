// Worker fixture that runs until it is killed. It ignores SIGTERM so a
// supervisor that stops it has to escalate to SIGKILL. Unlike sleep-worker.ts
// it needs no environment (the runner does not pass the supervisor's env on).
process.on("SIGTERM", () => {});
process.stdout.write("hang-worker started\n");
setInterval(() => {}, 1_000);
