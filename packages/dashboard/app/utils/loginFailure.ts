/*
FNXC:ProviderAuth 2026-08-18-07:10:
Turn a provider login failure into something the operator can act on.

Both login surfaces used to report every non-completion as "Login did not complete. Please try
again." — including `OAuth state mismatch`, which is not a transient failure at all: it means the
pasted redirect URL came from a DIFFERENT (older) sign-in attempt than the one currently waiting,
so "try again" reproduces it exactly as long as the operator keeps pasting from the same stale
provider tab. That cost a real debugging session.

The server's own `loginError` is the input; anything unrecognized passes through verbatim, because a
specific upstream message (an invalid_grant body, a token-endpoint status) is always more useful than
the generic sentence it would otherwise be replaced by.
*/

const GENERIC_FAILURE = "Login did not complete. Please try again.";

export function describeLoginFailure(serverReason?: string): string {
  const reason = serverReason?.trim();
  if (!reason) {
    return GENERIC_FAILURE;
  }

  if (/state mismatch/i.test(reason)) {
    return "That link is from an earlier sign-in attempt. Close any older provider tabs, then start this login again and paste the URL from the newest tab.";
  }

  /*
   * Match the authorization-code grant failure only. A loose `code.*expired` also matched
   * "OpenAI Codex ... token_expired" — a different failure (a stale stored credential, not a spent
   * one-time code) that would then be given the wrong remedy.
   */
  if (/invalid_grant|Invalid 'code'|authorization code (?:has )?(?:expired|already)/i.test(reason)) {
    return "That authorization code was already used or has expired. Start the login again and paste the fresh redirect URL.";
  }

  if (/aborted|cancelled/i.test(reason)) {
    return "The login was cancelled before it finished. Start it again.";
  }

  return reason;
}
