import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  fetchBoardWorkflows as defaultFetchBoardWorkflows,
  type BoardWorkflowDefinition,
  type BoardWorkflowsPayload,
} from "../api";
import { setProjectBoardSelectedWorkflow as defaultPersistBoardWorkflowSelection } from "../api/system/workflows";
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
import { notifyWorkflowSettingValuesUpdatedFromSse } from "../utils/workflowSettingValuesEvents";

/*
FNXC:Workflows 2026-06-22-17:00:
Single source of truth for board-workflow fetch/cache/SSE/selection, shared verbatim by Board.tsx and the Planning header slot (PlanningWorkflowSwitcherSlot.tsx). Both surfaces must show the SAME workflow dropdown driven by the SAME data path: refetch on mount, on tab visibility/focus, and on `workflow:created|updated|deleted` SSE; every fetch is guarded by a monotonic sequence ref that drops out-of-order responses; successful payloads persist to the per-project session cache. Selection (`selectedWorkflowId`) hydrates from project-scoped durable storage, user changes write immediately, and stale stored ids are repaired only after the current payload proves the workflow no longer exists.

FNXC:Workflows 2026-06-29-14:45:
Transient board-workflows fetch failures are not authoritative workflow-mode disable signals. Preserve the last payload and durable workflow selection on API/focus/refresh blips so operators return to their selected lane unless the server explicitly returns workflow mode off, an empty list, or a single unswitchable workflow.

Per-consumer subscription semantics are preserved: each call to this hook installs its OWN visibilitychange/focus listeners and its OWN SSE subscription, so two consumers (Board + Planning slot) each subscribe and unsubscribe independently — the hook does not dedupe across consumers. Dependencies (fetch, subscribeSse, cache helpers) are injectable to keep the hook DI-friendly and free of App-level singletons.
*/

export interface UseBoardWorkflowsParams {
  projectId?: string;
  fetchBoardWorkflows?: typeof defaultFetchBoardWorkflows;
  subscribeSse?: typeof defaultSubscribeSse;
  readBoardWorkflowsCache?: typeof defaultReadBoardWorkflowsCache;
  writeBoardWorkflowsCache?: typeof defaultWriteBoardWorkflowsCache;
  clearBoardWorkflowsCache?: typeof defaultClearBoardWorkflowsCache;
  /**
   * FNXC:OriginWorkflowSelection 2026-07-26-19:40:
   * Server-side mirror of the operator's lane, so `fn task create` / `fn_task_create` /
   * refinement can resolve the "Selected workflow" option of `taskCreateWorkflowId` /
   * `refinementTaskWorkflowId`. Injectable like the other deps to keep the hook testable.
   */
  persistBoardWorkflowSelection?: typeof defaultPersistBoardWorkflowSelection;
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
   *  task missing from `taskWorkflowIds`, since task→workflow assignment emits no workflow SSE).
   *  Resolves when the fetch has SETTLED — it never rejects, since a failed fetch is
   *  non-authoritative — so a caller that must not overlap attempts can await it. */
  refreshBoardWorkflows: (options?: { forceFresh?: boolean; taskIds?: readonly string[] }) => Promise<void>;
  /**
   * Raw state setter, exposed so Board can apply optimistic task→workflow assignment.
   * Planning does not use this.
   */
  setBoardWorkflowsState: Dispatch<SetStateAction<{ projectId?: string; payload: BoardWorkflowsPayload } | null>>;
}

