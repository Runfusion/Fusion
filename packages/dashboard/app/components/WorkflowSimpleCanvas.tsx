import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  EdgeLabelRenderer,
  BaseEdge,
  getSmoothStepPath,
  Position,
  Handle,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeProps,
  type EdgeProps,
  type OnBeforeDelete,
  type OnNodesDelete,
  type OnEdgesDelete,
} from "@xyflow/react";
import { useTranslation } from "react-i18next";
import {
  Play,
  Flag,
  MessageSquare,
  Terminal,
  Shield,
  GitMerge,
  PauseCircle,
  Split,
  Merge,
  Repeat,
  ToggleRight,
  ClipboardCheck,
  ListChecks,
  Code2,
  Bell,
  HelpCircle,
  DoorOpen,
  Plus,
  AlertTriangle,
} from "lucide-react";
import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import { nodeConfigSummary } from "./nodes/node-summary";
import { useWorkflowEditorCatalogs } from "./nodes/WorkflowEditorCatalogContext";
import { isColumnBandNode, isVisualOnlyWorkflowEdge } from "./workflow-flow-mapping";
import { simpleVerticalLayout, edgeSupportsSimpleInsert } from "./workflow-simple-layout";
import "./WorkflowSimpleCanvas.css";

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
WorkflowSimpleCanvas is the simplified graphical node editor: a modern,
vertical, auto-laid-out React Flow rendering of the SAME editor node/edge
state the advanced canvas edits. Requirements it encodes:
 - Common tasks (adding + configuring nodes) must be one-tap: every eligible
   edge shows a "+" insert affordance, clicking a node opens the shared
   inspector, and a persistent "+ Add step" pill covers the append case.
 - No free-form dragging: layout is derived (simpleVerticalLayout) and
   display-only, so the simple view can never corrupt the advanced canvas's
   manually authored positions or a v2 workflow's column placement.
 - Column swimlane bands, the minimap, and drag-to-connect handles are
   advanced-canvas chrome and intentionally absent here; column membership
   surfaces as a per-node chip instead.
 - Touch-friendly: pan/zoom gestures only, large hit targets, works as the
   mobile graph view (mobile keeps the row-list view as an even simpler
   fallback).
*/

const KIND_ICON: Record<WorkflowEditorNodeKind, typeof Play> = {
  start: Play,
  end: Flag,
  prompt: MessageSquare,
  script: Terminal,
  gate: Shield,
  merge: GitMerge,
  hold: PauseCircle,
  split: Split,
  join: Merge,
  foreach: Repeat,
  loop: Repeat,
  "optional-group": ToggleRight,
  "step-review": ClipboardCheck,
  "parse-steps": ListChecks,
  code: Code2,
  notify: Bell,
  "ask-user": HelpCircle,
  "exit-gate": DoorOpen,
};

/** Visual family per kind — drives the icon chip / accent color. */
export function simpleNodeFamily(kind: WorkflowEditorNodeKind): "terminal" | "agent" | "automation" | "flow" | "merge" {
  switch (kind) {
    case "start":
    case "end":
      return "terminal";
    case "prompt":
    case "ask-user":
    case "gate":
    case "step-review":
      return "agent";
    case "script":
    case "code":
    case "notify":
    case "parse-steps":
      return "automation";
    case "merge":
      return "merge";
    default:
      return "flow";
  }
}

interface SimpleNodeDisplayData extends WorkflowFlowNodeData {
  /** True for template children inside a container: horizontal handle flow. */
  __simpleChild?: boolean;
  /** Resolved column name chip (v2 workflows). */
  __columnName?: string;
}

