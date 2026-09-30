import { describe, expect, test } from "bun:test";
import { NOT_SERVED_MESSAGE, parseBootstrap } from "../ui/src/util/bootstrap.ts";

describe("parseBootstrap", () => {
  test("reads the token and port from the tag", () => {
    expect(parseBootstrap('{"token":"abc123","port":7777}')).toEqual({ token: "abc123", port: 7777 });
  });

  test("a missing port is tolerated", () => {
    expect(parseBootstrap('{"token":"abc"}')).toEqual({ token: "abc", port: 0 });
  });

  test("surrounding whitespace in the token is trimmed", () => {
    expect(parseBootstrap('{"token":"  abc \\n","port":1}')?.token).toBe("abc");
  });

  test("a missing tag (null or undefined text) is null, not a throw", () => {
    expect(parseBootstrap(null)).toBeNull();
    expect(parseBootstrap(undefined)).toBeNull();
    expect(parseBootstrap("")).toBeNull();
  });

  test("no token, an empty token or a non-string token is null", () => {
    expect(parseBootstrap('{"port":7777}')).toBeNull();
    expect(parseBootstrap('{"token":"","port":7777}')).toBeNull();
    expect(parseBootstrap('{"token":"   "}')).toBeNull();
    expect(parseBootstrap('{"token":123}')).toBeNull();
    expect(parseBootstrap('{"token":null}')).toBeNull();
  });

  test("malformed or non-object JSON is null", () => {
    expect(parseBootstrap("{not json")).toBeNull();
    expect(parseBootstrap("null")).toBeNull();
    expect(parseBootstrap('"abc"')).toBeNull();
    expect(parseBootstrap("[1,2]")).toBeNull();
  });

  test("the not-served message is the one the owner asked for", () => {
    expect(NOT_SERVED_MESSAGE).toBe(
      "This page was not served by the Auto supervisor. Open the dashboard with: auto ui",
    );
  });
});