export function useBoardWorkflows(params: UseBoardWorkflowsParams): UseBoardWorkflowsResult {
  const {
    projectId,
    fetchBoardWorkflows = defaultFetchBoardWorkflows,
    subscribeSse = defaultSubscribeSse,
    readBoardWorkflowsCache = defaultReadBoardWorkflowsCache,
    writeBoardWorkflowsCache = defaultWriteBoardWorkflowsCache,
    clearBoardWorkflowsCache = defaultClearBoardWorkflowsCache,
    persistBoardWorkflowSelection = defaultPersistBoardWorkflowSelection,
  } = params;

  const [boardWorkflowsState, setBoardWorkflowsState] = useState<{ projectId?: string; payload: BoardWorkflowsPayload } | null>(() => {
    const cached = readBoardWorkflowsCache(projectId);
    return cached ? { projectId, payload: cached } : null;
  });
  const boardWorkflows = boardWorkflowsState?.projectId === projectId && boardWorkflowsState ? boardWorkflowsState.payload : null;
  const [selectedWorkflowId, setSelectedWorkflowIdState] = useState<string | null>(() => readBoardWorkflowViewSelection(projectId));
  const storedSelectionRef = useRef<string | null>(selectedWorkflowId);
  /** Lane mirror queued by the user-driven setter; `undefined` = nothing to flush. */
  const pendingLaneMirrorRef = useRef<string | null | undefined>(undefined);

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
      /*
      FNXC:OriginWorkflowSelection 2026-07-26-19:40:
      Queue the server-side lane mirror only on this USER-driven setter, not on the
      stale-selection repair effect below — the mirror should track what the operator chose,
      not the hook's own bookkeeping. The all-workflows sentinel is a Board-only view, never
      a real workflow id, so it queues a CLEAR rather than being persisted as an id.
      Queued, not issued here: React may invoke a state updater more than once for a single
      change, and firing a request from inside one produced duplicate writes and a render
      loop. The flush effect below owns the actual call.
      */
      pendingLaneMirrorRef.current = resolvedSelection && resolvedSelection !== ALL_WORKFLOWS_BOARD_VIEW_ID
        ? resolvedSelection
        : null;
      return resolvedSelection;
    });
  }, [projectId]);

  /*
  FNXC:OriginWorkflowSelection 2026-07-26-19:40:
  Flush the queued lane mirror after commit. `undefined` means "nothing queued" — distinct
  from `null`, which is a real instruction to CLEAR the mirror — so the effect is a no-op on
  mount and on every render the operator did not drive. Unkeyed on purpose: it must run after
  whichever commit the setter's update landed in, and the ref latch already bounds it to one
  request per operator action.
  The promise is unawaited and its rejection swallowed: localStorage already holds the
  authoritative selection, so a failed mirror must never revert or block the lane switch.
  */
  useEffect(() => {
    const pending = pendingLaneMirrorRef.current;
    if (pending === undefined) return;
    pendingLaneMirrorRef.current = undefined;
    void persistBoardWorkflowSelection(pending, projectId).catch(() => {});
  });

  // Stale-response guard: a monotonic sequence ref drops out-of-order responses.
  const boardWorkflowsFetchSeqRef = useRef(0);

  // Re-hydrate from the per-project cache on project change.
  useEffect(() => {
    const cached = readBoardWorkflowsCache(projectId);
    const storedSelection = readBoardWorkflowViewSelection(projectId);
    storedSelectionRef.current = storedSelection;
    setSelectedWorkflowIdState(storedSelection);
    setBoardWorkflowsState(cached ? { projectId, payload: cached } : null);
  }, [projectId, readBoardWorkflowsCache]);

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  RETURNS its settle promise now (additive — existing callers ignore it). The
  unmapped-workflow repair needs to know when a forced refresh has SETTLED: on a slow
  request it was starting its second attempt on a fixed 250ms timer while the first was
  still in flight, so both attempts could be spent before either answer arrived. The
  promise never rejects — a failed fetch stays non-authoritative — so awaiting it is
  safe for every caller.
  */
  const refreshBoardWorkflows = useCallback((options?: { forceFresh?: boolean; taskIds?: readonly string[] }): Promise<void> => {
    const seq = ++boardWorkflowsFetchSeqRef.current;
    if (options?.forceFresh) {
      clearBoardWorkflowsCache(projectId);
    }
    const fetchPromise = options === undefined
      ? fetchBoardWorkflows(projectId)
      : fetchBoardWorkflows(projectId, options);
    return fetchPromise
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
    /*
    FNXC:BoardWorkflows 2026-07-26-15:14:
    The visibilitychange/focus listeners above cover a backgrounded tab, but not an error-driven SSE
    reconnect while the tab stays visible, during which workflow mutations are dropped. Declare the
    resync on the subscription itself so recovery does not depend on which of the two paths fired.
    */
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      onReconnect: forceRefreshBoardWorkflows,
      events: {
        "workflow:created": forceRefreshBoardWorkflows,
        "workflow:updated": forceRefreshBoardWorkflows,
        "workflow:deleted": forceRefreshBoardWorkflows,
        "workflow:setting-values-updated": (event: MessageEvent) => {
          try {
            notifyWorkflowSettingValuesUpdatedFromSse(JSON.parse(event.data) as Record<string, unknown>);
          } catch {
            // Malformed SSE payloads are non-authoritative and cannot invalidate a card.
          }
        },
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

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
  Workflow mode is now "this project resolved at least one lane", nothing else.
  The former `flagEnabled === true` conjunct is DELETED: the server hardcodes that
  field to `true` (`buildBoardWorkflowsPayload`), so it could only ever narrow the
  result to itself. Reading it kept a retired kill switch alive on the client, one
  stale payload away from silently reverting every consumer to the legacy board.
  */
  const workflowMode = Boolean(boardWorkflows?.workflows.length);

  const workflowOptions = useMemo<BoardWorkflowDefinition[]>(() => {
    if (!workflowMode || !boardWorkflows) return [];
    /*
    FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
    The payload retains disabled definitions only for cards with explicit legacy
    assignments. Switcher options must use the server's selectable marker so
    those compatibility lanes cannot leak into any shared picker.
    */
    return boardWorkflows.workflows
      .filter((workflow) => workflow.selectable !== false)
      .sort((a, b) => {
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
