await new Response(Bun.stdin.stream()).json();
process.stdout.write(JSON.stringify({ fire: true, state: { cursor: "message-42" }, meta: { transition_id: "message-42" } }));
