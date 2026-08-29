import type { NdjsonMessage } from "./types";

/**
 * Parse a single NDJSON line from Claude CLI stdout into a typed message.
 *
 * This function is deliberately resilient -- it never throws. Debug noise,
 * empty lines, and malformed JSON all return null so the streaming pipeline
 * can safely skip them and continue processing.
 */
export function parseLine(line: string): NdjsonMessage | null {
  const trimmed = line.trim();

  // Skip empty lines
  if (!trimmed) {
    return null;
  }

  // Skip non-JSON lines (debug output like "[SandboxDebug] ...")
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.error("Failed to parse NDJSON line:", trimmed);
    return null;
  }

  // Validate that the parsed result is a non-null object (not array, not primitive)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as NdjsonMessage;
}
