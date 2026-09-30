// Sleep worker fixture used for timeout / cancel / overlap tests.
const ms = Number(process.env.SLEEP_MS ?? "5000");

// Default: ignore SIGTERM so the runner has to escalate to SIGKILL when a
// timeout (or cancel) expires. Set HONOR_SIGTERM=1 to opt back in to graceful
// shutdown.
if (process.env.HONOR_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.exit(0);
  });
} else {
  process.on("SIGTERM", () => {
    // Swallow. The runner has to SIGKILL after killGraceMs.
  });
}

setTimeout(() => {
  process.stdout.write("done\n");
  process.exit(0);
}, ms);
