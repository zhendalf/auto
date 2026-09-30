import { describe, expect, test } from "bun:test";
import { Router, errorJson, json, methodNotAllowed } from "../supervisor/api/router.ts";

const ok = (label: string) => () => json({ label });

const router = new Router([
  { method: "GET", pattern: "/api/jobs", handler: ok("jobs") },
  { method: "GET", pattern: "/api/jobs/:name", handler: ok("job") },
  { method: "POST", pattern: "/api/jobs/:name/run", handler: ok("run") },
  { method: "GET", pattern: "/api/runs/:run_id/log", handler: ok("log") },
  { method: "POST", pattern: "/api/runs/:run_id/log", handler: ok("log-post") },
  { method: "GET", pattern: "/assets/*", handler: ok("assets") },
]);

describe("Router", () => {
  test("a known path with the wrong method is method_not_allowed with a sorted Allow list", () => {
    const m = router.match("DELETE", "/api/jobs/x/run");
    expect(m).toEqual({ kind: "method_not_allowed", allowed: ["POST"] });
    const both = router.match("PUT", "/api/runs/abc/log");
    expect(both).toEqual({ kind: "method_not_allowed", allowed: ["GET", "HEAD", "POST"] });
  });

  test("an unknown path is none, regardless of method", () => {
    expect(router.match("GET", "/api/nope").kind).toBe("none");
    expect(router.match("POST", "/api/nope").kind).toBe("none");
    expect(router.match("DELETE", "/api/jobs/x/run/extra").kind).toBe("none");
  });

  test("methodNotAllowed builds a 405 with the Allow header", async () => {
    const res = methodNotAllowed(["GET", "HEAD"]);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  test("HEAD is served by the GET handler with the body dropped", async () => {
    const m = router.match("HEAD", "/api/jobs");
    expect(m.kind).toBe("match");
    if (m.kind !== "match") return;
    const url = new URL("http://localhost/api/jobs");
    const res = await m.handler(new Request(url.href, { method: "HEAD" }), m.params, url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("HEAD on a POST-only path is 405, not a silent match", () => {
    expect(router.match("HEAD", "/api/jobs/x/run")).toEqual({ kind: "method_not_allowed", allowed: ["POST"] });
  });

  test("a single trailing slash is ignored; an empty :param segment never matches", () => {
    expect(router.match("GET", "/api/jobs/").kind).toBe("match");
    expect(router.match("GET", "/api/jobs//").kind).toBe("none");
    expect(router.match("POST", "/api/jobs//run").kind).toBe("none");
    expect(router.match("GET", "/api/runs//log").kind).toBe("none");
  });

  test("params are URL-decoded and the wildcard captures the rest", () => {
    const m = router.match("GET", "/api/jobs/my%20job");
    expect(m.kind === "match" && m.params.name).toBe("my job");
    const a = router.match("GET", "/assets/a/b.js");
    expect(a.kind === "match" && a.params._rest).toBe("a/b.js");
    // Malformed escapes do not throw.
    expect(router.match("GET", "/api/jobs/%E0%A4%A").kind).toBe("match");
  });

  test("errorJson keeps a consistent shape and passes extra headers through", async () => {
    const res = errorJson(416, "offset_out_of_range", { size: 3 }, { "x-log-size": "3" });
    expect(res.status).toBe(416);
    expect(res.headers.get("x-log-size")).toBe("3");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "offset_out_of_range", size: 3 });
  });
});
