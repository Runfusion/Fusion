/**
 * Shared secret-redaction helper.
 *
 * Pure string logic that strips token-like / auth patterns from text so auth
 * errors and process output don't leak verbatim into logs or buffers. Best
 * effort: covers bearer tokens, `Authorization:` header values,
 * `key=`/`token=`/`secret=` assignments, and long base64/hex secrets.
 */

/**
 * Redact token-like / auth patterns from `text`.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // Authorization: Bearer <token>  /  Authorization: <token>
      .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, "$1$2[REDACTED]")
      // Bearer <token>
      .replace(/\b(bearer)\s+[A-Za-z0-9._\-+/=]+/gi, "$1 [REDACTED]")
      // key=... token=... secret=... password=... apikey=... (quoted or bare)
      .replace(
        /\b((?:api[_-]?key|key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*)("?)[^\s,;"']+\2/gi,
        "$1$2[REDACTED]$2",
      )
      // sk-/ghp_/github_pat_/xoxb-/AKIA-style long opaque tokens
      .replace(/\b(sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      // standalone long base64/hex secrets (>=32 chars)
      .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED]")
      .replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED]")
  );
}
