/** Node kinds. v1 kinds (start/prompt/script/gate/end) plus the v2 additions:
 *  `hold` (passive dwell column states), `split`/`join` (parallel fan-out), the
 *  step-inversion additions (FN step-inversion, KTD-3/4/12/15): `foreach`
 *  (runtime-expanding per-step template region), `step-review` (per-step review
 *  verdicts as outcome edges), `parse-steps` (graph-native step-list parsing),
 *  and `code` (sandboxed TypeScript); and the unified PR-entity additions (U3):
 *  `pr-create` (open/reuse the PR + write the entity), `pr-respond` (the
 *  review-response run), and `pr-merge` (tool-side merge with expectedHeadOid). */
export type WorkflowIrNodeKind =
  | "start"
  | "prompt"
  | "script"
  | "gate"
  | "end"
  | "hold"
  | "split"
  | "join"
  | "foreach"
  | "step-review"
  | "parse-steps"
  | "code"
  | "pr-create"
  | "pr-respond"
  | "pr-merge";

export interface WorkflowIrNode {
  id: string;
  kind: WorkflowIrNodeKind;
  /** v2: the column this node is placed in. Must reference a defined column id. */
  column?: string;
  config?: Record<string, unknown>;
}

/**
 * Executor kinds selectable on a prompt/execute node's `config.executor` (CLI
 * Agent Executor, U7). The engine reads `config.executor` as an open string; this
 * union documents the recognized values and `WorkflowNodeExecutorConfig` the
 * fields each one consumes. `config` itself stays an open `Record` so unknown
 * keys remain forward-compatible.
 *
 * - `model`     (default): run the prompt on the configured/override model.
 * - `agent`     : run as a named agent (adopt its model + persona).
 * - `skill`     : invoke a named skill with the prompt as input.
 * - `cli`       : run a named project script with the prompt via env.
 * - `cli-agent` : drive a CLI coding agent (Claude Code / Codex / Droid / Pi /
 *                 generic) in an engine-owned PTY for the execute step. Honors
 *                 cancel/abort/re-entry semantics and positive-completion gating.
 */
export type WorkflowNodeExecutorKind = "model" | "agent" | "skill" | "cli" | "cli-agent";

/**
 * The cli-agent slice of a workflow node's `config`. These ride on the open
 * `WorkflowIrNode.config` record (read at U7's executor seam); they are NOT a
 * separate column. The resolved values are SNAPSHOTTED at session launch — a
 * mid-run edit to the node config applies to the next run only.
 */
export interface WorkflowNodeExecutorConfig {
  /** Selected executor kind for this node. */
  executor?: WorkflowNodeExecutorKind;
  /** cli-agent: adapter id to drive the session (resolved against the registry). */
  cliAdapterId?: string;
  /**
   * cli-agent: autonomy posture (drives privileged flags + resume caps). Stored
   * verbatim; structured but extensible (mirrors `CliAutonomyPosture`).
   */
  cliAutonomy?: {
    autoApprove?: boolean;
    maxResumeAttempts?: number;
    [key: string]: unknown;
  };
  /**
   * cli-agent: notification settings for waiting-on-input events on this node
   * (origin R2/R11). Opaque to the engine seam; forwarded to the dispatch.
   */
  cliNotify?: Record<string, unknown>;
}

/** Default bounded-rework budget when a rework region omits `maxReworkCycles`
 *  (KTD-5 foreach default; U6 reuses it for the top-level review loop). */
export const DEFAULT_MAX_REWORK_CYCLES = 3;
/** Defensive clamp on any rework budget (KTD-5; shared by foreach + U6). */
export const MAX_REWORK_CYCLES_CAP = 10;

/** Resolve a bounded-rework budget from a config bag, applying the shared
 *  default + clamp. Used by the foreach sub-walk and the top-level rework loop so
 *  the bound semantics cannot drift between the two. */
export function resolveMaxReworkCycles(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEFAULT_MAX_REWORK_CYCLES;
  return Math.max(1, Math.min(MAX_REWORK_CYCLES_CAP, Math.floor(n)));
}

