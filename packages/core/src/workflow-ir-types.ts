/** Node kinds. v1 kinds (start/prompt/script/gate/end) plus the v2 additions:
 *  `hold` (passive dwell column states), `split`/`join` (parallel fan-out), the
 *  step-inversion additions (FN step-inversion, KTD-3/4/12/15): `foreach`
 *  (runtime-expanding per-step template region), `step-review` (per-step review
 *  verdicts as outcome edges), `parse-steps` (graph-native step-list parsing),
 *  `code` (sandboxed TypeScript), `notify` (workflow-authored notifications),
 *  and `loop` (bounded repeat-until region);
 *  and the workflow-owned merge/retry/recovery policy additions:
 *  `merge-gate`, `merge-attempt`, `manual-merge-hold`, `retry-backoff`,
 *  `recovery-router`, `branch-group-member-integration`, and
 *  `branch-group-promotion`;
 *  and the unified PR-entity additions (U3):
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
  | "loop"
  | "optional-group"
  | "step-review"
  | "parse-steps"
  | "code"
  | "notify"
  | "merge-gate"
  | "merge-attempt"
  | "manual-merge-hold"
  | "retry-backoff"
  | "recovery-router"
  | "branch-group-member-integration"
  | "branch-group-promotion"
  | "pr-create"
  | "pr-respond"
  | "pr-merge";

export interface WorkflowIrNode {
  id: string;
  kind: WorkflowIrNodeKind;
  /** v2: the column this node is placed in. Must reference a defined column id. */
  column?: string;
  /** Plugin-namespaced extension metadata keyed as `plugin:<pluginId>:<extensionId>`. */
  extensions?: Record<string, Record<string, unknown>>;
  config?: Record<string, unknown>;
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

export interface OptionalStepRevisionBudget {
  unbounded: boolean;
  max: number;
}

