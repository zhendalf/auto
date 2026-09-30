import type { ReactNode } from "react";

export type Tone = "ok" | "bad" | "warn" | "orange" | "info" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok-fg",
  bad: "bg-bad-bg text-bad-fg",
  warn: "bg-warn-bg text-warn-fg",
  orange: "bg-orange-bg text-orange-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-neutral-bg text-neutral-fg",
};

/** A small status pill. `live` adds a pulsing dot (decorative; the text carries the meaning). */
export function Chip({
  tone,
  children,
  live,
  title,
  upper,
}: {
  tone: Tone;
  children: ReactNode;
  live?: boolean;
  title?: string;
  upper?: boolean;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${
        upper ? "uppercase tracking-tight" : ""
      } ${TONE_CLASS[tone]}`}
    >
      {live && <span aria-hidden="true" className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
