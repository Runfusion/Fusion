/**
 * FNXC:ClaudeAcp 2026-06-15-11:40:
 * Route A enable resolution (experimental, DEFAULT ON).
 *
 * The `pi-claude-cli` provider drives Claude through the `claude-code-cli-acp`
 * ACP bridge instead of `claude -p` when BOTH hold at dispatch time:
 *   1. `FUSION_CLAUDE_ACP=1` (this module sets it from the experimental flag), and
 *   2. a bridge path is resolvable (the acp-runtime plugin publishes
 *      `FUSION_CLAUDE_ACP_BRIDGE` on load — KTD10; absent → fail-closed to `-p`).
 *
 * The user-facing switch is `experimentalFeatures.claudeCliAcp`: ON unless the
 * user explicitly sets it to `false`. An operator force-override
 * (`FUSION_CLAUDE_ACP_FORCE=0|1`) always wins. The decision is recomputed every
 * call (each `createFnAgent`) so flipping the flag — e.g. the UI "use `claude -p`"
 * fallback after an auth failure — takes effect on the next turn, no restart.
 */

/** True unless `experimentalFeatures.claudeCliAcp === false` (default ON). */
export function claudeAcpExperimentalEnabled(
  globalSettings: Record<string, unknown> | undefined,
): boolean {
  const exp = ((globalSettings ?? {}).experimentalFeatures ?? {}) as Record<string, unknown>;
  return exp.claudeCliAcp !== false;
}

/**
 * Translate the experimental flag into the `FUSION_CLAUDE_ACP` dispatch the
 * provider reads. No-op when the env var is already set (explicit override wins),
 * so operators/tests keep full control. Returns the resolved enabled state.
 */
export function applyClaudeAcpEnable(
  globalSettings: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Operator force-override (set in the launch environment), re-read every call
  // so our own writes to FUSION_CLAUDE_ACP can't latch the decision.
  const force = env.FUSION_CLAUDE_ACP_FORCE;
  const enabled =
    force === "1" ? true : force === "0" ? false : claudeAcpExperimentalEnabled(globalSettings);
  env.FUSION_CLAUDE_ACP = enabled ? "1" : "0";
  return enabled;
}
