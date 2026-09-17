/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — shared state for the per-card delivery lock: availability, the three commands, conflicts and
the refresh that follows a decision.

Two fences matter here and are both keyed on the TASK, not on a render counter:
  • a response for a previously selected task must never publish into the currently rendered one
    (A → B → A returns to a card whose candidate token may have changed);
  • a retry of the SAME command reuses its requestId, so the server can recognise the replay and
    return the stored receipt instead of acting twice. A different command always gets a fresh id.
*/
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchTaskMergeApproval,
  setTaskMergeApprovalLock,
  submitTaskMergeDecision,
  type HumanMergeDecisionActionId,
  type HumanMergeDecisionPointView,
} from "../api/tasks/task-merge-approval.js";

export interface UseTaskMergeApprovalResult {
  point: HumanMergeDecisionPointView | null;
  loading: boolean;
  pendingAction: HumanMergeDecisionActionId | null;
  error: string | null;
  refresh: () => Promise<void>;
  submit: (action: HumanMergeDecisionActionId, message: string) => Promise<boolean>;
  setLock: (enabled: boolean) => Promise<boolean>;
  clearError: () => void;
}

function randomRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useTaskMergeApproval(
  taskId: string | undefined,
  projectId?: string,
  options: { enabled?: boolean } = {},
): UseTaskMergeApprovalResult {
  const [point, setPoint] = useState<HumanMergeDecisionPointView | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<HumanMergeDecisionActionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Identity of the card currently rendered; a response for any other identity is discarded. */
  const activeKey = useRef<string>("");
  const key = `${projectId ?? ""}\u0000${taskId ?? ""}`;
  activeKey.current = key;

  /*
  Stable per-(task, action) request ids. A retry of the same command replays the SAME id so the
  server returns its stored receipt; switching command clears the others so no action can inherit
  another's identity.
  */
  const requestIds = useRef<Map<string, string>>(new Map());
  const requestIdFor = useCallback((action: HumanMergeDecisionActionId): string => {
    const mapKey = `${key}\u0000${action}`;
    const existing = requestIds.current.get(mapKey);
    if (existing) return existing;
    const fresh = randomRequestId();
    requestIds.current.set(mapKey, fresh);
    return fresh;
  }, [key]);

  const refresh = useCallback(async () => {
    if (!taskId || options.enabled === false) {
      setPoint(null);
      return;
    }
    const requestKey = key;
    setLoading(true);
    try {
      const next = await fetchTaskMergeApproval(taskId, projectId);
      if (activeKey.current !== requestKey) return;
      setPoint(next);
    } catch {
      if (activeKey.current !== requestKey) return;
      /*
      A failed availability read must not present a decision surface: absence of proof is not
      permission. The panel simply does not appear.
      */
      setPoint(null);
    } finally {
      if (activeKey.current === requestKey) setLoading(false);
    }
  }, [taskId, projectId, key, options.enabled]);

  useEffect(() => {
    void refresh();
    // A different card starts from a clean slate: no token, no draft-facing error, no request ids.
    return () => {
      setError(null);
      setPendingAction(null);
    };
  }, [refresh]);

  const submit = useCallback(async (action: HumanMergeDecisionActionId, message: string): Promise<boolean> => {
    if (!taskId || !point?.candidateToken) return false;
    const requestKey = key;
    setPendingAction(action);
    setError(null);
    try {
      await submitTaskMergeDecision(taskId, {
        action,
        ...(message.trim().length > 0 ? { message } : {}),
        requestId: requestIdFor(action),
        candidateToken: point.candidateToken,
        expectedRevision: point.revision,
      }, projectId);
      if (activeKey.current !== requestKey) return true;
      /* The command succeeded: this request id is spent and must not be replayed as a new command. */
      requestIds.current.delete(`${key}\u0000${action}`);
      await refresh();
      return true;
    } catch (err) {
      if (activeKey.current !== requestKey) return false;
      setError(err instanceof Error ? err.message : String(err));
      /* A conflict means the server moved on; re-read so the operator sees the live situation. */
      await refresh();
      return false;
    } finally {
      if (activeKey.current === requestKey) setPendingAction(null);
    }
  }, [taskId, projectId, point?.candidateToken, point?.revision, key, refresh, requestIdFor]);

  const setLock = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (!taskId) return false;
    const requestKey = key;
    setError(null);
    try {
      await setTaskMergeApprovalLock(taskId, {
        enabled,
        requestId: randomRequestId(),
        ...(point?.revision ? { expectedRevision: point.revision } : {}),
      }, projectId);
      if (activeKey.current === requestKey) await refresh();
      return true;
    } catch (err) {
      if (activeKey.current === requestKey) {
        setError(err instanceof Error ? err.message : String(err));
        await refresh();
      }
      return false;
    }
  }, [taskId, projectId, point?.revision, key, refresh]);

  const clearError = useCallback(() => setError(null), []);

  return { point, loading, pendingAction, error, refresh, submit, setLock, clearError };
}
