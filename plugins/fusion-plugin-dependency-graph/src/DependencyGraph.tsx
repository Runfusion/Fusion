import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import { GraphTaskNode } from "./GraphTaskNode";
import { GraphToolbar } from "./GraphToolbar";
import { GraphEdges } from "./edges";
import { filterGraphTasks } from "./filters";
import { computeAutoLayout } from "./layout";
import { useGraphData } from "./useGraphData";
import { useGraphInteraction } from "./useGraphInteraction";
import { useDependencyChain } from "./hooks/useDependencyChain";
import "./DependencyGraph.css";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;
const POSITION_STORAGE_KEY = "fusion-plugin-dependency-graph:positions";

function getScopedPositionItem(projectId?: string): string | null {
  if (typeof window === "undefined") return null;
  if (typeof window.localStorage?.getItem !== "function") return null;
  const key = projectId ? `kb:${projectId}:${POSITION_STORAGE_KEY}` : POSITION_STORAGE_KEY;
  return window.localStorage.getItem(key);
}

export interface DependencyGraphProps {
  tasks: Task[];
  projectId?: string;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenDetail?: (task: Task) => void;
  addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void;
  globalPaused?: boolean;
  onUpdateTask?: (id: string, updates: { title?: string; description?: string; dependencies?: string[] }) => Promise<Task>;
  onArchiveTask?: (id: string) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean }) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenDetailWithTab?: (task: Task, initialTab: "changes") => void;
  taskStuckTimeoutMs?: number;
  onOpenMission?: (missionId: string) => void;
  onMoveTask?: (id: string, column: Task["column"], optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  lastFetchTimeMs?: number;
  workflowStepNameLookup?: ReadonlyMap<string, string>;
}

const POINTER_MOVE_THRESHOLD = 4;

