/**
 * FNXC:Identity 2026-08-15-22:52 (U18/KTD2 Stage C):
 * Total run-carrier helper. The partial getter answers "is there a live run?" for
 * liveness probes; this form never returns undefined so store mutations cannot
 * fall through to the deprecated unattributed overload. The fallback is the same
 * derived executor-lane actor `execute()` already writes onto a live run.
 */
import type { RunMutationContext } from "@fusion/core";
import { mutationContextForAgent } from "@fusion/core";
import { toRunMutationContext, type EngineRunContext } from "../util/run-audit.js";

export const EXECUTOR_LANE_AGENT_ID = "executor";

export function runContextForTotal(
  getRunContextFor: (taskId: string) => EngineRunContext | RunMutationContext | undefined,
  taskId: string,
  fallbackAgentId?: string | null,
): RunMutationContext {
  const live = getRunContextFor(taskId);
  if (!live) return mutationContextForAgent(fallbackAgentId ?? EXECUTOR_LANE_AGENT_ID);
  if ("actor" in live && live.actor) return live as RunMutationContext;
  return toRunMutationContext(live as EngineRunContext);
}
