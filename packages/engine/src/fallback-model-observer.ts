import type { AgentLogType } from "@fusion/core";
import { notifyFallbackUsed } from "./notifier.js";
import type { FallbackModelUsedPayload } from "./pi.js";

type FallbackLogStore = {
  logEntry?(taskId: string, action: string): Promise<unknown>;
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
      await options.store.logEntry(taskId, message).catch(() => undefined);
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
