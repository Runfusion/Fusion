import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  fetchBoardWorkflows as defaultFetchBoardWorkflows,
  type BoardWorkflowDefinition,
  type BoardWorkflowsPayload,
} from "../api";
import { subscribeSse as defaultSubscribeSse } from "../sse-bus";
import {
  clearBoardWorkflowsCache as defaultClearBoardWorkflowsCache,
  readBoardWorkflowsCache as defaultReadBoardWorkflowsCache,
  writeBoardWorkflowsCache as defaultWriteBoardWorkflowsCache,
} from "../utils/boardWorkflowsCache";
import {
  ALL_WORKFLOWS_BOARD_VIEW_ID,
  readBoardWorkflowViewSelection,
  removeBoardWorkflowSelection,
  writeBoardWorkflowSelection,
} from "../utils/boardWorkflowSelection";

/*
FNXC:Workflows 2026-06-22-17:00:
Single source of truth for board-workflow fetch/cache/SSE/selection, shared verbatim by Board.tsx and the Planning header slot (PlanningWorkflowSwitcherSlot.tsx). Both surfaces must show the SAME workflow dropdown driven by the SAME data path: refetch on mount, on tab visibility/focus, and on `workflow:created|updated|deleted` SSE; every fetch is guarded by a monotonic sequence ref that drops out-of-order responses; successful payloads persist to the per-project session cache. Selection (`selectedWorkflowId`) hydrates from project-scoped durable storage, user changes write immediately, and stale stored ids are repaired only after the current payload proves the workflow no longer exists.

FNXC:Workflows 2026-06-29-14:45:
Transient board-workflows fetch failures are not authoritative workflow-mode disable signals. Preserve the last payload and durable workflow selection on API/focus/refresh blips so operators return to their selected lane unless the server explicitly returns workflow mode off, an empty list, or a single unswitchable workflow.

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
  clearBoardWorkflowsCache?: typeof defaultClearBoardWorkflowsCache;
}

export interface UseBoardWorkflowsResult {
  /** Raw payload for the current project, or null when unloaded / project mismatch. */
  boardWorkflows: BoardWorkflowsPayload | null;
  /** True when the flag is on AND at least one workflow is defined. */
  workflowMode: boolean;
  /** Workflows sorted with the default first, then alphabetical. Empty unless in workflow mode. */
  workflowOptions: BoardWorkflowDefinition[];
  /** Currently selected real workflow (resolved from selection / default / first), or null. */
  selectedWorkflow: BoardWorkflowDefinition | null;
  selectedWorkflowId: string | null;
  /** True when the dashboard-only aggregate workflow view is selected. */
  isAllWorkflowsSelected: boolean;
  setSelectedWorkflowId: Dispatch<SetStateAction<string | null>>;
  /** Force a fresh fetch (used on switcher open, and when the board detects a rendered
   *  task missing from `taskWorkflowIds`, since task→workflow assignment emits no workflow SSE). */
  refreshBoardWorkflows: (options?: { forceFresh?: boolean }) => void;
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
    clearBoardWorkflowsCache = defaultClearBoardWorkflowsCache,
  } = params;

  const [boardWorkflowsState, setBoardWorkflowsState] = useState<{ projectId?: string; payload: BoardWorkflowsPayload } | null>(() => {
    const cached = shouldHydrateCache ? readBoardWorkflowsCache(projectId) : null;
    return cached ? { projectId, payload: cached } : null;
  });
  const boardWorkflows = boardWorkflowsState?.projectId === projectId && boardWorkflowsState ? boardWorkflowsState.payload : null;
  const [selectedWorkflowId, setSelectedWorkflowIdState] = useState<string | null>(() => readBoardWorkflowViewSelection(projectId));
  const storedSelectionRef = useRef<string | null>(selectedWorkflowId);

  const setSelectedWorkflowId = useCallback<Dispatch<SetStateAction<string | null>>>((nextSelection) => {
    setSelectedWorkflowIdState((previousSelection) => {
      const resolvedSelection = typeof nextSelection === "function"
        ? nextSelection(previousSelection)
        : nextSelection;
      storedSelectionRef.current = resolvedSelection;
      if (resolvedSelection) {
        writeBoardWorkflowSelection(projectId, resolvedSelection);
      } else {
        removeBoardWorkflowSelection(projectId);
      }
      return resolvedSelection;
    });
  }, [projectId]);

  // Stale-response guard: a monotonic sequence ref drops out-of-order responses.
  const boardWorkflowsFetchSeqRef = useRef(0);

  // Re-hydrate from the per-project cache on project change (and gate change).
  useEffect(() => {
    const cached = shouldHydrateCache ? readBoardWorkflowsCache(projectId) : null;
    const storedSelection = readBoardWorkflowViewSelection(projectId);
    storedSelectionRef.current = storedSelection;
    setSelectedWorkflowIdState(storedSelection);
    setBoardWorkflowsState(cached ? { projectId, payload: cached } : null);
  }, [projectId, shouldHydrateCache, readBoardWorkflowsCache]);

  const refreshBoardWorkflows = useCallback((options?: { forceFresh?: boolean }) => {
    const seq = ++boardWorkflowsFetchSeqRef.current;
    if (options?.forceFresh) {
      clearBoardWorkflowsCache(projectId);
    }
    const fetchPromise = options === undefined
      ? fetchBoardWorkflows(projectId)
      : fetchBoardWorkflows(projectId, options);
    fetchPromise
      .then((payload) => {
        if (seq === boardWorkflowsFetchSeqRef.current) {
          setBoardWorkflowsState({ projectId, payload });
          writeBoardWorkflowsCache(projectId, payload);
        }
      })
      .catch(() => {
        // Fetch failures are non-authoritative: keep the current/cache-hydrated payload so the cleanup effect does not erase durable selection.
      });
  }, [projectId, fetchBoardWorkflows, writeBoardWorkflowsCache, clearBoardWorkflowsCache]);

  useEffect(() => {
    refreshBoardWorkflows();
    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") refreshBoardWorkflows();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener("focus", onVisible);
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const forceRefreshBoardWorkflows = () => refreshBoardWorkflows({ forceFresh: true });
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "workflow:created": forceRefreshBoardWorkflows,
        "workflow:updated": forceRefreshBoardWorkflows,
        "workflow:deleted": forceRefreshBoardWorkflows,
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

  const isAllWorkflowsSelected = selectedWorkflowId === ALL_WORKFLOWS_BOARD_VIEW_ID;

  const selectedWorkflow = useMemo<BoardWorkflowDefinition | null>(() => {
    if (!workflowMode) return null;
    return workflowOptions.find((workflow) => workflow.id === selectedWorkflowId)
      ?? workflowOptions.find((workflow) => workflow.id === boardWorkflows?.defaultWorkflowId)
      ?? workflowOptions[0]
      ?? null;
  }, [boardWorkflows?.defaultWorkflowId, selectedWorkflowId, workflowMode, workflowOptions]);

  useEffect(() => {
    if (!boardWorkflows) {
      return;
    }

    if (!workflowMode) {
      if (storedSelectionRef.current !== null) {
        removeBoardWorkflowSelection(projectId);
        storedSelectionRef.current = null;
      }
      setSelectedWorkflowIdState(null);
      return;
    }

    if (workflowOptions.length < 2) {
      if (storedSelectionRef.current !== null) {
        removeBoardWorkflowSelection(projectId);
        storedSelectionRef.current = null;
      }
      setSelectedWorkflowIdState(selectedWorkflow?.id ?? null);
      return;
    }

    if (isAllWorkflowsSelected) {
      return;
    }

    if (selectedWorkflow && selectedWorkflow.id !== selectedWorkflowId) {
      const shouldRepairStoredSelection = storedSelectionRef.current !== null;
      setSelectedWorkflowIdState(selectedWorkflow.id);
      if (shouldRepairStoredSelection) {
        writeBoardWorkflowSelection(projectId, selectedWorkflow.id);
        storedSelectionRef.current = selectedWorkflow.id;
      }
    }
  }, [boardWorkflows, isAllWorkflowsSelected, projectId, selectedWorkflow, selectedWorkflowId, workflowMode, workflowOptions.length]);

  return {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    selectedWorkflowId,
    isAllWorkflowsSelected,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
    setBoardWorkflowsState,
  };
}
