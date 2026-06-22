import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  fetchBoardWorkflows as defaultFetchBoardWorkflows,
  type BoardWorkflowDefinition,
  type BoardWorkflowsPayload,
} from "../api";
import { subscribeSse as defaultSubscribeSse } from "../sse-bus";
import {
  readBoardWorkflowsCache as defaultReadBoardWorkflowsCache,
  writeBoardWorkflowsCache as defaultWriteBoardWorkflowsCache,
} from "../utils/boardWorkflowsCache";

/*
FNXC:Workflows 2026-06-22-17:00:
Single source of truth for board-workflow fetch/cache/SSE/selection, shared verbatim by Board.tsx and the Planning header slot (PlanningWorkflowSwitcherSlot.tsx). Both surfaces must show the SAME workflow dropdown driven by the SAME data path: refetch on mount, on tab visibility/focus, and on `workflow:created|updated|deleted` SSE; every fetch is guarded by a monotonic sequence ref that drops out-of-order responses; successful payloads persist to the per-project session cache; failures collapse to a flag-off payload. Selection (`selectedWorkflowId`) is local per-consumer and auto-syncs to the resolved default/first workflow.

Per-consumer subscription semantics are preserved: each call to this hook installs its OWN visibilitychange/focus listeners and its OWN SSE subscription, so two consumers (Board + Planning slot) each subscribe and unsubscribe independently — the hook does not dedupe across consumers. Dependencies (fetch, subscribeSse, cache helpers) are injectable to keep the hook DI-friendly and free of App-level singletons.
*/

export interface UseBoardWorkflowsParams {
  projectId?: string;
  /**
   * Gate cache hydration. Board passes `workflowColumnsEnabled === true || settingsLoaded === false`
   * to avoid flashing the legacy board; Planning has no such gate and leaves this at the default `true`.
   */
  shouldHydrateCache?: boolean;
  fetchBoardWorkflows?: typeof defaultFetchBoardWorkflows;
  subscribeSse?: typeof defaultSubscribeSse;
  readBoardWorkflowsCache?: typeof defaultReadBoardWorkflowsCache;
  writeBoardWorkflowsCache?: typeof defaultWriteBoardWorkflowsCache;
}

export interface UseBoardWorkflowsResult {
  /** Raw payload for the current project, or null when unloaded / project mismatch. */
  boardWorkflows: BoardWorkflowsPayload | null;
  /** True when the flag is on AND at least one workflow is defined. */
  workflowMode: boolean;
  /** Workflows sorted with the default first, then alphabetical. Empty unless in workflow mode. */
  workflowOptions: BoardWorkflowDefinition[];
  /** Currently selected workflow (resolved from selection / default / first), or null. */
  selectedWorkflow: BoardWorkflowDefinition | null;
  selectedWorkflowId: string | null;
  setSelectedWorkflowId: Dispatch<SetStateAction<string | null>>;
  /** Force a fresh fetch (used on switcher open, since task assignment changes emit no workflow SSE). */
  refreshBoardWorkflows: () => void;
  /**
   * Raw state setter, exposed so Board can apply optimistic task→workflow assignment.
   * Planning does not use this.
   */
  setBoardWorkflowsState: Dispatch<SetStateAction<{ projectId?: string; payload: BoardWorkflowsPayload } | null>>;
}

export function useBoardWorkflows(params: UseBoardWorkflowsParams): UseBoardWorkflowsResult {
  const {
    projectId,
    shouldHydrateCache = true,
    fetchBoardWorkflows = defaultFetchBoardWorkflows,
    subscribeSse = defaultSubscribeSse,
    readBoardWorkflowsCache = defaultReadBoardWorkflowsCache,
    writeBoardWorkflowsCache = defaultWriteBoardWorkflowsCache,
  } = params;

  const [boardWorkflowsState, setBoardWorkflowsState] = useState<{ projectId?: string; payload: BoardWorkflowsPayload } | null>(() => {
    const cached = shouldHydrateCache ? readBoardWorkflowsCache(projectId) : null;
    return cached ? { projectId, payload: cached } : null;
  });
  const boardWorkflows = boardWorkflowsState?.projectId === projectId && boardWorkflowsState ? boardWorkflowsState.payload : null;
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Stale-response guard: a monotonic sequence ref drops out-of-order responses.
  const boardWorkflowsFetchSeqRef = useRef(0);

  // Re-hydrate from the per-project cache on project change (and gate change).
  useEffect(() => {
    const cached = shouldHydrateCache ? readBoardWorkflowsCache(projectId) : null;
    setBoardWorkflowsState(cached ? { projectId, payload: cached } : null);
  }, [projectId, shouldHydrateCache, readBoardWorkflowsCache]);

  const refreshBoardWorkflows = useCallback(() => {
    const seq = ++boardWorkflowsFetchSeqRef.current;
    fetchBoardWorkflows(projectId)
      .then((payload) => {
        if (seq === boardWorkflowsFetchSeqRef.current) {
          setBoardWorkflowsState({ projectId, payload });
          writeBoardWorkflowsCache(projectId, payload);
        }
      })
      .catch(() => {
        if (seq === boardWorkflowsFetchSeqRef.current) {
          setBoardWorkflowsState({ projectId, payload: { flagEnabled: false, defaultWorkflowId: "builtin:coding", workflows: [], taskWorkflowIds: {} } });
        }
      });
  }, [projectId, fetchBoardWorkflows, writeBoardWorkflowsCache]);

  useEffect(() => {
    refreshBoardWorkflows();
    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") refreshBoardWorkflows();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener("focus", onVisible);
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "workflow:created": refreshBoardWorkflows,
        "workflow:updated": refreshBoardWorkflows,
        "workflow:deleted": refreshBoardWorkflows,
      },
    });
    return () => {
      // Advance the seq so any in-flight response is dropped on cleanup.
      boardWorkflowsFetchSeqRef.current++;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("focus", onVisible);
      unsubscribe();
    };
  }, [projectId, refreshBoardWorkflows, subscribeSse]);

  const flagOn = boardWorkflows?.flagEnabled === true;
  const workflowMode = flagOn && Boolean(boardWorkflows?.workflows.length);

  const workflowOptions = useMemo<BoardWorkflowDefinition[]>(() => {
    if (!workflowMode || !boardWorkflows) return [];
    return [...boardWorkflows.workflows].sort((a, b) => {
      if (a.id === boardWorkflows.defaultWorkflowId) return -1;
      if (b.id === boardWorkflows.defaultWorkflowId) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [boardWorkflows, workflowMode]);

  const selectedWorkflow = useMemo<BoardWorkflowDefinition | null>(() => {
    if (!workflowMode) return null;
    return workflowOptions.find((workflow) => workflow.id === selectedWorkflowId)
      ?? workflowOptions.find((workflow) => workflow.id === boardWorkflows?.defaultWorkflowId)
      ?? workflowOptions[0]
      ?? null;
  }, [boardWorkflows?.defaultWorkflowId, selectedWorkflowId, workflowMode, workflowOptions]);

  useEffect(() => {
    if (!workflowMode) {
      setSelectedWorkflowId(null);
      return;
    }
    if (selectedWorkflow && selectedWorkflow.id !== selectedWorkflowId) {
      setSelectedWorkflowId(selectedWorkflow.id);
    }
  }, [selectedWorkflow, selectedWorkflowId, workflowMode]);

  return {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    selectedWorkflowId,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
    setBoardWorkflowsState,
  };
}