export interface WorkflowIrEdge {
  from: string;
  to: string;
  condition?: string;
  /** Step-inversion (KTD-5) + PR review loop (U6): `rework` edges are the only
   *  legal cycles. Originally scoped to one foreach template instance and bounded
   *  by the foreach `maxReworkCycles`; U6 generalizes the same mechanism to the
   *  top-level walk so a PR review region (await-review → pr-respond → back to
   *  await-review) is a legal bounded cycle too. The bound on a top-level rework
   *  edge is `maxReworkCycles` on this edge's `from` node config (the loop head),
   *  defaulting to {@link DEFAULT_MAX_REWORK_CYCLES}. Either way, rework edges are
   *  exempt from "Cycle detected"; every other back-edge still throws. */
  kind?: "rework";
}

/** Step-inversion (KTD-3): config for a `foreach` node — a runtime-expanding
 *  template region instantiated once per planned step.
 *  Defaults: `mode` sequential; `isolation` shared for sequential / worktree for
 *  parallel; `concurrency` parallel-only. */
export interface WorkflowForeachConfig {
  source: "task-steps";
  maxReworkCycles?: number;
  mode?: "sequential" | "parallel";
  concurrency?: number;
  isolation?: "shared" | "worktree";
  template: {
    nodes: WorkflowIrNode[];
    edges: WorkflowIrEdge[];
  };
}

/** Step-inversion (KTD-12): a workflow-declared task document. Artifacts ride the
 *  existing task-documents machinery; `step-source` artifacts feed `parse-steps`. */
export interface WorkflowIrArtifact {
  key: string;
  title?: string;
  producedBy?: "planning" | "manual";
  role?: "step-source" | "context";
}

/** Step-inversion (KTD-13): the supported custom-field value types. */
export type WorkflowFieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "multi-enum"
  | "date"
  | "url";

/** A single enum/multi-enum option (KTD-13). */
export interface WorkflowFieldOption {
  value: string;
  label: string;
  color?: string;
}

/** Rendering instructions for a custom field (KTD-14). */
export interface WorkflowFieldRender {
  placement?: "card" | "detail" | "detail-section";
  widget?: "select" | "radio" | "chips" | "input" | "textarea" | "toggle";
  badge?: boolean;
}

/** Step-inversion (KTD-13): a workflow-defined custom task field. */
export interface WorkflowFieldDefinition {
  id: string;
  name: string;
  type: WorkflowFieldType;
  required?: boolean;
  default?: unknown;
  options?: WorkflowFieldOption[];
  render?: WorkflowFieldRender;
}

/** Workflow-settings (U1): the supported setting value types. A whitelist
 *  mirroring the scalar/enum subset of `WorkflowFieldType` — settings carry
 *  workflow-scoped policy (step timeouts, review gates, model lanes), so the
 *  date/url field types do not apply. */
export type WorkflowSettingType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "multi-enum";

/** A single enum/multi-enum option for a workflow setting (mirrors
 *  `WorkflowFieldOption`). */
export interface WorkflowSettingOption {
  value: string;
  label: string;
  color?: string;
}

/** Rendering instructions for a workflow setting (U1, KTD-1). Settings get their
 *  OWN render-hint type: a widget only — NO `card`/`detail` placement, which is
 *  task-card-specific. The widget whitelist mirrors the field render widgets. */
export interface WorkflowSettingRender {
  widget?: "select" | "radio" | "chips" | "input" | "textarea" | "toggle";
}

/** Workflow-settings (U1, R1, KTD-1): a workflow-declared typed setting. Clones
 *  the shape of `WorkflowFieldDefinition` (one level up) — declarations describe
 *  the schema; the per-`(workflowId, projectId)` value table (U2) carries data.
 *  `default` is consumed by the engine's effective-settings resolver (U3), so it
 *  is validated against its own type/options at parse time. */
export interface WorkflowSettingDefinition {
  id: string;
  name: string;
  type: WorkflowSettingType;
  default?: unknown;
  options?: WorkflowSettingOption[];
  description?: string;
  render?: WorkflowSettingRender;
}

/** A single trait configuration applied to a column. The `trait` is an opaque
 *  registry id (resolved by the trait registry shipped in U2); `config` carries
 *  trait-specific options validated by that trait's schema. */
export interface WorkflowIrColumnTrait {
  trait: string;
  config?: Record<string, unknown>;
}

