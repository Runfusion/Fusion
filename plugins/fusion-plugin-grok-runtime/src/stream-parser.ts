import type { GrokCliJsonResponse, GrokNdjsonEvent } from "./types.js";

/*
FNXC:GrokCli 2026-07-10-12:50:
FN-7796: xAI Grok Build TUI's `--output-format streaming-json` intermittently ends with `stopReason:"Cancelled"` and zero `text` events. The headless path now uses the reliable single-object `--output-format json` response, so parser callers should parse the complete stdout buffer into `{text,stopReason,sessionId,requestId,thought}` and treat invalid/partial buffers as absent output rather than throwing.
*/

/**
 * Parse the complete stdout buffer from
 * `grok -p <prompt> --output-format json` into the real xAI Grok Build TUI
 * response object, or null when the output is empty, non-JSON, a JSON array,
 * or an unrelated object with none of the expected response fields.
 */
export function parseJsonOutput(output: string): GrokCliJsonResponse | null {
  const trimmed = output.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const hasKnownField = ["text", "stopReason", "sessionId", "requestId", "thought"].some((key) => key in candidate);
  if (!hasKnownField) {
    return null;
  }

  return {
    text: typeof candidate.text === "string" ? candidate.text : undefined,
    stopReason: typeof candidate.stopReason === "string" ? candidate.stopReason : undefined,
    sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    requestId: typeof candidate.requestId === "string" ? candidate.requestId : undefined,
    thought: typeof candidate.thought === "string" ? candidate.thought : undefined,
  };
}

const STREAMING_EVENT_TYPES = new Set(["thought", "text", "end"]);

/**
 * Parse a single NDJSON line from the legacy/flaky
 * `--output-format streaming-json` contract. The runtime no longer relies on
 * this as its primary path, but retaining this parser lets deterministic
 * regressions model the live-captured cancelled-no-text stream shape and
 * produce a concrete diagnostic instead of treating it as arbitrary garbage.
 */
export function parseLine(line: string): GrokNdjsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as { type?: unknown };
  if (typeof candidate.type !== "string" || !STREAMING_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  return parsed as GrokNdjsonEvent;
}
