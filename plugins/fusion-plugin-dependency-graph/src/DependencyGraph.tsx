import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import { GraphTaskNode } from "./GraphTaskNode.js";
import { GraphToolbar } from "./GraphToolbar.js";
import { GraphEdges } from "./edges.js";
import { filterGraphTasks } from "./filters.js";
import { computeAutoLayout } from "./layout.js";
import { useGraphData } from "./useGraphData.js";
import { useGraphInteraction } from "./useGraphInteraction.js";
import { useDependencyChain } from "./hooks/useDependencyChain.js";
import { useGraphPositions } from "./hooks/useGraphPositions.js";
import { mergePositions, type NodePositions } from "./utils/graphPositionStorage.js";
import "./DependencyGraph.css";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;

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
  const visibleTaskIds = useMemo(() => new Set(filteredTasks.map((task) => task.id)), [filteredTasks]);
  const { savedPositions, persistPositions, clearSavedPositions } = useGraphPositions({ projectId, visibleTaskIds });
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(autoLayoutPositions);
  const [isNodeDragging, setIsNodeDragging] = useState(false);

  useEffect(() => {
    const autoLayoutRecord: NodePositions = {};
    for (const [taskId, position] of autoLayoutPositions.entries()) {
      autoLayoutRecord[taskId] = position;
    }

    const merged = savedPositions ? mergePositions(autoLayoutRecord, savedPositions, visibleTaskIds) : autoLayoutRecord;
    setPositions(new Map(Object.entries(merged)));
  }, [autoLayoutPositions, savedPositions, visibleTaskIds]);

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
    onWheelPan,
    onWheelZoom,
    handleKeyDown,
    setGraphBounds,
  } = useGraphInteraction();

  useEffect(() => {
    if (initialFitDoneRef.current) return;
    if (filteredTasks.length === 0) return;

    const hasSavedPositions = Boolean(savedPositions && Object.keys(savedPositions).length > 0);
    if (hasSavedPositions) {
      initialFitDoneRef.current = true;
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
    initialFitDoneRef.current = true;
  }, [filteredTasks.length, fitToGraph, positions, savedPositions]);

  const bounds = useMemo(() => {
    const values = Array.from(positions.values());
    if (values.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    }

    const minX = Math.min(...values.map((pos) => pos.x));
    const minY = Math.min(...values.map((pos) => pos.y));
    const maxX = Math.max(...values.map((pos) => pos.x + NODE_WIDTH));
    const maxY = Math.max(...values.map((pos) => pos.y + NODE_HEIGHT));

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  }, [positions]);

  const normalizedPositions = useMemo(() => {
    if (positions.size === 0) return positions;
    const next = new Map<string, { x: number; y: number }>();
    for (const [taskId, position] of positions.entries()) {
      next.set(taskId, { x: position.x - bounds.minX, y: position.y - bounds.minY });
    }
    return next;
  }, [bounds.minX, bounds.minY, positions]);

  useEffect(() => {
    setGraphBounds({ minX: 0, minY: 0, maxX: bounds.width, maxY: bounds.height });
  }, [bounds.height, bounds.width, setGraphBounds]);

  const handleResetLayout = useCallback(() => {
    clearSavedPositions();
    const freshLayout = computeAutoLayout(graphData, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, horizontalGap: 40, verticalGap: 80 });
    setPositions(freshLayout);
  }, [clearSavedPositions, graphData]);

  const handleNodeDragEnd = useCallback(() => {
    const positionRecord: NodePositions = {};
    for (const [taskId, position] of positions.entries()) {
      positionRecord[taskId] = position;
    }
    persistPositions(positionRecord);
  }, [persistPositions, positions]);

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

          if (event.ctrlKey || event.metaKey) {
            const rect = viewport.getBoundingClientRect();
            onWheelZoom(event.deltaY, { x: event.clientX - rect.left, y: event.clientY - rect.top }, viewport.clientWidth, viewport.clientHeight);
            return;
          }

          onWheelPan(event.deltaX, event.deltaY, viewport.clientWidth, viewport.clientHeight);
        }}
        onKeyDown={(event) => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          handleKeyDown(event, viewport.clientWidth, viewport.clientHeight, normalizedPositions, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}
        tabIndex={0}
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
              positions={normalizedPositions}
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
                const position = normalizedPositions.get(node.task.id);
                if (!position) return null;

                return (
                  <GraphTaskNode
                    key={node.task.id}
                    task={node.task}
                    projectId={projectId}
                    isSelected={selectedTaskId === node.task.id}
                    style={{ minHeight: `${NODE_HEIGHT}px`, left: `${position.x}px`, top: `${position.y}px` }}
                    position={position}
                    scale={zoom}
                    onNodePositionChange={(taskId, nextPosition) => {
                      setPositions((current) => {
                        const denormalizedPosition = { x: nextPosition.x + bounds.minX, y: nextPosition.y + bounds.minY };
                        const existing = current.get(taskId);
                        if (existing && existing.x === denormalizedPosition.x && existing.y === denormalizedPosition.y) return current;
                        const next = new Map(current);
                        next.set(taskId, denormalizedPosition);
                        return next;
                      });
                    }}
                    onNodeDragStateChange={setIsNodeDragging}
                    onNodeDragEnd={handleNodeDragEnd}
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
          handleResetLayout();
          const viewport = viewportRef.current;
          if (!viewport) return;
          const freshLayout = computeAutoLayout(graphData, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, horizontalGap: 40, verticalGap: 80 });
          const normalizedFreshLayout = new Map<string, { x: number; y: number }>();
          const values = Array.from(freshLayout.values());
          const minX = values.length > 0 ? Math.min(...values.map((position) => position.x)) : 0;
          const minY = values.length > 0 ? Math.min(...values.map((position) => position.y)) : 0;
          for (const [taskId, position] of freshLayout.entries()) {
            normalizedFreshLayout.set(taskId, { x: position.x - minX, y: position.y - minY });
          }
          fitToGraph(normalizedFreshLayout, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}
        onResetView={() => {
          handleResetLayout();
          resetView();
        }}
      />
    </section>
  );
}