/*
FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:15:
Optional-group steps can override the global `maxPostReviewFixes` cycle budget with a per-step non-negative integer or `"unbounded"`. The resolver keeps absent/invalid raw values byte-inert by falling back to the effective global budget, while `"unbounded"` explicitly removes the ceiling so Code Review, Browser Verification, or custom optional gates can cycle until they approve.
*/
export function resolveOptionalStepRevisionBudget(
  rawMaxRevisions: unknown,
  fallback: number,
): OptionalStepRevisionBudget {
  if (rawMaxRevisions === "unbounded") {
    return { unbounded: true, max: Number.POSITIVE_INFINITY };
  }
  if (
    typeof rawMaxRevisions === "number" &&
    Number.isFinite(rawMaxRevisions) &&
    Number.isInteger(rawMaxRevisions) &&
    rawMaxRevisions >= 0
  ) {
    return { unbounded: false, max: rawMaxRevisions };
  }
  return { unbounded: false, max: fallback };
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

export interface WorkflowIrEdge {
  from: string;
  to: string;
  condition?: string;
  /** Step-inversion (KTD-5) + PR review loop (U6): `rework` edges are the only
   *  legal cycles. Originally scoped to one foreach template instance and bounded
   *  by the foreach `maxReworkCycles`; U6 generalizes the same mechanism to the
   *  top-level walk so a PR review region (await-review → pr-respond → back to
   *  await-review) is a legal bounded cycle too. The bound on a top-level rework
   *  edge is `maxReworkCycles` on this edge's `to` node config (the loop-region
   *  head, which must set `reworkRegion: true`), defaulting to
   *  {@link DEFAULT_MAX_REWORK_CYCLES}. Either way, rework edges are
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

export type WorkflowLoopExitCondition =
  | {
      type: "output-contains";
      /** Template node id whose result value is inspected. Defaults to template exit node. */
      nodeId?: string;
      value: string;
    }
  | {
      type: "output-matches";
      /** Template node id whose result value is inspected. Defaults to template exit node. */
      nodeId?: string;
      pattern: string;
      flags?: string;
    };

/** Config for a bounded repeat-until workflow region. */
export interface WorkflowLoopConfig {
  maxIterations?: number;
  timeoutMs?: number;
  exitWhen: WorkflowLoopExitCondition;
  template: {
    nodes: WorkflowIrNode[];
    edges: WorkflowIrEdge[];
  };
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-11:00:
An `optional-group` node is a container (mirroring `foreach`/`loop`) whose `template` subgraph the executor runs ONCE when the group is enabled for the task and passes through (skips) when disabled.
Enable state reuses the per-task `enabledWorkflowSteps` facet keyed by the group node id, seeded from `defaultOn` at task creation — this replaces the execution-inert declaration-based optional-steps model (`WorkflowOptionalStep`/`optionalSteps`).
Single pass only: no iteration, no rework budget. Rework edges are forbidden inside the template so the single-pass guarantee is unambiguous (validated in `validateOptionalGroup`).

FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:15:
Optional-group remediation still runs the template once per graph pass, but workflow authors can set a per-step `maxRevisions` override for the PRE-merge fix→re-review cycle. A non-negative integer caps that optional step against its own review-attempt partition, `"unbounded"` removes the ceiling, and absence preserves the effective global `maxPostReviewFixes` behavior for generic optional gates.

FNXC:WorkflowRevisionBudget 2026-06-30-20:34:
Built-in Plan Review/spec and Code Review groups have workflow-value overrides (`planReviewMaxRevisions`, `codeReviewMaxRevisions`) that resolve before this node config; when those workflow values are unset, those two built-in review paths default to unbounded remediation.
*/
/** Config for an `optional-group` container node. `defaultOn` seeds the per-task
 *  enable set at creation; the `template` is the subgraph run once when enabled.
 *  Unlike `foreach`/`loop`, there is no iteration or rework — a single pass. */
export interface WorkflowOptionalGroupConfig {
  /** Workflow-author default for whether new tasks enable this group. */
  defaultOn?: boolean;
  /** Display name for the group (editor + per-task toggle surfaces). */
  name?: string;
  /**
   * Per-step override for the optional step's PRE-merge fix→re-review cycle. A
   * non-negative integer caps revisions for this step; `"unbounded"` keeps cycling
   * until the step returns APPROVE/APPROVE_WITH_NOTES. Plan Review and Code Review
   * workflow-setting values override this field; absence falls back to the
   * gate-specific runtime default (unbounded for those built-in reviews, global
   * fallback for generic optional gates).
   */
  maxRevisions?: number | "unbounded";
  /*
  FNXC:WorkflowPostMerge 2026-06-26-09:00:
  Execution phase of the optional-group step. Defaults to "pre-merge" (the prior, only
  behavior) when absent, so existing built-in/custom optional groups are byte-identical.
  "post-merge" marks a group that the graph executor runs AFTER a successful merge
  (gated by the `graphNativePostMerge` experimental flag); the recorded
  `WorkflowStepResult.phase` and `[post-merge]` logs follow this value.
  */
  phase?: "pre-merge" | "post-merge";
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

/** A workflow-defined board column. */
export interface WorkflowIrColumn {
  id: string;
  name: string;
  traits: WorkflowIrColumnTrait[];
  /** Plugin-namespaced extension metadata keyed as `plugin:<pluginId>:<extensionId>`. */
  extensions?: Record<string, Record<string, unknown>>;
  /** Optional permanent-agent binding (column-agent plan KTD-1). Additive and
   *  omitted entirely when unset — never serialized as `agent: null` — so legacy
   *  and default workflows stay byte-identical (R9). */
  agent?: WorkflowColumnAgent;
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

/*
FNXC:WorkflowOptionalGroup 2026-06-21-18:00:
Retired the legacy declaration-based optional-steps model. The `WorkflowOptionalStep` interface and the `WorkflowIrV2.optionalSteps` field are removed — optional steps are now graph-native `optional-group` NODES (see `WorkflowOptionalGroupConfig` above), resolved by `resolveWorkflowOptionalSteps`. A legacy persisted `optionalSteps` key on an old v2 row is TOLERATED at parse (ignored, not validated) so old rows still load as v2.
*/

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
