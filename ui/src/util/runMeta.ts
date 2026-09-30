import { formatBytes, formatTime } from "./format.ts";

export type MetaEntry = { label: string; value: string; mono: boolean };

const LABELS: Record<string, string> = {
  reason: "Reason",
  delivery_id: "Webhook delivery id",
  receipt_id: "Webhook receipt",
  fire_at: "Scheduled for",
  received_at: "Received at",
  body_digest: "Body digest",
  content_type: "Content type",
  byte_count: "Payload size",
  condition: "Condition",
};

// Internals of the payload format that mean nothing to a person.
const HIDDEN = new Set(["version"]);

function valueText(key: string, value: unknown, timeZone?: string): { text: string; mono: boolean } {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (key.endsWith("_at")) return { text: formatTime(value, { timeZone }), mono: false };
    if (key === "byte_count") return { text: formatBytes(value), mono: false };
    return { text: String(value), mono: true };
  }
  if (typeof value === "string") {
    return { text: value, mono: key !== "reason" && key !== "content_type" };
  }
  if (typeof value === "boolean") return { text: value ? "yes" : "no", mono: false };
  return { text: JSON.stringify(value), mono: true };
}

/**
 * What triggered a run, as label/value pairs, from the run's `trigger_meta`
 * (a manual run's reason, a webhook's delivery id, a cron fire time, ...).
 * Unknown keys are kept under their own name; empty values are dropped.
 */
export function metaEntries(meta: unknown, opts: { timeZone?: string } = {}): MetaEntry[] {
  if (meta == null) return [];
  if (typeof meta === "string") return meta ? [{ label: "Details", value: meta, mono: false }] : [];
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return [{ label: "Details", value: JSON.stringify(meta), mono: true }];
  }
  const out: MetaEntry[] = [];
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (HIDDEN.has(key) || value === null || value === undefined || value === "") continue;
    const { text, mono } = valueText(key, value, opts.timeZone);
    out.push({ label: LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), value: text, mono });
  }
  return out;
}