export function DependencyGraph({
  tasks,
  projectId,
  onOpenTaskDetail,
  onOpenDetail,
  addToast,
  globalPaused,
  onUpdateTask,
  onArchiveTask,
  onUnarchiveTask,
  onDeleteTask,
  onRetryTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
  onOpenMission,
  onMoveTask,
  lastFetchTimeMs,
  workflowStepNameLookup,
}: DependencyGraphProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const initialFitDoneRef = useRef(false);
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const pointerDraggedRef = useRef(false);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const filteredTasks = useMemo(() => filterGraphTasks(tasks), [tasks]);
  const graphData = useGraphData(filteredTasks);
  const { getChain } = useDependencyChain(filteredTasks);
  const activeTaskId = hoveredTaskId ?? selectedTaskId;
  const highlightedTaskIds = useMemo(() => (activeTaskId ? getChain(activeTaskId) : new Set<string>()), [activeTaskId, getChain]);

  const autoLayoutPositions = useMemo(
    () => computeAutoLayout(graphData, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, horizontalGap: 40, verticalGap: 80 }),
    [graphData],
  );
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(autoLayoutPositions);
  const [isNodeDragging, setIsNodeDragging] = useState(false);

  useEffect(() => {
    setPositions((current) => {
      const next = new Map<string, { x: number; y: number }>();
      for (const [taskId, layoutPosition] of autoLayoutPositions.entries()) {
        next.set(taskId, current.get(taskId) ?? layoutPosition);
      }
      return next;
    });
  }, [autoLayoutPositions]);

  const {
    transform,
    zoom,
    transitioning,
    zoomIn,
    zoomOut,
    resetView,
    fitToGraph,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheelZoom,
    handleKeyDown,
  } = useGraphInteraction();

  useEffect(() => {
    if (initialFitDoneRef.current) return;
    if (filteredTasks.length === 0) return;

    const hasSavedPositions = Boolean(getScopedPositionItem(projectId));
    if (hasSavedPositions) {
      initialFitDoneRef.current = true;
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
    initialFitDoneRef.current = true;
  }, [filteredTasks.length, fitToGraph, positions, projectId]);

  const bounds = useMemo(() => {
    const values = Array.from(positions.values());
    if (values.length === 0) return { width: 0, height: 0 };
    const maxX = Math.max(...values.map((pos) => pos.x + NODE_WIDTH));
    const maxY = Math.max(...values.map((pos) => pos.y + NODE_HEIGHT));
    return { width: maxX, height: maxY };
  }, [positions]);

  return (
    <section className="dependency-graph" data-testid="dependency-graph">
      <div
        ref={viewportRef}
        className="dependency-graph__viewport"
        onPointerDown={(event) => {
          if (isNodeDragging) return;
          pointerDownRef.current = { x: event.clientX, y: event.clientY };
          pointerDraggedRef.current = false;
          onPointerDown(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          if (isNodeDragging) return;
          const viewport = viewportRef.current;
          if (!viewport) return;
          const pointerDown = pointerDownRef.current;
          if (pointerDown) {
            const deltaX = Math.abs(event.clientX - pointerDown.x);
            const deltaY = Math.abs(event.clientY - pointerDown.y);
            if (deltaX > POINTER_MOVE_THRESHOLD || deltaY > POINTER_MOVE_THRESHOLD) {
              pointerDraggedRef.current = true;
            }
          }
          onPointerMove(event.pointerId, { x: event.clientX, y: event.clientY }, viewport.clientWidth, viewport.clientHeight);
        }}
        onPointerUp={(event) => {
          if (!isNodeDragging) {
            onPointerUp(event.pointerId);
          }
          pointerDownRef.current = null;
        }}
        onPointerCancel={(event) => {
          if (!isNodeDragging) {
            onPointerUp(event.pointerId);
          }
          pointerDownRef.current = null;
          pointerDraggedRef.current = false;
        }}
        onWheel={(event) => {
          event.preventDefault();
          const viewport = viewportRef.current;
          if (!viewport) return;
          const rect = viewport.getBoundingClientRect();
          onWheelZoom(event.deltaY, { x: event.clientX - rect.left, y: event.clientY - rect.top }, viewport.clientWidth, viewport.clientHeight);
        }}
        onKeyDown={(event) => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          handleKeyDown(event, viewport.clientWidth, viewport.clientHeight, positions, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}
        tabIndex={0}
        style={{ outline: "none" }}
        onClick={() => {
          if (pointerDraggedRef.current || isNodeDragging) return;
          setSelectedTaskId(null);
        }}
      >
        {filteredTasks.length === 0 ? (
          <div className="dependency-graph__empty">No active tasks to display in graph view.</div>
        ) : (
          <div className={`graph-canvas-transform${transitioning ? " graph-canvas-transform--animate" : ""}`} style={{ transform, width: `${bounds.width}px`, height: `${bounds.height}px` }}>
            <GraphEdges
              edges={graphData.edges}
              positions={positions}
              nodeWidth={NODE_WIDTH}
              nodeHeight={NODE_HEIGHT}
              highlightedEdgeIds={
                highlightedTaskIds.size > 0
                  ? new Set(
                      graphData.edges
                        .filter((edge) => highlightedTaskIds.has(edge.source) && highlightedTaskIds.has(edge.target))
                        .map((edge) => `${edge.source}->${edge.target}`),
                    )
                  : undefined
              }
            />
            <div className="dependency-graph__nodes-layer">
              {graphData.nodes.map((node) => {
                const position = positions.get(node.task.id);
                if (!position) return null;

                return (
                  <GraphTaskNode
                    key={node.task.id}
                    task={node.task}
                    projectId={projectId}
                    style={{ minHeight: `${NODE_HEIGHT}px`, left: `${position.x}px`, top: `${position.y}px` }}
                    position={position}
                    scale={zoom}
                    onNodePositionChange={(taskId, nextPosition) => {
                      setPositions((current) => {
                        const existing = current.get(taskId);
                        if (existing && existing.x === nextPosition.x && existing.y === nextPosition.y) return current;
                        const next = new Map(current);
                        next.set(taskId, nextPosition);
                        return next;
                      });
                    }}
                    onNodeDragStateChange={setIsNodeDragging}
                    isHighlighted={highlightedTaskIds.size > 0 && highlightedTaskIds.has(node.task.id)}
                    isDimmed={highlightedTaskIds.size > 0 && !highlightedTaskIds.has(node.task.id)}
                    onOpenDetail={onOpenDetail ?? ((task) => onOpenTaskDetail?.(task.id))}
                    addToast={addToast ?? (() => {})}
                    globalPaused={globalPaused}
                    onUpdateTask={onUpdateTask}
                    onArchiveTask={onArchiveTask}
                    onUnarchiveTask={onUnarchiveTask}
                    onDeleteTask={onDeleteTask}
                    onRetryTask={onRetryTask}
                    onOpenDetailWithTab={onOpenDetailWithTab}
                    taskStuckTimeoutMs={taskStuckTimeoutMs}
                    onOpenMission={onOpenMission}
                    onMoveTask={onMoveTask}
                    lastFetchTimeMs={lastFetchTimeMs}
                    workflowStepNameLookup={workflowStepNameLookup}
                    onMouseEnter={() => setHoveredTaskId(node.task.id)}
                    onMouseLeave={() => setHoveredTaskId(null)}
                    onClick={(event) => {
                      event.stopPropagation();
                      pointerDraggedRef.current = false;
                      setSelectedTaskId((current) => (current === node.task.id ? null : node.task.id));
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      <GraphToolbar
        zoom={zoom}
        onZoomIn={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          zoomIn(viewport.clientWidth, viewport.clientHeight);
        }}
        onZoomOut={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          zoomOut(viewport.clientWidth, viewport.clientHeight);
        }}
        onFitToGraph={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}
        onResetView={resetView}
      />
    </section>
  );
}
