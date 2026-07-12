import "@xyflow/react/dist/style.css";
import "./WorkflowNodeEditor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  applyEdgeChanges,
  type Connection,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type EdgeChange,
} from "@xyflow/react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, Plus, Trash2, Save, MessageSquare, Terminal, Shield, GitMerge, Loader2, HelpCircle, PauseCircle, Split, Merge, Repeat, ToggleRight, ClipboardCheck, ListChecks, Code2, Bell, LayoutGrid, Workflow, Download, Upload, ChevronDown, ChevronRight, ChevronLeft, Library, Sparkles, Maximize2, Minimize2, DoorOpen } from "lucide-react";
import type { WorkflowDefinition, WorkflowIrColumn, TraitViolation, WorkflowStepTemplate, WorkflowIrNodeKind } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  fetchWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  exportWorkflow,
  importWorkflow,
  designWorkflow,
  ApiRequestError,
  fetchModels,
  fetchAgents,
  fetchDiscoveredSkills,
  fetchWorkflowStepTemplates,
  fetchPluginWorkflowStepTemplates,
  fetchWorkflowPromptOverrides,
  updateWorkflowPromptOverrides,
  fetchSettings,
  type ModelInfo,
  type WorkflowPromptOverridesPayload,
} from "../api";
import type { Agent } from "../api";
import type { DiscoveredSkill } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useConfirm } from "../hooks/useConfirm";
import { subscribeSse } from "../sse-bus";

