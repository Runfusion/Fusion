import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { Task } from "@fusion/core";
import { loadPositions, savePositions } from "./storage";
import "./DependencyGraphView.css";

const ACTIVE_COLUMNS = new Set(["triage", "todo", "in-progress", "in-review"]);
const NODE_WIDTH_REM = 18;
const NODE_HEIGHT_REM = 9;
const GRID_GAP_X_REM = 3;
const GRID_GAP_Y_REM = 4;
const DRAG_THRESHOLD_REM = 0.5;
const SCENE_PADDING_REM = 2;
const FIT_PADDING_REM = 2;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2;

export interface DependencyGraphHostContext {
  projectId?: string;
  tasks: Task[];
  openTaskDetail: (task: Task) => void;
  renderTaskCard: (task: Task) => ReactNode;
}

export interface PluginDashboardViewComponentProps {
  context: DependencyGraphHostContext;
}

type Position = { x: number; y: number };

function getDistance(a: Position, b: Position): number {
  const deltaX = a.x - b.x;
  const deltaY = a.y - b.y;
  return Math.hypot(deltaX, deltaY);
}

export function DependencyGraphView({ context }: PluginDashboardViewComponentProps) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Position>({ x: 0, y: 0 });
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, Position>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const persisted = useMemo(() => loadPositions(context.projectId), [context.projectId]);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<
    | { kind: "node"; taskId: string; startPointer: Position; startNode: Position; moved: boolean }
    | { kind: "pan"; startPointer: Position; startPan: Position; moved: boolean }
    | null
  >(null);

  const tasks = useMemo(
    () => context.tasks.filter((task) => ACTIVE_COLUMNS.has(task.column)),
    [context.tasks],
  );

  const positioned = useMemo(() => {
    return tasks.map((task, index) => {
      const saved = nodeOverrides[task.id] ?? persisted[task.id];
      return {
        task,
        x: saved?.x ?? (index % 4) * (NODE_WIDTH_REM + GRID_GAP_X_REM),
        y: saved?.y ?? Math.floor(index / 4) * (NODE_HEIGHT_REM + GRID_GAP_Y_REM),
      };
    });
  }, [nodeOverrides, persisted, tasks]);

  const map = useMemo(() => new Map(positioned.map((node) => [node.task.id, node])), [positioned]);

  const edges = useMemo(() => {
    const lines: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
    positioned.forEach((node) => {
      (node.task.dependencies ?? []).forEach((dependencyId) => {
        const dependency = map.get(dependencyId);
        if (!dependency) return;
        lines.push({
          from: dependencyId,
          to: node.task.id,
          x1: dependency.x + NODE_WIDTH_REM,
          y1: dependency.y + NODE_HEIGHT_REM / 2,
          x2: node.x,
          y2: node.y + NODE_HEIGHT_REM / 2,
        });
      });
    });
    return lines;
  }, [map, positioned]);

  const bounds = useMemo(() => {
    if (positioned.length === 0) {
      return { minX: 0, minY: 0, width: NODE_WIDTH_REM * 2, height: NODE_HEIGHT_REM * 2 };
    }

    const minX = Math.min(...positioned.map((node) => node.x)) - SCENE_PADDING_REM;
    const minY = Math.min(...positioned.map((node) => node.y)) - SCENE_PADDING_REM;
    const maxX = Math.max(...positioned.map((node) => node.x + NODE_WIDTH_REM)) + SCENE_PADDING_REM;
    const maxY = Math.max(...positioned.map((node) => node.y + NODE_HEIGHT_REM)) + SCENE_PADDING_REM;

    return {
      minX,
      minY,
      width: Math.max(NODE_WIDTH_REM * 2, maxX - minX),
      height: Math.max(NODE_HEIGHT_REM * 2, maxY - minY),
    };
  }, [positioned]);

  const positionedForRender = useMemo(
    () =>
      positioned.map((node) => ({
        ...node,
        renderX: node.x - bounds.minX,
        renderY: node.y - bounds.minY,
      })),
    [bounds.minX, bounds.minY, positioned],
  );

  const edgesForRender = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        renderX1: edge.x1 - bounds.minX,
        renderY1: edge.y1 - bounds.minY,
        renderX2: edge.x2 - bounds.minX,
        renderY2: edge.y2 - bounds.minY,
      })),
    [bounds.minX, bounds.minY, edges],
  );

  const dependencyGraph = useMemo(() => {
    const downstream = new Map<string, Set<string>>();
    const upstream = new Map<string, Set<string>>();

    edges.forEach((edge) => {
      downstream.set(edge.from, (downstream.get(edge.from) ?? new Set<string>()).add(edge.to));
      upstream.set(edge.to, (upstream.get(edge.to) ?? new Set<string>()).add(edge.from));
    });

    return { downstream, upstream };
  }, [edges]);

  const focusTaskId = hoveredTaskId ?? selectedTaskId;

  const relatedTaskIds = useMemo(() => {
    if (!focusTaskId) return null;

    const related = new Set<string>([focusTaskId]);
    const walk = (seed: string, map: Map<string, Set<string>>) => {
      const queue = [seed];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        (map.get(current) ?? new Set<string>()).forEach((next) => {
          if (related.has(next)) return;
          related.add(next);
          queue.push(next);
        });
      }
    };

    walk(focusTaskId, dependencyGraph.downstream);
    walk(focusTaskId, dependencyGraph.upstream);

    return related;
  }, [dependencyGraph.downstream, dependencyGraph.upstream, focusTaskId]);

  const fitToGraph = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rootFontSize = Number.parseFloat(globalThis.getComputedStyle(document.documentElement).fontSize) || 16;
    const widthPx = bounds.width * rootFontSize;
    const heightPx = bounds.height * rootFontSize;
    const paddingPx = FIT_PADDING_REM * rootFontSize;
    const availableWidth = Math.max(1, canvas.clientWidth - paddingPx * 2);
    const availableHeight = Math.max(1, canvas.clientHeight - paddingPx * 2);

    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availableWidth / widthPx, availableHeight / heightPx)));
    const centeredPanX = (canvas.clientWidth - widthPx * nextScale) / (2 * rootFontSize * nextScale);
    const centeredPanY = (canvas.clientHeight - heightPx * nextScale) / (2 * rootFontSize * nextScale);

    setScale(nextScale);
    setPan({ x: centeredPanX, y: centeredPanY });
  };

  const persistPosition = (taskId: string, next: Position) => {
    setNodeOverrides((current) => ({ ...current, [taskId]: next }));
    savePositions(context.projectId, { ...persisted, ...nodeOverrides, [taskId]: next });
  };

  const handlePointerDownOnNode = (taskId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const hit = map.get(taskId);
    if (!hit) return;
    interactionRef.current = {
      kind: "node",
      taskId,
      startPointer: { x: event.clientX, y: event.clientY },
      startNode: { x: hit.x, y: hit.y },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    interactionRef.current = {
      kind: "pan",
      startPointer: { x: event.clientX, y: event.clientY },
      startPan: pan,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = interactionRef.current;
    if (!current) return;

    const delta = {
      x: (event.clientX - current.startPointer.x) / 16,
      y: (event.clientY - current.startPointer.y) / 16,
    };

    if (current.kind === "node") {
      const moved = getDistance({ x: 0, y: 0 }, delta) > DRAG_THRESHOLD_REM;
      if (moved && !current.moved) current.moved = true;
      if (!current.moved) return;
      setNodeOverrides((existing) => ({
        ...existing,
        [current.taskId]: { x: current.startNode.x + delta.x / scale, y: current.startNode.y + delta.y / scale },
      }));
      return;
    }

    const moved = getDistance({ x: 0, y: 0 }, delta) > DRAG_THRESHOLD_REM;
    if (moved && !current.moved) current.moved = true;
    if (!current.moved) return;
    setPan({ x: current.startPan.x + delta.x, y: current.startPan.y + delta.y });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = interactionRef.current;
    interactionRef.current = null;
    if (!current) return;

    if (current.kind === "node") {
      const hit = map.get(current.taskId);
      if (!hit) return;

      if (!current.moved) {
        context.openTaskDetail(hit.task);
        return;
      }

      persistPosition(current.taskId, { x: hit.x, y: hit.y });
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <section className="dependency-graph-view">
      <div className="dependency-graph-controls">
        <button className="btn btn-sm" onClick={() => setScale((value) => Math.min(value + 0.1, MAX_SCALE))}>Zoom In</button>
        <button className="btn btn-sm" onClick={() => setScale((value) => Math.max(value - 0.1, MIN_SCALE))}>Zoom Out</button>
        <button className="btn btn-sm" onClick={fitToGraph}>Fit</button>
      </div>

      <div
        className="dependency-graph-canvas"
        ref={canvasRef}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className="dependency-graph-scene"
          style={{
            width: `${bounds.width}rem`,
            height: `${bounds.height}rem`,
            transform: `translate(${pan.x}rem, ${pan.y}rem) scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <svg className="dependency-graph-edges" viewBox={`0 0 ${bounds.width} ${bounds.height}`}>
            {edgesForRender.map((edge) => (
              <line
                key={`${edge.from}-${edge.to}`}
                x1={edge.renderX1}
                y1={edge.renderY1}
                x2={edge.renderX2}
                y2={edge.renderY2}
                className={`dependency-graph-edge${relatedTaskIds ? relatedTaskIds.has(edge.from) && relatedTaskIds.has(edge.to) ? " is-related" : " is-dimmed" : ""}`}
              />
            ))}
          </svg>

          {positionedForRender.map((node) => (
            <div
              key={node.task.id}
              className={`dependency-graph-node${selectedTaskId === node.task.id ? " is-selected" : ""}${relatedTaskIds ? relatedTaskIds.has(node.task.id) ? " is-related" : " is-dimmed" : ""}`}
              style={{
                width: `${NODE_WIDTH_REM}rem`,
                minHeight: `${NODE_HEIGHT_REM}rem`,
                transform: `translate(${node.renderX}rem, ${node.renderY}rem)`,
              }}
              onPointerDown={(event) => handlePointerDownOnNode(node.task.id, event)}
              onPointerEnter={() => setHoveredTaskId(node.task.id)}
              onPointerLeave={() => setHoveredTaskId((current) => (current === node.task.id ? null : current))}
            >
              {context.renderTaskCard(node.task)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
