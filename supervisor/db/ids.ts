// UUID helpers: v4 for jobs, v7 (time-sortable) for runs.

export function uuidv4(): string {
  return crypto.randomUUID();
}

export function uuidv7(): string {
  // 48-bit unix-ms timestamp prefix, version=7, variant=10xx, rest random.
  const ms = BigInt(Date.now());
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  const bytes = new Uint8Array(16);
  // Timestamp: 6 bytes big-endian.
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  // 12 bits of random for rand_a, with version=7 in top nibble of byte 6.
  bytes[6] = 0x70 | (rand[0]! & 0x0f);
  bytes[7] = rand[1]!;
  // 62 bits of random for rand_b, with variant=10 in top two bits of byte 8.
  bytes[8] = 0x80 | (rand[2]! & 0x3f);
  bytes[9] = rand[3]!;
  bytes[10] = rand[4]!;
  bytes[11] = rand[5]!;
  bytes[12] = rand[6]!;
  bytes[13] = rand[7]!;
  bytes[14] = rand[8]!;
  bytes[15] = rand[9]!;

  const hex: string[] = new Array(16);
  for (let i = 0; i < 16; i++) hex[i] = bytes[i]!.toString(16).padStart(2, "0");
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

if (import.meta.main) {
  const a = uuidv7();
  const b = uuidv7();
  const c = uuidv7();
  console.log(a);
  console.log(b);
  console.log(c);
  if (!(a <= b && b <= c)) {
    console.error("uuidv7 not monotonically non-decreasing as strings");
    process.exit(1);
  }
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const id of [a, b, c]) {
    if (!re.test(id)) {
      console.error(`invalid uuidv7 shape: ${id}`);
      process.exit(1);
    }
  }
}
