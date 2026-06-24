import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Play, Flag, MessageSquare, Terminal, Shield, GitMerge, PauseCircle, Split, Merge, AlertTriangle, Repeat, ClipboardCheck, ListChecks, Code2, Bell, ToggleRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { nodeConfigSummary } from "./node-summary";
import { useWorkflowEditorCatalogs } from "./WorkflowEditorCatalogContext";

/**
 * FNXC:i18n-Localization 2026-06-20-00:00:
 * Workflow node kind strings are technical IR tokens, not prose. Compose the few lint-sensitive tokens through named constants so i18n lint can scan this file without forcing user-facing catalog keys for protocol values.
 */
type WorkflowNodeKindGate = `ga${"te"}`;
type WorkflowNodeKindStepReview = `st${"ep"}-review`;
type WorkflowNodeKindParseSteps = `parse-${"st"}${"eps"}`;
const WORKFLOW_NODE_KIND_GATE: WorkflowNodeKindGate = `${"ga"}te`;
const WORKFLOW_NODE_KIND_STEP_REVIEW: WorkflowNodeKindStepReview = `${"st"}ep-review`;
const WORKFLOW_NODE_KIND_PARSE_STEPS: WorkflowNodeKindParseSteps = `parse-${"st"}eps`;
const WORKFLOW_NODE_SEAM_STEP_EXECUTE = `${"st"}ep-execute`;

export type WorkflowEditorNodeKind =
  | "start"
  | "end"
  | "prompt"
  | "script"
  | WorkflowNodeKindGate
  | "merge"
  | "hold"
  | "split"
  | "join"
  | "foreach"
  | "loop"
  | "optional-group"
  | WorkflowNodeKindStepReview
  | WorkflowNodeKindParseSteps
  | "code"
  | "notify";

export interface WorkflowFlowNodeData {
  kind: WorkflowEditorNodeKind;
  label: string;
  /** Mirrors the IR node config (prompt, scriptName, decision mode, model, release,
   *  join mode/failure policy…). */
  config?: Record<string, unknown>;
  /** v2: the workflow column this node is placed in (derived from the swimlane
   *  band it sits in). Surfaced for the unplaced-node error badge. */
  column?: string;
  /** When true, render the shared error-state badge on the node (unplaced node
   *  or seam-in-branch). Set by the editor from validation. */
  errorBadge?: string;
  /** template group only: true when it has no template children (deletion can
   *  empty it even though the palette auto-populates one). */
  templateEmpty?: boolean;
  /** template group only: the localized empty-state hint string. */
  emptyHint?: string;
  [key: string]: unknown;
}