function SimpleStepNode({ data, selected }: NodeProps) {
  const { t } = useTranslation("app");
  const catalogs = useWorkflowEditorCatalogs();
  const d = data as SimpleNodeDisplayData;
  const kind = d.kind;
  const Icon = KIND_ICON[kind] ?? MessageSquare;
  const family = simpleNodeFamily(kind);
  const summary = nodeConfigSummary(d, catalogs, t);
  const horizontal = d.__simpleChild === true;
  const targetPos = horizontal ? Position.Left : Position.Top;
  const sourcePos = horizontal ? Position.Right : Position.Bottom;
  const seam = kind === "prompt" ? (d.config?.seam as string | undefined) : undefined;

  if (kind === "start" || kind === "end") {
    return (
      <div
        className={`wf-simple-terminal wf-simple-terminal--${kind}${selected ? " wf-simple-node--selected" : ""}`}
        data-testid={`wf-simple-node-${kind}`}
      >
        {kind !== "start" && <Handle type="target" position={targetPos} className="wf-simple-handle" />}
        <Icon size={13} aria-hidden />
        <span>{d.label || kind}</span>
        {kind !== "end" && <Handle type="source" position={sourcePos} className="wf-simple-handle" />}
      </div>
    );
  }

  return (
    <div
      className={`wf-simple-node wf-simple-node--${family}${selected ? " wf-simple-node--selected" : ""}${d.errorBadge ? " wf-simple-node--error" : ""}`}
      data-testid={`wf-simple-node-${kind}`}
    >
      <Handle type="target" position={targetPos} className="wf-simple-handle" />
      <span className="wf-simple-node-chip" aria-hidden>
        <Icon size={16} />
      </span>
      <span className="wf-simple-node-body">
        <span className="wf-simple-node-title-row">
          <span className="wf-simple-node-label">{d.label || kind}</span>
          {kind === "gate" && <span className="wf-simple-node-badge">{t("workflowNodes.gateBadge", "gate")}</span>}
          {seam === "step-execute" && <span className="wf-simple-node-badge">{t("workflowNodes.stepBadge", "step")}</span>}
        </span>
        {summary ? (
          <span className="wf-simple-node-summary" title={summary}>
            {summary}
          </span>
        ) : null}
        {d.__columnName ? <span className="wf-simple-node-column">{d.__columnName}</span> : null}
      </span>
      {d.errorBadge ? (
        <span className="wf-simple-node-error" role="alert" title={d.errorBadge}>
          <AlertTriangle size={13} aria-hidden />
        </span>
      ) : null}
      <Handle type="source" position={sourcePos} className="wf-simple-handle" />
    </div>
  );
}

