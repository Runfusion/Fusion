// Untrusted-input sanitization helpers (U6 / Risk S7).
//
// Every string an ACP agent emits — text/thinking deltas, tool `title`, plan
// text, `sessionId`, `toolCallId` — is untrusted input. Before any such string
// reaches a Fusion callback, a log, the UI, or (worst) a filesystem path, it must
// be neutralized:
//
//   - `stripControlSequences` removes ANSI/OSC escapes and C0/C1 control chars so
//     a crafted string cannot inject terminal escapes / rewrite log lines.
//   - `boundString` truncates oversized content (Risk S5) with a visible marker.
//   - `boundIdentifier` bounds an agent-supplied id and strips path separators /
//     NUL bytes so the id can never be interpolated into a filesystem path
//     unsanitized.

/** Default cap for an agent-supplied identifier (sessionId, toolCallId). */
export const DEFAULT_IDENTIFIER_MAX = 256;

/** Marker appended when `boundString` truncates its input. */
export const TRUNCATION_MARKER = "…[truncated]";

// ANSI escape sequences:
//   CSI / SGR:  ESC [ ... <final byte>
//   OSC:        ESC ] ... (BEL | ST)
//   other ESC-prefixed two-char sequences (e.g. ESC ( B)
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;

// Non-printable control chars to drop. C0 = \x00–\x1F, DEL = \x7F, C1 = \x80–\x9F.
// We KEEP \n (\x0A) and \t (\x09) — they are legitimate whitespace in agent text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/**
 * Remove ANSI escape sequences (CSI/SGR/OSC) and non-printable C0/C1 control
 * characters from an untrusted string. Preserves `\n` and `\t`. Never throws —
 * a non-string input yields an empty string.
 */
export function stripControlSequences(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_CHARS_PATTERN, "");
}

/**
 * Truncate `text` to at most `max` characters, appending a short truncation
 * marker when the input is cut. A non-positive `max` yields an empty string; a
 * non-string input yields an empty string. The returned string is never longer
 * than `max` (the marker replaces the tail of the budget, it is not added on
 * top).
 */
export function boundString(text: string, max: number): string {
  if (typeof text !== "string" || text === "") return "";
  if (!Number.isFinite(max) || max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) {
    return text.slice(0, max);
  }
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Bound an agent-supplied identifier to a sane length and strip anything that
 * could let it escape into a filesystem path: path separators (`/`, `\`), NUL
 * bytes, control chars, and `..` traversal segments are removed. The result is
 * a flat, length-bounded token safe to use as a Map key or a single path
 * component. A non-string / empty input yields `""`.
 */
export function boundIdentifier(id: string, max: number = DEFAULT_IDENTIFIER_MAX): string {
  if (typeof id !== "string" || id === "") return "";
  const cap = Number.isFinite(max) && max > 0 ? max : DEFAULT_IDENTIFIER_MAX;
  // Drop ANSI/control first, then path-dangerous characters, then traversal.
  let cleaned = stripControlSequences(id)
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, "")
    .replace(/[/\\]/g, "_");
  // Collapse any remaining `..` traversal tokens (after separators were removed
  // a `..` cannot point anywhere, but normalize it away for defense in depth).
  cleaned = cleaned.replace(/\.\.+/g, "_");
  return cleaned.slice(0, cap);
}