/*
FNXC:i18n-Localize 2026-06-20-00:00:
FN-6770 localizes this workflow surface through t() and authored en catalog keys so hardcoded user-facing copy does not need a lint.ignore deferral.
*/
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
import { isMobileViewport, useViewportMode } from "../hooks/useViewportMode";
import { WorkflowIcon } from "./WorkflowIcon";
import { workflowNodeTypes, type WorkflowFlowNodeData, type WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import { WorkflowEditorCatalogContext } from "./nodes/WorkflowEditorCatalogContext";
import { bareSkillName, type NodeSummaryCatalogs } from "./nodes/node-summary";
import { nodeHelpForData } from "./nodes/node-help";
import {
  irToFlow,
  flowToIr,
  emptyWorkflowIr,
  emptyWorkflowLayout,
  copyIrWithFreshIds,
  insertFragment,
  optionalGroupFragmentIr,
  fragmentSeamConflicts,
  columnsOf,
  fieldsOf,
  settingsOf,
  columnsToBandNodes,
  reconcileNodeColumns,
  strictColumnForY,
  validateColumnsClient,
  unplacedNodeIds,
  isColumnBandNode,
  foreachChildFlowId,
  shortConditionLabel,
  edgeClassName,
  edgeConditionEditability,
  buildConnectionEdge,
  cascadeDelete,
  refreshTemplateContainerVisualBoundaries,
  WF_EDGE_INTERACTION_WIDTH,
  FOREACH_GROUP_WIDTH,
  FOREACH_GROUP_HEIGHT,
  FOREACH_CHILD_X,
  FOREACH_CHILD_Y,
} from "./workflow-flow-mapping";
import { autoLayout, applyAutoLayout } from "./workflow-auto-layout";
import { insertNodeOnEdge, findAppendEdgeId, spliceInsertedSubgraphOnEdge } from "./workflow-simple-layout";
import { WorkflowSimpleCanvas } from "./WorkflowSimpleCanvas";
import { WorkflowAddStepModal, type AddStepPaletteEntry } from "./WorkflowAddStepModal";
import { fetchTraits, fetchStepParsers, type TraitCatalogEntry } from "../api";
import { WorkflowColumnPanel } from "./WorkflowColumnPanel";
import { WorkflowFieldsPanel } from "./WorkflowFieldsPanel";
import { WorkflowSettingsPanel } from "./WorkflowSettingsPanel";
import type { WorkflowFieldDefinition, WorkflowSettingDefinition } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { FloatingWindow } from "./FloatingWindow";
import { MobileWorkflowGraphView } from "./MobileWorkflowGraphView";
import {
  buildMobileWorkflowGraph,
  reorderWorkflowNode,
  type MobileWorkflowConnectionTarget,
  type WorkflowNodeReorderDirection,
} from "./workflow-mobile-graph";

type ExecutorKind = "model" | "agent" | "skill" | "cli" | "cli-agent";

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
The desktop workflow editor now has THREE view modes over the same node/edge
state, replacing the old boolean simple-editor toggle:
 - "simple"   — the simplified graphical node editor (default): vertical
   auto-laid-out canvas, "+" insert-on-edge, add-step dialog, no palette
   toolbar or column bands. Cleaner for the common tasks (adding and
   configuring nodes).
 - "advanced" — the full canvas: palette toolbar, templates, drag/connect,
   column swimlanes, minimap, auto-layout, import/export. Nothing removed.
 - "list"     — the pre-existing row-list simple editor, kept as an even
   simpler fallback; it reuses the mobile shell exactly as before.
The choice persists per-browser in localStorage. Mobile keeps its tab shell
(forced by viewport) and gets its own graph-style toggle: the simplified
canvas by default with the row list as fallback.
*/
type WorkflowEditorViewMode = "simple" | "advanced" | "list";
const viewModeStorageKey = "fusion:wf-editor-view-mode";
type MobileGraphStyle = "canvas" | "list";
const mobileGraphStyleStorageKey = "fusion:wf-mobile-graph-style";
// FNXC:WorkflowOptionalGroup 2026-06-21-18:00: dropped the "optional-steps" mobile
// panel — the declaration authoring surface is retired (optional-group nodes now).
type MobileWorkflowPanel = "graph" | "add" | "settings" | "fields" | "columns" | "actions";

function builtinSeamPrompt(config: Record<string, unknown> | undefined): string {
  const seam = typeof config?.seam === "string" ? config.seam : "";
  switch (seam) {
    case "planning":
      return "Generate the task plan and write the planning artifact that downstream workflow nodes consume.";
    case "execute":
      return "Run Fusion's standard implementation prompt for this task, generated from the task spec, current project context, workflow fields, and available tools.";
    case "step-execute":
      return "Run Fusion's step implementation prompt for the active planned step in the task worktree.";
    case "review":
      return "Run Fusion's review boundary for completed implementation work and route the task based on the review result.";
    case "merge":
      return "Run Fusion's merge boundary: verify merge readiness, apply the configured merge strategy, and update the final task state.";
    default:
      return "";
  }
}

/** Adapter descriptor served by GET /api/cli-agents (U15). */
interface CliAdapterDescriptorView {
  id: string;
  name: string;
  tier: "native" | "hybrid" | "generic";
}

/** Static fallback so the picker renders before/without the API fetch. */
const CLI_AGENT_ADAPTER_FALLBACK: CliAdapterDescriptorView[] = [
  { id: "claude-code", name: "Claude Code", tier: "native" },
  { id: "codex", name: "Codex", tier: "hybrid" },
  { id: "droid", name: "Droid", tier: "hybrid" },
  { id: "pi", name: "Pi", tier: "hybrid" },
  { id: "generic", name: "Generic CLI", tier: "generic" },
];

// Mirror of @fusion/core's isBuiltinWorkflowId / BUILTIN_WORKFLOW_ID_PREFIX.
// Inlined because the dashboard app build aliases "@fusion/core" to its
// types-only entry (which doesn't re-export builtin-workflows), and importing
// the function would pull the eager BUILTIN_WORKFLOWS construction into the
// browser bundle for a one-line prefix check.
const isBuiltinWorkflowId = (id: string): boolean => id.startsWith("builtin:");

function getModelDropdownValue(provider: string, modelId: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelDropdownValue(value: string): { provider: string; modelId: string } {
  if (!value) return { provider: "", modelId: "" };
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return { provider: "", modelId: "" };
  return { provider: value.slice(0, slashIndex), modelId: value.slice(slashIndex + 1) };
}

/*
FNXC:WorkflowMiniMap 2026-06-22-10:15:
The workflow minimap must show the actual graph, not the large column swimlane
band nodes that exist only as canvas background scaffolding. Use explicit
theme-token colors so React Flow's SVG attributes do not fall back to blank
default chrome in dark/light themes.
*/
function miniMapNodeColor(node: FlowNode<WorkflowFlowNodeData>): string {
  if (isColumnBandNode(node.id)) return "transparent";
  if (node.data.kind === "start") return "var(--ws-success)";
  if (node.data.kind === "end") return "var(--ws-info)";
  if (node.data.kind === "gate" || node.data.kind === "step-review") return "var(--ws-warning)";
  if (node.data.kind === "merge" || node.data.kind === "join") return "var(--accent)";
  return "var(--todo)";
}

function miniMapNodeStrokeColor(node: FlowNode<WorkflowFlowNodeData>): string {
  return isColumnBandNode(node.id) ? "transparent" : "var(--border-strong, var(--border))";
}

/** Normalized serialization of the editor's authoring state for dirty tracking
 *  (U4). Serializes nodes/edges through flowToIr (so mapping-layer defaults are
 *  materialized identically on the loaded and live sides) plus the editor-owned
 *  name/description and the resulting layout (auto-layout/drag position changes
 *  count as dirty). Returns a stable JSON string for cheap equality. */
function serializeGraph(
  name: string,
  description: string,
  icon: string | undefined,
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  columns: WorkflowIrColumn[],
  fields: WorkflowFieldDefinition[],
  settings: WorkflowSettingDefinition[],
): string {
  const { ir, layout } = flowToIr(
    name,
    nodes,
    edges,
    columns.length ? columns : undefined,
    fields.length ? fields : undefined,
    settings.length ? settings : undefined,
  );
  return JSON.stringify({ name, description, icon: icon?.trim() || undefined, ir, layout });
}

interface WorkflowNodeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  /** When "settings" the editor scrolls the WorkflowSettingsPanel into view on
   *  mount (U6/U9: redirect stubs link here via a `?panel=settings` param read by
   *  the editor's mount site). */
  initialPanel?: "settings";
  /** When "create" the editor opens with the new-workflow dialog active. */
  initialAction?: "create";
  /** Workflow id to preselect when the editor opens from workflow-aware surfaces. */
  initialWorkflowId?: string;
  /*
  FNXC:WorkflowEditorEmbedding 2026-06-22-00:00:
  The workflow editor can render either as a fixed modal overlay ("modal", the
  default and historical behavior) or inline as a main-content-area view
  ("embedded") that fills the right-dock panel like a Command Center view.
  In embedded mode the editor drops the .modal-overlay shell, the X close
  button, native resize, and all modal-only dismiss paths (Escape, overlay
  click) so it reads as a persistent view rather than a dismissible dialog.
  The modal path stays byte-identical when presentation is "modal"/undefined.
  */
  presentation?: ModalPresentation;
}

let nodeSeq = 0;
function newNodeId(): string {
  nodeSeq += 1;
  return `n-${Date.now().toString(36)}-${nodeSeq}`;
}

/** Built-in step parsers (KTD-12). Fallback list when the live catalog endpoint
 *  (GET /api/step-parsers) is unreachable; the editor otherwise merges in any
 *  registered plugin parsers fetched from the registry. */
const BUILTIN_STEP_PARSERS = ["step-headings", "json-steps"] as const;

/** Step-review verdict outcomes (KTD-4), authored as `outcome:<verdict>` edge
 *  conditions and displayed as short labels. */
const STEP_REVIEW_VERDICTS = ["approve", "revise", "rethink", "unavailable"] as const;
const NOTIFY_EVENT_OPTIONS = [
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "task-created",
  "workflow-notify",
] as const;
const NOTIFY_CUSTOM_EVENT_VALUE = "__custom";
const WORKFLOW_CLI_COMMAND_PLACEHOLDER = "npm test -- --runInBand";
const WORKFLOW_CODE_SOURCE_PLACEHOLDER = "export default async (ctx) => ({ outcome: \"success\" });";
const WORKFLOW_NOTIFY_MESSAGE_PLACEHOLDER = "Task {{taskId}} reached {{workflowName}}";

const PALETTE: Array<{ kind: WorkflowEditorNodeKind; label: string; icon: typeof MessageSquare; presetConfig?: Record<string, unknown> }> = [
  { kind: "prompt", label: "Prompt", icon: MessageSquare },
  // FNXC:WorkflowAskUser 2026-07-05-00:00: FN-7579 promotes the formerly generic
  // "User input" entry (a `prompt` node with a hidden `awaitInput: true` preset)
  // into the first-class "Ask user question" node (`kind: "ask-user"`). The old
  // `prompt` + `config.awaitInput: true` shape still validates and parks/resumes
  // unchanged (back-compat alias) — it is just no longer offered from the
  // palette, so there is one discoverable entry point, not two.
  // FNXC:WorkflowAskUser 2026-07-05-01:30: no presetConfig here — an ask-user
  // node's `config.question` key must be ABSENT (not an empty string) to fall
  // back to the engine's default prompt; validateAskUserAndExitGateNodes
  // rejects a present-but-empty question, so seeding `{ question: "" }` here
  // would make every freshly dropped, untouched node fail to save.
  { kind: "ask-user", label: "Ask user question", icon: HelpCircle },
  { kind: "exit-gate", label: "Exit gate", icon: DoorOpen },
  { kind: "script", label: "Script", icon: Terminal },
  { kind: "gate", label: "Gate", icon: Shield },
  { kind: "merge", label: "Merge boundary", icon: GitMerge },
  { kind: "hold", label: "Hold", icon: PauseCircle, presetConfig: { release: "manual" } },
  { kind: "split", label: "Split", icon: Split },
  { kind: "join", label: "Join", icon: Merge, presetConfig: { mode: "all", onBranchFailure: "collect" } },
  // Step-inversion (KTD-3/4/12/15).
  { kind: "foreach", label: "For-each step", icon: Repeat, presetConfig: { source: "task-steps" } },
  { kind: "loop", label: "Loop", icon: Repeat, presetConfig: { maxIterations: 3, exitWhen: { type: "output-contains", value: "DONE" } } },
  // FNXC:WorkflowOptionalGroup 2026-06-21-11:30: An optional-group container holds a template subgraph run once when the task enables it (per-task `enabledWorkflowSteps`, seeded from `defaultOn`) and skipped otherwise.
  { kind: "optional-group", label: "Optional group", icon: ToggleRight, presetConfig: { defaultOn: false } },
  { kind: "step-review", label: "Step review", icon: ClipboardCheck, presetConfig: { type: "code" } },
  { kind: "parse-steps", label: "Parse steps", icon: ListChecks, presetConfig: { artifact: "PROMPT.md", parser: "step-headings" } },
  { kind: "code", label: "Code", icon: Code2, presetConfig: { source: "" } },
  { kind: "notify", label: "Notify", icon: Bell, presetConfig: { event: "in-review", title: "{{taskTitle}}", message: "" } },
];

/** Map a step template to a single pre-configured editor node (kind + config),
 *  mirroring the U1 `stepInputToNode` converter's field mapping (mode → kind;
 *  prompt/scriptName/toolMode/gateMode/model overrides → config). Inserting one
 *  template thus produces the same node the steps→IR migration would. */
function stepTemplateToNode(tpl: WorkflowStepTemplate): {
  kind: WorkflowEditorNodeKind;
  label: string;
  config: Record<string, unknown>;
} {
  const config: Record<string, unknown> = {
    name: tpl.name,
    // Always carry gateMode so a materialized node round-trips both modes.
    gateMode: tpl.gateMode ?? "advisory",
  };
  if (tpl.description) config.description = tpl.description;

  if (tpl.mode === "script") {
    if (tpl.scriptName) config.scriptName = tpl.scriptName;
    return { kind: "script", label: tpl.name, config };
  }

  // prompt mode (default)
  config.prompt = tpl.prompt ?? "";
  config.toolMode = tpl.toolMode === "coding" ? "coding" : "readonly";
  // Model overrides only round-trip when BOTH are present (compiler requirement).
  if (tpl.modelProvider && tpl.modelId) {
    config.modelProvider = tpl.modelProvider;
    config.modelId = tpl.modelId;
  }
  /*
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Template-seeded prompt nodes preserve reasoning effort independently from model selection so authors can inherit a model while pinning per-node thinking.
   */
  if (tpl.thinkingLevel) config.thinkingLevel = tpl.thinkingLevel;
  return { kind: "prompt", label: tpl.name, config };
}

// Node kinds a user authors from the palette. Structural/derived nodes
// (start/end and column bands — which map to data.kind "start") are excluded, so
// a fresh start→end graph counts as trivial. Used by the palette-hint (R9).
const USER_NODE_KINDS: ReadonlySet<WorkflowEditorNodeKind> = new Set<WorkflowEditorNodeKind>([
  "prompt",
  "script",
  "gate",
  "code",
  "hold",
  "split",
  "join",
  "foreach",
  "loop",
  "optional-group",
  "step-review",
  "parse-steps",
  "notify",
  "merge",
  "ask-user",
  "exit-gate",
]);

/** A pickable creation template: "Blank" (id null) or a copyable source
 *  workflow (built-in or user kind="workflow"). U4/R7. */
interface WorkflowCreateTemplate {
  /** null = blank; otherwise the source definition's id. */
  id: string | null;
  name: string;
  description: string;
  /** Optional compact icon copied from custom workflow sources. */
  icon?: string;
  /** Node count of the source IR (0 for blank). */
  nodeCount: number;
  /** Source definition for seeding via copyIrWithFreshIds (absent for blank). */
  source?: WorkflowDefinition;
  /** True for built-in sources (grouped separately). */
  builtin: boolean;
}

/** Local create-workflow dialog (KTD-7). Built on the shared `.modal` primitives
 *  (precedent: NewTaskModal). Owns its own template/name/description/error state;
 *  the parent supplies the candidate `workflows` (fragments filtered out here)
 *  and an async `onCreate` that performs the createWorkflow call and throws on
 *  failure so the dialog can surface server rejections inline without losing the
 *  typed input. Escape/overlay close (no dirty state of its own).
 *
 *  U4/R7: a template step precedes the name/description fields — a
 *  radiogroup-semantics option list (Blank default-selected + built-ins + user
 *  workflows) navigable by ArrowUp/Down; selecting a template prefills the name
 *  ("<source> copy") while untouched and inherits the source description. */
function CreateWorkflowDialog({
  workflows,
  onCreate,
  onDesign,
  onClose,
}: {
  workflows: WorkflowDefinition[];
  onCreate: (name: string, description: string, icon: string, template: WorkflowCreateTemplate) => Promise<void>;
  /** U10/R11: design a brand-new workflow from a prompt. Resolves on success
   *  (the parent seeds + activates the workflow and closes the dialog); throws on
   *  failure so the dialog surfaces the server message inline without closing.
   *  `signal` aborts the in-flight design request. */
  onDesign: (prompt: string, name: string, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("app");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // U10/R11: AI-design disclosure state. `aiOpen` reveals the prompt textarea;
  // `aiPrompt` holds the request; `aiBusy` flags the in-flight design call (the
  // submit disables + a spinner + Cancel show); `aiError` is the inline failure.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  // Tracks whether the user has edited the name; once true, selecting a template
  // no longer overwrites it (R7: prefill only when untouched).
  const [nameTouched, setNameTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Build the option list: Blank first (default), then built-in workflows, then
  // the user's own kind="workflow" definitions. Fragments are excluded entirely.
  const templates = useMemo<WorkflowCreateTemplate[]>(() => {
    const blank: WorkflowCreateTemplate = {
      id: null,
      name: t("workflows.templateBlank", "Blank"),
      description: t("workflows.templateBlankDescription", "Start from an empty start → end graph."),
      nodeCount: 0,
      builtin: false,
    };
    const usable = workflows.filter((w) => w.kind !== "fragment");
    const toTemplate = (w: WorkflowDefinition): WorkflowCreateTemplate => ({
      id: w.id,
      name: w.name,
      description: w.description ?? "",
      icon: w.icon,
      nodeCount: w.ir.nodes.length,
      source: w,
      builtin: isBuiltinWorkflowId(w.id),
    });
    const builtins = usable.filter((w) => isBuiltinWorkflowId(w.id)).map(toTemplate);
    const yours = usable.filter((w) => !isBuiltinWorkflowId(w.id)).map(toTemplate);
    return [blank, ...builtins, ...yours];
  }, [workflows, t]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = templates[selectedIndex] ?? templates[0];

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Apply a template selection: move the radio focus state and (R7) prefill the
  // name ("<source> copy") only while the user has not edited it. Description and
  // copy icon follow the selected source so typed-name copies still satisfy the
  // custom-workflow icon contract.
  const selectTemplate = useCallback(
    (index: number) => {
      const tmpl = templates[index];
      if (!tmpl) return;
      setSelectedIndex(index);
      if (tmpl.id === null) {
        if (!nameTouched) setName("");
        setDescription("");
        setIcon("");
      } else {
        if (!nameTouched) {
          setName(t("workflows.templateCopyName", "{{name}} copy", { name: tmpl.name }));
        }
        setDescription(tmpl.description);
        /*
        FNXC:WorkflowIcons 2026-06-30-12:20:
        Copying a built-in or iconless workflow must create an editable custom workflow with a non-Fusion icon, while custom workflow copies preserve their existing non-Fusion icon.

        FNXC:WorkflowIcons 2026-06-30-15:06:
        Template selection must default the copied icon even after the author types a custom name; only the name prefill is protected by the dirty-name guard.
        */
        setIcon(tmpl.builtin || !tmpl.icon ? "✨" : tmpl.icon);
      }
      if (error) setError(null);
    },
    [templates, nameTouched, error, t],
  );

  // ArrowUp/Down move the radio selection; Enter confirms and shifts focus to
  // the name input. Other keys (incl. Escape) bubble to the dialog handler.
  const handleOptionKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = Math.min(selectedIndex + 1, templates.length - 1);
        selectTemplate(next);
        optionRefs.current[next]?.focus();
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = Math.max(selectedIndex - 1, 0);
        selectTemplate(prev);
        optionRefs.current[prev]?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTemplate(selectedIndex);
        nameRef.current?.focus();
      }
    },
    [selectedIndex, templates.length, selectTemplate],
  );

  const overlayProps = useOverlayDismiss(onClose);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) {
        setError(t("workflows.createNameRequired", "Enter a workflow name"));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await onCreate(trimmed, description.trim(), icon.trim(), selected);
        // Success path closes the dialog from the parent.
      } catch (err) {
        setError(getErrorMessage(err) || t("workflows.createFailed", "Failed to create workflow"));
        setSubmitting(false);
      }
    },
    [name, description, icon, selected, onCreate, t],
  );

  // U10/R11: submit the AI design request. On success the parent seeds the
  // workflow and closes the dialog; on failure the server message renders inline
  // (role="alert") and the dialog stays open. The fetch is cancelable via the
  // Cancel button (AbortController); an abort re-enables the controls silently.
  const handleAiSubmit = useCallback(async () => {
    const trimmed = aiPrompt.trim();
    if (!trimmed) {
      setAiError(t("workflows.aiPromptRequired", "Describe the workflow you want"));
      return;
    }
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiBusy(true);
    setAiError(null);
    try {
      await onDesign(trimmed, name.trim(), controller.signal);
      // Success closes the dialog from the parent.
    } catch (err) {
      if (controller.signal.aborted) {
        // User-initiated cancel: re-enable silently (no error message).
        return;
      }
      setAiError(getErrorMessage(err) || t("workflows.aiFailed", "Failed to design workflow"));
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      setAiBusy(false);
    }
  }, [aiPrompt, name, onDesign, t]);

  const handleAiCancel = useCallback(() => {
    aiAbortRef.current?.abort();
    setAiBusy(false);
  }, []);

  // Section boundaries for group headers (built-ins / your workflows). Blank is
  // always index 0; built-ins follow, then user workflows.
  const firstBuiltinIndex = templates.findIndex((tmpl) => tmpl.id !== null && tmpl.builtin);
  const firstYoursIndex = templates.findIndex((tmpl) => tmpl.id !== null && !tmpl.builtin);

  return (
    <div className="modal-overlay open wf-create-overlay" {...overlayProps}>
      <div
        className="modal wf-create-modal"
        data-testid="wf-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("workflows.createTitle", "New workflow")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-header">
          <h3>{t("workflows.createTitle", "New workflow")}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t("actions.close", "Close")}
          >
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* U10/R11: AI-design disclosure. Toggling reveals a prompt textarea
                + "Design with AI" submit; submitting designs a brand-new workflow
                from the result (the parent seeds + activates it). In-flight: the
                submit disables + spins, aria-busy is set on the section, and a
                Cancel aborts the fetch. Failure renders inline (role="alert"). */}
            <div className="wf-ai-create" aria-busy={aiBusy} data-testid="wf-ai-create">
              <button
                type="button"
                className="wf-ai-toggle"
                data-testid="wf-ai-toggle"
                aria-expanded={aiOpen}
                onClick={() => {
                  setAiOpen((o) => !o);
                  setAiError(null);
                }}
              >
                <Sparkles size={13} />{" "}
                {t("workflows.aiToggle", "Describe it instead")}
              </button>
              {aiOpen && (
                <div className="wf-ai-create-body">
                  <textarea
                    className="wf-ai-prompt"
                    data-testid="wf-ai-prompt"
                    rows={3}
                    value={aiPrompt}
                    disabled={aiBusy}
                    placeholder={t(
                      "workflows.aiPromptPlaceholder",
                      "e.g. Run lint and tests before merge, then post a changelog comment after merge",
                    )}
                    onChange={(e) => {
                      setAiPrompt(e.target.value);
                      if (aiError) setAiError(null);
                    }}
                  />
                  {aiError && (
                    <p className="wf-create-error" role="alert" data-testid="wf-ai-error">
                      {aiError}
                    </p>
                  )}
                  <div className="wf-ai-actions">
                    <button
                      type="button"
                      className="btn btn-primary wf-ai-submit"
                      data-testid="wf-ai-submit"
                      disabled={aiBusy}
                      onClick={() => void handleAiSubmit()}
                    >
                      {aiBusy ? <Loader2 size={13} className="wf-spin" /> : <Sparkles size={13} />}{" "}
                      {t("workflows.aiSubmit", "Design with AI")}
                    </button>
                    {aiBusy && (
                      <button
                        type="button"
                        className="btn wf-ai-cancel"
                        data-testid="wf-ai-cancel"
                        onClick={handleAiCancel}
                      >
                        {t("common.cancel", "Cancel")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="wf-field">
              <span id="wf-template-label">{t("workflows.templatePickerLabel", "Start from")}</span>
              <div
                className="wf-template-list"
                role="radiogroup"
                aria-labelledby="wf-template-label"
                data-testid="wf-template-list"
              >
                {templates.map((tmpl, index) => {
                  const isSelected = index === selectedIndex;
                  const optionKey = tmpl.id ?? "blank";
                  return (
                    <div key={optionKey}>
                      {index === firstBuiltinIndex && firstBuiltinIndex >= 0 && (
                        <p className="wf-template-section wf-template-section--icon">
                          <WorkflowIcon workflowId="builtin:template-section" decorative />
                          <span>{t("workflows.templateSectionBuiltin", "Fusion workflows")}</span>
                        </p>
                      )}
                      {index === firstYoursIndex && firstYoursIndex >= 0 && (
                        <p className="wf-template-section">
                          {t("workflows.templateSectionYours", "Your workflows")}
                        </p>
                      )}
                      <div
                        ref={(el) => {
                          optionRefs.current[index] = el;
                        }}
                        role="radio"
                        aria-checked={isSelected}
                        tabIndex={isSelected ? 0 : -1}
                        className={`wf-template-option${isSelected ? " selected" : ""}`}
                        data-testid={tmpl.id === null ? "wf-template-option-blank" : `wf-template-option-${tmpl.id}`}
                        onClick={() => {
                          selectTemplate(index);
                          optionRefs.current[index]?.focus();
                        }}
                        onKeyDown={handleOptionKeyDown}
                      >
                        <span className="wf-template-option-heading">
                          <WorkflowIcon workflowId={tmpl.id ?? ""} icon={tmpl.icon} decorative />
                          <span className="wf-template-option-name">{tmpl.name}</span>
                        </span>
                        {tmpl.description && (
                          <span className="wf-template-option-desc">{tmpl.description}</span>
                        )}
                        {tmpl.id !== null && (
                          <span className="wf-template-option-count">
                            {t("workflows.templateNodeCount", "{{count}} nodes", { count: tmpl.nodeCount })}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <label className="wf-field">
              <span>{t("workflows.createName", "Name")}</span>
              <input
                ref={nameRef}
                data-testid="wf-create-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                  if (error) setError(null);
                }}
              />
            </label>
            <label className="wf-field">
              <span>{t("workflows.iconLabel", "Icon (optional)")}</span>
              <input
                data-testid="wf-create-icon"
                value={icon}
                maxLength={16}
                placeholder={t("workflows.iconPlaceholder", "e.g. 🚀")}
                onChange={(e) => setIcon(e.target.value)}
              />
            </label>
            <label className="wf-field">
              <span>{t("workflows.createDescription", "Description (optional)")}</span>
              <textarea
                rows={2}
                data-testid="wf-create-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {error && (
              <p className="wf-create-error" role="alert" data-testid="wf-create-error">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t("common.cancel", "Cancel")}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="wf-create-submit"
              disabled={submitting}
            >
              {submitting ? <Loader2 size={13} className="wf-spin" /> : null}{" "}
              {t("workflows.createSubmit", "Create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InnerEditor({
  onClose,
  addToast,
  projectId,
  initialPanel,
  initialAction,
  initialWorkflowId,
  modalRef,
  isEmbedded = false,
}: Omit<WorkflowNodeEditorProps, "isOpen" | "presentation"> & {
  modalRef: React.RefObject<HTMLDivElement | null>;
  isEmbedded?: boolean;
}) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const viewportMode = useViewportMode();
  const isMobileMode = viewportMode === "mobile";
  const [workflowListStageOpen, setWorkflowListStageOpen] = useState(() => isMobileViewport());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode<WorkflowFlowNodeData>>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [miniMapCollapsed, setMiniMapCollapsed] = useState(false);
  // FNXC:WorkflowSimpleView 2026-07-10-12:00: three-mode desktop view state
  // (see the WorkflowEditorViewMode note above). Persisted so operators land
  // back in the mode they work in; "simple" is the default for everyone else.
  const [viewMode, setViewMode] = useState<WorkflowEditorViewMode>(() => {
    try {
      const stored = localStorage.getItem(viewModeStorageKey);
      if (stored === "simple" || stored === "advanced" || stored === "list") return stored;
    } catch {
      // localStorage unavailable: non-fatal.
    }
    return "simple";
  });
  useEffect(() => {
    try {
      localStorage.setItem(viewModeStorageKey, viewMode);
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [viewMode]);
  // Mobile graph tab presentation: simplified canvas (default) or row list.
  const [mobileGraphStyle, setMobileGraphStyle] = useState<MobileGraphStyle>(() => {
    try {
      const stored = localStorage.getItem(mobileGraphStyleStorageKey);
      if (stored === "canvas" || stored === "list") return stored;
    } catch {
      // localStorage unavailable: non-fatal.
    }
    return "canvas";
  });
  useEffect(() => {
    try {
      localStorage.setItem(mobileGraphStyleStorageKey, mobileGraphStyle);
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [mobileGraphStyle]);
  const [mobilePanel, setMobilePanel] = useState<MobileWorkflowPanel>(() =>
    initialPanel === "settings" ? "settings" : "graph",
  );
  // "list" keeps the pre-existing compact (mobile-shell) presentation.
  const simpleLayoutEnabled = isMobileMode || viewMode === "list";
  // Desktop simplified graphical view (not the list fallback, not mobile).
  const simpleViewEnabled = !simpleLayoutEnabled && viewMode === "simple";
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  // Create-workflow dialog (KTD-7) open state + focus-return ref to the
  // "New workflow" button (NewTaskModal focus pattern).
  const [createOpen, setCreateOpen] = useState(initialAction === "create");
  const newWorkflowBtnRef = useRef<HTMLButtonElement>(null);
  const mobileInitialWorkflowDismissedRef = useRef<string | null>(null);
  // Inline-editable name/description (KTD-10). `name`/`description` mirror the
  // active workflow and are persisted through handleSave; `editingName`/
  // `editingDescription` flag the active inline input.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  // Snapshot of the workflow as loaded, serialized through flowToIr AFTER
  // irToFlow so mapping-layer defaults (e.g. condition: "success", config
  // materialization) are present on both sides of the dirty comparison. Set by
  // the load effect; compared against the live serialization in `isDirty`.
  const loadedSnapshotRef = useRef<string | null>(null);
  // v2 columns the editor is authoring for the active workflow.
  const [columns, setColumns] = useState<WorkflowIrColumn[]>([]);
  // v2 custom field definitions the editor is authoring (KTD-13/14, U13).
  const [fields, setFields] = useState<WorkflowFieldDefinition[]>([]);
  // v2 typed setting declarations the editor is authoring (U6, KTD-1). Setting
  // VALUES live per-project in the workflow_settings table (KTD-2) and are
  // managed by the panel's Values tab, not this declaration array.
  const [settings, setSettings] = useState<WorkflowSettingDefinition[]>([]);
  /* FNXC:WorkflowOptionalGroup 2026-06-21-18:00:
     The legacy optional-step DECLARATION authoring state/panel is removed. Optional
     steps are graph-native `optional-group` nodes authored through the canvas; the
     editor no longer carries a separate `optionalSteps` declaration array. */
  // FNXC:WorkflowEditor 2026-06-21-20:06:
  // Built-in workflow graph structure remains read-only, but prompt/gate node prompts need a separate per-project override state so editing prompts does not mark structural graph edits dirty or use the read-only workflow PATCH authority.
  const [promptOverrides, setPromptOverrides] = useState<WorkflowPromptOverridesPayload | null>(null);
  const [promptOverrideSavingNodeId, setPromptOverrideSavingNodeId] = useState<string | null>(null);
  // Ref to the settings panel so a `?panel=settings` deep link can scroll it
  // into view on mount (U6/U9 redirect stubs).
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const [traitCatalog, setTraitCatalog] = useState<TraitCatalogEntry[]>([]);
  // Step-parser ids for the parse-steps inspector (KTD-12). Seeded with the
  // built-in pair so the select is never empty; replaced by the live catalog
  // (built-ins + plugin parsers) once GET /api/step-parsers resolves.
  const [stepParsers, setStepParsers] = useState<string[]>([...BUILTIN_STEP_PARSERS]);

  // U9/R8: palette Templates section sources. Built-in + plugin step templates
  // (fetched once on open) and the fragment definitions (derived from the loaded
  // workflow list, kind === "fragment"). The collapsed state persists in
  // localStorage; the inline conflict error is the persistent seam-duplication
  // notice rendered inside the section.
  const [stepTemplates, setStepTemplates] = useState<WorkflowStepTemplate[]>([]);
  const [pluginTemplates, setPluginTemplates] = useState<
    Array<{ pluginId: string; template: WorkflowStepTemplate }>
  >([]);
  const templatesCollapsedStorageKey = "fusion:wf-templates-collapsed";
  const [templatesCollapsed, setTemplatesCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(templatesCollapsedStorageKey);
      if (stored != null) return stored === "1";
      return isMobileViewport();
    } catch {
      return false;
    }
  });
  const [templateFilter, setTemplateFilter] = useState("");
  const [templateConflict, setTemplateConflict] = useState<string | null>(null);
  const canvasNodesMaterializedRef = useRef(false);

  // U12: the columns/fields authoring panels live in the left sidebar (below the
  // workflow list) as collapsible disclosure sections. Each section's collapsed
  // state persists in localStorage; default expanded.
  /*
  FNXC:WorkflowSidebar 2026-06-22-12:00:
  The workflow view needs the entire left sidebar collapsible, not only its
  internal column/field/settings groups, so graph editing can use the full
  canvas width. Persist the shell state and keep a visible restore control in
  the canvas area when the sidebar is hidden.
  */
  const sidebarCollapsedStorageKey = "fusion:wf-left-sidebar-collapsed";
  const columnsCollapsedStorageKey = "fusion:wf-sidebar-columns-collapsed";
  const fieldsCollapsedStorageKey = "fusion:wf-sidebar-fields-collapsed";
  const settingsCollapsedStorageKey = "fusion:wf-sidebar-settings-collapsed";
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(sidebarCollapsedStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [columnsCollapsed, setColumnsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(columnsCollapsedStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [fieldsCollapsed, setFieldsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(fieldsCollapsedStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [settingsCollapsed, setSettingsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(settingsCollapsedStorageKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(sidebarCollapsedStorageKey, sidebarCollapsed ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(columnsCollapsedStorageKey, columnsCollapsed ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [columnsCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(fieldsCollapsedStorageKey, fieldsCollapsed ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [fieldsCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(settingsCollapsedStorageKey, settingsCollapsed ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [settingsCollapsed]);
  // React Flow instance for programmatic viewport control (auto-layout on load).
  const { setViewport } = useReactFlow();
  // Wrapper around <ReactFlow> so keyboard deletion can return focus to the
  // canvas container (R6) instead of leaving it on a now-removed node.
  const canvasRef = useRef<HTMLDivElement>(null);

  // U5/R10: import affordance state. `importError` renders a PERSISTENT inline
  // error region (not a toast) for client parse failures and server 4xx
  // validation failures; `importWarnings` renders non-blocking notes in the same
  // region. The hidden file input is reset after every attempt.
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // U10/R11: toolbar "Design with AI" panel state. `aiPanelOpen` toggles the
  // popover; `aiEditPrompt` holds the request; `aiEditBusy` flags the in-flight
  // call (submit disables + spins, Cancel shows); `aiEditError` is the inline
  // failure. The proposed replacement applies only through the dirty-guard
  // confirm — and always confirms (destructive whole-graph replace).
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiEditPrompt, setAiEditPrompt] = useState("");
  const [aiEditBusy, setAiEditBusy] = useState(false);
  const [aiEditError, setAiEditError] = useState<string | null>(null);
  const aiEditAbortRef = useRef<AbortController | null>(null);

  const activeWorkflow = useMemo(() => workflows.find((w) => w.id === activeId), [workflows, activeId]);
  const isBuiltin = !!activeWorkflow && isBuiltinWorkflowId(activeWorkflow.id);
  const lifecycleWarnings = activeWorkflow?.lifecycleWarnings ?? [];

  // Live mirror of the active workflow id, readable inside async callbacks that
  // captured an earlier value before an await (e.g. the AI-design round-trip).
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Trivial-graph palette hint (R9): a user-owned workflow whose graph carries no
  // user-authored node yet (everything is start/end/column-band — column bands map
  // to data.kind "start"). Disappears as soon as any user node exists; never shows
  // for built-ins.
  const isTrivialUserGraph = useMemo(() => {
    if (!activeWorkflow || isBuiltin) return false;
    return !nodes.some((n) => USER_NODE_KINDS.has(n.data.kind));
  }, [activeWorkflow, isBuiltin, nodes]);

  // FNXC:WorkflowColumns 2026-06-22-18:00:
  // Workflow columns and the graph engine graduated from Experimental. Column
  // agent authoring is available by default; stale persisted flag values do not
  // disable the picker or make bindings inert.
  const columnAgentsEnabled = true;

  // Trait catalog (for client-side composition validation; the panel fetches its
  // own copy for the picker, but the editor needs the flags to validate).
  useEffect(() => {
    let cancelled = false;
    fetchTraits(projectId)
      .then((catalog) => {
        if (!cancelled) setTraitCatalog(catalog);
      })
      .catch(() => {
        // Non-fatal: validation degrades to server-side parse on save.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Step-parser catalog (KTD-12) for the parse-steps inspector's parser select.
  // Merges built-ins with any registered plugin parsers; falls back to the
  // built-in pair if the fetch fails so the select always has options.
  useEffect(() => {
    let cancelled = false;
    fetchStepParsers(projectId)
      .then((ids) => {
        if (!cancelled && ids.length > 0) setStepParsers(ids);
      })
      .catch(() => {
        // Non-fatal: keep the built-in fallback already in state.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // U9/R8: built-in + plugin step templates for the palette Templates section.
  // Fetched once on open; non-fatal on failure (the subsections simply stay
  // empty and hide). Fragments come from the workflow list, not a separate fetch.
  useEffect(() => {
    let cancelled = false;
    fetchWorkflowStepTemplates()
      .then((res) => {
        if (!cancelled) setStepTemplates(res.templates ?? []);
      })
      .catch(() => {
        // Non-fatal: Built-in steps subsection stays empty.
      });
    fetchPluginWorkflowStepTemplates()
      .then((res) => {
        if (!cancelled) setPluginTemplates(res.templates ?? []);
      })
      .catch(() => {
        // Non-fatal: Plugin steps subsection stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the Templates section collapsed state.
  useEffect(() => {
    try {
      localStorage.setItem(templatesCollapsedStorageKey, templatesCollapsed ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode / SSR): non-fatal.
    }
  }, [templatesCollapsed]);

  useEffect(() => {
    if (selectedNodeId) setInspectorCollapsed(false);
  }, [selectedNodeId]);

  useEffect(() => {
    if (initialPanel === "settings") setMobilePanel("settings");
  }, [initialPanel]);

  // U9/R8: fragment definitions surface from the loaded workflow list (kind ===
  // "fragment"); they are excluded from the sidebar workflow list elsewhere.
  const fragments = useMemo(
    () => workflows.filter((w) => w.kind === "fragment"),
    [workflows],
  );

  // U9/R8: alphabetical, filtered subsection entries. The filter (a single text
  // input) matches across all groups by name and only appears once the combined
  // entry count exceeds 8. Empty subsections are hidden by the render.
  const templateGroups = useMemo(() => {
    const q = templateFilter.trim().toLowerCase();
    const matches = (name: string) => !q || name.toLowerCase().includes(q);
    const byName = <T extends { name: string }>(a: T, b: T) =>
      a.name.localeCompare(b.name);

    const fragmentEntries = [...fragments]
      .sort(byName)
      .filter((f) => matches(f.name));
    const stepEntries = [...stepTemplates]
      .sort(byName)
      .filter((s) => matches(s.name));
    const pluginEntries = [...pluginTemplates]
      .sort((a, b) => a.template.name.localeCompare(b.template.name))
      .filter((p) => matches(p.template.name));

    return { fragmentEntries, stepEntries, pluginEntries };
  }, [fragments, stepTemplates, pluginTemplates, templateFilter]);

  // Total entries available (pre-filter) — drives whether the filter input shows.
  const templateTotalCount =
    fragments.length + stepTemplates.length + pluginTemplates.length;
  const hasAnyTemplate = templateTotalCount > 0;

  // Composition violations (client mirror of validateColumnTraits).
  const columnViolations: TraitViolation[] = useMemo(
    () => (columns.length ? validateColumnsClient(columns, traitCatalog) : []),
    [columns, traitCatalog],
  );
  // Step nodes not placed in any column (v2 only).
  const unplaced = useMemo(() => unplacedNodeIds(nodes, columns), [nodes, columns]);
  const blockingViolationCount = columnViolations.filter((v) => v.severity === "error").length;

  // Dirty = the normalized live serialization differs from the loaded snapshot
  // (U4). Built-ins are never dirty (read-only). Memoized over the inputs that
  // feed serializeGraph; the loaded snapshot is a ref set by the load effect.
  const isDirty = useMemo(() => {
    if (isBuiltin) return false;
    if (!activeWorkflow || loadedSnapshotRef.current === null) return false;
    return (
      serializeGraph(name, description, icon, nodes, edges, columns, fields, settings) !==
      loadedSnapshotRef.current
    );
  }, [isBuiltin, activeWorkflow, name, description, icon, nodes, edges, columns, fields, settings]);

  const loadWorkflows = useCallback(async (options?: { forceFresh?: boolean }) => {
    setLoading(true);
    try {
      const data = await fetchWorkflows(projectId, options);
      setWorkflows(data);
      setActiveId((prev) => {
        if (prev && data.some((workflow) => workflow.id === prev)) return prev;
        if (initialAction !== "create" && initialWorkflowId && data.some((workflow) => workflow.id === initialWorkflowId)) {
          return initialWorkflowId;
        }
        return isMobileMode ? null : data[0]?.id ?? null;
      });
    } catch (err) {
      addToast(getErrorMessage(err) || t("workflows.loadFailed", "Failed to load workflows"), "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, addToast, isMobileMode, initialAction, initialWorkflowId, t]);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    /*
    FNXC:ChatWorkflowAuthoring 2026-07-01-10:55:
    WorkflowNodeEditor can be open while chat/tool execution creates a workflow through ChatManager rather than this component's create/import buttons. Subscribe to workflow lifecycle SSE and force-refresh definitions so the editor list shows chat-created workflows without a hard reload or stale deduped request.
    */
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const refreshFromWorkflowMutation = () => {
      void loadWorkflows({ forceFresh: true });
    };
    return subscribeSse(`/api/events${query}`, {
      events: {
        "workflow:created": refreshFromWorkflowMutation,
        "workflow:updated": refreshFromWorkflowMutation,
        "workflow:deleted": refreshFromWorkflowMutation,
      },
    });
  }, [loadWorkflows, projectId]);

  useEffect(() => {
    if (!initialWorkflowId || !isMobileMode || !workflowListStageOpen) return;
    if (activeId !== initialWorkflowId) return;
    if (mobileInitialWorkflowDismissedRef.current === initialWorkflowId) return;
    mobileInitialWorkflowDismissedRef.current = initialWorkflowId;
    setWorkflowListStageOpen(false);
  }, [activeId, initialWorkflowId, isMobileMode, workflowListStageOpen]);

  // FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c removed the on-open legacy-step
  // migration trigger and its one-time notice. The legacy workflow_steps table was
  // dropped; workflow steps run graph-native, so there is nothing to migrate.

  // U5/R9: export the active workflow as a downloaded JSON envelope. Enabled for
  // built-ins; the caller gates on `isDirty` (a stale export is impossible
  // because the server reads the persisted definition). Network failures toast.
  const handleExport = useCallback(async () => {
    if (!activeWorkflow) return;
    try {
      await exportWorkflow(activeWorkflow.id, projectId);
    } catch (err) {
      addToast(getErrorMessage(err) || t("workflows.exportFailed", "Failed to export workflow"), "error");
    }
  }, [activeWorkflow, projectId, addToast, t]);

  // U5/R10: import a workflow envelope from a selected file. Validation failures
  // (client JSON.parse or server 4xx) populate the PERSISTENT inline error region
  // — never a toast. Network/5xx errors toast. The file input resets after every
  // attempt so re-selecting the same file fires `onChange` again.
  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input immediately so the same file can be re-picked later.
      if (importInputRef.current) importInputRef.current.value = "";
      if (!file) return;
      setImportError(null);
      setImportWarnings([]);
      setImporting(true);
      try {
        const text = await file.text();
        let envelope: unknown;
        try {
          envelope = JSON.parse(text);
        } catch {
          setImportError(t("workflows.importInvalidJson", "That file isn't valid JSON."));
          return;
        }
        const result = await importWorkflow(envelope, projectId);
        await loadWorkflows();
        setActiveId(result.workflow.id);
        setWorkflowListStageOpen(false);
        addToast(
          t("workflows.imported", 'Imported workflow "{{name}}"', { name: result.workflow.name }),
          "success",
        );
        if (result.strippedApprovalFlags) {
          addToast(
            t("workflows.importStripped", "Auto-approval flags were removed from imported nodes"),
            "warning",
          );
        }
        if (result.warnings.length > 0) setImportWarnings(result.warnings);
      } catch (err) {
        // 4xx → persistent inline validation error; anything else → toast.
        if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) {
          setImportError(getErrorMessage(err) || t("workflows.importFailed", "Import failed"));
        } else {
          addToast(getErrorMessage(err) || t("workflows.importFailed", "Import failed"), "error");
        }
      } finally {
        setImporting(false);
      }
    },
    [projectId, loadWorkflows, addToast, t],
  );

  // Load the active workflow graph into the canvas.
  useEffect(() => {
    canvasNodesMaterializedRef.current = false;
    if (!activeWorkflow) {
      setNodes([]);
      setEdges([]);
      setColumns([]);
      setFields([]);
      setSettings([]);
      setPromptOverrides(null);
      setPromptOverrideSavingNodeId(null);
      setName("");
      setDescription("");
      setIcon(undefined);
      loadedSnapshotRef.current = null;
      return;
    }
    const flow = irToFlow(activeWorkflow);
    const loadedColumns = columnsOf(activeWorkflow);
    const loadedFields = fieldsOf(activeWorkflow);
    const loadedSettings = settingsOf(activeWorkflow);
    // Auto-layout on load: compute tidy positions and apply them before the
    // first render so nodes are visible in the top-left viewport.
    const layoutPositions = autoLayout(flow.nodes, flow.edges, loadedColumns);
    const laidOutNodes = applyAutoLayout(flow.nodes, layoutPositions);
    setNodes(laidOutNodes);
    setEdges(flow.edges);
    setColumns(loadedColumns);
    setFields(loadedFields);
    setSettings(loadedSettings);
    setName(activeWorkflow.name);
    setDescription(activeWorkflow.description ?? "");
    setIcon(activeWorkflow.icon);
    setEditingName(false);
    setEditingDescription(false);
    // Compute the normalized loaded snapshot from the materialized flow (so
    // mapping defaults match the live side) plus name/description.
    loadedSnapshotRef.current = serializeGraph(
      activeWorkflow.name,
      activeWorkflow.description ?? "",
      activeWorkflow.icon,
      laidOutNodes,
      flow.edges,
      loadedColumns,
      loadedFields,
      loadedSettings,
    );
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setValidationError(null);
    // Position viewport at top-left so the laid-out nodes are visible.
    setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
  }, [activeWorkflow, setNodes, setEdges, setViewport]);

  useEffect(() => {
    if (nodes.length > 0) canvasNodesMaterializedRef.current = true;
  }, [nodes]);

  useEffect(() => {
    if (!activeWorkflow || !isBuiltin) {
      setPromptOverrides(null);
      setPromptOverrideSavingNodeId(null);
      return;
    }
    let cancelled = false;
    void fetchWorkflowPromptOverrides(activeWorkflow.id, projectId)
      .then((payload) => {
        if (cancelled) return;
        setPromptOverrides(payload);
        setNodes((ns) =>
          ns.map((node) => {
            if (node.data.kind !== "prompt" && node.data.kind !== "gate") return node;
            const effective = payload.effective[node.id];
            if (effective === undefined) return node;
            return {
              ...node,
              data: {
                ...node.data,
                config: { ...(node.data.config ?? {}), prompt: effective },
              },
            };
          }),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        addToast(getErrorMessage(err) || t("workflowEditor.promptOverridesLoadFailed", "Failed to load prompt overrides"), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkflow, isBuiltin, projectId, addToast, t, setNodes]);

  // `?panel=settings` deep link (U6/U9 redirect stubs): once the active workflow
  // has loaded, scroll the settings panel into view. Runs once per editor open.
  const didScrollToSettings = useRef(false);
  useEffect(() => {
    if (initialPanel !== "settings" || didScrollToSettings.current) return;
    if (!activeWorkflow) return;
    const el = settingsPanelRef.current;
    if (el) {
      didScrollToSettings.current = true;
      el.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" });
    }
  }, [initialPanel, activeWorkflow]);

  // Reset the one-shot scroll latch whenever the deep-link target changes (e.g.
  // the panel is closed and re-opened with `?panel=settings`), so a fresh open
  // scrolls the settings panel into view again instead of staying latched.
  useEffect(() => {
    return () => {
      didScrollToSettings.current = false;
    };
  }, [initialPanel]);

  // Server-reported node error (e.g. seam-in-branch) attributed to a node id.
  const [serverNodeError, setServerNodeError] = useState<{ nodeId: string; message: string } | null>(null);

  // Keep the swimlane band group nodes in sync with the authored columns
  // (add/rename/reorder via the column panel). Step nodes are preserved; only
  // the band nodes are replaced.
  // FNXC:WorkflowEditor 2026-06-16-23:24:
  // FN-6525 requires the column-sync pass to clear stale node.column ids after delete-all-then-re-add, because the re-added Todo column receives a generated id and parseWorkflowIr rejects the old structural start-node reference.
  useEffect(() => {
    setNodes((ns) => {
      const stepNodes = ns.filter((n) => !isColumnBandNode(n.id) && n.type !== "group");
      return [...columnsToBandNodes(columns), ...reconcileNodeColumns(stepNodes, columns)];
    });
  }, [columns, setNodes]);

  // Append a new (success) edge directly rather than via React Flow's addEdge,
  // which dedupes on source/target/handles and would block parallel
  // success+failure edges between the same pair (KTD-3). buildConnectionEdge
  // reimplements addEdge's sanity guards plus the author-time cycle guard (KTD-9).
  const createConnectionEdge = useCallback(
    (connection: Connection, options: { selectCreatedEdge?: boolean } = {}) => {
      const result = buildConnectionEdge(connection, edges, nodes);
      if ("error" in result) {
        if (result.error === "cycle") {
          addToast(
            t(
              "workflowNodes.cycleBlocked",
              "That connection would create a cycle — only rework edges inside a for-each template may loop back",
            ),
            "warning",
          );
        } else if (result.error === "duplicate") {
          addToast(
            t("workflowNodes.duplicateBlocked", "That connection already exists"),
            "warning",
          );
        } else if (result.error === "reserved-handle") {
          addToast(
            t("workflowNodes.reservedHandleBlocked", "Optional-block boundary guides cannot be connected manually"),
            "warning",
          );
        }
        return;
      }
      setEdges((eds) => {
        const refreshed = refreshTemplateContainerVisualBoundaries(nodes, [...eds, result.edge]);
        setNodes(refreshed.nodes);
        return refreshed.edges;
      });
      if (options.selectCreatedEdge) {
        setSelectedEdgeId(result.edge.id);
        setSelectedNodeId(null);
        setInspectorCollapsed(false);
      }
    },
    [edges, nodes, setEdges, setNodes, addToast, t],
  );

  const onWorkflowEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      setEdges((eds) => {
        const changedEdges = applyEdgeChanges(changes, eds) as FlowEdge[];
        const refreshed = refreshTemplateContainerVisualBoundaries(nodes, changedEdges);
        setNodes(refreshed.nodes);
        return refreshed.edges;
      });
    },
    [nodes, setEdges, setNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      createConnectionEdge(connection);
    },
    [createConnectionEdge],
  );

  const onCreateSimpleConnection = useCallback(
    (source: string, target: string) => {
      createConnectionEdge({ source, target, sourceHandle: null, targetHandle: null }, { selectCreatedEdge: true });
    },
    [createConnectionEdge],
  );

  /**
   * FNXC:WorkflowSimpleEditor 2026-06-17-03:08:
   * Custom-workflow simple editors need read-only-safe reordering without a canvas drag gesture. Swap sibling node positions through the shared mobile graph helper so built-ins stay gated, selection remains untouched, and the existing IR save path persists the new position-derived order.
   */
  const onMoveSimpleNode = useCallback(
    (nodeId: string, direction: WorkflowNodeReorderDirection) => {
      setNodes((ns) => reorderWorkflowNode(ns, nodeId, direction));
    },
    [setNodes],
  );

  // Dragging a step node into a column band sets node.column (position-based
  // hit testing against the ordered bands — see workflow-flow-mapping).
  const onNodeDragStop = useCallback(
    (_evt: unknown, node: FlowNode<WorkflowFlowNodeData>) => {
      if (isColumnBandNode(node.id) || columns.length === 0) return;
      // strictColumnForY (not the clamping columnForY): a node dragged above or
      // below all bands keeps no column rather than snapping to the nearest one.
      const column = strictColumnForY(node.position.y, columns);
      if (!column) return;
      setNodes((ns) =>
        ns.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, column } } : n)),
      );
    },
    [columns, setNodes],
  );

  const addNode = useCallback(
    (kind: WorkflowEditorNodeKind, nodeLabel?: string, presetConfig?: Record<string, unknown>) => {
      const id = newNodeId();
      const label = nodeLabel ?? (kind === "merge" ? "Merge boundary" : kind.charAt(0).toUpperCase() + kind.slice(1));
      const baseConfig = kind === "gate" ? { gateMode: "gate" } : {};
      const config = presetConfig ? { ...baseConfig, ...presetConfig } : baseConfig;

      if (kind === "foreach" || kind === "loop" || kind === "optional-group") {
        // Template groups render as React Flow group nodes. Foreach seeds the
        // required step-execute seam; loop + optional-group seed a regular prompt
        // so authors can wire the body immediately. The group node must precede
        // its child for React Flow's parent extent to apply.
        // FNXC:WorkflowOptionalGroup 2026-06-21-11:30: An optional-group is authored exactly like a foreach/loop region — drop nodes inside; the subgraph runs once when the task enables the group.
        // FNXC:WorkflowOptionalGroup 2026-06-29-23:56: Palette and mobile add paths must compute optional-group boundary metadata immediately. A newly seeded optional child is both the visual entry and exit until authors add real internal template edges, so refresh the generated boundary guides before committing nodes to state rather than waiting for save/reload.
        const childId = foreachChildFlowId(id, newNodeId());
        const childLabel =
          kind === "foreach"
            ? t("workflowNodes.stepExecuteLabel", "Step execute")
            : kind === "optional-group"
              ? t("workflowNodes.optionalGroupStepLabel", "Optional step")
              : t("workflowNodes.loopStepLabel", "Loop step");
        const childConfig = kind === "foreach" ? { seam: "step-execute" } : { prompt: "" };
        setNodes((ns) => {
          const nextNodes = [
            ...ns,
            {
              id,
              type: kind,
              position: { x: 200 + ns.length * 40, y: 240 + (ns.length % 3) * 70 },
              data: { kind, label, config, templateEmpty: false },
              style: { width: FOREACH_GROUP_WIDTH, height: FOREACH_GROUP_HEIGHT },
              deletable: true,
            },
            {
              id: childId,
              type: "prompt",
              position: { x: FOREACH_CHILD_X, y: FOREACH_CHILD_Y },
              parentId: id,
              extent: "parent",
              data: {
                kind: "prompt",
                label: childLabel,
                config: childConfig,
              },
              deletable: true,
            },
          ] satisfies FlowNode<WorkflowFlowNodeData>[];
          const refreshed = refreshTemplateContainerVisualBoundaries(nextNodes, edges);
          setEdges(refreshed.edges);
          return refreshed.nodes;
        });
        setSelectedNodeId(id);
        return;
      }

      setNodes((ns) => [
        ...ns,
        {
          id,
          type: kind,
          position: { x: 200 + ns.length * 40, y: 240 + (ns.length % 3) * 70 },
          data: { kind, label, config },
          deletable: true,
        },
      ]);
      setSelectedNodeId(id);
    },
    [edges, setEdges, setNodes, t],
  );

  // U9/R8: insert a step template (built-in or plugin) as ONE pre-configured
  // node, mapping its fields the same way the U1 converter does. Reuses the
  // addNode path so layout/selection/dirty all behave identically.
  const handleInsertStepTemplate = useCallback(
    (tpl: WorkflowStepTemplate) => {
      if (isBuiltin) return;
      const { kind, label, config } = stepTemplateToNode(tpl);
      addNode(kind, label, config);
    },
    [isBuiltin, addNode],
  );

  /*
  FNXC:WorkflowOptionalGroup 2026-06-21-14:32:
  "Insert as optional group" (U5/R5): drop an add-on already wrapped in an `optional-group` container in
  one action, seeding the group's `defaultOn` from the template's `defaultOn`. Reuses `stepTemplateToNode`
  (KTD-5 — the catalog stays flat) to project the add-on to a prompt/script node, then `optionalGroupFragmentIr`
  to wrap it and the EXISTING `insertFragment` path to remap ids + expand the group's template child — so two
  inserts of the same add-on never collide. The group name carries the template name so the per-task toggle
  surfaces label it.
  */
  const handleInsertStepTemplateAsOptionalGroup = useCallback(
    // FNXC:WorkflowSimpleView 2026-07-12-10:30: PR #2006 review — when the
    // add-step dialog targeted an edge "+", this path must splice the new
    // optional-group into that edge instead of dropping it free-floating.
    (tpl: WorkflowStepTemplate, targetEdgeId?: string | null) => {
      if (isBuiltin) return;
      const { kind, config } = stepTemplateToNode(tpl);
      const fragmentIr = optionalGroupFragmentIr(
        { kind: kind as WorkflowIrNodeKind, config },
        { name: tpl.name, defaultOn: tpl.defaultOn ?? false },
      );
      const result = insertFragment(nodes, edges, fragmentIr, {
        x: 240,
        y: 200 + (nodes.length % 4) * 40,
      });
      const spliced = targetEdgeId
        ? spliceInsertedSubgraphOnEdge(result.nodes, result.edges, targetEdgeId, result.insertedNodeIds)
        : null;
      setNodes(spliced?.nodes ?? result.nodes);
      setEdges(spliced?.edges ?? result.edges);
      setSelectedNodeId(result.insertedNodeIds[0] ?? null);
    },
    [isBuiltin, nodes, edges, setNodes, setEdges],
  );

  // U9/R8: insert a fragment definition's body into the active graph. Pre-validates
  // seam duplication via fragmentSeamConflicts; on conflict, surfaces a persistent
  // inline error inside the Templates section and does NOT insert. Otherwise
  // insertFragment remaps ids + rewires internal edges, landing nodes at a fixed
  // offset from the canvas origin.
  const handleInsertFragment = useCallback(
    // FNXC:WorkflowSimpleView 2026-07-12-10:30: PR #2006 review — an
    // edge-targeted pick ("+" on an edge) splices the fragment's entry/exit
    // boundary into that edge; the toolbar/free path keeps the classic
    // fixed-position landing.
    (fragment: WorkflowDefinition, targetEdgeId?: string | null) => {
      if (isBuiltin) return false;
      const loadedIrFallback = canvasNodesMaterializedRef.current ? undefined : activeWorkflow?.ir;
      const conflicts = fragmentSeamConflicts(fragment.ir, nodes, loadedIrFallback);
      if (conflicts.length > 0) {
        setTemplateConflict(conflicts.join(", "));
        return false;
      }
      setTemplateConflict(null);
      const result = insertFragment(
        nodes,
        edges,
        fragment.ir,
        { x: 240, y: 200 + (nodes.length % 4) * 40 },
        fragment.layout,
      );
      const spliced = targetEdgeId
        ? spliceInsertedSubgraphOnEdge(result.nodes, result.edges, targetEdgeId, result.insertedNodeIds)
        : null;
      setNodes(spliced?.nodes ?? result.nodes);
      setEdges(spliced?.edges ?? result.edges);
      setSelectedNodeId(result.insertedNodeIds[0] ?? null);
      return true;
    },
    [isBuiltin, nodes, edges, activeWorkflow, setNodes, setEdges],
  );

  /*
  FNXC:WorkflowSimpleView 2026-07-10-12:00:
  Add-step dialog target for the simplified view. `edgeId` set = insert ON that
  edge (source→new→target rewiring via insertNodeOnEdge); null = free append
  (the "+ Add step" pill), which prefers the unambiguous edge into `end` and
  falls back to the classic free-floating addNode. `insideContainer` hides
  container kinds from the dialog because containers cannot nest.
  */
  const [addStepTarget, setAddStepTarget] = useState<{
    edgeId: string | null;
    insideContainer: boolean;
  } | null>(null);

  const openInsertOnEdge = useCallback(
    (edgeId: string) => {
      if (isBuiltin) return;
      const edge = edges.find((e) => e.id === edgeId);
      const source = edge ? nodes.find((n) => n.id === edge.source) : undefined;
      const target = edge ? nodes.find((n) => n.id === edge.target) : undefined;
      const insideContainer = !!source?.parentId && source.parentId === target?.parentId;
      setAddStepTarget({ edgeId, insideContainer });
    },
    [isBuiltin, edges, nodes],
  );

  const openAddStep = useCallback(() => {
    if (isBuiltin) return;
    setAddStepTarget({ edgeId: findAppendEdgeId(nodes, edges), insideContainer: false });
  }, [isBuiltin, nodes, edges]);

  const containerChildLabelFor = useCallback(
    (kind: WorkflowEditorNodeKind) =>
      kind === "foreach"
        ? t("workflowNodes.stepExecuteLabel", "Step execute")
        : kind === "optional-group"
          ? t("workflowNodes.optionalGroupStepLabel", "Optional step")
          : t("workflowNodes.loopStepLabel", "Loop step"),
    [t],
  );

  /** Insert on the targeted edge when one is set (falling back to addNode when
   *  the edge disappeared, e.g. deleted while the dialog was open). */
  const insertFromAddStep = useCallback(
    (kind: WorkflowEditorNodeKind, label: string, presetConfig?: Record<string, unknown>) => {
      if (addStepTarget?.edgeId) {
        const result = insertNodeOnEdge(nodes, edges, addStepTarget.edgeId, {
          kind,
          label,
          presetConfig,
          containerChildLabel: containerChildLabelFor(kind),
        });
        if (result) {
          setNodes(result.nodes);
          setEdges(result.edges);
          setSelectedNodeId(result.newNodeId);
          setSelectedEdgeId(null);
          setAddStepTarget(null);
          return;
        }
      }
      addNode(kind, label, presetConfig);
      setAddStepTarget(null);
    },
    [addStepTarget, nodes, edges, setNodes, setEdges, addNode, containerChildLabelFor],
  );

  const handleAddStepPalettePick = useCallback(
    (entry: AddStepPaletteEntry) => insertFromAddStep(entry.kind, entry.label, entry.presetConfig),
    [insertFromAddStep],
  );

  const handleAddStepTemplatePick = useCallback(
    (tpl: WorkflowStepTemplate) => {
      const { kind, label, config } = stepTemplateToNode(tpl);
      insertFromAddStep(kind, label, config);
    },
    [insertFromAddStep],
  );

  // Auto-layout: one-click left-to-right tidy (U5, R8). Recomputes positions
  // only; bands and foreach template children are left in place. Marks the
  // editor dirty automatically via the layout serialization in isDirty.
  const handleAutoLayout = useCallback(() => {
    setNodes((ns) => applyAutoLayout(ns, autoLayout(ns, edges, columns)));
  }, [setNodes, edges, columns]);

  // U10/R11: toolbar "Design with AI" submit. Designs against the ACTIVE workflow
  // (passing its id; the server reads the persisted IR — the client never posts
  // IR). On success the returned graph REPLACES the canvas, but only after a
  // confirm — and we ALWAYS confirm (even when clean) because this is a
  // destructive whole-graph replace. On confirm we map the returned {ir, layout}
  // through irToFlow on a definition-shaped object (mirroring the load effect's
  // mapping); the result is intentionally left UNSAVED so the user explicitly
  // saves (the dirty snapshot is the active workflow's, so the replaced graph
  // reads dirty). On failure the canvas is untouched and the panel shows the
  // server message inline. The fetch is cancelable via the panel's Cancel button.
  const handleAiEditSubmit = useCallback(async () => {
    if (!activeWorkflow || isBuiltin) return;
    const trimmed = aiEditPrompt.trim();
    if (!trimmed) {
      setAiEditError(t("workflows.aiPromptRequired", "Describe the workflow you want"));
      return;
    }
    const controller = new AbortController();
    aiEditAbortRef.current = controller;
    // Capture the target workflow up-front: if the user switches the active
    // workflow during the (long) design round-trip, we must NOT apply the result
    // to whatever workflow happens to be active when it resolves.
    const targetWorkflow = activeWorkflow;
    setAiEditBusy(true);
    setAiEditError(null);
    try {
      const result = await designWorkflow(
        { prompt: trimmed, workflowId: targetWorkflow.id },
        projectId,
        controller.signal,
      );
      // The active workflow changed mid-flight → discard the stale result.
      if (activeIdRef.current !== targetWorkflow.id) {
        addToast(
          t("workflows.aiStaleDiscarded", "Discarded AI design — you switched workflows"),
          "warning",
        );
        return;
      }
      // Always confirm before the destructive replace.
      const ok = await confirm({
        title: t("workflows.aiReplaceTitle", "Replace graph?"),
        message: t(
          "workflows.aiReplaceConfirm",
          "Replace the current graph with the AI design? Unsaved changes will be lost.",
        ),
        confirmLabel: t("workflows.aiReplaceConfirmLabel", "Replace"),
        danger: true,
      });
      if (!ok) return; // Cancel keeps the current canvas untouched.
      // Map the returned IR through irToFlow on a definition-shaped object,
      // mirroring the active-workflow load effect's mapping.
      const flow = irToFlow({
        ...targetWorkflow,
        ir: result.ir,
        layout: result.layout,
      });
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setColumns(columnsOf({ ...targetWorkflow, ir: result.ir }));
      setFields(fieldsOf({ ...targetWorkflow, ir: result.ir }));
      // Hydrate settings on the fragment/generate path too — it previously dropped
      // them, which silently lost the declarations on the next save (the round-trip
      // data loss U2 fixes for the primary load path). Optional steps need no
      // separate hydration: they are graph-native `optional-group` nodes carried by
      // the node/edge mapping above (FNXC:WorkflowOptionalGroup 2026-06-21-18:00).
      setSettings(settingsOf({ ...targetWorkflow, ir: result.ir }));
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setValidationError(null);
      // Leave the loaded snapshot pointing at the (still-persisted) base so the
      // replaced graph reads dirty — the user must explicitly Save.
      if (result.strippedApprovalFlags) {
        addToast(
          t("workflows.importStripped", "Auto-approval flags were removed from imported nodes"),
          "warning",
        );
      }
      setAiPanelOpen(false);
      setAiEditPrompt("");
    } catch (err) {
      if (controller.signal.aborted) return; // user cancel: re-enable silently
      setAiEditError(getErrorMessage(err) || t("workflows.aiFailed", "Failed to design workflow"));
    } finally {
      if (aiEditAbortRef.current === controller) aiEditAbortRef.current = null;
      setAiEditBusy(false);
    }
  }, [
    activeWorkflow,
    isBuiltin,
    aiEditPrompt,
    projectId,
    confirm,
    t,
    setNodes,
    setEdges,
    addToast,
  ]);

  const handleAiEditCancel = useCallback(() => {
    aiEditAbortRef.current?.abort();
    setAiEditBusy(false);
  }, []);

  const updateSelectedData = useCallback(
    (
      patch:
        | Partial<WorkflowFlowNodeData>
        | {
            config:
              | Record<string, unknown>
              | ((prev: Record<string, unknown>) => Record<string, unknown>);
          },
    ) => {
      if (!selectedNodeId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedNodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...("config" in patch
                    ? {
                        config:
                          typeof patch.config === "function"
                            ? patch.config((n.data.config ?? {}) as Record<string, unknown>)
                            : (() => {
                                const nextConfig = { ...(n.data.config ?? {}), ...patch.config };
                                /*
                                 * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
                                 * Inspector controls use `undefined` as the clear signal for optional config keys such as `thinkingLevel`; remove those keys so saved IR has absence, not an undefined shell.
                                 */
                                for (const key of Object.keys(nextConfig)) {
                                  if (nextConfig[key] === undefined) delete nextConfig[key];
                                }
                                return nextConfig;
                              })(),
                      }
                    : patch),
                },
              }
            : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const applyPromptOverridePayloadToNode = useCallback(
    (nodeId: string, payload: WorkflowPromptOverridesPayload) => {
      setPromptOverrides(payload);
      const effective = payload.effective[nodeId] ?? payload.defaults[nodeId] ?? "";
      setNodes((ns) =>
        ns.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: { ...(node.data.config ?? {}), prompt: effective },
                },
              }
            : node,
        ),
      );
    },
    [setNodes],
  );

  const persistBuiltinPromptOverride = useCallback(
    async (nodeId: string, prompt: string) => {
      if (!activeWorkflow || !isBuiltin) return;
      setPromptOverrideSavingNodeId(nodeId);
      try {
        const payload = await updateWorkflowPromptOverrides(activeWorkflow.id, { [nodeId]: prompt }, projectId);
        applyPromptOverridePayloadToNode(nodeId, payload);
        addToast(t("workflowEditor.promptOverrideSaved", "Prompt override saved"), "success");
      } catch (err) {
        addToast(getErrorMessage(err) || t("workflowEditor.promptOverrideSaveFailed", "Failed to save prompt override"), "error");
        try {
          const payload = await fetchWorkflowPromptOverrides(activeWorkflow.id, projectId);
          applyPromptOverridePayloadToNode(nodeId, payload);
        } catch {
          // Best-effort rollback; a later workflow reload will reconcile.
        }
      } finally {
        setPromptOverrideSavingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [activeWorkflow, isBuiltin, projectId, addToast, t, applyPromptOverridePayloadToNode],
  );

  const resetBuiltinPromptOverride = useCallback(
    async (nodeId: string) => {
      if (!activeWorkflow || !isBuiltin) return;
      setPromptOverrideSavingNodeId(nodeId);
      try {
        const payload = await updateWorkflowPromptOverrides(activeWorkflow.id, { [nodeId]: null }, projectId);
        applyPromptOverridePayloadToNode(nodeId, payload);
        addToast(t("workflowEditor.promptOverrideReset", "Prompt reset to default"), "success");
      } catch (err) {
        addToast(getErrorMessage(err) || t("workflowEditor.promptOverrideResetFailed", "Failed to reset prompt"), "error");
      } finally {
        setPromptOverrideSavingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [activeWorkflow, isBuiltin, projectId, addToast, t, applyPromptOverridePayloadToNode],
  );

  // Edge inspector (KTD-4/5): mutate the selected edge's condition + rework
  // kind, keeping its display label in sync. Rework edges render dashed/animated.
  const updateSelectedEdge = useCallback(
    (patch: { condition?: string; rework?: boolean }) => {
      if (!selectedEdgeId) return;
      setEdges((eds) => {
        const updated = eds.map((e) => {
          if (e.id !== selectedEdgeId) return e;
          const condition = patch.condition ?? (e.data?.condition as string | undefined) ?? "success";
          const rework = patch.rework ?? (e.data?.kind as string | undefined) === "rework";
          return {
            ...e,
            label: rework ? `${shortConditionLabel(condition)} (rework)` : shortConditionLabel(condition),
            data: { ...(e.data ?? {}), condition, kind: rework ? "rework" : undefined },
            type: rework ? "step" : undefined,
            animated: rework,
            className: edgeClassName(condition, rework),
          };
        });
        const refreshed = refreshTemplateContainerVisualBoundaries(nodes, updated);
        setNodes(refreshed.nodes);
        return refreshed.edges;
      });
    },
    [nodes, selectedEdgeId, setEdges, setNodes],
  );

  // ── Deletion (U3, R6) ──────────────────────────────────────────────────────
  // Apply cascadeDelete to the current graph for the given node/edge ids,
  // clearing any selection that pointed at a removed element. Shared by the
  // inspector delete buttons and the keyboard-delete path.
  const applyDelete = useCallback(
    (ids: Iterable<string>) => {
      const idSet = new Set(ids);
      let next: { nodes: FlowNode<WorkflowFlowNodeData>[]; edges: FlowEdge[] } | null = null;
      setNodes((ns) => {
        const deleted = cascadeDelete(ns, edges, idSet);
        next = refreshTemplateContainerVisualBoundaries(deleted.nodes, deleted.edges);
        return next.nodes;
      });
      if (next) setEdges((next as { edges: FlowEdge[] }).edges);
      if (selectedNodeId !== null && idSet.has(selectedNodeId)) setSelectedNodeId(null);
      if (selectedEdgeId !== null && idSet.has(selectedEdgeId)) setSelectedEdgeId(null);
    },
    [edges, setNodes, setEdges, selectedNodeId, selectedEdgeId],
  );

  // Keyboard delete (Backspace/Delete) flows through React Flow's onBeforeDelete:
  // it hands us the nodes/edges it intends to remove, and we return the
  // cascadeDelete-expanded set (foreach children + incident edges, protected
  // nodes filtered out) so React Flow deletes exactly the right elements. After
  // deletion, focus returns to the canvas container (R6). Built-ins never reach
  // here (deleteKeyCode is null and selection is read-only), but the protection
  // in cascadeDelete is the backstop.
  const onBeforeDelete = useCallback(
    async ({ nodes: delNodes, edges: delEdges }: { nodes: FlowNode<WorkflowFlowNodeData>[]; edges: FlowEdge[] }) => {
      if (isBuiltin) return false;
      const ids = new Set<string>([...delNodes.map((n) => n.id), ...delEdges.map((e) => e.id)]);
      const result = cascadeDelete(nodes, edges, ids);
      const removedNodeIds = new Set(nodes.map((n) => n.id));
      for (const n of result.nodes) removedNodeIds.delete(n.id);
      const removedEdgeIds = new Set(edges.map((e) => e.id));
      for (const e of result.edges) removedEdgeIds.delete(e.id);
      if (removedNodeIds.size === 0 && removedEdgeIds.size === 0) return false;
      return {
        nodes: nodes.filter((n) => removedNodeIds.has(n.id)),
        edges: edges.filter((e) => removedEdgeIds.has(e.id)),
      };
    },
    [isBuiltin, nodes, edges],
  );

  // After React Flow removes the elements, drop any dangling selection and move
  // focus to the canvas so keyboard nav continues from a live element (R6).
  const onNodesDelete = useCallback(() => {
    setSelectedNodeId(null);
    canvasRef.current?.focus();
  }, []);
  const onEdgesDelete = useCallback(() => {
    setSelectedEdgeId(null);
    canvasRef.current?.focus();
  }, []);

  // Close the create dialog and return focus to its trigger (NewTaskModal
  // focus-return pattern). Used by both the success and cancel paths.
  const closeCreateDialog = useCallback(() => {
    setCreateOpen(false);
    newWorkflowBtnRef.current?.focus();
  }, []);

  // Perform the createWorkflow call. Throws on failure so the dialog surfaces
  // the server error (e.g. duplicate name) inline without losing the input.
  const handleCreateWorkflow = useCallback(
    async (workflowName: string, workflowDescription: string, workflowIcon: string, template: WorkflowCreateTemplate) => {
      // Blank → empty start→end graph; template → a fresh-ID copy of the source
      // graph + layout (U4/R7, never a reference). Always created kind "workflow".
      const seed =
        template.source !== undefined
          ? copyIrWithFreshIds(template.source.ir, template.source.layout)
          : { ir: emptyWorkflowIr(workflowName), layout: emptyWorkflowLayout() };
      const created = await createWorkflow(
        {
          name: workflowName,
          description: workflowDescription || undefined,
          icon: workflowIcon || undefined,
          kind: "workflow",
          ir: seed.ir,
          layout: seed.layout,
        },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      setWorkflowListStageOpen(false);
      addToast(t("workflows.created", 'Created workflow "{{name}}"', { name: created.name }), "success");
      closeCreateDialog();
    },
    [projectId, addToast, t, closeCreateDialog],
  );

  // U10/R11: design a brand-new workflow from a prompt in the create dialog.
  // Calls the server design route (no IR posted), then creates the workflow
  // seeded from the returned {ir, layout} via the existing create path. The name
  // comes from the dialog's name field if filled, else "AI: <first 30 chars>".
  // A stripped-approval-flags result shows the shared importStripped toast
  // (reused per spec). Throws on failure so the dialog renders the server message
  // inline and stays open (nothing created).
  const handleDesignNewWorkflow = useCallback(
    async (prompt: string, dialogName: string, signal: AbortSignal) => {
      const result = await designWorkflow({ prompt }, projectId, signal);
      const fallbackName = `AI: ${prompt.slice(0, 30)}`;
      const workflowName = dialogName || fallbackName;
      const created = await createWorkflow(
        {
          name: workflowName,
          kind: "workflow",
          ir: result.ir,
          layout: result.layout,
        },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      setWorkflowListStageOpen(false);
      addToast(t("workflows.created", 'Created workflow "{{name}}"', { name: created.name }), "success");
      if (result.strippedApprovalFlags) {
        addToast(
          t("workflows.importStripped", "Auto-approval flags were removed from imported nodes"),
          "warning",
        );
      }
      closeCreateDialog();
    },
    [projectId, addToast, t, closeCreateDialog],
  );

  const handleDeleteWorkflow = useCallback(async () => {
    if (!activeWorkflow) return;
    if (isBuiltinWorkflowId(activeWorkflow.id)) return; // built-ins are read-only
    const ok = await confirm({
      title: t("workflows.deleteTitle", "Delete workflow?"),
      message: t("workflows.deleteMessage", 'Delete workflow "{{name}}"? This cannot be undone.', {
        name: activeWorkflow.name,
      }),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteWorkflow(activeWorkflow.id, projectId);
      setWorkflows((ws) => ws.filter((w) => w.id !== activeWorkflow.id));
      setActiveId(null);
      if (isMobileMode) setWorkflowListStageOpen(true);
      addToast(t("workflows.deleted", "Workflow deleted"), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("workflows.deleteFailed", "Failed to delete workflow"), "error");
    }
  }, [activeWorkflow, projectId, addToast, confirm, t, isMobileMode]);

  const handleDuplicate = useCallback(async () => {
    if (!activeWorkflow) return;
    try {
      const created = await createWorkflow(
        {
          name: `${activeWorkflow.name} (copy)`,
          description: activeWorkflow.description,
          icon: isBuiltinWorkflowId(activeWorkflow.id) || !activeWorkflow.icon ? "✨" : activeWorkflow.icon,
          ir: activeWorkflow.ir,
          layout: activeWorkflow.layout,
        },
        projectId,
      );
      setWorkflows((ws) => [...ws, created]);
      setActiveId(created.id);
      setWorkflowListStageOpen(false);
      addToast(t("workflows.duplicatedEditable", "Duplicated to \"{{name}}\" — editable", { name: created.name }), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("workflows.duplicateFailed", "Failed to duplicate workflow"), "error");
    }
  }, [activeWorkflow, projectId, addToast, t]);

  const handleSave = useCallback(async () => {
    if (!activeWorkflow) return;
    if (isBuiltinWorkflowId(activeWorkflow.id)) return; // built-ins are read-only

    // Block save on client-detected violations before any round-trip:
    //  - unplaced step nodes (rendered as inline node badges + summary count);
    //  - trait composition errors (rendered on the offending column band).
    if (unplaced.length > 0) {
      const message = t(
        "workflowColumns.unplacedCount",
        "{{count}} nodes not placed in a column",
        { count: unplaced.length },
      );
      setValidationError(message);
      addToast(message, "error");
      return;
    }
    if (blockingViolationCount > 0) {
      const message = t(
        "workflowColumns.compositionBlocked",
        "Resolve trait conflicts on highlighted columns before saving",
      );
      setValidationError(message);
      addToast(message, "error");
      return;
    }

    setSaving(true);
    setValidationError(null);
    setServerNodeError(null);
    try {
      const trimmedName = name.trim() || activeWorkflow.name;
      const { ir, layout } = flowToIr(
        trimmedName,
        nodes,
        edges,
        columns.length ? columns : undefined,
        fields.length ? fields : undefined,
        settings.length ? settings : undefined,
      );
      // Include name/description in the PATCH only when they changed from the
      // loaded workflow (KTD-10 inline rename/description persist here).
      const nameChanged = trimmedName !== activeWorkflow.name;
      const descChanged = description !== (activeWorkflow.description ?? "");
      const normalizedIcon = icon?.trim() || undefined;
      const iconChanged = normalizedIcon !== activeWorkflow.icon;
      const finishSave = async (updated: Awaited<ReturnType<typeof updateWorkflow>>) => {
        setWorkflows((ws) => ws.map((w) => (w.id === updated.id ? updated : w)));
        // Re-baseline the dirty snapshot to the just-saved state so the editor is
        // clean immediately after a successful save.
        loadedSnapshotRef.current = serializeGraph(
          updated.name,
          updated.description ?? "",
          updated.icon,
          nodes,
          edges,
          columns,
          fields,
          settings,
        );
        setName(updated.name);
        setDescription(updated.description ?? "");
        setIcon(updated.icon);
        // FNXC:WorkflowEditor 2026-07-01-00:00: The linear WorkflowStep compiler
        // was removed and the graph interpreter runs branching graphs directly, so
        // there is no post-save compile check. The server already validated the IR
        // (parseWorkflowIr) on the update PATCH; reaching here means it is valid.
        addToast(t("workflows.saved", "Workflow saved"), "success");
      };
      const savePayload = {
        ir,
        layout,
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(descChanged ? { description } : {}),
        ...(iconChanged ? { icon: normalizedIcon ?? null } : {}),
      };
      try {
        await finishSave(await updateWorkflow(activeWorkflow.id, savePayload, projectId));
      } catch (err) {
        // Policy-escalation handshake (R13, PR #1432 review): the route rejects a
        // binding to a broader-than-default agent until the author explicitly
        // confirms. Surface the server's explanation, then retry with the flag —
        // otherwise such bindings would be unsavable from the dashboard.
        // Shape-checked rather than `instanceof ApiRequestError` so test doubles
        // (and any error wrapper) that carry the details payload still route here.
        const escalation =
          (err as { details?: { policyEscalation?: boolean } } | null)?.details?.policyEscalation === true;
        if (!escalation) throw err;
        const proceed = window.confirm(
          `${getErrorMessage(err)}\n\n${t(
            "workflowColumns.confirmPolicyEscalation",
            "Bind it anyway? The column agent will run with broader permissions than this project's default.",
          )}`,
        );
        if (!proceed) {
          addToast(t("workflowColumns.escalationDeclined", "Save cancelled — column agent binding not confirmed"), "error");
          return;
        }
        await finishSave(
          await updateWorkflow(activeWorkflow.id, { ...savePayload, confirmPolicyEscalation: true }, projectId),
        );
      }
    } catch (err) {
      const message = getErrorMessage(err) || t("workflows.saveFailed", "Failed to save workflow");
      // parseWorkflowIr (server) names the offending node for structural errors
      // like seam-in-branch ("seam 'merge' node 'n-…' is forbidden inside …").
      // Attribute it to that node so the shared error badge renders on it.
      const nodeMatch = /node '([^']+)'/.exec(message);
      if (nodeMatch && nodes.some((n) => n.id === nodeMatch[1])) {
        setServerNodeError({ nodeId: nodeMatch[1], message });
      }
      setValidationError(message);
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  }, [activeWorkflow, name, description, nodes, edges, columns, fields, settings, unplaced, blockingViolationCount, projectId, addToast, t]);

  // Stamp the shared error-state badge onto offending nodes: unplaced step
  // nodes and any node the server flagged (seam-in-branch). One component
  // (WorkflowNodeErrorBadge) renders both, keyed off data.errorBadge.
  const nodesForRender = useMemo(() => {
    const unplacedSet = new Set(unplaced);
    // Count current template children per template group so the empty-state hint
    // reflects live deletions even though the palette seeds one.
    const childCount = new Map<string, number>();
    for (const n of nodes) {
      if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    }
    return nodes.map((n) => {
      let errorBadge: string | undefined;
      if (unplacedSet.has(n.id)) errorBadge = t("workflowColumns.nodeUnplaced", "Not placed in a column");
      if (serverNodeError?.nodeId === n.id) errorBadge = serverNodeError.message;
      const isTemplateGroup =
        n.data.kind === "foreach" || n.data.kind === "loop" || n.data.kind === "optional-group";
      const emptyHint =
        n.data.kind === "loop"
          ? t("workflowNodes.loopEmptyHint", "Drag loop steps here")
          : n.data.kind === "optional-group"
            ? t("workflowNodes.optionalGroupEmptyHint", "Drag optional steps here")
            : t("workflowNodes.foreachEmptyHint", "Drag a step-execute node here");
      const templateEmpty = isTemplateGroup ? (childCount.get(n.id) ?? 0) === 0 : undefined;
      if (
        errorBadge === n.data.errorBadge &&
        (!isTemplateGroup || (templateEmpty === n.data.templateEmpty && n.data.emptyHint === emptyHint))
      )
        return n;
      return {
        ...n,
        data: {
          ...n.data,
          errorBadge,
          ...(isTemplateGroup ? { templateEmpty, emptyHint } : {}),
        },
      };
    });
  }, [nodes, unplaced, serverNodeError, t]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  /**
   * FNXC:WorkflowEditor 2026-06-17-00:20:
   * The structural start node needs an inspector because its entry column is editable and persisted in the workflow IR. Keep end structural-only until it has a meaningful editable property.
   */
  const selectedNodeHasInspector = selectedNode !== null && selectedNode.data.kind !== "end";
  // FNXC:WorkflowEditor 2026-06-21-10:00: Help content for the inspector, keyed by the node's effective kind (preserved IR kind when a graph-only policy node collapsed onto a generic merge/gate/hold shape).
  const selectedNodeHelp = selectedNode !== null ? nodeHelpForData(selectedNode.data) : null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const mobileNodeDetailStage = isMobileMode && selectedNodeHasInspector && !inspectorCollapsed;
  const mobileEdgeDetailStage = isMobileMode && selectedEdge !== null;
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const handleTogglePromptExpand = useCallback(() => {
    setIsPromptExpanded((prev) => !prev);
  }, []);
  const handlePromptFullscreenKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isPromptExpanded || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setIsPromptExpanded(false);
  }, [isPromptExpanded]);
  const selectedNodePromptValue =
    selectedNode && (selectedNode.data.kind === "prompt" || selectedNode.data.kind === "gate")
      ? String(
          selectedNode.data.config?.prompt
            ?? promptOverrides?.effective[selectedNode.id]
            ?? (isBuiltin ? builtinSeamPrompt(selectedNode.data.config as Record<string, unknown> | undefined) : ""),
        )
      : "";
  const selectedPromptDefault = selectedNode ? promptOverrides?.defaults[selectedNode.id] : undefined;
  const selectedPromptStored = selectedNode ? promptOverrides?.stored[selectedNode.id] : undefined;
  const selectedPromptHasOverride = selectedPromptStored !== undefined;
  const selectedPromptIsOverridden =
    selectedPromptHasOverride && selectedPromptDefault !== undefined && selectedPromptStored !== selectedPromptDefault;
  const selectedPromptOverrideSaving = !!selectedNode && promptOverrideSavingNodeId === selectedNode.id;
  const selectedNodePromptEditable =
    !!selectedNode &&
    (selectedNode.data.kind === "prompt" || selectedNode.data.kind === "gate") &&
    (!isBuiltin || selectedPromptDefault !== undefined);
  const handlePromptTextChange = useCallback(
    (value: string) => {
      if (!selectedNodePromptEditable) return;
      updateSelectedData({ config: { prompt: value } });
    },
    [selectedNodePromptEditable, updateSelectedData],
  );
  const handlePromptTextBlur = useCallback(() => {
    if (!isBuiltin || !selectedNode || (selectedNode.data.kind !== "prompt" && selectedNode.data.kind !== "gate")) return;
    const stored = promptOverrides?.stored[selectedNode.id];
    const defaultPrompt = promptOverrides?.defaults[selectedNode.id];
    const nextPrompt = selectedNodePromptValue.trim() ? selectedNodePromptValue : "";
    if ((stored === undefined && (defaultPrompt === undefined || nextPrompt === defaultPrompt)) || stored === nextPrompt) return;
    void persistBuiltinPromptOverride(selectedNode.id, selectedNodePromptValue);
  }, [isBuiltin, selectedNode, selectedNodePromptValue, promptOverrides, persistBuiltinPromptOverride]);
  const handlePromptResetClick = useCallback(() => {
    if (!selectedNode) return;
    void resetBuiltinPromptOverride(selectedNode.id);
  }, [selectedNode, resetBuiltinPromptOverride]);
  // The edge inspector renders different controls per source-node kind (KTD-2):
  // step-review → verdict controls; prompt/script/gate/code/foreach →
  // success/failure select; everything else → a read-only condition note.
  const selectedEdgeEditability = useMemo(() => {
    if (!selectedEdge) return "readonly" as const;
    const src = nodes.find((n) => n.id === selectedEdge.source);
    return edgeConditionEditability(src?.data.kind);
  }, [selectedEdge, nodes]);

  // Artifacts the active workflow declares (KTD-12). The parse-steps inspector
  // offers a select over these; when none are declared it falls back to a
  // free-text input defaulting to PROMPT.md.
  const declaredArtifacts = useMemo(() => {
    const ir = activeWorkflow?.ir;
    if (ir && ir.version === "v2" && Array.isArray(ir.artifacts)) {
      return ir.artifacts.map((a) => a.key);
    }
    return [];
  }, [activeWorkflow]);

  // Executor resources. Prefetched once when the editor opens (U1/KTD-6) so node
  // cards can resolve model/agent/skill ids to display names in their config
  // summaries; the inspector selects reuse the same state. Failures are
  // non-fatal — summaries fall back to raw ids — so the prefetch is toastless.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [projectDefaultThinkingLevel, setProjectDefaultThinkingLevel] = useState("off");
  const [agents, setAgents] = useState<Agent[]>([]);
  // The agent fetches are project-scoped, but this cache survives project
  // switches — both load paths short-circuit on agents.length > 0, which would
  // keep showing (and let the editor bind) the PREVIOUS project's registry.
  // Reset on project change so the next consumer refetches (PR #1432 review).
  useEffect(() => {
    setAgents([]);
  }, [projectId]);
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  // CLI-agent adapter catalog (U15). Falls back to the static list when the API
  // fetch fails so the picker is always usable.
  const [cliAdapters, setCliAdapters] = useState<CliAdapterDescriptorView[]>(CLI_AGENT_ADAPTER_FALLBACK);

  useEffect(() => {
    let cancelled = false;
    // Promise.resolve wraps so a synchronously-undefined return (e.g. a bare
    // test mock) degrades to "no catalog" instead of throwing — summaries then
    // fall back to raw ids, which is the documented failure behavior (KTD-6).
    Promise.resolve(fetchModels())
      .then((res) => {
        if (!cancelled && res?.models) setModels(res.models);
      })
      .catch(() => {});
    Promise.resolve(fetchAgents())
      .then((res) => {
        if (!cancelled && Array.isArray(res)) setAgents(res);
      })
      .catch(() => {});
    Promise.resolve(fetchDiscoveredSkills(projectId))
      .then((res) => {
        if (!cancelled && Array.isArray(res)) setSkills(res);
      })
      .catch(() => {});
    Promise.resolve(fetchSettings(projectId))
      .then((res) => {
        if (!cancelled) setProjectDefaultThinkingLevel(res?.defaultThinkingLevel ?? "off");
      })
      .catch(() => {
        if (!cancelled) setProjectDefaultThinkingLevel("off");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Catalogs handed to the rendered node cards via context (KTD-6). Minimal
  // structural shape — nodeConfigSummary reads only id/name/provider.
  const catalogs: NodeSummaryCatalogs = useMemo(
    () => ({
      models: models.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      skills: skills.map((s) => ({ id: s.id, name: s.name })),
    }),
    [models, agents, skills],
  );
  // Column id → display name for the simplified view's per-node column chips.
  const columnNameMap = useMemo(() => new Map(columns.map((c) => [c.id, c.name])), [columns]);
  const mobileConnectionTargetsBySource = useMemo(() => {
    const targetNodes = nodesForRender
      .filter((node) => !isColumnBandNode(node.id) && node.data.kind !== "start")
      .map((node): MobileWorkflowConnectionTarget => ({
        id: node.id,
        label: node.data.label || node.id,
        kind: node.data.kind,
      }));

    const targetsBySource = new Map<string, MobileWorkflowConnectionTarget[]>();
    for (const source of nodesForRender) {
      if (
        isColumnBandNode(source.id)
        || source.data.kind === "start"
        || source.data.kind === "end"
      ) {
        continue;
      }
      const targets = targetNodes.filter((target) => target.id !== source.id);
      if (targets.length > 0) targetsBySource.set(source.id, targets);
    }
    return targetsBySource;
  }, [nodesForRender]);

  const mobileGraphRows = useMemo(() => {
    const attachConnectionTargets = (rows: ReturnType<typeof buildMobileWorkflowGraph>): ReturnType<typeof buildMobileWorkflowGraph> =>
      rows.map((row) => ({
        ...row,
        connectionTargets: isBuiltin ? [] : mobileConnectionTargetsBySource.get(row.id) ?? [],
        children: attachConnectionTargets(row.children),
      }));

    return attachConnectionTargets(buildMobileWorkflowGraph(nodesForRender, edges, columns, catalogs, t));
  }, [nodesForRender, edges, columns, catalogs, t, isBuiltin, mobileConnectionTargetsBySource]);

  const currentExecutor = (selectedNode?.data.config?.executor as ExecutorKind | undefined) ?? "model";

  // The override binding governing the selected node, if any: its declared
  // column carries an `agent` in `override` mode. Drives the "overridden by
  // column agent" note so authors don't diagnose override as a bug (R11). Keyed
  // on the column id + binding, not array identity.
  const overrideColumnBinding = useMemo(() => {
    // Foreach template children don't carry their own column in irToFlow — they
    // inherit the enclosing foreach group's column at execution (R4). Mirror that
    // inheritance here so a step-execute prompt inside an override-bound foreach
    // still shows the note (PR #1432 review).
    const columnId =
      selectedNode?.data.column
      ?? (selectedNode?.parentId
        ? nodes.find((n) => n.id === selectedNode.parentId)?.data.column
        : undefined);
    if (!columnId) return undefined;
    const col = columns.find((c) => c.id === columnId);
    if (!col?.agent || col.agent.mode !== "override") return undefined;
    return col.agent;
  }, [selectedNode?.data.column, selectedNode?.parentId, nodes, columns]);

  // Resolve the override agent's display name from the loaded registry; when the
  // id is stale (not in the list) fall back to the not-found treatment.
  const overrideAgent = useMemo(
    () => (overrideColumnBinding ? agents.find((a) => a.id === overrideColumnBinding.agentId) : undefined),
    [overrideColumnBinding, agents],
  );

  useEffect(() => {
    if (currentExecutor !== "cli-agent") return;
    let cancelled = false;
    fetch("/api/cli-agents")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.adapters) return;
        setCliAdapters(data.adapters as CliAdapterDescriptorView[]);
      })
      .catch(() => {
        // Keep the static fallback; the picker stays functional.
      });
    return () => {
      cancelled = true;
    };
  }, [currentExecutor]);

  useEffect(() => {
    // step-review offers an optional review model picker (KTD-4).
    if (selectedNode?.data.kind === "step-review" && models.length === 0) {
      fetchModels().then((res) => setModels(res.models)).catch((err) => {
        addToast(getErrorMessage(err) || t("workflowEditor.modelsLoadFailed", "Failed to load models"), "error");
      });
      return;
    }
    if (!selectedNode || (selectedNode.data.kind !== "prompt" && selectedNode.data.kind !== "gate")) return;
    if (currentExecutor === "model" && models.length === 0) {
      fetchModels().then((res) => setModels(res.models)).catch((err) => {
        addToast(getErrorMessage(err) || t("workflowEditor.modelsLoadFailed", "Failed to load models"), "error");
      });
    } else if (currentExecutor === "agent" && agents.length === 0) {
      // Project-scoped, matching WorkflowColumnPanel's fetchAgents(undefined,
      // projectId) — an unscoped fetch returns the wrong registry in
      // multi-project deployments (PR #1432 review).
      fetchAgents(undefined, projectId).then(setAgents).catch((err) => {
        addToast(getErrorMessage(err) || t("workflowEditor.agentsLoadFailed", "Failed to load agents"), "error");
      });
    } else if (currentExecutor === "skill" && skills.length === 0) {
      fetchDiscoveredSkills(projectId).then(setSkills).catch((err) => {
        addToast(getErrorMessage(err) || t("workflowEditor.skillsLoadFailed", "Failed to load skills"), "error");
      });
    }
  }, [
    currentExecutor,
    selectedNode?.id,
    selectedNode?.data.kind,
    projectId,
    addToast,
    models.length,
    agents.length,
    skills.length,
    t,
  ]);

  // ── Dirty-state dismissal guard (U4, R7) ────────────────────────────────────
  // One synchronous decision point for every dismissal path. If the editor is
  // clean (or built-in), the action runs immediately; if dirty, the discard
  // confirm opens and the action runs only in the .then(true) callback. Used by
  // the X button, overlay click (via useOverlayDismiss), the Escape keydown
  // handler, and the sidebar workflow switch.
  const guardedDismiss = useCallback(
    (proceed: () => void) => {
      if (!isDirty) {
        proceed();
        return;
      }
      void confirm({
        title: t("workflows.discardTitle", "Discard unsaved changes?"),
        message: t(
          "workflows.discardMessage",
          "You have unsaved changes to this workflow. Discard them?",
        ),
        confirmLabel: t("workflows.discardConfirm", "Discard"),
        danger: true,
      }).then((ok) => {
        if (ok) proceed();
      });
    },
    [isDirty, confirm, t],
  );

  const requestClose = useCallback(() => {
    guardedDismiss(onClose);
  }, [guardedDismiss, onClose]);

  // Sidebar workflow switch: route through the guard so dirty edits prompt
  // before the active workflow changes (cancel keeps the current selection).
  const requestSwitch = useCallback(
    (id: string) => {
      if (id === activeId) {
        setWorkflowListStageOpen(false);
        return;
      }
      guardedDismiss(() => {
        setActiveId(id);
        setWorkflowListStageOpen(false);
      });
    },
    [guardedDismiss, activeId],
  );

  // When the selected node sits in an override column, eagerly load the agent
  // registry so the "overridden by column agent <name>" note can resolve the
  // name even if this node's own executor isn't "agent".
  useEffect(() => {
    if (!overrideColumnBinding || agents.length > 0) return;
    let cancelled = false;
    // Project-scoped (PR #1432 review): without projectId this resolves from the
    // wrong scope in multi-project deployments — the override note would show a
    // false "not found" for a perfectly valid project agent.
    Promise.resolve(fetchAgents(undefined, projectId)).then((list) => {
      if (!cancelled) setAgents(list ?? []);
    }).catch((err) => {
      if (!cancelled) addToast(getErrorMessage(err) || t("workflowEditor.agentsLoadFailed", "Failed to load agents"), "error");
    });
    return () => {
      cancelled = true;
    };
  }, [overrideColumnBinding, agents.length, projectId, addToast, t]);

  const promptFullscreenOverlay =
    isPromptExpanded && (selectedNode?.data.kind === "prompt" || selectedNode?.data.kind === "gate")
      ? createPortal(
          <div
            className="wf-prompt-editor wf-prompt-editor--fullscreen"
            onKeyDown={handlePromptFullscreenKeyDown}
          >
            <div className="wf-prompt-fullscreen-header">
              <span>{t("workflowEditor.editingPrompt", "Editing Prompt")}</span>
              <button
                type="button"
                className="btn btn-sm wf-prompt-expand-btn"
                onClick={handleTogglePromptExpand}
                aria-label={t("workflowEditor.collapsePrompt", "Collapse prompt editor")}
                title={t("workflowEditor.collapsePrompt", "Collapse prompt editor")}
              >
                <Minimize2 size={14} />
              </button>
            </div>
            <label className="wf-field">
              <span>{t("workflowEditor.prompt", "Prompt")}</span>
              <textarea
                rows={undefined}
                value={selectedNodePromptValue}
                readOnly={!selectedNodePromptEditable}
                onChange={(e) => handlePromptTextChange(e.target.value)}
                onBlur={handlePromptTextBlur}
                autoFocus
              />
            </label>
            {isBuiltin ? (
              <div className="wf-prompt-override-actions wf-prompt-override-actions--fullscreen">
                {selectedPromptIsOverridden ? (
                  <span className="wf-prompt-override-badge" data-testid="wf-prompt-overridden">
                    {t("workflowEditor.promptOverridden", "Overridden")}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handlePromptResetClick}
                  disabled={!selectedPromptHasOverride || selectedPromptOverrideSaving}
                >
                  {selectedPromptOverrideSaving
                    ? t("workflowEditor.promptSaving", "Saving…")
                    : t("workflowEditor.resetPromptDefault", "Reset to default")}
                </button>
              </div>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  /*
  FNXC:WorkflowEditorFloating 2026-06-24-00:00:
  Dropdown-launched workflow editing must use the shared movable/resizable FloatingWindow so workflow modals participate in drag, resize, viewport clamping, geometry persistence, and shared z-index stacking. The embedded Workflows destination remains fixed in its host panel and bypasses all floating chrome.
  */
  const modalElement = (
      <div
        className={`modal wf-editor-modal${isEmbedded ? " wf-editor-modal--embedded" : ""}`}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Dedicated Escape handler (useOverlayDismiss does not cover Escape).
          // Ignore Escape originating from inputs/textareas/selects so inline
          // editors (name/description) keep their own Escape-to-cancel behavior.
          if (e.key !== "Escape") return;
          // Embedded views are persistent; Escape must not dismiss them.
          if (isEmbedded) return;
          // The create dialog (rendered as a child) owns its own Escape; if it's
          // open, let it handle the event (it stops propagation already).
          if (createOpen) return;
          const target = e.target as HTMLElement;
          const tag = target.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          e.stopPropagation();
          requestClose();
        }}
      >
        <header className="wf-editor-header">
          {/* FNXC:WorkflowEditorEmbedding 2026-06-22-01:00: Title row aligned to the shared ViewHeader/Command Center metric — a Workflow icon (size 20) + 1.125rem title — so the embedded workflows view reads consistently with other main-content destinations. */}
          <h2>
            <Workflow size={20} aria-hidden="true" />
            <span>{t("workflows.title", "Workflows")}</span>
          </h2>
          {/* FNXC:WorkflowEditorEmbedding 2026-06-22-00:00: embedded views keep a
              Command Center-style header title but drop the modal X close button. */}
          {!isEmbedded ? (
            <button className="wf-editor-close" onClick={requestClose} aria-label={t("workflows.closeEditor", "Close workflow editor")}>
              <X size={18} />
            </button>
          ) : null}
        </header>


        <div
          className={`wf-editor-body${workflowListStageOpen ? " wf-editor-body--list-stage" : " wf-editor-body--editor-stage"}${
            simpleLayoutEnabled ? " wf-editor-body--simple-layout" : ""
          }${simpleViewEnabled ? " wf-editor-body--simple-view" : ""}${mobileNodeDetailStage ? " wf-editor-body--mobile-node-detail" : ""}${
            mobileEdgeDetailStage ? " wf-editor-body--mobile-edge-detail" : ""
          }${sidebarCollapsed ? " wf-editor-body--sidebar-collapsed" : ""}`}
        >
          <aside className="wf-editor-sidebar">
            <div className="wf-editor-sidebar-head">
              <button
                className="wf-editor-new"
                ref={newWorkflowBtnRef}
                data-testid="wf-new-workflow"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={14} /> {t("workflows.newWorkflow", "New workflow")}
              </button>
              {!isMobileMode && (
                <button
                  type="button"
                  className="wf-sidebar-shell-toggle"
                  data-testid="wf-sidebar-collapse"
                  aria-expanded={!sidebarCollapsed}
                  aria-label={t("workflows.collapseSidebar", "Collapse workflow sidebar")}
                  title={t("workflows.collapseSidebar", "Collapse workflow sidebar")}
                  onClick={() => setSidebarCollapsed(true)}
                >
                  <ChevronLeft size={14} aria-hidden />
                </button>
              )}
            </div>
            {/* U5/R10: keyboard-accessible import affordance triggering a hidden
                file input; validation failures render in the persistent inline
                region below (role="alert"), not a toast. */}
            <button
              type="button"
              className="wf-editor-import"
              data-testid="wf-import"
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
              title={t("workflows.importTooltip", "Import a workflow from a JSON file")}
            >
              {importing ? <Loader2 size={14} className="wf-spin" /> : <Upload size={14} />}{" "}
              {t("workflows.import", "Import")}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              className="wf-editor-import-input"
              data-testid="wf-import-input"
              style={{ display: "none" }}
              onChange={handleImportFile}
            />
            {importError && (
              <div className="wf-editor-import-error" role="alert" data-testid="wf-import-error">
                {importError}
              </div>
            )}
            {importWarnings.length > 0 && (
              <div className="wf-editor-import-warnings" data-testid="wf-import-warnings">
                {importWarnings.map((w, i) => (
                  <p key={i} className="wf-editor-import-warning">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {isMobileMode && workflows.length > 0 && !activeWorkflow ? (
              <div className="wf-editor-select-note" data-testid="wf-mobile-select-note">
                {t("workflows.mobileSelectNote", "Select a workflow to edit.")}
              </div>
            ) : null}
            {loading ? (
              <div className="wf-editor-empty">
                <Loader2 size={16} className="wf-spin" /> {t("workflows.loading", "Loading…")}
              </div>
            ) : workflows.length === 0 ? (
              <div className="wf-editor-empty">{t("workflows.noneYet", "No workflows yet.")}</div>
            ) : (
              <ul className="wf-editor-list">
                {workflows.map((w) => (
                  <li key={w.id}>
                    <button
                      className={`wf-editor-list-item${w.id === activeId ? " active" : ""}`}
                      onClick={() => requestSwitch(w.id)}
                    >
                      {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* U12: columns + fields authoring panels, below the workflow list,
                each as a collapsible disclosure section. Only shown when a
                workflow is active (read-only gating preserved via isBuiltin). The
                disclosure button serves as the section header; the panels' own
                internal <h3> is suppressed via CSS to avoid a double header. */}
            {/* FNXC:WorkflowSimpleView 2026-07-10-12:00: columns/fields/settings
                authoring panels are advanced-view chrome; the simplified view
                hides them (still one click away via the Advanced toggle). */}
            {activeWorkflow && !simpleLayoutEnabled && !simpleViewEnabled && (
              <div className="wf-sidebar-panels">
                <section className="wf-sidebar-section" data-testid="wf-sidebar-columns-section">
                  <button
                    type="button"
                    className="wf-sidebar-section-toggle"
                    aria-expanded={!columnsCollapsed}
                    data-testid="wf-sidebar-columns-toggle"
                    onClick={() => setColumnsCollapsed((c) => !c)}
                  >
                    {columnsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{t("workflowColumns.title", "Columns")}</span>
                  </button>
                  {!columnsCollapsed && (
                    <WorkflowColumnPanel
                      columns={columns}
                      onChange={setColumns}
                      violations={columnViolations}
                      readOnly={isBuiltin}
                      projectId={projectId}
                      addToast={addToast}
                      columnAgentsEnabled={columnAgentsEnabled}
                    />
                  )}
                </section>

                <section className="wf-sidebar-section" data-testid="wf-sidebar-fields-section">
                  <button
                    type="button"
                    className="wf-sidebar-section-toggle"
                    aria-expanded={!fieldsCollapsed}
                    data-testid="wf-sidebar-fields-toggle"
                    onClick={() => setFieldsCollapsed((c) => !c)}
                  >
                    {fieldsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{t("workflowFields.title", "Fields")}</span>
                  </button>
                  {!fieldsCollapsed && (
                    <WorkflowFieldsPanel
                      fields={fields}
                      onChange={setFields}
                      readOnly={isBuiltin}
                      addToast={addToast}
                    />
                  )}
                </section>

                <section className="wf-sidebar-section" data-testid="wf-sidebar-settings-section">
                  <button
                    type="button"
                    className="wf-sidebar-section-toggle"
                    aria-expanded={!settingsCollapsed}
                    data-testid="wf-sidebar-settings-toggle"
                    onClick={() => setSettingsCollapsed((c) => !c)}
                  >
                    {settingsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{t("workflowSettings.title", "Settings")}</span>
                  </button>
                  {!settingsCollapsed && (
                    <div ref={settingsPanelRef} className="wf-settings-panel-wrap">
                      <WorkflowSettingsPanel
                        workflowId={activeWorkflow.id}
                        settings={settings}
                        onChange={setSettings}
                        readOnly={isBuiltin}
                        projectId={projectId}
                        addToast={addToast}
                        initialTab="values"
                      />
                    </div>
                  )}
                </section>

                {/* FNXC:WorkflowOptionalGroup 2026-06-21-18:00: The optional-step
                    DECLARATION authoring sidebar section is removed. Optional steps
                    are authored as graph-native `optional-group` nodes on the canvas. */}
              </div>
            )}
          </aside>

          <section className="wf-editor-canvas-wrap">
            <button
              type="button"
              className="wf-editor-mobile-back"
              onClick={() => setWorkflowListStageOpen(true)}
              aria-label={t("workflows.backToWorkflowList", "Back to workflows")}
            >
              <ChevronLeft size={16} />
              <span>{t("common.back", "Back")}</span>
            </button>
            {activeWorkflow ? (
              <>
                {/* Inline name + description strip (KTD-10). Built-ins render as
                    plain text (no click affordance); user-owned workflows are
                    click-to-edit (Enter commits, Escape cancels, blur commits). */}
                <div className="wf-name-strip">
                  {sidebarCollapsed && !isMobileMode && (
                    <button
                      type="button"
                      className="wf-sidebar-shell-restore"
                      data-testid="wf-sidebar-restore"
                      aria-expanded="false"
                      aria-label={t("workflows.showSidebar", "Show workflow sidebar")}
                      title={t("workflows.showSidebar", "Show workflow sidebar")}
                      onClick={() => setSidebarCollapsed(false)}
                    >
                      <ChevronRight size={14} aria-hidden />
                    </button>
                  )}
                  <WorkflowIcon workflowId={activeWorkflow.id} icon={icon} decorative />
                  {isBuiltin ? (
                    <span className="wf-workflow-name wf-workflow-name--readonly" data-testid="wf-workflow-name">
                      {activeWorkflow.name}
                    </span>
                  ) : editingName ? (
                    <input
                      className="wf-workflow-name-input"
                      data-testid="wf-workflow-name-input"
                      autoFocus
                      value={name}
                      aria-label={t("workflows.nameLabel", "Workflow name")}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!name.trim()) setName(activeWorkflow.name);
                          setEditingName(false);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setName(activeWorkflow.name);
                          setEditingName(false);
                        }
                      }}
                      onBlur={() => {
                        if (!name.trim()) setName(activeWorkflow.name);
                        setEditingName(false);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="wf-workflow-name"
                      data-testid="wf-workflow-name"
                      onClick={() => setEditingName(true)}
                      title={t("workflows.clickToRename", "Click to rename")}
                    >
                      {name || activeWorkflow.name}
                    </button>
                  )}
                  {!isBuiltin ? (
                    <input
                      className="wf-workflow-icon-input"
                      data-testid="wf-workflow-icon-input"
                      value={icon ?? ""}
                      maxLength={16}
                      aria-label={t("workflows.iconLabel", "Icon (optional)")}
                      placeholder={t("workflows.iconPlaceholder", "e.g. 🚀")}
                      onChange={(e) => setIcon(e.target.value)}
                    />
                  ) : null}
                  {isBuiltin ? (
                    activeWorkflow.description ? (
                      <span className="wf-workflow-description wf-workflow-description--readonly" data-testid="wf-workflow-description">
                        {activeWorkflow.description}
                      </span>
                    ) : null
                  ) : editingDescription ? (
                    <input
                      className="wf-workflow-description-input"
                      data-testid="wf-workflow-description-input"
                      autoFocus
                      value={description}
                      aria-label={t("workflows.descriptionLabel", "Workflow description")}
                      placeholder={t("workflows.descriptionPlaceholder", "Add a description")}
                      onChange={(e) => setDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setEditingDescription(false);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setDescription(activeWorkflow.description ?? "");
                          setEditingDescription(false);
                        }
                      }}
                      onBlur={() => setEditingDescription(false)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="wf-workflow-description"
                      data-testid="wf-workflow-description"
                      onClick={() => setEditingDescription(true)}
                      title={t("workflows.clickToEditDescription", "Click to edit description")}
                    >
                      {description || t("workflows.descriptionPlaceholder", "Add a description")}
                    </button>
                  )}
                  {!isMobileMode && (
                    /* FNXC:WorkflowSimpleView 2026-07-10-12:00: segmented three-mode
                       switch (Simple / Advanced / List) replacing the old boolean
                       simple-editor toggle; List is the old simple editor. */
                    <div
                      className="wf-view-mode-toggle"
                      role="group"
                      data-testid="wf-view-mode-toggle"
                      aria-label={t("workflows.viewModeLabel", "Editor view")}
                    >
                      {(
                        [
                          ["simple", Workflow, t("workflows.viewModeSimple", "Simple")],
                          ["advanced", LayoutGrid, t("workflows.viewModeAdvanced", "Advanced")],
                          ["list", ListChecks, t("workflows.viewModeList", "List")],
                        ] as Array<[WorkflowEditorViewMode, typeof Workflow, string]>
                      ).map(([mode, Icon, label]) => (
                        <button
                          key={mode}
                          type="button"
                          className={`wf-view-mode-option${viewMode === mode ? " wf-view-mode-option--active" : ""}`}
                          data-testid={`wf-view-mode-${mode}`}
                          aria-pressed={viewMode === mode}
                          onClick={() => setViewMode(mode)}
                        >
                          <Icon size={13} aria-hidden />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {lifecycleWarnings.length > 0 && (
                  /* FNXC:WorkflowEditor 2026-07-12-10:30: the lifecycle
                     warnings banner previously rendered fully expanded and
                     dominated the editor header (every fresh workflow starts
                     with two warnings). It is now a one-line disclosure —
                     count summary, details on demand — in every view mode. */
                  <details className="wf-lifecycle-warnings" data-testid="wf-lifecycle-warnings">
                    <summary className="wf-lifecycle-warnings-title" data-testid="wf-lifecycle-warnings-toggle">
                      <Shield size={14} aria-hidden />
                      <span role="status">
                        {t("workflows.lifecycleWarningsCount", "{{count}} lifecycle warnings", {
                          count: lifecycleWarnings.length,
                        })}
                      </span>
                      <ChevronDown size={12} className="wf-lifecycle-warnings-chevron" aria-hidden />
                    </summary>
                    <ul>
                      {lifecycleWarnings.map((warning, index) => (
                        <li key={`${warning.code}:${warning.nodeId ?? ""}:${index}`}>
                          <span className="wf-lifecycle-warning-code">{warning.code}</span>
                          {warning.nodeId && <span className="wf-lifecycle-warning-node">{warning.nodeId}</span>}
                          <span>{warning.message}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {simpleLayoutEnabled && (
                  <div className="wf-mobile-shell" data-testid="wf-mobile-shell">
                    <nav className="wf-mobile-tabs" aria-label={t("workflows.mobileEditorNav", "Workflow editor sections")}>
                      {([
                        ["graph", t("workflowNodes.mobileGraph", "Graph")],
                        ["add", t("workflowNodes.mobileAdd", "Add")],
                        ["settings", t("workflowSettings.title", "Settings")],
                        ["fields", t("workflowFields.title", "Fields")],
                        ["columns", t("workflowColumns.title", "Columns")],
                        ["actions", t("workflowNodes.mobileActions", "Actions")],
                      ] as Array<[MobileWorkflowPanel, string]>).map(([panel, label]) => (
                        <button
                          key={panel}
                          type="button"
                          className={`wf-mobile-tab${mobilePanel === panel ? " wf-mobile-tab--active" : ""}`}
                          aria-current={mobilePanel === panel ? "page" : undefined}
                          data-testid={`wf-mobile-tab-${panel}`}
                          onClick={() => setMobilePanel(panel)}
                        >
                          {label}
                        </button>
                      ))}
                    </nav>

                    <div className="wf-mobile-panel" data-testid={`wf-mobile-panel-${mobilePanel}`}>
                      {mobilePanel === "graph" && (
                        <>
                          {/* FNXC:WorkflowSimpleView 2026-07-10-12:00: mobile
                              graph tab offers the simplified touch canvas
                              (default) with the row list kept as the even
                              simpler fallback. Desktop "list" mode reuses
                              this shell and keeps the row list only. */}
                          {isMobileMode && (
                            <div
                              className="wf-mobile-graph-style-toggle"
                              role="group"
                              data-testid="wf-mobile-graph-style-toggle"
                              aria-label={t("workflowNodes.mobileGraphStyleLabel", "Graph presentation")}
                            >
                              {(
                                [
                                  ["canvas", t("workflowNodes.mobileGraphStyleCanvas", "Graph")],
                                  ["list", t("workflowNodes.mobileGraphStyleList", "List")],
                                ] as Array<[MobileGraphStyle, string]>
                              ).map(([style, label]) => (
                                <button
                                  key={style}
                                  type="button"
                                  className={`wf-view-mode-option${mobileGraphStyle === style ? " wf-view-mode-option--active" : ""}`}
                                  data-testid={`wf-mobile-graph-style-${style}`}
                                  aria-pressed={mobileGraphStyle === style}
                                  onClick={() => setMobileGraphStyle(style)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}
                          {isMobileMode && mobileGraphStyle === "canvas" ? (
                            <div className="wf-mobile-simple-canvas" data-testid="wf-mobile-simple-canvas">
                              <WorkflowEditorCatalogContext.Provider value={catalogs}>
                                <WorkflowSimpleCanvas
                                  instanceKey={activeWorkflow.id}
                                  nodes={nodesForRender}
                                  edges={edges}
                                  columnNames={columnNameMap}
                                  editable={!isBuiltin}
                                  selectedNodeId={selectedNodeId}
                                  selectedEdgeId={selectedEdgeId}
                                  onSelectNode={(id) => {
                                    setSelectedNodeId(id);
                                    setSelectedEdgeId(null);
                                    setInspectorCollapsed(false);
                                  }}
                                  onSelectEdge={(id) => {
                                    setSelectedEdgeId(id);
                                    setSelectedNodeId(null);
                                  }}
                                  onClearSelection={() => {
                                    setSelectedNodeId(null);
                                    setSelectedEdgeId(null);
                                  }}
                                  onInsertOnEdge={openInsertOnEdge}
                                  onAddStep={openAddStep}
                                  onBeforeDelete={onBeforeDelete}
                                  onNodesDelete={onNodesDelete}
                                  onEdgesDelete={onEdgesDelete}
                                />
                              </WorkflowEditorCatalogContext.Provider>
                            </div>
                          ) : (
                            <MobileWorkflowGraphView
                              rows={mobileGraphRows}
                              selectedNodeId={selectedNodeId}
                              selectedEdgeId={selectedEdgeId}
                              onSelectNode={(id) => {
                                setSelectedNodeId(id);
                                setSelectedEdgeId(null);
                                setInspectorCollapsed(false);
                              }}
                              onSelectEdge={(id) => {
                                setSelectedEdgeId(id);
                                setSelectedNodeId(null);
                              }}
                              onCreateConnection={isBuiltin ? undefined : onCreateSimpleConnection}
                              canReorder={!isBuiltin}
                              onMoveNode={onMoveSimpleNode}
                            />
                          )}
                        </>
                      )}

                      {mobilePanel === "add" && (
                        <div className="wf-mobile-add">
                          {isBuiltin ? (
                            <p className="wf-inspector-note wf-inspector-note--info wf-inspector-note--with-icon">
                              <WorkflowIcon workflowId={activeWorkflow.id} decorative />
                              <span>{t("workflows.readOnlyBuiltin", "Workflow structure is read-only; prompts are editable.")}</span>
                            </p>
                          ) : (
                            <>
                              <section className="wf-mobile-add-section">
                                <h3>{t("workflowNodes.mobileNodeKinds", "Node types")}</h3>
                                <div className="wf-mobile-add-grid">
                                  {PALETTE.map(({ kind, label, icon: Icon, presetConfig }) => (
                                    <button
                                      key={label}
                                      type="button"
                                      className="wf-mobile-add-option"
                                      data-testid={`wf-mobile-add-${kind}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                                      onClick={() => {
                                        addNode(kind, label, presetConfig);
                                        setMobilePanel("graph");
                                      }}
                                    >
                                      <Icon size={16} aria-hidden />
                                      <span>{label}</span>
                                    </button>
                                  ))}
                                </div>
                              </section>

                              {hasAnyTemplate && (
                                <section className="wf-mobile-add-section">
                                  <h3>{t("workflowNodes.templatesSection", "Templates")}</h3>
                                  {templateTotalCount > 8 && (
                                    <input
                                      type="text"
                                      className="wf-templates-filter wf-mobile-template-filter"
                                      data-testid="wf-mobile-template-filter"
                                      value={templateFilter}
                                      onChange={(e) => setTemplateFilter(e.target.value)}
                                      placeholder={t("workflowNodes.templateFilterPlaceholder", "Filter templates")}
                                      aria-label={t("workflowNodes.templateFilterLabel", "Filter templates")}
                                    />
                                  )}
                                  {templateConflict && (
                                    <div className="wf-templates-conflict" role="alert" data-testid="wf-mobile-tpl-conflict">
                                      {t(
                                        "workflowNodes.templateSeamConflict",
                                        'This fragment duplicates the "{{seam}}" seam already on the canvas, so it can\'t be inserted.',
                                        { seam: templateConflict },
                                      )}
                                    </div>
                                  )}
                                  {templateGroups.fragmentEntries.length > 0 && (
                                    <div className="wf-mobile-template-group">
                                      <h4>{t("workflowNodes.templatesFragments", "Fragments")}</h4>
                                      {templateGroups.fragmentEntries.map((f) => (
                                        <button
                                          key={f.id}
                                          type="button"
                                          className="wf-mobile-template-option"
                                          data-testid={`wf-mobile-tpl-fragment-${f.id}`}
                                          onClick={() => {
                                            if (handleInsertFragment(f)) setMobilePanel("graph");
                                          }}
                                        >
                                          {f.name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {templateGroups.stepEntries.length > 0 && (
                                    <div className="wf-mobile-template-group">
                                      <h4>{t("workflowNodes.templatesBuiltinSteps", "Fusion steps")}</h4>
                                      {/* FNXC:WorkflowOptionalGroup 2026-06-21-14:38: mobile mirrors the desktop two-variant insert (node / optional group). */}
                                      {templateGroups.stepEntries.map((s) => (
                                        <div key={s.id} className="wf-mobile-template-option-row">
                                          <button
                                            type="button"
                                            className="wf-mobile-template-option"
                                            data-testid={`wf-mobile-tpl-step-${s.id}`}
                                            onClick={() => {
                                              handleInsertStepTemplate(s);
                                              setMobilePanel("graph");
                                            }}
                                          >
                                            {s.name}
                                          </button>
                                          <button
                                            type="button"
                                            className="wf-mobile-template-option-optional"
                                            data-testid={`wf-mobile-tpl-step-${s.id}-optional-group`}
                                            aria-label={t(
                                              "workflowNodes.insertTemplateAsOptionalGroup",
                                              "Insert {{name}} as optional group",
                                              { name: s.name },
                                            )}
                                            onClick={() => {
                                              handleInsertStepTemplateAsOptionalGroup(s);
                                              setMobilePanel("graph");
                                            }}
                                          >
                                            {t("workflowNodes.asOptionalGroup", "as optional group")}
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {templateGroups.pluginEntries.length > 0 && (
                                    <div className="wf-mobile-template-group">
                                      <h4>{t("workflowNodes.templatesPluginSteps", "Plugin steps")}</h4>
                                      {templateGroups.pluginEntries.map(({ pluginId, template }) => (
                                        <button
                                          key={`${pluginId}:${template.id}`}
                                          type="button"
                                          className="wf-mobile-template-option"
                                          data-testid={`wf-mobile-tpl-plugin-${template.id}`}
                                          onClick={() => {
                                            handleInsertStepTemplate(template);
                                            setMobilePanel("graph");
                                          }}
                                        >
                                          <span>{template.name}</span>
                                          <span className="wf-templates-badge">{pluginId}</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </section>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {mobilePanel === "settings" && activeWorkflow && (
                        <div ref={settingsPanelRef} className="wf-mobile-destination">
                          <WorkflowSettingsPanel
                            workflowId={activeWorkflow.id}
                            settings={settings}
                            onChange={setSettings}
                            readOnly={isBuiltin}
                            projectId={projectId}
                            addToast={addToast}
                            initialTab="values"
                          />
                        </div>
                      )}

                      {mobilePanel === "fields" && (
                        <div className="wf-mobile-destination">
                          <WorkflowFieldsPanel
                            fields={fields}
                            onChange={setFields}
                            readOnly={isBuiltin}
                            addToast={addToast}
                          />
                        </div>
                      )}


                      {mobilePanel === "columns" && (
                        <div className="wf-mobile-destination">
                          <WorkflowColumnPanel
                            columns={columns}
                            onChange={setColumns}
                            violations={columnViolations}
                            readOnly={isBuiltin}
                            projectId={projectId}
                            addToast={addToast}
                            columnAgentsEnabled={columnAgentsEnabled}
                          />
                        </div>
                      )}

                      {mobilePanel === "actions" && (
                        <div className="wf-mobile-actions">
                          {isBuiltin ? (
                            <>
                              <p className="wf-inspector-note wf-inspector-note--info wf-inspector-note--with-icon">
                                <WorkflowIcon workflowId={activeWorkflow.id} decorative />
                                <span>{t("workflows.readOnlyBuiltin", "Workflow structure is read-only; prompts are editable.")}</span>
                              </p>
                              <button className="wf-editor-action" data-testid="wf-mobile-export" onClick={handleExport}>
                                <Download size={15} /> {t("workflows.export", "Export")}
                              </button>
                              <button className="wf-editor-save wf-editor-duplicate-primary" data-testid="wf-mobile-duplicate" onClick={handleDuplicate}>
                                <Plus size={15} /> {t("workflows.duplicateToCustomize", "Duplicate to customize")}
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="wf-editor-save" data-testid="wf-mobile-save" onClick={handleSave} disabled={saving}>
                                {saving ? <Loader2 size={15} className="wf-spin" /> : <Save size={15} />}
                                {t("common.save", "Save")}
                              </button>
                              <button className="wf-editor-action" data-testid="wf-mobile-ai-edit" onClick={() => setAiPanelOpen((o) => !o)}>
                                <Sparkles size={15} /> {t("workflows.aiEdit", "Design with AI")}
                              </button>
                              {aiPanelOpen && (
                                <div className="wf-ai-panel wf-mobile-ai-panel" data-testid="wf-mobile-ai-panel" role="dialog" aria-busy={aiEditBusy}>
                                  <textarea
                                    className="wf-ai-prompt"
                                    data-testid="wf-mobile-ai-edit-prompt"
                                    rows={4}
                                    value={aiEditPrompt}
                                    disabled={aiEditBusy}
                                    placeholder={t(
                                      "workflows.aiPromptPlaceholder",
                                      "e.g. Run lint and tests before merge, then post a changelog comment after merge",
                                    )}
                                    onChange={(e) => {
                                      setAiEditPrompt(e.target.value);
                                      if (aiEditError) setAiEditError(null);
                                    }}
                                  />
                                  {aiEditError && (
                                    <p className="wf-create-error" role="alert" data-testid="wf-mobile-ai-edit-error">
                                      {aiEditError}
                                    </p>
                                  )}
                                  <div className="wf-ai-actions">
                                    <button
                                      type="button"
                                      className="btn btn-primary wf-ai-submit"
                                      data-testid="wf-mobile-ai-edit-submit"
                                      disabled={aiEditBusy}
                                      onClick={() => void handleAiEditSubmit()}
                                    >
                                      {aiEditBusy ? <Loader2 size={13} className="wf-spin" /> : <Sparkles size={13} />}
                                      {t("workflows.aiSubmit", "Design with AI")}
                                    </button>
                                    {aiEditBusy && (
                                      <button type="button" className="btn wf-ai-cancel" onClick={handleAiEditCancel}>
                                        {t("common.cancel", "Cancel")}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}
                              <button className="wf-editor-action" data-testid="wf-mobile-auto-layout" onClick={handleAutoLayout}>
                                <LayoutGrid size={15} /> {t("workflowNodes.autoLayout", "Auto-layout")}
                              </button>
                              <button className="wf-editor-action" data-testid="wf-mobile-export" onClick={handleExport} disabled={isDirty}>
                                <Download size={15} /> {t("workflows.export", "Export")}
                              </button>
                              <button className="wf-editor-delete" data-testid="wf-mobile-delete" onClick={handleDeleteWorkflow}>
                                <Trash2 size={15} /> {t("common.delete", "Delete")}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {isBuiltin ? (
                  // Read-only Fusion workflow: a banner *replaces* the save/edit toolbar
                  // (not an overlay); the canvas below stays inspectable.
                  <div className="wf-editor-readonly-banner" role="status" data-testid="wf-readonly-banner">
                    <span className="wf-editor-readonly-note">
                      <WorkflowIcon workflowId={activeWorkflow.id} decorative />
                      <span>{t("workflows.readOnlyBuiltin", "Workflow structure is read-only; prompts are editable.")}</span>
                    </span>
                    <button
                      className="wf-editor-action"
                      data-testid="wf-export"
                      onClick={handleExport}
                      title={t(
                        "workflows.exportTooltip",
                        "Download as JSON — contains your full prompt and command text",
                      )}
                    >
                      <Download size={13} /> {t("workflows.export", "Export")}
                    </button>
                    <button className="wf-editor-save wf-editor-duplicate-primary" onClick={handleDuplicate}>
                      <Plus size={13} /> {t("workflows.duplicateToCustomize", "Duplicate to customize")}
                    </button>
                  </div>
                ) : simpleViewEnabled ? (
                  /* FNXC:WorkflowSimpleView 2026-07-10-12:00: simplified-view
                     toolbar — the flat 16-button palette moves into the
                     searchable add-step dialog; the toolbar keeps only the
                     common actions (Add step, Design with AI, Delete, Save).
                     Import/Export/Auto-layout stay in the Advanced view. */
                  <div className="wf-editor-toolbar wf-editor-toolbar--simple" data-testid="wf-simple-toolbar">
                    <button
                      type="button"
                      className="wf-editor-action wf-simple-toolbar-add"
                      data-testid="wf-simple-toolbar-add-step"
                      onClick={openAddStep}
                    >
                      <Plus size={13} /> {t("workflowNodes.simpleAddStep", "Add step")}
                    </button>
                    <div className="wf-editor-actions">
                      <div className="wf-ai-edit-wrap">
                        <button
                          className="wf-editor-action"
                          data-testid="wf-simple-ai-edit"
                          aria-expanded={aiPanelOpen}
                          onClick={() => {
                            setAiPanelOpen((o) => !o);
                            setAiEditError(null);
                          }}
                        >
                          <Sparkles size={13} /> {t("workflows.aiEdit", "Design with AI")}
                        </button>
                        {aiPanelOpen && (
                          <div
                            className="wf-ai-panel"
                            data-testid="wf-simple-ai-panel"
                            role="dialog"
                            aria-busy={aiEditBusy}
                            aria-label={t("workflows.aiEdit", "Design with AI")}
                          >
                            <textarea
                              className="wf-ai-prompt"
                              data-testid="wf-simple-ai-edit-prompt"
                              rows={3}
                              value={aiEditPrompt}
                              disabled={aiEditBusy}
                              placeholder={t(
                                "workflows.aiPromptPlaceholder",
                                "e.g. Run lint and tests before merge, then post a changelog comment after merge",
                              )}
                              onChange={(e) => {
                                setAiEditPrompt(e.target.value);
                                if (aiEditError) setAiEditError(null);
                              }}
                            />
                            {aiEditError && (
                              <p className="wf-create-error" role="alert" data-testid="wf-simple-ai-edit-error">
                                {aiEditError}
                              </p>
                            )}
                            <div className="wf-ai-actions">
                              <button
                                type="button"
                                className="btn btn-primary wf-ai-submit"
                                data-testid="wf-simple-ai-edit-submit"
                                disabled={aiEditBusy}
                                onClick={() => void handleAiEditSubmit()}
                              >
                                {aiEditBusy ? <Loader2 size={13} className="wf-spin" /> : <Sparkles size={13} />}{" "}
                                {t("workflows.aiSubmit", "Design with AI")}
                              </button>
                              {aiEditBusy && (
                                <button
                                  type="button"
                                  className="btn wf-ai-cancel"
                                  data-testid="wf-simple-ai-edit-cancel"
                                  onClick={handleAiEditCancel}
                                >
                                  {t("common.cancel", "Cancel")}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      <button className="wf-editor-delete" onClick={handleDeleteWorkflow}>
                        <Trash2 size={13} /> {t("common.delete", "Delete")}
                      </button>
                      <button className="wf-editor-save" onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 size={13} className="wf-spin" /> : <Save size={13} />}{" "}
                        {t("common.save", "Save")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="wf-editor-toolbar">
                    <div className="wf-editor-palette">
                      {PALETTE.map(({ kind, label, icon: Icon, presetConfig }) => (
                        <button
                          key={label}
                          className="wf-palette-btn"
                          onClick={() => addNode(kind, label, presetConfig)}
                        >
                          <Icon size={13} /> {label}
                        </button>
                      ))}
                    </div>
                    <div className="wf-editor-actions">
                      {/* U10/R11: "Design with AI" opens a popover panel targeting
                          the active workflow (workflowId). Hidden for built-ins. */}
                      <div className="wf-ai-edit-wrap">
                        <button
                          className="wf-editor-action"
                          data-testid="wf-ai-edit"
                          aria-expanded={aiPanelOpen}
                          onClick={() => {
                            setAiPanelOpen((o) => !o);
                            setAiEditError(null);
                          }}
                        >
                          <Sparkles size={13} /> {t("workflows.aiEdit", "Design with AI")}
                        </button>
                        {aiPanelOpen && (
                          <div
                            className="wf-ai-panel"
                            data-testid="wf-ai-panel"
                            role="dialog"
                            aria-busy={aiEditBusy}
                            aria-label={t("workflows.aiEdit", "Design with AI")}
                          >
                            <textarea
                              className="wf-ai-prompt"
                              data-testid="wf-ai-edit-prompt"
                              rows={3}
                              value={aiEditPrompt}
                              disabled={aiEditBusy}
                              placeholder={t(
                                "workflows.aiPromptPlaceholder",
                                "e.g. Run lint and tests before merge, then post a changelog comment after merge",
                              )}
                              onChange={(e) => {
                                setAiEditPrompt(e.target.value);
                                if (aiEditError) setAiEditError(null);
                              }}
                            />
                            {aiEditError && (
                              <p className="wf-create-error" role="alert" data-testid="wf-ai-edit-error">
                                {aiEditError}
                              </p>
                            )}
                            <div className="wf-ai-actions">
                              <button
                                type="button"
                                className="btn btn-primary wf-ai-submit"
                                data-testid="wf-ai-edit-submit"
                                disabled={aiEditBusy}
                                onClick={() => void handleAiEditSubmit()}
                              >
                                {aiEditBusy ? (
                                  <Loader2 size={13} className="wf-spin" />
                                ) : (
                                  <Sparkles size={13} />
                                )}{" "}
                                {t("workflows.aiSubmit", "Design with AI")}
                              </button>
                              {aiEditBusy && (
                                <button
                                  type="button"
                                  className="btn wf-ai-cancel"
                                  data-testid="wf-ai-edit-cancel"
                                  onClick={handleAiEditCancel}
                                >
                                  {t("common.cancel", "Cancel")}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      <button
                        className="wf-editor-action"
                        onClick={handleAutoLayout}
                        data-testid="wf-auto-layout"
                      >
                        <LayoutGrid size={13} /> {t("workflowNodes.autoLayout", "Auto-layout")}
                      </button>
                      <button
                        className="wf-editor-action"
                        data-testid="wf-export"
                        onClick={handleExport}
                        disabled={isDirty}
                        title={
                          isDirty
                            ? t("workflows.exportDirtyTooltip", "Save before exporting")
                            : t(
                                "workflows.exportTooltip",
                                "Download as JSON — contains your full prompt and command text",
                              )
                        }
                      >
                        <Download size={13} /> {t("workflows.export", "Export")}
                      </button>
                      <button className="wf-editor-delete" onClick={handleDeleteWorkflow}>
                        <Trash2 size={13} /> {t("common.delete", "Delete")}
                      </button>
                      <button className="wf-editor-save" onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 size={13} className="wf-spin" /> : <Save size={13} />}{" "}
                        {t("common.save", "Save")}
                      </button>
                    </div>
                  </div>
                )}

                {hasAnyTemplate && !simpleViewEnabled && (
                  <section
                    className="wf-templates"
                    data-testid="wf-palette-templates"
                    aria-label={t("workflowNodes.templatesSection", "Templates")}
                  >
                    <div className="wf-templates-header">
                      <button
                        type="button"
                        className="wf-templates-toggle"
                        aria-expanded={!templatesCollapsed}
                        data-testid="wf-templates-toggle"
                        onClick={() => setTemplatesCollapsed((c) => !c)}
                      >
                        {templatesCollapsed ? (
                          <ChevronRight size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )}
                        <Library size={13} />{" "}
                        {t("workflowNodes.templatesSection", "Templates")}
                      </button>
                      {!templatesCollapsed && templateTotalCount > 8 && (
                        <input
                          type="text"
                          className="wf-templates-filter"
                          data-testid="wf-template-filter"
                          value={templateFilter}
                          onChange={(e) => setTemplateFilter(e.target.value)}
                          placeholder={t(
                            "workflowNodes.templateFilterPlaceholder",
                            "Filter templates",
                          )}
                          aria-label={t(
                            "workflowNodes.templateFilterLabel",
                            "Filter templates",
                          )}
                        />
                      )}
                    </div>

                    {!templatesCollapsed && (
                      <div className="wf-templates-body">
                        {templateConflict && (
                          <div
                            className="wf-templates-conflict"
                            role="alert"
                            data-testid="wf-tpl-conflict"
                          >
                            {t(
                              "workflowNodes.templateSeamConflict",
                              'This fragment duplicates the "{{seam}}" seam already on the canvas, so it can\'t be inserted.',
                              { seam: templateConflict },
                            )}
                          </div>
                        )}

                        {templateGroups.fragmentEntries.length > 0 && (
                          <div className="wf-templates-group">
                            <h4 className="wf-templates-group-title">
                              {t("workflowNodes.templatesFragments", "Fragments")}
                            </h4>
                            <div className="wf-templates-entries">
                              {templateGroups.fragmentEntries.map((f) => (
                                <button
                                  key={f.id}
                                  type="button"
                                  className="wf-templates-entry"
                                  data-testid={`wf-tpl-fragment-${f.id}`}
                                  disabled={isBuiltin}
                                  aria-label={t(
                                    "workflowNodes.insertTemplate",
                                    "Insert template {{name}}",
                                    { name: f.name },
                                  )}
                                  onClick={() => handleInsertFragment(f)}
                                >
                                  {f.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {templateGroups.stepEntries.length > 0 && (
                          <div className="wf-templates-group">
                            <h4 className="wf-templates-group-title">
                              {t("workflowNodes.templatesBuiltinSteps", "Fusion steps")}
                            </h4>
                            <div className="wf-templates-entries">
                              {/*
                              FNXC:WorkflowOptionalGroup 2026-06-21-14:36:
                              Each built-in add-on surfaces TWO insert variants: the row inserts as a single node
                              (today's behavior), and a small secondary "as optional group" affordance wraps it in
                              an `optional-group` container (U5/R5). Both keep the established `wf-tpl-step-*` testid
                              convention (the wrap variant suffixes `-optional-group`).
                              */}
                              {templateGroups.stepEntries.map((s) => (
                                <div key={s.id} className="wf-templates-entry-row">
                                  <button
                                    type="button"
                                    className="wf-templates-entry"
                                    data-testid={`wf-tpl-step-${s.id}`}
                                    disabled={isBuiltin}
                                    aria-label={t(
                                      "workflowNodes.insertTemplate",
                                      "Insert template {{name}}",
                                      { name: s.name },
                                    )}
                                    onClick={() => handleInsertStepTemplate(s)}
                                  >
                                    {s.name}
                                  </button>
                                  <button
                                    type="button"
                                    className="wf-templates-entry-optional"
                                    data-testid={`wf-tpl-step-${s.id}-optional-group`}
                                    disabled={isBuiltin}
                                    title={t(
                                      "workflowNodes.insertAsOptionalGroup",
                                      "Insert as optional group",
                                    )}
                                    aria-label={t(
                                      "workflowNodes.insertTemplateAsOptionalGroup",
                                      "Insert {{name}} as optional group",
                                      { name: s.name },
                                    )}
                                    onClick={() => handleInsertStepTemplateAsOptionalGroup(s)}
                                  >
                                    {t("workflowNodes.asOptionalGroup", "as optional group")}
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {templateGroups.pluginEntries.length > 0 && (
                          <div className="wf-templates-group">
                            <h4 className="wf-templates-group-title">
                              {t("workflowNodes.templatesPluginSteps", "Plugin steps")}
                            </h4>
                            <div className="wf-templates-entries">
                              {templateGroups.pluginEntries.map(({ pluginId, template }) => (
                                <button
                                  key={`${pluginId}:${template.id}`}
                                  type="button"
                                  className="wf-templates-entry"
                                  data-testid={`wf-tpl-plugin-${template.id}`}
                                  disabled={isBuiltin}
                                  aria-label={t(
                                    "workflowNodes.insertTemplate",
                                    "Insert template {{name}}",
                                    { name: template.name },
                                  )}
                                  onClick={() => handleInsertStepTemplate(template)}
                                >
                                  {template.name}
                                  <span className="wf-templates-badge">{pluginId}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {validationError && (
                  <div className="wf-editor-banner" role="alert">
                    {validationError}
                  </div>
                )}
                {unplaced.length > 0 && (
                  <div className="wf-editor-banner wf-editor-banner--warn" role="alert" data-testid="wf-unplaced-summary">
                    {t("workflowColumns.unplacedCount", "{{count}} nodes not placed in a column", {
                      count: unplaced.length,
                    })}
                  </div>
                )}

                {simpleViewEnabled ? (
                  /* FNXC:WorkflowSimpleView 2026-07-10-12:00: the simplified
                     graphical canvas replaces the advanced React Flow canvas;
                     both edit the same nodes/edges state, so selection,
                     deletion, the inspector, validation badges and Save all
                     behave identically. */
                  <div className="wf-editor-canvas wf-editor-canvas--simple" ref={canvasRef} tabIndex={-1}>
                    <WorkflowEditorCatalogContext.Provider value={catalogs}>
                      <WorkflowSimpleCanvas
                        instanceKey={activeWorkflow.id}
                        nodes={nodesForRender}
                        edges={edges}
                        columnNames={columnNameMap}
                        editable={!isBuiltin}
                        selectedNodeId={selectedNodeId}
                        selectedEdgeId={selectedEdgeId}
                        onSelectNode={(id) => {
                          setSelectedNodeId(id);
                          setSelectedEdgeId(null);
                          setInspectorCollapsed(false);
                        }}
                        onSelectEdge={(id) => {
                          setSelectedEdgeId(id);
                          setSelectedNodeId(null);
                        }}
                        onClearSelection={() => {
                          setSelectedNodeId(null);
                          setSelectedEdgeId(null);
                        }}
                        onInsertOnEdge={openInsertOnEdge}
                        onAddStep={openAddStep}
                        onBeforeDelete={onBeforeDelete}
                        onNodesDelete={onNodesDelete}
                        onEdgesDelete={onEdgesDelete}
                      />
                    </WorkflowEditorCatalogContext.Provider>
                  </div>
                ) : (
                <div className="wf-editor-canvas" ref={canvasRef} tabIndex={-1}>
                  {isMobileMode &&
                    inspectorCollapsed &&
                    selectedNode &&
                    selectedNode.data.kind !== "end" && (
                      <button
                        type="button"
                        className="wf-inspector-toggle wf-inspector-toggle--collapsed"
                        data-testid="wf-inspector-toggle"
                        aria-expanded="false"
                        onClick={() => setInspectorCollapsed(false)}
                      >
                        <ChevronRight size={13} />
                        <span>{t("workflowNodes.showInspector", "Show node details")}</span>
                      </button>
                    )}
                  {isTrivialUserGraph && (
                    <div className="wf-trivial-hint" role="status" data-testid="wf-trivial-hint">
                      {t(
                        "workflowNodes.trivialGraphHint",
                        "This workflow only runs start → end. Add steps from the palette above to build it out.",
                      )}
                    </div>
                  )}
                  <WorkflowEditorCatalogContext.Provider value={catalogs}>
                  <ReactFlow
                    nodes={nodesForRender}
                    edges={edges}
                    nodeTypes={workflowNodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onWorkflowEdgesChange}
                    onConnect={onConnect}
                    onNodeDragStop={onNodeDragStop}
                    deleteKeyCode={isBuiltin ? null : ["Backspace", "Delete"]}
                    onBeforeDelete={onBeforeDelete}
                    onNodesDelete={onNodesDelete}
                    onEdgesDelete={onEdgesDelete}
                    onNodeClick={(_, node) => {
                      setSelectedNodeId(node.id);
                      setSelectedEdgeId(null);
                      setInspectorCollapsed(false);
                    }}
                    onEdgeClick={(_, edge) => {
                      setSelectedEdgeId(edge.id);
                      setSelectedNodeId(null);
                    }}
                    onPaneClick={() => {
                      setSelectedNodeId(null);
                      setSelectedEdgeId(null);
                    }}
                    defaultEdgeOptions={{ interactionWidth: WF_EDGE_INTERACTION_WIDTH }}
                    defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                  >
                    <Background />
                    <Controls />
                    <button
                      type="button"
                      className={`wf-minimap-toggle nodrag nopan${miniMapCollapsed ? " wf-minimap-toggle--collapsed" : ""}`}
                      aria-expanded={!miniMapCollapsed}
                      aria-controls="wf-workflow-minimap"
                      data-testid="wf-minimap-toggle"
                      onClick={() => setMiniMapCollapsed((collapsed) => !collapsed)}
                    >
                      {miniMapCollapsed ? <Maximize2 size={13} aria-hidden /> : <Minimize2 size={13} aria-hidden />}
                      <span>
                        {miniMapCollapsed
                          ? t("workflowNodes.showMiniMap", "Show mini map")
                          : t("workflowNodes.hideMiniMap", "Hide mini map")}
                      </span>
                    </button>
                    {!miniMapCollapsed && (
                      <MiniMap
                        id="wf-workflow-minimap"
                        pannable
                        zoomable
                        nodeColor={miniMapNodeColor}
                        nodeStrokeColor={miniMapNodeStrokeColor}
                        maskColor="color-mix(in srgb, var(--surface) 70%, transparent)"
                        bgColor="var(--surface)"
                      />
                    )}
                  </ReactFlow>
                  </WorkflowEditorCatalogContext.Provider>
                </div>
                )}
              </>
            ) : (
              <div className="wf-editor-empty wf-editor-canvas-empty wf-editor-onboard">
                <Workflow className="wf-editor-onboard-icon" size={40} aria-hidden />
                <h3 className="wf-editor-onboard-title">
                  {t("workflows.emptyTitle", "No workflow selected")}
                </h3>
                <p className="wf-editor-onboard-text">
                  {t(
                    "workflows.emptyDescription",
                    "Workflows orchestrate the steps and gates that run around task execution. Create one to start arranging that flow.",
                  )}
                </p>
                <button
                  className="wf-editor-save wf-editor-onboard-cta"
                  data-testid="wf-empty-create"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus size={14} /> {t("workflows.newWorkflow", "New workflow")}
                </button>
              </div>
            )}
          </section>

          {/* FNXC:WorkflowSimpleEditor 2026-06-29-23:21: Simple editor row and pencil affordances must open the same node details in desktop compact and mobile presentations. Do not suppress this inspector only because the canvas is hidden; mobile collapse still closes the detail stage and end nodes remain non-inspectable. */}
          {selectedNodeHasInspector &&
            !(isMobileMode && inspectorCollapsed) && (
            <aside
              className={`wf-editor-inspector${simpleViewEnabled ? " wf-editor-inspector--simple" : ""}`}
              data-testid="wf-node-inspector"
            >
              <div className="wf-inspector-heading">
                {/* FNXC:WorkflowEditor 2026-06-21-10:00: Heading shows the node-kind title (from the help registry) so the pane names what is selected, falling back to the generic "Node" label. */}
                <h3>{selectedNodeHelp?.title ?? t("workflowNodes.nodeInspector", "Node")}</h3>
                {isMobileMode && (
                  <button
                    type="button"
                    className="wf-inspector-toggle wf-inspector-toggle--expanded"
                    data-testid="wf-inspector-toggle"
                    aria-expanded="true"
                    onClick={() => {
                      if (simpleLayoutEnabled) {
                        setSelectedNodeId(null);
                      } else {
                        setInspectorCollapsed(true);
                      }
                    }}
                  >
                    <ChevronDown size={13} />
                    <span>{t("workflowNodes.collapseInspector", "Collapse")}</span>
                  </button>
                )}
              </div>
              {/* FNXC:WorkflowEditor 2026-06-21-10:00: Per-node Help — what the node does, how to configure it, and its inputs/outputs/edges. Collapsed by default so it never pushes config fields below the fold; remembered open/closed within the session is intentionally not persisted (cheap to reopen). Engine-managed graph-only nodes (merge gate, branch-group integration/promotion, PR/recovery nodes) get an "Engine-managed" badge since they are read-only. */}
              {selectedNodeHelp && (
                <details className="wf-inspector-help" data-testid="wf-node-help">
                  <summary className="wf-inspector-help-summary">
                    <HelpCircle size={13} aria-hidden />
                    <span>{t("workflowNodes.helpTitle", "What does this node do?")}</span>
                    {selectedNodeHelp.graphOnly && (
                      <span className="wf-inspector-help-badge" data-testid="wf-node-help-engine-managed">
                        {t("workflowNodes.helpEngineManaged", "Engine-managed")}
                      </span>
                    )}
                  </summary>
                  <div className="wf-inspector-help-body">
                    <p className="wf-inspector-help-summary-text">{selectedNodeHelp.summary}</p>
                    <dl className="wf-inspector-help-dl">
                      {selectedNodeHelp.configure && (
                        <>
                          <dt>{t("workflowNodes.helpConfigure", "Configure")}</dt>
                          <dd>{selectedNodeHelp.configure}</dd>
                        </>
                      )}
                      <dt>{t("workflowNodes.helpInputs", "Inputs")}</dt>
                      <dd>{selectedNodeHelp.inputs}</dd>
                      <dt>{t("workflowNodes.helpOutputs", "Outputs")}</dt>
                      <dd>{selectedNodeHelp.outputs}</dd>
                      <dt>{t("workflowNodes.helpEdges", "Edges")}</dt>
                      <dd>{selectedNodeHelp.edges}</dd>
                    </dl>
                  </div>
                </details>
              )}
              {isBuiltin && (
                <p className="wf-inspector-note wf-inspector-note--info wf-inspector-note--with-icon">
                  <WorkflowIcon workflowId={activeWorkflow.id} decorative />
                  <span>{t("workflowNodes.readOnlyDuplicateToEdit", "Workflow structure is read-only — prompts on prompt and gate nodes can be edited here.")}</span>
                </p>
              )}
              <fieldset className="wf-inspector-fields" disabled={isBuiltin}>
              {/* FNXC:WorkflowEditor 2026-06-17-00:20: Start labels are structural and ignored by flowToIr, so exposing the generic Name editor would create a no-op rename. */}
              {selectedNode.data.kind !== "start" && (
                <label className="wf-field">
                  <span>{t("common:labels.name", "Name")}</span>
                  <input
                    value={selectedNode.data.label}
                    onChange={(e) => updateSelectedData({ label: e.target.value })}
                  />
                </label>
              )}
              {selectedNode.data.kind === "start" && (
                <div data-testid="wf-start-inspector">
                  {/* FNXC:WorkflowEditor 2026-06-17-00:20: The start node's entry column persists as node.column in v2 IR and determines the board column a task enters. Only render the selector when columns exist so v1 workflows keep a meaningful note without an empty control. */}
                  <p className="wf-inspector-note wf-inspector-note--info">
                    {t(
                      "workflowNodes.startNote",
                      "The start node marks where a task enters the workflow.",
                    )}
                  </p>
                  {columns.length > 0 && (
                    <label className="wf-field">
                      <span>{t("workflowNodes.startEntryColumn", "Entry column")}</span>
                      <select
                        data-testid="wf-start-entry-column"
                        value={String(selectedNode.data.column ?? "")}
                        onChange={(e) => updateSelectedData({ column: e.target.value || undefined })}
                      >
                        <option value="">
                          {t("workflowNodes.startEntryColumnAuto", "— Auto (first column)")}
                        </option>
                        {columns.map((col) => (
                          <option key={col.id} value={col.id}>
                            {col.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              </fieldset>

              {selectedNode.data.kind === "prompt" || selectedNode.data.kind === "gate" ? (
                <div className="wf-prompt-editor">
                  <label className="wf-field">
                    <span>{t("workflowEditor.prompt", "Prompt")}</span>
                    <textarea
                      rows={5}
                      value={selectedNodePromptValue}
                      readOnly={!selectedNodePromptEditable}
                      onChange={(e) => handlePromptTextChange(e.target.value)}
                      onBlur={handlePromptTextBlur}
                    />
                  </label>
                  <div className="wf-prompt-override-actions">
                    {isBuiltin && selectedPromptIsOverridden ? (
                      <span className="wf-prompt-override-badge" data-testid="wf-prompt-overridden">
                        {t("workflowEditor.promptOverridden", "Overridden")}
                      </span>
                    ) : null}
                    {isBuiltin ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handlePromptResetClick}
                        disabled={!selectedPromptHasOverride || selectedPromptOverrideSaving}
                      >
                        {selectedPromptOverrideSaving
                          ? t("workflowEditor.promptSaving", "Saving…")
                          : t("workflowEditor.resetPromptDefault", "Reset to default")}
                      </button>
                    ) : null}
                  </div>
                  {/* Expand button is outside <fieldset disabled={isBuiltin}> so it remains
                      clickable for builtin workflows. Root cause: HTML spec disables all
                      descendant buttons inside a disabled fieldset, including type="button". */}
                  <button
                    type="button"
                    className="btn btn-sm wf-prompt-expand-btn wf-prompt-expand-btn--inline"
                    onClick={handleTogglePromptExpand}
                    aria-label={t("workflowEditor.expandPrompt", "Expand prompt editor")}
                    title={t("workflowEditor.expandPrompt", "Expand prompt editor")}
                  >
                    <Maximize2 size={14} />
                  </button>
                </div>
              ) : null}

              <fieldset className="wf-inspector-fields" disabled={isBuiltin}>
              {selectedNode.data.kind === "prompt" ? (
                <>
                  <label className="wf-field">
                    <span>{t("workflowEditor.executor", "Executor")}</span>
                    <select
                      value={currentExecutor}
                      onChange={(e) => updateSelectedData({ config: { executor: e.target.value } })}
                    >
                      <option value="model">{t("workflowEditor.model", "Model")}</option>
                      <option value="agent">{t("workflowEditor.agent", "Agent")}</option>
                      <option value="skill">{t("workflowEditor.skill", "Skill")}</option>
                      <option value="cli">{t("workflowEditor.cliScript", "CLI / script")}</option>
                      <option value="cli-agent">{t("workflowEditor.cliAgent.executorOption")}</option>
                    </select>
                  </label>

                  {overrideColumnBinding && (
                    <p className="wf-inspector-note wf-inspector-note--warn" data-testid="wf-node-overridden-by-column-agent">
                      {t(
                        "workflowColumns.overriddenByColumnAgent",
                        "Overridden by column agent {{name}} — this node's executor settings are superseded.",
                        {
                          name: overrideAgent?.name
                            ?? t("workflowColumns.agentNotFound", "Agent not found — {{id}}", { id: overrideColumnBinding.agentId }),
                        },
                      )}
                    </p>
                  )}

                  {currentExecutor === "model" && (
                    <label className="wf-field">
                      <span>{t("workflowEditor.model", "Model")}</span>
                      <CustomModelDropdown
                        label={t("workflowEditor.model", "Model")}
                        models={models}
                        value={getModelDropdownValue(
                          String(selectedNode.data.config?.modelProvider ?? ""),
                          String(selectedNode.data.config?.modelId ?? ""),
                        )}
                        onChange={(value) => {
                          const { provider, modelId } = parseModelDropdownValue(value);
                          updateSelectedData({ config: { modelProvider: provider || undefined, modelId: modelId || undefined } });
                        }}
                        /*
                         * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
                         * Prompt model nodes expose the shared inline thinking selector only for the model executor, persisting `config.thinkingLevel` with Default clearing the key.
                         */
                        showThinkingLevel
                        thinkingLevel={String(selectedNode.data.config?.thinkingLevel ?? "")}
                        onThinkingLevelChange={(value) => updateSelectedData({ config: { thinkingLevel: value || undefined } })}
                        defaultThinkingLevel={projectDefaultThinkingLevel ?? "off"}
                      />
                    </label>
                  )}

                  {currentExecutor === "agent" && (() => {
                    const nodeAgentId = String(selectedNode.data.config?.agentId ?? "");
                    // A stored id absent from the loaded registry would render the
                    // select blank; instead surface a not-found option that
                    // preserves the IR value until the author clears/replaces it.
                    const nodeAgentStale = nodeAgentId !== "" && !agents.some((a) => a.id === nodeAgentId);
                    return (
                      <label className="wf-field">
                        <span>{t("workflowEditor.agent", "Agent")}</span>
                        <select
                          value={nodeAgentId}
                          onChange={(e) => updateSelectedData({ config: { agentId: e.target.value || undefined } })}
                        >
                          <option value="">{t("workflowEditor.selectAgent", "— select agent —")}</option>
                          {nodeAgentStale && (
                            <option value={nodeAgentId}>
                              {t("workflowColumns.agentNotFound", "Agent not found — {{id}}", { id: nodeAgentId })}
                            </option>
                          )}
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
                        {nodeAgentStale && (
                          <p className="wf-inspector-note wf-inspector-note--warn" data-testid="wf-node-agent-stale">
                            {t("workflowColumns.agentNotFound", "Agent not found — {{id}}", { id: nodeAgentId })}
                          </p>
                        )}
                      </label>
                    );
                  })()}

                  {currentExecutor === "skill" && (() => {
                    // The stored skillName may be namespaced (e.g.
                    // "compound-engineering:ce-work") while the <option> values are
                    // the catalog's two-segment names ("ce-work/SKILL.md"). Resolve
                    // through bareSkillName so the matching option shows as selected
                    // instead of falling back to "— select skill —".
                    const rawSkill = String(selectedNode.data.config?.skillName ?? "");
                    const matchedSkill = rawSkill
                      ? skills.find((s) => bareSkillName(s.name) === bareSkillName(rawSkill))
                      : undefined;
                    const selectedSkillValue = matchedSkill ? matchedSkill.name : rawSkill;
                    return (
                      <label className="wf-field">
                        <span>{t("workflowEditor.skill", "Skill")}</span>
                        <select
                          value={selectedSkillValue}
                          onChange={(e) => updateSelectedData({ config: { skillName: e.target.value || undefined } })}
                        >
                          <option value="">{t("workflowEditor.selectSkill", "— select skill —")}</option>
                          {skills.map((s) => (
                            <option key={s.id} value={s.name}>{s.name}</option>
                          ))}
                        </select>
                      </label>
                    );
                  })()}

                  {currentExecutor === "cli" && (
                    <>
                      <label className="wf-field">
                        <span>{t("workflowEditor.cliMode", "CLI mode")}</span>
                        <select
                          value={String(selectedNode.data.config?.cliMode ?? "command")}
                          onChange={(e) => updateSelectedData({ config: { cliMode: e.target.value } })}
                        >
                          <option value="command">{t("workflowEditor.command", "Command")}</option>
                          <option value="script">{t("workflowEditor.namedScript", "Named script")}</option>
                        </select>
                      </label>
                      {(selectedNode.data.config?.cliMode ?? "command") === "command" ? (
                        <label className="wf-field">
                          <span>{t("workflowEditor.command", "Command")}</span>
                          <textarea
                            rows={3}
                            placeholder={WORKFLOW_CLI_COMMAND_PLACEHOLDER}
                            value={String(selectedNode.data.config?.cliCommand ?? "")}
                            onChange={(e) => updateSelectedData({ config: { cliCommand: e.target.value } })}
                          />
                          <p className="wf-inspector-note wf-inspector-note--info">
                            {t("workflowEditor.cliCommandNote", "Runs an arbitrary command in the task worktree. The first time this exact command runs, the task pauses for your approval. The node prompt is passed via FUSION_NODE_PROMPT.")}
                          </p>
                          <label className="wf-field wf-field--checkbox">
                            <input
                              type="checkbox"
                              checked={selectedNode.data.config?.cliSkipApproval === true}
                              onChange={(e) => updateSelectedData({ config: { cliSkipApproval: e.target.checked } })}
                            />
                            <span>{t("workflowEditor.skipFirstRunApproval", "Skip first-run approval (runs without pausing)")}</span>
                          </label>
                        </label>
                      ) : (
                        <label className="wf-field">
                          <span>{t("workflowEditor.scriptName", "Script name")}</span>
                          <input
                            value={String(selectedNode.data.config?.scriptName ?? "")}
                            onChange={(e) => updateSelectedData({ config: { scriptName: e.target.value } })}
                          />
                          <span className="wf-inspector-note">{t("workflowEditor.namedScriptNote", "Named script from project settings. The node prompt is passed via FUSION_NODE_PROMPT.")}</span>
                        </label>
                      )}
                    </>
                  )}

                  {currentExecutor === "cli-agent" && (
                    <div data-testid="cli-agent-config">
                      <label className="wf-field">
                        <span>{t("workflowEditor.cliAgent.adapterLabel")}</span>
                        <select
                          data-testid="cli-agent-adapter"
                          value={String(selectedNode.data.config?.cliAdapterId ?? "")}
                          onChange={(e) =>
                            updateSelectedData({ config: { cliAdapterId: e.target.value || undefined } })
                          }
                        >
                          <option value="">{t("workflowEditor.cliAgent.adapterPlaceholder")}</option>
                          {cliAdapters.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({t(`workflowEditor.cliAgent.tier.${a.tier}`)})
                            </option>
                          ))}
                        </select>
                        <span className="wf-inspector-note">
                          {t("workflowEditor.cliAgent.adapterNote")}
                        </span>
                      </label>

                      <label className="wf-field wf-field--checkbox">
                        <input
                          type="checkbox"
                          data-testid="cli-agent-autonomy"
                          checked={Boolean(
                            (selectedNode.data.config?.cliAutonomy as { autoApprove?: boolean } | undefined)
                              ?.autoApprove,
                          )}
                          onChange={(e) =>
                            updateSelectedData({
                              config: {
                                cliAutonomy: {
                                  ...((selectedNode.data.config?.cliAutonomy as Record<string, unknown>) ?? {}),
                                  autoApprove: e.target.checked,
                                },
                              },
                            })
                          }
                        />
                        <span>{t("workflowEditor.cliAgent.autonomyLabel")}</span>
                      </label>
                      {Boolean(
                        (selectedNode.data.config?.cliAutonomy as { autoApprove?: boolean } | undefined)
                          ?.autoApprove,
                      ) && (
                        <p className="wf-inspector-note wf-inspector-note--info">
                          {t("workflowEditor.cliAgent.autonomyNote")}
                        </p>
                      )}

                      <label className="wf-field">
                        <span>{t("workflowEditor.cliAgent.notifyLabel")}</span>
                        <select
                          data-testid="cli-agent-notify"
                          value={String(
                            (selectedNode.data.config?.cliNotify as { mode?: string } | undefined)?.mode ??
                              "banner",
                          )}
                          onChange={(e) =>
                            updateSelectedData({ config: { cliNotify: { mode: e.target.value } } })
                          }
                        >
                          <option value="banner">{t("workflowEditor.cliAgent.notify.banner")}</option>
                          <option value="banner+notify">
                            {t("workflowEditor.cliAgent.notify.bannerNotify")}
                          </option>
                        </select>
                        <span className="wf-inspector-note">
                          {t("workflowEditor.cliAgent.notifyNote")}
                        </span>
                      </label>
                    </div>
                  )}

                  <label className="wf-field wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config?.autoApprove)}
                      onChange={(e) => updateSelectedData({ config: { autoApprove: e.target.checked } })}
                    />
                    <span>{t("workflowEditor.autoApproveRequests", "Auto-approve requests")}</span>
                  </label>
                  {Boolean(selectedNode.data.config?.autoApprove) && (
                    <p className="wf-inspector-note">
                      {t("workflowEditor.autoApproveRequestsNote", "Runs without pausing for approval — e.g. a CLI command executes on its first run without waiting for your sign-off.")}
                    </p>
                  )}

                  <label className="wf-field">
                    <span>{t("workflowEditor.maxRetries", "Max retries")}</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      placeholder="default"
                      value={selectedNode.data.config?.maxRetries != null ? String(selectedNode.data.config.maxRetries) : ""}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "") {
                          updateSelectedData({
                            config: (prev) => {
                              const next = { ...prev };
                              delete next.maxRetries;
                              return next;
                            },
                          });
                        } else {
                          const num = parseInt(val, 10);
                          if (!isNaN(num)) updateSelectedData({ config: { maxRetries: num } });
                        }
                      }}
                    />
                  </label>

                  <label className="wf-field wf-field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config?.awaitInput)}
                      onChange={(e) => updateSelectedData({ config: { awaitInput: e.target.checked } })}
                    />
                    <span>{t("workflowEditor.waitForUserInput", "Wait for user input")}</span>
                  </label>
                  {Boolean(selectedNode.data.config?.awaitInput) && (
                    <p className="wf-inspector-note wf-inspector-note--info">
                      {t("workflowEditor.waitForUserInputNote", "This node pauses the task until you reply in the task's comments and unpause. The Prompt field above is shown to the user as the question.")}
                    </p>
                  )}
                </>
              ) : null}

              {selectedNode.data.kind === "script" ? (
                <label className="wf-field">
                  <span>{t("workflowEditor.scriptName", "Script name")}</span>
                  <input
                    value={String(selectedNode.data.config?.scriptName ?? "")}
                    onChange={(e) => updateSelectedData({ config: { scriptName: e.target.value } })}
                  />
                </label>
              ) : null}

              {selectedNode.data.kind === "hold" ? (
                <label className="wf-field">
                  <span>{t("workflowNodes.releaseCondition", "Release condition")}</span>
                  <select
                    value={String(selectedNode.data.config?.release ?? "manual")}
                    onChange={(e) => updateSelectedData({ config: { release: e.target.value } })}
                  >
                    <option value="manual">{t("workflowNodes.releaseManual", "Manual promote")}</option>
                    <option value="timer">{t("workflowNodes.releaseTimer", "Timer")}</option>
                    <option value="capacity">{t("workflowNodes.releaseCapacity", "Downstream capacity")}</option>
                    <option value="dependency">{t("workflowNodes.releaseDependency", "Dependency complete")}</option>
                    <option value="external-event">{t("workflowNodes.releaseExternal", "External event")}</option>
                  </select>
                </label>
              ) : null}

              {selectedNode.data.kind === "join" ? (
                <>
                  <label className="wf-field">
                    <span>{t("workflowNodes.joinMode", "Join mode")}</span>
                    <select
                      value={(() => {
                        const m = selectedNode.data.config?.mode as unknown;
                        if (m && typeof m === "object" && "quorum" in (m as object)) return "quorum";
                        return typeof m === "string" ? m : "all";
                      })()}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "quorum") {
                          updateSelectedData({ config: { mode: { quorum: 2 } } });
                        } else {
                          updateSelectedData({ config: { mode: v } });
                        }
                      }}
                    >
                      <option value="all">{t("workflowNodes.joinAll", "All branches")}</option>
                      <option value="any">{t("workflowNodes.joinAny", "Any branch")}</option>
                      <option value="quorum">{t("workflowNodes.joinQuorum", "Quorum (n)")}</option>
                    </select>
                  </label>
                  {(() => {
                    const m = selectedNode.data.config?.mode as unknown;
                    return m && typeof m === "object" && "quorum" in (m as object);
                  })() && (
                    <label className="wf-field">
                      <span>{t("workflowNodes.quorumN", "Quorum count (n)")}</span>
                      <input
                        type="number"
                        min={1}
                        value={String((selectedNode.data.config?.mode as { quorum?: number })?.quorum ?? 2)}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (!isNaN(n)) updateSelectedData({ config: { mode: { quorum: n } } });
                        }}
                      />
                    </label>
                  )}
                  <label className="wf-field">
                    <span>{t("workflowNodes.failurePolicy", "On branch failure")}</span>
                    <select
                      value={String(selectedNode.data.config?.onBranchFailure ?? "collect")}
                      onChange={(e) => updateSelectedData({ config: { onBranchFailure: e.target.value } })}
                    >
                      <option value="collect">{t("workflowNodes.failureCollect", "Collect (wait for all)")}</option>
                      <option value="fail-fast">{t("workflowNodes.failureFailFast", "Fail-fast (cancel siblings)")}</option>
                    </select>
                  </label>
                </>
              ) : null}

              {selectedNode.data.kind === "split" ? (
                <p className="wf-inspector-note wf-inspector-note--info">
                  {t(
                    "workflowNodes.splitNote",
                    "Branches run concurrently from this node. Execute and merge seams are not allowed inside a branch.",
                  )}
                </p>
              ) : null}

              {selectedNode.data.kind === "foreach" ? (
                (() => {
                  const mode = String(selectedNode.data.config?.mode ?? "sequential");
                  const isParallel = mode === "parallel";
                  return (
                    <>
                      <label className="wf-field">
                        <span>{t("workflowNodes.foreachMode", "Mode")}</span>
                        <select
                          value={mode}
                          onChange={(e) => {
                            const v = e.target.value;
                            // parallel+shared is rejected by the validator; flip
                            // isolation to worktree when switching to parallel.
                            updateSelectedData({
                              config: (prev) => ({
                                ...prev,
                                mode: v,
                                ...(v === "parallel" && prev.isolation === "shared"
                                  ? { isolation: "worktree" }
                                  : {}),
                              }),
                            });
                          }}
                        >
                          <option value="sequential">{t("workflowNodes.foreachSequential", "Sequential")}</option>
                          <option value="parallel">{t("workflowNodes.foreachParallel", "Parallel")}</option>
                        </select>
                      </label>

                      <label className="wf-field">
                        <span>{t("workflowNodes.foreachIsolation", "Isolation")}</span>
                        <select
                          value={String(
                            selectedNode.data.config?.isolation ?? (isParallel ? "worktree" : "shared"),
                          )}
                          onChange={(e) => updateSelectedData({ config: { isolation: e.target.value } })}
                        >
                          <option value="shared" disabled={isParallel}>
                            {t("workflowNodes.foreachShared", "Shared worktree")}
                          </option>
                          <option value="worktree">{t("workflowNodes.foreachWorktree", "Per-step worktree")}</option>
                        </select>
                      </label>

                      {isParallel && (
                        <label className="wf-field">
                          <span>{t("workflowNodes.foreachConcurrency", "Concurrency")}</span>
                          <input
                            type="number"
                            min={1}
                            max={8}
                            placeholder="2"
                            value={
                              selectedNode.data.config?.concurrency != null
                                ? String(selectedNode.data.config.concurrency)
                                : ""
                            }
                            onChange={(e) => {
                              const val = e.target.value.trim();
                              if (val === "") {
                                updateSelectedData({
                                  config: (prev) => {
                                    const next = { ...prev };
                                    delete next.concurrency;
                                    return next;
                                  },
                                });
                              } else {
                                const num = parseInt(val, 10);
                                if (!isNaN(num)) updateSelectedData({ config: { concurrency: num } });
                              }
                            }}
                          />
                        </label>
                      )}

                      <label className="wf-field">
                        <span>{t("workflowNodes.foreachMaxRework", "Max rework cycles")}</span>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          placeholder="3"
                          value={
                            selectedNode.data.config?.maxReworkCycles != null
                              ? String(selectedNode.data.config.maxReworkCycles)
                              : ""
                          }
                          onChange={(e) => {
                            const val = e.target.value.trim();
                            if (val === "") {
                              updateSelectedData({
                                config: (prev) => {
                                  const next = { ...prev };
                                  delete next.maxReworkCycles;
                                  return next;
                                },
                              });
                            } else {
                              const num = parseInt(val, 10);
                              if (!isNaN(num)) updateSelectedData({ config: { maxReworkCycles: num } });
                            }
                          }}
                        />
                      </label>
                      <p className="wf-inspector-note wf-inspector-note--info">
                        {t(
                          "workflowNodes.foreachNote",
                          "Expands once per planned step. Drop a step-execute node (and optional step-review) into the region.",
                        )}
                      </p>
                    </>
                  );
                })()
              ) : null}

              {selectedNode.data.kind === "loop" ? (
                (() => {
                  const exitWhen =
                    selectedNode.data.config?.exitWhen &&
                    typeof selectedNode.data.config.exitWhen === "object"
                      ? (selectedNode.data.config.exitWhen as Record<string, unknown>)
                      : { type: "output-contains", value: "DONE" };
                  const exitType = String(exitWhen.type ?? "output-contains");
                  const exitText =
                    exitType === "output-matches"
                      ? String(exitWhen.pattern ?? "")
                      : String(exitWhen.value ?? "");
                  return (
                    <>
                      <label className="wf-field">
                        <span>{t("workflowNodes.loopExitType", "Exit condition")}</span>
                        <select
                          value={exitType}
                          onChange={(e) => {
                            const nextType = e.target.value;
                            updateSelectedData({
                              config: (prev) => {
                                const current =
                                  prev.exitWhen && typeof prev.exitWhen === "object"
                                    ? (prev.exitWhen as Record<string, unknown>)
                                    : {};
                                const text =
                                  nextType === "output-matches"
                                    ? String(current.pattern ?? current.value ?? "")
                                    : String(current.value ?? current.pattern ?? "");
                                const nextExitWhen: Record<string, unknown> = {
                                  ...current,
                                  type: nextType,
                                };
                                delete nextExitWhen.pattern;
                                delete nextExitWhen.value;
                                return {
                                  ...prev,
                                  exitWhen:
                                    nextType === "output-matches"
                                      ? { ...nextExitWhen, pattern: text }
                                      : { ...nextExitWhen, value: text },
                                };
                              },
                            });
                          }}
                        >
                          <option value="output-contains">
                            {t("workflowNodes.loopOutputContains", "Output contains")}
                          </option>
                          <option value="output-matches">
                            {t("workflowNodes.loopOutputMatches", "Output matches regex")}
                          </option>
                        </select>
                      </label>

                      <label className="wf-field">
                        <span>
                          {exitType === "output-matches"
                            ? t("workflowNodes.loopPattern", "Pattern")
                            : t("workflowNodes.loopValue", "Value")}
                        </span>
                        <input
                          value={exitText}
                          placeholder={exitType === "output-matches" ? "DONE|COMPLETE" : "DONE"}
                          onChange={(e) => {
                            const value = e.target.value;
                            updateSelectedData({
                              config: (prev) => {
                                const current =
                                  prev.exitWhen && typeof prev.exitWhen === "object"
                                    ? (prev.exitWhen as Record<string, unknown>)
                                    : {};
                                return {
                                  ...prev,
                                  exitWhen:
                                    exitType === "output-matches"
                                      ? { ...current, type: exitType, pattern: value }
                                      : { ...current, type: exitType, value },
                                };
                              },
                            });
                          }}
                        />
                      </label>

                      <label className="wf-field">
                        <span>{t("workflowNodes.loopNodeId", "Watch node id (optional)")}</span>
                        <input
                          value={String(exitWhen.nodeId ?? "")}
                          placeholder={t("workflowNodes.loopNodeIdPlaceholder", "Template exit node")}
                          onChange={(e) => {
                            const nodeId = e.target.value.trim();
                            updateSelectedData({
                              config: (prev) => {
                                const current =
                                  prev.exitWhen && typeof prev.exitWhen === "object"
                                    ? (prev.exitWhen as Record<string, unknown>)
                                    : { type: "output-contains", value: "DONE" };
                                const next = { ...current };
                                if (nodeId) next.nodeId = nodeId;
                                else delete next.nodeId;
                                return { ...prev, exitWhen: next };
                              },
                            });
                          }}
                        />
                      </label>

                      <label className="wf-field">
                        <span>{t("workflowNodes.loopMaxIterations", "Max iterations")}</span>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          placeholder="3"
                          value={
                            selectedNode.data.config?.maxIterations != null
                              ? String(selectedNode.data.config.maxIterations)
                              : ""
                          }
                          onChange={(e) => {
                            const val = e.target.value.trim();
                            updateSelectedData({
                              config: (prev) => {
                                const next = { ...prev };
                                if (val === "") delete next.maxIterations;
                                else {
                                  const num = parseInt(val, 10);
                                  if (!isNaN(num)) next.maxIterations = num;
                                }
                                return next;
                              },
                            });
                          }}
                        />
                      </label>

                      <label className="wf-field">
                        <span>{t("workflowNodes.loopTimeoutMs", "Timeout (ms)")}</span>
                        <input
                          type="number"
                          min={1}
                          max={3600000}
                          placeholder="300000"
                          value={
                            selectedNode.data.config?.timeoutMs != null
                              ? String(selectedNode.data.config.timeoutMs)
                              : ""
                          }
                          onChange={(e) => {
                            const val = e.target.value.trim();
                            updateSelectedData({
                              config: (prev) => {
                                const next = { ...prev };
                                if (val === "") delete next.timeoutMs;
                                else {
                                  const num = parseInt(val, 10);
                                  if (!isNaN(num)) next.timeoutMs = num;
                                }
                                return next;
                              },
                            });
                          }}
                        />
                      </label>

                      <p className="wf-inspector-note wf-inspector-note--info">
                        {t(
                          "workflowNodes.loopNote",
                          "Repeats the template until the selected output matches, an iteration limit is reached, or the timeout expires.",
                        )}
                      </p>
                    </>
                  );
                })()
              ) : null}

              {/* FNXC:WorkflowOptionalGroup 2026-06-21-11:30: The optional-group inspector exposes the workflow-author `defaultOn` default (whether new tasks enable the group). The group name reuses the shared Name field above; the body is authored by dropping nodes inside, identical to foreach/loop. */}
              {selectedNode.data.kind === "optional-group" ? (
                (() => {
                  const maxRevisions = selectedNode.data.config?.maxRevisions;
                  const isUnbounded = maxRevisions === "unbounded";
                  return (
                    <>
                      <label className="wf-field wf-field--checkbox">
                        <input
                          type="checkbox"
                          data-testid="wf-optional-group-default-on"
                          checked={Boolean(selectedNode.data.config?.defaultOn)}
                          onChange={(e) => updateSelectedData({ config: { defaultOn: e.target.checked } })}
                        />
                        <span>{t("workflowNodes.optionalGroupDefaultOn", "Enabled by default for new tasks")}</span>
                      </label>

                      {/* FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:47: Optional-group authors need a per-step revision budget control that round-trips as `config.maxRevisions`; clearing deletes the key so existing workflows keep the global `maxPostReviewFixes` fallback, while Unbounded disables the numeric input and persists the explicit `"unbounded"` mode. */}
                      <label className="wf-field">
                        <span>{t("workflowNodes.optionalGroupMaxRevisions", "Max revisions")}</span>
                        <input
                          type="number"
                          min={0}
                          placeholder={t("workflowNodes.optionalGroupMaxRevisionsPlaceholder", "Use global setting")}
                          data-testid="wf-optional-group-max-revisions"
                          disabled={isUnbounded}
                          value={typeof maxRevisions === "number" ? String(maxRevisions) : ""}
                          onChange={(e) => {
                            const val = e.target.value.trim();
                            updateSelectedData({
                              config: (prev) => {
                                const next = { ...prev };
                                if (val === "") delete next.maxRevisions;
                                else {
                                  const num = parseInt(val, 10);
                                  if (!isNaN(num) && num >= 0) next.maxRevisions = num;
                                }
                                return next;
                              },
                            });
                          }}
                        />
                      </label>

                      <label className="wf-field wf-field--checkbox">
                        <input
                          type="checkbox"
                          data-testid="wf-optional-group-max-revisions-unbounded"
                          checked={isUnbounded}
                          onChange={(e) => {
                            updateSelectedData({
                              config: (prev) => {
                                const next = { ...prev };
                                if (e.target.checked) next.maxRevisions = "unbounded";
                                else if (next.maxRevisions === "unbounded") delete next.maxRevisions;
                                return next;
                              },
                            });
                          }}
                        />
                        <span>{t("workflowNodes.optionalGroupMaxRevisionsUnbounded", "Unbounded")}</span>
                      </label>

                      <p className="wf-inspector-note wf-inspector-note--info">
                        {t(
                          "workflowNodes.optionalGroupNote",
                          "Runs the steps inside this group once when the task enables it (seeded from this default), and skips them when disabled. Drop the optional steps into the region.",
                        )}
                      </p>
                    </>
                  );
                })()
              ) : null}

              {selectedNode.data.kind === "step-review" ? (
                <>
                  <label className="wf-field">
                    <span>{t("workflowNodes.reviewType", "Review type")}</span>
                    <select
                      value={String(selectedNode.data.config?.type ?? "code")}
                      onChange={(e) => updateSelectedData({ config: { type: e.target.value } })}
                    >
                      <option value="plan">{t("workflowNodes.reviewPlan", "Plan review")}</option>
                      <option value="code">{t("workflowNodes.reviewCode", "Code review")}</option>
                    </select>
                  </label>
                  <label className="wf-field">
                    <span>{t("workflowNodes.reviewModel", "Review model (optional)")}</span>
                    <CustomModelDropdown
                      label={t("workflowNodes.reviewModel", "Review model (optional)")}
                      models={models}
                      value={getModelDropdownValue(
                        String(selectedNode.data.config?.modelProvider ?? ""),
                        String(selectedNode.data.config?.modelId ?? ""),
                      )}
                      onChange={(value) => {
                        const { provider, modelId } = parseModelDropdownValue(value);
                        updateSelectedData({
                          config: {
                            modelProvider: provider || undefined,
                            modelId: modelId || undefined,
                            model: value || undefined,
                          },
                        });
                      }}
                      /*
                       * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
                       * Step-review nodes share the model dropdown thinking selector so review sessions can pin reasoning effort with the same node > task > settings precedence as executor steps.
                       */
                      showThinkingLevel
                      thinkingLevel={String(selectedNode.data.config?.thinkingLevel ?? "")}
                      onThinkingLevelChange={(value) => updateSelectedData({ config: { thinkingLevel: value || undefined } })}
                      defaultThinkingLevel={projectDefaultThinkingLevel ?? "off"}
                    />
                  </label>
                  <p className="wf-inspector-note wf-inspector-note--info">
                    {t(
                      "workflowNodes.reviewNote",
                      "Verdicts route as outcome edges. Click an outgoing edge to set its verdict and rework behavior.",
                    )}
                  </p>
                </>
              ) : null}

              {selectedNode.data.kind === "parse-steps" ? (
                <>
                  {declaredArtifacts.length > 0 ? (
                    <label className="wf-field">
                      <span>{t("workflowNodes.parseArtifact", "Artifact")}</span>
                      <select
                        value={String(selectedNode.data.config?.artifact ?? declaredArtifacts[0])}
                        onChange={(e) => updateSelectedData({ config: { artifact: e.target.value } })}
                      >
                        {declaredArtifacts.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="wf-field">
                      <span>{t("workflowNodes.parseArtifact", "Artifact")}</span>
                      <input
                        placeholder="PROMPT.md"
                        value={String(selectedNode.data.config?.artifact ?? "PROMPT.md")}
                        onChange={(e) => updateSelectedData({ config: { artifact: e.target.value } })}
                      />
                    </label>
                  )}
                  <label className="wf-field">
                    <span>{t("workflowNodes.parseParser", "Parser")}</span>
                    {/* Sourced from the live parser registry via GET /api/step-parsers
                        (built-ins + plugin parsers), with a built-in fallback. The
                        node's current parser is always included so a plugin parser
                        the catalog missed never silently drops out of the select. */}
                    <select
                      value={String(selectedNode.data.config?.parser ?? "step-headings")}
                      onChange={(e) => updateSelectedData({ config: { parser: e.target.value } })}
                    >
                      {Array.from(
                        new Set([String(selectedNode.data.config?.parser ?? "step-headings"), ...stepParsers]),
                      ).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}

              {selectedNode.data.kind === "code" ? (
                <>
                  <label className="wf-field">
                    <span>{t("workflowNodes.codeSource", "Source (TypeScript)")}</span>
                    <textarea
                      className="wf-code-source"
                      rows={8}
                      spellCheck={false}
                      placeholder={WORKFLOW_CODE_SOURCE_PLACEHOLDER}
                      value={String(selectedNode.data.config?.source ?? "")}
                      onChange={(e) => updateSelectedData({ config: { source: e.target.value } })}
                    />
                  </label>
                  <label className="wf-field">
                    <span>{t("workflowNodes.codeTimeout", "Timeout (ms)")}</span>
                    <input
                      type="number"
                      min={1}
                      placeholder="30000"
                      value={
                        selectedNode.data.config?.timeoutMs != null
                          ? String(selectedNode.data.config.timeoutMs)
                          : ""
                      }
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        if (val === "") {
                          updateSelectedData({
                            config: (prev) => {
                              const next = { ...prev };
                              delete next.timeoutMs;
                              return next;
                            },
                          });
                        } else {
                          const num = parseInt(val, 10);
                          if (!isNaN(num)) updateSelectedData({ config: { timeoutMs: num } });
                        }
                      }}
                    />
                  </label>
                  <p className="wf-inspector-note wf-inspector-note--info">
                    {t(
                      "workflowNodes.codeNote",
                      "Runs sandboxed TypeScript. Syntax is validated at save.",
                    )}
                  </p>
                </>
              ) : null}

              {selectedNode.data.kind === "notify" ? (
                (() => {
                  const eventValue = String(selectedNode.data.config?.event ?? "workflow-notify");
                  const isCustom = !NOTIFY_EVENT_OPTIONS.includes(eventValue as typeof NOTIFY_EVENT_OPTIONS[number]);
                  return (
                    <>
                      <label className="wf-field">
                        <span>{t("workflowNodes.notifyEvent", "Event type")}</span>
                        <select
                          value={isCustom ? NOTIFY_CUSTOM_EVENT_VALUE : eventValue}
                          onChange={(e) => {
                            const value = e.target.value;
                            updateSelectedData({
                              config: {
                                event: value === NOTIFY_CUSTOM_EVENT_VALUE ? "custom-event" : value,
                              },
                            });
                          }}
                        >
                          {NOTIFY_EVENT_OPTIONS.map((event) => (
                            <option key={event} value={event}>{event}</option>
                          ))}
                          <option value={NOTIFY_CUSTOM_EVENT_VALUE}>{t("workflowNodes.notifyCustom", "Custom")}</option>
                        </select>
                      </label>
                      {isCustom ? (
                        <label className="wf-field">
                          <span>{t("workflowNodes.notifyCustomEvent", "Custom event")}</span>
                          <input
                            value={eventValue}
                            placeholder="custom-event"
                            onChange={(e) => updateSelectedData({ config: { event: e.target.value } })}
                          />
                        </label>
                      ) : null}
                      <label className="wf-field">
                        <span>{t("workflowNodes.notifyTitle", "Title (optional)")}</span>
                        <input
                          value={String(selectedNode.data.config?.title ?? "{{taskTitle}}")}
                          placeholder="{{taskTitle}}"
                          onChange={(e) => updateSelectedData({ config: { title: e.target.value } })}
                        />
                      </label>
                      <label className="wf-field">
                        <span>{t("workflowNodes.notifyMessage", "Message (optional)")}</span>
                        <textarea
                          rows={4}
                          value={String(selectedNode.data.config?.message ?? "")}
                          placeholder={WORKFLOW_NOTIFY_MESSAGE_PLACEHOLDER}
                          onChange={(e) => updateSelectedData({ config: { message: e.target.value } })}
                        />
                      </label>
                      <p className="wf-inspector-note wf-inspector-note--info">
                        {t(
                          "workflowNodes.notifyNote",
                          "Templates may use {{taskTitle}}, {{taskId}}, {{workflowName}}, and {{context:key}}.",
                        )}
                      </p>
                    </>
                  );
                })()
              ) : null}

              {/* FNXC:WorkflowAskUser 2026-07-05-00:00: the ask-user question is the only
                  author-facing field; it reuses the same default-string fallback the
                  engine's runAwaitInputNode applies when left blank. */}
              {selectedNode.data.kind === "ask-user" ? (
                <>
                  <label className="wf-field">
                    <span>{t("workflowNodes.askUserQuestion", "Question")}</span>
                    <textarea
                      rows={3}
                      placeholder={t(
                        "workflowNodes.askUserQuestionPlaceholder",
                        "This workflow is waiting for your input.",
                      )}
                      value={String(selectedNode.data.config?.question ?? "")}
                      onChange={(e) => {
                        const value = e.target.value;
                        // FNXC:WorkflowAskUser 2026-07-05-02:00: validateAskUserAndExitGateNodes
                        // rejects a PRESENT-but-empty `question` (only an ABSENT question falls
                        // back to the engine default). Clearing the textarea back to "" must
                        // therefore delete the key, not persist `question: ""`, or the node
                        // silently becomes unsavable the moment an author reverts to the
                        // documented "leave blank for the default" behavior.
                        updateSelectedData({
                          config: (prev) => {
                            const next = { ...prev };
                            if (value.trim() === "") delete next.question;
                            else next.question = value;
                            return next;
                          },
                        });
                      }}
                    />
                  </label>
                  <p className="wf-inspector-note wf-inspector-note--info">
                    {t(
                      "workflowNodes.askUserNote",
                      "Parks the task and surfaces this question in the task chat/detail. Resumes once the user replies and unpauses.",
                    )}
                  </p>
                </>
              ) : null}

              {/* FNXC:WorkflowExitGate 2026-07-05-00:00: condition is optional — an
                  unconditional exit-gate always routes to end; a conditional one checks
                  a referenced node's published input (e.g. an ask-user reply). */}
              {selectedNode.data.kind === "exit-gate" ? (
                (() => {
                  const hasCondition =
                    selectedNode.data.config?.condition != null &&
                    typeof selectedNode.data.config.condition === "object";
                  const condition = hasCondition
                    ? (selectedNode.data.config!.condition as Record<string, unknown>)
                    : { type: "output-contains", value: "" };
                  const condType = String(condition.type ?? "output-contains");
                  const condText = condType === "output-matches" ? String(condition.pattern ?? "") : String(condition.value ?? "");
                  return (
                    <>
                      <label className="wf-field wf-field--checkbox">
                        <input
                          type="checkbox"
                          checked={hasCondition}
                          onChange={(e) => {
                            if (e.target.checked) {
                              updateSelectedData({
                                config: { condition: { type: "output-contains", value: "" } },
                              });
                            } else {
                              updateSelectedData({
                                config: (prev) => {
                                  const next = { ...prev };
                                  delete next.condition;
                                  return next;
                                },
                              });
                            }
                          }}
                        />
                        <span>{t("workflowNodes.exitGateConditional", "Exit conditionally")}</span>
                      </label>
                      {hasCondition ? (
                        <>
                          <label className="wf-field">
                            <span>{t("workflowNodes.exitGateNodeId", "Watch node id")}</span>
                            <input
                              value={String(condition.nodeId ?? "")}
                              placeholder={t("workflowNodes.exitGateNodeIdPlaceholder", "e.g. ask")}
                              onChange={(e) => {
                                const nodeId = e.target.value.trim();
                                updateSelectedData({
                                  config: (prev) => {
                                    const current =
                                      prev.condition && typeof prev.condition === "object"
                                        ? (prev.condition as Record<string, unknown>)
                                        : { type: "output-contains", value: "" };
                                    const next = { ...current };
                                    if (nodeId) next.nodeId = nodeId;
                                    else delete next.nodeId;
                                    return { ...prev, condition: next };
                                  },
                                });
                              }}
                            />
                          </label>
                          <label className="wf-field">
                            <span>{t("workflowNodes.exitGateConditionType", "Exit when")}</span>
                            <select
                              value={condType}
                              onChange={(e) => {
                                const nextType = e.target.value;
                                updateSelectedData({
                                  config: (prev) => {
                                    const current =
                                      prev.condition && typeof prev.condition === "object"
                                        ? (prev.condition as Record<string, unknown>)
                                        : {};
                                    const text =
                                      nextType === "output-matches"
                                        ? String(current.pattern ?? current.value ?? "")
                                        : String(current.value ?? current.pattern ?? "");
                                    const nextCondition: Record<string, unknown> = { ...current, type: nextType };
                                    delete nextCondition.pattern;
                                    delete nextCondition.value;
                                    return {
                                      ...prev,
                                      condition:
                                        nextType === "output-matches"
                                          ? { ...nextCondition, pattern: text }
                                          : { ...nextCondition, value: text },
                                    };
                                  },
                                });
                              }}
                            >
                              <option value="output-contains">{t("workflowNodes.loopOutputContains", "Output contains")}</option>
                              <option value="output-matches">{t("workflowNodes.loopOutputMatches", "Output matches regex")}</option>
                            </select>
                          </label>
                          <label className="wf-field">
                            <span>
                              {condType === "output-matches"
                                ? t("workflowNodes.loopPattern", "Pattern")
                                : t("workflowNodes.loopValue", "Value")}
                            </span>
                            <input
                              value={condText}
                              placeholder={condType === "output-matches" ? "looks good|approved" : "looks good"}
                              onChange={(e) => {
                                const value = e.target.value;
                                updateSelectedData({
                                  config: (prev) => {
                                    const current =
                                      prev.condition && typeof prev.condition === "object"
                                        ? (prev.condition as Record<string, unknown>)
                                        : {};
                                    return {
                                      ...prev,
                                      condition:
                                        condType === "output-matches"
                                          ? { ...current, type: condType, pattern: value }
                                          : { ...current, type: condType, value },
                                    };
                                  },
                                });
                              }}
                            />
                          </label>
                        </>
                      ) : null}
                      <p className="wf-inspector-note wf-inspector-note--info">
                        {t(
                          "workflowNodes.exitGateNote",
                          "Routes early to End (outcome:exit) when the condition matches, or unconditionally when none is set. Falls through (outcome:continue) otherwise.",
                        )}
                      </p>
                    </>
                  );
                })()
              ) : null}

              {selectedNode.data.kind === "prompt" ||
              selectedNode.data.kind === "gate" ||
              selectedNode.data.kind === "script" ? (
                <label className="wf-field">
                  <span>{t("workflowNodes.gateMode", "Gate mode")}</span>
                  <select
                    // Default display must match the compiler's defaults:
                    // gate and script nodes block by default, prompt is advisory.
                    value={String(
                      selectedNode.data.config?.gateMode
                        ?? (selectedNode.data.kind === "prompt" ? "advisory" : "gate"),
                    )}
                    onChange={(e) => updateSelectedData({ config: { gateMode: e.target.value } })}
                  >
                    <option value="advisory">{t("workflowNodes.advisory", "Advisory")}</option>
                    <option value="gate">{t("workflowNodes.gateBlocks", "Gate (blocks)")}</option>
                  </select>
                </label>
              ) : selectedNode.data.kind === "merge" ? (
                <p className="wf-inspector-note">
                  {t(
                    "workflowNodes.mergeBoundaryNote",
                    "Steps before this marker run pre-merge; steps after run post-merge.",
                  )}
                </p>
              ) : null}
              </fieldset>
              {!isBuiltin && (
                <button
                  type="button"
                  className="wf-editor-delete wf-inspector-delete"
                  data-testid="wf-delete-node"
                  onClick={() => {
                    applyDelete([selectedNode.id]);
                    setSelectedNodeId(null);
                  }}
                >
                  <Trash2 size={13} /> {t("workflowNodes.deleteNode", "Delete node")}
                </button>
              )}
            </aside>
          )}

          {selectedEdge && (
            <aside
              className={`wf-editor-inspector${simpleViewEnabled ? " wf-editor-inspector--simple" : ""}`}
              data-testid="wf-edge-inspector"
            >
              <div className="wf-inspector-heading">
                <h3>{t("workflowNodes.edgeInspector", "Edge")}</h3>
                {isMobileMode && (
                  <button
                    type="button"
                    className="wf-inspector-toggle wf-inspector-toggle--expanded"
                    data-testid="wf-edge-inspector-close"
                    aria-expanded="true"
                    onClick={() => setSelectedEdgeId(null)}
                  >
                    <ChevronDown size={13} />
                    <span>{t("workflowNodes.collapseInspector", "Collapse")}</span>
                  </button>
                )}
              </div>
              <fieldset className="wf-inspector-fields" disabled={isBuiltin}>
                {selectedEdgeEditability === "verdicts" ? (
                  <>
                    <label className="wf-field">
                      <span>{t("workflowNodes.edgeVerdict", "Review verdict")}</span>
                      <select
                        data-testid="wf-edge-verdict"
                        value={(() => {
                          const c = String(selectedEdge.data?.condition ?? "success");
                          return c.startsWith("outcome:") ? c.slice("outcome:".length) : "";
                        })()}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateSelectedEdge({ condition: v ? `outcome:${v}` : "success" });
                        }}
                      >
                        <option value="">{t("workflowNodes.edgeNoVerdict", "— success (no verdict) —")}</option>
                        {STEP_REVIEW_VERDICTS.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wf-field wf-field--checkbox">
                      <input
                        type="checkbox"
                        data-testid="wf-edge-rework"
                        checked={(selectedEdge.data?.kind as string | undefined) === "rework"}
                        onChange={(e) => updateSelectedEdge({ rework: e.target.checked })}
                      />
                      <span>{t("workflowNodes.edgeRework", "Rework edge (loop back, bounded)")}</span>
                    </label>
                    <p className="wf-inspector-note wf-inspector-note--info">
                      {t(
                        "workflowNodes.edgeReworkNote",
                        "Rework edges are the only legal cycles — they loop back within the for-each step instance, bounded by Max rework cycles.",
                      )}
                    </p>
                  </>
                ) : selectedEdgeEditability === "conditions" ? (
                  <label className="wf-field">
                    <span>{t("workflowNodes.edgeCondition", "Condition")}</span>
                    <select
                      data-testid="wf-edge-condition"
                      value={String(selectedEdge.data?.condition ?? "success")}
                      onChange={(e) => updateSelectedEdge({ condition: e.target.value })}
                    >
                      <option value="success">{t("workflowNodes.conditionSuccess", "success")}</option>
                      <option value="failure">{t("workflowNodes.conditionFailure", "failure")}</option>
                    </select>
                  </label>
                ) : (
                  <p className="wf-inspector-note">
                    {t(
                      "workflowNodes.edgeConditionLabel",
                      "Condition: {{condition}}",
                      { condition: String(selectedEdge.data?.condition ?? "success") },
                    )}
                  </p>
                )}
              </fieldset>
              {!isBuiltin && (
                <button
                  type="button"
                  className="wf-editor-delete wf-inspector-delete"
                  data-testid="wf-delete-edge"
                  onClick={() => {
                    applyDelete([selectedEdge.id]);
                    setSelectedEdgeId(null);
                  }}
                >
                  <Trash2 size={13} /> {t("workflowNodes.deleteEdge", "Delete edge")}
                </button>
              )}
            </aside>
          )}
        </div>
        {createOpen && (
          <CreateWorkflowDialog
            workflows={workflows}
            onCreate={handleCreateWorkflow}
            onDesign={handleDesignNewWorkflow}
            onClose={closeCreateDialog}
          />
        )}
        <WorkflowAddStepModal
          open={addStepTarget !== null}
          onClose={() => setAddStepTarget(null)}
          palette={PALETTE}
          disallowContainers={addStepTarget?.insideContainer === true}
          fragments={templateGroups.fragmentEntries}
          stepTemplates={templateGroups.stepEntries}
          pluginTemplates={templateGroups.pluginEntries}
          templateConflict={templateConflict}
          onPickPalette={handleAddStepPalettePick}
          onPickFragment={(fragment) => {
            if (handleInsertFragment(fragment, addStepTarget?.edgeId)) setAddStepTarget(null);
          }}
          onPickStepTemplate={handleAddStepTemplatePick}
          onPickStepTemplateAsOptionalGroup={(tpl) => {
            handleInsertStepTemplateAsOptionalGroup(tpl, addStepTarget?.edgeId);
            setAddStepTarget(null);
          }}
        />
      </div>
  );
  return (
    <>
      {isEmbedded ? (
        // FNXC:WorkflowEditorEmbedding 2026-06-22-00:00: inline main-content
        // wrapper (no fixed overlay, no overlayProps overlay-click dismiss).
        <div className="workflow-editor-embedded right-dock-embedded-view">
          {modalElement}
        </div>
      ) : (
        <FloatingWindow
          title={t("workflows.title", "Workflows")}
          onClose={requestClose}
          windowKey="workflow-node-editor"
          className="floating-window--workflow-editor"
          hideHeader
          dragHandleSelector=".wf-editor-header"
          defaultSize={{ width: 1200, height: 820 }}
          minSize={{ width: 640, height: 480 }}
          persistGeometryKey="fusion:workflow-node-editor-floating-geometry"
        >
          {modalElement}
        </FloatingWindow>
      )}
      {promptFullscreenOverlay}
    </>
  );
}

export function WorkflowNodeEditor({
  isOpen,
  onClose,
  addToast,
  projectId,
  initialPanel,
  initialAction,
  initialWorkflowId,
  presentation = "modal",
}: WorkflowNodeEditorProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const { isEmbedded } = useEmbeddedPresentation(presentation);
  if (!isOpen) return null;
  return (
    <ReactFlowProvider>
      <InnerEditor
        onClose={onClose}
        addToast={addToast}
        projectId={projectId}
        initialPanel={initialPanel}
        initialAction={initialAction}
        initialWorkflowId={initialWorkflowId}
        modalRef={modalRef}
        isEmbedded={isEmbedded}
      />
    </ReactFlowProvider>
  );
}