function SimpleContainerNode({ data, selected }: NodeProps) {
  const { t } = useTranslation("app");
  const d = data as SimpleNodeDisplayData;
  const Icon = KIND_ICON[d.kind] ?? Repeat;
  const badge =
    d.kind === "optional-group"
      ? d.config?.defaultOn === true
        ? t("workflowNodes.optionalGroupDefaultOn", "default on")
        : t("workflowNodes.optionalGroupDefaultOff", "default off")
      : d.kind === "loop"
        ? `${(d.config?.maxIterations as number | undefined) ?? 3}x`
        : ((d.config?.mode as string | undefined) ?? "sequential");
  return (
    <div
      className={`wf-simple-container${selected ? " wf-simple-node--selected" : ""}${d.errorBadge ? " wf-simple-node--error" : ""}`}
      data-testid={`wf-simple-node-${d.kind}`}
    >
      <Handle type="target" position={Position.Top} className="wf-simple-handle" />
      <div className="wf-simple-container-header">
        <span className="wf-simple-node-chip wf-simple-node-chip--flow" aria-hidden>
          <Icon size={14} />
        </span>
        <span className="wf-simple-node-label">{d.label || d.kind}</span>
        <span className="wf-simple-node-badge">{badge}</span>
        {d.errorBadge ? (
          <span className="wf-simple-node-error" role="alert" title={d.errorBadge}>
            <AlertTriangle size={13} aria-hidden />
          </span>
        ) : null}
      </div>
      {d.templateEmpty === true && (
        <div className="wf-simple-container-empty">{d.emptyHint || t("workflowNodes.simpleContainerEmpty", "No steps inside yet")}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="wf-simple-handle" />
    </div>
  );
}

const simpleNodeTypes = {
  start: SimpleStepNode,
  end: SimpleStepNode,
  prompt: SimpleStepNode,
  script: SimpleStepNode,
  gate: SimpleStepNode,
  merge: SimpleStepNode,
  hold: SimpleStepNode,
  split: SimpleStepNode,
  join: SimpleStepNode,
  "step-review": SimpleStepNode,
  "parse-steps": SimpleStepNode,
  code: SimpleStepNode,
  notify: SimpleStepNode,
  "ask-user": SimpleStepNode,
  "exit-gate": SimpleStepNode,
  foreach: SimpleContainerNode,
  loop: SimpleContainerNode,
  "optional-group": SimpleContainerNode,
};

interface SimpleEdgeData {
  condition?: string;
  kind?: string;
  __insertable?: boolean;
  [key: string]: unknown;
}

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
The simple edge renders the routing condition as a chip only when it carries
signal (anything but the default "success"), keeping the default path visually
quiet. The "+" button is the primary add-node entry point of the simple view.
React Flow edgeTypes must stay referentially stable (recreating the map
re-mounts every edge), so the per-render onInsertOnEdge callback reaches the
edge component through this context rather than through edge props.
*/
const SimpleCanvasInsertContext = createContext<(edgeId: string) => void>(() => {});

function SimpleInsertEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, label }: EdgeProps) {
  const { t } = useTranslation("app");
  const onInsertOnEdge = useContext(SimpleCanvasInsertContext);
  const d = (data ?? {}) as SimpleEdgeData;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });
  const condition = d.condition ?? "success";
  const isRework = d.kind === "rework";
  const showChip = isRework || condition !== "success";
  const chipText = isRework ? `${String(label ?? condition)}` : String(label ?? condition);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`wf-simple-edge-path${selected ? " wf-simple-edge-path--selected" : ""}${isRework ? " wf-simple-edge-path--rework" : ""}${condition === "failure" ? " wf-simple-edge-path--failure" : ""}`}
      />
      <EdgeLabelRenderer>
        <div
          className="wf-simple-edge-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {showChip && (
            <span className={`wf-simple-edge-chip${condition === "failure" ? " wf-simple-edge-chip--failure" : ""}${isRework ? " wf-simple-edge-chip--rework" : ""}`}>
              {chipText}
            </span>
          )}
          {d.__insertable === true && (
            <button
              type="button"
              className="wf-simple-edge-insert"
              data-testid={`wf-simple-insert-${id}`}
              aria-label={t("workflowNodes.simpleInsertStep", "Insert step here")}
              title={t("workflowNodes.simpleInsertStep", "Insert step here")}
              onClick={(event) => {
                event.stopPropagation();
                onInsertOnEdge(id);
              }}
            >
              <Plus size={14} aria-hidden />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const simpleEdgeTypes = { "wf-simple": SimpleInsertEdge };

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
React Flow's `fitView` prop applies only on init, but the editor loads the
workflow (and the user can switch workflows) AFTER the canvas mounts — and the
derived vertical layout centers x around 0, so without a refit the graph sits
off-screen to the left. Refit whenever the set of rendered nodes changes
(workflow switch, add/insert/delete), on the next frame so React Flow has
measured the new nodes.
*/
function SimpleCanvasAutoFit({
  signature,
  containerRef,
}: {
  signature: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { fitView } = useReactFlow();
  // Nodes have no dimensions until React Flow measures them; fitView before
  // that is a no-op (seen as a mis-centered mobile canvas on first mount).
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (!nodesInitialized) return;
    let frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.15, maxZoom: 1 });
    });
    // Second pass: container children and fonts can measure after the first
    // fit (and mobile stage transitions animate the container), shifting the
    // graph bounds without a node-set change. One settled refit covers it.
    const settle = window.setTimeout(() => {
      void fitView({ padding: 0.15, maxZoom: 1 });
    }, 250);
    // The canvas region also resizes without a graph change (inspector
    // opening/closing, sidebar collapse, window resize) — refit then too so
    // the flow stays centered instead of drifting off-screen.
    const el = containerRef.current;
    const observer =
      typeof ResizeObserver === "undefined" || !el
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              void fitView({ padding: 0.15, maxZoom: 1 });
            });
          });
    if (observer && el) observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      observer?.disconnect();
    };
  }, [signature, fitView, containerRef, nodesInitialized]);
  return null;
}

