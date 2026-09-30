import { describe, expect, test } from "bun:test";
import { INITIAL_ANSI_STATE, parseAnsi, stripAnsi } from "../ui/src/util/ansi.ts";
import { LogBuffer, overwriteCarriageReturns } from "../ui/src/util/logBuffer.ts";

describe("parseAnsi", () => {
  test("plain text is one default segment", () => {
    const { segments } = parseAnsi("hello");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ text: "hello", fg: null, bold: false });
  });

  test("basic colors, bold and reset", () => {
    const { segments } = parseAnsi("\x1b[31mred\x1b[0m plain \x1b[1;32mbold green\x1b[0m");
    expect(segments.map((s) => s.text)).toEqual(["red", " plain ", "bold green"]);
    expect(segments[0]).toMatchObject({ fg: 1 });
    expect(segments[1]).toMatchObject({ fg: null, bold: false });
    expect(segments[2]).toMatchObject({ fg: 2, bold: true });
  });

  test("bright colors, backgrounds, underline, italic, dim", () => {
    const { segments } = parseAnsi("\x1b[93;44;3;4;2mx\x1b[22;23;24;39;49my");
    expect(segments[0]).toMatchObject({ fg: 11, bg: 4, italic: true, underline: true, dim: true });
    expect(segments[1]).toMatchObject({ fg: null, bg: null, italic: false, underline: false, dim: false });
  });

  test("an empty parameter list is a reset", () => {
    const { segments } = parseAnsi("\x1b[31ma\x1b[mb");
    expect(segments[1]).toMatchObject({ text: "b", fg: null });
  });

  test("256-color palette: first sixteen render, the rest are consumed", () => {
    const low = parseAnsi("\x1b[38;5;9mx");
    expect(low.segments[0]).toMatchObject({ fg: 9 });
    const high = parseAnsi("\x1b[38;5;200mx\x1b[1my");
    expect(high.segments[0]).toMatchObject({ text: "x", fg: null });
    expect(high.segments[1]).toMatchObject({ text: "y", bold: true });
  });

  test("true color is consumed without leaking its parameters into other codes", () => {
    const { segments } = parseAnsi("\x1b[38;2;255;0;0;1mx");
    expect(segments[0]).toMatchObject({ text: "x", fg: null, bold: true });
  });

  test("state carries across calls", () => {
    const a = parseAnsi("\x1b[31mone", INITIAL_ANSI_STATE);
    const b = parseAnsi("two", a.state);
    expect(b.segments[0]).toMatchObject({ text: "two", fg: 1 });
  });

  test("other escape sequences and control characters are stripped", () => {
    const text = "a\x1b[2Kb\x1b[1;1Hc\x1b]0;window title\x07d\x1b(Be\x00f\x07g\x1b[?25lh";
    expect(stripAnsi(text)).toBe("abcdefgh");
  });

  test("an escape cut off at the end of the text is dropped", () => {
    expect(stripAnsi("done\x1b[3")).toBe("done");
    expect(stripAnsi("done\x1b")).toBe("done");
  });

  test("markup stays text: nothing is interpreted as HTML", () => {
    const { segments } = parseAnsi('<img src=x onerror="alert(1)">\x1b[31m<b>');
    expect(segments.map((s) => s.text).join("")).toBe('<img src=x onerror="alert(1)"><b>');
  });

  test("tabs survive", () => {
    expect(stripAnsi("a\tb")).toBe("a\tb");
  });
});

describe("LogBuffer", () => {
  test("holds back the unterminated last line until its newline arrives", () => {
    const b = new LogBuffer(1_000_000);
    b.append("one\ntw");
    expect(b.lines.map((l) => l.text)).toEqual(["one"]);
    expect(b.partial()?.map((s) => s.text).join("")).toBe("tw");
    b.append("o\nthree");
    expect(b.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(b.plainText()).toBe("one\ntwo\nthree");
  });

  test("colors carry across lines", () => {
    const b = new LogBuffer(1_000_000);
    b.append("\x1b[32mgreen\nstill green\x1b[0m\nplain\n");
    expect(b.lines[1]!.segments[0]).toMatchObject({ text: "still green", fg: 2 });
    expect(b.lines[2]!.segments[0]).toMatchObject({ text: "plain", fg: null });
  });

  test("CRLF and progress-bar redraws keep what is visible", () => {
    const b = new LogBuffer(1_000_000);
    b.append("line\r\n10%\r50%\r100%\ndone\n");
    expect(b.lines.map((l) => l.text)).toEqual(["line", "100%", "done"]);
    expect(overwriteCarriageReturns("a\r")).toBe("a");
    expect(overwriteCarriageReturns("\r\r")).toBe("");
  });

  test("drops the oldest lines past the cap and counts them", () => {
    const b = new LogBuffer(50);
    for (let i = 0; i < 20; i++) b.append(`line number ${i}\n`);
    expect(b.dropped).toBeGreaterThan(0);
    expect(b.lines.at(-1)!.text).toBe("line number 19");
    expect(b.dropped + b.lines.length).toBe(20);
  });

  test("line numbers are stable keys across trimming", () => {
    const b = new LogBuffer(30);
    b.append("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndddddddddd\n");
    const nos = b.lines.map((l) => l.no);
    expect(nos).toEqual([...nos].sort((x, y) => x - y));
    expect(b.lines.at(-1)!.no).toBe(3);
  });

  test("an empty buffer reports so, and clear resets it", () => {
    const b = new LogBuffer(100);
    expect(b.isEmpty).toBe(true);
    b.append("x");
    expect(b.isEmpty).toBe(false);
    b.clear();
    expect(b.isEmpty).toBe(true);
    expect(b.plainText()).toBe("");
  });
});