/** Per-column permanent-agent binding (column-agent plan KTD-1). A column may name
 *  one agent from the registry plus a mode that decides precedence against
 *  node-level / task-level agent and model settings:
 *  - `defer`: the column agent applies only when the work carries no own settings
 *    (no agent identity and no complete modelProvider+modelId pair — KTD-5).
 *  - `override`: the column agent supersedes node/task settings wholesale.
 *  This is execution identity (consumed by the executor's session-building paths),
 *  not a board-transition trait — hence a first-class typed field, not a trait
 *  config blob (KTD-1). Agent *existence* is not an IR concern (no agent store at
 *  this layer); it is enforced at write time (route) and falls back at read time. */
export interface WorkflowColumnAgent {
  /** Registry agent id that staffs the column. Non-empty. */
  agentId: string;
  /** Precedence mode against node/task settings. */
  mode: "defer" | "override";
}

/** The three locked role columns of a company-model board (U3, R1). A column's
 *  `role` is the identity of the agent slot the board mandates there: the Lead
 *  staffs todo, the Executor in-progress, the Reviewer in-review. Only the
 *  company board template carries these markers — legacy/default workflows never
 *  set them, so flag-off boards stay byte-identical and the company-model
 *  placement/movement rules (which key off the markers) never fire for them. */
export type WorkflowColumnRole = "lead" | "executor" | "reviewer";

/** A workflow-defined board column. */
export interface WorkflowIrColumn {
  id: string;
  name: string;
  traits: WorkflowIrColumnTrait[];
  /** Optional permanent-agent binding (column-agent plan KTD-1). Additive and
   *  omitted entirely when unset — never serialized as `agent: null` — so legacy
   *  and default workflows stay byte-identical (R9). */
  agent?: WorkflowColumnAgent;
  /** Company-model role marker (U3, R1). Present only on the three mandatory
   *  role columns of a company board template; absent everywhere else. The
   *  company-model placement (workflow-reconciliation) and movement
   *  (workflow-transitions) rules key off this marker, so a board that carries
   *  it is a company-model board and one that doesn't is left on the legacy
   *  path. Additive — omitted entirely when unset. */
  role?: WorkflowColumnRole;
  /** Company-model lock marker (U3, R1). A locked column is non-deletable and
   *  non-renamable: the save-validation path rejects edits that remove or rename
   *  it. The three role columns are locked. Additive — omitted when unset. */
  locked?: boolean;
}

/** Release conditions for a `hold` node (KTD-2, R3). */
export type WorkflowHoldRelease =
  | "manual"
  | "timer"
  | "capacity"
  | "dependency"
  | "external-event";

/** Join synchronization mode (KTD-11). `quorum` requires `quorum.n` completed branches. */
export type WorkflowJoinMode = "all" | "any" | { quorum: number };

/** What happens to sibling branches when one branch fails before the join (KTD-11). */
export type WorkflowJoinBranchFailure = "fail-fast" | "collect";

/** A v1 workflow IR graph. Frozen by FN-5769; retained for back-compat. */
export interface WorkflowIrV1 {
  version: "v1";
  name: string;
  nodes: WorkflowIrNode[];
  edges: WorkflowIrEdge[];
}

/** A v2 workflow IR graph: v1 plus workflow-defined columns and node placement.
 *  Step-inversion adds optional `artifacts` (KTD-12) and `fields` (KTD-13)
 *  declarations — both additive; absent on legacy graphs. */
export interface WorkflowIrV2 {
  version: "v2";
  name: string;
  columns: WorkflowIrColumn[];
  nodes: WorkflowIrNode[];
  edges: WorkflowIrEdge[];
  artifacts?: WorkflowIrArtifact[];
  fields?: WorkflowFieldDefinition[];
  /** Workflow-settings (U1, R1): typed setting declarations. Additive; absent on
   *  legacy graphs. Values persist per-`(workflowId, projectId)` (U2), not here. */
  settings?: WorkflowSettingDefinition[];
}

/** Either IR version. v1 graphs upgrade to v2 on parse (see parseWorkflowIr). */
export type WorkflowIr = WorkflowIrV1 | WorkflowIrV2;
