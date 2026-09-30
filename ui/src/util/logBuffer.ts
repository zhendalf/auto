import { INITIAL_ANSI_STATE, parseAnsi, type AnsiSegment, type AnsiState } from "./ansi.ts";

export type LogLine = {
  /** Increases for every line ever appended, so it is a stable React key even after old lines are dropped. */
  no: number;
  segments: AnsiSegment[];
  /** The line without escape sequences (for copy). */
  text: string;
};

/**
 * Turns streamed log text into parsed lines with a size cap. Text arrives in
 * arbitrary chunks (the log is followed with byte offsets), so the last,
 * unterminated line is held back until its newline arrives, and ANSI state
 * carries from one line to the next. Once the kept text exceeds `maxChars`
 * the oldest lines are dropped and counted in `dropped`.
 */
export class LogBuffer {
  lines: LogLine[] = [];
  /** How many lines were dropped from the head to stay under the cap. */
  dropped = 0;
  private nextNo = 0;
  private chars = 0;
  private raw = "";
  private state: AnsiState = INITIAL_ANSI_STATE;

  constructor(private readonly maxChars: number) {}

  /** Append decoded text. Returns nothing; read `lines` and `partial()`. */
  append(text: string): void {
    if (!text) return;
    const data = this.raw + text;
    const parts = data.split("\n");
    this.raw = parts.pop() ?? "";
    for (const part of parts) this.pushLine(part);
    this.trim();
  }

  /** The unterminated last line, parsed for display, or null when there is none. */
  partial(): AnsiSegment[] | null {
    if (!this.raw) return null;
    const { segments } = parseAnsi(overwriteCarriageReturns(this.raw), this.state);
    return segments.length > 0 ? segments : null;
  }

  /** All kept text, plain, for the Copy button. */
  plainText(): string {
    const tail = this.partial()?.map((s) => s.text).join("") ?? "";
    const body = this.lines.map((l) => l.text).join("\n");
    return tail ? (body ? `${body}\n${tail}` : tail) : body;
  }

  get isEmpty(): boolean {
    return this.lines.length === 0 && this.raw === "";
  }

  clear(): void {
    this.lines = [];
    this.dropped = 0;
    this.chars = 0;
    this.raw = "";
    this.state = INITIAL_ANSI_STATE;
  }

  private pushLine(rawLine: string): void {
    const { segments, state } = parseAnsi(overwriteCarriageReturns(rawLine), this.state);
    this.state = state;
    const text = segments.map((s) => s.text).join("");
    this.lines.push({ no: this.nextNo++, segments, text });
    this.chars += text.length + 1;
  }

  private trim(): void {
    let cut = 0;
    while (this.chars > this.maxChars && this.lines.length - cut > 1) {
      this.chars -= this.lines[cut]!.text.length + 1;
      cut += 1;
    }
    if (cut > 0) {
      this.lines = this.lines.slice(cut);
      this.dropped += cut;
    }
  }
}

/**
 * A carriage return without a line feed rewinds the cursor (progress bars
 * redraw one line that way). Keep what would be visible at the end: the text
 * after the last "\r", or the last non-empty redraw. A trailing "\r" (from
 * CRLF) is just removed.
 */
export function overwriteCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const pieces = line.split("\r");
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (pieces[i]) return pieces[i]!;
  }
  return "";
}
