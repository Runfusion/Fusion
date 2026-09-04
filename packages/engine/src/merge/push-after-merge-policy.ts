import type { Settings } from "@fusion/core";

export type PushAfterMergeLane = "single-repo" | "workspace";

/**
 * FNXC:MergePush 2026-08-30-09:14:
 * FN-263 makes push-after-merge one policy across direct and workspace landing. A workspace task
 * always uses direct per-repository landing and never reaches `processPullRequestMerge` (FN-7610
 * at project-engine.ts:4694), so pull-request strategy suppresses only the single-repository push.
 */
export function isPushAfterMergeEnabled(
  settings: Pick<Settings, "pushAfterMerge" | "mergeStrategy">,
  options: { lane?: PushAfterMergeLane } = {},
): boolean {
  if (settings.pushAfterMerge !== true) return false;
  return options.lane === "workspace" || settings.mergeStrategy !== "pull-request";
}
