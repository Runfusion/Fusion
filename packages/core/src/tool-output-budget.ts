import { createLogger } from "./logger.js";

/*
FNXC:EngineDiagnostics 2026-07-30-04:00:
FN-8603 requires production diagnostics to route through the shared logger rather than bare console
output, so every line carries the shared severity marker and subsystem prefix. This file had a bare
`console.warn` on the invalid-override path, which `log-severity-spam-contract` flags as a contract
violation.

Kept at `warn`, NOT demoted: an invalid operator-supplied budget is a real misconfiguration, not
routine chatter. Note this path is therefore not FUSION_DEBUG-gated — only `debug` is — so what the
shared logger adds here is the marker and prefix, not suppression.
*/
const log = createLogger("tool-output-budget");

/** Default maximum model-visible characters in one engine-injected tool result. */
export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 16_000;

/** Explicit `agentToolOutputMaxChars` value that disables the shared output wrapper. */
export const TOOL_OUTPUT_UNLIMITED_SETTING_VALUE = 0;

const DEFAULT_TRUNCATION_HINT = "narrow your query or use limit/offset for more";

/**
 * FNXC:ToolOutputBudget 2026-07-30-12:00:
 * FN-8614 bounds the total text returned by each engine-injected tool result so a
 * large log, document, or JSON response cannot consume an agent's context window.
 * 16,000 characters remains the default while operators can use
 * `agentToolOutputMaxChars` to select a positive cap or the explicit no-limit value.
 *
 * FNXC:ToolOutputBudget 2026-07-30-16:00:
 * FN-8616 requires an operator-controlled opt-out without making an unset or invalid
 * value unbounded. Only the `0` setting sentinel disables this shared wrapper.
 */
export function buildToolOutputTruncationMarker(hint = DEFAULT_TRUNCATION_HINT): string {
  return `\n[Tool output truncated to fit the context budget; ${hint}.]`;
}

function normalizeMaxChars(maxChars: number | undefined): number {
  const candidate = maxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS;
  if (!Number.isFinite(candidate)) return DEFAULT_TOOL_OUTPUT_MAX_CHARS;
  return Math.max(1, Math.floor(candidate));
}

/** Clamp one text result, reserving the canonical truncation marker inside its cap. */
export function clampToolOutputText(
  text: string,
  opts: { maxChars?: number; hint?: string } = {},
): string {
  const maxChars = normalizeMaxChars(opts.maxChars);
  if (text.length <= maxChars) return text;

  const marker = buildToolOutputTruncationMarker(opts.hint);
  // A re-clamp at the same or a larger budget must not add a second marker.
  if (text.endsWith(marker)) return text.slice(0, maxChars);
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return text.slice(0, maxChars - marker.length) + marker;
}

/**
 * Clamp all text blocks in one result as a single budget, allocating retained text
 * in document order. Non-text blocks are deliberately handled by the engine wrapper.
 */
export function clampToolOutputBlocks(
  texts: readonly (string | undefined)[],
  opts: { maxChars?: number; hint?: string } = {},
): string[] {
  const normalized = texts.map((text) => typeof text === "string" ? text : "");
  const maxChars = normalizeMaxChars(opts.maxChars);
  const total = normalized.reduce((sum, text) => sum + text.length, 0);
  if (total <= maxChars) return normalized;

  const marker = buildToolOutputTruncationMarker(opts.hint);
  const joined = normalized.join("");
  if (joined.endsWith(marker)) {
    let remaining = maxChars;
    return normalized.map((text) => {
      const retained = text.slice(0, remaining);
      remaining -= retained.length;
      return retained;
    });
  }

  // Reserve the marker before allocating any source text. This also preserves the
  // marker when overflow begins exactly at a text-block boundary.
  const sourceBudget = Math.max(0, maxChars - marker.length);
  let remaining = sourceBudget;
  let markerWritten = false;
  return normalized.map((text) => {
    if (markerWritten) return "";
    if (text.length <= remaining) {
      remaining -= text.length;
      return text;
    }
    markerWritten = true;
    return text.slice(0, remaining) + marker.slice(0, maxChars - sourceBudget);
  });
}

/**
 * Resolve the operator setting. Invalid values always retain the finite default;
 * only the explicit zero sentinel represents unlimited output.
 */
export function resolveAgentToolOutputMaxChars(
  settings: { agentToolOutputMaxChars?: number | null | unknown },
): number | null {
  const candidate = settings.agentToolOutputMaxChars;
  if (candidate === TOOL_OUTPUT_UNLIMITED_SETTING_VALUE) return null;
  if (typeof candidate === "number" && Number.isFinite(candidate) && Number.isInteger(candidate) && candidate > 0) {
    return candidate;
  }
  return DEFAULT_TOOL_OUTPUT_MAX_CHARS;
}

/** Resolve an optional named override; every valid result remains finitely bounded. */
export function resolveToolOutputBudget(
  toolName: string,
  overrides: Readonly<Record<string, number | null | undefined>> | undefined,
  defaultMaxChars = DEFAULT_TOOL_OUTPUT_MAX_CHARS,
): number {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, toolName)) {
    return defaultMaxChars;
  }
  const candidate = overrides[toolName];
  if (typeof candidate === "number" && Number.isFinite(candidate) && Number.isInteger(candidate) && candidate > 0) {
    return candidate;
  }

  const error = new Error(`Invalid tool output budget for ${toolName}; overrides must be finite positive integers.`);
  if (process.env.NODE_ENV === "production") {
    log.warn(error.message);
    return defaultMaxChars;
  }
  throw error;
}
