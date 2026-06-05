import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Play, Flag, MessageSquare, Terminal, Shield, GitMerge, PauseCircle, Split, Merge, AlertTriangle, Repeat, ClipboardCheck, ListChecks, Code2 } from "lucide-react";

/** Node kinds the editor can render. "merge" is the pre/post-merge seam marker.
 *  v2 adds "hold" (passive dwell), "split"/"join" (parallel fan-out). The
 *  step-inversion additions (KTD-3/4/12/15): "foreach" (runtime-expanding
 *  per-step template region, rendered as a React Flow group), "step-review"
 *  (per-step review verdicts as outcome edges), "parse-steps" (graph-native
 *  step-list parsing), and "code" (sandboxed TypeScript). */
export type WorkflowEditorNodeKind =
  | "start"
  | "end"
  | "prompt"
  | "script"
  | "gate"
  | "merge"
  | "hold"
  | "split"
  | "join"
  | "foreach"
  | "step-review"
  | "parse-steps"
  | "code";

export interface WorkflowFlowNodeData {
  kind: WorkflowEditorNodeKind;
  label: string;
  /** Mirrors the IR node config (prompt, scriptName, gateMode, model, release,
   *  join mode/failure policy…). */
  config?: Record<string, unknown>;
  /** v2: the workflow column this node is placed in (derived from the swimlane
   *  band it sits in). Surfaced for the unplaced-node error badge. */
  column?: string;
  /** When true, render the shared error-state badge on the node (unplaced node
   *  or seam-in-branch). Set by the editor from validation. */
  errorBadge?: string;
  /** foreach group only: true when it has no template children (deletion can
   *  empty it even though the palette auto-populates one). */
  templateEmpty?: boolean;
  /** foreach group only: the localized empty-state hint string. */
  emptyHint?: string;
  [key: string]: unknown;
}

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
  "step-review": ClipboardCheck,
  "parse-steps": ListChecks,
  code: Code2,
};

/** Shared error-state component (U10): one component renders both the
 *  unplaced-node and the seam-in-branch error as an inline badge on the node. */
export function WorkflowNodeErrorBadge({ message }: { message: string }) {
  return (
    <span className="wf-node-error-badge" role="alert" data-testid="wf-node-error-badge" title={message}>
      <AlertTriangle size={11} aria-hidden /> {message}
    </span>
  );
}

function NodeShell({ data, kind }: { data: WorkflowFlowNodeData; kind: WorkflowEditorNodeKind }) {
  const Icon = KIND_ICON[kind];
  const showTarget = kind !== "start";
  const showSource = kind !== "end";
  const release = kind === "hold" ? (data.config?.release as string | undefined) : undefined;
  const joinMode =
    kind === "join"
      ? (() => {
          const m = data.config?.mode as unknown;
          if (m && typeof m === "object" && "quorum" in (m as object)) {
            return `quorum(${(m as { quorum: number }).quorum})`;
          }
          return typeof m === "string" ? m : "all";
        })()
      : undefined;
  // Step-execute seam prompt nodes (only legal inside a foreach template) carry
  // a distinguishing badge so the template's execute node reads clearly.
  const seam = kind === "prompt" ? (data.config?.seam as string | undefined) : undefined;
  const reviewType = kind === "step-review" ? (data.config?.type as string | undefined) : undefined;
  const parser = kind === "parse-steps" ? (data.config?.parser as string | undefined) : undefined;
  return (
    <div
      className={`wf-node wf-node-${kind}${seam === "step-execute" ? " wf-node-step-execute" : ""}${data.errorBadge ? " wf-node--error" : ""}`}
      data-testid={`wf-node-${kind}`}
    >
      {showTarget && <Handle type="target" position={Position.Left} />}
      <span className="wf-node-icon">
        <Icon size={14} aria-hidden />
      </span>
      <span className="wf-node-label">{data.label || kind}</span>
      {kind === "gate" && <span className="wf-node-badge">gate</span>}
      {release && <span className="wf-node-badge">{release}</span>}
      {joinMode && <span className="wf-node-badge">{joinMode}</span>}
      {seam === "step-execute" && <span className="wf-node-badge">step</span>}
      {reviewType && <span className="wf-node-badge">{reviewType}</span>}
      {parser && <span className="wf-node-badge">{parser}</span>}
      {data.errorBadge && <WorkflowNodeErrorBadge message={data.errorBadge} />}
      {showSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

/** A `foreach` node renders as a React Flow group: template nodes are children
 *  (parentId = the group id) laid out inside it. When empty, an empty-state hint
 *  prompts the author to drop a step-execute node in. The mode/isolation config
 *  is summarized in a header badge row. */
function ForeachGroupNode({ data }: { data: WorkflowFlowNodeData }) {
  const mode = (data.config?.mode as string | undefined) ?? "sequential";
  const isolation = (data.config?.isolation as string | undefined) ?? (mode === "parallel" ? "worktree" : "shared");
  const isEmpty = data.templateEmpty === true;
  return (
    <div
      className={`wf-foreach-group${data.errorBadge ? " wf-node--error" : ""}`}
      data-testid="wf-node-foreach"
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-foreach-header">
        <span className="wf-node-icon">
          <Repeat size={14} aria-hidden />
        </span>
        <span className="wf-node-label">{data.label || "foreach"}</span>
        <span className="wf-node-badge">{mode}</span>
        <span className="wf-node-badge">{isolation}</span>
      </div>
      {isEmpty && (
        <div className="wf-foreach-empty" data-testid="wf-foreach-empty">
          {data.emptyHint || "Drag a step-execute node here"}
        </div>
      )}
      {data.errorBadge && <WorkflowNodeErrorBadge message={data.errorBadge} />}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const workflowNodeTypes = {
  start: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="start" />,
  end: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="end" />,
  prompt: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="prompt" />,
  script: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="script" />,
  gate: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="gate" />,
  merge: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="merge" />,
  hold: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="hold" />,
  split: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="split" />,
  join: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="join" />,
  foreach: ({ data }: NodeProps) => <ForeachGroupNode data={data as WorkflowFlowNodeData} />,
  "step-review": ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="step-review" />,
  "parse-steps": ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="parse-steps" />,
  code: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="code" />,
};
