import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "../cli/client.ts";
import { fakeRunId, startFakeApi, type Fake } from "./cli-fake-api.ts";

let fake: Fake;
let client: ApiClient;
const RUN = fakeRunId("cafe0001");

beforeEach(() => {
  fake = startFakeApi();
  client = new ApiClient({ baseUrl: fake.baseUrl, tokenFile: fake.tokenFile });
});
afterEach(async () => {
  await fake.stop();
});

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("ApiClient.runLogFrom", () => {
  test("returns the bytes from the offset, the total size and the run state", async () => {
    fake.runs.set(RUN, { run_id: RUN, job_name: "j", state: "running", log: "hello\nworld\n" });
    const first = await client.runLogFrom(RUN, 0);
    expect(decode(first.bytes)).toBe("hello\nworld\n");
    expect(first).toMatchObject({ size: 12, state: "running", missing: false, outOfRange: false });
    const rest = await client.runLogFrom(RUN, 6);
    expect(decode(rest.bytes)).toBe("world\n");
    const end = await client.runLogFrom(RUN, 12);
    expect(end.bytes.length).toBe(0);
    expect(end.size).toBe(12);
  });

  test("counts bytes, not characters", async () => {
    fake.runs.set(RUN, { run_id: RUN, job_name: "j", state: "running", log: "é✓\n" });
    const r = await client.runLogFrom(RUN, 0);
    expect(r.size).toBe(6);
    expect((await client.runLogFrom(RUN, 2)).bytes.length).toBe(4);
  });

  test("a run without a log yet is reported as missing, with its state, not thrown", async () => {
    fake.runs.set(RUN, { run_id: RUN, job_name: "j", state: "queued", log: null });
    const r = await client.runLogFrom(RUN, 0);
    expect(r).toMatchObject({ missing: true, state: "queued", size: 0 });
  });

  test("an offset past the end is reported as out of range, with the real size", async () => {
    fake.runs.set(RUN, { run_id: RUN, job_name: "j", state: "running", log: "abc" });
    const r = await client.runLogFrom(RUN, 99);
    expect(r).toMatchObject({ outOfRange: true, size: 3 });
  });

  test("an unknown run is still an error", async () => {
    await expect(client.runLogFrom("deadbeef", 0)).rejects.toBeInstanceOf(ApiError);
  });
});
