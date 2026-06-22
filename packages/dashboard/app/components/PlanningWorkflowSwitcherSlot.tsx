import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchBoardWorkflows, type BoardWorkflowDefinition, type BoardWorkflowsPayload } from "../api";
import { subscribeSse } from "../sse-bus";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";
import { readBoardWorkflowsCache, writeBoardWorkflowsCache } from "../utils/boardWorkflowsCache";

/*
FNXC:PlanningWorkflowSwitcher 2026-06-22-00:00:
The Planning view must surface the SAME workflow dropdown as the Board, in the SAME location (the Header `#header-workflow-slot`). Board owns its own switcher only while the board is active, so Planning needs a self-contained mirror that fetches/caches board-workflows, tracks local selection, and portals the identical `board-workflow-toolbar > board-workflow-selector > WorkflowSwitcher` markup into the header slot. We intentionally do NOT import Board (the board switcher is tied to board lifecycle/state).

Self-contained replication of Board's board-workflows fetch/cache/SSE-refresh path (Board.tsx ~370-470, ~607-637): refresh on mount, visibility/focus, and `workflow:created|updated|deleted` SSE, guarded by a monotonic sequence ref and persisted via the shared session cache. Gate render exactly like Board: only show when there is something to switch (workflow mode on AND >= 2 workflow options).
*/

interface PlanningWorkflowSwitcherSlotProps {
  projectId?: string;
  onOpenWorkflowEditor?: () => void;
  onCreateWorkflow?: () => void;
}

// Counts require live task/column data that Planning does not thread here.
// WorkflowSwitcher renders zero counts for an empty map, so pass a stable empty Map
// rather than threading tasks into the Planning view.
const EMPTY_COUNTS: Map<string, WorkflowStatusCounts> = new Map();

export function PlanningWorkflowSwitcherSlot({ projectId, onOpenWorkflowEditor, onCreateWorkflow }: PlanningWorkflowSwitcherSlotProps) {
  const [boardWorkflowsState, setBoardWorkflowsState] = useState<{ projectId?: string; payload: BoardWorkflowsPayload } | null>(() => {
    const cached = readBoardWorkflowsCache(projectId);
    return cached ? { projectId, payload: cached } : null;
  });
  const boardWorkflows = boardWorkflowsState?.projectId === projectId && boardWorkflowsState ? boardWorkflowsState.payload : null;
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Header may mount its workflow slot after this component, so resolve it on mount
  // and re-resolve via a short polling effect until it attaches. Render only via portal.
  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });

  // Stale-response guard: drop out-of-order board-workflows responses.
  const boardWorkflowsFetchSeqRef = useRef(0);

  useEffect(() => {
    const cached = readBoardWorkflowsCache(projectId);
    setBoardWorkflowsState(cached ? { projectId, payload: cached } : null);
  }, [projectId]);

  /*
  FNXC:PlanningWorkflowSwitcher 2026-06-22-00:00:
  Opening the switcher must refresh the payload because task workflow assignment changes do not emit workflow-definition SSE events. Shared by mount, visibility/focus, and workflow-definition SSE refetches so the stale guard and cache writes stay identical to Board.
  */
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
  }, [projectId]);

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
      boardWorkflowsFetchSeqRef.current++;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("focus", onVisible);
      unsubscribe();
    };
  }, [projectId, refreshBoardWorkflows]);

  // Attach to the header slot once the Header mounts it. Poll briefly until present.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolve = () => {
      const slot = document.getElementById("header-workflow-slot");
      setHeaderWorkflowSlot((prev) => (prev === slot ? prev : slot));
      return slot;
    };
    if (resolve()) return;
    const interval = window.setInterval(() => {
      if (resolve()) window.clearInterval(interval);
    }, 250);
    return () => window.clearInterval(interval);
  }, []);

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

  // Gate: only render when there is something to switch (>= 2 options), matching Board's "show only when switchable" intent.
  if (!workflowMode || !selectedWorkflow || workflowOptions.length < 2 || !headerWorkflowSlot) {
    return null;
  }

  const workflowToolbar = (
    <div className="board-workflow-toolbar">
      <div className="board-workflow-selector">
        <WorkflowSwitcher
          workflows={workflowOptions}
          value={selectedWorkflow.id}
          onChange={setSelectedWorkflowId}
          counts={EMPTY_COUNTS}
          onOpen={refreshBoardWorkflows}
          onEditWorkflow={onOpenWorkflowEditor}
          onCreateWorkflow={onCreateWorkflow}
        />
      </div>
    </div>
  );

  return createPortal(workflowToolbar, headerWorkflowSlot);
}
