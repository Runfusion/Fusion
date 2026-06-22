import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import { GraphTaskNode } from "./GraphTaskNode.js";
import { GraphToolbar } from "./GraphToolbar.js";
import { GraphEdges } from "./edges.js";
import { filterGraphTasks } from "./filters.js";
import { computeAutoLayout, type LayoutOptions } from "./layout.js";
import { useGraphData } from "./useGraphData.js";
import { useGraphInteraction } from "./useGraphInteraction.js";
import { useDependencyChain } from "./hooks/useDependencyChain.js";
import { useGraphPositions } from "./hooks/useGraphPositions.js";
import { mergePositions, type NodePositions } from "./utils/graphPositionStorage.js";
import "./DependencyGraph.css";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;
const NARROW_VIEWPORT_WIDTH = 768;

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
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const pointerDraggedRef = useRef(false);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(new Map());
  const filteredTasks = useMemo(() => filterGraphTasks(tasks), [tasks]);
  const graphData = useGraphData(filteredTasks);
  const { getChain } = useDependencyChain(filteredTasks);
  const activeTaskId = hoveredTaskId ?? selectedTaskId;
  const highlightedTaskIds = useMemo(() => (activeTaskId ? getChain(activeTaskId) : new Set<string>()), [activeTaskId, getChain]);
  const orientation = useMemo<NonNullable<LayoutOptions["orientation"]>>(() => {
    const width = viewportSize.width || (typeof window !== "undefined" ? window.innerWidth : 0);
    const height = viewportSize.height || (typeof window !== "undefined" ? window.innerHeight : 0);
    return height > width || width < NARROW_VIEWPORT_WIDTH ? "horizontal" : "vertical";
  }, [viewportSize.height, viewportSize.width]);
  const layoutOptions = useMemo<LayoutOptions>(
    () => ({
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
      horizontalGap: 40,
      verticalGap: 80,
      orientation,
      measuredHeights,
    }),
    [measuredHeights, orientation],
  );

  const autoLayoutPositions = useMemo(() => computeAutoLayout(graphData, layoutOptions), [graphData, layoutOptions]);
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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateViewportSize = (width: number, height: number) => {
      setViewportSize((current) => {
        if (current.width === width && current.height === height) return current;
        return { width, height };
      });
    };

    if (typeof ResizeObserver === "undefined") {
      updateViewportSize(
        viewport.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0),
        viewport.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 0),
      );
      return;
    }

    updateViewportSize(viewport.clientWidth, viewport.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateViewportSize(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const relevantTaskIds = new Set(graphData.nodes.map((node) => node.task.id));
    const nextRefs = new Map<string, HTMLDivElement>();
    for (const taskId of relevantTaskIds) {
      const element = viewport.querySelector<HTMLDivElement>(`[data-testid="graph-task-node-${taskId}"]`);
      if (element) {
        nextRefs.set(taskId, element);
      }
    }
    nodeRefs.current = nextRefs;

    setMeasuredHeights((current) => {
      let changed = false;
      const next = new Map<string, number>();
      for (const [taskId, height] of current.entries()) {
        if (!relevantTaskIds.has(taskId)) {
          changed = true;
          continue;
        }
        next.set(taskId, height);
      }
      return changed ? next : current;
    });

    const updateHeightForTask = (taskId: string, height: number) => {
      setMeasuredHeights((current) => {
        const previous = current.get(taskId);
        if (previous !== undefined && Math.abs(previous - height) < 1) {
          return current;
        }
        const next = new Map(current);
        next.set(taskId, height);
        return next;
      });
    };

    for (const [taskId, element] of nextRefs.entries()) {
      updateHeightForTask(taskId, element.offsetHeight || NODE_HEIGHT);
    }

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLDivElement;
        const taskId = Array.from(nextRefs.entries()).find(([, refElement]) => refElement === element)?.[0];
        if (!taskId) continue;
        updateHeightForTask(taskId, element.offsetHeight || NODE_HEIGHT);
      }
    });

    for (const element of nextRefs.values()) {
      observer.observe(element);
    }

    return () => observer.disconnect();
  }, [graphData.nodes, positions, viewportSize.height, viewportSize.width]);

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

  const bounds = useMemo(() => {
    const values = Array.from(positions.values());
    if (values.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    }

    const minX = Math.min(...values.map((pos) => pos.x));
    const minY = Math.min(...values.map((pos) => pos.y));
    const maxX = Math.max(...values.map((pos) => pos.x + NODE_WIDTH));
    const maxY = Math.max(...Array.from(positions.entries()).map(([taskId, pos]) => pos.y + (measuredHeights.get(taskId) ?? NODE_HEIGHT)));

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  }, [measuredHeights, positions]);

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

  /*
  FNXC:Graph 2026-06-23-00:10:
  The Graph view must load CENTERED/fit in the viewport. This is a custom transform-based
  canvas (not React Flow), so "fit" = compute zoom/pan from node positions via fitToGraph.
  Two failure modes were producing an off-center / not-fit initial load:
  1. Async nodes: tasks (and their computed `positions`) arrive after first paint. The old
     guard latched `initialFitDoneRef` on the FIRST run, so it fit an empty/half-laid-out
     graph (positions still stale, viewport unmeasured) and never re-fit once real nodes existed.
  2. Re-entering the view: this component stays mounted when the user navigates away and back,
     so a latched ref meant no re-fit on re-activation.
  Fix: only fit once the graph is actually fittable — viewport measured (width/height > 0) AND
  positions populated — and re-fit whenever the fitted geometry changes so a fresh or newly
  settled node set centers. Guard against fitting an empty graph. User-saved positions preserve
  relative node placement, but still fit into the visible viewport so the whole graph cannot load
  off screen.

  FNXC:Graph 2026-06-22-13:25:
  Loading Graph view must always hit fit-to-graph after layout settles, including graphs with saved
  manual node positions. The fit signature includes viewport size, bounds, and measured node heights
  so a late height/ResizeObserver settle re-fits automatically instead of leaving cards off screen.

  FNXC:Graph 2026-06-23-02:45:
  Remaining "must click+drag once to recenter" bug was a coordinate-space + ordering race, NOT
  just a measurement race:
  - `fitToGraph` internally calls `clampPan`, which clamps against `graphBoundsRef` populated by
    the `setGraphBounds` effect (immediately above) from NORMALIZED bounds (minX/minY shifted to 0).
    On the first paint that ref is still its initial `{0,0,0,0}`, so `clampPan` took its degenerate
    branch and clamped pan to ±viewport — visibly off-center. The fit never re-ran when bounds
    later committed; only a manual drag re-clamped against correct bounds and snapped it centered.
    This effect is now placed AFTER the setGraphBounds effect so, within a render commit, the
    bounds ref is updated before the fit runs.
  - We were also feeding raw `positions` (possibly non-zero minX/minY) to `fitToGraph` while the
    canvas renders `normalizedPositions` (origin at 0,0). Fit must run on the SAME space the DOM
    and `graphBoundsRef` use, so we fit on `normalizedPositions`.
  Robust fix:
  1. Fit on `normalizedPositions` so fit-space == render-space == clamp-bounds-space.
  2. Defer the fit one paint via double `requestAnimationFrame` so the just-committed normalized
     bounds are guaranteed live in `graphBoundsRef` before `clampPan` runs (rAF is allowed in the
     plugin runtime; no eslint/no-restricted-globals rule forbids it here). Falls back to a
     synchronous fit when rAF is unavailable (test/SSR), where effects in the same commit have
     already set the bounds ref.
  3. ResizeObserver (above) still drives the hidden→visible 0→N transition and later resizes; this
     effect keys on `viewportSize` so a fit is (re)attempted the moment a real non-zero size lands.
  First real paint now centers with zero user input, including navigating INTO the graph view.
  */
  // Stable signature of the current fitted geometry; changes when nodes, viewport,
  // bounds, or measured heights settle so we re-center after the graph has its
  // real box instead of latching an early off-screen layout.
  const fitNodeKey = useMemo(
    () => Array.from(normalizedPositions.keys()).sort().join("|"),
    [normalizedPositions],
  );
  const fitGeometryKey = useMemo(
    () => [
      fitNodeKey,
      viewportSize.width,
      viewportSize.height,
      bounds.width,
      bounds.height,
      Array.from(measuredHeights.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([id, height]) => `${id}:${Math.round(height)}`).join("|"),
    ].join("::"),
    [bounds.height, bounds.width, fitNodeKey, measuredHeights, viewportSize.height, viewportSize.width],
  );
  const lastFittedGeometryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (filteredTasks.length === 0) return;
    if (normalizedPositions.size === 0) return;

    const viewport = viewportRef.current;
    if (!viewport) return;
    // Viewport not yet measured: a 0-sized fit would mis-center. Wait for ResizeObserver.
    const viewportWidth = viewport.clientWidth || viewportSize.width;
    const viewportHeight = viewport.clientHeight || viewportSize.height;
    if (viewportWidth === 0 || viewportHeight === 0) return;

    // Re-fit on initial load and whenever layout geometry settles. This includes
    // saved/manual positions: saved positions should preserve node placement, not
    // allow the entire graph to load off screen.
    if (lastFittedGeometryKeyRef.current === fitGeometryKey) return;

    // FNXC:Graph 2026-06-23-02:45: defer one paint so the committed normalized bounds are live in
    // graphBoundsRef before clampPan (inside fitToGraph) runs — otherwise pan mis-clamps to ±viewport.
    let frameOne = 0;
    let frameTwo = 0;
    const runFit = () => {
      const liveViewport = viewportRef.current;
      if (!liveViewport) return;
      const liveWidth = liveViewport.clientWidth || viewportSize.width;
      const liveHeight = liveViewport.clientHeight || viewportSize.height;
      if (liveWidth === 0 || liveHeight === 0) return;
      fitToGraph(normalizedPositions, liveWidth, liveHeight, {
        nodeWidth: NODE_WIDTH,
        nodeHeight: NODE_HEIGHT,
        measuredHeights,
      });
      lastFittedGeometryKeyRef.current = fitGeometryKey;
    };

    if (typeof requestAnimationFrame === "function") {
      frameOne = requestAnimationFrame(() => {
        frameTwo = requestAnimationFrame(runFit);
      });
    } else {
      // Test/SSR environments without rAF: fit synchronously (bounds effect already ran this commit).
      runFit();
    }

    return () => {
      if (frameOne) cancelAnimationFrame(frameOne);
      if (frameTwo) cancelAnimationFrame(frameTwo);
    };
  }, [filteredTasks.length, fitGeometryKey, fitToGraph, measuredHeights, normalizedPositions, viewportSize.height, viewportSize.width]);

  const handleResetLayout = useCallback(() => {
    clearSavedPositions();
    const freshLayout = computeAutoLayout(graphData, layoutOptions);
    setPositions(freshLayout);
  }, [clearSavedPositions, graphData, layoutOptions]);

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
          handleKeyDown(event, viewport.clientWidth, viewport.clientHeight, normalizedPositions, {
            nodeWidth: NODE_WIDTH,
            nodeHeight: NODE_HEIGHT,
            measuredHeights,
          });
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
              nodeHeights={measuredHeights}
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
          const freshLayout = computeAutoLayout(graphData, layoutOptions);
          const normalizedFreshLayout = new Map<string, { x: number; y: number }>();
          const values = Array.from(freshLayout.values());
          const minX = values.length > 0 ? Math.min(...values.map((position) => position.x)) : 0;
          const minY = values.length > 0 ? Math.min(...values.map((position) => position.y)) : 0;
          for (const [taskId, position] of freshLayout.entries()) {
            normalizedFreshLayout.set(taskId, { x: position.x - minX, y: position.y - minY });
          }
          fitToGraph(normalizedFreshLayout, viewport.clientWidth, viewport.clientHeight, {
            nodeWidth: NODE_WIDTH,
            nodeHeight: NODE_HEIGHT,
            measuredHeights,
          });
        }}
        onResetView={() => {
          handleResetLayout();
          resetView();
        }}
      />
    </section>
  );
}
