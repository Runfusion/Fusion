/**
 * Startup-banner secret display.
 *
 * FNXC:StartupSecretDisplay 2026-10-15-21:25 (RUFU-687):
 * `fn serve` and `fn dashboard` print a launch URL, a token line and an `fn node connect
 * --api-key …` example so an operator can open their own dashboard from the machine or a second
 * device. Printing the raw value is correct at an interactive terminal and wrong everywhere else:
 * a redirected or piped stdout persists the credential. Measured in production — the watchdog
 * starts the server with stdout appended to `/tmp/fusion-prod-20261006.log`, whose 175
 * `token=<value>` occurrences each authenticate the dashboard API (an operator session used one
 * to call `POST /api/tasks/:id/bypass-review` successfully). Anyone able to read that file, or any
 * log shipping/rotation/support-bundle path that includes it, holds an operator credential.
 *
 * The rule is therefore about the SINK, not the field: a secret may be printed raw only when the
 * stream is an interactive terminal, which is ephemeral and faces the operator. A non-TTY stdout
 * (file, pipe, CI log, `systemd`, `nohup`, watchdog) gets a mask plus instructions, because the
 * banner still has to prove auth is on and which last-4 identifies it.
 *
 * `--token` remains the way to SET a token; retrieval is unaffected (the daemon keeps
 * `fn daemon --token-only`), so masking the banner cannot lock an operator out of their own UI.
 */

/** Masked rendering: keeps only the trailing identity characters. */
export function maskSecret(token?: string | null): string {
  if (!token) return "none";
  if (token.length < 4) return "****";
  return `****${token.slice(-4)}`;
}

/**
 * True when the secret may be printed raw: an interactive terminal only.
 *
 * `isTTY` is injectable so the branches are testable without detaching a process.
 */
export function maySurfaceSecret(isTTY: boolean | undefined = process.stdout.isTTY): boolean {
  return isTTY === true;
}

/**
 * The token as it should appear in a banner line.
 *
 * @param token raw bearer token
 * @param isTTY interactivity of the destination stream
 */
export function secretForDisplay(token: string, isTTY?: boolean): string {
  if (maySurfaceSecret(isTTY)) return token;
  return `${maskSecret(token)} (hidden because stdout is not a terminal; pass --token <value> to set a known one, or run in a terminal)`;
}

/**
 * Launch URL for the banner. The `?token=` query is a working credential, so it follows the same
 * sink rule as the token line: masked on a non-interactive stream.
 */
export function launchUrl(baseUrl: string, token?: string | null, isTTY?: boolean): string {
  if (!token) return baseUrl;
  return maySurfaceSecret(isTTY)
    ? `${baseUrl}/?token=${encodeURIComponent(token)}`
    : `${baseUrl}/?token=${maskSecret(token)}#auth-required`;
}
