/**
 * FNXC:ReleaseScript 2026-07-08-11:20:
 * The former operator-held environment signal is removed. An env var is self-grantable (an agent can `export` it) and survives into non-interactive shells, so it never proved a live human. Real releases now require a human to type the authorization phrase at an interactive prompt, and a release can no longer be run non-interactively at all.
 *
 * FN-6469 proved that branch and working-tree preflight checks are not an authorization boundary because an agent can clone `main` into a fresh directory and rerun `pnpm release --yes`. The interactive-typed phrase closes that hole: it cannot be satisfied without a TTY-attached human, and `--yes` does not bypass it.
 */

/**
 * The exact phrase an operator must type to authorize a real release.
 * Matched case-insensitively after trimming surrounding whitespace.
 */
export const RELEASE_AUTHORIZATION_PHRASE = "authorized";

/**
 * FNXC:ReleaseScript 2026-07-08-11:20:
 * Pure decision for how release authorization must be obtained. Real releases require a live operator: dry-runs publish nothing and bypass; a non-interactive shell (no TTY) is blocked outright because the authorization phrase cannot be typed; an interactive shell must prompt for the typed phrase (see {@link isReleaseAuthorizationPhrase}).
 *
 * @param {{ dryRun: boolean, stdinIsTTY?: boolean }} options
 * @returns {{ authorized: boolean, mode: "dry-run-bypass" | "requires-confirmation" | "blocked", reason?: string }}
 */
export function evaluateReleaseAuthorization({ dryRun, stdinIsTTY = false }) {
  if (dryRun === true) {
    return { authorized: true, mode: "dry-run-bypass" };
  }

  if (stdinIsTTY !== true) {
    return {
      authorized: false,
      mode: "blocked",
      reason:
        "Releases cannot be run non-interactively: no TTY is attached, so the operator authorization phrase cannot be typed. " +
        `Run \`pnpm release\` from an interactive terminal and type "${RELEASE_AUTHORIZATION_PHRASE}" when prompted; aborted before version bump, publish, push, or tag.`,
    };
  }

  return { authorized: false, mode: "requires-confirmation" };
}

/**
 * FNXC:ReleaseScript 2026-07-08-11:20:
 * Validate what the operator typed at the authorization prompt. Only the exact phrase (case-insensitive, whitespace-trimmed) authorizes the release; anything else fails closed.
 *
 * @param {unknown} input raw string the operator typed
 * @returns {boolean}
 */
export function isReleaseAuthorizationPhrase(input) {
  return (
    typeof input === "string" &&
    input.trim().toLowerCase() === RELEASE_AUTHORIZATION_PHRASE
  );
}
