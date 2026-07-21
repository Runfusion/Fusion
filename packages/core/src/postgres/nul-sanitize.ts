/*
FNXC:PostgresMigrationNulSanitize 2026-07-17-10:05 (extracted 2026-07-20):
PostgreSQL rejects U+0000 in text/varchar ("invalid byte sequence" / "\u0000
cannot be converted to text.") and in json/jsonb ("unsupported Unicode escape
sequence"). Any write path that persists free-form agent/tool output as
Postgres text or jsonb — chat messages, chat room messages, and the
agent/user mailbox — can receive a raw NUL byte from unsanitized upstream
tool output (e.g. Windows CLI dumps piped straight into a message body) and
crash the write with an uncaught PostgresError.

This module was originally written for the one-time SQLite -> PostgreSQL
first-boot migration (see sqlite-migrator.ts) and is promoted here so live
write paths (async-chat-store.ts, async-message-store.ts) can reuse the same
tested sanitization instead of duplicating it or, worse, not sanitizing at
all.
*/

// eslint-disable-next-line no-control-regex -- matching the NUL control character is the point
const NUL_CHAR_RE = /\u0000/g;

/** Strip U+0000 (NUL) characters from a plain string. Cheap no-op when absent. */
export function stripNulChars(text: string): string {
  return text.includes("\u0000") ? text.replace(NUL_CHAR_RE, "") : text;
}

/**
 * Recursively strip U+0000 from all string values and object keys in a
 * parsed JSON-like value (object/array/string/number/boolean/null).
 */
export function deepStripNulChars(value: unknown): unknown {
  if (typeof value === "string") {
    return stripNulChars(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepStripNulChars);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entry]) => [stripNulChars(key), deepStripNulChars(entry)],
      ),
    );
  }
  return value;
}

/**
 * Sanitize a value that Drizzle will bind as a `text`/`varchar` column.
 * Strings are NUL-stripped; everything else (including null/undefined)
 * passes through unchanged.
 */
export function sanitizeTextValue<T>(value: T): T {
  return (typeof value === "string" ? (stripNulChars(value) as unknown as T) : value);
}

/**
 * Sanitize a value that Drizzle will bind as a `jsonb` column. Accepts
 * either a JS value (object/array/etc, including null/undefined) that will
 * be strip-cleaned recursively, since Drizzle's jsonb columns take JS values
 * directly (not JSON strings) at the call sites this is used from.
 */
export function sanitizeJsonbValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return deepStripNulChars(value) as T;
}