/**
 * FNXC:ReleaseScript 2026-07-08-11:20:
 * The former operator-held environment signal is removed. An env var is self-grantable (an agent can `export` it) and survives into non-interactive shells, so it never proved a live human.
 *
 * FNXC:ReleaseScript 2026-08-03-02:56:
 * The typed "authorized" phrase is removed. Real releases are gated by the operator y/N confirmation
 * in scripts/release.mjs. Dry-runs publish nothing and need no authorization. Agents must not run
 * real releases (AGENTS.md → Releasing); that is instruction, not a typed-phrase lock.
 *
 * FNXC:ReleaseScript 2026-08-03-02:57:
 * `--yes` is also removed; every real release requires interactive confirmation.
 */

/**
 * Pure decision for release authorization bookkeeping. Dry-runs bypass; real releases are always
 * allowed to proceed to the script's interactive confirm() step.
 *
 * @param {{ dryRun: boolean }} options
 * @returns {{ authorized: boolean, mode: "dry-run-bypass" | "operator-confirm" }}
 */
export function evaluateReleaseAuthorization({ dryRun }) {
  if (dryRun === true) {
    return { authorized: true, mode: "dry-run-bypass" };
  }
  return { authorized: true, mode: "operator-confirm" };
}