export interface WorkflowSimpleCanvasProps {
  nodes: FlowNode<WorkflowFlowNodeData>[];
  edges: FlowEdge[];
  /** Column id → display name (v2). Empty map for v1 workflows. */
  columnNames: Map<string, string>;
  editable: boolean;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClearSelection: () => void;
  /** Open the add-step dialog targeting this edge. */
  onInsertOnEdge: (edgeId: string) => void;
  /** Open the add-step dialog for a free append. */
  onAddStep: () => void;
  onBeforeDelete?: OnBeforeDelete<FlowNode<WorkflowFlowNodeData>, FlowEdge>;
  onNodesDelete?: OnNodesDelete<FlowNode<WorkflowFlowNodeData>>;
  onEdgesDelete?: OnEdgesDelete<FlowEdge>;
}

export function WorkflowSimpleCanvas({
  nodes,
  edges,
  columnNames,
  editable,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onInsertOnEdge,
  onAddStep,
  onBeforeDelete,
  onNodesDelete,
  onEdgesDelete,
}: WorkflowSimpleCanvasProps) {
  const { t } = useTranslation("app");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const displayNodes = useMemo(() => {
    const positions = simpleVerticalLayout(nodes, edges);
    return nodes
      .filter((n) => !isColumnBandNode(n.id))
      .map((n) => {
        const pos = positions.get(n.id);
        const data: SimpleNodeDisplayData = {
          ...(n.data as WorkflowFlowNodeData),
          __simpleChild: !!n.parentId,
          __columnName: n.data.column ? columnNames.get(n.data.column) : undefined,
        };
        return {
          ...n,
          data,
          position: pos ?? n.position,
          selected: n.id === selectedNodeId,
          draggable: false,
          connectable: false,
        };
      });
  }, [nodes, edges, columnNames, selectedNodeId]);

  const displayEdges = useMemo(
    () =>
      edges
        .filter((e) => !isVisualOnlyWorkflowEdge(e))
        .map((e) => ({
          ...e,
          type: "wf-simple",
          selected: e.id === selectedEdgeId,
          data: {
            ...(e.data ?? {}),
            __insertable: editable && edgeSupportsSimpleInsert(e),
          },
        })),
    [edges, editable, selectedEdgeId],
  );

  return (
    <div className="wf-simple-canvas" data-testid="wf-simple-canvas" ref={containerRef}>
      {/* FNXC:WorkflowSimpleView 2026-07-10-12:00: OWN provider, deliberately
          nested inside the editor's ReactFlowProvider. The editor keeps its
          advanced canvas mounted (CSS-hidden) in list/mobile presentations;
          sharing one store between two ReactFlow instances corrupts node
          measurements and breaks fitView on the visible one. */}
      <ReactFlowProvider>
      <SimpleCanvasInsertContext.Provider value={onInsertOnEdge}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={simpleNodeTypes}
        edgeTypes={simpleEdgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        onBeforeDelete={onBeforeDelete}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={onClearSelection}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.75}
        proOptions={{ hideAttribution: false }}
      >
        <SimpleCanvasAutoFit signature={displayNodes.map((n) => n.id).join("|")} containerRef={containerRef} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} className="wf-simple-canvas-bg" />
        <Controls showInteractive={false} className="wf-simple-controls" />
        {editable && (
          <Panel position="bottom-center" className="wf-simple-add-panel">
            <button type="button" className="wf-simple-add-step" data-testid="wf-simple-add-step" onClick={onAddStep}>
              <Plus size={15} aria-hidden />
              <span>{t("workflowNodes.simpleAddStep", "Add step")}</span>
            </button>
          </Panel>
        )}
      </ReactFlow>
      </SimpleCanvasInsertContext.Provider>
      </ReactFlowProvider>
    </div>
  );
}
