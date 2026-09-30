const input = await new Response(Bun.stdin.stream()).json() as { previousState?: { checks?: number } };
process.stdout.write(JSON.stringify({ fire: false, state: { checks: (input.previousState?.checks ?? 0) + 1 } }));