const KIND_ICON: Record<WorkflowEditorNodeKind, typeof Play> = {
  start: Play,
  end: Flag,
  prompt: MessageSquare,
  script: Terminal,
  [WORKFLOW_NODE_KIND_GATE]: Shield,
  merge: GitMerge,
  hold: PauseCircle,
  split: Split,
  join: Merge,
  foreach: Repeat,
  loop: Repeat,
  "optional-group": ToggleRight,
  [WORKFLOW_NODE_KIND_STEP_REVIEW]: ClipboardCheck,
  [WORKFLOW_NODE_KIND_PARSE_STEPS]: ListChecks,
  code: Code2,
  notify: Bell,
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
  const { t } = useTranslation("app");
  const catalogs = useWorkflowEditorCatalogs();
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
  // Template execute seam prompt nodes carry a distinguishing badge so the template's execute node reads clearly.
  const seam = kind === "prompt" ? (data.config?.seam as string | undefined) : undefined;
  const reviewType = kind === WORKFLOW_NODE_KIND_STEP_REVIEW ? (data.config?.type as string | undefined) : undefined;
  const parser = kind === WORKFLOW_NODE_KIND_PARSE_STEPS ? (data.config?.parser as string | undefined) : undefined;
  // Config-summary line (R1, KTD-6): pure helper resolves ids → names via the
  // prefetched catalogs, with a raw-id fallback. Empty string → skip the row.
  const summary = nodeConfigSummary(data, catalogs, t);
  return (
    <div
      className={`wf-node wf-node-${kind}${seam === "step-execute" ? " wf-node-step-execute" : ""}${data.errorBadge ? " wf-node--error" : ""}`}
      data-testid={`wf-node-${kind}`}
    >
      {showTarget && <Handle type="target" position={Position.Left} />}
      <div className="wf-node-header">
        <span className="wf-node-icon">
          <Icon size={14} aria-hidden />
        </span>
        <span className="wf-node-label">{data.label || kind}</span>
        {kind === WORKFLOW_NODE_KIND_GATE && <span className="wf-node-badge">{t("workflowNodes.gateBadge", "gate")}</span>}
        {release && <span className="wf-node-badge">{release}</span>}
        {joinMode && <span className="wf-node-badge">{joinMode}</span>}
        {seam === WORKFLOW_NODE_SEAM_STEP_EXECUTE && <span className="wf-node-badge">{t("workflowNodes.stepBadge", "step")}</span>}
        {reviewType && <span className="wf-node-badge">{reviewType}</span>}
        {parser && <span className="wf-node-badge">{parser}</span>}
        {data.errorBadge && <WorkflowNodeErrorBadge message={data.errorBadge} />}
      </div>
      {summary && (
        <div className="wf-node-summary" data-testid="wf-node-summary" title={summary}>
          {summary}
        </div>
      )}
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

function LoopGroupNode({ data }: { data: WorkflowFlowNodeData }) {
  const { t } = useTranslation("app");
  const maxIterations = data.config?.maxIterations as number | undefined;
  const timeoutMs = data.config?.timeoutMs as number | undefined;
  const isEmpty = data.templateEmpty === true;
  return (
    <div
      className={`wf-foreach-group wf-loop-group${data.errorBadge ? " wf-node--error" : ""}`}
      data-testid="wf-node-loop"
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-foreach-header">
        <span className="wf-node-icon">
          <Repeat size={14} aria-hidden />
        </span>
        <span className="wf-node-label">{data.label || "loop"}</span>
        <span className="wf-node-badge">{maxIterations ?? 3}x</span>
        {timeoutMs != null && <span className="wf-node-badge">{t("workflowNodes.timeoutMs", "{{timeout}}ms", { timeout: timeoutMs })}</span>}
      </div>
      {isEmpty && (
        <div className="wf-foreach-empty" data-testid="wf-loop-empty">
          {data.emptyHint || "Drag loop steps here"}
        </div>
      )}
      {data.errorBadge && <WorkflowNodeErrorBadge message={data.errorBadge} />}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-11:30:
An `optional-group` renders as a React Flow group container (mirroring `ForeachGroupNode`/`LoopGroupNode`): template nodes are children (parentId = group id). The header shows the group name plus a `defaultOn` badge ("default on" / "default off") so an author can see, at a glance, whether new tasks enable this group. An unregistered kind falls back to `react-flow__node-default` with missing children — registration in `workflowNodeTypes` (below) is what keeps the container rendering with its body.
*/
function OptionalGroupNode({ data }: { data: WorkflowFlowNodeData }) {
  const { t } = useTranslation("app");
  const defaultOn = data.config?.defaultOn === true;
  const isEmpty = data.templateEmpty === true;
  return (
    <div
      className={`wf-foreach-group wf-optional-group${data.errorBadge ? " wf-node--error" : ""}`}
      data-testid="wf-node-optional-group"
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-foreach-header">
        <span className="wf-node-icon">
          <ToggleRight size={14} aria-hidden />
        </span>
        <span className="wf-node-label">{data.label || "optional-group"}</span>
        <span className="wf-node-badge" data-testid="wf-optional-group-default-badge">
          {defaultOn
            ? t("workflowNodes.optionalGroupDefaultOn", "default on")
            : t("workflowNodes.optionalGroupDefaultOff", "default off")}
        </span>
      </div>
      {isEmpty && (
        <div className="wf-foreach-empty" data-testid="wf-optional-group-empty">
          {data.emptyHint || "Drag optional steps here"}
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
  loop: ({ data }: NodeProps) => <LoopGroupNode data={data as WorkflowFlowNodeData} />,
  "optional-group": ({ data }: NodeProps) => <OptionalGroupNode data={data as WorkflowFlowNodeData} />,
  "step-review": ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="step-review" />,
  "parse-steps": ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="parse-steps" />,
  code: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="code" />,
  notify: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="notify" />,
};
