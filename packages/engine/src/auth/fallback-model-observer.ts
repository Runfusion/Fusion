import type { AgentLogType, RunMutationContext } from "@fusion/core";
import { notifyFallbackUsed } from "../util/notifier.js";
import type { FallbackModelUsedPayload } from "../pi.js";

/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 — a structural seam must RESTATE the required context):
This seam re-declares `logEntry` with its own narrow signature instead of picking it off `TaskStore`,
so it does not inherit U18's canonical/deprecated overload pair. Left at the old three-argument
arity it would keep accepting unattributed writes forever — the engine call-site sweep would report
done while this hole stayed open, which is exactly the `resolved-seams-nobody-wired.md` failure the
census exists to catch. The signature below mirrors the CANONICAL store arity (`outcome` explicit,
`runContext` required and last), which is also what keeps a real `TaskStore` structurally assignable
here: the deprecated overload cannot absorb a `RunMutationContext` in the `outcome` position.
*/
type FallbackLogStore = {
  logEntry?(taskId: string, action: string, outcome: string | undefined, runContext: RunMutationContext): Promise<unknown>;
  appendAgentLog?(
    taskId: string,
    text: string,
    // FNXC:AgentLog-EntryTypes 2026-07-15-11:20: reference the canonical AgentLogType rather than
    // re-listing the members — the hand-copied union silently drifted when `status` was added.
    type: AgentLogType,
    detail?: string,
    agent?: string,
  ): Promise<unknown>;
};

type FallbackModelObserverOptions = {
  agent: string;
  label: string;
  store?: FallbackLogStore;
  taskId?: string;
  taskTitle?: string;
  /*
  FNXC:Identity 2026-08-09-03:04 (U18/KTD2):
  Required, not optional-with-a-default. `agent` above is a LANE LABEL ("merger", "triage"), not an
  agent id, so deriving an actor from it would mint a fake identity that reads as real in audit. The
  lane that constructs the observer is the only place that knows its own run, so the requirement is
  restated here and each construction site must answer it — with `toRunMutationContext` when it holds
  a run context, or the marker when it genuinely has none.
  */
  runContext: RunMutationContext;
};

function buildFallbackLogMessage(
  label: string,
  payload: FallbackModelUsedPayload,
): string {
  const reason = payload.failureCategory === "authentication"
    ? "; primary provider authentication failed"
    : payload.failureCategory === "rate-limit"
      ? "; primary provider rate limit reached"
      : payload.failureCategory === "model-selection"
        ? "; primary model was unavailable"
        : payload.failureCategory === "provider-error"
          ? "; primary provider failed"
          : "";
  /*
  FNXC:ModelFallback 2026-07-14-15:58:
  A successful fallback must still explain the primary failure on the task. Persist a bounded category rather than raw provider text so operators can distinguish authentication from capacity/model failures without leaking credentials or arbitrary response bodies into activity logs.
  */
  return `[fallback] ${label} switched from ${payload.primaryModel} to ${payload.fallbackModel} (${payload.triggerPoint}${reason})`;
}

export function createFallbackModelObserver(options: FallbackModelObserverOptions) {
  return async (payload: FallbackModelUsedPayload): Promise<void> => {
    const taskId = options.taskId ?? payload.taskId;
    const taskTitle = options.taskTitle ?? payload.taskTitle;
    const message = buildFallbackLogMessage(options.label, payload);

    if (taskId && options.store?.logEntry) {
      await options.store.logEntry(taskId, message, undefined, options.runContext).catch(() => undefined);
    }
    if (taskId && options.store?.appendAgentLog) {
      await options.store.appendAgentLog(taskId, message, "status", undefined, options.agent).catch(() => undefined);
    }

    await notifyFallbackUsed({
      primaryModel: payload.primaryModel,
      fallbackModel: payload.fallbackModel,
      triggerPoint: payload.triggerPoint,
      taskId,
      taskTitle,
      timestamp: payload.timestamp,
    });
  };
}
