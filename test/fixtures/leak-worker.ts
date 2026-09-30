// Leak fixture: prints a "secret" injected via env so the test can verify
// the runner redacts it before writing to the log file.
process.stdout.write(`leak: ${process.env.SECRET_VALUE ?? ""}\n`);
process.exit(0);
