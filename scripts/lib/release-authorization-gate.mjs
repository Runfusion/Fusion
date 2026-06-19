export const RELEASE_AUTHORIZATION_ENV = "FUSION_RELEASE_AUTHORIZED";

/**
 * FNXC:ReleaseScript 2026-06-15-02:41:
 * FN-6469 proved that branch and working-tree preflight checks are not an authorization boundary because an agent can clone `main` into a fresh directory and rerun `pnpm release --yes`.
 * Real releases are not agent-initiable: the publish path requires an explicit operator-held environment signal that is outside repo state and cannot be self-granted by reproducing `main`; dry-runs bypass this gate because they publish nothing.
 *
 * @param {{ dryRun: boolean, env?: Record<string, string | undefined>, stdinIsTTY?: boolean }} options
 * @returns {{ authorized: boolean, mode: "dry-run-bypass" | "env-signal" | "blocked", reason?: string }}
 */
export function evaluateReleaseAuthorization({ dryRun, env = {}, stdinIsTTY = false }) {
  if (dryRun === true) {
    return { authorized: true, mode: "dry-run-bypass" };
  }

  const signal = env[RELEASE_AUTHORIZATION_ENV];
  if (typeof signal === "string" && signal.trim() !== "") {
    return { authorized: true, mode: "env-signal" };
  }

  const shellContext = stdinIsTTY
    ? "No operator authorization signal was present in this interactive shell."
    : "No operator authorization signal was present in this non-interactive shell.";

  return {
    authorized: false,
    mode: "blocked",
    reason: `${shellContext} Real releases require explicit operator authorization via ${RELEASE_AUTHORIZATION_ENV}; aborted before version bump, publish, push, or tag.`,
  };
}
