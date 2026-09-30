import type { z } from "zod";
import type { ConfigSchema } from "./supervisor/config.ts";

/**
 * What a config file is written as: fields that have defaults (reentrancy,
 * queueDepth, timeoutMs, killGraceMs, enabled, webhook limits, ...) are
 * optional. The supervisor validates the file and fills the defaults in.
 */
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Type-check an Auto configuration without changing it at runtime. */
export function defineConfig(config: ConfigInput): ConfigInput {
  return config;
}

export type {
  Automation,
  Config,
  CronTrigger,
  Trigger,
  WebhookTrigger,
} from "./supervisor/config.ts";
