/**
 * Credential redaction for PostgreSQL connection strings.
 *
 * FNXC:PostgresConnection 2026-06-24-01:40:
 * The password portion of DATABASE_URL must never be written to logs.
 * Connection-error messages and log-safe representations of connection strings
 * must redact credentials so that a misconfigured or leaking log sink cannot
 * expose the database password. This module provides pure-string helpers used
 * by the connection layer and any diagnostic surface that references a URL.
 *
 * Supports two URL shapes:
 *   1. `postgresql://user:password@host:port/db?params` (URL with userinfo)
 *   2. Space-delimited key=value connection strings (e.g. `host=localhost password=secret`)
 *
 * Only the password/secret material is redacted. The host, port, database, and
 * username are preserved because they are needed for actionable error messages
 * and debugging without exposing credentials.
 */

/** The replacement text used in place of the actual password. */
export const REDACTED_PASSWORD_PLACEHOLDER = "********";

/**
 * Redact the password from a standard `postgresql://` or `postgres://`
 * connection string (URL form with userinfo).
 *
 * Returns the input unchanged if no userinfo password is present.
 *
 * @example
 * redactUrlPassword("postgresql://user:s3cr3t@localhost:5432/fusion")
 * // → "postgresql://user:********@localhost:5432/fusion"
 */
export function redactUrlPassword(url: string): string {
  // Match the userinfo section of a postgres/postgresql scheme URL.
  // userinfo = [user [: password]] @
  // We only redact the password (after the first colon within userinfo).
  // The regex captures:
  //   scheme:// + username + :password@ + rest
  const urlPasswordRe =
    /((?:postgres|postgresql):\/\/[^/\s:@]+):([^@\s]+)(@[^\s]*)/;
  let result = url;
  const match = urlPasswordRe.exec(result);
  if (match) {
    result = `${match[1]}:${REDACTED_PASSWORD_PLACEHOLDER}${match[3]}`;
  }
  // FNXC:CredentialRedact 2026-06-26-10:40:
  // P1 fix (review #22): also redact `?password=` / `&password=` query-param
  // passwords in URL-form connection strings. Some drivers/tools accept the
  // password as a query parameter (e.g. postgresql://host:5432/db?password=secret)
  // and the userinfo regex above does not cover that shape, so the password
  // was logged verbatim by DatabaseConnectionError / describeBackendForLog.
  result = redactUrlQueryPassword(result);
  return result;
}

/**
 * Redact a `password=` query parameter from a URL's query string.
 *
 * Handles both `?password=value` (first param) and `&password=value` (subsequent
 * param). Only the value is redacted; the key and other params are preserved so
 * the URL remains actionable for debugging.
 *
 * @example
 * redactUrlQueryPassword("postgresql://h:5432/db?password=s3cr3t&sslmode=require")
 * // → "postgresql://h:5432/db?password=********&sslmode=require"
 */
export function redactUrlQueryPassword(url: string): string {
  // Match `password=` preceded by `?` or `&`, followed by a bare value that
  // stops at `&`, `#`, or end of string. Query-param values are never quoted.
  return url.replace(
    /([?&]password=)([^&#\s]*)/gi,
    `$1${REDACTED_PASSWORD_PLACEHOLDER}`,
  );
}

/**
 * Redact the password from a space-delimited key=value connection string
 * (the libpq keyword/value format: `host=localhost password=secret dbname=fusion`).
 *
 * @example
 * redactKeywordPassword("host=localhost password=s3cr3t dbname=fusion")
 * // → "host=localhost password=******** dbname=fusion"
 */
export function redactKeywordPassword(connStr: string): string {
  // Match `password=` followed by a value that is either quoted or bare
  // (stopping at whitespace or end of string).
  return connStr.replace(
    /((?:^|\s)password\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi,
    (_full, prefix: string) => `${prefix}${REDACTED_PASSWORD_PLACEHOLDER}`,
  );
}

/**
 * Redact credentials from any connection string, handling both URL form
 * (`postgresql://...`) and keyword/value form (`host=... password=...`).
 *
 * This is the primary safe-display entry point: use it whenever a connection
 * string or URL fragment might be logged, included in an error message, or
 * rendered in any diagnostic output.
 *
 * @example
 * redactConnectionString("postgresql://user:pass@host/db")
 * // → "postgresql://user:********@host/db"
 *
 * @example
 * redactConnectionString("host=h password=p port=5432")
 * // → "host=h password=******** port=5432"
 */
export function redactConnectionString(connStr: string): string {
  const isUrlForm = /(postgres|postgresql):\/\//i.test(connStr);
  if (isUrlForm) {
    return redactUrlPassword(connStr);
  }
  return redactKeywordPassword(connStr);
}

/**
 * Redact any plaintext password value that appears in an arbitrary error
 * message or log text. This is the defensive fallback for connection errors
 * thrown by the driver, which may embed the full connection string.
 *
 * It handles both URL-embedded passwords and keyword/value passwords, as well
 * as bare password fragments that may appear in driver error messages.
 */
export function redactCredentialsFromMessage(text: string): string {
  let result = text;
  // URL form — userinfo password
  result = result.replace(
    /((?:postgres|postgresql):\/\/[^/\s:@]+):([^@\s]+)(@[^\s]*)/gi,
    `$1:${REDACTED_PASSWORD_PLACEHOLDER}$3`,
  );
  // FNXC:CredentialRedact 2026-06-26-10:40:
  // URL form — query-param password (?password= / &password=). Same gap as
  // redactUrlPassword (review #22): driver errors can embed the full URL.
  result = redactUrlQueryPassword(result);
  // keyword/value form
  result = result.replace(
    /((?:^|\s)password\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi,
    `$1${REDACTED_PASSWORD_PLACEHOLDER}`,
  );
  return result;
}
