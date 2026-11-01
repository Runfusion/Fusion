import type { Settings } from "@fusion/core";

export type PushAfterMergeLane = "single-repo" | "workspace";

/**
 * Why publishing is withheld, as a closed vocabulary an operator can query without re-deriving anything.
 *
 * `setting-disabled` names the operator: "Push to remote after merge" is off, so nothing will ever reach
 * a remote from this project until they flip it. `merge-strategy-suppressed` names the mechanism: the
 * operator DID ask for publishing, but the pull-request strategy owns the transport, so a push here would
 * be wrong rather than merely unwanted. The two read the same way in a log but have opposite remedies,
 * which is exactly why they are two codes and not one.
 *
 * FNXC:MergePublish 2026-10-31-22:57 (RUFU-338 F-4):
 * The boolean answer used to be the whole interface, so the merge lane that acted on it could not say why
 * it did nothing, and "publish disabled by config" was indistinguishable from a merge-lane dispatch
 * failure (RUFU-337 F-4, measured on main tip 05a0e0c786). The explanation is derived from the SAME
 * predicate rather than a second copy of the rule, so a trace can never disagree with the decision.
 */
export type PushAfterMergeDisabledReason = "setting-disabled" | "merge-strategy-suppressed";

/** One evaluated publish decision: enabled, or disabled with the fixed reason that says why. */
export type PushAfterMergeDecision =
  | { enabled: true }
  | { enabled: false; reasonCode: PushAfterMergeDisabledReason };

/**
 * FNXC:MergePush 2026-08-30-09:14:
 * FN-263 makes push-after-merge one policy across direct and workspace landing. A workspace task
 * always uses direct per-repository landing and never reaches `processPullRequestMerge` (FN-7610
 * at project-engine.ts:4694), so pull-request strategy suppresses only the single-repository push.
 *
 * FNXC:MergePublish 2026-10-31-22:57 (RUFU-338 F-4):
 * This is now the single decision point that ALSO explains itself; `isPushAfterMergeEnabled` is a
 * derivation over it, so every existing call site keeps byte-identical results while the two surfaces
 * that report a withheld publish name the cause instead of the silence.
 */
export function explainPushAfterMergeDecision(
  settings: Pick<Settings, "pushAfterMerge" | "mergeStrategy">,
  options: { lane?: PushAfterMergeLane } = {},
): PushAfterMergeDecision {
  if (settings.pushAfterMerge !== true) return { enabled: false, reasonCode: "setting-disabled" };
  if (options.lane !== "workspace" && settings.mergeStrategy === "pull-request") {
    return { enabled: false, reasonCode: "merge-strategy-suppressed" };
  }
  return { enabled: true };
}

export function isPushAfterMergeEnabled(
  settings: Pick<Settings, "pushAfterMerge" | "mergeStrategy">,
  options: { lane?: PushAfterMergeLane } = {},
): boolean {
  return explainPushAfterMergeDecision(settings, options).enabled;
}
