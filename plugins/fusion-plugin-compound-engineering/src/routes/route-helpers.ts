/**
 * Shared route helpers.
 *
 * `asString` coerces an unknown request value to a non-empty string or
 * `undefined` — the common "optional, must be a real string" guard used across
 * the CE route handlers. (settings.ts has a different-signature `asString` that
 * is intentionally NOT consolidated here.)
 */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
