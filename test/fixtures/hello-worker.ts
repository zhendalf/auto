// Hello-world worker fixture for runner tests.
process.stdout.write(`hello from RUN_ID=${process.env.RUN_ID ?? ""}\n`);
process.exit(0);
