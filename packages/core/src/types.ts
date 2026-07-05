import type { InReviewStallSignal } from "./in-review-stall.js";
import type { ModelPricing } from "./model-pricing.js";
import type { InReviewStalledSignal } from "./in-review-stalled.js";
import type { StalePausedReviewSignal } from "./stale-paused-review.js";
import type { StalePausedTodoSignal } from "./stale-paused-todo.js";
import type { StalledReviewSignal } from "./stalled-review-detector.js";
import type { TaskAgeStalenessSignal } from "./task-age-staleness.js";
import type { SecretScope } from "./secrets-store.js";

export {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
} from "./capacity.js";
export type { CapacityRiskSignal } from "./capacity.js";

// FNXC:McpConfig 2026-06-26-02:10: The dashboard Vite build aliases @fusion/core to this browser-safe module, so the pure MCP config helpers are re-exported here for Settings UI import/export, validation, and project-over-global resolution without pulling Node-only stores into the client bundle.
export { exportMcpServersJson, importMcpServersJson, resolveEffectiveMcpServers } from "./mcp-config.js";
export {
  DEFAULT_GITLAB_API_BASE_URL,
  DEFAULT_GITLAB_INSTANCE_URL,
  resolveGitlabConfig,
  resolveGitlabEnabled,
} from "./gitlab-config.js";
export type { GitlabConfigSettingsSource, ResolvedGitlabConfig, ResolveGitlabConfigInput } from "./gitlab-config.js";
export { validateMcpServerDefinitionDetailed, validateMcpServerDefinitionsDetailed } from "./settings-validation.js";

/**
 * Valid thinking effort levels for AI agent sessions, controlling the cost/quality tradeoff of reasoning.
 * Includes extra-high for maximum-effort requests on reasoning-capable models.
 *
 * FNXC:Settings-ThinkingLevel 2026-06-19-14:55:
 * The central thinking-level enum must expose `xhigh` so UI settings and API validation can pass maximum reasoning requests through to CLI adapters. Runtime adapters map `xhigh` to `high` for non-Opus models and `max` for Opus models.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The legacy default-workflow column set. Workflow-aware task movement resolves
 * valid columns from each task's workflow definition (the default workflow's
 * column IDs are byte-identical to these — KTD-1). New code should prefer the
 * workflow-resolved path (`resolveAllowedColumns` / `workflowHasColumn` in
 * `workflow-transitions.ts`) and trait predicates over string equality; this
 * enum remains the canonical id set for the built-in default workflow.
 */
export const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done", "archived"] as const;
/**
 * The closed legacy column union — still the correct type for default-workflow
 * column ids. Movement entry points accept the wider {@link ColumnId}; runtime
 * code validates ids against the task's resolved workflow.
 */
export type Column = (typeof COLUMNS)[number];

/**
 * Column identifier accepted at task-movement entry points (KTD-1).
 * Equals the legacy `Column` union for autocomplete purposes, but admits
 * workflow-defined custom column ids; runtime paths validate the id against the
 * task's resolved workflow.
 */
export type ColumnId = Column | (string & {});

export const DEFAULT_COLUMN: Column = "triage";

/**
 * Tests membership against the closed legacy column enum. Note: under the
 * workflowColumns flag, column validity is workflow-scoped — flag-aware code
 * should use `workflowHasColumn(ir, columnId)` (`workflow-transitions.ts`);
 * this remains correct for the flag-OFF path and default-workflow ids.
 */
export function isColumn(value: unknown): value is Column {
  return typeof value === "string" && (COLUMNS as readonly string[]).includes(value);
}

/**
 * @deprecated (workflowColumns, U12) Coerces an arbitrary value to a legacy
 * column, DISCARDING workflow-defined custom column ids — lossy under the
 * flag. Resolve and validate against the task's workflow instead. Retained
 * for the legacy flag-OFF path while the flag exists.
 */
export function normalizeColumn(value: unknown, fallback: Column = DEFAULT_COLUMN): Column {
  return isColumn(value) ? value : fallback;
}

/** Ordered task-priority levels for the core task domain contract. */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Default task priority used for legacy rows/entries and create flows when
 * callers omit the priority field.
 */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "normal";

export const MERGE_REQUEST_STATES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "exhausted",
  "cancelled",
  "manual-required",
] as const;

export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

export const WORKFLOW_WORK_ITEM_KINDS = [
  "task",
  "merge",
  "retry",
  "manual-hold",
  "recovery",
] as const;

export type WorkflowWorkItemKind = (typeof WORKFLOW_WORK_ITEM_KINDS)[number];

export const WORKFLOW_WORK_ITEM_STATES = [
  "runnable",
  "running",
  "held",
  "retrying",
  "manual-required",
  "succeeded",
  "failed",
  "cancelled",
  "exhausted",
] as const;

export type WorkflowWorkItemState = (typeof WORKFLOW_WORK_ITEM_STATES)[number];

export interface WorkflowWorkItem {
  id: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: WorkflowWorkItemKind;
  state: WorkflowWorkItemState;
  attempt: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowWorkItemUpsertInput {
  id?: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: WorkflowWorkItemKind;
  state?: WorkflowWorkItemState;
  attempt?: number;
  retryAfter?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  blockedReason?: string | null;
  now?: string;
}

export interface WorkflowWorkItemTransitionPatch {
  attempt?: number;
  retryAfter?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  blockedReason?: string | null;
  now?: string;
}

export interface WorkflowWorkItemDueFilter {
  now?: string;
  limit?: number;
  kinds?: WorkflowWorkItemKind[];
  states?: WorkflowWorkItemState[];
}

export interface MergeRequestWorkflowProjectionOptions {
  runId?: string;
  nodeId?: string;
  now?: string;
}

export interface MergeQueueEntry {
  taskId: string;
  enqueuedAt: string;
  priority: TaskPriority;
  leasedBy: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

export interface MergeRequestRecord {
  taskId: string;
  state: MergeRequestState;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError: string | null;
}

export interface CompletionHandoffMarker {
  taskId: string;
  acceptedAt: string;
  source: string;
}

export interface MergeQueueEnqueueOptions {
  priority?: TaskPriority;
  now?: string;
}

export interface MergeQueueAcquireOptions {
  leaseDurationMs: number;
  now?: string;
  /** If provided, the lease attempt targets this specific task first.
   *  The task must be unexpired/available; otherwise falls back to normal queue-head selection. */
  targetTaskId?: string;
}

export type MergeQueueReleaseOutcome =
  | { kind: "success" }
  | { kind: "failure"; error: string };

export interface HandoffEvidence {
  /** Reason text recorded on the run-audit event (for example "fn_task_done"). */
  reason: string;
  /** Optional run id captured for forensics. */
  runId?: string;
  /** Optional agent id captured for forensics. */
  agentId?: string;
}

export interface HandoffToReviewOptions {
  ownerAgentId: string | null;
  evidence: HandoffEvidence;
  moveOptions?: {
    preserveResumeState?: boolean;
    preserveProgress?: boolean;
    preserveWorktree?: boolean;
    preserveStatus?: boolean;
    moveSource?: "user" | "engine";
    skipMergeBlocker?: boolean;
  };
  /** Inject a clock for tests. */
  now?: string;
}

/**
 * Dashboard high-fan-out blocker threshold. A blocker is considered high impact
 * when at least this many active todo tasks are waiting on it.
 */
export const HIGH_FANOUT_BLOCKER_TODO_THRESHOLD = 5;

/**
 * Default age gate (ms) before a high fan-out blocker is escalated in dashboards.
 */
export const STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Execution mode for task implementation.
 * Controls how the executor agent approaches the task:
 * - "standard": Full execution with complete review workflow (default)
 * - "fast": Expedited execution with minimal overhead for simple tasks
 */
export const EXECUTION_MODES = ["standard", "fast"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Default execution mode for new tasks */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "standard";

/*
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Per-task override of the workflow-native `plannerOversightLevel` setting
 * (declared in `BUILTIN_OVERSIGHT_SETTINGS`, packages/core/src/builtin-workflow-settings.ts).
 * When a task sets this field, it wins over the workflow's effective oversight
 * value; unset (NULL in storage) means "inherit the workflow default". Values,
 * order, and default here must stay in sync with `BUILTIN_OVERSIGHT_SETTINGS`.
 */
export const PLANNER_OVERSIGHT_LEVELS = ["off", "observe", "steer", "autonomous"] as const;
export type PlannerOversightLevel = (typeof PLANNER_OVERSIGHT_LEVELS)[number];
export const DEFAULT_PLANNER_OVERSIGHT_LEVEL: PlannerOversightLevel = "autonomous";

/** Controls whether triage should require completion documentation artifacts in task specs. */
export const COMPLETION_DOCUMENTATION_MODES = ["off", "changeset", "changelog"] as const;
export type CompletionDocumentationMode = (typeof COMPLETION_DOCUMENTATION_MODES)[number];

/** Theme mode for light/dark/system preference */
export const THEME_MODES = ["dark", "light", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Color theme options for the dashboard */
export const COLOR_THEMES = [
  "default",
  "ocean",
  "forest",
  "sunset",
  "zen",
  "berry",
  "high-contrast",
  "industrial",
  "monochrome",
  "slate",
  "ash",
  // FNXC:DashboardTheming 2026-06-19-15:36: "air" is the source-of-truth id for the minimal, borderless, paper-like dashboard theme; keep bootstrap validators and theme options in sync with this union.
  "air",
  "graphite",
  "silver",
  "solarized",
  "factory",
  "factory-mono",
  "ayu",
  "one-dark",
  "nord",
  "dracula",
  "gruvbox",
  "tokyo-night",
  "catppuccin-mocha",
  "github-dark",
  "everforest",
  "rose-pine",
  "kanagawa",
  "night-owl",
  "palenight",
  "monokai-pro",
  "slime",
  "brutalist",
  "neon-city",
  "parchment",
  "terminal",
  "glass",
  // FNXC:DashboardTheming 2026-07-01-00:00: Glass Silver is the silver/gray frosted sibling of Glass; keep this id in lockstep with dashboard/desktop validators and selector metadata so persisted explicit choices survive startup.
  "glass-silver",
  "horizon",
  "vitesse",
  "outrun",
  "snazzy",
  "porple",
  "espresso",
  "mars",
  "poimandres",
  "ember",
  "rust",
  "copper",
  "foundry",
  "carbon",
  "sandstone",
  "lagoon",
  "frost",
  "lavender",
  "neon-bloom",
  "sepia",
  "shadcn",
  // FNXC:DashboardTheming 2026-06-30-00:00: Shadcn Ember is the default for unset installs; keep it adjacent to the shadcn base so dashboard options and bootstrap validators preserve published theme order while explicit legacy ids remain valid.
  "shadcn-ember",
  // FNXC:DashboardTheming 2026-06-20-18:20: FN-6816 adds the user-customizable shadcn variant; keep this union in lockstep with dashboard theme options, swatches, theme-data base blocks, and the shadcn custom color token list.
  "shadcn-custom",
  // FNXC:DashboardTheming 2026-06-19-16:07: FN-6756 extends the published color-theme union with shadcn-family accent variants; keep dashboard theme options, bootstrap validation, swatches, and theme-data token blocks in lockstep with this ordered list.
  // FNXC:DashboardTheming 2026-06-20-00:00: FN-6813 renames the grayscale-base mono theme to shadcn-mono-red and adds the remaining mono accent variants; keep Shadcn Gray adjacent to Shadcn Black so the color-family order stays stable with FN-6814.
  // FNXC:DashboardTheming 2026-06-21-00:00: FN-6815 adds shadcn-gray-blue as the slate-neutral blue-gray sibling; keep it adjacent to Shadcn Gray so the published union mirrors dashboard option order.
  "shadcn-blue",
  "shadcn-green",
  "shadcn-red",
  "shadcn-purple",
  "shadcn-pink",
  "shadcn-orange",
  "shadcn-yellow",
  "shadcn-mono-red",
  "shadcn-mono-blue",
  "shadcn-mono-green",
  "shadcn-mono-purple",
  "shadcn-mono-pink",
  "shadcn-mono-orange",
  "shadcn-mono-yellow",
  "shadcn-black",
  "shadcn-gray",
  "shadcn-gray-blue",
] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

/** UI locales supported across the dashboard and terminal UI. `en` is the
 *  source-of-truth language and the fallback for all others. Adding a locale
 *  here (plus translated catalogs) is the only code change a new language
 *  needs — see `@fusion/i18n`. zh-CN and zh-TW are independent catalogs and
 *  are never auto-converted between scripts. */
export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW", "fr", "es", "ko"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
/** Source-of-truth language and the fallback for all locales. */
export const DEFAULT_LOCALE: Locale = "en";

/** Narrow an arbitrary value to a supported `Locale`. */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export type PrStatus = "open" | "closed" | "merged" | "draft";
export type MergeStrategy = "direct" | "pull-request";
export type MergeIntegrationWorktreeMode =
  | "reuse-task-worktree"
  | "cwd-integration-branch" // explicit opt-in; surfaces a warning at startup. See FN-5348.
  | "cwd-main"; // legacy alias for cwd-integration-branch; deprecated. Normalized at read time.

let warnedLegacyCwdMain = false;

export function __resetLegacyCwdMainWarningForTests(): void {
  warnedLegacyCwdMain = false;
}

export function normalizeMergeIntegrationWorktreeMode(
  value: unknown,
): MergeIntegrationWorktreeMode {
  if (value === "reuse-task-worktree" || value === "cwd-integration-branch") {
    return value;
  }

  if (value === "cwd-main") {
    if (!warnedLegacyCwdMain) {
      warnedLegacyCwdMain = true;
      console.warn("[merger] settings.mergeIntegrationWorktree=cwd-main is legacy; normalized to cwd-integration-branch");
    }
    return "cwd-integration-branch";
  }

  return "reuse-task-worktree";
}

export const DIRECT_MERGE_COMMIT_STRATEGIES = ["auto", "always-squash", "always-rebase"] as const;
export type DirectMergeCommitStrategy = (typeof DIRECT_MERGE_COMMIT_STRATEGIES)[number];

export const MERGE_ADVANCE_AUTO_SYNC_MODES = ["off", "ff-only", "stash-and-ff"] as const;
export type MergeAdvanceAutoSyncMode = (typeof MERGE_ADVANCE_AUTO_SYNC_MODES)[number];
export function normalizeMergeAdvanceAutoSyncMode(value: unknown): MergeAdvanceAutoSyncMode {
  return value === "off" || value === "ff-only" || value === "stash-and-ff" ? value : "stash-and-ff";
}
/** How merge conflicts are resolved when the AI agent can't (or shouldn't) decide.
 *
 *  Both `smart-*` strategies share the same cascade: pre-merge fetch +
 *  fast-forward of local main from origin (graceful degrade on failure),
 *  then AI, then auto-resolve lock/generated/trivial files. They differ only
 *  in the final per-file fallback when conflicts remain:
 *
 *  - "smart-prefer-main" (default): fall back to `-X ours` so main's state
 *    wins. Best when concurrent tasks could regress just-merged sibling work.
 *  - "smart-prefer-branch": fall back to `-X theirs` so the task branch wins.
 *    Best when one agent at a time is dominant and you trust their output.
 *  - "ai-only": run AI on every attempt; never silently prefer one side.
 *  - "abort": run AI once; if conflict remains, fail the merge so a human
 *    can resolve it.
 *
 *  Legacy values `"smart"` and `"prefer-main"` are accepted for backwards
 *  compatibility and normalized via {@link normalizeMergeConflictStrategy}.
 *  `"smart"` maps to `"smart-prefer-branch"` (its historical fallback) and
 *  `"prefer-main"` maps to `"smart-prefer-main"`. */
export type MergeConflictStrategy =
  | "smart-prefer-main"
  | "smart-prefer-branch"
  | "ai-only"
  | "abort"
  /** @deprecated use "smart-prefer-branch" */
  | "smart"
  /** @deprecated use "smart-prefer-main" */
  | "prefer-main";

/** Canonical (post-migration) values that the merger actually dispatches on. */
export type CanonicalMergeConflictStrategy = Exclude<
  MergeConflictStrategy,
  "smart" | "prefer-main"
>;

/** Translate legacy `mergeConflictStrategy` values into their canonical form.
 *  Pass-through for already-canonical values; defaults to "smart-prefer-main"
 *  when the input is undefined. */
export function normalizeMergeConflictStrategy(
  value: MergeConflictStrategy | undefined,
): CanonicalMergeConflictStrategy {
  switch (value) {
    case "smart":
      return "smart-prefer-branch";
    case "prefer-main":
      return "smart-prefer-main";
    case undefined:
      return "smart-prefer-main";
    default:
      return value;
  }
}

export const MERGE_STRATEGY_OVERLAP_BEHAVIORS = [
  "flip-to-prefer-branch",
  "warn-only",
  "ignore",
] as const;

export type MergeStrategyOverlapBehavior = (typeof MERGE_STRATEGY_OVERLAP_BEHAVIORS)[number];

export function normalizeMergeStrategyOverlapBehavior(
  value: unknown,
): MergeStrategyOverlapBehavior {
  return typeof value === "string"
    && (MERGE_STRATEGY_OVERLAP_BEHAVIORS as readonly string[]).includes(value)
    ? value as MergeStrategyOverlapBehavior
    : "flip-to-prefer-branch";
}

export const POST_MERGE_AUDIT_MODES = ["block", "warn", "off"] as const;

/** Controls how the merger reacts to a dirty post-merge audit (FN-4333). */
export type PostMergeAuditMode = (typeof POST_MERGE_AUDIT_MODES)[number];

export function normalizePostMergeAuditMode(value: unknown): PostMergeAuditMode {
  return typeof value === "string"
    && (POST_MERGE_AUDIT_MODES as readonly string[]).includes(value)
    ? (value as PostMergeAuditMode)
    : "block";
}

export const MERGE_AUDIT_AUTO_RECOVERY_MODES = ["deterministic-only", "programmatic", "ai-assisted", "off"] as const;

/** Controls how aggressively the merger tries to auto-recover from audit blocks (FN-4315). */
export type MergeAuditAutoRecoveryMode = (typeof MERGE_AUDIT_AUTO_RECOVERY_MODES)[number];

export function normalizeMergeAuditAutoRecovery(value: unknown): MergeAuditAutoRecoveryMode {
  return typeof value === "string"
    && (MERGE_AUDIT_AUTO_RECOVERY_MODES as readonly string[]).includes(value)
    ? (value as MergeAuditAutoRecoveryMode)
    : "ai-assisted";
}

export const MERGER_MODES = ["ai", "deterministic"] as const;

/**
 * Merge execution path (FN-5633).
 *  - "ai" (default): the standalone AI merge path — a clean-room worktree where
 *    an AI agent merges the task branch and an AI reviewer audits it (with
 *    corrective retries) before a fast-forward landing. Bypasses the legacy
 *    scaffolding entirely.
 *  - "deterministic": **DEPRECATED (master-plan U0, 2026-06-21) and INERT.** Once
 *    routed to the legacy `aiMergeTask` pipeline; now ignored — every merge uses
 *    the unified "ai" path (`runAiMerge`). The value is retained (not removed) to
 *    avoid a breaking `@runfusion/fusion` type change, and the engine logs a
 *    one-time deprecation warning when it observes a resolved "deterministic".
 *
 * FNXC:MergerUnification 2026-06-21-19:05: `merger.mode` is published surface, so
 * the type and the `MergerSettings.mode` field stay; only the "deterministic"
 * VALUE is deprecated/inert. Removing the type is a separate breaking change.
 */
export type MergerMode = (typeof MERGER_MODES)[number];

export function normalizeMergerMode(value: unknown): MergerMode {
  return typeof value === "string" && (MERGER_MODES as readonly string[]).includes(value)
    ? (value as MergerMode)
    : "ai";
}

/** Settings for the AI merge path (FN-5633). */
export interface MergerSettings {
  /**
   * Which merge path to use. Default: "ai".
   * @deprecated master-plan U0 (2026-06-21): the value is inert — every merge now
   * uses the unified AI merge path (`runAiMerge`). Field retained as published
   * surface; "deterministic" only triggers a one-time deprecation warning.
   */
  mode?: MergerMode;
  /** How many AI corrective rounds before landing the best result (advisory) or
   *  hard-failing (blocking). Default: 3. The reviewer uses the project's
   *  validator/reviewer model lane — there is no merge-specific model setting. */
  maxReviewPasses?: number;
  /** Dangerous compatibility escape hatch for the AI merge landing path.
   *  When true (default for resolved project settings), Fusion restores the legacy
   *  stash → fast-forward → restore behavior when the checked-out integration
   *  worktree is dirty. Set false to explicitly opt out and fail closed before
   *  unrelated local edits can be reintroduced after landing. */
  allowDirtyLocalCheckoutSync?: boolean;
}

export const AUTO_RECOVERY_MODES = ["off", "deterministic-only", "programmatic", "ai-assisted"] as const;

export type AutoRecoveryMode = (typeof AUTO_RECOVERY_MODES)[number];

export type AutoRecoveryFailureClass =
  | "file-scope-invariant"
  | "post-squash-audit-blocker"
  | "branch-cross-contamination"
  | "branch-conflict-tripwire"
  | "branch-conflict-recovery-exhausted"
  | "branch-conflict-unrecoverable"
  | "message-delivery-failure";

export interface AutoRecoverySettings {
  mode: AutoRecoveryMode;
  perClass?: Partial<Record<AutoRecoveryFailureClass, AutoRecoveryMode>>;
  maxRetries?: number;
}

export function normalizeAutoRecovery(value: unknown): AutoRecoverySettings {
  const fallback: AutoRecoverySettings = { mode: "deterministic-only", maxRetries: 3 };
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as {
    mode?: unknown;
    perClass?: unknown;
    maxRetries?: unknown;
  };
  const mode = typeof candidate.mode === "string" && (AUTO_RECOVERY_MODES as readonly string[]).includes(candidate.mode)
    ? candidate.mode as AutoRecoveryMode
    : fallback.mode;
  const perClass = typeof candidate.perClass === "object" && candidate.perClass
    ? Object.fromEntries(
      Object.entries(candidate.perClass as Record<string, unknown>)
        .filter(([k, v]) => (
          [
            "file-scope-invariant",
            "post-squash-audit-blocker",
            "branch-cross-contamination",
            "branch-conflict-tripwire",
            "branch-conflict-recovery-exhausted",
            "branch-conflict-unrecoverable",
            "message-delivery-failure",
          ].includes(k)
          && typeof v === "string"
          && (AUTO_RECOVERY_MODES as readonly string[]).includes(v)
        )),
    ) as Partial<Record<AutoRecoveryFailureClass, AutoRecoveryMode>>
    : undefined;
  const maxRetries = typeof candidate.maxRetries === "number" && Number.isFinite(candidate.maxRetries)
    ? Math.max(0, Math.floor(candidate.maxRetries))
    : fallback.maxRetries;

  return { mode, perClass, maxRetries };
}
/** Policy for handling task execution when the selected node is unavailable/unhealthy. */
export type UnavailableNodePolicy = "block" | "fallback-local";

export type OwningNodeHandoffPolicy = "block" | "reassign-to-local" | "reassign-any-healthy";

export interface ModelPreset {
  id: string;
  name: string;
  executorProvider?: string;
  executorModelId?: string;
  validatorProvider?: string;
  validatorModelId?: string;
}

/** A reusable workflow step definition that can run after task implementation. */
/** Execution mode for a workflow step. */
export type WorkflowStepMode = "prompt" | "script";
export type WorkflowStepToolMode = "readonly" | "coding";
export type WorkflowStepGateMode = "gate" | "advisory";

/** Lifecycle phase for workflow step execution. */
export type WorkflowStepPhase = "pre-merge" | "post-merge";

export interface WorkflowStep {
  /** Unique identifier (e.g., "WS-001") */
  id: string;
  /** Built-in template source ID when this step was materialized from a template. */
  templateId?: string;
  /** Display name (e.g., "Documentation Review") */
  name: string;
  /** Short description for UI display */
  description: string;
  /** Execution mode — "prompt" runs an AI agent, "script" runs a named project script */
  mode: WorkflowStepMode;
  /** Lifecycle phase — "pre-merge" runs before merge (default), "post-merge" runs after merge success */
  phase?: WorkflowStepPhase;
  /** Gate behavior — gate blocks merge/auto-revive on failure, advisory records non-blocking findings. */
  gateMode: WorkflowStepGateMode;
  /** Full agent prompt to execute when this step runs (used when mode is "prompt") */
  prompt: string;
  /** Tool set available to prompt-mode workflow agents. Defaults to readonly. */
  toolMode?: WorkflowStepToolMode;
  /** Name of a skill to load into this step's session (e.g.
   *  "compound-engineering:ce-work"). When set, the step session loads the named
   *  skill (discovery + selection) and the engine injects the Fusion workflow-step
   *  conventions preamble. Only meaningful for skill-executor graph nodes. */
  skillName?: string;
  /**
   * Browser capability requested by prompt-mode steps. When true, the executor
   * loads the agent-browser navigation skill when available, preflights the
   * `agent-browser` CLI, and records browser-verification activity in the agent
   * log. Ignored for script-mode steps.
   */
  requiresBrowser?: boolean;
  /** Name of a script from project settings `scripts` map to execute (required when mode is "script") */
  scriptName?: string;
  /** Whether this step is available for selection on new tasks */
  enabled: boolean;
  /** When true, this step is automatically pre-selected when creating new tasks.
   *  Users can still deselect it — this only controls the initial default state. */
  defaultOn?: boolean;
  /** AI model provider override for the workflow step agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. Only used when mode is "prompt". */
  modelProvider?: string;
  /** AI model ID override for the workflow step agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. Only used when mode is "prompt". */
  modelId?: string;
  /** (workflow-editor-consolidation U1/U2, KTD-1/KTD-3) when this legacy step has
   *  been migrated into a fragment WorkflowDefinition, the fragment's id is stamped
   *  here so the lazy step migration is idempotent (already-stamped rows are
   *  skipped). Stored in the `migrated_fragment_id` column. */
  migratedFragmentId?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input for creating a new workflow step. */
/** Event types that can trigger ntfy notifications */
export type NtfyNotificationEvent =
  | "in-review"
  | "merged"
  | "failed"
  | "awaiting-approval"
  | "awaiting-user-review"
  | "planning-awaiting-input"
  | "cli-agent-awaiting-input"
  | "gridlock"
  | "board-stall-unrecovered"
  | "db-corruption-detected"
  | "fallback-used"
  | "memory-dreams-processed"
  | "token-budget"
  | "message:agent-to-user"
  | "message:agent-to-agent"
  | "message:room"
  | "oauth-token-expired"
  | "task-created"
  | "workflow-notify";

/** Known notification event types. Providers may support additional custom events. */
export const NOTIFICATION_EVENTS = [
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
  /*
   * FNXC:ToolPermissionNotifications 2026-06-27-00:00:
   * CLI tool-permission requests are a distinct user-facing notification event from plan approval. Operators must be able to enable external alerts when a terminal-backed agent waits for human input.
   */
  "cli-agent-awaiting-input",
  "gridlock",
  "board-stall-unrecovered",
  "db-corruption-detected",
  "fallback-used",
  "memory-dreams-processed",
  "token-budget",
  "message:agent-to-user",
  "message:agent-to-agent",
  "message:room",
  "oauth-token-expired",
  "task-created",
  "workflow-notify",
] as const;

/** Notification event type. Known events plus provider-specific custom events. */
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number] | (string & {});

/** Standard payload shape shared across notification providers. */
export interface NotificationPayload {
  taskId?: string;
  taskTitle?: string;
  taskDescription?: string;
  event: NotificationEvent;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/** Declarative notification provider configuration persisted in settings. */
export interface NotificationProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CustomProvider {
  id: string;
  name: string;
  apiType: "openai-compatible" | "anthropic-compatible" | "google-generative-ai" | "openai-responses";
  baseUrl: string;
  apiKey?: string;
  /**
   * OpenAI-compatible opt-in for providers that explicitly support the `developer` role.
   * Omitted/false forces legacy `system` role emission to avoid provider 400s.
   */
  supportsDeveloperRole?: boolean;
  models?: { id: string; name: string }[];
}

export interface WorkflowStepInput {
  /** Built-in template source ID when creating a concrete step from a template. */
  templateId?: string;
  name: string;
  description: string;
  /** Execution mode — defaults to "prompt" if not specified */
  mode?: WorkflowStepMode;
  /** Lifecycle phase — defaults to "pre-merge" if not specified */
  phase?: WorkflowStepPhase;
  /** Gate behavior — defaults by mode (prompt: advisory, script: gate) when omitted. */
  gateMode?: WorkflowStepGateMode;
  /** Agent prompt (used when mode is "prompt"). Optional — can be AI-generated later via refinement. */
  prompt?: string;
  /** Tool set available to prompt-mode workflow agents. Defaults to readonly. */
  toolMode?: WorkflowStepToolMode;
  /** Name of a skill to load into this step's session (e.g.
   *  "compound-engineering:ce-work"). See `WorkflowStep.skillName`. */
  skillName?: string;
  /** Script name from project settings (required when mode is "script").
   *  Must reference a named script in `settings.scripts` — no raw commands. */
  scriptName?: string;
  /** Defaults to true if not specified */
  enabled?: boolean;
  /** When true, this step is automatically pre-selected when creating new tasks.
   *  Users can still deselect — this only controls the initial default state. */
  defaultOn?: boolean;
  /** AI model provider override. Must be set together with modelId. Only used when mode is "prompt". */
  modelProvider?: string;
  /** AI model ID override. Must be set together with modelProvider. Only used when mode is "prompt". */
  modelId?: string;
  /** (workflow-editor-consolidation U2, KTD-3) fragment id stamped when this step
   *  was migrated into a fragment WorkflowDefinition. Set by the migration only. */
  migratedFragmentId?: string;
}

/** Result of a workflow step execution on a task. */
export interface WorkflowStepResult {
  /** ID of the workflow step that ran (e.g., "WS-001") */
  workflowStepId: string;
  /** Name of the workflow step at execution time */
  workflowStepName: string;
  /** Lifecycle phase at execution time */
  phase?: WorkflowStepPhase;
  /** Runtime source for distinguishing graph-authored node progress from optional-toggle checks. */
  source?: "optional-group" | "node";
  /** Execution status */
  status: "passed" | "failed" | "advisory_failure" | "skipped" | "pending";
  /** Output from the workflow step agent (findings, errors, etc.) */
  output?: string;
  /**
   * Machine-readable verdict from prompt-mode structured output.
   * Absent for script-mode steps and legacy prose-only prompt outputs.
   */
  verdict?: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE";
  /**
   * Optional notes from prompt-mode structured output.
   * Absent for script-mode steps and legacy prose-only prompt outputs.
   */
  notes?: string;
  /** ISO-8601 timestamp when the step started */
  startedAt?: string;
  /** ISO-8601 timestamp when the step completed */
  completedAt?: string;
}

/**
 * Lifecycle status of one persisted step instance (step-inversion U4, KTD-6).
 * - `pending` — expanded but not yet started.
 * - `in-progress` — actively executing inside its foreach sub-walk.
 * - `awaiting-integration` — work complete on a parallel-mode branch, waiting
 *   for the ordered integration stage (KTD-11; unused at concurrency 1).
 * - `completed` — terminal success (integrated in parallel mode).
 * - `failed` — terminal failure.
 */
export type WorkflowRunStepInstanceStatus =
  | "pending"
  | "in-progress"
  | "awaiting-integration"
  | "completed"
  | "failed";

/**
 * Persisted run-state for one expanded step instance inside a foreach region
 * (step-inversion U4, KTD-6). One row per `(taskId, runId, foreachNodeId,
 * stepIndex)`; mirrors the `workflow_run_branches` posture. Resume reconstructs
 * the instance set from `pinnedStepCount` + per-instance `currentNodeId` /
 * `reworkCount`. `baselineSha` / `checkpointId` are the RETHINK reset anchors
 * (previously in-memory, lost on restart). `branchName` / `integratedAt` and the
 * `awaiting-integration` status serve parallel mode (KTD-11); null/unused at
 * concurrency 1. This is the core row shape; the engine-side instance model is
 * separate and engine-owned.
 */
export interface WorkflowRunStepInstance {
  taskId: string;
  runId: string;
  /** Node id of the foreach region that expanded this instance. */
  foreachNodeId: string;
  /** Zero-based index of the step this instance runs. */
  stepIndex: number;
  /** Step count pinned at expansion; resume fails on mismatch with live steps[]. */
  pinnedStepCount: number;
  /** Current sub-walk node id for the in-flight instance; null when not started. */
  currentNodeId?: string | null;
  status: WorkflowRunStepInstanceStatus;
  /** Git sha the RETHINK reset rewinds to; null when no baseline captured. */
  baselineSha?: string | null;
  /** Session checkpoint to rewind to on RETHINK; null when none captured. */
  checkpointId?: string | null;
  /** Number of rework cycles consumed against the rework budget. */
  reworkCount: number;
  /** Per-instance branch name in worktree-isolation mode (KTD-11); null otherwise. */
  branchName?: string | null;
  /** ISO-8601 timestamp the instance branch was integrated (KTD-11); null otherwise. */
  integratedAt?: string | null;
  /** ISO-8601 timestamp of the last write to this row. */
  updatedAt: string;
}

/*
FNXC:WorkflowStepTemplate 2026-06-25-00:00:
U6 deleted the built-in step-template catalog array (the former value export). The
`WorkflowStepTemplate` SHAPE is KEPT because plugin-contributed step templates still use
it (they feed the
workflow-editor optional-group palette via `getPluginWorkflowStepTemplates`). It is no
longer backed by any built-in catalog: the former built-in `browser-verification` /
`code-review` literals now live inlined in their optional-group node builders
(`builtin-browser-verification-group.ts` / `builtin-code-review-group.ts`).
*/
/** A workflow step template shape used by plugin-contributed steps (palette entries). */
export interface WorkflowStepTemplate {
  /** Unique template identifier (e.g., "documentation-review") */
  id: string;
  /** Display name (e.g., "Documentation Review") */
  name: string;
  /** Short description for UI */
  description: string;
  /** Full agent prompt template */
  prompt: string;
  /** Execution mode for plugin-contributed templates; defaults to prompt. */
  mode?: WorkflowStepMode;
  /** Task lifecycle phase for plugin-contributed templates; defaults to pre-merge. */
  phase?: "pre-merge" | "post-merge";
  /** Script name for script-mode plugin templates. */
  scriptName?: string;
  /** Tool set available when the template runs as a prompt-mode step. */
  toolMode?: WorkflowStepToolMode;
  /** Failure behavior for materialized steps from this template. */
  gateMode?: WorkflowStepGateMode;
  /** Whether this template should be auto-selected for new tasks. */
  defaultOn?: boolean;
  /** AI model provider override for prompt-mode templates. */
  modelProvider?: string;
  /** AI model ID override for prompt-mode templates. */
  modelId?: string;
  /** Grouping category (e.g., "Quality", "Security") */
  category: string;
  /** Optional icon identifier for UI (e.g., "file-text", "shield") */
  icon?: string;
  /** Optional default enabled state for plugin-provided templates. */
  enabled?: boolean;
}

export type PrConflictState = "clean" | "conflicting" | "behind" | "blocked" | "unknown";

export interface PrConflictDiagnostics {
  conflictingFiles: string[];
  suggestedCommands: string[];
  capturedAt: string;
}

export interface PrInfo {
  url: string;
  number: number;
  status: PrStatus;
  title: string;
  headBranch: string;
  baseBranch: string;
  commentCount: number;
  isDraft?: boolean;
  draft?: boolean;
  /**
   * FNXC:PrAutoMergeGate 2026-06-28-00:33:
   * FN-7182: `true` means this PR was created or linked by the dashboard Create PR action as an explicit human handoff.
   * Pipeline PR-merge-strategy PRs leave this unset so automatic PR-mode merging keeps working. PrInfo is persisted as JSON, so this provenance flag needs no SQLite migration.
   */
  manual?: boolean;
  autoMergeOnGreen?: boolean;
  autoMergeStrategy?: "merge" | "squash" | "rebase";
  lastMergeError?: string;
  lastMergeErrorAt?: string;
  checkRollup?: "success" | "failure" | "pending" | "none";
  mergeable?: PrConflictState;
  conflictDiagnostics?: PrConflictDiagnostics;
  lastCommentAt?: string;
  lastCheckedAt?: string;
  lastReviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

export type IssueState = "open" | "closed";

export interface IssueInfo {
  url: string;
  number: number;
  state: IssueState;
  title: string;
  stateReason?: "completed" | "not_planned" | "reopened";
  lastCheckedAt?: string;
}

export interface TaskGithubTrackedIssue {
  owner: string;
  repo: string;
  number: number;
  url: string;
  nodeId?: string;
  createdAt: string;
  lastSyncedAt?: string;
}

export type GithubIssueAction = "close" | "delete" | "leave" | "auto";

export type GitLabTrackedItemKind = "project_issue" | "group_issue" | "merge_request";

/*
FNXC:GitLabTracking 2026-07-02-00:00:
GitLab tracking is a first-class task contract instead of overloading GitHub tracking because GitLab items can come from GitLab.com or self-managed instances and may be project issues, group issues, or merge requests. Store only public metadata and stale/link timestamps; never persist GitLab tokens here.
*/
export interface TaskGitLabTrackedItem {
  /** GitLab work item kind imported or linked to this task. */
  kind: GitLabTrackedItemKind;
  /** Canonical browser URL for GitLab.com or a self-managed GitLab instance. */
  url: string;
  /** GitLab web instance/base URL, for example https://gitlab.com or a self-managed host. */
  instanceUrl: string;
  /** Parsed host for compact display/dedup diagnostics. */
  host: string;
  /** GitLab IID visible inside a project or group namespace. */
  iid: number;
  /** Optional global GitLab database id when import APIs supplied it. */
  id?: number;
  /** Project numeric id when the item belongs to a concrete project. */
  projectId?: number;
  /** Project path with namespace, when available from import or URL parsing. */
  projectPath?: string;
  /** Group id/path for group-issue searches where GitLab returns a group-scoped source. */
  groupId?: number | string;
  groupPath?: string;
  /** Optional display title and live state snapshot; these are staleable metadata, not auth state. */
  title?: string;
  state?: string;
  createdAt: string;
  linkedAt?: string;
  lastSyncedAt?: string;
  staleAt?: string;
  staleReason?: string;
}

export interface TaskGitLabTracking {
  /** Per-task linked GitLab metadata. Separate from GitHub tracking because GitLab supports GitLab.com plus self-managed project/group/MR URLs without GitHub issue semantics. */
  item?: TaskGitLabTrackedItem;
  /** ISO-8601 of the most recent manual unlink, retained for audit. */
  unlinkedAt?: string;
}

export interface TaskGithubTracking {
  /** Per-task enabled override. When undefined, project/global default applies. */
  enabled?: boolean;
  /** "owner/repo" override; when undefined, project/global default repo applies. */
  repoOverride?: string;
  /** Linked GitHub issue. Set after issue creation succeeds. Cleared via unlinkGithubIssue(). */
  issue?: TaskGithubTrackedIssue;
  /** ISO-8601 of the most recent manual unlink, retained for audit. */
  unlinkedAt?: string;
}

/**
 * Durable provenance metadata for tasks imported from external issue trackers.
 *
 * Distinct from {@link IssueInfo}, which captures live issue status snapshots.
 * This contract stores source identity so the originating issue can be
 * re-associated even when live status is unavailable.
 */
export interface TaskSourceIssue {
  /** Issue provider key (for example: "github", "gitlab", "jira"). */
  provider: string;
  /** Repository/project identifier in provider-specific canonical form. */
  repository: string;
  /** Stable provider-specific external issue identifier (string to support non-numeric IDs). */
  externalIssueId: string;
  /** Human-visible issue number in the source tracker. */
  issueNumber: number;
  /** Optional canonical URL to the source issue. */
  url?: string;
  /**
   * FNXC:GithubSourceIssueAnalytics 2026-06-18-17:56:
   * Command Center "Fixed by Fusion" analytics need the real source-issue closure time when Fusion closed or observed the issue, replacing the prior `updatedAt` completion approximation when exact data is available.
   * ISO-8601 timestamp for when the source issue was closed; absent when the issue has never been observed closed.
   */
  closedAt?: string;
}

export interface BatchStatusRequest {
  taskIds: string[];
}

export interface BatchStatusEntry {
  issueInfo?: IssueInfo;
  prInfo?: PrInfo;
  prInfos?: PrInfo[];
  stale: boolean;
  error?: string;
}

export type BatchStatusResult = Record<string, BatchStatusEntry>;

export interface BatchStatusResponse {
  results: BatchStatusResult;
}

export type StepStatus = "pending" | "in-progress" | "done" | "skipped";

export interface TaskStep {
  name: string;
  status: StepStatus;
  /**
   * Step-inversion (KTD-11): 0-indexed indices of steps this step depends on,
   * parsed from the PROMPT.md `### Step N (depends: 1,2): Title` annotation
   * or structured parser output (1-indexed step numbers in authored content →
   * 0-indexed indices here).
   *
   * FNXC:WorkflowSteps 2026-06-29-17:52:
   * Absence and emptiness are different planner contracts. Absent means unannotated and therefore implicitly depends on the previous step; an explicit empty array means this step has no dependencies and may run as a parallel root.
   */
  dependsOn?: number[];
}

/** Correlation metadata linking a task mutation to the agent run that caused it. */
export interface RunMutationContext {
  /** The heartbeat run ID that initiated this mutation. */
  runId: string;
  /** The agent ID that performed the mutation. */
  agentId: string;
  /** Optional invocation source of the run (e.g., "on_demand", "timer", "assignment"). */
  source?: string;
}

export interface TaskLogEntry {
  timestamp: string;
  action: string;
  outcome?: string;
  /** Correlation metadata linking this entry to the agent run that produced it. */
  runContext?: RunMutationContext;
}

export type WorkflowTransitionNotificationKind =
  | "manual-merge-hold"
  | "recovery-requeue";

export interface WorkflowTransitionNotificationMarker {
  kind: WorkflowTransitionNotificationKind;
  column: ColumnId;
  transitionId: string;
  nodeId?: string;
  reason?: string;
  createdAt: string;
}

export type ActivityEventType =
  | "task:created"
  | "task:moved"
  | "task:updated"
  | "task:deleted"
  | "task:merged"
  | "task:failed"
  | "task:duplicate-warning-overridden"
  | "task:auto-archived-deterministic-duplicate"
  | "task:auto-archived-near-duplicate"
  | "task:near-duplicate-flagged"
  /** FNXC:ReleaseAuthorizationGate 2026-06-15-02:44: Release-class tasks parked by triage need a distinct activity so operators can see that explicit user approval is required before dispatch. */
  | "task:release-authorization-required"
  | "task:auto-archived-ghost-bug"
  | "task:auto-archived-duplicate"
  | "task:merge-worktree-reacquired"
  | "settings:updated"
  | "project:isolation-transition";

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  type: ActivityEventType;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** The set of agent roles that produce log entries. */
export type AgentRole = "triage" | "executor" | "reviewer" | "merger";

/** The discriminator for agent log entry types. */
export type AgentLogType = "text" | "tool" | "thinking" | "tool_result" | "tool_error";

/** A single chunk of agent output persisted to disk (JSONL in agent.log). */
export interface AgentLogEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** The task this log entry belongs to. */
  taskId: string;
  /** The text content (delta for "text"/"thinking", tool name for "tool"/"tool_result"/"tool_error"). */
  text: string;
  /** The kind of entry — text delta, tool invocation marker, thinking block, tool result, or tool error. */
  type: AgentLogType;
  /** For tool entries: human-readable summary of tool args (e.g. file path, command).
   *  For tool_result/tool_error: summary of the result or error message. */
  detail?: string;
  /** Which agent produced this entry. Absent in logs written before this field was added. */
  agent?: AgentRole;
  /** Request/tool processing duration in milliseconds. Absent for legacy rows and entries without bounded timing. */
  durationMs?: number;
  /** Time to first visible model output in milliseconds. Absent after the first visible output and on legacy rows. */
  timeToFirstTokenMs?: number;
}

/** How much of `.fusion/tasks/{ID}/agent.log` is copied into cold archive storage. */
export type ArchiveAgentLogMode = "none" | "compact" | "full";

export interface TaskAttachment {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface SteeringComment {
  id: string;
  text: string;
  createdAt: string;
  author: "user" | "agent";
}

export interface TaskComment {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
  source?: "user" | "agent" | "github-review" | "github-review-comment";
  externalId?: string;
  reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
}

export interface TaskCommentInput {
  text: string;
  author: string;
}

export type TaskReviewMode = "pull-request" | "direct";
export type TaskReviewSource = "github-pr" | "reviewer-agent";
export type TaskReviewDecision = "approved" | "changes-requested" | "commented" | "pending";
export type TaskReviewVerdict = "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
export type TaskReviewerType = "plan" | "code";
export type TaskReviewItemStatus = "queued" | "in-progress" | "addressed" | "failed";

export interface LegacyTaskReviewItem {
  id: string;
  source: TaskReviewSource;
  status: TaskReviewItemStatus;
  summary: string;
  body?: string;
  filePath?: string;
  line?: number;
  commentUrl?: string;
  reviewer?: string;
  createdAt: string;
  updatedAt: string;
  addressedAt?: string;
  failedReason?: string;
}

export interface TaskReview {
  mode: TaskReviewMode;
  source: TaskReviewSource;
  decision: TaskReviewDecision;
  summary?: string;
  latestRefreshAt?: string;
  selectedItemIds?: string[];
  items: LegacyTaskReviewItem[];
}

export type PrCheckState =
  | "success"
  | "pending"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure";

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: PrCheckState;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskReviewAuthor {
  login: string;
}

export interface PrTaskReviewSummaryReviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
  submittedAt?: string;
}

export interface PrTaskReviewSummary {
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers: PrTaskReviewSummaryReviewer[];
  blockingReasons: string[];
  checks: PrCheckStatus[];
}

export interface TaskReviewStateItem {
  id: string;
  threadId?: string;
  githubCommentId?: number;
  path?: string;
  diffSide?: string;
  body: string;
  author: TaskReviewAuthor;
  createdAt: string;
  updatedAt?: string;
  state?: string;
  htmlUrl?: string;
  isResolved?: boolean;
  source?: TaskReviewSource;
  reviewType?: TaskReviewerType;
  verdict?: TaskReviewVerdict;
  step?: number;
  summary?: string;
}

export type ReviewAddressingStatus = "queued" | "in-progress" | "addressed" | "failed";

export interface ReviewAddressingSnapshot {
  itemId: string;
  sourceMode: "pull-request" | "reviewer-agent";
  source: "pr-review" | "reviewer-agent";
  summary: string;
  body: string;
  authorLogin?: string;
  filePath?: string;
  lineNumber?: number;
  threadId?: string;
  url?: string;
}

export interface ReviewAddressingRecord {
  itemId: string;
  status: ReviewAddressingStatus;
  selectedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  stale?: boolean;
  snapshot?: ReviewAddressingSnapshot;
}

export interface ReviewerTaskReviewSummary {
  verdict?: TaskReviewVerdict;
  reviewType?: TaskReviewerType;
  summary?: string;
}

export type TaskReviewRefreshSource = "manual" | "auto" | "initial-load";
export type TaskReviewRefreshStatus = "idle" | "refreshing" | "ready" | "error";

export interface TaskReviewState {
  source: "pull-request" | "reviewer-agent";
  lastRefreshedAt?: string;
  refreshSource?: TaskReviewRefreshSource;
  refreshStatus?: TaskReviewRefreshStatus;
  refreshError?: string;
  summary?: PrTaskReviewSummary | ReviewerTaskReviewSummary;
  items: TaskReviewStateItem[];
  addressing: ReviewAddressingRecord[];
}

export interface TaskReviewSummary {
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers?: PrTaskReviewSummaryReviewer[];
  blockingReasons?: string[];
  checks?: PrCheckStatus[];
  verdict?: TaskReviewVerdict;
  reviewType?: TaskReviewerType;
  summary?: string;
}

export interface TaskReviewDataItem {
  itemId: string;
  sourceMode: "pull-request" | "reviewer-agent";
  title: string;
  body: string;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  url?: string;
  filePath?: string;
  line?: number;
  threadId?: string;
  reviewState?: string | null;
  isResolved?: boolean;
  progressStatus?: "queued" | "in-progress" | "addressed" | "failed" | null;
}

export type TaskReviewItem = TaskReviewDataItem;

export interface TaskReviewData {
  mode: "pull-request" | "reviewer-agent";
  refreshable: boolean;
  fetchedAt: string | null;
  summary: TaskReviewSummary | null;
  items: TaskReviewItem[];
}

export interface TaskDocument {
  /** UUID primary key */
  id: string;
  /** Task this document belongs to */
  taskId: string;
  /** Document key (e.g., "plan", "notes", "research"). Alphanumeric, hyphens, underscores. */
  key: string;
  /** Document body content */
  content: string;
  /** Monotonically increasing revision number (starts at 1) */
  revision: number;
  /** Who created/last-edited this revision: "user" | "agent" | "system" */
  author: string;
  /** Optional extensible metadata (JSON object) */
  metadata?: Record<string, unknown>;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-update timestamp */
  updatedAt: string;
}

export interface TaskDocumentRevision {
  /** Auto-increment row ID */
  id: number;
  /** Task this revision belongs to */
  taskId: string;
  /** Document key */
  key: string;
  /** Snapshot of document content at this revision */
  content: string;
  /** Revision number of this snapshot */
  revision: number;
  /** Author who created this revision */
  author: string;
  /** Optional metadata snapshot */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp when this revision was archived */
  createdAt: string;
}

export interface TaskDocumentCreateInput {
  /** Document key. Must match /^[a-zA-Z0-9_-]{1,64}$/ */
  key: string;
  /** Document body content */
  content: string;
  /** Author (defaults to "user" if not provided) */
  author?: string;
  /** Optional extensible metadata */
  metadata?: Record<string, unknown>;
}

/**
 * TaskDocument extended with its parent task metadata for display in the documents view.
 */
export interface TaskDocumentWithTask extends TaskDocument {
  /** Title of the parent task */
  taskTitle?: string;
  /** Description of the parent task */
  taskDescription?: string;
  /** Column of the parent task (e.g., "triage", "todo", "in-progress", "done", "in-review", "archived") */
  taskColumn?: string;
}

/** Supported artifact media classes for the persisted artifact registry. */
export type ArtifactType = "document" | "image" | "video" | "audio" | "other";

/**
 * FNXC:ArtifactRegistry 2026-06-19-22:04:
 * Agents need a first-class registry for multi-type artifacts that are visible across agents and tasks. Store binary media on disk and persist only metadata plus relative URIs in SQLite so query paths stay lightweight and never inline binary bytes.
 */
export interface Artifact {
  /** UUID primary key */
  id: string;
  /** Artifact media class used for filtering and presentation */
  type: ArtifactType;
  /** Human-readable artifact title */
  title: string;
  /** Optional longer description or caption */
  description?: string;
  /** Optional MIME type for inline text or binary media */
  mimeType?: string;
  /** Optional content size in bytes, set from binary data when persisted on disk */
  sizeBytes?: number;
  /** Relative stored path; task artifacts are anchored at the task dir, while task-less registry artifacts are anchored at `.fusion/` */
  uri?: string;
  /** Optional inline text body for text/document artifacts */
  content?: string;
  /** Agent, user, or system identifier that registered the artifact */
  authorId: string;
  /** Class of actor that registered the artifact */
  authorType: "agent" | "user" | "system";
  /** Optional task this artifact is associated with */
  taskId?: string;
  /** Optional extensible metadata (JSON object) */
  metadata?: Record<string, unknown>;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-update timestamp */
  updatedAt: string;
}

export interface ArtifactCreateInput {
  /** Artifact media class used for filtering and presentation */
  type: ArtifactType;
  /** Human-readable artifact title */
  title: string;
  /** Optional longer description or caption */
  description?: string;
  /** Optional MIME type for inline text or binary media */
  mimeType?: string;
  /** Optional content size in bytes for inline or externally referenced content */
  sizeBytes?: number;
  /** Optional relative URI when content is already stored outside SQLite */
  uri?: string;
  /** Optional inline text body for text/document artifacts */
  content?: string;
  /** Agent, user, or system identifier registering the artifact */
  authorId: string;
  /** Class of actor registering the artifact */
  authorType: "agent" | "user" | "system";
  /** Optional task this artifact is associated with */
  taskId?: string;
  /** Optional extensible metadata (JSON object) */
  metadata?: Record<string, unknown>;
  /** Optional binary payload; the store persists it on disk and records a relative URI */
  data?: Buffer;
}

/** Artifact extended with optional parent task metadata for cross-task registry views. */
export interface ArtifactWithTask extends Artifact {
  /** Title of the parent task */
  taskTitle?: string;
  /** Description of the parent task */
  taskDescription?: string;
  /** Column of the parent task (e.g., "triage", "todo", "in-progress", "done", "in-review", "archived") */
  taskColumn?: string;
}

/**
 * Goal-citation Slice 2 success-signal surfaces where goal IDs are extracted.
 */
export type GoalCitationSurface = "agent_log" | "task_document";

/**
 * A unique extracted goal ID and the index of its first appearance in source text.
 */
export interface GoalCitationMatch {
  goalId: string;
  index: number;
}

/**
 * Input payload for recording a single observed goal citation in the Slice 2 success-signal trail.
 * `snippet` must be a bounded source-text substring (≤200 chars), never the full source body.
 */
export interface GoalCitationInput {
  goalId: string;
  agentId: string;
  taskId?: string;
  surface: GoalCitationSurface;
  sourceRef: string;
  snippet: string;
  timestamp?: string;
}

/**
 * Persisted goal-citation audit row used to measure Slice 2 anchoring success signal.
 * `snippet` is always a bounded substring (≤200 chars), not full source content.
 */
export interface GoalCitation extends Required<Pick<GoalCitationInput, "goalId" | "agentId" | "surface" | "sourceRef" | "snippet">> {
  id: number;
  taskId?: string;
  timestamp: string;
}

/**
 * Filter contract for querying goal-citation success-signal rows across scanned surfaces.
 * Snippet payloads remain bounded substrings (≤200 chars) of original text.
 */
export interface GoalCitationFilter {
  goalId?: string;
  agentId?: string;
  taskId?: string;
  surface?: GoalCitationSurface;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export const DOCUMENT_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Shared GitHub owner/repo slug validation for repo override inputs. */
export const REPO_OVERRIDE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function validateDocumentKey(key: string): void {
  if (!DOCUMENT_KEY_RE.test(key)) {
    throw new Error(
      `Invalid document key: "${key}". Must be 1-64 characters: letters, digits, hyphens, or underscores.`,
    );
  }
}

/** Build canonical research enrichment document key from a run id. */
export function buildResearchDocumentKey(runId: string): string {
  const sanitizedRunId = runId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!sanitizedRunId) {
    throw new Error("Invalid research run id: sanitized run id is empty");
  }
  const key = `research-${sanitizedRunId}`;
  validateDocumentKey(key);
  return key;
}

export interface MergeDetails {
  commitSha?: string;
  /**
   * When merger used rebase strategy (>=2 substantive commits), this is the
   * parent SHA on the target branch before the cherry-pick chain. The canonical
   * rebase display/audit range is `rebaseBaseSha..commitSha`.
   * Unset for squash merges.
   */
  rebaseBaseSha?: string;
  /**
   * Authoritative landed file set on the merge target:
   * - squash: files touched by the final recorded squash commit
   * - rebase/cherry-pick: files touched across `rebaseBaseSha..commitSha`
   *
   * This differs from `Task.modifiedFiles`, which is an executor pre-merge
   * worktree snapshot and can include in-flight files later reverted before
   * landing.
   */
  landedFiles?: string[];
  /**
   * Shortstat file count of the final recorded merge/squash commit only.
   * For multi-commit task lineage this can undercount landed scope.
   * Use `/api/tasks/:id/diff` for lineage-backed landed totals.
   * Decision (FN-4647): this remains commit-level metadata; no separate
   * persisted lineage-level summary is added at this time.
   */
  filesChanged?: number;
  /**
   * Shortstat insertion count of the final recorded merge/squash commit only.
   * Use `/api/tasks/:id/diff` for lineage-backed landed totals.
   */
  insertions?: number;
  /**
   * Shortstat deletion count of the final recorded merge/squash commit only.
   * Use `/api/tasks/:id/diff` for lineage-backed landed totals.
   */
  deletions?: number;
  /**
   * True when rebase-strategy capture found zero commits attributable to this
   * task — the branch's work was already on main (verified-short-circuit /
   * already-on-main path). When true, `landedFiles` will be `[]` and stats
   * will be 0. Squash-strategy merges never set this flag.
   */
  noOpVerifiedShortCircuit?: boolean;
  /**
   * True when `landedFiles` / `filesChanged` / `insertions` / `deletions` were
   * captured from task-attributable commits only (rebase-strategy success path
   * via `filterFilesToOwnTaskCommits`). Self-healing `recoverDoneTaskMergeMetadata`
   * must NOT overwrite these values with the full `rebaseBaseSha..sha` range,
   * which would re-inflate them.
   */
  landedFilesAttributionRestricted?: boolean;
  /**
   * Set ONLY when `filterFilesToOwnTaskCommits` threw and the merger fell back
   * to the legacy unrestricted `<rebaseBaseSha>..<sha>` walk. Stored
   * `landedFiles` / stats may include foreign commits; this flag opts
   * self-healing back into reconcile (the inflated values are NOT intentional).
   * Never set on success paths.
   */
  landedFilesCaptureFallback?: "attribution-failed";
  mergeCommitMessage?: string;
  mergedAt?: string;
  mergeConfirmed?: boolean;
  noOpMerge?: boolean;
  noOpReason?: string;
  prNumber?: number;
  mergeTargetBranch?: string;
  mergeTargetSource?: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main";
  resolutionStrategy?: "ai" | "auto-resolve" | "theirs" | "ours" | "abort" | "orphan-discard-no-op";
  resolutionMethod?: "ai" | "auto" | "mixed" | "theirs" | "ours" | "abort";
  attemptsMade?: 1 | 2 | 3;
  autoResolvedCount?: number;
  /**
   * FN-4811 follow-up: persisted record of a done-task finalize-integrity warning.
   * When set, the periodic integrity sweep skips re-emitting the same warning across
   * engine restarts — the in-memory `finalizeUnprovenWarned` Set is volatile and would
   * otherwise spam the log every time the sweep ran on a fresh process.
   *
   * `warnedAt` is the ISO timestamp of the first warning; `reason` is the classifier
   * reason (e.g. "missing-evidence", "foreign-start-point", "no-owned-commit-foreign-deltas").
   * Clear this field when the task evidence is later proven (e.g., via
   * `task:integrity-reconcile-modified-files` repair path).
   */
  integrityWarning?: {
    warnedAt: string;
    reason: string;
  };
  /**
   * FN-5627 follow-up: counts how many times self-healing
   * `recoverTransientMergeFailures` has reset this task's `mergeRetries` and
   * re-enqueued it after a transient merge failure (e.g., `target-not-queued`
   * lease handoff race, or a misclassified same-SHA spurious concurrent-advance
   * left over from pre-FN-5627 code paths). Bounded by `MAX_TRANSIENT_MERGE_RECOVERIES`
   * (2) to avoid infinite recovery loops on genuinely-stuck tasks. Distinct from
   * `task.mergeRetries`, which counts in-cycle aiMergeTask retries.
   */
  transientRecoveryCount?: number;
  /**
   * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
   * Workspace-mode aggregate landed map: sub-repo relative path → the squash sha
   * that landed on that repo's local integration ref. Set ONLY by
   * `landWorkspaceTask`'s finalize-once after EVERY acquired repo's landed
   * predicate holds; the task-level `commitSha` points at one representative
   * landed sha (the first sorted landed repo) so the existing `task:merged`
   * consumer (which reads `mergeDetails.commitSha`) is satisfied. Empty/absent
   * for single-repo tasks.
   */
  workspaceLandedShas?: Record<string, string>;
}

/** Represents an agent's checkout lease on a task. */
export interface CheckoutLease {
  /** The agent ID that holds the lease */
  agentId: string;
  /** ISO-8601 timestamp when the lease was acquired */
  checkedOutAt: string;
}

export interface CheckoutClaimContext {
  /** Node identity for the claimant. */
  nodeId: string;
  /** Owning run/session ID when known. */
  runId?: string;
  /** Expected current lease epoch for renewal operations. */
  leaseEpoch?: number;
  /** ISO-8601 timestamp for lease-renewed heartbeat updates. */
  renewedAt?: string;
}

export interface CheckoutClaimPrecondition {
  /** Null/undefined means expecting an unclaimed row. */
  expectedCheckedOutBy?: string | null;
  expectedNodeId?: string | null;
  expectedLeaseEpoch?: number | null;
}

export interface TaskClaimRow {
  projectId: string;
  taskId: string;
  ownerNodeId: string;
  ownerAgentId: string;
  ownerRunId: string | null;
  leaseEpoch: number;
  leaseRenewedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CentralClaimStore {
  tryClaimTask(input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
    runId: string | null;
    renewedAt: string;
    expectedEpoch?: number | null;
  }): { ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict"; current: TaskClaimRow };
  renewTaskClaim(input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
    runId: string | null;
    renewedAt: string;
    expectedEpoch: number;
  }): { ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict" | "not_found"; current: TaskClaimRow | null };
  releaseTaskClaim(input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
  }): { ok: true } | { ok: false; reason: "not_owner" | "not_found"; current: TaskClaimRow | null };
  getTaskClaim(projectId: string, taskId: string): TaskClaimRow | null;
}

/**
 * One model-specific bucket inside a task's durable token usage aggregate.
 *
 * FNXC:TokenAnalytics 2026-06-19-15:42:
 * Multi-model task lifecycles must persist unidentified, partially identified, and fully identified model buckets without tightening nullability; analytics expands these buckets while legacy task-level totals remain the grand-total source of truth.
 */
export interface TaskTokenUsagePerModel {
  /** Provider of the actually-used model for this bucket. */
  modelProvider?: string;
  /** Id of the actually-used model for this bucket. */
  modelId?: string;
  /** Cumulative prompt/input tokens consumed by this model for the task. */
  inputTokens: number;
  /** Cumulative completion/output tokens consumed by this model for the task. */
  outputTokens: number;
  /** Cumulative cache-read (cache hit) tokens reported for this model. */
  cachedTokens: number;
  /** Cumulative cache-write tokens reported for this model. */
  cacheWriteTokens: number;
  /** Cumulative total tokens for this model bucket. */
  totalTokens: number;
  /** ISO-8601 timestamp of the first recorded usage event for this model bucket. */
  firstUsedAt: string;
  /** ISO-8601 timestamp of the most recent recorded usage event for this model bucket. */
  lastUsedAt: string;
}

/**
 * Durable task-level aggregate token usage totals persisted on the task row.
 *
 * This model captures cumulative usage across all agent/run activity linked to
 * a task so usage survives process restarts and can be queried without joining
 * transient run state.
 */
export interface TaskTokenUsage {
  /** Cumulative prompt/input tokens consumed by the task. */
  inputTokens: number;
  /** Cumulative completion/output tokens consumed by the task. */
  outputTokens: number;
  /** Cumulative cache-read (cache hit) tokens reported by providers. */
  cachedTokens: number;
  /** Cumulative cache-write tokens reported by providers. */
  cacheWriteTokens: number;
  /** Cumulative total tokens for the task (input + output + cache-read + cache-write). */
  totalTokens: number;
  /** ISO-8601 timestamp of the first recorded usage event for this task. */
  firstUsedAt: string;
  /** ISO-8601 timestamp of the most recent recorded usage event for this task. */
  lastUsedAt: string;
  /**
   * FNXC:TokenAnalytics 2026-06-18-16:23:
   * Snapshot the provider of the actually-used model for analytics only. This is intentionally distinct from task.modelProvider, which is an own-model override used by model resolution and must not be written by token bookkeeping.
   */
  modelProvider?: string;
  /**
   * FNXC:TokenAnalytics 2026-06-18-16:23:
   * Snapshot the id of the actually-used model for analytics only. This is intentionally distinct from task.modelId, which is an own-model override used by model resolution and must not be written by token bookkeeping.
   */
  modelId?: string;
  /**
   * FNXC:TokenAnalytics 2026-06-19-15:38:
   * Command Center model/provider analytics must show every model that consumed tokens during a task lifecycle. Store durable per-model buckets so executor, validator, reviewer, and planning usage is attributed to the producing model while the top-level task aggregate remains backward-compatible.
   */
  perModel?: TaskTokenUsagePerModel[];
}

export interface TaskTokenBudget {
  /** Total-token soft cap. When reached, emits one notification and continues. */
  soft?: number;
  /** Total-token hard cap. When reached, pauses the task with pausedReason="token_budget_exceeded". */
  hard?: number;
  /** Optional per-size overrides keyed by Task.size (S/M/L). Falls back to soft/hard when absent. */
  perSize?: { S?: { soft?: number; hard?: number }; M?: { soft?: number; hard?: number }; L?: { soft?: number; hard?: number } };
}

export interface TaskTokenBudgetOverride {
  soft?: number;
  hard?: number;
  /** Optional ISO timestamp recording when an operator widened the cap on unpause. */
  raisedAt?: string;
  /** Optional free-text justification recorded with the override. */
  reason?: string;
}

/** Thrown when a checkout is attempted on a task already checked out by another agent. */
export class CheckoutConflictError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly currentHolderId: string,
    public readonly requestedById: string,
  ) {
    super(`Task ${taskId} is already checked out by agent ${currentHolderId}`);
    this.name = "CheckoutConflictError";
  }
}

/** Origin types for task creation provenance tracking. */
export type SourceType =
  | "dashboard_ui"
  | "quick_chat"
  | "chat_session"
  | "agent_heartbeat"
  | "automation"
  | "cron"
  | "workflow_step"
  | "github_import"
  | "gitlab_import"
  | "task_refine"
  | "task_duplicate"
  | "cli"
  | "api"
  | "recovery"
  | "research"
  | "unknown";

export const DUPLICATE_OF_METADATA_KEY = "duplicateOfTaskIds" as const;

/** Provenance metadata for how a task was created. */
export interface TaskSource {
  sourceType: SourceType;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  sourceParentTaskId?: string;
  /**
   * Reserved metadata keys:
   * - `duplicateOfTaskIds: string[]` stores structured duplicate lineage captured
   *   from triage parsing and backfills.
   * - near-duplicate markers: `nearDuplicateOf` (canonical task id),
   *   `nearDuplicateScore` (number), `nearDuplicateSharedTokens` (string[]),
   *   and optional `nearDuplicateDismissed` (boolean).
   */
  sourceMetadata?: Record<string, unknown>;
}

export type TaskBranchGroupSource = "planning" | "mission" | "new-task";

export type TaskBranchAssignmentMode = "shared" | "per-task-derived";

export interface TaskBranchContext {
  /**
   * The owning BranchGroup id (`BG-…`). Only set for shared-mode members that
   * were actually assigned to an ensured branch group. Non-shared members
   * (per-task-derived) carry branch context (source/assignmentMode) without a
   * groupId so they are never swept into a shared group by the legacy
   * synthetic-groupId membership fallback (see filterTasksByBranchGroup).
   */
  groupId?: string;
  source: TaskBranchGroupSource;
  assignmentMode: TaskBranchAssignmentMode;
  inheritedBaseBranch?: string;
}

export type BranchGroupPrState = "none" | "open" | "merged" | "closed";

export type BranchGroupStatus = "open" | "finalized" | "abandoned";

export interface BranchGroup {
  id: string;
  sourceType: TaskBranchGroupSource;
  sourceId: string;
  branchName: string;
  worktreePath?: string;
  autoMerge: boolean;
  prState: BranchGroupPrState;
  prUrl?: string;
  prNumber?: number;
  status: BranchGroupStatus;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface BranchGroupCreateInput {
  sourceType: TaskBranchGroupSource;
  sourceId: string;
  branchName: string;
  worktreePath?: string;
  autoMerge?: boolean;
  prState?: BranchGroupPrState;
  prUrl?: string;
  prNumber?: number;
  status?: BranchGroupStatus;
  closedAt?: number;
}

export interface BranchGroupUpdate {
  sourceId?: string;
  branchName?: string;
  worktreePath?: string | null;
  autoMerge?: boolean;
  prState?: BranchGroupPrState;
  prUrl?: string | null;
  prNumber?: number | null;
  status?: BranchGroupStatus;
  closedAt?: number | null;
}

// --- Unified PR entity (feat: PR lifecycle as workflow nodes, U1) ---
//
// The single first-class record of a pull request fusion manages, regardless
// of how the work landed (a lone task or a shared branch group). Its lifecycle
// is driven by the pr-create / pr-respond / pr-merge workflow nodes; the only
// writers of the GitHub-mirror fields are the pr-create node (on a confirmed
// create) and the reconcile (R4: never persist state GitHub has not
// corroborated).

/** What a PR entity is attached to. */
export type PrEntitySourceType = "task" | "branch-group";

/**
 * Lifecycle state. Non-terminal: creating, open, responding. Terminal: merged,
 * closed. failed is a recorded, retryable creation failure (R4).
 */
export type PrEntityState =
  | "creating"
  | "open"
  | "responding"
  | "merged"
  | "closed"
  | "failed";

/** GitHub review decision mirror (matches PrInfo.lastReviewDecision shape). */
export type PrReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** Aggregate CI rollup mirror (matches PrInfo.checkRollup shape). */
export type PrChecksRollup = "success" | "failure" | "pending" | "none";

export interface PrEntity {
  id: string;
  sourceType: PrEntitySourceType;
  /** Task id or branch-group id, depending on sourceType. */
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch?: string;
  state: PrEntityState;
  /** GitHub-mirror fields — only the create node and reconcile write these. */
  prNumber?: number;
  prUrl?: string;
  headOid?: string;
  mergeable?: PrConflictState;
  checksRollup?: PrChecksRollup;
  reviewDecision?: PrReviewDecision;
  /** Whether auto-merge is opted in for this entity (R10). */
  autoMerge: boolean;
  /**
   * Imported-from-legacy state that GitHub has not yet corroborated. While true
   * the entity is a hard gate: excluded from auto-merge + response dispatch and
   * never advanced on stale state (R19). Cleared on first successful reconcile.
   */
  unverified: boolean;
  /** Classified failure reason when state === "failed" (R4, AE3). */
  failureReason?: string;
  /** Rework-cycle counter backing the R8 iteration cap (survives restart). */
  responseRounds: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface PrEntityCreateInput {
  sourceType: PrEntitySourceType;
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch?: string;
  state?: PrEntityState;
  autoMerge?: boolean;
  unverified?: boolean;
  prNumber?: number;
  prUrl?: string;
}

export interface PrEntityUpdate {
  state?: PrEntityState;
  prNumber?: number | null;
  prUrl?: string | null;
  headOid?: string | null;
  mergeable?: PrConflictState | null;
  checksRollup?: PrChecksRollup | null;
  reviewDecision?: PrReviewDecision;
  autoMerge?: boolean;
  unverified?: boolean;
  failureReason?: string | null;
  responseRounds?: number;
  closedAt?: number | null;
}

/** Per-thread response outcome, keyed by thread id + head OID (R15). */
export type PrThreadOutcome = "fixed" | "disagreed" | "pending";

export interface PrThreadState {
  prEntityId: string;
  /** GitHub review-thread node id. */
  threadId: string;
  /** Head OID the outcome was produced against (idempotency key with threadId). */
  headOid: string;
  outcome: PrThreadOutcome;
  /** Commit SHA embedded in the agent's reply marker, when a fix was pushed. */
  fixCommitSha?: string;
  updatedAt: number;
}

export interface Task {
  id: string;
  /** Immutable lineage identity used for durable commit/task attribution. */
  lineageId?: string;
  title?: string;
  description: string;
  /**
   * Task importance level. Missing legacy values normalize to `normal` when
   * tasks are hydrated from persistence.
   */
  priority?: TaskPriority;
  /** The task's current column id. Widened to {@link ColumnId} so workflow-defined
   *  custom columns are representable; flag-OFF paths only ever store legacy ids. */
  column: ColumnId;
  /** Source column captured when this task is archived; used to restore sensibly. */
  preArchiveColumn?: Column;
  dependencies: string[];
  /** User-requested hint for triage: prefer splitting into child tasks when appropriate. */
  breakIntoSubtasks?: boolean;
  /** When true, this decision-only task is expected to complete without creating git commits. */
  noCommitsExpected?: boolean;
  worktree?: string;
  /**
   * Workspace mode only. Keyed by repo path relative to workspace rootDir.
   * Each entry records the on-disk worktree path and git branch for one sub-repo.
   *
   * FNXC:Workspace 2026-06-21-20:10:
   * `baseCommitSha` is the per-repo fork-point captured at acquisition (U2/KTD3)
   * against that sub-repo's RESOLVED integration branch, local-first. It is the
   * per-repo analogue of the single-repo base-commit capture and prevents
   * cross-repo files-changed inflation when local integration is ahead of origin.
   *
   * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
   * `landedSha` is the per-repo "this repo's branch has landed on its local
   * integration ref" marker, set by `landWorkspaceTask` after a sub-repo's squash
   * advances that repo's ref. It is the ONLY partial-land state added (no new
   * status type): a re-run's landed predicate skips a repo whose `landedSha` is
   * present AND whose recorded value is an ancestor of (or equals) the repo's
   * integration tip, so an interrupted multi-repo land retries only the un-landed
   * repos and never re-advances an already-landed ref (idempotent retry).
   */
  workspaceWorktrees?: Record<string, { worktreePath: string; branch: string; baseCommitSha?: string; landedSha?: string }>;
  steps: TaskStep[];
  currentStep: number;
  /**
   * Workflow-defined custom task field values (KTD-13), keyed by field id.
   * Persisted as the `tasks.customFields` JSON column. Treated as opaque by
   * the core row⇄Task mapping and `updateTask`; the validation/write authority
   * (type/enum/render checks against the workflow's field schema) lands in a
   * later unit. Absent on legacy tasks.
   */
  customFields?: Record<string, unknown>;
  status?: string;
  /** ID of the in-progress task whose file scope overlaps with this task,
   *  causing the scheduler to defer it. Set when the scheduler queues
   *  the task due to file-scope overlap; cleared (set to `undefined`)
   *  when the task is eventually started or moved to done. */
  blockedBy?: string;
  /** ID of the in-progress/in-review task whose file scope overlaps with this task's
   *  file scope, causing the scheduler to defer dispatch. Set independently of
   *  `blockedBy` so overlap state survives dependency-based blockedBy transitions.
   *  Cleared when the overlap resolves (the blocker task moves to done or its
   *  scope no longer overlaps). */
  overlapBlockedBy?: string;
  /** When true, all automated agent and scheduler interaction is suspended. */
  paused?: boolean;
  /** When true, this task was explicitly moved back to todo by a user and should not auto-dispatch. */
  userPaused?: boolean;
  /** Optional machine-readable reason for automated pauses (for example dispatch-storm). */
  pausedReason?: string;
  /** ISO timestamp set when the task first crossed the soft token budget cap. */
  tokenBudgetSoftAlertedAt?: string;
  /** ISO timestamp marking first one-shot alert when worktrunk failed and fell back to native backend. */
  worktrunkFallbackAlertedAt?: string;
  /** Structured details for a fail-hard worktrunk operation failure. */
  worktrunkFailure?: {
    op: "create" | "sync" | "prune" | "remove" | "install" | "resolve-binary";
    stderr?: string;
    exitCode?: number | null;
    attemptedAt: string;
  };
  /** ISO timestamp set when the task first crossed the hard token budget cap. */
  tokenBudgetHardAlertedAt?: string;
  /** Optional per-task budget override set by an operator on resume. */
  tokenBudgetOverride?: TaskTokenBudgetOverride;
  /** Dispatch-storm cycle counter tracked by scheduler for todo↔in-progress loop detection. */
  dispatchStormCount?: number;
  /** ISO timestamp of the most recent dispatch-storm cycle increment. */
  lastDispatchAt?: string;
  /** When set, this task was paused because the agent with this ID was paused. Cleared when the agent resumes. Distinct from user-initiated pause. */
  pausedByAgentId?: string;
  /** Configured merge target/base branch for this task (task intent).
   *  Defaults to the project default branch when omitted. */
  baseBranch?: string;
  /** Per-task auto-merge override.
   *  `undefined` means no explicit per-task value: follow live `settings.autoMerge`.
   *  `true`/`false` are explicit overrides when paired with `autoMergeProvenance: "user"`.
   *  Distinct from GitHub PR metadata (`PrInfo.autoMergeOnGreen` /
   *  `PrInfo.autoMergeStrategy`), which must not be conflated with this field. */
  autoMerge?: boolean;
  /** Provenance for `autoMerge`.
   *  `"user"` means a sticky explicit user-set override.
   *  `"legacy-stamp"` means an ambiguous value written by the pre-FN-6245
   *  review-entry stamp and is operator-clearable. Absent means unknown/none. */
  autoMergeProvenance?: "user" | "legacy-stamp";
  /** Actual git working branch name used for this task's worktree. May differ from
   *  the conventional `fn/{task-id}` when conflict recovery generated a
   *  unique suffixed name (e.g., `fn/fn-042-2`). */
  branch?: string;
  /** Optional planning/mission branch-group metadata carried across related tasks. */
  branchContext?: TaskBranchContext;
  /** Internal execution-only provenance for dependency-start handoff.
   *  When set, the scheduler asked executor to start from an upstream dependency
   *  branch. This is transient execution state and should be cleared after use. */
  executionStartBranch?: string;
  /** Base commit SHA for creating this task's worktree. Used with the start ref
   *  chosen for the worktree to establish the exact starting point. */
  baseCommitSha?: string;
  /**
   * Executor-time snapshot of `git diff <baseCommitSha>..HEAD` captured in the
   * task worktree (`TaskExecutor.captureModifiedFiles`).
   *
   * This may be a stale/transient superset of files that actually landed after
   * merge resolution or follow-up commits. Done-task cards must not use this
   * field for their files-changed chip; the authoritative landed diff comes
   * from `/api/tasks/:id/diff`, with `mergeDetails.landedFiles` as committed
   * metadata fallback when live stats are unavailable.
   */
  modifiedFiles?: string[];
  /** Opt out of the squash file-scope invariant for this task. */
  scopeOverride?: boolean;
  /** Optional justification for bypassing the squash file-scope invariant. */
  scopeOverrideReason?: string;
  /** Append-only list of file paths auto-widened into `## File Scope` by merger safety checks. */
  scopeAutoWiden?: string[];
  /** Mission ID this task is linked to (for mission hierarchy) */
  missionId?: string;
  /** Slice ID this task is linked to (for mission hierarchy) */
  sliceId?: string;
  attachments?: TaskAttachment[];
  steeringComments?: SteeringComment[];
  comments?: TaskComment[];
  /** Structured review metadata shown in the Review tab (legacy contract). */
  review?: TaskReview;
  /** Structured review metadata shown in the Review tab (canonical contract). */
  reviewState?: TaskReviewState;
  /** PR information for tasks linked to GitHub pull requests */
  prInfo?: PrInfo;
  /** Canonical list of linked PRs; prInfo mirrors the primary PR for back-compat. */
  prInfos?: PrInfo[];
  mergeDetails?: MergeDetails;
  /** Issue information for tasks imported from GitHub issues */
  issueInfo?: IssueInfo;
  /**
   * Per-task tracking metadata for Fusion-emitted GitHub issues.
   * Distinct from issueInfo/sourceIssue, which describe imported source issues.
   */
  githubTracking?: TaskGithubTracking;
  /** Durable source provenance for task creation/import metadata. */
  source?: TaskSource;
  /** Durable source provenance for the originating external issue. */
  sourceIssue?: TaskSourceIssue;
  /** Linked GitLab tracking metadata for GitLab.com and self-managed GitLab items. */
  gitlabTracking?: TaskGitLabTracking;
  log: TaskLogEntry[];
  /** Pre-aggregated sum of `[timing] … in <N>ms` log durations, in milliseconds.
   *  Computed server-side so slim board listings can render the card timer
   *  without shipping the full agent log. The TaskDetailModal still derives
   *  this on the fly from `log`, so this field is only populated by the slim
   *  list path and may be omitted on the full-detail object. */
  timedExecutionMs?: number;
  /** Server-computed in-review stall signal. Undefined when no stall rule matches.
   *  Diagnostic-only: must not be used as an auto-completion signal. */
  inReviewStall?: InReviewStallSignal;
  /** Server-computed task age staleness signal. Undefined when no staleness rule matches.
   *  Diagnostic-only: must not be used as an auto-completion signal. */
  ageStaleness?: TaskAgeStalenessSignal;
  /** Server-computed stale paused review diagnostic signal. Undefined when no rule matches.
   *  Diagnostic-only: must not trigger automatic state mutation. */
  stalePausedReview?: StalePausedReviewSignal;
  /** Server-computed in-review quiet-window diagnostic signal. Undefined when no rule matches.
   *  Diagnostic-only: must not trigger automatic state mutation. */
  inReviewStalled?: InReviewStalledSignal;
  /** Server-computed stale paused todo diagnostic signal. Undefined when no rule matches.
   *  Diagnostic-only: must not trigger automatic state mutation. */
  stalePausedTodo?: StalePausedTodoSignal;
  /*
   * FNXC:WorkflowNotifications 2026-06-29-12:44:
   * Workflow transition notifications should use typed task state instead of
   * parsing human-readable task log text. Producers set this marker when a
   * workflow transition needs operator notification; NotificationService only
   * consumes it while the task remains in the recorded target column. The marker
   * column prevents stale task movement from triggering a later notification,
   * and transitionId provides stable dedupe across repeated task:updated events.
   */
  workflowTransitionNotification?: WorkflowTransitionNotificationMarker;
  /** Heuristic stalled-review diagnostic signal (legacy compatibility contract). */
  stalledReview?: StalledReviewSignal;
  /** Durable aggregate token usage totals for the task. Undefined when no usage has been recorded yet. */
  tokenUsage?: TaskTokenUsage;
  size?: "S" | "M" | "L";
  reviewLevel?: number;
  /** Model preset selected during task creation. Presets resolve to concrete model overrides at creation time. */
  modelPresetId?: string;
  /** AI model provider override for the executor agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelProvider?: string;
  /** AI model ID override for the executor agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelId?: string;
  /** AI model provider override for the validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both validator model fields
   *  are undefined, the reviewer uses global settings defaults. */
  validatorModelProvider?: string;
  /** AI model ID override for the validator/reviewer agent.
   *  Must be set together with `validatorModelProvider`. When both validator model
   *  fields are undefined, the reviewer uses global settings defaults. */
  validatorModelId?: string;
  /** AI model provider override for the planning/triage agent.
   *  Must be set together with `planningModelId`. When both planning model fields
   *  are undefined, the triage agent uses global settings defaults. */
  planningModelProvider?: string;
  /** AI model ID override for the planning/triage agent.
   *  Must be set together with `planningModelProvider`. When both planning model
   *  fields are undefined, the triage agent uses global settings defaults. */
  planningModelId?: string;
  /** IDs of workflow steps enabled for this task, run after implementation completes */
  enabledWorkflowSteps?: string[];
  /** Results from workflow step executions (populated after task implementation) */
  workflowStepResults?: WorkflowStepResult[];
  /** Number of merge retry attempts made for this task (auto-merge conflict recovery) */
  mergeRetries?: number;
  /** Number of workflow step failure retry attempts made for this task.
   *  When pre-merge workflow steps fail, the executor retries up to MAX_WORKFLOW_STEP_RETRIES
   *  times before marking the task as failed. Cleared on successful workflow step completion. */
  workflowStepRetries?: number;
  /** Number of times the stuck-task detector has killed this task's agent session.
   *  Incremented by the self-healing manager on each stuck kill. When this reaches
   *  `maxStuckKills`, the task is marked as permanently failed instead of re-queued. */
  stuckKillCount?: number;
  /** Number of consecutive reclaim/unpause attempts where no execution progress
   *  materialized (tip unchanged, step signature unchanged, and no active session).
   *  Incremented by self-healing for resume-limbo detection and reset when
   *  progress is observed or recovery escalates to a fresh todo dispatch. */
  resumeLimboCount?: number;
  /** Bounded auto-retry attempts for transient workflow-graph failures observed
   *  immediately after engine-restart or unpause resume. Reset by manual retry
   *  and by successful forward progress; capped by the executor before terminal
   *  `status:"failed"` is recorded to preserve the FN-5704 anti-loop exemption. */
  graphResumeRetryCount?: number | null;
  /** Branch tip SHA snapshot captured at the last reclaim/unpause attempt used
   *  by resume-limbo detection to determine whether commits advanced. */
  resumeLimboTipSha?: string;
  /** Compact execution-progress snapshot captured at the last reclaim/unpause
   *  attempt (current step + step statuses) for resume-limbo detection. */
  resumeLimboStepSignature?: string;
  /** Number of times workflow remediation has auto-revived this task after
   *  failed pre-merge review feedback. Incremented each time the engine sends the
   *  task back with failure feedback injected. Capped only when the workflow step
   *  resolves to a numeric maxRevisions/maxPostReviewFixes budget; built-in Code
   *  Review defaults to unbounded recovery so ordinary REVISE feedback does not
   *  terminal-fail the task. */
  postReviewFixCount?: number;
  /** Number of bounded recovery retry attempts for transient executor/triage failures.
   *  Distinct from `mergeRetries` (merge-conflict-specific). Incremented by the
   *  recovery-policy module on each recoverable failure; cleared when work restarts
   *  cleanly or reaches a terminal column (in-review, done, archived). */
  recoveryRetryCount?: number;
  /** Number of times this task has been requeued after the agent exited without
   *  calling `task_done`. Incremented by the executor for immediate `todo`
   *  requeues and by self-healing for deferred recovery of partial-progress
   *  failures. Capped by `MAX_TASK_DONE_RETRIES`; when exhausted the task stays
   *  in `in-review` for human inspection. Cleared on successful completion. */
  taskDoneRetryCount?: number;
  /** Number of times self-healing auto-requeued an `in-review` task that failed
   *  at session start with an unusable-worktree error. Bounded by
   *  `MAX_WORKTREE_SESSION_RETRIES`; when exhausted the task remains parked in
   *  `in-review` for human inspection. Cleared on successful completion / move
   *  out of failed state by the executor. */
  worktreeSessionRetryCount?: number;
  /** Number of completion-handoff limbo recoveries attempted for this task.
   *  Incremented by self-healing when an `in-review` task has a stale
   *  "Task marked done by agent" marker but no merge fan-out state.
   *  Capped by `MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES`; exhaustion leaves
   *  the task failed in-review for human inspection. */
  completionHandoffLimboRecoveryCount?: number;
  /** Number of times this task has bounced from `in-review` back to `in-progress`
   *  due to a deterministic verification failure during auto-merge. Incremented
   *  by the auto-merge error handler (project-engine.ts). When this reaches
   *  `MAX_VERIFICATION_FAILURE_BOUNCES`, the task is marked failed and a
   *  follow-up triage task is created so a human / fresh agent can investigate
   *  rather than endlessly re-attempting the same fix. */
  verificationFailureCount?: number;
  /** Number of times this task has bounced from `in-review` back to `in-progress`
   *  due to auto-merge conflict-retry exhaustion. Incremented by the auto-merge
   *  error handler (project-engine.ts) when conflicts can't be auto-resolved
   *  within `MAX_AUTO_MERGE_RETRIES`. When this reaches
   *  `MAX_MERGE_CONFLICT_BOUNCES`, the task is parked in `in-review` with
   *  `status="failed"` and a follow-up triage task is created — preventing the
   *  cooldown sweep from re-attempting the same impossible merge forever. */
  mergeConflictBounceCount?: number;
  /** Number of times this task has bounced from `in-review` back to `in-progress`
   *  due to post-merge audit recovery escalation. Incremented by the auto-merge
   *  error handler (project-engine.ts) when a `SquashAuditError` remains unresolved
   *  after deterministic/programmatic/AI recovery passes. When this reaches
   *  `MAX_MERGE_AUDIT_BOUNCES`, the task is parked with `status="failed"` and a
   *  recovery follow-up task is created. */
  mergeAuditBounceCount?: number;
  /** Number of transient auto-merge retries consumed after provider/network abort
   *  errors (for example AbortError, socket hang up, server_error payloads).
   *  Distinct from `mergeRetries` (in-cycle conflict retries) and
   *  `mergeConflictBounceCount` (in-review→in-progress conflict bounces).
   *  Bounded by `MAX_AUTO_MERGE_TRANSIENT_RETRIES`; once exhausted, the task is
   *  parked with `status="failed"` instead of re-enqueued. */
  mergeTransientRetryCount?: number;
  /** Number of branch-conflict recovery attempts consumed by executor branch
   *  conflict auto-recovery loops. Incremented once per recovery retry attempt. */
  branchConflictRecoveryCount?: number;
  /** Number of reviewer context-limit retries consumed by FN-4082 compact
   *  reviewer-request fallback handling. */
  reviewerContextRetryCount?: number;
  /** Number of reviewer fallback retries consumed by FN-4092 fallback-model
   *  and same-model strict-prompt retry paths. */
  reviewerFallbackRetryCount?: number;
  /** Derived retry aggregation computed at read time from retry counters.
   *  This field is not persisted to SQLite. */
  retrySummary?: RetrySummary;
  /** ISO-8601 timestamp indicating when the task becomes eligible for the next
   *  recovery retry. Scheduler and triage processor skip tasks whose
   *  `nextRecoveryAt` is still in the future. Cleared alongside `recoveryRetryCount`. */
  nextRecoveryAt?: string;
  /** Thinking level for AI agent sessions — controls reasoning effort (off/minimal/low/medium/high) */
  thinkingLevel?: ThinkingLevel;
  /** Execution mode for task implementation.
   *  - "standard": Full execution with complete review workflow (default)
   *  - "fast": Expedited execution with minimal overhead for simple tasks
   *  Defaults to "standard" when not specified. */
  executionMode?: ExecutionMode;
  /** Per-task override of the workflow-native planner oversight level (FNXC:PlannerOversight).
   *  When set, wins over the workflow's effective `plannerOversightLevel`. Unset means
   *  "inherit workflow default" — see `resolveEffectivePlannerOversightLevel` in
   *  workflow-settings-resolver.ts for precedence. */
  plannerOversightLevel?: PlannerOversightLevel;
  /** Explicitly assigned agent ID for task-agent linking. Distinct from Agent.taskId active execution state. */
  assignedAgentId?: string;
  /** Per-task node override. When set, this task routes to the specified node instead of the project's default node. Undefined means use the project default. Use empty string to explicitly clear. */
  nodeId?: string;
  /** The node this task is actually routed to (resolved from nodeId override or project default). Set by the scheduler at dispatch time. */
  effectiveNodeId?: string;
  /** How the effectiveNodeId was determined. Set by the scheduler at dispatch time. */
  effectiveNodeSource?: "task-override" | "project-default" | "local";
  /** Provenance: how this task was created. */
  sourceType?: SourceType;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  sourceParentTaskId?: string;
  sourceMetadata?: Record<string, unknown>;
  /** Reconstructed task prompt content when available on in-memory execution tasks. */
  prompt?: string;
  /** Explicitly assigned user ID for task-user linking. Used during review handoff to indicate
   *  which user should review the task. The sentinel value "requesting-user" indicates the
   *  user who created or steered the task. */
  assigneeUserId?: string;
  /** Agent ID currently holding the checkout lease for this task. Undefined when no active lease. */
  checkedOutBy?: string;
  /** ISO-8601 timestamp when the checkout lease was acquired. */
  checkedOutAt?: string;
  /** Node ID currently owning the checkout lease. */
  checkoutNodeId?: string;
  /** Owning run/session ID for the checkout lease when known. */
  checkoutRunId?: string;
  /** ISO-8601 timestamp of the last successful lease renewal heartbeat. */
  checkoutLeaseRenewedAt?: string;
  /** Monotonically increasing lease generation used to prevent stale reclaim attempts. */
  checkoutLeaseEpoch?: number;
  /** Path to the persisted agent session file, enabling pause/resume without
   *  losing conversation context. Set when execution starts; cleared on
   *  completion or terminal failure. */
  sessionFile?: string;
  /** Error message from the last failure, if the task failed during execution */
  error?: string;
  /** Optional summary of what was changed/fixed when task is completed */
  summary?: string;
  /** ISO-8601 timestamp of when the task last entered its current column.
   *  Used to sort cards within a column so that recently-moved cards appear at the top. */
  columnMovedAt?: string;
  /** ISO-8601 wall-clock timestamp for the first-ever transition into `in-progress`.
   *  Immutable once set: never cleared or overwritten across retries, reopens,
   *  recovery bounces, or user-initiated moves. */
  firstExecutionAt?: string;
  /** Accumulated milliseconds spent in `in-progress` across all attempts.
   *  Incremented whenever the task leaves `in-progress`; never decremented and
   *  never cleared by reopen flows. */
  cumulativeActiveMs?: number;
  /*
  FNXC:TaskTiming 2026-06-26-10:14:
  Per-stage dwell-time instrumentation. `cumulativeActiveMs` only measures `in-progress`,
  so "how long did a task sit in todo / in-review" was unrecoverable without reconstructing
  it from agent logs. This map records cumulative wall-clock milliseconds spent in EACH
  column (column name -> total ms), accumulated at the column-transition seam in store.ts
  exactly like `cumulativeActiveMs`: on every transition we add the dwell of the column being
  LEFT (newColumnMovedAt - previousColumnMovedAt, clamped >= 0). Multi-visit columns add to
  the existing bucket; never decremented and never cleared by reopen flows. Directly queryable
  per stage by consumers like productivity-analytics.ts.
  */
  columnDwellMs?: Record<string, number>;
  /** ISO-8601 wall-clock timestamp for the current execution attempt.
   *  Set when entering `in-progress`; may be cleared on reopen to
   *  todo/triage when resume state is not preserved. */
  executionStartedAt?: string;
  /** ISO-8601 wall-clock timestamp when the task first reached `done`.
   *  Set once on first transition to `done`; may be cleared on reopen to
   *  todo/triage when resume state is not preserved. */
  executionCompletedAt?: string;
  deletedAt?: string;
  allowResurrection?: boolean;
  createdAt: string;
  updatedAt: string;
}

/*
FNXC:Workspace 2026-06-21-19:05:
R7 workspace merge-boundary guard (master-plan U0). Workspace-mode tasks populate
`task.workspaceWorktrees` (one git worktree per sub-repo); their merge must run a
per-repo loop that does NOT exist yet — it lands in master-plan U6. Until then, a
workspace task reaching ANY merge entry point (engine dispatch, store.mergeTask,
the CLI `onMergeImpl` / `runTaskMerge` callers) would run git operations against
the NON-GIT workspace root and crash. This single shared predicate is called at the
top of every merge door, BEFORE any git work, so the task is held with a clear,
actionable error instead. It lives in @fusion/core so all four call sites — including
store.mergeTask, which cannot import from @fusion/engine — share ONE implementation.
The guard throws a NAMED `WorkspaceTaskMergeError` so callers (e.g. the engine merge
dispatch catch) can distinguish this permanent config error from a transient merge
failure and avoid burning mergeRetries. Master-plan U6 REMOVES this guard when the
per-repo merge loop becomes the gate.
*/

/**
 * Error thrown by {@link assertNotWorkspaceTaskMerge} when a workspace-mode task
 * reaches a merge path. Named so callers can branch on it (e.g. park without
 * burning mergeRetries) rather than treating it as a transient merge failure.
 */
export class WorkspaceTaskMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTaskMergeError";
  }
}

/**
 * Throws {@link WorkspaceTaskMergeError} when `task.workspaceWorktrees` has at least
 * one entry (a workspace-mode task). No-op for single-repo tasks. See the
 * FNXC:Workspace note above.
 * @param task the task about to enter a merge path
 */
export function assertNotWorkspaceTaskMerge(task: Pick<Task, "id" | "workspaceWorktrees">): void {
  if (isWorkspaceTask(task)) {
    throw new WorkspaceTaskMergeError(
      `Workspace task ${task.id} cannot merge until per-repo merge support (master-plan U6) lands`,
    );
  }
}

/*
FNXC:Workspace 2026-06-22-05:10 (Phase C review B5/B7-dep — canonical workspace predicate):
A workspace-mode task is identified by having at least one `workspaceWorktrees` entry
(one git worktree per sub-repo). This single predicate replaces the inlined
`!!task.workspaceWorktrees && Object.keys(task.workspaceWorktrees).length > 0` that was
copy-pasted across the engine merge dispatch and the merge-confirmed reachability fast-path
(B2). It lives in @fusion/core so the engine, store, and CLI doors share ONE definition.
The dashboard keeps its own local `isWorkspaceTask` (WorkspaceWorktreesSummary, UI-only) —
this core export is for engine/CLI use.
*/
export function isWorkspaceTask(task: Pick<Task, "workspaceWorktrees">): boolean {
  const worktrees = task.workspaceWorktrees;
  return !!worktrees && Object.keys(worktrees).length > 0;
}

export type RetrySummary = {
  stuckKill: number;
  recovery: number;
  taskDone: number;
  worktreeSession: number;
  workflowStep: number;
  verification: number;
  postReviewFix: number;
  mergeConflict: number;
  branchConflict: number;
  reviewerContext: number;
  reviewerFallback: number;
  total: number;
};

export interface TaskDetail extends Task {
  prompt: string;
  /** Derived aggregate of retry counters (computed on read; never persisted). */
  retrySummary?: RetrySummary;
}

/** A task candidate from the inbox-lite work selection, with metadata about why it was selected. */
export interface InboxTask {
  task: Task;
  priority: "in_progress" | "todo" | "blocked";
  reason: string;
}

export interface TaskCreateInput {
  title?: string;
  /** Optional lineage override for trusted replication/import paths only. */
  lineageId?: string;
  /**
   * Opt-in createTask override for soft-deleted ID reuse.
   * Not persisted to storage.
   */
  forceResurrect?: boolean;
  description: string;
  /** Configured merge target/base branch for this task (task intent).
   *  Defaults to the project default branch when omitted. */
  baseBranch?: string;
  /** Actual git working branch name used for this task's worktree. */
  branch?: string;
  /** Optional planning/mission branch-group metadata carried across related tasks. */
  branchContext?: TaskBranchContext;
  /** Optional per-task auto-merge override. Undefined means no task-level override. */
  autoMerge?: boolean;
  /** Durable source provenance for the originating external issue. */
  sourceIssue?: TaskSourceIssue;
  /** Linked GitLab tracking metadata for GitLab.com and self-managed GitLab items. */
  gitlabTracking?: TaskGitLabTracking;
  /** Optional persisted aggregate token usage snapshot for task creation/import paths. */
  tokenUsage?: TaskTokenUsage;
  /** Provenance metadata for task creation. */
  source?: TaskSource;
  /**
   * Optional task importance level. Omitted values default to `normal`.
   */
  priority?: TaskPriority;
  /** Initial column id. Widened to {@link ColumnId} (#1403) so a custom-column
   *  task can be replicated/created; flag-OFF creation only ever uses legacy ids. */
  column?: ColumnId;
  dependencies?: string[];
  breakIntoSubtasks?: boolean;
  /** When true, this task is expected to complete without creating git commits. */
  noCommitsExpected?: boolean;
  /** IDs of workflow steps to enable for this task */
  enabledWorkflowSteps?: string[];
  /**
   * Workflow selection applied atomically at task creation (U6/R3/KTD-4).
   *
   * Semantics:
   *  - `undefined` → inherit the project default workflow (today's behavior:
   *    `materializeDefaultWorkflowSteps` runs, falling back to default-on steps).
   *  - `null` → explicitly NO workflow: skip default materialization entirely;
   *    the task is created with no custom workflow steps.
   *  - `string` → that workflow's compiled steps are materialized and selected
   *    inside the creation flow, overriding any project default. Fragment IDs
   *    and unknown IDs are rejected with a clear error BEFORE the task row is
   *    created.
   *
   * Mutually exclusive with `enabledWorkflowSteps`: when `enabledWorkflowSteps`
   * is provided, it takes precedence and `workflowId` materialization is skipped.
   */
  workflowId?: string | null;
  /** Model preset selected during task creation. Presets resolve to concrete model overrides at creation time. */
  modelPresetId?: string;
  /** AI model provider override for the executor agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelProvider?: string;
  /** AI model ID override for the executor agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelId?: string;
  /** AI model provider override for the validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both validator model fields
   *  are undefined, the reviewer uses global settings defaults. */
  validatorModelProvider?: string;
  /** AI model ID override for the validator/reviewer agent.
   *  Must be set together with `validatorModelProvider`. When both validator model
   *  fields are undefined, the reviewer uses global settings defaults. */
  validatorModelId?: string;
  /** AI model provider override for the planning/triage agent.
   *  Must be set together with `planningModelId`. When both planning model fields
   *  are undefined, the triage agent uses global settings defaults. */
  planningModelProvider?: string;
  /** AI model ID override for the planning/triage agent.
   *  Must be set together with `planningModelProvider`. When both planning model
   *  fields are undefined, the triage agent uses global settings defaults. */
  planningModelId?: string;
  /** Thinking level for AI agent sessions — controls reasoning effort (off/minimal/low/medium/high) */
  thinkingLevel?: ThinkingLevel;
  /** When true, trigger AI title summarization if description is long and no title provided */
  summarize?: boolean;
  /** Mission ID to link this task to (for mission hierarchy) */
  missionId?: string;
  /** Slice ID to link this task to (for mission hierarchy) */
  sliceId?: string;
  /** Optional explicit agent assignment for this task */
  assignedAgentId?: string;
  /** Per-task node override. When set, this task routes to the specified node instead of the project's default node. Undefined means use the project default. Use empty string to explicitly clear. */
  nodeId?: string;
  /** Optional explicit user assignment for this task (used during review handoff) */
  assigneeUserId?: string;
  /** Opt out of the squash file-scope invariant for this task. */
  scopeOverride?: boolean;
  /** Optional justification for bypassing the squash file-scope invariant. */
  scopeOverrideReason?: string;
  /** Append-only list of file paths auto-widened into `## File Scope` by merger safety checks. */
  scopeAutoWiden?: string[];
  /** Per-task GitHub issue tracking overrides for Fusion-created linked issues. */
  githubTracking?: Pick<TaskGithubTracking, "enabled" | "repoOverride">;
  /** Review level for task execution — controls review rigor: 0=None, 1=Plan Only, 2=Plan and Code, 3=Full */
  reviewLevel?: number;
  /** Execution mode for task implementation.
   *  - "standard": Full execution with complete review workflow (default)
   *  - "fast": Expedited execution with minimal overhead for simple tasks
   *  Defaults to "standard" when not specified. */
  executionMode?: ExecutionMode;
  /** Per-task override of the workflow-native planner oversight level (FNXC:PlannerOversight).
   *  When set, wins over the workflow's effective `plannerOversightLevel`. Unset means
   *  "inherit workflow default". */
  plannerOversightLevel?: PlannerOversightLevel;
}

// ── Todo List Types ──────────────────────────────────────────────────────

export interface MeshReplicatedTaskCreatePayload {
  replicationVersion: 1;
  reservationId: string;
  taskId: string;
  sourceNodeId: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  input: TaskCreateInput;
}

export interface MeshReplicatedTaskApplyResult {
  task: Task;
  applied: boolean;
}

/** Canonical version for shared-state snapshots exchanged across mesh nodes. */
export const SHARED_STATE_SNAPSHOT_VERSION = 1 as const;

export interface TodoList {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  listId: string;
  text: string;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sortOrder: number;
}

export interface TodoListCreateInput {
  title: string;
}

export interface TodoListUpdateInput {
  title?: string;
}

export interface TodoItemCreateInput {
  text: string;
  sortOrder?: number;
}

export interface TodoItemUpdateInput {
  text?: string;
  completed?: boolean;
  sortOrder?: number;
}

export interface TodoListWithItems extends TodoList {
  items: TodoItem[];
}

// ── Settings Scope Types ────────────────────────────────────────────────
//
// Settings are split into two scopes:
//
// 1. **GlobalSettings** — User preferences stored in `~/.fusion/settings.json`.
//    These persist across all fn projects for the current user (theme, default
//    AI models, notification preferences).
//
// 2. **ProjectSettings** — Project-specific workflow and resource settings stored
//    in `.fusion/config.json`. These control how the engine operates for this
//    particular project (concurrency, merge strategy, worktree management, etc.).
//
// The merged view (`Settings`) combines both scopes: project values override
// global values. This is the type returned by `TaskStore.getSettings()` and
// used by most consumers.
//
// Computed/server-only fields (like `prAuthAvailable`) live only on
// `Settings` and are injected at read time by the API layer.

/** Settings scope discriminator for UI and validation. */
export type SettingsScope = "global" | "project";

/**
 * Settings for daemon mode authentication token and server configuration.
 * Stored in global settings alongside user preferences.
 */
export interface DaemonTokenSettings {
  /** The daemon authentication token (format: fn_<32 hex chars>).
   *  Used for authenticating CLI clients to the daemon server. */
  daemonToken?: string;
  /** Port for daemon mode server binding. Default: 4040. */
  daemonPort?: number;
  /** Host for daemon mode server binding. Default: "127.0.0.1" (localhost only).
   *  Set to "0.0.0.0" explicitly to expose the API on all interfaces — only do
   *  this if you understand the implications (terminal/exec endpoints become
   *  reachable from the LAN even with a bearer token). */
  daemonHost?: string;
}

/**
 * Global (user-level) settings stored in `~/.fusion/settings.json`.
 *
 * These are user preferences that persist across all fn projects.
 * The dashboard UI shows these under a "Global" section.
 */
/** Web search backend for auto-research provider. */
export type WebSearchBackend = "builtin" | "searxng" | "brave" | "google" | "tavily";

export interface ResearchEnabledSources {
  webSearch: boolean;
  pageFetch: boolean;
  github: boolean;
  localDocs: boolean;
  llmSynthesis: boolean;
}

export interface ResearchGlobalDefaults {
  searchProvider?: string;
  synthesisProvider?: string;
  synthesisModelId?: string;
  enabledSources?: ResearchEnabledSources;
  maxSourcesPerRun?: number;
  defaultExportFormat?: "markdown" | "json";
}

export interface ResearchProjectLimits {
  maxConcurrentRuns?: number;
  maxSourcesPerRun?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
}

export interface ResearchProjectSettings {
  enabled?: boolean;
  searchProvider?: string;
  synthesisProvider?: string;
  synthesisModelId?: string;
  enabledSources?: Partial<ResearchEnabledSources>;
  limits?: ResearchProjectLimits;
}

export type SandboxBackendName = "native" | "sandbox-exec" | "bubblewrap" | "docker" | "podman" | "custom";

export type SandboxFailureMode = "fail-hard" | "fallback-native";

export interface SandboxPolicy {
  allowNetwork?: boolean;
  allowedPaths?: string[];
}

export interface SandboxProjectSettings {
  backend?: SandboxBackendName;
  policy?: SandboxPolicy;
  failureMode?: SandboxFailureMode;
}

export type EvalFollowUpPolicy = "disabled" | "suggest-only" | "auto-create";

export interface EvalProjectSettings {
  enabled?: boolean;
  intervalMs?: number;
  evaluatorProvider?: string;
  evaluatorModelId?: string;
  followUpPolicy?: EvalFollowUpPolicy;
  retentionDays?: number;
}

export interface ResolvedEvalSettings {
  enabled: boolean;
  intervalMs: number;
  evaluatorProvider?: string;
  evaluatorModelId?: string;
  followUpPolicy: EvalFollowUpPolicy;
  retentionDays: number;
}

export type AgentMemoryInclusionMode = "full" | "index" | "off";
export type HeartbeatScopeDisciplineMode = "strict" | "lite" | "off";
export type HeartbeatPromptTemplate = "default" | "compact";

export interface OpenRouterModelFilters {
  supported_parameters?: string[];
  output_modalities?: string[];
}

export interface OpenRouterProviderPreferences {
  order?: string[];
  ignore?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  sort?: "price" | "throughput" | "latency";
  require_parameters?: boolean;
}

export type WorktrunkOnFailure = "fail" | "fallback-native";

/** Worktrunk integration settings. Mirrored across global and project tiers
 *  with field-level project-overrides-global precedence. See
 *  `resolveWorktrunkSettings` and FN-4621 in docs/settings-reference.md. */
export interface WorktrunkSettings {
  /** Master toggle. When true, Fusion delegates worktree create/sync/prune/remove
   *  to the external `worktrunk` CLI via the WorktreeBackend abstraction (FN-4622).
   *  Default: false. */
  enabled?: boolean;
  /** Absolute path to the `worktrunk` binary. When undefined, Fusion resolves via
   *  $PATH and falls back to the auto-install flow (FN-4624). */
  binaryPath?: string;
  /** Behavior when a delegated worktrunk operation fails.
   *  - "fail" (default): operation fails, task is paused with
   *    pausedReason "worktrunk_operation_failed", error surfaces to dashboard.
   *  - "fallback-native": fall back to Fusion's built-in worktree-pool and
   *    emit a one-shot dashboard alert. */
  onFailure?: WorktrunkOnFailure;
  /** Cached install path discovered by the auto-install flow.
   *  Set by Fusion engine; not intended for manual edits. */
  installedBinaryPath?: string;
}

/**
 * FNXC:McpConfig 2026-06-25-00:00:
 * MCP servers are trusted once enabled because downstream runtime slices may launch local commands or connect to operator-provided URLs. Store only declarations here; sensitive env, header, and token material MUST be represented as Fusion-managed secret references, never inline plaintext.
 */
export interface McpSecretRef {
  secretRef: string;
  scope: SecretScope;
}

export function isMcpSecretRef(value: unknown): value is McpSecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.secretRef === "string" &&
    candidate.secretRef.trim().length > 0 &&
    (candidate.scope === "project" || candidate.scope === "global")
  );
}

export type McpSensitiveValue = McpSecretRef | string;

export interface McpStdioTransport {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, McpSensitiveValue>;
}

export interface McpSseTransport {
  transport: "sse";
  url: string;
  headers?: Record<string, McpSensitiveValue>;
}

export interface McpStreamableHttpTransport {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, McpSensitiveValue>;
}

export type McpTransport = McpStdioTransport | McpSseTransport | McpStreamableHttpTransport;

export type McpServerDefinition = {
  name: string;
  enabled?: boolean;
} & McpTransport;

export interface McpServersSettings {
  enabled?: boolean;
  servers?: McpServerDefinition[];
}

export interface DashboardKeyboardShortcuts {
  /** Opens the dashboard Quick Chat surface. Empty string disables this shortcut. Default: "Space". */
  quickChat?: string;
  /** Opens or toggles the dashboard Terminal surface. Empty string disables this shortcut. Default: "Ctrl+`". */
  terminal?: string;
}

export interface GlobalSettings {
  /** Theme mode preference: dark, light, or system (follows OS). Default: "dark". */
  themeMode?: ThemeMode;
  /** Color theme preference for accent colors and styling. Default: "shadcn-ember"; "default" and "ocean" remain valid explicit legacy selections. */
  colorTheme?: ColorTheme;
  /** Token→hex override map for the customizable shadcn theme. Applied only when `colorTheme === "shadcn-custom"`; dashboard sanitizes keys and values before writing CSS custom properties. */
  shadcnCustomColors?: Record<string, string>;
  /** Dashboard font size scale percentage. Bounded to 85-125. Default: 100. */
  dashboardFontScalePct?: number;
  /**
   * FNXC:DashboardShortcuts 2026-07-04-00:00:
   * Dashboard keyboard shortcuts are global operator preferences because they control browser UI affordances, not project execution policy. Defaults keep Space for Quick Chat and Ctrl+` for Terminal; blank values intentionally disable an action.
   */
  dashboardKeyboardShortcuts?: DashboardKeyboardShortcuts;
  /**
   * FNXC:ModalDismissal 2026-06-29-00:00:
   * Modal backdrop dismissal is a global operator preference, not project policy. Default false keeps fixed modal overlays from closing on accidental outside clicks unless the operator opts in.
   */
  dismissModalsOnOutsideClick?: boolean;
  /** Active UI locale (e.g. `"en"`, `"zh-CN"`, `"fr"`). One of `SUPPORTED_LOCALES`.
   *  When unset, each surface resolves the locale at runtime (browser/env
   *  detection) and falls back to `DEFAULT_LOCALE` ("en"). */
  language?: Locale;
  /** Default AI model provider name (e.g. `"anthropic"`, `"openai"`).
   *  Must be set together with `defaultModelId`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultProvider?: string;
  /** Default AI model ID within the provider (e.g. `"claude-sonnet-4-5"`).
   *  Must be set together with `defaultProvider`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultModelId?: string;
  /** When true, force every AI lane onto the deterministic mock provider regardless
   *  of per-task or per-lane overrides. No network calls, zero token cost.
   *  Project `testMode` takes precedence over the global value. */
  testMode?: boolean;
  /**
   * User-edited or one-click-fetched pricing entries keyed by lowercased `provider:model`.
   *
   * FNXC:CommandCenter 2026-06-22-00:00:
   * Global pricing overrides let Command Center cost estimates reflect user-maintained or LiteLLM-refreshed rates while preserving the built-in MODEL_PRICING fallback for unedited models.
   */
  modelPricingOverrides?: Record<string, ModelPricing>;
  /** ISO timestamp for the last successful pricing refresh from the configured source. */
  modelPricingFetchedAt?: string;
  /** Source label or URL for the current global pricing override set. */
  modelPricingSource?: string;
  /** Fusion Model Router opt-in (U17/KTD9). When true, a conservative selection
   *  layer may down-route an allowlist of mechanical steps (dependabot bumps,
   *  lint-only fixes) to a cheap model tier before a session starts; everything
   *  else resolves to the configured default pair. OFF by default — when unset or
   *  false, model resolution is byte-identical to its non-router behavior.
   *  Selection is governed: it never returns a pair the model controls forbid and
   *  always defers to a column-agent override. */
  modelRouterEnabled?: boolean;
  /** Provider for the Model Router's cheap tier (U17). Used only when
   *  `modelRouterEnabled` is true and a step is allowlisted for down-routing.
   *  Must be set together with `modelRouterCheapModelId`; if either is unset the
   *  router falls back to the configured default pair. */
  modelRouterCheapProvider?: string;
  /** Model ID for the Model Router's cheap tier (U17). See
   *  `modelRouterCheapProvider`. */
  modelRouterCheapModelId?: string;
  /** Phase-1 FN-5741 write-only shadow seam toggle.
   *  When true, executor/self-healing/merger persist additive merge-request contract
   *  records and completion-handoff markers without changing merge authority.
   *  Project value (if set) takes precedence over this global value. Default: false. */
  mergeRequestContractShadowEnabled?: boolean;
  /** Fallback AI model provider used when the primary default model fails due to
   *  transient provider-side issues such as rate limits or overloaded capacity.
   *  Must be set together with `fallbackModelId`. */
  fallbackProvider?: string;
  /** Fallback AI model ID used with `fallbackProvider` when the primary default
   *  model fails due to transient provider-side issues such as rate limits or
   *  overloaded capacity. Must be set together with `fallbackProvider`. */
  fallbackModelId?: string;
  /** Default thinking effort level for AI agent sessions.
   *  Controls how much reasoning effort the model uses — higher levels
   *  produce better results but cost more. When undefined, the engine
   *  uses the model's default thinking level. */
  defaultThinkingLevel?: ThinkingLevel;
  /** When true, enables ntfy.sh push notifications for task completion and failures.
   *  Requires ntfyTopic to be set. Default: false. */
  ntfyEnabled?: boolean;
  /** ntfy.sh topic name for push notifications. When set along with ntfyEnabled,
   *  notifications are sent to {ntfyBaseUrl}/{topic} (default: https://ntfy.sh/{topic})
   *  when tasks complete or fail. */
  ntfyTopic?: string;
  /** Optional ntfy server base URL for push notifications.
   *  Must be an http:// or https:// URL. When omitted, notifications default to
   *  https://ntfy.sh. Example: "https://ntfy.internal.example" */
  ntfyBaseUrl?: string;
  /** Optional ntfy access token used for authenticated publishes.
   *  When set, Fusion sends `Authorization: Bearer <token>` with ntfy requests.
   *  Leave undefined to publish without authentication. */
  ntfyAccessToken?: string;
  /** List of notification events to send via ntfy.sh.
   *  When ntfyEnabled is true, only events in this list will trigger notifications.
   *  If undefined or empty when ntfyEnabled is true, all events are sent (backward compatible).
   *  Default: ["in-review", "merged", "failed"] */
  ntfyEvents?: NtfyNotificationEvent[];
  /** Dashboard hostname for ntfy.sh deep links. When set along with ntfyEnabled
   *  and ntfyTopic, notifications include a Click URL that opens the dashboard
   *  directly to the task. In multi-project setups the URL includes both
   *  ?project=<id>&task=<id> so the dashboard opens the correct project first.
   *  Example: "http://localhost:3000" or "https://fusion.example.com" */
  ntfyDashboardHost?: string;
  /** Optional global fallback per-task token budget defaults. */
  taskTokenBudget?: TaskTokenBudget;
  /** Default access policy applied to a secret when its row-level `access_policy`
   *  is null/unset. One of "auto" (return value to caller and audit),
   *  "prompt" (route through approvals), or "deny" (reject without prompt).
   *  Default when unset: "prompt". */
  secretsAccessPolicy?: SecretAccessPolicy;
  /** Read-only derived probe for cross-node secrets sync passphrase state.
   * Mirrors `hasSyncPassphraseConfigured(secretsStore)` against the reserved
   * `__sync_passphrase__` row in `secrets_global`. Never includes plaintext and
   * cannot be persisted via `updateSettings` / `updateGlobalSettings`. */
  secretsSyncPassphraseConfigured?: boolean;
  /** Policy for recovering tasks whose existing owning node becomes unavailable. */
  owningNodeHandoffPolicy?: OwningNodeHandoffPolicy;
  /** How long a task must remain in `status='failed'` before a push notification fires.
   *  Set to 0 to dispatch immediately (legacy behavior). Default: 30000 ms. */
  failureNotificationDelayMs?: number;
  /** `sticky-only` (default) defers failure notifications by `failureNotificationDelayMs`
   *  and suppresses them if the task self-recovers. `all` restores the legacy
   *  immediate-dispatch behavior. `terminal-only` suppresses failure notifications
   *  while the engine is still auto-retrying, and only notifies once the task is
   *  parked paused (`task.paused === true`) or escalated (`column === "in-review"`
   *  with `status === "failed"`). */
  failureNotificationMode?: "sticky-only" | "all" | "terminal-only";
  /** When true, enables webhook notifications for task lifecycle events.
   *  Requires webhookUrl to be set. Default: false. */
  webhookEnabled?: boolean;
  /** URL to send webhook notifications to.
   *  Must be an http:// or https:// URL. */
  webhookUrl?: string;
  /** Format of the webhook payload.
   *  - "slack": Slack incoming webhook format ({ text: message })
   *  - "discord": Discord webhook format ({ content: message })
   *  - "generic": Structured JSON with event/task/timestamp fields
   *  Default: "generic". */
  webhookFormat?: "slack" | "discord" | "generic";
  /** List of notification events to send via webhook.
   *  When webhookEnabled is true, only events in this list trigger webhooks.
   *  If undefined or empty when webhookEnabled is true, all events are sent.
   *  Default: [] (all events). */
  webhookEvents?: string[];
  /** Pluggable notification providers configuration. Additive to legacy ntfy
   *  settings so existing ntfy configuration continues working unchanged. */
  notificationProviders?: NotificationProviderConfig[];
  /** User-defined OpenAI/Anthropic-compatible API providers. */
  customProviders?: CustomProvider[];
  /** The default project ID for CLI operations when --project flag is not provided.
   *  Used to determine which project to operate on when not in a project directory.
   *  Set via `fn project set-default <name>`. */
  defaultProjectId?: string;
  /** Whether the first-run setup wizard has been completed.
   *  Set to true when the user completes the multi-project setup process.
   *  Default: false (undefined until setup is completed). */
  setupComplete?: boolean;
  /** ISO timestamp for completion of the `fn onboard` CLI wizard.
   *  Distinct from dashboard `setupComplete` first-run flow state.
   *  Undefined means CLI onboarding has not completed yet. */
  cliOnboardingCompletedAt?: string;
  /** List of favorite provider names. Favorite providers appear at the top of
   *  model selection dropdowns. Order is preserved - earlier entries appear higher. */
  favoriteProviders?: string[];
  /** List of favorite model identifiers. Each entry is formatted as `{provider}/{modelId}`
   *  (e.g., `"anthropic/claude-sonnet-4-5"`). Favorited models appear as pinned rows
   *  at the very top of model selection dropdowns, before provider groups. Order is
   *  preserved - earlier entries appear higher. */
  favoriteModels?: string[];
  /** When true, the dashboard eagerly fetches the latest model catalog from
   *  the OpenRouter API at startup so the model picker shows all available
   *  OpenRouter models (not just the static built-in list). Default: true. */
  openrouterModelSync?: boolean;
  /** Optional OpenRouter app-attribution header overrides.
   *  Use-time defaults are referer=`https://runfusion.ai` and title=`Fusion`.
   *  Empty string values intentionally suppress sending that header. */
  openrouterAppAttribution?: { referer?: string; title?: string };
  /** Optional OpenRouter model-catalog filters for startup sync fetches.
   *  Values are sent as comma-joined query params (`supported_parameters`,
   *  `output_modalities`) when configured. */
  openrouterModelFilters?: OpenRouterModelFilters;
  /** Optional OpenRouter provider routing preferences forwarded to chat
   *  completions as `compat.openRouterRouting`.
   *  Supports order/ignore/only provider lists, fallback behavior, sort mode,
   *  and require-parameters preference. */
  openrouterProviderPreferences?: OpenRouterProviderPreferences;
  /** When true, startup refreshes the opencode-go model catalog via
   *  `opencode models opencode --refresh` so model pickers expose an up-to-date
   *  opencode-go provider list without waiting for a later session bootstrap.
   *  Default: true. */
  opencodeGoModelSync?: boolean;
  /** When true (default), checks npm for new versions of @runfusion/fusion and
   *  shows update notices in the CLI and dashboard. The actual cadence is
   *  governed by `updateCheckFrequency`. Disabled = no automatic checks at all. */
  updateCheckEnabled?: boolean;
  /** When true (default), the dashboard probes PATH for a globally-installed
   *  `fn`/`fusion` CLI binary so it can advertise install/upgrade actions in
   *  the UI. The probe spawns `<bin> --version`, which executes whichever
   *  `runfusion.ai` is on PATH. Set to false to skip the probe entirely —
   *  useful when the local dev process is the source of truth and shelling
   *  out to an outdated globally-installed binary is unwanted. */
  fnBinaryCheckEnabled?: boolean;
  /** Global fallback GitHub tracking repo in `owner/repo` format (FN-3868).
   *  Used when a project has no githubTrackingDefaultRepo. */
  githubTrackingDefaultRepo?: string;
  /** Global GitLab integration enable flag. Undefined is effectively enabled for backward compatibility; projects can override this value. */
  gitlabEnabled?: boolean;
  /** Global fallback GitLab web instance URL. Defaults effectively to https://gitlab.com when unset.
   *  Project gitlabInstanceUrl overrides this value. */
  gitlabInstanceUrl?: string;
  /** Global fallback GitLab REST API base URL. When unset, Fusion derives `<instance>/api/v4`.
   *  Project gitlabApiBaseUrl overrides this value. */
  gitlabApiBaseUrl?: string;
  /**
   * FNXC:GitLabAuthentication 2026-07-02-00:00:
   * FN-7423 accepts personal, project, and group GitLab access tokens for later HTTP API import/tracking/comment/close tasks. Global values are fallbacks only; project settings override them and project/group token resource membership still constrains runtime access.
   */
  /** Global fallback GitLab access token. Stored as a plain settings string in this phase; UI must render it only as a password field. */
  gitlabAuthToken?: string;
  /** Global fallback GitLab token type label. Defaults effectively to "personal" when a token exists and this is unset. */
  gitlabAuthTokenType?: GitlabAuthTokenType;
  /** Cadence for automatic update checks. The dashboard's `/update-check`
   *  route uses this to decide whether to consult npm or return a cached
   *  result.
   *  - `manual`: never auto-check; only when the user clicks "Check now"
   *  - `on-startup`: refresh once when the server starts, then cache
   *    indefinitely until next startup
   *  - `daily` (default): 24h cache TTL
   *  - `weekly`: 7-day cache TTL
   */
  updateCheckFrequency?: "manual" | "on-startup" | "daily" | "weekly";
  /** When true (default), the dashboard automatically reloads when a new build
   *  version is detected via /version.json polling or service worker activation.
   *  Set to false to suppress automatic reloads — the user must manually
   *  refresh to pick up updates. */
  autoReloadOnVersionChange?: boolean;
  /** When true, indicates the user has completed the AI model onboarding flow
   *  (connected at least one provider and selected a default model). When
   *  false/undefined, the dashboard will auto-open the onboarding modal.
   *  Also set to true when the user explicitly dismisses onboarding. */
  modelOnboardingComplete?: boolean;
  /** When true, route AI model calls through the locally-installed Claude CLI
   *  via the `pi-claude-cli` pi extension (instead of the direct Anthropic
   *  API). Enabling this also causes Fusion to symlink its skill into each
   *  project's `.claude/skills/fusion/` on `fn init`, `fn project add`,
   *  dashboard project creation, and server startup — so the skill is
   *  available inside Claude Code sessions that pi spawns.
   *
   *  When left undefined, detection falls back to scanning the `packages`
   *  array in the agent settings for `"npm:pi-claude-cli"` (legacy signal).
   *  Setting this field explicitly (true/false) always wins. */
  useClaudeCli?: boolean;
  /** When true, route Factory AI model calls through the locally-installed Droid CLI
   *  via the `droid-cli` provider path (instead of direct API provider calls).
   *
   *  When left undefined, Droid CLI routing stays disabled unless explicitly enabled
   *  by the dashboard auth toggle. Setting this field explicitly (true/false)
   *  always wins. */
  useDroidCli?: boolean;
  /** When true, enable llama.cpp model-provider support (provider ID: `llama-server`)
   *  via Fusion's bundled `@fusion/pi-llama-cpp` extension.
   *
   *  When left undefined, llama.cpp routing stays disabled unless explicitly enabled
   *  by the dashboard auth toggle. Setting this field explicitly (true/false)
   *  always wins. */
  useLlamaCpp?: boolean;
  /** When true, enable Cursor CLI model-provider support (provider ID: `cursor-cli`)
   *  through an operator-local Cursor CLI installation. */
  useCursorCli?: boolean;
  /**
   * FNXC:CursorCli 2026-07-02-00:00:
   * Operators need a global machine-local Cursor CLI executable override when PATH discovery resolves the wrong `cursor-agent`, `cursor`, `.cmd`, or `.bat` shim. Blank/undefined means Fusion must keep auto-detecting through PATH candidates.
   */
  cursorCliBinaryPath?: string;
  /** Global baseline AI model provider for task execution (executor agent).
   *  This is the global lane that project-level `executionProvider` can override.
   *  Must be set together with `executionGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  executionGlobalProvider?: string;
  /** Global baseline AI model ID for task execution.
   *  Must be set together with `executionGlobalProvider`. */
  executionGlobalModelId?: string;
  /** Global baseline AI model provider for planning/triage (specification) agent.
   *  This is the global lane that project-level `planningProvider` can override.
   *  Must be set together with `planningGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  planningGlobalProvider?: string;
  /** Global baseline AI model ID for planning/triage.
   *  Must be set together with `planningGlobalProvider`. */
  planningGlobalModelId?: string;
  /** Global baseline AI model provider for validator/reviewer agent.
   *  This is the global lane that project-level `validatorProvider` can override.
   *  Must be set together with `validatorGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  validatorGlobalProvider?: string;
  /** Global baseline AI model ID for validator/reviewer.
   *  Must be set together with `validatorGlobalProvider`. */
  validatorGlobalModelId?: string;
  /** Global baseline AI model provider for title summarization.
   *  This is the global lane that project-level `titleSummarizerProvider` can override.
   *  Must be set together with `titleSummarizerGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  titleSummarizerGlobalProvider?: string;
  /** Global baseline AI model ID for title summarization.
   *  Must be set together with `titleSummarizerGlobalProvider`. */
  titleSummarizerGlobalModelId?: string;
  /** The daemon authentication token (format: fn_<32 hex chars>).
   *  Used for authenticating CLI clients to the daemon server. */
  daemonToken?: string;
  /** Port for daemon mode server binding. Default: 4040. */
  daemonPort?: number;
  /** Host for daemon mode server binding. Default: "127.0.0.1" (localhost only).
   *  Set to "0.0.0.0" explicitly to expose the API on all interfaces — only do
   *  this if you understand the implications (terminal/exec endpoints become
   *  reachable from the LAN even with a bearer token). */
  daemonHost?: string;
  /** When true, enables automatic settings synchronization between nodes.
   *  Settings are pushed/pulled on the configured interval. Default: false. */
  settingsSyncEnabled?: boolean;
  /** When true, model auth credentials (API keys) are included in sync operations.
   *  Only applies when settingsSyncEnabled is also true. Default: false. */
  settingsSyncAuth?: boolean;
  /** How often automatic settings sync runs, in milliseconds.
   *  Valid values: 300000 (5m), 900000 (15m), 1800000 (30m), 3600000 (1h).
   *  Default: 900000 (15m). */
  settingsSyncInterval?: number;
  /** Conflict resolution strategy when synced settings differ between nodes.
   *  - "last-write-wins": The most recent change overwrites (default)
   *  - "always-ask": Prompt the user to choose
   *  - "keep-local": Keep the local version on conflict
   *  - "keep-remote": Accept the remote version on conflict
   *  Default: "last-write-wins". */
  settingsSyncConflictResolution?: "last-write-wins" | "always-ask" | "keep-local" | "keep-remote";
  /** Currently selected dashboard node ID. Used to restore the last-viewed node
   *  on fresh browser/PWA sessions. Null or undefined means viewing the local node.
   *  Persisted to global settings so it survives across browser restarts. */
  dashboardCurrentNodeId?: string;
  /** Map of node ID to the last-selected project ID for that node.
   *  The key is the node ID (use `"local"` for the local node).
   *  Persisted to global settings so project context is restored on fresh sessions.
   *  Clear individual entries by setting them to `undefined` (omitting from update).
   *  Clearing all entries returns the dashboard to overview mode. */
  dashboardCurrentProjectIdByNode?: Record<string, string>;
  /** When true, the dashboard TUI's memory guard will SIGKILL any running
   *  vitest processes once system memory usage crosses
   *  {@link vitestKillThresholdPct}. The kill is throttled to once per 30
   *  seconds. Default: true. */
  vitestAutoKillEnabled?: boolean;
  /** System-memory usage percent (0–100) at which the TUI memory guard
   *  triggers a vitest auto-kill. Clamped to [50, 99] in the UI.
   *  Default: 90. */
  vitestKillThresholdPct?: number;
  /** When true (default), persist tool argument/result payloads in task agent
   *  logs for `tool`, `tool_result`, and `tool_error` entries. Very large tool
   *  payloads may still be clipped server-side to keep dashboard log reads
   *  responsive. When false, tool timeline rows are still stored, but their
   *  verbose `detail` payload is omitted to reduce log size/noise. Distinct
   *  from `persistAgentThinkingLog`, which controls `thinking` rows. */
  persistAgentToolOutput?: boolean;
  /** When true, persist `thinking` log entries from agent reasoning deltas for
   *  permanent (non-ephemeral) agents. Default: false (suppressed). */
  persistAgentThinkingLogPermanent?: boolean;
  /** When true, persist `thinking` log entries from agent reasoning deltas for
   *  ephemeral / task-worker / spawned agents. Default: false (suppressed). */
  persistAgentThinkingLogEphemeral?: boolean;
  /** @deprecated Use `persistAgentThinkingLogPermanent` and
   *  `persistAgentThinkingLogEphemeral` instead.
   *
   *  Legacy fallback: when explicitly set and one of the granular fields is
   *  undefined, this value seeds that undefined granular kind at read time.
   *  Default: false (suppressed). */
  persistAgentThinkingLog?: boolean;
  /** Global default for memory prompt inclusion mode across projects/agents.
   *  - "full": inline full curated memory content into prompts (default)
   *  - "index": include only a compact memory index, then fetch on demand via memory tools
   *  - "off": omit agent-memory prompt sections entirely
   */
  agentMemoryInclusionMode?: AgentMemoryInclusionMode;
  /** Research defaults shared across all projects.
   * Project settings may override these via `researchSettings`. */
  researchGlobalDefaults?: ResearchGlobalDefaults;
  /** Enable or disable the research subsystem globally.
   *  When false, dashboard/API entrypoints should reject new research runs.
   *  Default: true when research store exists. */
  researchGlobalEnabled?: boolean;
  /** Maximum concurrent research runs allowed by default.
   *  Default: 3. */
  researchGlobalMaxConcurrentRuns?: number;
  /** Default timeout for end-to-end research runs in milliseconds.
   *  Default: 300000 (5 minutes). */
  researchGlobalDefaultTimeout?: number;
  /** Default maximum number of sources the orchestrator may fetch per run.
   *  Default: 20. */
  researchGlobalMaxSourcesPerRun?: number;
  /** Default maximum number of synthesis rounds per run.
   *  Default: 2. */
  researchGlobalMaxSynthesisRounds?: number;
  /** Web search backend for auto-research. Default: "builtin"; web search itself cannot be disabled. */
  researchGlobalWebSearchProvider?: WebSearchBackend;
  /** SearXNG instance URL (required when researchGlobalWebSearchProvider is "searxng"). */
  researchGlobalSearxngUrl?: string;
  /** Brave Search API key (required when researchGlobalWebSearchProvider is "brave"). */
  researchGlobalBraveApiKey?: string;
  /** Google Custom Search API key (required when researchGlobalWebSearchProvider is "google"). */
  researchGlobalGoogleSearchApiKey?: string;
  /** Google Custom Search engine ID (required when researchGlobalWebSearchProvider is "google"). */
  researchGlobalGoogleSearchCx?: string;
  /** Tavily API key (required when researchGlobalWebSearchProvider is "tavily"). */
  researchGlobalTavilyApiKey?: string;
  /** Enable GitHub repository/issue search provider. Default: false. */
  researchGlobalGitHubEnabled?: boolean;
  /** Enable local project documentation search provider. Default: true. */
  researchGlobalLocalDocsEnabled?: boolean;
  /** Maximum search results per provider query. Default: 10. */
  researchGlobalMaxSearchResults?: number;
  /** HTTP fetch timeout in milliseconds for page/content fetching. Default: 30000. */
  researchGlobalFetchTimeoutMs?: number;
  /** User-Agent header for HTTP requests made by research providers. Default: "FusionResearchBot/1.0". */
  researchGlobalUserAgent?: string;
  /** Global-scoped remote access configuration persisted in `~/.fusion/settings.json`.
   *  Stores both provider configs, active provider selection, token strategy,
   *  and lifecycle restart metadata for remote tunnel orchestration. */
  remoteAccess?: RemoteAccessProjectSettings;
  /** Global defaults for user-configurable MCP servers.
   *  Project-level `mcpServers` entries override by server name and may disable
   *  a global server without deleting the global declaration. */
  mcpServers?: McpServersSettings;
  /** Global defaults for worktrunk integration.
   *  Merged with project-level `worktrunk` field-by-field in `getSettings()`/
   *  `getSettingsFast()` so partial project overrides inherit unspecified fields. */
  worktrunk?: WorktrunkSettings;
  /** Global-scoped experimental feature toggles.
   *  Each key is a feature flag name, and the value indicates whether it is enabled.
   *  Features not present in this map are considered disabled (fallback to false).
   *  This allows users to explicitly mark capabilities as experimental and toggle
   *  them on/off from the Settings dashboard.
   *
   *  Example shape:
   *  {
   *    "my-new-feature": true,
   *    "another-experiment": false
   *  }
   *
   *  Default: only dual-observe is emitted and remains disabled because it runs
   *  diagnostic shadow parity observation. Workflow columns and graph execution
   *  have graduated from this map; stale persisted values are ignored by their
   *  runtime helpers.
   *
   *  `claudeCliAcp` (default ON): routes the Claude CLI provider through the
   *  `claude-code-cli-acp` ACP bridge instead of `claude -p`. Effective only when
   *  the acp-runtime plugin is installed (it publishes the bundled bridge path);
   *  otherwise the provider fails closed to `-p`. Set false to force `-p`. */
  experimentalFeatures?: Record<string, boolean>;
  /** Per-adapter CLI-agent launch configuration (CLI Agent Executor, U15).
   *  Keyed by adapter id (e.g. `"claude-code"`, `"codex"`, `"generic"`). Each
   *  entry carries operator overrides layered over the adapter's shipped
   *  defaults: a command override, extra args, an autonomy mode, and env
   *  allowlist additions. Validated + sanitized at the write boundary
   *  (`sanitizeCliAgentsSettings`); invalid entries/fields are dropped.
   *
   *  Note: elevation expressed through ANY of these channels (autonomy mode,
   *  extra args, env additions, a non-default command override) is gated by a
   *  stored per-project approval at launch — see `@fusion/engine`'s
   *  `resolveEffectivePosture`. These settings only describe *intent*; the
   *  engine resolves and enforces posture. Default: {} (no overrides). */
  cliAgents?: Record<string, CliAgentSettings>;
}

/** Operator launch config for one CLI-agent adapter (U15). Values are layered
 *  over the adapter's shipped defaults at launch. All fields optional; an empty
 *  object means "use shipped defaults". */
export interface CliAgentSettings {
  /** Override for the binary path/name to invoke. A non-default value is treated
   *  as privileged (routes through the autonomy approval gate). */
  commandOverride?: string;
  /** Extra args appended after the adapter's computed base args. Free-form; the
   *  engine's elevation detector scans these for bypass markers. */
  extraArgs?: string[];
  /** Autonomy mode above the adapter baseline. `"default"` is the baseline (no
   *  elevation); `"elevated"` requests bypass-permissions-style autonomy and is
   *  gated. Kept as a string enum so adapters can map it to their own flags. */
  autonomyMode?: "default" | "elevated";
  /** Additional env var KEYS to forward from the parent process to the child.
   *  Names only (never values); the engine copies these from `process.env`.
   *  Service credentials (`FUSION_*`) are always excluded regardless. */
  envAdditions?: string[];
}

export type RemoteAccessProvider = "tailscale" | "cloudflare";

export interface RemoteAccessProvidersConfig {
  tailscale: {
    enabled: boolean;
    hostname: string;
    targetPort: number;
    acceptRoutes: boolean;
  };
  cloudflare: {
    enabled: boolean;
    quickTunnel: boolean;
    tunnelName: string;
    tunnelToken: string | null;
    ingressUrl: string;
  };
}

export interface RemoteAccessTokenStrategyConfig {
  persistent: {
    enabled: boolean;
    token: string | null;
  };
  shortLived: {
    enabled: boolean;
    ttlMs: number;
    maxTtlMs: number;
  };
}

export interface RemoteAccessLifecycleConfig {
  rememberLastRunning: boolean;
  wasRunningOnShutdown: boolean;
  lastRunningProvider: RemoteAccessProvider | null;
}

export interface RemoteAccessProjectSettings {
  activeProvider: RemoteAccessProvider | null;
  providers: RemoteAccessProvidersConfig;
  tokenStrategy: RemoteAccessTokenStrategyConfig;
  lifecycle: RemoteAccessLifecycleConfig;
}

/** GitHub authentication strategy used by project issue-tracking settings (FN-3868). */
export type GithubAuthMode = "gh-cli" | "token";

/** GitLab access-token family configured for future HTTP API integrations (FN-7423). */
export type GitlabAuthTokenType = "personal" | "project" | "group";

export interface SecretsEnvSettings {
  /** Default: false. When true, materialize env_exportable secrets into the worktree on creation. */
  enabled?: boolean;
  /** Default: ".env". Must be a relative path with no separators, "..", or null bytes. */
  filename?: string;
  /** Default: "merge". skip = leave existing file untouched; merge = preserve non-managed lines, overlay Fusion-managed block; replace = overwrite with managed block only. */
  overwritePolicy?: "skip" | "merge" | "replace";
  /** Optional case-sensitive key prefix filter — only secrets whose `key` starts with this prefix are exported. */
  keyPrefix?: string;
  /** Default: true. When true, refuse to write if `git check-ignore <filename>` reports the path is NOT ignored. */
  requireGitignored?: boolean;
}

/** @deprecated Use SecretsEnvSettings. */
export type SecretsEnvConfig = SecretsEnvSettings;

/**
 * Project-level settings stored in `.fusion/config.json`.
 *
 * These control how the engine operates for this particular project:
 * concurrency, merge strategy, worktree management, build/test commands, etc.
 * Runtime state fields (globalPause, enginePaused) also live here because
 * different projects may need independent pause control.
 */
export interface ProjectSettings {
  /** Hard stop: when true, all automated agent activity is **immediately**
   *  terminated — active triage, execution, and merge agent sessions are
   *  killed, and the scheduler stops dispatching new work. Acts as a
   *  global emergency stop for the entire AI engine.
   *  Individual per-task pause flags are unaffected. */
  globalPause?: boolean;
  /** Tracks why globalPause was activated. "rate-limit" for automatic pauses,
   *  "manual" for user-initiated. Cleared on unpause. */
  globalPauseReason?: string;
  /** Default custom workflow (WF-…) applied to newly created tasks when the
   *  caller does not specify enabledWorkflowSteps. Overridable per task. */
  defaultWorkflowId?: string;
  /** Built-in workflow ids visible/selectable in project workflow pickers.
   *  Undefined preserves the default of showing every built-in workflow. */
  enabledBuiltinWorkflowIds?: string[];
  /** Raw CLI commands a user has explicitly approved for workflow CLI nodes
   *  (trust-on-first-use). A node's command must appear here before it runs;
   *  named scripts (settings.scripts) never require approval. */
  approvedWorkflowCliCommands?: string[];
  /** CLI-agent adapter ids the project owner has approved for ELEVATED autonomy
   *  (CLI Agent Executor, U15). An adapter must appear here before a launch whose
   *  resolved posture is elevated (bypass-permissions-style) is permitted; an
   *  unapproved elevation fails the launch with a typed error. Approving
   *  principal in v1: the daemon-token holder (the single workspace owner). */
  approvedCliAutonomyAdapters?: string[];
  /** Engine pause (soft pause): when true, the scheduler and triage
   *  processor stop dispatching **new** work (scheduling, triage
   *  specification, and auto-merge), but currently running agent sessions
   *  are allowed to finish naturally — no sessions are terminated.
   *  This is the normal on/off toggle for the AI engine.
   *  Contrast with {@link globalPause}, which is a hard stop that
   *  immediately terminates all active agent sessions. Has no additional
   *  effect when {@link globalPause} is also true (hard stop already
   *  covers everything). */
  enginePaused?: boolean;
  /**
   * FNXC:TaskTiming 2026-06-25-00:00:
   * Records the last time the engine process proved it was alive so startup recovery can exclude process-down wall-clock time from active task duration without changing firstExecutionAt.
   */
  engineLastActiveAt?: string;
  /** Maximum number of concurrent AI agents across all activity types
   *  (triage specification, task execution, and merge operations). */
  maxConcurrent: number;
  /** Maximum number of concurrent triage/specification agents. When undefined,
   *  falls back to maxConcurrent. */
  maxTriageConcurrent?: number;
  /** System-wide maximum concurrent agents across ALL projects.
   *  When multiple projects are active, the sum of their in-flight agents
   *  will not exceed this limit. Applies to triage, execution, and merge.
   *  Default: 4. When undefined, falls back to CentralCore default (4). */
  globalMaxConcurrent?: number;
  maxWorktrees: number;
  pollIntervalMs: number;
  /** Global multiplier applied to all agent heartbeat intervals.
   *  For example, 0.5 halves the interval (faster checks), 2.0 doubles it (slower checks).
   *  Must be > 0. Default: 1 (no change). */
  heartbeatMultiplier?: number;
  /** Number of auto-claim candidates rendered in no-task heartbeat prompts. Range: 0-10. Default: 5. */
  autoClaimCandidatesInPrompt?: number;
  /** Opt engineer-role agents into no-task backlog auto-claim. Default: false. */
  engineerBacklogAutoClaim?: boolean;
  /** Sticky window for intake duplicate checks against soft-deleted tasks.
   * Unit: days. Default: 7. Set to 0 to disable tombstone-window widening. */
  tombstoneStickyWindowDays?: number;
  /** Heartbeat scope-discipline procedure mode.
   * - "strict": coordination-focused scope discipline (default)
   * - "lite": pre-FN-3884 behavior
   * - "off": minimal procedure with no scope-classification step
   */
  heartbeatScopeDiscipline?: HeartbeatScopeDisciplineMode;
  /** Heartbeat execution prompt template mode.
   * - "default": richer context with higher caps (default)
   * - "compact": lower caps to reduce prompt size
   */
  heartbeatPromptTemplate?: HeartbeatPromptTemplate;
  groupOverlappingFiles: boolean;
  /**
   * When true (default), file-overlap serialization ignores project-relative paths
   * containing any hidden dot segment (for example `.fusion/`, `.changeset/`,
   * `.github/`, `.env`, or `packages/.cache/out.js`). Set false to restore the
   * legacy behavior that counts hidden paths as overlap blockers.
   */
  ignoreHiddenOverlapPaths?: boolean;
  /** File/directory paths to ignore when evaluating overlap serialization.
   *  Entries are project-relative paths (for example: `docs/README.md`, `docs/`, `generated/*`).
   *  Absolute paths and `..` traversal are not allowed.
   *  When set, matching paths are excluded from overlap checks for both
   *  active in-progress tasks and in-review tasks with unmerged worktrees. */
  overlapIgnorePaths?: string[];
  /**
   * FNXC:FileBrowser 2026-06-29-00:00:
   * Project owners can opt the workspace file browser into slash-prefixed absolute paths for local admin workflows. Default false keeps browsing confined to the selected project/task workspace; this does not apply to task-local file APIs, memory, plugin bundles, worktree-copy validation, or Windows drive-letter paths.
   */
  allowAbsoluteFileBrowserPaths?: boolean;
  autoMerge: boolean;
  /** When true, force every AI lane onto the deterministic mock provider regardless
   *  of per-task or per-lane overrides. No network calls, zero token cost. */
  testMode?: boolean;
  /** Phase-1 FN-5741 write-only shadow seam toggle.
   *  Overrides global `mergeRequestContractShadowEnabled` when defined.
   *  Default: false. */
  mergeRequestContractShadowEnabled?: boolean;
  /** How completed in-review tasks should be finalized when autoMerge is enabled.
   *  - "direct": preserve the existing local squash-merge flow into the current branch
   *  - "pull-request": create or reuse a GitHub PR and wait for GitHub-side checks/reviews
   *    before merging through GitHub
   *  Default: "direct" for backward compatibility. */
  mergeStrategy?: MergeStrategy;
  /** When true, only auto-merge a pull request after it has at least one approving
   *  review (`reviewDecision === "APPROVED"`). Independent of GitHub's branch-protection
   *  `required` flag, so this works on free private repos where required reviewers can't
   *  be enforced server-side. Only applies when `mergeStrategy === "pull-request"`.
   *  Default: false. */
  requirePrApproval?: boolean;
  /** When true (default), the Review-response loop automatically acts on PR review
   *  threads (human + bot): it dispatches an agent that fixes + pushes + replies, or
   *  disagrees with reasoning. When false, the loop is inert — review threads are left
   *  untouched for a human to handle. Independent of `autoMerge`: with auto-resolution
   *  on but auto-merge off, threads are still resolved but the PR is NOT merged (the
   *  human checkpoint remains merge). U18, R15. Default: true. */
  autoResolveReviewComments?: boolean;
  /** Direct-merge commit routing mode.
   *  - "auto": squash single-substantive branches, preserve history for multi-substantive branches
   *  - "always-squash": always use the legacy squash path for direct merges
   *  - "always-rebase": always preserve individual branch commits during direct merges
   *  Only applies when mergeStrategy is "direct". Default: "always-squash". */
  directMergeCommitStrategy?: DirectMergeCommitStrategy;
  /** Auto-merge integration-root mode.
   *  - "reuse-task-worktree" (default): run the auto-merge cascade in the task worktree
   *  - "cwd-integration-branch": explicit opt-in only. Runs merge operations in the user's
   *    checked-out integration-branch worktree, violating the FN-5349 invariant unless the user
   *    explicitly accepts that risk.
   *  - "cwd-main": legacy alias for "cwd-integration-branch" (normalized at read time)
   *  Auto-merge only; manual/direct merge entrypoints outside auto-merge are unchanged. */
  mergeIntegrationWorktree?: MergeIntegrationWorktreeMode;
  /** After the merger advances the integration branch ref, what to do in *other*
   *  worktrees that have the same branch checked out (typically the user's
   *  project-root checkout that sat at the previous tip).
   *  - "off": do nothing; the user must `git pull` (or click the Merge Advance
   *    Notice banner's Pull button) to bring their checkout forward.
   *  - "ff-only": fast-forward the other worktree only when its index and
   *    working tree are clean. Dirty worktrees are left alone and the banner
   *    still surfaces for manual handling.
   *  - "stash-and-ff" (default): run the Smart Pull pipeline
   *    (stash → fast-forward → pop) so local edits survive across the
   *    auto-sync. Pop conflicts surface as `merge:auto-sync` audit events with
   *    `outcome: "stash-pop-conflict"` and are forwarded to the dashboard's
   *    existing stash-conflict modal.
   *  Only applies to direct merges (`mergeStrategy === "direct"`). */
  mergeAdvanceAutoSync?: MergeAdvanceAutoSyncMode;
  /** Explicit integration branch name (e.g. `main`, `master`, `trunk`, `develop`).
   *  Resolution order: `integrationBranch` → `baseBranch` → `origin/HEAD` → `main`.
   *  This value is used as the `projectDefaultBranch` input to `resolveTaskMergeTarget`. */
  integrationBranch?: string;
  /** When true, automatically push to the configured remote after a successful direct merge.
   *  The push process includes pulling the latest from the remote (rebase) first.
   *  If conflicts arise during the pull, they are resolved using the AI conflict resolution pipeline.
   *  Only applies when mergeStrategy is "direct". Default: false. */
  pushAfterMerge?: boolean;
  /** The git remote and branch to push to after merging (e.g. "origin", "origin main").
   *  When set to just a remote name (e.g. "origin"), the current branch is pushed.
   *  When set to "remote branch" format, both the remote and branch are specified.
   *  Only used when pushAfterMerge is true. Default: "origin". */
  pushRemote?: string;
  /** Policy for how to route execution when the selected node is unavailable/unhealthy.
   *  Applies to both project default node selection and per-task node overrides.
   *  - "block": prevent execution until the selected node is healthy/available (default)
   *  - "fallback-local": run on the local node when the selected node is unavailable */
  unavailableNodePolicy?: UnavailableNodePolicy;
  /** Policy for tasks already owned by an unavailable node.
   *  - "block": keep parked until owner recovers
   *  - "reassign-to-local": let local node take over (default)
   *  - "reassign-any-healthy": any healthy node may claim */
  owningNodeHandoffPolicy?: OwningNodeHandoffPolicy;
  /** Project-level research configuration overrides. */
  researchSettings?: ResearchProjectSettings;
  /** Optional per-project `.env` materialization settings for exportable secrets. */
  secretsEnv?: SecretsEnvSettings;
  /** Project-scoped MCP server overrides.
   *  Entries override global server declarations by name; `enabled: false` on a
   *  same-named entry disables that server for this project. */
  mcpServers?: McpServersSettings;
  /** Sandbox command-execution settings.
   *  When omitted, runtime behavior is preserved via native passthrough defaults. */
  sandbox?: SandboxProjectSettings;
  /** Project-level scheduled eval configuration overrides. */
  evalSettings?: EvalProjectSettings;
  /** Enable scheduled evaluation batches for recently completed tasks. */
  taskEvaluationEnabled?: boolean;
  /** Cron expression for scheduled task-evaluation batches. */
  taskEvaluationSchedule?: string;
  /** Optional provider override for scheduled task evaluation runs. */
  taskEvaluationProvider?: string;
  /** Optional model override for scheduled task evaluation runs. */
  taskEvaluationModelId?: string;
  /** Follow-up policy for scheduled task evaluation findings. */
  taskEvaluationFollowUpPolicy?: "off" | "suggest" | "create";
  /** Optional retention window (days) for task evaluation history. */
  taskEvaluationRetention?: number;
  /** Enable or disable the research subsystem for this project.
   *  When undefined, falls back to global settings.
   *  @deprecated Prefer researchSettings.enabled */
  researchEnabled?: boolean;
  /** Project-level maximum concurrent research runs.
   *  When undefined, falls back to global settings (default 3). */
  researchMaxConcurrentRuns?: number;
  /** Project-level default run timeout in milliseconds.
   *  When undefined, falls back to global settings (default 300000). */
  researchDefaultTimeout?: number;
  /** Project-level source fetch cap per run.
   *  When undefined, falls back to global settings (default 20). */
  researchMaxSourcesPerRun?: number;
  /** Project-level synthesis round cap per run.
   *  When undefined, falls back to global settings (default 2). */
  researchMaxSynthesisRounds?: number;
  /** ID of the pinned default execution node. Tasks without a per-task override run on this node. */
  defaultNodeId?: string;
  /** Shell command to run inside each new worktree immediately after creation.
   *  Useful for project-specific setup (e.g. `pnpm install --frozen-lockfile`, `cp .env.local .env`). */
  worktreeInitCommand?: string;
  /**
   * Repository-root-relative regular files copied into newly assigned non-resume task worktrees.
   *
   * FNXC:WorktreeCopyFiles 2026-06-24-00:00:
   * Operators need `.env`-style repo files available before worktree init commands run without embedding shell copy commands in setup. Entries stay root-relative, copy only regular files, and apply only when Fusion prepares a fresh or pooled assignment so resume worktrees keep their existing on-disk state.
   */
  worktreeCopyFiles?: string[];
  /** Custom test command for the project (e.g. "pnpm test") */
  testCommand?: string;
  /** Custom build command for the project (e.g. "pnpm build") */
  buildCommand?: string;
  /** When true, completed task worktrees are returned to an idle pool instead
   *  of being deleted. New tasks acquire a warm worktree from the pool,
   *  preserving build caches (node_modules, target/, dist/). Default: false. */
  recycleWorktrees?: boolean;
  /**
   * Controls whether the board shows worktree grouping and worktree-name labels in WIP/processing columns.
   *
   * FNXC:WorktreeGroupingSetting 2026-06-27-22:30:
   * This is an explicit show/hide project setting. The default-off state hides worktree grouping and labels in both legacy and workflow-mode WIP columns; when enabled, operators see grouping in every WIP/processing column, including workflow-mode columns flagged as counting toward WIP.
   */
  showWorktreeGrouping?: boolean;
  /**
   * When true, board task-card clicks open task detail in the right dock when that dock surface is active; otherwise board clicks keep the full main-panel task detail. Default: false.
   *
   * FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
   * This project-scoped setting is default-off so current board navigation is unchanged. When enabled, only Board card clicks may route to the tablet/desktop right dock; all non-board task-open paths and dock-inactive/mobile states must preserve the full-panel or existing modal behavior.
   */
  openTasksInRightSidebar?: boolean;
  /**
   * When true, ordinary board task-card clicks open task detail in the existing popped-out FloatingWindow task surface instead of the full main-panel task detail. Default: false.
   *
   * FNXC:MobileTaskPopups 2026-07-01-12:00:
   * This project-scoped setting is default-off so board navigation is unchanged until operators opt in. When enabled, it applies to board-card clicks on every viewport with no deep initial tab and reuses the existing task pop-out/FloatingWindow path; the popup route takes precedence over right-dock routing for those ordinary clicks while all non-board task-open paths remain governed by their existing settings and handlers.
   */
  openMobileTasksInPopup?: boolean;
  /**
   * FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
   * Default-off keeps task details Activity-first so omitted non-done opens land on the legacy `chat` Activity → Live surface. Operators can set true to restore Chat-first ordering/default while explicit Activity/Chat/Logs deep links remain stable.
   */
  taskDetailChatFirst?: boolean;
  /** When true, restores the legacy behavior of silently creating sibling
   *  branches like `fusion/FN-123-2` when the canonical task branch is already
   *  checked out elsewhere. Default: false. */
  executorAllowSiblingBranchRename?: boolean;
  /** Controls how worktree directory names are generated when creating fresh worktrees.
   *  Only applies when recycleWorktrees is NOT enabled (pooled worktrees retain their existing names).
   *  - "random": Human-friendly adjective-noun names (e.g., swift-falcon) — default
   *  - "task-id": Use the task ID (e.g., fn-042)
   *  - "task-title": Use a slugified version of the task title (e.g., fix-login-bug)
   *  Default: "random". */
  worktreeNaming?: "random" | "task-id" | "task-title";
  /** Project-level worktrunk integration overrides.
   *  Merged with global `worktrunk` field-by-field so partial project values
   *  override only specified fields and inherit the rest. */
  worktrunk?: WorktrunkSettings;
  /** Optional container directory for task worktrees.
   *  When unset, worktrees default to `<projectRoot>/.worktrees`.
   *  Supports leading `~` expansion and the `{repo}` token (basename of the project root).
   *  Accepts absolute paths or paths relative to the project root.
   *  Affects newly-created worktrees and pool/self-healing directory scans only;
   *  existing `task.worktree` absolute paths are honored as-is. */
  worktreesDir?: string;
  /** Prefix for generated task IDs (e.g. `"KB"` produces `KB-001`).
   *  Defaults to `"KB"`. Only affects new tasks — existing tasks retain
   *  their original IDs. */
  taskPrefix?: string;
  /** Preferred commit trailer keys for task attribution in priority order.
   *  The first value is used by commit-msg hook installation when enabled.
   *  Defaults to `["Fusion-Task-Id"]`. */
  taskAttributionTrailerNames?: string[];
  /** When true, Fusion installs a commit-msg hook in managed task worktrees
   *  that appends the configured task attribution trailer (e.g. `Fusion-Task-Id: FN-123`).
   *  Set to false for projects with custom hook infrastructure. Default: true. */
  commitMsgHookEnabled?: boolean;
  /** When true, merge commit messages include the task ID as the conventional
   *  commit scope (e.g. `feat(KB-001): ...`). When false, the scope is
   *  omitted (e.g. `feat: ...`). Default: true. */
  includeTaskIdInCommit?: boolean;
  /** When true, fusion appends a `Co-authored-by` trailer to all commits it
   *  creates so Fusion is credited alongside the user's git identity (which
   *  remains the primary author/committer). When false, no co-author trailer
   *  is added. Default: true. */
  commitAuthorEnabled?: boolean;
  /** Name used in the `Co-authored-by` trailer for Fusion commits.
   *  Only used when commitAuthorEnabled is true. Default: "Fusion". */
  commitAuthorName?: string;
  /** Email used in the `Co-authored-by` trailer for Fusion commits.
   *  Only used when commitAuthorEnabled is true. Default: "noreply@runfusion.ai". */
  commitAuthorEmail?: string;
  /** AI model provider for planning/triage (specification) agent.
   *  Must be set together with `planningModelId`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  planningProvider?: string;
  /** AI model ID for planning/triage (specification) agent.
   *  Must be set together with `planningProvider`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  planningModelId?: string;
  /** Fallback model provider for planning/triage. When unset, falls back to the
   *  global fallback model. Must be set together with `planningFallbackModelId`. */
  planningFallbackProvider?: string;
  /** Fallback model ID for planning/triage. When unset, falls back to the
   *  global fallback model. Must be set together with `planningFallbackProvider`. */
  planningFallbackModelId?: string;
  /** Project-level override for the base default AI model provider.
   *  When set, this overrides the global `defaultProvider`/`defaultModelId` baseline
   *  for all lanes that don't have their own explicit project override.
   *  Must be set together with `defaultModelIdOverride`. */
  defaultProviderOverride?: string;
  /** Project-level override for the base default AI model ID.
   *  Must be set together with `defaultProviderOverride`. */
  defaultModelIdOverride?: string;
  /** Project-level AI model provider for task execution (executor agent).
   *  This is the execution lane that overrides the global `executionGlobalProvider`.
   *  Must be set together with `executionModelId`. Falls back to
   *  `executionGlobalProvider`/`executionGlobalModelId` or
   *  `defaultProviderOverride`/`defaultModelIdOverride` or
   *  `defaultProvider`/`defaultModelId` when undefined. */
  executionProvider?: string;
  /** Project-level AI model ID for task execution.
   *  Must be set together with `executionProvider`. */
  executionModelId?: string;
  /** AI model provider for validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  validatorProvider?: string;
  /** AI model ID for validator/reviewer agent.
   *  Must be set together with `validatorProvider`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  validatorModelId?: string;
  /** Fallback model provider for validator/reviewer. When unset, falls back to
   *  the global fallback model. Must be set together with
   *  `validatorFallbackModelId`. */
  validatorFallbackProvider?: string;
  /** Fallback model ID for validator/reviewer. When unset, falls back to the
   *  global fallback model. Must be set together with `validatorFallbackProvider`. */
  validatorFallbackModelId?: string;
  /** Reusable model configuration presets for task creation. */
  modelPresets?: ModelPreset[];
  /** When true, task creation UIs automatically recommend/apply a preset based on task size. */
  autoSelectModelPreset?: boolean;
  /** Controls whether planning specs should require release documentation artifacts on completion.
   *  - "off": do not inject any release-documentation requirement
   *  - "changeset": require a `.changeset/*.md` entry when relevant
   *  - "changelog": require updating an existing changelog file (do not invent a new one)
   *  Default: "off" */
  completionDocumentationMode?: CompletionDocumentationMode;
  /** Mapping of task sizes to preset IDs used for auto-selection during task creation. */
  defaultPresetBySize?: { S?: string; M?: string; L?: string };
  /** When true, auto-merge will automatically resolve common conflict patterns
   *  (lock files, generated files, trivial conflicts) without requiring AI
   *  intervention. When AI resolution fails, the system will retry with escalating
   *  strategies. Default: true. */
  autoResolveConflicts?: boolean;
  /** Alias for autoResolveConflicts. When true, enables automatic resolution of
   *  lock files (ours), generated files (theirs), and trivial whitespace conflicts
   *  without spawning an AI agent. Default: true. */
  smartConflictResolution?: boolean;
  /** Drop stale merger autostashes older than this age in hours. Minimum 1. Default: 24. */
  mergerAutostashMaxAgeHours?: number;
  /** When true, the merger fetches the remote and rebases the task branch
   *  onto the latest `<remote>/<defaultBranch>` before attempting to merge
   *  it back into the main branch. This catches upstream changes from
   *  other collaborators (or from a running fusion worker on another host)
   *  before they become a merge conflict. Auto-resolve still runs on any
   *  conflicts the rebase surfaces, so most of the time this is invisible.
   *  Default: true. */
  worktreeRebaseBeforeMerge?: boolean;
  /** Git remote to fetch from for the pre-merge rebase. When unset or empty,
   *  the merger resolves the default remote from the repo's configuration
   *  (typically `origin`). Exposed as a dropdown in the dashboard's
   *  Worktrees settings. */
  worktreeRebaseRemote?: string;
  /** When true, the worktree is also rebased onto the local default-branch
   *  HEAD (in addition to the remote rebase). Catches sibling tasks that
   *  merged into local main *after* this task's worktree was created but
   *  *before* its merge — including merges that haven't been pushed yet.
   *  Without this, concurrent task branches based on stale main can silently
   *  re-introduce code that an earlier sibling task already deleted.
   *  Default: true. */
  worktreeRebaseLocalBase?: boolean;
  /** Master switch for pre-merge auto-prerebase policy. When false, merger
   *  bypasses hot-file and divergence-threshold prerebase triggers.
   *  Default: true. */
  prerebaseAutoEnabled?: boolean;
  /** Shared-infrastructure file paths that trigger pre-merge auto-prerebase
   *  when they changed between `<task.baseCommitSha>` and local main HEAD.
   *  Empty array disables hot-file triggering.
   *  Default: curated project hot-file list. */
  prerebaseHotFiles?: string[];
  /** Commit-count threshold for pre-merge auto-prerebase. When the commit
   *  count of `<task.baseCommitSha>..localMainHead` exceeds this value, the
   *  merger auto-prerebases regardless of hot-file overlap.
   *  Set to 0 or undefined to disable count-based triggering.
   *  Default: 50. */
  prerebaseDivergenceThreshold?: number;
  /** Strategy used when a merge conflict can't be resolved by AI. See
   *  {@link MergeConflictStrategy}. Default: "smart". */
  mergeConflictStrategy?: MergeConflictStrategy;
  /**
   * FNXC:AutoMergeRetries 2026-06-17-04:20:
   * The auto-merge conflict-resolution retry cap is project-configurable so operators can tune when tasks park for human visibility. Default 3 preserves the historical fixed cap; non-positive or non-finite values fall back to the default.
   *
   * Maximum number of auto-merge conflict-resolution retries before a task is
   * parked as failed for manual recovery. Must be a positive integer. Default: 3.
   */
  maxAutoMergeRetries?: number;
  /** AI merge path configuration (FN-5633). See {@link MergerSettings}.
   *  When mode is "ai" (default), the standalone AI merge path is used and the
   *  legacy merge settings above/below it do not apply. */
  merger?: MergerSettings;
  /** Minimum branch net line volume before the pre-commit diff-volume gate evaluates a file. Default applied at read site: 20. */
  mergeDiffVolumeMinLines?: number;
  /** Minimum staged/branch-net ratio required by the pre-commit diff-volume gate. Default applied at read site: 0.2. */
  mergeDiffVolumeThreshold?: number;
  /** Additional file globs allowlisted by the pre-commit diff-volume gate on top of generated/lockfile patterns. Default applied at read site: []. */
  mergeDiffVolumeAllowlist?: string[];
  /** Controls overlap protection when `mergeConflictStrategy="smart-prefer-main"`
   *  reaches its Attempt 3 fallback. Default: "flip-to-prefer-branch". */
  mergeStrategyOverlapBehavior?: MergeStrategyOverlapBehavior;
  /** Controls how the merger reacts to a dirty post-merge / post-rebase audit (FN-4333).
   *  - "block" (default): throw `SquashAuditError`, park task as failed (today's behavior).
   *  - "warn": log audit findings on the agent log but auto-complete the merge.
   *  - "off": skip the post-merge audit entirely.
   *
   *  Regardless of mode, the merger short-circuits overlap-only findings on the
   *  rebase-strategy path when deterministic merge verification has already proven
   *  the resulting tree (silent drops are impossible by construction in that case). */
  postMergeAuditMode?: PostMergeAuditMode;
  /** Controls Stage 1–3 post-merge audit auto-recovery behavior before bounce/park.
   *  - "deterministic-only": verified-rebase short-circuit only.
   *  - "programmatic": deterministic + per-file contribution survival checks.
   *  - "ai-assisted" (default): programmatic + one AI restoration commit attempt.
   *  - "off": disable all recovery; audit blocks immediately.
   */
  mergeAuditAutoRecovery?: MergeAuditAutoRecoveryMode;
  /** Dispatcher-level reliability recovery policy (FN-4533/FN-4534). */
  autoRecovery?: AutoRecoverySettings;
  /** Optional ISO-8601 timestamp baseline for reliability metrics.
   *  When set, reliability windows are floored at this instant so historical
   *  events before the reset are excluded from aggregates (but not deleted). */
  reliabilityStatsResetAt?: string;
  /** Wall-clock timeout (ms) for a single pre-merge workflow step's AI call.
   *  When a step exceeds this, the session is aborted and the executor is
   *  given one shot to retry with the configured fallback model before the
   *  step is reported as failed. Default: 900_000 (15 minutes). */
  workflowStepTimeoutMs?: number;
  /** How pre-merge prompt workflow steps enforce declared File Scope at step end.
   *  - "block" (default): mark the step failed/revision-requested on off-scope writes
   *  - "warn": log off-scope writes but allow the step to pass
   *  - "off": disable workflow-step scope enforcement and keep legacy behavior */
  workflowStepScopeEnforcement?: "block" | "warn" | "off";
  /** Executor-side scope-leak policy at fn_task_done time for plan-only tasks (review level 1).
   *  - "off": disable guard
   *  - "warn" (default): log [scope-leak] activity but allow completion
   *  - "block": refuse fn_task_done when off-scope files are detected */
  planOnlyScopeLeakEnforcement?: "off" | "warn" | "block";
  /** When true (default), workflow revision feedback that explicitly names files
   *  outside the task's declared File Scope is forked into a dependent follow-up
   *  task instead of being appended to the original PROMPT.md. Set to false to
   *  preserve the legacy append-and-rerun behavior. */
  workflowRevisionForkOnScopeMismatch?: boolean;
  /** When true, out-of-scope file changes block merge instead of just logging warnings.
   *  Useful for teams that want strict enforcement of declared File Scope.
   *  Default: false (soft guardrail — warnings only). */
  strictScopeEnforcement?: boolean;
  /** Maximum number of build retry attempts during merge when a build fails with a
   *  transient error. Default: 0 (no retry). Set to 1 to allow one retry. */
  buildRetryCount?: number;
  /** Maximum number of times to attempt in-merge verification fixes when test/build
   *  commands fail during merge. The fix agent runs on the main branch with the merged
   *  code to resolve failures before aborting the merge. Default: 3. Set to 0 to disable. */
  verificationFixRetries?: number;
  /** Timeout in milliseconds for build commands during merge. Default: 300000 (5 min). */
  buildTimeoutMs?: number;
  /**
   * FNXC:Verification 2026-06-17-14:20:
   * Engine verification commands need a durable project-level budget so marathon test runs abort cleanly instead of tripping the stuck detector and requeueing forever.
   * When set, this millisecond value overrides both fn_run_verification scope defaults (package 300s, workspace 900s); when unset, the legacy per-scope defaults still apply.
   */
  verificationCommandTimeoutMs?: number;
  /**
   * FNXC:Verification 2026-06-25-00:00:
   * When true (default), merge/executor verification is narrowed to ONLY the
   * test files implicated by the task's branch diff — changed `*.test`/`*.spec`
   * files plus the co-located tests of changed source files — run via
   * `pnpm --filter <pkg> exec vitest run <files> --silent=passed-only
   * --reporter=dot`. This keeps verification proportional to the change
   * (seconds-to-<2min) and relies on the thin merge gate for cross-cutting
   * coverage. Applies to BOTH explicit and inferred test commands. When no test
   * files resolve from the diff, verification falls back to the existing
   * package-scoped/explicit command. Set false to always run the broader
   * package/full command. Default: true. */
  scopeVerificationToChangedFiles?: boolean;
  /** When enabled, AI-generated task specifications require manual approval
   *  before the task can move from triage to todo. Tasks with approved specs
   *  remain in triage with status "awaiting-approval" until a user approves
   *  or rejects the plan. Default: false. */
  requirePlanApproval?: boolean;
  /**
   * FNXC:PlanApproval 2026-06-26-00:00:
   * Per-project setting to control plan approval for every task: workflow defers to the per-workflow requirePlanApproval setting, auto-approve-all bypasses approval for all tasks, and require-all parks every approved spec for manual approval.
   */
  planApprovalMode?: "workflow" | "auto-approve-all" | "require-all";
  /** Controls task-worker execution mode.
   *  - true (default): spawn short-lived `executor-FN-XXXX` ephemeral workers per task
   *  - false: disable ephemeral workers; scheduler auto-assigns dispatchable tasks
   *    to permanent executor agents using the reporting chain heuristic.
   *  Tasks without an eligible permanent executor remain queued. */
  ephemeralAgentsEnabled?: boolean;
  /**
   * FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
   * Gates whether ephemeral/runtime-managed task-worker agents may create new tasks via `fn_task_create`.
   * Default true preserves the existing behavior where a task-worker can spin off follow-up tasks.
   * When false, an ephemeral caller's `fn_task_create` is rejected while human/dashboard/CLI callers and permanent agents remain unaffected. */
  ephemeralAgentsCanCreateTasks?: boolean;
  /** Approval policy for agent provisioning tools (fn_agent_create/fn_agent_delete). */
  agentProvisioning?: {
    approvalMode?: AgentProvisioningApprovalMode;
    trustedRoles?: string[];
    trustedAgentIds?: string[];
    alwaysApproveDelete?: boolean;
  };
  /** Approval policy for sandbox provisioning/bootstrap actions that mutate the host. */
  sandboxProvisioning?: {
    approvalMode?: SandboxProvisioningApprovalMode;
    trustedRoles?: string[];
    trustedAgentIds?: string[];
    /** Backend ids that may bootstrap without approval. Default: ["native"]. */
    autoApproveBackendIds?: string[];
  };
  /** Project default runtime permission-policy overrides for all agent lifetimes.
   *  Rules are a partial map of category -> disposition (`allow` | `block` | `require-approval`).
   *  Tool rules are exact tool-name overrides that take precedence over category rules.
   *  Missing categories and tools inherit the built-in `unrestricted` seed (`allow`). Agents without an explicit policy, including legacy ephemeral task workers, inherit this project default at runtime. */
  defaultAgentPermissionPolicy?: {
    rules?: Partial<AgentPermissionPolicyRules>;
    toolRules?: AgentPermissionPolicyToolRules;
  };
  /** When true, enforces that task specifications (PROMPT.md) are refreshed if they
   *  become stale. Stale specs are detected based on specStalenessMaxAgeMs.
   *  Default: false. */
  specStalenessEnabled?: boolean;
  /** Maximum age in milliseconds for a task specification before it is considered stale
   *  and requires regeneration. Only enforced when specStalenessEnabled is true.
   *  Default: 21600000 (6 hours). */
  specStalenessMaxAgeMs?: number;
  /** Timeout in milliseconds for detecting stuck tasks. When a task's agent session
   *  shows no activity (no text deltas, tool calls, or progress updates) for longer
   *  than this duration, the task is considered stuck and will be terminated and retried.
   *  Default: 600000 (10 minutes). Set to 0 to disable. */
  taskStuckTimeoutMs?: number;
  /** Number of rapid todo↔in-progress cycles allowed before auto-pausing the task.
   *  Default: 5. */
  dispatchOscillationThreshold?: number;
  /** Sliding time window in milliseconds used to count rapid todo↔in-progress cycles.
   *  Default: 60000 (1 minute). */
  dispatchOscillationWindowMs?: number;
  /** Delay before scheduler may re-dispatch an engine-requeued todo task.
   *  Default: 5000 (5 seconds). */
  dispatchOscillationSettleMs?: number;
  /** Maximum milliseconds InProcessRuntime.stop() waits for in-flight tasks to drain
   *  AFTER aborting their AI sessions. Default: 2000. Set to 0 to skip drain waits
   *  entirely (test/CI). Set to 30000 to preserve the historical 30s grace window. */
  runtimeStopDrainMs?: number;
  /** Epoch ms when the in-process runtime last became active (startup or transition
   *  out of globalPause/enginePaused). Time-based stuck/stalled/stale detectors floor
   *  their activity anchor at this value so engine downtime is not counted as quiet time.
   *  Stamped by the runtime; undefined when no runtime has come up yet. */
  engineActiveSinceMs?: number;
  /** Extra grace period in milliseconds added to engineActiveSinceMs before any
   *  time-based stuck/stalled/stale signal may fire after activation.
   *  Default: 300000 (5 minutes). Set to 0 to disable the grace period. */
  engineActivationGraceMs?: number;
  /** Minimum number of identical consecutive in-review stall log entries (same code + reason)
   *  before the task is auto-disposed with `pausedReason='in-review-stall-deadlock'`.
   *  Default: 3. Set to 0 to disable. */
  inReviewStallDeadlockThreshold?: number;
  /** Threshold in milliseconds for surfacing paused in-review tasks as stale.
   *  Age is measured from columnMovedAt when present, otherwise updatedAt.
   *  Default: 86400000 (24 hours). Set to 0 or undefined to disable surfacing. */
  stalePausedReviewThresholdMs?: number;
  /** Threshold in milliseconds for surfacing unpaused in-review tasks quiet beyond a time window.
   *  Default: 86400000 (24 hours). Set to 0 to disable. Gates `surfaceInReviewStalled`
   *  and the `Task.inReviewStalled` hydration.
   */
  inReviewStalledThresholdMs?: number;
  /** Threshold in milliseconds for surfacing paused todo tasks as stale.
   *  Age is measured from columnMovedAt when present, otherwise updatedAt.
   *  Default: 86400000 (24 hours). Set to 0 or undefined to disable surfacing. */
  stalePausedTodoThresholdMs?: number;
  /** Minimum age in milliseconds that a paused in-progress task may continue holding
   *  file-scope reservation while one or more followers are blocked by it.
   *  Self-healing rebounds qualifying holders to todo when this threshold is met.
   *  Default: 1800000 (30 minutes). Set to 0 to disable. */
  pausedScopeDecayMs?: number;
  /** Maximum age in milliseconds a meta-task may remain blocked without its target
   *  advancing before self-healing auto-archives it as superseded.
   *  Default: 7200000 (2 hours). Set to 0 to disable. */
  metaTaskStallAutoCloseMs?: number;
  /** Grace period in milliseconds used by meta-task auto-archive guards to treat
   *  recent executor activity as in-flight and skip destructive auto-archive.
   *  Default: 1800000 (30 minutes). Set to 0 to disable this guard. */
  metaTaskActiveExecutionGraceMs?: number;
  /** Rolling window in milliseconds for board-stall auto-recovery evaluation.
   *  Default: 7200000 (2 hours). */
  boardStallSweepWindowMs?: number;
  /** Minimum blocked-edge growth within the board-stall window that qualifies as a
   *  stall signal when there are zero transitions out of in-progress.
   *  Default: 3. */
  boardStallBlockedGrowthThreshold?: number;
  /** Age threshold in milliseconds before a blocker with high todo fan-out is escalated.
   *  Blocker age is measured from columnMovedAt when available, otherwise updatedAt.
   *  Only blockers currently in in-progress or in-review are eligible. */
  staleHighFanoutBlockerAgeThresholdMs?: number;
  /** Staleness warning threshold for tasks in in-progress, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInProgressWarningMs?: number;
  /** Staleness critical threshold for tasks in in-progress, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInProgressCriticalMs?: number;
  /** Staleness warning threshold for tasks in in-review, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInReviewWarningMs?: number;
  /** Staleness critical threshold for tasks in in-review, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInReviewCriticalMs?: number;
  /** When true, the dashboard shows the capacity-risk banner once
   *  capacityRiskTodoThreshold is exceeded with zero idle non-ephemeral agents.
   *  Default: false. */
  capacityRiskBannerEnabled?: boolean;
  /** Todo count threshold for raising a capacity-risk warning when there are zero
   *  idle non-ephemeral agents available. Warning fires only when todo is strictly
   *  greater than this threshold. Default: 20. */
  capacityRiskTodoThreshold?: number;
  /** Enables scheduler backlog-pressure imbalance alerts. Default: true. */
  backlogPressureAlertEnabled?: boolean;
  /** Todo/max(In-Progress,1) ratio above which backlog pressure alerting triggers.
   *  Must be a positive finite number. Default: 10. */
  backlogPressureRatioThreshold?: number;
  /** Minimum todo inventory required before backlog pressure alerting can trigger.
   *  Must be a positive finite number. Default: 5. */
  backlogPressureMinTodoCount?: number;
  /** Minimum cooldown in milliseconds between backlog-pressure alerts.
   *  Default: 24 * 60 * 60_000. */
  backlogPressureAlertCooldownMs?: number;
  /** Enables dependency-blocked todo backlog-health reporting. Default: true. */
  dependencyBlockedTodoReportEnabled?: boolean;
  /** Blocker age in milliseconds below which dependency-blocked todo groups are fresh.
   *  Default: 30 * 60_000 (30 minutes). */
  dependencyBlockedTodoFreshAgeMs?: number;
  /** Blocker age in milliseconds at or above which dependency-blocked todo groups are stale.
   *  Default: 4 * 60 * 60_000 (4 hours). */
  dependencyBlockedTodoStaleAgeMs?: number;
  /** Minimum dependency-blocked todo count required to include a blocker group.
   *  Default: 1. */
  dependencyBlockedTodoMinCount?: number;
  /** Minimum cooldown in milliseconds between dependency-blocked todo insight emissions.
   *  Default: 6 * 60 * 60_000. */
  dependencyBlockedTodoReportCooldownMs?: number;
  /** TTL in milliseconds for persisted AI planning/subtask/mission interview sessions.
   *  Sessions older than this cutoff are expired by the dashboard session cleanup loop.
   *  Valid range: 600000 (10 minutes) to 2592000000 (30 days).
   *  Default: 604800000 (7 days). */
  aiSessionTtlMs?: number;
  /** Interval in milliseconds for scheduled AI session cleanup sweeps.
   *  Valid range: 60000 (1 minute) to 86400000 (24 hours).
   *  Default: 3600000 (1 hour). */
  aiSessionCleanupIntervalMs?: number;
  /** When true, automatically unpause after rate-limit-triggered globalPause using
   *  escalating backoff. Allows unattended recovery from transient API rate limits.
   *  Default: true. */
  autoUnpauseEnabled?: boolean;
  /** Base delay in milliseconds before first auto-unpause attempt after rate-limit pause.
   *  Subsequent attempts use exponential backoff (2x). Default: 300000 (5 min). */
  autoUnpauseBaseDelayMs?: number;
  /** Maximum delay cap in milliseconds for auto-unpause backoff. Default: 3600000 (60 min). */
  autoUnpauseMaxDelayMs?: number;
  /** Maximum number of times the stuck-task detector can kill and re-queue a task
   *  before it is marked as permanently failed. Default: 6. */
  maxStuckKills?: number;
  /** Maximum branch-conflict auto-recovery retries before failing the task.
   *  Default: 5. */
  maxBranchConflictRecoveries?: number;
  /** Maximum reviewer context-limit compact-and-retry attempts before failing.
   *  Default: 2. */
  maxReviewerContextRetries?: number;
  /** Maximum reviewer fallback-model retry attempts before failing.
   *  Default: 2. */
  maxReviewerFallbackRetries?: number;
  /** Master cap across all retry categories before throwing RetryStormError.
   *  Default: 25. */
  maxTotalRetriesBeforeFail?: number;
  /** When the stuck-task detector kills and re-queues a task, preserve the
   *  task's recoverable step progress (step statuses + currentStep) instead
   *  of resetting every step to `pending`. Before clearing the worktree/branch
   *  for a fresh checkout, stuck-requeue cleanup resets completed/in-progress
   *  steps to `pending` if the branch has no unique commits, preventing deleted
   *  uncommitted-only work from being skipped on retry. Default: true. */
  preserveProgressOnStuckRequeue?: boolean;
  /** Maximum number of times the self-healing manager may auto-revive a task parked
   *  in `in-review` with a failed pre-merge workflow step. Also bounds the inline
   *  pre-merge optional-step fix → re-review cycle for Code Review and Browser
   *  Verification. Each revival injects the failure feedback into `PROMPT.md`, resets
   *  steps, and sends the task back through the normal todo → in-progress flow. Set
   *  to 0 to disable. Default: 3. */
  maxPostReviewFixes?: number;
  /** Maximum number of child agents a single parent agent can spawn.
   *  Limits the fan-out per executor task to prevent resource exhaustion.
   *  Default: 5. */
  maxSpawnedAgentsPerParent?: number;
  /** Maximum total spawned agents across all parent agents in a single executor instance.
   *  Provides a global safety cap regardless of how many parent agents are running.
   *  Default: 20. */
  maxSpawnedAgentsGlobal?: number;
  /** Interval in milliseconds for periodic maintenance (worktree pruning, WAL checkpoint,
   *  orphan cleanup). 0 disables. Default: 900000 (15 min). */
  maintenanceIntervalMs?: number;
  /** When true, periodic maintenance archives done tasks after the configured age. Default: true. */
  autoArchiveDoneTasksEnabled?: boolean;
  /** Age in milliseconds after a task enters done before auto-archive. Default: 172800000 (48h). */
  autoArchiveDoneAfterMs?: number;
  /** Retention in integer days before done tasks are auto-archived.
   *  0 disables this days-based override. When > 0, takes precedence over autoArchiveDoneAfterMs. */
  doneAutoArchiveDays?: number;
  /** How much agent log content to preserve when a task is moved to cold archive storage.
   *  - "compact": deterministic summary plus a small recent-entry snapshot (default)
   *  - "full": copy the full agent.log into archive.db
   *  - "none": do not copy agent.log content */
  archiveAgentLogMode?: ArchiveAgentLogMode;
  /** When true, automatically poll and update PR status badges for tasks linked to GitHub PRs.
   *  Default: false. */
  autoUpdatePrStatus?: boolean;
  /** When true, automatically post a comment to the originating GitHub issue
   *  when an imported task is moved to done. Default: false. */
  githubCommentOnDone?: boolean;
  /** Optional template used for GitHub issue comments posted on task completion.
   *  Supports `{taskId}` and `{taskTitle}` placeholders. */
  githubCommentTemplate?: string;
  /** When true, automatically close linked source-imported GitHub issues
   *  when a task moves to done. Default: false. */
  githubCloseSourceIssueOnDone?: boolean;
  /** When true, new tasks default GitHub tracking to enabled for this project (FN-3868).
   *  Default: false. */
  githubTrackingEnabledByDefault?: boolean;
  /**
   * FNXC:GithubImportTracking 2026-07-01-00:00:
   * This project-scoped switch is intentionally narrower than githubTrackingEnabledByDefault: it only forces imported GitHub issues to become GitHub-tracked tasks so the source issue is adopted, while ordinary new tasks keep their existing default behavior.
   * Default: false.
   */
  githubLinkImportedIssuesToTracking?: boolean;
  /** Project default GitHub tracking repo in `owner/repo` format (FN-3868).
   *  Falls back to global githubTrackingDefaultRepo when unset. */
  githubTrackingDefaultRepo?: string;
  /**
   * FNXC:GitLabConfiguration 2026-07-02-00:00:
   * FN-7422 adds durable GitLab instance/API URL settings for GitLab.com and self-managed hosts. FN-7423 layers token settings onto the same project-over-global configuration contract without adding runtime GitLab imports or tracking.
   */
  /** Project GitLab integration enable flag. Undefined inherits global gitlabEnabled, then defaults effectively enabled for backward compatibility. */
  gitlabEnabled?: boolean;
  /** Project GitLab web instance URL. Falls back to global gitlabInstanceUrl, then https://gitlab.com. */
  gitlabInstanceUrl?: string;
  /** Project GitLab REST API base URL. Falls back to global gitlabApiBaseUrl, then derives `<instance>/api/v4`. */
  gitlabApiBaseUrl?: string;
  /** Project GitLab access token for HTTP API auth. Stored as a plain settings string in this phase; UI must render it only as a password field. */
  gitlabAuthToken?: string;
  /** Project GitLab token type label. Defaults effectively to "personal" when a token exists and this is unset. */
  gitlabAuthTokenType?: GitlabAuthTokenType;
  /**
   * FNXC:GitLabLifecycle 2026-07-02-00:00:
   * GitLab comment and auto-close settings mirror GitHub lifecycle side effects but remain disabled by default and use the configured GitLab instance/API URL so GitLab.com and self-managed hosts behave consistently.
   */
  /** When true, automatically post a comment to the originating GitLab issue or merge request when an imported task is moved to done. Default: false. */
  gitlabCommentOnDone?: boolean;
  /** Optional template used for GitLab source comments posted on task completion. Supports `{taskId}` and `{taskTitle}` placeholders. */
  gitlabCommentTemplate?: string;
  /** When true, automatically close/reopen linked source-imported GitLab issues or merge requests on task done/undone lifecycle moves. Default: false. */
  gitlabCloseSourceIssueOnDone?: boolean;
  /** When true, tracking issue creation searches open/closed repo issues for likely duplicates before opening a new issue.
   *  Default: true (set false to opt out). */
  githubTrackingDedupEnabled?: boolean;
  /** GitHub auth strategy for issue-tracking API calls in this project (FN-3868).
   *  Default: "gh-cli". */
  githubAuthMode?: GithubAuthMode;
  /** Personal access token used when githubAuthMode is "token" (FN-3868).
   *  Stored as a plain settings string in this phase. */
  githubAuthToken?: string;
  /** When true, automatic database backups are enabled. Default: false. */
  autoBackupEnabled?: boolean;
  /** Cron expression for backup schedule. Default: "0 2 * * *" (daily at 2 AM). */
  autoBackupSchedule?: string;
  /** Number of backup files to retain (oldest deleted when exceeded). Default: 7. */
  autoBackupRetention?: number;
  /** Directory for backup files, relative to project root. Default: ".fusion/backups". */
  autoBackupDir?: string;
  /** When true, scheduled memory backups are enabled. Default: false. */
  memoryBackupEnabled?: boolean;
  /** Cron expression for memory backup schedule. Default: "0 3 * * *" (daily at 3 AM). */
  memoryBackupSchedule?: string;
  /** Number of memory backups to retain (oldest deleted when exceeded). Default: 14. */
  memoryBackupRetention?: number;
  /** Directory for memory backup snapshots, relative to project root.
   *  Default: ".fusion/backups/memory". */
  memoryBackupDir?: string;
  /** Scope of memory backup snapshots.
   *  - "project": backups `.fusion/memory` only
   *  - "agents": backups `.fusion/agent-memory` only
   *  - "all": backups both project and per-agent memory
   *  Default: "all". */
  memoryBackupScope?: "project" | "agents" | "all";
  /** When true, tasks created without titles but with descriptions longer than 200
   *  characters will automatically receive an AI-generated title (max 60 chars).
   *  Default: false. */
  autoSummarizeTitles?: boolean;
  /** When true, merge commit messages include an AI-generated summary of the
   *  changes instead of just listing step commit subjects. Body composition
   *  includes a narrative line, bullet summary, and `git diff --stat` when
   *  available. Uses the title summarizer model. Default: true. */
  useAiMergeCommitSummary?: boolean;
  /** AI model provider for title summarization (when autoSummarizeTitles is enabled).
   *  Must be set together with `titleSummarizerModelId`. Falls back to planningProvider,
   *  then defaultProvider if not specified. */
  titleSummarizerProvider?: string;
  /** AI model ID for title summarization (when autoSummarizeTitles is enabled).
   *  Must be set together with `titleSummarizerProvider`. Falls back to planningModelId,
   *  then defaultModelId if not specified. */
  titleSummarizerModelId?: string;
  /** Fallback model provider for title summarization. When unset, falls back to
   *  planning fallback, then global fallback. Must be set together with
   *  `titleSummarizerFallbackModelId`. */
  titleSummarizerFallbackProvider?: string;
  /** Fallback model ID for title summarization. When unset, falls back to
   *  planning fallback, then global fallback. Must be set together with
   *  `titleSummarizerFallbackProvider`. */
  titleSummarizerFallbackModelId?: string;
  /**
   * FNXC:PrMetadataGeneration 2026-06-27-00:00:
   * Project operators can add title-specific guidance to the Create PR metadata prompt without replacing the strict JSON schema contract. Blank or whitespace-only values are treated as unset so the default prompt remains byte-for-byte unchanged.
   * Optional project-scoped guidance appended to the PR metadata system prompt for the generated `title` field. Default: undefined.
   */
  prTitlePromptInstructions?: string;
  /**
   * FNXC:PrMetadataGeneration 2026-06-27-00:00:
   * Project operators can add body-specific guidance to the Create PR metadata prompt without replacing the strict JSON schema contract. Blank or whitespace-only values are treated as unset so the default prompt remains byte-for-byte unchanged.
   * Optional project-scoped guidance appended to the PR metadata system prompt for the generated `summary`, `changes`, and `testing` fields. Default: undefined.
   */
  prDescriptionPromptInstructions?: string;
  /** Named scripts that can be referenced by setupScript or other automation.
   *  A map of script name to shell command. */
  scripts?: Record<string, string>;
  /** Reference to a named script in the scripts map that runs before task execution.
   *  Used for pre-task setup like environment preparation. */
  setupScript?: string;
  /** When true, enables periodic AI-powered extraction of insights from working memory
   *  into a distilled long-term memory file. Creates an automation schedule that reads
   *  `.fusion/memory/MEMORY.md`, identifies patterns/principles/pitfalls, and writes to
   *  `.fusion/memory/memory-insights.md`. Default: false. */
  insightExtractionEnabled?: boolean;
  /** Cron expression for insight extraction schedule. Only used when
   *  insightExtractionEnabled is true. Default: "0 2 * * *" (daily at 2 AM). */
  insightExtractionSchedule?: string;
  /** Minimum interval between insight extractions in milliseconds. Prevents
   *  excessive AI calls when working memory hasn't changed significantly.
   *  Extraction only runs if BOTH this time has elapsed AND memory has grown
   *  by more than MIN_INSIGHT_GROWTH_CHARS characters. Default: 86400000 (24h). */
  insightExtractionMinIntervalMs?: number;
  /** When enabled, agents will consult and update files under .fusion/memory/ with durable
   *  project learnings. When disabled, agents will not include memory instructions
   *  in their prompts and will not read or write to .fusion/memory/ files.
   *  Default: true (enabled for backward compatibility). */
  memoryEnabled?: boolean;
  /** Memory backend type for pluggable memory storage.
   *  Available built-in backends:
   *  - "qmd": QMD (Quantized Memory Distillation) backend using the qmd CLI tool (default)
   *  - "file": File-based backend storing memory in `.fusion/memory/`
   *  - "readonly": Read-only backend that returns empty memory (for external management)
   *  - Any registered custom backend type
   *  Default: "qmd" */
  memoryBackendType?: string;
  /** When true, enables automatic AI-powered summarization and compression of the
   *  working memory file when it exceeds the configured size threshold.
   *  Creates an automation schedule that checks memory size and compacts when needed.
   *  Default: false. */
  memoryAutoSummarizeEnabled?: boolean;
  /** Character count threshold that triggers automatic memory summarization.
   *  When working memory exceeds this size, the auto-summarize automation will
   *  compress it. Only used when memoryAutoSummarizeEnabled is true.
   *  Default: 50000. */
  memoryAutoSummarizeThresholdChars?: number;
  /** Cron expression for the auto-summarize check schedule. Only used when
   *  memoryAutoSummarizeEnabled is true.
   *  Default: "0 3 * * *" (daily at 3 AM, offset from insight extraction at 2 AM). */
  memoryAutoSummarizeSchedule?: string;
  /** When true, daily memory notes are periodically synthesized into DREAMS.md
   *  and durable lessons are promoted into `.fusion/memory/MEMORY.md`.
   *  Default: false. */
  memoryDreamsEnabled?: boolean;
  /** Cron expression for dream processing. Only used when memoryDreamsEnabled
   *  is true. Default: "0 4 * * *" (daily at 4 AM). */
  memoryDreamsSchedule?: string;
  /** Maximum token count before auto-compact triggers. When undefined, compact
   *  only on overflow errors. When set, the engine monitors token usage after
   *  each prompt and proactively compacts context when the token count reaches
   *  this threshold. */
  tokenCap?: number;
  /** Optional per-task token budget defaults (soft/hard with optional size overrides). */
  taskTokenBudget?: TaskTokenBudget;
  /** When true, each task step runs in its own fresh agent session instead of a
   *  single session for the entire task. Enables per-step error recovery and
   *  optional parallel execution when steps have non-overlapping file scopes.
   *  Default: false. */
  runStepsInNewSessions?: boolean;
  /** Maximum number of steps to run in parallel when runStepsInNewSessions is
   *  enabled and steps have non-overlapping file scopes. Range: 1–4.
   *  Default: 2. */
  maxParallelSteps?: number;
  /** Time in milliseconds after which a mission in `activating` state is
   *  considered stale and eligible for self-healing recovery.
   *  Default: 600000 (10 minutes). */
  missionStaleThresholdMs?: number;
  /** Maximum automatic retry attempts for a failed mission-linked task before
   *  its feature is marked as blocked for manual intervention.
   *  Default: 3. */
  missionMaxTaskRetries?: number;
  /** Interval in milliseconds between mission feature/task consistency checks.
   *  Set to 0 to disable periodic health checks.
   *  Default: 300000 (5 minutes). */
  missionHealthCheckIntervalMs?: number;
  /** Configurable agent role prompt templates and assignments.
   *  When set, allows per-project customization of system prompts
   *  for different agent roles (executor, triage, reviewer, merger). */
  agentPrompts?: AgentPromptsConfig;
  /** Prompt segment overrides for fine-grained customization of agent prompts.
   *  Each key maps to a customizable prompt segment (e.g., "executor-welcome",
   *  "triage-context"). When a key is present with a non-empty value, that
   *  override replaces the default prompt segment. Missing or empty values
   *  fall back to the default prompt content. Null values delete the key.
   *
   *  This is separate from `agentPrompts` which controls full role templates.
   *  `promptOverrides` allows surgical customization of specific prompt segments
   *  without replacing entire role prompts.
   *
   *  Supported keys: "executor-welcome", "executor-guardrails", "executor-spawning",
   *  "executor-completion", "triage-welcome", "triage-context", "reviewer-verdict",
   *  "merger-conflicts". */
  promptOverrides?: Record<string, string | null>;
  /** Enable/disable agent self-reflection workflows. Default: false. */
  reflectionEnabled?: boolean;
  /** How often periodic reflections occur in milliseconds. Default: 3_600_000 (1 hour). */
  reflectionIntervalMs?: number;
  /** When true, automatically trigger reflection after task completion. Default: true. */
  reflectionAfterTask?: boolean;
  /** Policy for agent-to-user review handoff. When enabled, agents can hand off
   *  tasks to users for human review via steering comments.
   *  - "disabled": No handoff detection (default)
   *  - "comment-triggered": Detect handoff phrases in agent steering comments
   *  - "always": Always handoff after completion (not implemented, reserved for future)
   */
  reviewHandoffPolicy?: "disabled" | "comment-triggered" | "always";
  /** Quick Chat launcher placement. "floating" shows the draggable FAB, "footer" shows a footer button, "off" hides both. */
  quickChatButtonMode?: "floating" | "footer" | "off";
  /**
   * FNXC:ChatModal 2026-06-28-00:00:
   * Outside-click dismissal of Quick Chat is now user-configurable; default true preserves the prior always-on behavior from FN-7152.
   * When true (default), the Quick Chat floating window closes when the user clicks outside it. Set false to keep it open until explicitly closed.
   */
  quickChatCloseOnOutsideClick?: boolean;
  /** Legacy Quick Chat FAB toggle. Prefer quickChatButtonMode for new callers. */
  showQuickChatFAB?: boolean;
  /**
   * FNXC:ChatModal 2026-07-01-00:00:
   * Task planner sessions (`task-planner:<taskId>`) are hidden from the common Chat feed by default to keep task-detail planning conversations out of Direct chat clutter. Operators can opt back into the previous shared-feed behavior with this project setting.
   */
  showTaskChatsInCommonFeed?: boolean;
  /** Number of days of chat inactivity before old chat sessions/rooms are auto-cleaned.
   *  Allowed values: 0 (off, default), 7, 14, 30, 60, 90. Uses updatedAt inactivity age. */
  chatAutoCleanupDays?: number;
  /** Number of days of inactivity before old inbox/outbox messages are auto-pruned.
   *  Allowed values: 0 (off, default) or one of 7 | 14 | 30 | 60 | 90. Uses messages.updatedAt inactivity age. */
  mailAutoCleanupDays?: number;
  /** Number of days to retain append-only operational-log rows (activityLog,
   *  runAuditEvents, agentHeartbeats, terminal agentRuns by `endedAt`, and
   *  agentConfigRevisions by `createdAt`) before periodic maintenance prunes
   *  them. In-flight agentRuns (`endedAt IS NULL`) and the most-recent config
   *  revision per agent are always preserved. Agent logs are now stored in
   *  per-task JSONL files — see agentLogFileRetentionDays. Default: 30. Set 0
   *  to disable pruning. */
  operationalLogRetentionDays?: number;
  /** Number of days to retain per-task agent-log JSONL files for soft-deleted
   *  and archived tasks. Only affects tasks that are no longer active. Entries
   *  older than this window are removed from the JSONL file during periodic
   *  maintenance. Default: 0 (disabled). Set to a positive integer (e.g. 90)
   *  to enable pruning. */
  agentLogFileRetentionDays?: number;
  /** Number of most-recent chat-room messages kept verbatim in the responder transcript.
   *  Older messages are compacted into a summary block. Default: 12. */
  chatRoomRecentVerbatimMessages?: number;
  /** Upper bound on messages fetched from the room store for compaction consideration.
   *  Default: 80. */
  chatRoomCompactionFetchLimit?: number;
  /** Hard cap on the synthesized "Earlier room context" summary block.
   *  Default: 1500. */
  chatRoomSummaryMaxChars?: number;
  /**
   * FNXC:Workspace 2026-06-24-16:00:
   * When true, the project root is treated as a workspace-mode parent directory containing
   * multiple git sub-repos (recorded in .fusion/workspace.json), not a single git repo.
   * ensureGitRepositoryForProjectPath skips `git init` for workspace roots, and the executor
   * runs tasks per-sub-repo instead of at the root. Auto-detected at registration time when
   * sub-repos are found, with an interactive confirmation prompt. Can be toggled per-project
   * via the dashboard Settings modal or PUT /settings.
   */
  workspaceMode?: boolean;
}

/**
 * Merged settings view combining global and project scopes.
 *
 * This is the primary type returned by `TaskStore.getSettings()` and used
 * by most consumers. Project settings override global settings.
 *
 * Also includes computed/server-only fields like `prAuthAvailable`
 * that are injected at read time by the API layer.
 */
export interface Settings extends GlobalSettings, ProjectSettings {
  /** Whether PR authentication is currently available (read-only, set by server).
   *  True when authenticated gh CLI access is available or token fallback exists. */
  prAuthAvailable?: boolean;
  /** Use the lean fast-path planning prompt variant instead of the full triage spec prompt. */
  leanPlanning?: boolean;
  /** Auto-approve generated specs and skip the independent spec reviewer. */
  autoApproveSpec?: boolean;
  /** Index signature for dynamic settings access */
  [key: string]: unknown;
}

export {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalOnlySettingsKey,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  isMergeRequestContractShadowEnabled,
  resolvePersistAgentThinkingLog,
  sanitizeCliAgentSettings,
  sanitizeCliAgentsSettings,
  sanitizeMcpServers,
  CLI_AGENT_ADAPTER_IDS,
  CLI_AGENT_AUTONOMY_MODES,
} from "./settings-schema.js";

export interface BoardConfig {
  nextId: number;
  settings?: Settings;
}

export interface DistributedTaskIdReserveInput {
  prefix: string;
  nodeId: string;
  ttlMs?: number;
}

export interface DistributedTaskIdReserveResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  expiresAt: string;
  committedClusterTaskCount: number;
}

export interface DistributedTaskIdCommitInput {
  reservationId: string;
  nodeId: string;
}

export interface DistributedTaskIdCommitResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  committedClusterTaskCount: number;
  committedAt: string;
}

export interface DistributedTaskIdAbortInput {
  reservationId: string;
  nodeId: string;
  reason: "abort" | "expired" | "failed-create";
}

export interface DistributedTaskIdAbortResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  committedClusterTaskCount: number;
  abortedAt: string;
}

export interface DistributedTaskIdStateInput {
  prefix: string;
}

export interface DistributedTaskIdStateResult {
  nextSequence: number;
  committedClusterTaskCount: number;
  activeReservationCount: number;
  burnedReservationCount: number;
  lastCommittedTaskId?: string;
}

export interface AutostashOrphanRecord {
  sha: string;
  ref: string;
  label: string;
  sourceTaskId: string | null;
  createdAt: string | null;
  changedPaths: string[];
  classification: "subsumed" | "live" | "unknown";
  /** Merge/recovery phase that created this stash label when known. */
  sourcePhase?: string | null;
  /** Task that detected/surfaced this orphan in the current run. */
  detectedByTaskId?: string | null;
  /** ISO timestamp when this orphan was surfaced in the current run. */
  detectedAt?: string | null;
}

/**
 * Outcome of restoring the developer's pre-merge autostash after the merge
 * completes. Surfaced on MergeResult so the UI / dashboard can show whether
 * the dev's uncommitted work was reapplied cleanly, AI-resolved, or left
 * stashed for manual recovery.
 *
 * Background: when rootDir is the developer's primary checkout, the merger
 * stashes any uncommitted edits before running its hard resets, then applies
 * them back at the end. Historically a pop conflict would log a warning and
 * silently leave the stash in place — developers had no way to discover this
 * had happened. See `restoreUnrelatedRootDirChanges` in merger.ts.
 */
export type AutostashOutcome =
  | { status: "no-changes" }
  | { status: "restored"; stashSha: string }
  | {
      status: "ai-resolved";
      stashSha: string;
      conflictedFiles: string[];
    }
  | {
      status: "conflict-needs-manual";
      stashSha: string;
      conflictedFiles: string[];
      message: string;
    }
  | { status: "failed"; stashSha?: string; errorMessage: string };

export interface MergeResult extends MergeDetails {
  task: Task;
  branch: string;
  merged: boolean;
  noOp?: boolean;
  ok?: true;
  reason?: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
  /** Whether the merged result was pushed to the remote. Only set when pushAfterMerge is enabled. */
  pushedToRemote?: boolean;
  /** Error message if push to remote failed. Non-fatal — merge is already committed locally. */
  pushError?: string;
  /** Outcome of restoring the developer's pre-merge autostash, when one was
   *  created. Absent when the working tree was already clean at merge start. */
  autostash?: AutostashOutcome;
  /** Internal flag to track if a build retry has been attempted. Not persisted. */
  _buildRetried?: boolean;
}

export type TaskCommitAssociationMatchSource =
  | "canonical-lineage-trailer"
  | "legacy-task-id-trailer"
  | "legacy-subject"
  | "manual-reconciliation";

export type TaskCommitAssociationConfidence = "canonical" | "legacy" | "ambiguous";

export interface TaskCommitAssociation {
  id: string;
  taskLineageId: string;
  taskIdSnapshot: string;
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: TaskCommitAssociationMatchSource;
  confidence: TaskCommitAssociationConfidence;
  note?: string;
  additions?: number;
  deletions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommitAssociationDiffBackfillReport {
  scannedRows: number;
  distinctCommits: number;
  updatedRows: number;
  skippedUnavailableCommits: number;
  skippedInvalidShas: number;
  dryRun: boolean;
}

export const COLUMN_LABELS: Record<Column, string> = {
  triage: "Planning",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  archived: "Archived",
};

export const COLUMN_DESCRIPTIONS: Record<Column, string> = {
  triage: "Raw ideas — AI will plan these",
  todo: "Specified and ready to start",
  "in-progress": "AI is working on this in a worktree",
  "in-review": "Complete — ready to merge",
  done: "Merged and closed",
  archived: "Completed and archived",
};

/**
 * @deprecated (workflowColumns, U12) The hardcoded legacy transition graph.
 * Transition validity is resolved from the task's workflow column graph
 * (`resolveAllowedColumns` in `workflow-transitions.ts`) plus trait guards in
 * `moveTaskInternal` — this constant remains the default-workflow parity oracle
 * while legacy call sites are retired.
 */
export const VALID_TRANSITIONS: Record<Column, Column[]> = {
  // FN-4892: intake-side heuristics may cold-archive tasks before execution starts.
  triage: ["todo", "archived"],
  // FN-4892: allow direct archival for newly specified intake tasks.
  todo: ["in-progress", "triage", "archived"],
  // NOTE: "in-progress" → "done" is enabled for mission validation tasks that complete directly.
  // Regular implementation tasks should move through "in-review" before "done".
  "in-progress": ["in-review", "todo", "triage", "done"],
  "in-review": ["done", "in-progress", "todo", "triage"],
  done: ["todo", "triage", "archived"],
  archived: ["done"],
};

// ── Planning Mode Types ────────────────────────────────────────────────────

/** Entry in the archive log (archive.jsonl) representing a compact, 
 *  restorable snapshot of an archived task without agent log content.
 */
export interface ArchivedTaskEntry {
  id: string;
  /** Immutable lineage identity preserved across archive/restore. */
  lineageId: string;
  title?: string;
  description: string;
  /**
   * Task importance level at archive time. Missing legacy values should be
   * interpreted as `normal` during restore/read flows.
   */
  priority?: TaskPriority;
  column: "archived"; // Always archived when in the log
  /** Source column captured at archive time; absent on legacy archive entries. */
  preArchiveColumn?: Column;
  dependencies: string[];
  steps: TaskStep[];
  currentStep: number;
  /** Workflow-defined custom task field values (KTD-13) frozen at archive time. */
  customFields?: Record<string, unknown>;
  size?: "S" | "M" | "L";
  reviewLevel?: number;
  /** Execution mode for task implementation at time of archival.
   *  - "standard": Full execution with complete review workflow (default)
   *  - "fast": Expedited execution with minimal overhead for simple tasks */
  executionMode?: ExecutionMode;
  /** Per-task override of the workflow-native planner oversight level at time of archival. */
  plannerOversightLevel?: PlannerOversightLevel;
  prInfo?: PrInfo;
  prInfos?: PrInfo[];
  issueInfo?: IssueInfo;
  githubTracking?: TaskGithubTracking;
  /** Linked GitLab tracking metadata for GitLab.com and self-managed GitLab items. */
  gitlabTracking?: TaskGitLabTracking;
  /** Durable source provenance for the originating external issue. */
  sourceIssue?: TaskSourceIssue;
  /** Attachment metadata (filenames, mime types, etc.) without file content */
  attachments?: TaskAttachment[];
  /** User and agent comments remain searchable in the archive DB. */
  comments?: TaskComment[];
  /** Structured review metadata shown in the Review tab (legacy contract). */
  review?: TaskReview;
  /** Structured review metadata shown in the Review tab (canonical contract). */
  reviewState?: TaskReviewState;
  /** Reconstructed prompt content at archive time, without attachment blobs. */
  prompt?: string;
  /** Agent log retention mode used when this archive entry was written. */
  agentLogMode?: ArchiveAgentLogMode;
  /** Deterministic compact summary of the historical agent log. */
  agentLogSummary?: string;
  /** Bounded recent agent log entries retained in compact mode. */
  agentLogSnapshot?: AgentLogEntry[];
  /** Full historical agent log. Only present when archiveAgentLogMode is "full". */
  agentLogFull?: AgentLogEntry[];
  log: TaskLogEntry[];
  createdAt: string;
  updatedAt: string;
  columnMovedAt?: string;
  /** Immutable first-ever dispatch timestamp into `in-progress`. */
  firstExecutionAt?: string;
  /** Accumulated active runtime spent in `in-progress` across attempts. */
  cumulativeActiveMs?: number;
  /** FNXC:TaskTiming 2026-06-26-10:14: per-column cumulative dwell (ms) carried through
   *  archive/restore so per-stage wall-clock survives archival. See Task.columnDwellMs. */
  columnDwellMs?: Record<string, number>;
  /** Current-attempt execution anchor; may be cleared on reopen. */
  executionStartedAt?: string;
  /** First-time completion anchor; may be cleared on reopen. */
  executionCompletedAt?: string;
  /** ISO timestamp set when the task is soft-deleted from active views. */
  deletedAt?: string;
  /** Timestamp when the task was archived to the log */
  archivedAt: string;
  /** Optional: model preset and override fields for executor and validator */
  modelPresetId?: string;
  modelProvider?: string;
  modelId?: string;
  validatorModelProvider?: string;
  validatorModelId?: string;
  /** Optional: planning model override for triage agent */
  planningModelProvider?: string;
  planningModelId?: string;
  /** Per-task token/cost accounting (input/output/cache) preserved across archival. */
  tokenUsage?: TaskTokenUsage;
  /** Optional: other metadata to preserve */
  breakIntoSubtasks?: boolean;
  noCommitsExpected?: boolean;
  paused?: boolean;
  baseBranch?: string;
  /** Actual git branch name used for this task's worktree */
  branch?: string;
  /** Optional planning/mission branch-group metadata carried across related tasks. */
  branchContext?: TaskBranchContext;
  /** Optional per-task auto-merge override. Undefined means no task-level override. */
  autoMerge?: boolean;
  /** Base commit SHA for the task's worktree */
  baseCommitSha?: string;
  /** List of files modified by this task */
  modifiedFiles?: string[];
  /** Mission ID this task is linked to */
  missionId?: string;
  /** Slice ID this task is linked to */
  sliceId?: string;
  mergeRetries?: number;
  recoveryRetryCount?: number;
  nextRecoveryAt?: string;
  error?: string;
  /** User assigned to review this task (used during review handoff) */
  assigneeUserId?: string;
}

/** Type of planning question presented to the user */
export type PlanningQuestionType = "text" | "single_select" | "multi_select" | "confirm";

/** Exact Planning Mode checkpoint prompt shown before a final summary can be displayed. */
export const PLANNING_DEEPEN_CHECKPOINT_QUESTION = "Would you like to go deeper?";

/** Reserved question id for the server-owned Planning Mode deepening checkpoint. */
export const PLANNING_DEEPEN_CHECKPOINT_ID = "__planning_deepen_checkpoint__";

/** Reserved checkbox option id that lets the user accept the pending final summary. */
export const PLANNING_DEEPEN_PROCEED_OPTION_ID = "__planning_deepen_proceed_to_final__";

/** Reserved response key accepted as an explicit proceed signal for the deepening checkpoint. */
export const PLANNING_DEEPEN_PROCEED_RESPONSE_KEY = "__planning_deepen_proceed__";

/** Isolation mode for project execution */
export type IsolationMode = "in-process" | "child-process";

/** Project status in the central registry */
export type ProjectStatus = "active" | "paused" | "errored" | "initializing";

/** Node connectivity/health status in the central registry */
export type NodeStatus = "online" | "offline" | "connecting" | "error";

/** A node discovered on the local network via mDNS/DNS-SD */
export interface DiscoveredNode {
  /** Node name from the mDNS service instance name */
  name: string;
  /** Host address (IP address) */
  host: string;
  /** Port the Fusion dashboard is running on */
  port: number;
  /** Node type from TXT record */
  nodeType: "local" | "remote";
  /** Node ID from TXT record (if the node has registered itself) */
  nodeId?: string;
  /** When this node was first discovered */
  discoveredAt: string;
  /** When this node was last seen (updated on each mDNS response) */
  lastSeenAt: string;
}

/** Configuration for network node discovery */
export interface DiscoveryConfig {
  /** Whether to broadcast this node's presence on the network */
  broadcast: boolean;
  /** Whether to listen for other nodes on the network */
  listen: boolean;
  /** mDNS service type name (default: "_fusion._tcp") */
  serviceType: string;
  /** Port to advertise (defaults to the dashboard port) */
  port: number;
  /**
   * How long (ms) to remember a discovered node after last seeing it.
   * Default: 300000 (5 minutes).
   */
  staleTimeoutMs: number;
}

export type NodeDiscoveryEvent =
  | { type: "node:discovered"; node: DiscoveredNode }
  | { type: "node:updated"; node: DiscoveredNode }
  | { type: "node:lost"; name: string }
  | { type: "discovery:started" }
  | { type: "discovery:stopped" };

/** Host-level resource and uptime metrics reported by a node. */
export interface SystemMetrics {
  /** CPU utilization percentage (0-100). */
  cpuUsage: number;
  /** Used system memory in bytes. */
  memoryUsed: number;
  /** Total system memory in bytes. */
  memoryTotal: number;
  /** Used storage space in bytes. */
  storageUsed: number;
  /** Total storage space in bytes. */
  storageTotal: number;
  /** Node uptime in milliseconds. */
  uptime: number;
  /** ISO timestamp for when the metrics snapshot was captured. */
  reportedAt: string;
}

/** A peer node known by a local node in the mesh graph. */
export interface PeerNode {
  /** Unique id for this node-peer relationship. */
  id: string;
  /** Local node id that owns this peer entry. */
  nodeId: string;
  /** Remote node identifier for this peer relationship. */
  peerNodeId: string;
  /** Remote peer display name. */
  name: string;
  /** Remote peer base URL. */
  url: string;
  /** Last known peer connectivity status. */
  status: NodeStatus;
  /** ISO timestamp when the peer was last observed. */
  lastSeen: string;
  /** ISO timestamp when the peer relationship was created. */
  connectedAt: string;
}

/** Full mesh status snapshot for a node. */
export interface NodeMeshState {
  /** Node id for this snapshot. */
  nodeId: string;
  /** Display name of the reporting node. */
  nodeName: string;
  /** Optional base URL (undefined for local nodes). */
  nodeUrl: string | undefined;
  /** Runtime node type for this snapshot. */
  nodeType: NodeConfig["type"];
  /** Current node status. */
  status: NodeStatus;
  /** Latest metrics payload for the node. */
  metrics: SystemMetrics | null;
  /** ISO timestamp when the node was last seen. */
  lastSeen: string;
  /** ISO timestamp when this node was connected/registered. */
  connectedAt: string;
  /** Expanded peer list for the node. */
  knownPeers: PeerNode[];
}

/** Cluster-wide mesh topology snapshot merged from local and remote mesh reads. */
export interface MeshClusterSnapshot {
  /** ISO timestamp when this aggregate snapshot was assembled. */
  collectedAt: string;
  /** Node ID that assembled and served the snapshot. */
  sourceNodeId: string;
  /** Deduplicated per-node mesh snapshots keyed by nodeId semantically. */
  nodes: NodeMeshState[];
}

/** Lightweight mesh discovery record for propagating peer awareness. */
export interface MeshDiscovery {
  /** Node id that generated this discovery payload. */
  nodeId: string;
  /** Known peer node ids for the reporting node. */
  knownPeers: string[];
  /** ISO timestamp for latest discovery refresh. */
  lastDiscoveryAt: string;
  /** Monotonic version for discovery state updates. */
  discoveryVersion: number;
}

/** Lightweight snapshot of a known node suitable for gossip transmission. */
export interface PeerInfo {
  /** Unique node identifier. */
  nodeId: string;
  /** Display name of the node. */
  nodeName: string;
  /** Base URL of the node (empty string for local nodes). */
  nodeUrl: string;
  /** Current node status. */
  status: NodeStatus;
  /** Latest system metrics snapshot, if available. */
  metrics: SystemMetrics | null;
  /** ISO timestamp of when this info was last updated. */
  lastSeen: string;
  /** Optional capabilities available on this node. */
  capabilities?: AgentCapability[];
  /** Maximum concurrent tasks/runtimes this node can host. */
  maxConcurrent: number;
}

/** Request payload sent when a node initiates a peer sync. */
export interface SnapshotBase {
  version: number;
  exportedAt: string;
  checksum: string;
}

export type MeshWriteQueueStatus = "pending" | "replaying" | "applied" | "failed";

export interface MeshSnapshotQuery {
  nodeId: string;
  projectId?: string | null;
  scope: string;
}

export interface MeshSnapshotRecordInput {
  nodeId: string;
  projectId?: string | null;
  scope: string;
  payload: Record<string, unknown>;
  snapshotVersion: string;
  capturedAt: string;
  sourceNodeId?: string | null;
  sourceRunId?: string | null;
  staleAfter?: string | null;
}

export interface MeshSnapshotRecord extends MeshSnapshotRecordInput {
  updatedAt: string;
}

export interface MeshWriteQueueInput {
  originNodeId: string;
  targetNodeId: string;
  projectId?: string | null;
  scope: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Record<string, unknown>;
  intentVersion: string;
}

export interface MeshWriteQueueFilter {
  originNodeId?: string;
  targetNodeId?: string;
  status?: MeshWriteQueueStatus;
}

export interface MeshWriteQueueEntry extends MeshWriteQueueInput {
  id: string;
  status: MeshWriteQueueStatus;
  attemptCount: number;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string | null;
}

export interface MeshWriteApplyResult {
  appliedAt?: string;
}

export interface MeshWriteFailureResult {
  lastError: string;
}

export interface MeshWriteReplaySummary {
  replayed: number;
  applied: number;
  failed: number;
  queuedWriteIds: string[];
}

export interface MeshDegradedReadState {
  mode: "fresh" | "degraded";
  asOf: string;
  sourceNodeId: string | null;
  snapshotVersion: string | null;
  stalenessMs: number;
  queueDepth: number;
  pendingWriteCount: number;
  failedWriteCount: number;
}

export interface SharedMeshStatePayload {
  taskMetadata?: SnapshotBase & { payload: { tasks: Task[] } };
  missionHierarchy?: SnapshotBase & {
    payload: {
      missions: import("./mission-types.js").Mission[];
      milestones: import("./mission-types.js").Milestone[];
      slices: import("./mission-types.js").Slice[];
      features: import("./mission-types.js").MissionFeature[];
      missionEvents: import("./mission-types.js").MissionEvent[];
      assertions: import("./mission-types.js").MissionContractAssertion[];
      featureAssertionLinks: import("./mission-types.js").FeatureAssertionLink[];
    };
  };
  agents?: SnapshotBase & { payload: { agents: Agent[]; blockedStates: { agentId: string; state: BlockedStateSnapshot }[] } };
  agentRuns?: SnapshotBase & { payload: { runs: AgentHeartbeatRun[] } };
  activityLog?: SnapshotBase & { payload: { entries: ActivityLogEntry[] } };
  runAudit?: SnapshotBase & { payload: { entries: RunAuditEvent[] } };
  projectSettings?: SnapshotBase & { payload: { global: GlobalSettings; projects?: Record<string, ProjectSettings> } };
  authMaterial?: SnapshotBase & { payload: { providerAuth?: Record<string, ProviderAuthEntry> } };
}

export interface PeerSyncRequest {
  /** Node ID of the sender. */
  senderNodeId: string;
  /** Base URL of the sender node. */
  senderNodeUrl: string;
  /** List of peers known by the sender. */
  knownPeers: PeerInfo[];
  /** ISO timestamp of when this sync request was generated. */
  timestamp: string;
  /** Optional settings sync payload included in the request. */
  settings?: SettingsSyncPayload;
  /** Optional shared-state payload included in the request. */
  sharedState?: SharedMeshStatePayload;
}

/** Response payload returned after a peer sync exchange. */
export interface PeerSyncResponse {
  /** Node ID of the responding node (local node). */
  senderNodeId: string;
  /** Base URL of the responding node. */
  senderNodeUrl: string;
  /** Full list of peers known by the responding node. */
  knownPeers: PeerInfo[];
  /** Peers in the local list that the sender didn't know about. */
  newPeers: PeerInfo[];
  /** ISO timestamp of when this response was generated. */
  timestamp: string;
  /** Optional settings sync payload included in the response. */
  settings?: SettingsSyncPayload;
  /** Optional shared-state payload included in the response. */
  sharedState?: SharedMeshStatePayload;
}

/** A single provider's authentication credential for sync transport. */
export interface ProviderAuthEntry {
  /** Credential type: "api_key" or "oauth". */
  type: "api_key" | "oauth";
  /** The API key value (for "api_key" type). Omitted for OAuth providers. */
  key?: string;
  /** OAuth access token (for "oauth" type). Omitted for API key providers. */
  accessToken?: string;
  /** OAuth refresh token (for "oauth" type). */
  refreshToken?: string;
  /** OAuth credential expiry epoch milliseconds. */
  expires?: number;
  /** Optional OAuth account identifier. */
  accountId?: string;
  /** Whether this credential has been validated. */
  authenticated?: boolean;
}

/** Payload for synchronizing settings and model auth between nodes. */
export interface SettingsSyncPayload {
  /** Global settings (user-level preferences, model defaults). */
  global?: GlobalSettings;
  /** Map of project name → project settings for projects on this node.
   *  Keyed by project name (not ID or path) since node paths differ. */
  projects?: Record<string, ProjectSettings>;
  /** Model provider auth credentials. Keys are provider IDs (e.g., "anthropic", "openai").
   *  Values contain the credential type and key. Only transmitted over authenticated
   *  node connections. */
  providerAuth?: Record<string, ProviderAuthEntry>;
  /** Per-project workflow setting values keyed `workflowId → { settingKey: value }`. */
  workflowSettings?: Record<string, Record<string, unknown>>;
  /** ISO timestamp when this snapshot was generated. */
  exportedAt: string;
  /** Checksum of the settings data for change detection (SHA-256 hex of JSON). */
  checksum: string;
  /** Version of the sync payload format. */
  version: 1;
}

/** Tracks settings sync state between the local node and a remote node. */
export interface SettingsSyncState {
  /** Local node ID. */
  nodeId: string;
  /** Remote node ID. */
  remoteNodeId: string;
  /** ISO timestamp of the last successful settings sync. */
  lastSyncedAt: string | null;
  /** Checksum of local settings at last sync (for change detection). */
  localChecksum: string | null;
  /** Checksum of remote settings at last sync. */
  remoteChecksum: string | null;
  /** Number of settings syncs performed. */
  syncCount: number;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** Result of a settings sync exchange. */
export interface SettingsSyncResult {
  /** Number of global settings applied. */
  globalCount: number;
  /** Number of project settings applied. */
  projectCount: number;
  /** Number of provider auth entries synced. */
  authCount: number;
  /** Number of workflow setting values applied by the caller. */
  workflowSettingsCount: number;
  /** Whether the sync was successful. */
  success: boolean;
  /** Error message if sync failed. */
  error?: string;
}

/** A runtime node that can host project execution (local machine or remote host) */
export interface NodeConfig {
  /** Unique node ID (e.g., "node_abc123") */
  id: string;
  /** Display name (unique across all nodes) */
  name: string;
  /** Node type */
  type: "local" | "remote";
  /** Base URL for remote nodes. Undefined for local nodes. */
  url?: string;
  /** API key used for authenticating requests to remote nodes. */
  apiKey?: string;
  /** Current node status */
  status: NodeStatus;
  /** Optional capabilities available on this node */
  capabilities?: AgentCapability[];
  /** Optional latest host metrics for this node. */
  systemMetrics?: SystemMetrics;
  /** Optional list of known peer node IDs. */
  knownPeers?: string[];
  /** Version tracking info (app version, plugin versions, last sync) */
  versionInfo?: NodeVersionInfo;
  /** Snapshot of plugin ID → version mapping */
  pluginVersions?: Record<string, string>;
  /** Persisted Docker-managed container configuration, when present. */
  dockerConfig?: DockerNodeConfig;
  /** Maximum concurrent tasks/runtimes this node can host */
  maxConcurrent: number;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Persisted configuration for a Docker-managed Fusion node. */
export interface DockerNodeConfig {
  /** Docker image name (e.g., "runfusion/fusion:latest") */
  image: string;
  /** Container name (defaults to "fusion-{nodeId}") */
  containerName?: string;
  /** Volume mount definitions */
  volumeMounts: DockerNodeVolumeMount[];
  /** Environment variable overrides (key-value pairs) */
  environment: Record<string, string>;
  /** Resource limits */
  resources?: DockerNodeContainerResourceConfig;
  /** Docker host connection settings */
  host?: DockerNodeHostConfig;
  /** Optional CLI tools to include in the container */
  extraClis?: string[];
  /** Persistent storage configuration */
  persistence?: DockerNodePersistenceConfig;
  /** Config version counter — starts at 1, auto-incremented on every update */
  configVersion: number;
  /** ISO timestamp of last config change (auto-set on update) */
  lastUpdated?: string;
}

export interface DockerNodeVolumeMount {
  /** Host path or named volume */
  hostPath: string;
  /** Container mount path */
  containerPath: string;
  /** "rw" (default) or "ro" */
  mode?: "rw" | "ro";
  /** "volume" (default) for named volumes, "bind" for host bind mounts */
  type?: "volume" | "bind";
}

export interface DockerNodeContainerResourceConfig {
  /** Memory limit in bytes (e.g., 2147483648 for 2GB) */
  memoryBytes?: number;
  /** CPU count limit (e.g., 2.0 for two cores) */
  cpuCount?: number;
  /** PIDs limit */
  pidsLimit?: number;
}

export interface DockerNodeHostConfig {
  /** Docker context name (for named Docker context selection) */
  contextName?: string;
  /** Explicit Docker host URL (e.g., "tcp://192.168.1.100:2376") */
  dockerHost?: string;
  /** Path to TLS CA cert */
  tlsCaCert?: string;
  /** Path to TLS client cert */
  tlsCert?: string;
  /** Path to TLS client key */
  tlsKey?: string;
  /** Whether to verify TLS (default: true) */
  tlsVerify?: boolean;
}

export interface DockerNodePersistenceConfig {
  /** Named Docker volume for Fusion data */
  volumeName?: string;
  /** Whether to retain the volume when the node is deleted (default: false) */
  retainOnDelete?: boolean;
}

export function validateDockerNodeConfig(config: unknown): {
  valid: boolean;
  config?: DockerNodeConfig;
  errors?: string[];
} {
  const errors: string[] = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config must be an object"] };
  }

  const candidate = config as Record<string, unknown>;

  if (typeof candidate.image !== "string" || !candidate.image.trim()) {
    errors.push("image must be a non-empty string");
  }

  if (!Array.isArray(candidate.volumeMounts)) {
    errors.push("volumeMounts must be an array");
  } else {
    candidate.volumeMounts.forEach((mount, index) => {
      if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
        errors.push(`volumeMounts[${index}] must be an object`);
        return;
      }
      const mountCandidate = mount as Record<string, unknown>;
      if (typeof mountCandidate.hostPath !== "string") {
        errors.push(`volumeMounts[${index}].hostPath must be a string`);
      }
      if (typeof mountCandidate.containerPath !== "string") {
        errors.push(`volumeMounts[${index}].containerPath must be a string`);
      }
      if (mountCandidate.mode !== undefined && mountCandidate.mode !== "rw" && mountCandidate.mode !== "ro") {
        errors.push(`volumeMounts[${index}].mode must be "rw" or "ro"`);
      }
      if (mountCandidate.type !== undefined && mountCandidate.type !== "volume" && mountCandidate.type !== "bind") {
        errors.push(`volumeMounts[${index}].type must be "volume" or "bind"`);
      }
    });
  }

  if (!candidate.environment || typeof candidate.environment !== "object" || Array.isArray(candidate.environment)) {
    errors.push("environment must be an object");
  } else {
    for (const [key, value] of Object.entries(candidate.environment)) {
      if (typeof key !== "string" || typeof value !== "string") {
        errors.push(`environment.${key} must be a string value`);
      }
    }
  }

  if (typeof candidate.configVersion !== "number" || !Number.isFinite(candidate.configVersion) || candidate.configVersion < 1) {
    errors.push("configVersion must be a number >= 1");
  }

  const validateOptionalObject = (
    fieldName: string,
    value: unknown,
    validators: Array<[string, (value: unknown) => boolean, string]>,
  ) => {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${fieldName} must be an object`);
      return;
    }
    const typed = value as Record<string, unknown>;
    for (const [prop, test, message] of validators) {
      if (typed[prop] !== undefined && !test(typed[prop])) {
        errors.push(`${fieldName}.${prop} ${message}`);
      }
    }
  };

  validateOptionalObject("resources", candidate.resources, [
    ["memoryBytes", (value) => typeof value === "number" && Number.isFinite(value), "must be a number"],
    ["cpuCount", (value) => typeof value === "number" && Number.isFinite(value), "must be a number"],
    ["pidsLimit", (value) => typeof value === "number" && Number.isFinite(value), "must be a number"],
  ]);

  validateOptionalObject("host", candidate.host, [
    ["contextName", (value) => typeof value === "string", "must be a string"],
    ["dockerHost", (value) => typeof value === "string", "must be a string"],
    ["tlsCaCert", (value) => typeof value === "string", "must be a string"],
    ["tlsCert", (value) => typeof value === "string", "must be a string"],
    ["tlsKey", (value) => typeof value === "string", "must be a string"],
    ["tlsVerify", (value) => typeof value === "boolean", "must be a boolean"],
  ]);

  validateOptionalObject("persistence", candidate.persistence, [
    ["volumeName", (value) => typeof value === "string", "must be a string"],
    ["retainOnDelete", (value) => typeof value === "boolean", "must be a boolean"],
  ]);

  if (candidate.extraClis !== undefined) {
    if (!Array.isArray(candidate.extraClis) || candidate.extraClis.some((item) => typeof item !== "string")) {
      errors.push("extraClis must be an array of strings");
    }
  }

  if (candidate.containerName !== undefined && typeof candidate.containerName !== "string") {
    errors.push("containerName must be a string");
  }

  if (candidate.lastUpdated !== undefined && typeof candidate.lastUpdated !== "string") {
    errors.push("lastUpdated must be a string");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, config: candidate as unknown as DockerNodeConfig };
}

export function sanitizeDockerNodeConfigForResponse(config: DockerNodeConfig): DockerNodeConfig {
  const clone = structuredClone(config);
  const sensitivePattern = /API_KEY|SECRET|TOKEN|PASSWORD/i;

  for (const [key, value] of Object.entries(clone.environment)) {
    if (sensitivePattern.test(key) && typeof value === "string") {
      clone.environment[key] = "***";
    }
  }

  if (clone.host?.tlsKey) {
    clone.host.tlsKey = "***";
  }

  return clone;
}

/** Version information tracked per node for plugin synchronization */
export interface NodeVersionInfo {
  /** Core Fusion application version (semver string, e.g., "0.1.0") */
  appVersion: string;
  /** Map of plugin-id → semver version string for all installed plugins */
  pluginVersions: Record<string, string>;
  /** ISO-8601 timestamp of the last sync operation */
  lastSyncedAt: string;
}

/** Input for updating node version info. appVersion is optional and will be auto-filled if not provided. */
export type NodeVersionInfoInput = Omit<NodeVersionInfo, "appVersion"> & {
  /** Core Fusion application version. If not provided, will be auto-filled with the current app version. */
  appVersion?: string;
};

/** Lifecycle status of a managed Docker node. */
export type DockerNodeStatus = "creating" | "running" | "stopped" | "error" | "recreating" | "deleting";

/** Docker daemon connection settings for provisioning a managed node container. */
export interface DockerHostConfig {
  /** Docker host URI (for example: tcp://192.168.1.50:2376 or unix:///var/run/docker.sock). */
  host?: string;
  /** Named Docker context to target. */
  context?: string;
  /** Whether to verify Docker daemon TLS certificates. */
  tlsVerify?: boolean;
  /** Path to Docker daemon CA certificate. */
  tlsCaPath?: string;
  /** Path to Docker client certificate. */
  tlsCertPath?: string;
  /** Path to Docker client private key. */
  tlsKeyPath?: string;
}

/** Container CPU and memory limit settings for managed Docker nodes. */
export interface DockerResourceSizing {
  /** Memory limit in MB (for example: 4096). */
  memoryMB?: number;
  /** CPU limit (for example: 2.0). */
  cpus?: number;
  /** Swap limit in MB (0 = unlimited swap, Docker default behavior). */
  memorySwapMB?: number;
}

/** A single bind mount definition for a managed Docker node container. */
export interface DockerVolumeMount {
  /** Absolute path on the host machine. */
  hostPath: string;
  /** Path inside the container. */
  containerPath: string;
  /** Mount mode. Defaults to read/write when omitted. */
  mode?: "ro" | "rw";
}

/** Optional additional CLI tools installed in the managed Docker node image. */
export type DockerExtraCli = "claude-cli" | "droid-cli";

/** Persisted definition and lifecycle metadata for a managed Docker node. */
export interface ManagedDockerNode {
  /** Unique managed Docker node ID (for example: dn_abc123). */
  id: string;
  /** Linked mesh node ID after registration, or null while provisioning. */
  nodeId: string | null;
  /** Display name (unique across managed Docker nodes). */
  name: string;
  /** Docker image repository/name (for example: runfusion/fusion). */
  imageName: string;
  /** Docker image tag (for example: latest or 0.2.0). */
  imageTag: string;
  /** Provisioned container ID, or null before container creation. */
  containerId: string | null;
  /** Current managed Docker lifecycle status. */
  status: DockerNodeStatus;
  /** Docker daemon host/context configuration used for operations. */
  hostConfig: DockerHostConfig;
  /** Environment variables injected into the container. */
  envVars: Record<string, string>;
  /** Bind mounts configured for this container. */
  volumeMounts: DockerVolumeMount[];
  /** Resource limits for this container. */
  resourceSizing: DockerResourceSizing;
  /** Optional extra CLI tools included in provisioning. */
  extraClis: DockerExtraCli[];
  /** Whether storage volumes persist across container recreation. */
  persistentStorage: boolean;
  /** Reachable URL for mesh/node registration once running. */
  reachableUrl: string | null;
  /** API key for the managed node, auto-generated or user-provided. */
  apiKey: string | null;
  /** Last provisioning/runtime error message when status is error. */
  errorMessage: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last update timestamp. */
  updatedAt: string;
}

/** Input for creating a managed Docker node record. */
export type ManagedDockerNodeInput = Omit<
  ManagedDockerNode,
  "id" | "containerId" | "status" | "createdAt" | "updatedAt" | "errorMessage"
>;

/** Partial update payload for managed Docker nodes. */
export type ManagedDockerNodeUpdate = Partial<
  Omit<ManagedDockerNode, "id" | "createdAt">
>;

/** Input to the mesh configuration generation process. */
export interface MeshConfigGeneratorInput {
  /** The managed Docker node record (from FN-3107). */
  managedNode: ManagedDockerNode;
  /** The orchestrating node's URL (e.g., "http://192.168.1.10:4040"). */
  orchestratorUrl: string;
  /** The orchestrating node's API key for authentication. */
  orchestratorApiKey: string;
  /** Optional user-provided API key. If omitted, one is auto-generated. */
  nodeApiKey?: string;
  /** Optional container port override. If omitted, defaults to 4041. */
  containerPort?: number;
}

/** Input to the end-to-end provision-and-register flow. */
export interface FullProvisioningInput {
  /** The managed Docker node to configure and register. */
  managedNode: ManagedDockerNode;
  /** The orchestrating node's URL. */
  orchestratorUrl: string;
  /** The orchestrating node's API key. */
  orchestratorApiKey: string;
  /** Optional user-provided API key for the new node. */
  nodeApiKey?: string;
  /** Optional container port override. */
  containerPort?: number;
}

/** Configuration bundle needed for a new node to join the mesh. */
export interface MeshConnectionConfig {
  /** API key for authenticating to this node. Auto-generated if not provided by user. */
  nodeApiKey: string;
  /** The URL the orchestrating node uses to reach the new container. */
  reachableUrl: string;
  /** Orchestrating node's URL, pushed to the container so it knows its mesh parent. */
  orchestratorUrl: string;
  /** Orchestrating node's API key for inbound settings sync authentication. */
  orchestratorApiKey: string;
  /** Port the container's Fusion server will listen on. */
  containerPort: number;
  /** Environment variables assembled from the above for injection into the container. */
  envVars: Record<string, string>;
}

/** Result of applying mesh config to a provisioned node. */
export interface MeshConfigResult {
  /** The generated/applied connection config. */
  config: MeshConnectionConfig;
  /** The registered NodeConfig in the mesh. */
  node: NodeConfig;
  /** Whether the node health check passed after registration. */
  isHealthy: boolean;
  /** Latency of the health check in ms, if successful. */
  healthCheckLatencyMs?: number;
  /** Error if health check or registration failed. */
  error?: string;
}

/** Information about a discovered Docker context */
export interface DockerContextInfo {
  /** Context name (e.g., "default", "my-remote") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Docker host URI for this context (e.g., "tcp://192.168.1.50:2376") */
  dockerHost?: string;
  /** Whether this is the currently active context */
  isCurrentContext: boolean;
  /** Whether this context has a connection error */
  isError?: boolean;
  /** Error message if the context is unreachable */
  errorMessage?: string;
}

/** Result of testing Docker daemon connectivity */
export interface DockerConnectivityResult {
  /** Whether the connection succeeded */
  success: boolean;
  /** Docker Engine version string */
  dockerVersion?: string;
  /** Docker API version string */
  apiVersion?: string;
  /** Docker Engine OS/arch info */
  operatingSystem?: string;
  /** Error message if connection failed */
  error?: string;
  /** Whether the target is the local Docker daemon */
  isLocalDaemon: boolean;
}

/** Minimal container inspection result from Docker */
export interface DockerContainerInspectResult {
  /** Container ID */
  id: string;
  /** Container name (with leading / stripped) */
  name: string;
  /** Container status string (e.g., "running", "exited") */
  status: string;
  /** Image name/tag */
  image: string;
  /** Creation timestamp (Unix epoch) */
  created: number;
  /** Detailed container state */
  state: {
    running: boolean;
    paused: boolean;
    restarting: boolean;
    dead: boolean;
    error?: string;
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
  };
  /** Optional exposed ports summary */
  ports?: Record<string, string>;
}

/** Configuration for the Fusion Docker image to use for provisioning */
export interface DockerNodeImageConfig {
  /** Image name (e.g., "runfusion/fusion" or "ghcr.io/runfusion/fusion") */
  image: string;
  /** Image tag (e.g., "latest", "0.14.1") */
  tag: string;
  /** Whether to pull the image before creating the container */
  pullImage: boolean;
  /** Optional registry authentication — username */
  registryUsername?: string;
  /** Optional registry authentication — password/token */
  registryPassword?: string;
}

/** Resource constraints for a provisioned Docker container */
export interface DockerNodeResourceConfig {
  /** CPU limit in cores (e.g., 2 = 2 CPUs). Undefined = unlimited */
  cpuLimit?: number;
  /** Memory limit in megabytes. Undefined = unlimited */
  memoryLimitMb?: number;
  /** Memory swap limit in megabytes. -1 = unlimited swap. Undefined = default */
  memorySwapMb?: number;
}

/** Input for provisioning a new Docker-based Fusion node */
export interface DockerProvisionInput {
  /** Display name for the node (must be unique) */
  nodeName: string;
  /** Docker host configuration — where to create the container */
  hostConfig: DockerHostConfig;
  /** Image configuration — which Fusion image to use */
  imageConfig: DockerNodeImageConfig;
  /** Resource constraints for the container */
  resourceConfig?: DockerNodeResourceConfig;
  /** Environment variables to set in the container (KEY=VALUE strings) */
  environment?: string[];
  /** Volume mount specifications (e.g., ["fusion-data:/data", "/host/path:/container/path"]) */
  volumeMounts?: string[];
  /** Named volume for persistent Fusion data storage. If provided, mounted at /data */
  persistentVolume?: string;
  /** Optional extra CLI tools to include in the container (e.g., ["claude", "droid"]) */
  extraClis?: string[];
  /** The URL/hostname where this node will be reachable by other nodes */
  reachableUrl?: string;
  /** Whether to auto-generate an API key for this node */
  autoGenerateApiKey: boolean;
  /** Explicit API key to use (if autoGenerateApiKey is false) */
  apiKey?: string;
  /** Maximum concurrent tasks for this node (default: 2) */
  maxConcurrent?: number;
  /** Optional Docker network to attach the container to */
  network?: string;
  /** Optional container labels (key-value pairs) */
  labels?: Record<string, string>;
}

/** Result of a Docker node provisioning operation */
export interface DockerProvisionResult {
  /** Whether provisioning succeeded */
  success: boolean;
  /** The container ID created by Docker */
  containerId?: string;
  /** The container name (generated or specified) */
  containerName?: string;
  /** The registered node ID in CentralCore */
  nodeId?: string;
  /** The API key generated or assigned for this node */
  apiKey?: string;
  /** The port mapping (if applicable) */
  portMapping?: string;
  /** Error message if provisioning failed */
  error?: string;
  /** The stage at which failure occurred (for error reporting) */
  failedStage?: "image-pull" | "container-create" | "container-start" | "node-register" | "config-apply";
  /** Duration of the provisioning operation in ms */
  durationMs?: number;
}

/** A single plugin's version information for sync comparison */
export interface PluginVersionEntry {
  /** Plugin ID (matches PluginManifest.id) */
  pluginId: string;
  /** Version on the source/local node (undefined if not installed) */
  localVersion?: string;
  /** Version on the target/remote node (undefined if not installed) */
  remoteVersion?: string;
}

/** Suggested action for a plugin during node synchronization */
export type PluginSyncAction = "install" | "update" | "remove" | "no-action";

/** A single plugin sync recommendation */
export interface PluginSyncEntry {
  /** Plugin ID */
  pluginId: string;
  /** Suggested action */
  action: PluginSyncAction;
  /** Version to install/update to (undefined for "remove" and "no-action") */
  targetVersion?: string;
  /** Current version on the local node (undefined if not installed) */
  localVersion?: string;
  /** Current version on the remote node (undefined if not installed) */
  remoteVersion?: string;
  /** Reason for the suggested action */
  reason: string;
}

/** Result of comparing plugin versions between two nodes */
export interface PluginSyncResult {
  /** The local node ID */
  localNodeId: string;
  /** The remote node ID being compared against */
  remoteNodeId: string;
  /** List of plugin sync recommendations */
  plugins: PluginSyncEntry[];
  /** ISO-8601 timestamp of when this comparison was made */
  comparedAt: string;
  /** Whether the two nodes are considered compatible (no install/update/remove needed) */
  isCompatible: boolean;
  /** Summary message */
  summary: string;
}

/** Compatibility status between two version strings */
export type VersionCompatibilityStatus = "compatible" | "minor-difference" | "major-difference" | "incompatible";

/** Result of checking version compatibility between two versions */
export interface VersionCompatibilityResult {
  /** The local version */
  localVersion: string;
  /** The remote version */
  remoteVersion: string;
  /** Overall compatibility status */
  status: VersionCompatibilityStatus;
  /** Human-readable explanation */
  message: string;
}

/** A project registered in the central database */
export interface RegisteredProject {
  /** Unique project ID (e.g., "proj_abc123") */
  id: string;
  /** Display name */
  name: string;
  /** Absolute path to project directory */
  path: string;
  /** Current project status */
  status: ProjectStatus;
  /** Execution isolation mode */
  isolationMode: IsolationMode;
  /** Optional runtime node assignment */
  nodeId?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** ISO-8601 timestamp of last activity */
  lastActivityAt?: string;
  /** Cached project settings snapshot */
  settings?: ProjectSettings;
}

/** @deprecated Use RegisteredProject instead */
export type ProjectInfo = RegisteredProject;

/** A persisted per-project, per-node working directory path mapping. */
export interface ProjectNodePathMapping {
  /** Project ID reference */
  projectId: string;
  /** Node ID reference */
  nodeId: string;
  /** Absolute working-directory path for this project on this node */
  path: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input payload for creating/updating a project-node path mapping. */
export interface ProjectNodePathMappingUpsertInput {
  projectId: string;
  nodeId: string;
  path: string;
}

/** Input payload for deleting a project-node path mapping. */
export interface ProjectNodePathMappingDeleteInput {
  projectId: string;
  nodeId: string;
}

/** Health metrics for a registered project */
export interface ProjectHealth {
  /** Project ID reference */
  projectId: string;
  /** Current status */
  status: ProjectStatus;
  /** Number of tasks currently active */
  activeTaskCount: number;
  /**
   * FNXC:Concurrency 2026-06-26-23:46:
   * Persisted project-health bookkeeping refreshed only by health polling / slot accounting paths; it is not a live read-layer running-agent count.
   * Consumers that need current running agents must derive from the shared top-level slot predicate: in-progress executors, active triage planners (`column === "triage" && status === "planning" && !paused`), and active in-review reviewer/merger/fix agents including PR/fix merge substates, leaving this stored value untouched.
   */
  inFlightAgentCount: number;
  /** ISO-8601 timestamp of last activity */
  lastActivityAt?: string;
  /** ISO-8601 timestamp of last error */
  lastErrorAt?: string;
  /** Last error message */
  lastErrorMessage?: string;
  /** Total completed tasks (cumulative) */
  totalTasksCompleted: number;
  /** Total failed tasks (cumulative) */
  totalTasksFailed: number;
  /** Rolling average task duration in milliseconds */
  averageTaskDurationMs?: number;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Activity log entry in the central unified feed */
export interface CentralActivityLogEntry {
  /** Unique entry ID */
  id: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Event type */
  type: ActivityEventType;
  /** Project ID this event belongs to */
  projectId: string;
  /** Project name (denormalized for display) */
  projectName: string;
  /** Task ID (optional) */
  taskId?: string;
  /** Task title (optional) */
  taskTitle?: string;
  /** Event details */
  details: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Global concurrency state across all projects */
export interface GlobalConcurrencyState {
  /** System-wide concurrent agent limit (default: 4) */
  globalMaxConcurrent: number;
  /**
   * FNXC:Concurrency 2026-06-26-18:34:
   * Persisted global slot bookkeeping maintained by acquire/release flows; it is not a live aggregate of project task stores.
   * Read surfaces that need current running-agent totals should aggregate live `column === "in-progress"` task counts while preserving slot limiter semantics and DB column names.
   */
  currentlyActive: number;
  /** Tasks waiting for concurrency slots */
  queuedCount: number;
  /** Per-project active agent counts */
  projectsActive: Record<string, number>;
}

/** A single question in the planning conversation flow */
export interface PlanningQuestion {
  id: string;
  type: PlanningQuestionType;
  question: string;
  description?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

/** The final summary generated after planning conversation completes */
export interface PlanningSummary {
  title: string;
  description: string;
  suggestedSize: "S" | "M" | "L";
  priority?: TaskPriority;
  suggestedDependencies: string[];
  keyDeliverables: string[];
}

/** Response from planning endpoints - either a question or the final summary */
export type PlanningResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: PlanningSummary };

/** Planning session state stored in memory */
export interface PlanningSession {
  id: string;
  ip: string;
  initialPlan: string;
  history: Array<{ question: PlanningQuestion; response: unknown }>;
  currentQuestion?: PlanningQuestion;
  summary?: PlanningSummary;
  /**
   * Optional per-session auto-merge override for tasks planned in this session.
   * Not separately persisted; durable form is a branch_groups row keyed by session id.
   */
  autoMerge?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Agent Types ────────────────────────────────────────────────────────────

/** Agent lifecycle states */
export const AGENT_STATES = ["idle", "active", "running", "paused", "error"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Valid state transitions for agents */
export const AGENT_VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["active"],
  active: ["idle", "running", "paused", "error"],
  running: ["idle", "active", "paused", "error"],
  paused: ["idle", "active"],
  error: ["idle", "active", "paused"],
};

/**
 * Detect if an agent is a runtime-created ephemeral/internal agent.
 * These agents are created by the engine for task execution/system workflows and should
 * typically be hidden from the default agents page listing.
 *
 * Detection heuristics (returns true if ANY match):
 * - `agent.metadata?.agentKind === "task-worker"` — task-worker agents from InProcessRuntime
 * - `agent.metadata?.taskWorker === true` — legacy task-worker marker
 * - `agent.metadata?.managedBy === "task-executor"` — executor-managed agents
 * - `agent.metadata?.type === "spawned"` — spawned child agents from TaskExecutor
 * - `agent.metadata?.internal === true` — explicitly internal/system agent marker
 * - Legacy fallback: executor role with name starting with "executor-" and no reportsTo
 * - Legacy fallback: executor role named "verification-agent" with no reportsTo
 *
 * @param agent - Agent object (partial shape accepted)
 * @returns true if the agent is an ephemeral/runtime-created/internal system agent
 */
export function isEphemeralAgent(
  agent: { metadata?: Record<string, unknown> | null; name?: string; role?: string; reportsTo?: string | null },
): boolean {
  const metadata = agent.metadata ?? {};

  // Check explicit metadata markers first
  if (metadata.agentKind === "task-worker") return true;
  if (metadata.taskWorker === true) return true;
  if (metadata.managedBy === "task-executor") return true;
  if (metadata.type === "spawned") return true;
  if (metadata.internal === true) return true;

  // Legacy fallback: executor agents with "executor-" prefix and no manager
  // These are task workers that were created before metadata was standardized
  if (
    agent.role === "executor" &&
    typeof agent.name === "string" &&
    agent.name.startsWith("executor-") &&
    agent.reportsTo == null
  ) {
    return true;
  }

  // Legacy internal system agent used by older verification flows.
  if (
    agent.role === "executor" &&
    agent.name === "verification-agent" &&
    agent.reportsTo == null
  ) {
    return true;
  }

  return false;
}

/**
 * Check if an agent has meaningful identity content (soul, instructions, or memory).
 * Agents with identity should run heartbeat sessions even without a task assignment,
 * so they can load their prompts and do useful ambient work.
 *
 * @param agent - Agent object (partial shape accepted, null/undefined returns false)
 * @returns true if the agent has any of: soul, instructionsText, instructionsPath, or memory with non-empty trimmed content
 */
export function hasAgentIdentity(
  agent: { soul?: string | null; instructionsText?: string | null; instructionsPath?: string | null; memory?: string | null } | null | undefined,
): boolean {
  if (!agent) return false;
  return !!(
    agent.soul?.trim() ||
    agent.instructionsText?.trim() ||
    agent.instructionsPath?.trim() ||
    agent.memory?.trim()
  );
}

/** Single heartbeat event recorded for an agent */
export interface AgentHeartbeatEvent {
  /** ISO-8601 timestamp of when the heartbeat was recorded */
  timestamp: string;
  /** Status of the heartbeat */
  status: "ok" | "missed" | "recovered";
  /** ID of the heartbeat run this event belongs to */
  runId: string;
}

/** What triggered a heartbeat run */
export type HeartbeatInvocationSource = "on_demand" | "timer" | "assignment" | "automation" | "routine";

/*
FNXC:AutomationTools 2026-06-26-00:00:
Dashboard source-checkout builds alias @fusion/core to this frontend-safe module, so mirror the automation AI-step tool catalog here as a runtime export for UI selectors.
*/
export const AUTOMATION_SELECTABLE_TOOLS = ["Read", "Bash", "Edit", "Write", "Grep", "Find", "Ls"] as const;

/** Snapshot of the last blocked state for a task, used for dedup comparison. */
export interface BlockedStateSnapshot {
  /** The task ID that was blocked */
  taskId: string;
  /** What the task was blocked by (dependency IDs, overlapping task ID) */
  blockedBy: string;
  /** ISO-8601 timestamp when this blocked state was recorded */
  recordedAt: string;
  /** Hash of relevant context at the time (comment count, last comment ID) */
  contextHash: string;
}

/** A continuous heartbeat session/run for an agent */
export interface AgentHeartbeatRun {
  /** Unique identifier for this run */
  id: string;
  /** ID of the agent this run belongs to */
  agentId: string;
  /** Task ID associated with this heartbeat run when bound to a task. */
  taskId?: string;
  /** ISO-8601 timestamp when the run started */
  startedAt: string;
  /** ISO-8601 timestamp when the run ended (null if active) */
  endedAt: string | null;
  /** Status of the run */
  status: "active" | "completed" | "terminated" | "failed";
  /** What triggered this run */
  invocationSource?: HeartbeatInvocationSource;
  /** Trigger detail (manual, ping, scheduler, system) */
  triggerDetail?: string;
  /** PID of the agent process */
  processPid?: number;
  /** Exit code of the agent process */
  exitCode?: number;
  /** Session ID before execution (for continuity tracking) */
  sessionIdBefore?: string;
  /** Session ID after execution */
  sessionIdAfter?: string;
  /** Token usage for this run */
  usageJson?: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number };
  /** Structured result from the run */
  resultJson?: Record<string, unknown>;
  /** Snapshot of context at run start (taskId, projectId, etc.).
   *  May include optional comment-wake fields:
   *  - `triggeringCommentIds?: string[]`
   *  - `triggeringCommentType?: "steering" | "task" | "pr"` */
  contextSnapshot?: Record<string, unknown>;
  /** Excerpt of stdout output */
  stdoutExcerpt?: string;
  /** Excerpt of stderr output */
  stderrExcerpt?: string;
  /** Full assembled system prompt sent to the LLM for this run (truncated to 100,000 chars). */
  systemPrompt?: string;
  /** Full per-tick execution prompt sent to the LLM for this run (truncated to 100,000 chars). */
  executionPrompt?: string;
  /** Whether the run used a custom heartbeat procedure, the built-in default, or the no-task default override. */
  heartbeatProcedureSource?: "default" | "custom" | "default-no-task-override";
}

/** Capabilities/roles an agent can have */
export type AgentCapability = "triage" | "executor" | "reviewer" | "merger" | "scheduler" | "engineer" | "custom";

/** A configurable agent role prompt template. */
export interface AgentPromptTemplate {
  /** Unique identifier (e.g., "default-executor", "senior-engineer") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of this template's behavioral style */
  description: string;
  /** The agent role this template applies to */
  role: AgentCapability;
  /** The system prompt content for this template */
  prompt: string;
  /** Whether this is a built-in template (true) or user-created (false) */
  builtIn?: boolean;
}

/** Configuration for per-agent prompts stored in project settings. */
export interface AgentPromptsConfig {
  /** Custom prompt templates. Built-in templates are always available. */
  templates?: AgentPromptTemplate[];
  /** Mapping from agent role to template ID.
   *  When set, overrides the default built-in prompt for that role.
   *  Key is the AgentCapability string, value is a template ID. */
  roleAssignments?: Partial<Record<AgentCapability, string>>;
}

// ── Plugin Activation Types ──────────────────────────────────────────────────

/**
 * Project-scoped plugin/extension activation event persisted in `plugin_activations`.
 * FNXC:CommandCenterEcosystem 2026-06-19-00:00:
 * Command Center Ecosystem uses these rows as the only source for Plugin activations; an absent row set means unavailable, not zero.
 */
export interface PluginActivation {
  id: number;
  pluginId: string;
  source: string;
  pluginVersion: string | null;
  activatedAt: string;
}

export interface PluginActivationInput {
  pluginId: string;
  source: string;
  pluginVersion?: string | null;
  activatedAt?: string;
}

// ── Run Audit Types ───────────────────────────────────────────────────────────

/** Domain categories for run-audit events.
 *  - "database": TaskStore mutations (task updates, comments, etc.)
 *  - "git": Git operations (commits, branches, merges)
 *  - "filesystem": File system mutations (file reads/writes, attachments)
 *  - "sandbox": Sandbox backend lifecycle events for user-configured command execution */
export type RunAuditDomain = "database" | "git" | "filesystem" | "sandbox";

export type RunAuditMutationType =
  | "mergeQueue:enqueue"
  | "mergeQueue:lease-acquired"
  | "mergeQueue:lease-released"
  | "mergeQueue:lease-expired"
  | "task:handoff"
  | "task:handoff-invariant-violation"
  | (string & {});

/** Input for recording a run-audit event. */
export interface RunAuditEventInput {
  /** ISO-8601 timestamp when the event occurred. Defaults to current time if not provided. */
  timestamp?: string;
  /** Task ID associated with this event (if applicable). */
  taskId?: string;
  /** Agent ID that performed the mutation. */
  agentId: string;
  /** Heartbeat run ID that initiated this mutation. */
  runId: string;
  /** The domain/category of the mutation. */
  domain: RunAuditDomain;
  /** Type of mutation (for example "task:update", "task:move", "task:handoff", "task:handoff-invariant-violation", "mergeQueue:enqueue", "git:commit", or "file:write"). */
  mutationType: RunAuditMutationType;
  /** Target of the mutation (e.g., task ID, file path, branch name). */
  target: string;
  /** Optional structured metadata about the mutation (compact, actionable data). */
  metadata?: Record<string, unknown>;
}

/** A persisted run-audit event record. */
export interface RunAuditEvent {
  /** Unique event identifier */
  id: string;
  /** ISO-8601 timestamp when the event occurred */
  timestamp: string;
  /** Task ID associated with this event (if applicable) */
  taskId?: string;
  /** Agent ID that performed the mutation */
  agentId: string;
  /** Heartbeat run ID that initiated this mutation */
  runId: string;
  /** The domain/category of the mutation */
  domain: RunAuditDomain;
  /** Type of mutation (e.g., "task:update", "git:commit", "file:write") */
  mutationType: RunAuditMutationType;
  /** Target of the mutation (e.g., task ID, file path, branch name) */
  target: string;
  /** Optional structured metadata about the mutation */
  metadata?: Record<string, unknown>;
}

/** Filter options for querying run-audit events. */
export interface RunAuditEventFilter {
  /** Filter by heartbeat run ID. */
  runId?: string;
  /** Filter by task ID. */
  taskId?: string;
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by domain. */
  domain?: RunAuditDomain;
  /** Filter by mutation type. */
  mutationType?: RunAuditMutationType;
  /** Start of time range (inclusive). */
  startTime?: string;
  /** End of time range (inclusive). */
  endTime?: string;
  /** Maximum number of events to return. */
  limit?: number;
}

// ── Agent Permission Types ──────────────────────────────────────────────────

/** Canonical permission identifiers for agent access control.
 *  Each string represents a discrete capability that can be granted or denied. */
export const AGENT_PERMISSIONS = [
  "tasks:assign", // Assign tasks to agents
  "tasks:create", // Create new tasks
  "tasks:execute", // Execute/run tasks
  "tasks:review", // Review task output (code, specs)
  "tasks:merge", // Merge completed task branches
  "tasks:delete", // Delete tasks
  "tasks:archive", // Archive/unarchive tasks
  "agents:create", // Create new agents
  "agents:update", // Update agent configuration
  "agents:delete", // Delete agents
  "agents:view", // View agent details and logs
  "settings:read", // Read project settings
  "settings:update", // Modify project settings
  "workflows:manage", // Create/edit/delete workflow steps
  "missions:manage", // Create/edit/delete missions and slices
  "automations:manage", // Create/edit/delete scheduled automations
  "messages:send", // Send messages to agents/users
  "messages:read", // Read mailbox messages
] as const;

/** A single canonical permission string. */
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/**
 * Canonical v1 action categories for permanent-agent runtime gating.
 *
 * `none` is a classifier-only result for positively-recognized read-only actions.
 * It is never stored as a policy rule key.
 */
export const PERMANENT_AGENT_ACTION_CATEGORIES = [
  "git_write",
  "file_write_delete",
  "command_execution",
  "network_api",
  "task_agent_mutation",
  "none",
] as const;

/** A single v1 permanent-agent action category. */
export type PermanentAgentActionCategory = (typeof PERMANENT_AGENT_ACTION_CATEGORIES)[number];

/** Sensitive runtime categories covered by policy rules (excludes classifier-only `none`). */
export type PermanentAgentSensitiveActionCategory = Exclude<PermanentAgentActionCategory, "none">;

/** Runtime action categories governed by agent permission policy presets. */
export const AGENT_PERMISSION_POLICY_ACTION_CATEGORIES: readonly PermanentAgentSensitiveActionCategory[] = [
  "git_write",
  "file_write_delete",
  "command_execution",
  "network_api",
  "task_agent_mutation",
] as const;

export const AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES: Record<
  PermanentAgentSensitiveActionCategory,
  readonly string[]
> = {
  git_write: ["git commit", "git push", "git merge", "git branch -d", "git worktree add", "write", "edit"],
  file_write_delete: ["write", "edit", "fn_task_attach"],
  command_execution: ["bash (non-git)", "fn_run_verification", "fn_acquire_repo_worktree", "read", "find", "grep", "ls"],
  network_api: ["fn_research_run (web/research)", "fn_research_cancel", "fn_web_fetch", "worktrunk_install"],
  /* FNXC:ToolGovernance 2026-06-27-16:51: Dashboard policy examples must mirror action-gate mutation exports. Identity reflection is exempt heartbeat coordination, so it is intentionally not advertised as task_agent_mutation.
   * FNXC:WorkflowAuthoringTools 2026-06-29-23:40: Published workflow authoring tools are now agent-visible, so policy examples include the mutating workflow create/update/delete/settings/select surface operators can approve or block. */
  task_agent_mutation: [
    "fn_task_create",
    "fn_delegate_task",
    "fn_task_import_github",
    "fn_task_import_github_issue",
    "fn_task_import_gitlab_project_issues",
    "fn_task_import_gitlab_group_issues",
    "fn_task_import_gitlab_merge_requests",
    "fn_task_browse_gitlab_project_issues",
    "fn_task_browse_gitlab_group_issues",
    "fn_task_browse_gitlab_merge_requests",
    "fn_spawn_agent",
    "fn_update_agent_config",
    "fn_task_update",
    "fn_workflow_create",
    "fn_workflow_update",
    "fn_workflow_delete",
    "fn_workflow_settings",
    "fn_workflow_select",
    "fn_task_promote",
    "fn_task_refine",
  ],
};

export const AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES: readonly string[] = [
  "fn_send_message",
  "fn_post_room_message",
  "fn_read_messages",
  "fn_task_log",
  "fn_task_done",
  "fn_heartbeat_done",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_trait_list",
  "fn_memory_search",
  "fn_memory_get",
  "fn_memory_append",
  "fn_read_evaluations",
  "fn_reflect_on_performance",
];

export const AGENT_PROVISIONING_APPROVAL_MODES = ["always", "trusted-only", "never"] as const;
export type AgentProvisioningApprovalMode = (typeof AGENT_PROVISIONING_APPROVAL_MODES)[number];

export const SECRET_ACCESS_POLICIES = ["auto", "prompt", "deny"] as const;
export type SecretAccessPolicy = (typeof SECRET_ACCESS_POLICIES)[number];

export const SANDBOX_PROVISIONING_APPROVAL_MODES = ["always", "trusted-only", "never"] as const;
export type SandboxProvisioningApprovalMode = (typeof SANDBOX_PROVISIONING_APPROVAL_MODES)[number];

/** A single runtime action category governed by permission policy. */
export type AgentPermissionPolicyActionCategory = PermanentAgentSensitiveActionCategory;
export type ApprovalRequestActionCategory =
  | AgentPermissionPolicyActionCategory
  | "agent_provisioning"
  | "sandbox_provisioning"
  | "secrets_access";

/** How a runtime action category is handled by permission policy. */
export type AgentPermissionPolicyDisposition = "allow" | "block" | "require-approval";

/** Exact tool-name permission overrides layered above category rules. */
export type AgentPermissionPolicyToolRules = Record<string, AgentPermissionPolicyDisposition>;

/** Minimum portable agent gating context consumed by engine runtime wrappers. The legacy name is retained for API compatibility, but the context applies to permanent identity agents and ephemeral task-worker agents. */
export interface PermanentAgentGatingContext {
  permissionPolicy?: {
    presetId: string;
    rules: Partial<Record<PermanentAgentSensitiveActionCategory, AgentPermissionPolicyDisposition>>;
    toolRules?: AgentPermissionPolicyToolRules;
  };
  requester?: ApprovalRequestActorSnapshot;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  createApprovalRequest?: (input: {
    category: AgentPermissionPolicyActionCategory;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<ApprovalRequest | null>;
  findPendingApprovalRequest?: (dedupeKey: string) => Promise<ApprovalRequest | null>;
}

/** Built-in permission policy preset identifiers for agent runtime policies. */
export const AGENT_PERMISSION_POLICY_PRESET_IDS = ["unrestricted", "approval-required", "locked-down", "custom"] as const;

/** A single built-in permission policy preset identifier. */
export type AgentPermissionPolicyPresetId = (typeof AGENT_PERMISSION_POLICY_PRESET_IDS)[number];

/** Canonical category->disposition map for a permission policy. */
export type AgentPermissionPolicyRules = Record<
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition
>;

/**
 * First-class persisted permission policy contract for permanent and ephemeral agents.
 *
 * FNXC:ToolPermissions 2026-07-01-00:00:
 * Operators must be able to block a single governed tool such as `fn_task_create` without blocking every task-agent mutation. `toolRules` stores exact tool-name overrides and the engine resolves them before category rules while leaving heartbeat-critical exempt tools non-configurable.
 */
export interface AgentPermissionPolicy {
  presetId: AgentPermissionPolicyPresetId;
  rules: AgentPermissionPolicyRules;
  toolRules?: AgentPermissionPolicyToolRules;
}

/** Approval request lifecycle statuses. */
export const APPROVAL_REQUEST_STATUSES = ["pending", "approved", "denied", "completed"] as const;

/** A single approval request lifecycle status. */
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

/** Append-only audit event types for approval requests. */
export const APPROVAL_REQUEST_AUDIT_EVENT_TYPES = [
  "created",
  "approved",
  "denied",
  "completed",
] as const;

/** A single append-only audit event type for approval requests. */
export type ApprovalRequestAuditEventType = (typeof APPROVAL_REQUEST_AUDIT_EVENT_TYPES)[number];

/** Immutable actor identity snapshot captured at request/audit event time. */
export interface ApprovalRequestActorSnapshot {
  actorId: string;
  actorType: "agent" | "user" | "system";
  actorName: string;
}

/** Legacy action-category aliases accepted for backward compatibility. */
export const LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES = [
  "file_write",
  "file_delete",
  "command_execute",
  "network_access",
  "task_mutation",
  "agent_mutation",
] as const;

export type LegacyAgentPermissionPolicyActionCategory =
  (typeof LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES)[number];

/** Canonical + compatibility action-category input accepted at boundaries. */
export type ApprovalRequestActionCategoryInput =
  | ApprovalRequestActionCategory
  | LegacyAgentPermissionPolicyActionCategory;

/** Normalize legacy action-category aliases to canonical v1 categories. */
export function normalizeApprovalRequestActionCategory(
  category: ApprovalRequestActionCategoryInput,
): ApprovalRequestActionCategory {
  switch (category) {
    case "file_write":
    case "file_delete":
      return "file_write_delete";
    case "command_execute":
      return "command_execution";
    case "network_access":
      return "network_api";
    case "task_mutation":
    case "agent_mutation":
      return "task_agent_mutation";
    case "agent_provisioning":
      return "agent_provisioning";
    case "sandbox_provisioning":
      return "sandbox_provisioning";
    case "secrets_access":
      return "secrets_access";
    default:
      return category;
  }
}

/** Action payload gated by an approval request. */
export interface ApprovalRequestTargetAction {
  category: ApprovalRequestActionCategory;
  action: string;
  summary: string;
  resourceType: string;
  resourceId: string;
  context?: Record<string, unknown>;
}

/** Append-only audit event row for approval request history. */
export interface ApprovalRequestAuditEvent {
  id: string;
  requestId: string;
  eventType: ApprovalRequestAuditEventType;
  actor: ApprovalRequestActorSnapshot;
  note?: string;
  createdAt: string;
}

/** Durable approval request record used by engine and dashboard surfaces. */
export interface ApprovalRequest {
  id: string;
  status: ApprovalRequestStatus;
  requester: ApprovalRequestActorSnapshot;
  targetAction: ApprovalRequestTargetAction;
  taskId?: string;
  runId?: string;
  requestedAt: string;
  decidedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Create input for a new pending approval request. */
export interface ApprovalRequestCreateInput {
  requester: ApprovalRequestActorSnapshot;
  targetAction: Omit<ApprovalRequestTargetAction, "category"> & {
    category: ApprovalRequestActionCategoryInput;
  };
  taskId?: string;
  runId?: string;
}

/** Input for pending->approved / pending->denied decisions. */
export interface ApprovalRequestDecisionInput {
  actor: ApprovalRequestActorSnapshot;
  note?: string;
}

/** Input for approved->completed transition. */
export interface ApprovalRequestCompletionInput {
  actor: ApprovalRequestActorSnapshot;
  note?: string;
}

/** Query filters for approval request listings. */
export interface ApprovalRequestListInput {
  status?: ApprovalRequestStatus;
  requesterActorId?: string;
  taskId?: string;
  runId?: string;
  limit?: number;
  offset?: number;
}

/** True when a transition is valid for approval request lifecycle rules. */
export function isValidApprovalRequestTransition(
  from: ApprovalRequestStatus,
  to: ApprovalRequestStatus,
): boolean {
  if (from === to) {
    return true;
  }
  if (from === "pending") {
    return to === "approved" || to === "denied";
  }
  if (from === "approved") {
    return to === "completed";
  }
  return false;
}

/** Describes how an agent's task assignment capability was determined. */
export type TaskAssignSource =
  | "role_default" // Granted automatically by role (e.g., scheduler gets tasks:assign)
  | "explicit_grant" // Explicitly granted via permissions field
  | "denied"; // Not granted by any source

/** Computed access state for an agent, derived from its role and permissions. */
export interface AgentAccessState {
  /** The agent ID this access state belongs to. */
  agentId: string;
  /** Whether this agent can assign tasks to other agents. */
  canAssignTasks: boolean;
  /** How the tasks:assign permission was determined. */
  taskAssignSource: TaskAssignSource;
  /** Whether this agent can create new agents. */
  canCreateAgents: boolean;
  /** Whether this agent can execute tasks. */
  canExecuteTasks: boolean;
  /** Whether this agent can review task output. */
  canReviewTasks: boolean;
  /** Whether this agent can merge task branches. */
  canMergeTasks: boolean;
  /** Whether this agent can delete agents. */
  canDeleteAgents: boolean;
  /** Whether this agent can manage missions. */
  canManageMissions: boolean;
  /** Whether this agent can send messages. */
  canSendMessages: boolean;
  /** Full set of resolved permissions (union of role defaults + explicit grants). */
  resolvedPermissions: Set<AgentPermission>;
  /** Permissions explicitly granted on this agent (from the permissions field). */
  explicitPermissions: Set<AgentPermission>;
  /** Permissions granted by role default (not explicitly set). */
  roleDefaultPermissions: Set<AgentPermission>;
}

/** Agent record stored in the system */
export interface Agent {
  /** Unique identifier (e.g., "agent-001") */
  id: string;
  /** Display name */
  name: string;
  /** Role/capability of the agent */
  role: AgentCapability;
  /** Current lifecycle state */
  state: AgentState;
  /** ID of the task this agent is currently working on (if any) */
  taskId?: string;
  /** ISO-8601 timestamp when the agent was created */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** ISO-8601 timestamp of last successful heartbeat */
  lastHeartbeatAt?: string;
  /** Optional metadata */
  metadata: Record<string, unknown>;
  /** Job title / description for the agent */
  title?: string;
  /** Custom icon identifier */
  icon?: string;
  /** Uploaded avatar image URL */
  imageUrl?: string;
  /** Agent ID this agent reports to (org hierarchy) */
  reportsTo?: string;
  /** Runtime configuration. Supports: AgentHeartbeatConfig keys (heartbeatIntervalMs, heartbeatTimeoutMs, maxConcurrentRuns) */
  runtimeConfig?: Record<string, unknown>;
  /** Why the agent was paused (error, manual, etc.) */
  pauseReason?: string;
  /** Capability permission flags */
  permissions?: Record<string, boolean>;
  /** Runtime action gating policy (preset + normalized category rules). */
  permissionPolicy?: AgentPermissionPolicy;
  /** Cumulative input tokens across all runs */
  totalInputTokens?: number;
  /** Cumulative output tokens across all runs */
  totalOutputTokens?: number;
  /** Last error message */
  lastError?: string;
  /** Number of currently pending approvals requested by this agent. */
  pendingApprovalCount?: number;
  /**
   * FNXC:AgentTaskStateDrift 2026-06-27-16:20:
   * Dashboard/API responses need a transient linked-task column so coordinators can distinguish legitimate parked/active agent linkages from execution drift; unresolved lookups use the response-only "unresolved" sentinel. This is resolved per request and must not be persisted by AgentStore.
   */
  taskColumn?: string;
  /** Path to a markdown file containing custom instructions (resolved relative to project root).
   *  Must end in `.md`, no `..` traversal. Max 500 chars. */
  instructionsPath?: string;
  /** Inline custom instructions appended to the agent's system prompt at execution time. Max 50,000 chars. */
  instructionsText?: string;
  /** Agent personality/identity description — defines the agent's character, tone, and behavioral traits. Max 10,000 chars. */
  soul?: string;
  /** Per-agent accumulated knowledge — stores learnings, preferences, and context the agent has gathered. Max 50,000 chars. */
  memory?: string;
  /** Structured instruction bundle configuration for managed/external markdown files. */
  bundleConfig?: InstructionsBundleConfig;
  /** Optional path to a markdown file containing this agent's per-tick heartbeat procedure
   *  (overrides the default HEARTBEAT_PROCEDURE constant). Resolved relative to project root.
   *  Must end in `.md`, no `..` traversal. Max 500 chars. */
  heartbeatProcedurePath?: string;
}

/** Recursive node in the agent org tree. */
export interface OrgTreeNode {
  agent: Agent;
  children: OrgTreeNode[];
}

export type MessageResponseMode = "immediate" | "on-heartbeat";

/** Per-agent heartbeat configuration, stored in agent.runtimeConfig */
export interface AgentHeartbeatConfig {
  /** Whether heartbeat triggers are enabled for this agent (default: true) */
  enabled?: boolean;
  /** Whether this agent should auto-claim relevant unowned tasks during no-task heartbeats (default: true when unset). */
  autoClaimRelevantTasks?: boolean;
  /** Number of auto-claim candidates to inject into no-task heartbeat prompts. Default: 5, range: 0-10. */
  autoClaimCandidatesInPrompt?: number;
  /** Per-agent override for opting engineer-role agents into no-task backlog auto-claim. Default: project setting or false. */
  engineerBacklogAutoClaim?: boolean;
  /** Polling interval in ms (default: 30000). Min: 1000 */
  heartbeatIntervalMs?: number;
  /** Heartbeat timeout in ms (default: 60000). Min: 5000 */
  heartbeatTimeoutMs?: number;
  /** Max concurrent heartbeat runs per agent (default: 1). Min: 1 */
  maxConcurrentRuns?: number;
  /** Whether periodic self-improvement is enabled (default: true) */
  selfImproveEnabled?: boolean;
  /** Interval between self-improvement cycles in ms (default: 14400000 = 4h). Min: 3600000 (1h) */
  selfImproveIntervalMs?: number;
  /** ISO timestamp of last self-improvement run */
  lastSelfImproveAt?: string;
  /**
   * How this agent responds to incoming messages.
   * "immediate" triggers a heartbeat run when a message arrives.
   * "on-heartbeat" defers message handling to the next scheduled heartbeat (default).
   */
  messageResponseMode?: MessageResponseMode;
  /** Per-agent budget governance configuration. When set, enables budget tracking and enforcement. */
  budgetConfig?: AgentBudgetConfig;
  /** Per-agent override for memory prompt inclusion mode. */
  agentMemoryInclusionMode?: AgentMemoryInclusionMode;
  /** Per-agent override for heartbeat scope-discipline procedure mode. */
  heartbeatScopeDiscipline?: HeartbeatScopeDisciplineMode;
  /** Per-agent override for heartbeat execution prompt template mode. */
  heartbeatPromptTemplate?: HeartbeatPromptTemplate;
  /** Last resolved memory inclusion mode recorded by engine for transition logging. */
  lastAgentMemoryInclusionMode?: AgentMemoryInclusionMode;
  /**
   * When true, the engine fires a catch-up heartbeat at server startup if the
   * agent's last heartbeat is older than its interval — i.e., the server was
   * down across a scheduled tick. Default: false.
   */
  runMissedHeartbeatOnStartup?: boolean;
  /**
   * When true (default), an agent's heartbeat runs and its task execution session can run
   * concurrently. When false, the two paths serialize: a heartbeat will not start while the
   * agent's bound task has an active executor session, and an executor session will not start
   * while the agent has an active heartbeat run.
   *
   * Permanent agents only — ignored for ephemeral agents. Default: true when unset.
   */
  allowParallelExecution?: boolean;
  /**
   * When true, timer-triggered heartbeats are skipped while the agent has no currently assigned
   * task (`agent.taskId` is unset). Assignment and on-demand triggers are unaffected.
   * Default: false (timer fires regardless of assignment).
   */
  skipHeartbeatWhenIdle?: boolean;
}

/** Per-agent budget configuration, stored in agent.runtimeConfig.budgetConfig */
export interface AgentBudgetConfig {
  /** Total token cap (input + output). When undefined, no budget limit is enforced. */
  tokenBudget?: number;
  /** Warning threshold as a fraction (0–1). Default: 0.8. Triggers isOverThreshold when usagePercent >= this value * 100. */
  usageThreshold?: number;
  /** Budget accumulation period. Default: "lifetime". */
  budgetPeriod?: "daily" | "weekly" | "monthly" | "lifetime";
  /** Day of month/week for period reset (1–31 for monthly, 0–6 for weekly where 0=Sunday). Only used when budgetPeriod is "monthly" or "weekly". */
  resetDay?: number;
}

/** Computed budget status for an agent at a point in time. */
export interface AgentBudgetStatus {
  /** The agent this status belongs to */
  agentId: string;
  /** Total tokens consumed (input + output) */
  currentUsage: number;
  /** Token cap from config, or null when no budget is configured */
  budgetLimit: number | null;
  /** Usage as a percentage of budget (0–100), or null when no budget */
  usagePercent: number | null;
  /** The configured threshold fraction (e.g., 0.8), or null when no budget */
  thresholdPercent: number | null;
  /** Whether currentUsage >= budgetLimit */
  isOverBudget: boolean;
  /** Whether usagePercent >= thresholdPercent * 100 */
  isOverThreshold: boolean;
  /** ISO-8601 timestamp of the last budget reset, or null */
  lastResetAt: string | null;
  /** ISO-8601 timestamp of the next scheduled reset, or null for lifetime/no budget */
  nextResetAt: string | null;
}

/** Configuration for an agent's instruction bundle — a collection of markdown files
 *  that together form the agent's custom instructions. */
export interface InstructionsBundleConfig {
  /** Bundle mode — "managed" = system-managed directory, "external" = user-specified path */
  mode: "managed" | "external";
  /** Primary instructions file name (default: "AGENTS.md") */
  entryFile: string;
  /** List of all file names in the bundle directory */
  files: string[];
  /** User-specified directory path for external mode (required when mode is "external") */
  externalPath?: string;
}

/** Extended agent information including heartbeat history */
export interface AgentDetail extends Agent {
  /** Recent heartbeat events (last N events) */
  heartbeatHistory: AgentHeartbeatEvent[];
  /** Current active heartbeat run (if any) */
  activeRun?: AgentHeartbeatRun;
  /** All completed runs for this agent */
  completedRuns: AgentHeartbeatRun[];
}

/** Input for creating a new agent */
export interface AgentCreateInput {
  name: string;
  role: AgentCapability;
  metadata?: Record<string, unknown>;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
}

/** Input for updating an existing agent */
export interface AgentUpdateInput {
  name?: string;
  role?: AgentCapability;
  metadata?: Record<string, unknown>;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  pauseReason?: string;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  lastError?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
}

/** An API key associated with an agent for bearer token authentication. */
export interface AgentApiKey {
  /** Unique key identifier (e.g., "key-a1b2c3d4") */
  id: string;
  /** The agent this key belongs to */
  agentId: string;
  /** SHA-256 hash of the plaintext token (hex-encoded, 64 chars) */
  tokenHash: string;
  /** Optional human-readable label for the key */
  label?: string;
  /** ISO-8601 timestamp when the key was created */
  createdAt: string;
  /** ISO-8601 timestamp when the key was revoked, null if active */
  revokedAt?: string;
}

/** Result returned when creating a new API key — includes the plaintext token exactly once. */
export interface AgentApiKeyCreateResult {
  /** The persisted key metadata (不含 plaintext token) */
  key: AgentApiKey;
  /** The plaintext token — shown only at creation, never stored */
  token: string;
}

/** Per-task session persistence for an agent */
export interface AgentTaskSession {
  /** Agent ID */
  agentId: string;
  /** Task ID */
  taskId: string;
  /** Session state for resuming context across runs */
  sessionParams: Record<string, unknown>;
  /** Human-readable session identifier */
  sessionDisplayId?: string;
  /** ISO-8601 timestamp when session was created */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** A single performance rating for an agent */
export interface AgentRating {
  id: string;
  agentId: string;
  raterType: "user" | "agent" | "system";
  raterId?: string;
  score: number;
  category?: string;
  comment?: string;
  runId?: string;
  taskId?: string;
  createdAt: string;
}

/** Aggregated rating statistics for an agent */
export interface AgentRatingSummary {
  agentId: string;
  averageScore: number;
  totalRatings: number;
  categoryAverages: Record<string, number>;
  recentRatings: AgentRating[];
  trend: "improving" | "declining" | "stable" | "insufficient-data";
}

/** Input payload for creating an agent rating */
export interface AgentRatingInput {
  raterType: "user" | "agent" | "system";
  raterId?: string;
  score: number;
  category?: string;
  comment?: string;
  runId?: string;
  taskId?: string;
}

/** Trackable configuration fields for revision history.
 *  Excludes budget-related items, state, taskId, token counts, and timestamps. */
export interface AgentConfigSnapshot {
  name: string;
  role: AgentCapability;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
  metadata: Record<string, unknown>;
}

/** A single key-value change within a config revision */
export interface RevisionFieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** A revision entry recording a configuration change to an agent */
export interface AgentConfigRevision {
  /** Unique revision identifier */
  id: string;
  /** Agent ID this revision belongs to */
  agentId: string;
  /** ISO-8601 timestamp when the revision was created */
  createdAt: string;
  /** Snapshot of config BEFORE the change */
  before: AgentConfigSnapshot;
  /** Snapshot of config AFTER the change */
  after: AgentConfigSnapshot;
  /** Field-level diffs between before and after */
  diffs: RevisionFieldDiff[];
  /** Description of what changed (e.g., "Updated runtimeConfig, name") */
  summary: string;
  /** Who or what triggered the change */
  source: "user" | "system" | "rollback";
  /** If this was a rollback, the revision ID that was restored */
  rollbackToRevisionId?: string;
}

/**
 * Legacy project-relative shared path for the heartbeat procedure markdown
 * file. Older builds defaulted every non-ephemeral agent to this single
 * file, which prevented per-agent customization. New code should use
 * {@link getDefaultHeartbeatProcedurePath} instead. This constant is kept
 * exported only so migrations can detect agents still pointing at the
 * shared path and re-route them to their own per-agent file.
 *
 * @deprecated Use {@link getDefaultHeartbeatProcedurePath} for new agent
 *   creation and upgrade flows.
 */
export const DEFAULT_HEARTBEAT_PROCEDURE_PATH = ".fusion/HEARTBEAT.md";

function slugifyAgentAssetSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getSafeAgentAssetIdSegment(agentId: string): string {
  const slug = slugifyAgentAssetSegment(agentId);
  return slug || "agent";
}

/**
 * Compute the canonical per-agent asset directory segment.
 *
 * Canonical format: `<slugged-display-name>-<safe-agent-id>`.
 * Example: `CEO` + `agent2736` => `ceo-agent2736`.
 *
 * If the display-name slug is empty (for example name has only symbols), the
 * id-derived segment is used as the directory prefix so the result is always
 * filesystem-safe and non-empty.
 */
export function getCanonicalAgentAssetDirectoryName(agentName: string, agentId: string): string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("getCanonicalAgentAssetDirectoryName requires a non-empty agentId");
  }
  const safeId = getSafeAgentAssetIdSegment(agentId);
  const nameSlug = slugifyAgentAssetSegment(agentName ?? "");
  const prefix = nameSlug || safeId;
  return `${prefix}-${safeId}`;
}

/** Legacy per-agent asset directory segment used by older builds. */
export function getLegacyAgentAssetDirectoryName(agentId: string): string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("getLegacyAgentAssetDirectoryName requires a non-empty agentId");
  }
  return agentId;
}

/** Canonical managed instruction bundle directory name for an agent. */
export function getCanonicalAgentInstructionsBundleDirName(agentName: string, agentId: string): string {
  return `${getCanonicalAgentAssetDirectoryName(agentName, agentId)}-instructions`;
}

/** Legacy managed instruction bundle directory name used by older builds. */
export function getLegacyAgentInstructionsBundleDirName(agentId: string): string {
  return `${getLegacyAgentAssetDirectoryName(agentId)}-instructions`;
}

/**
 * Compute the project-relative default heartbeat procedure file path for a
 * given agent. Each agent gets their own editable HEARTBEAT.md so operators
 * can tune the per-tick procedure without changes leaking across the team.
 *
 * The path is laid out under `.fusion/agents/<canonical-agent-dir>/HEARTBEAT.md`.
 */
export function getDefaultHeartbeatProcedurePath(agentId: string, agentName?: string): string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("getDefaultHeartbeatProcedurePath requires a non-empty agentId");
  }
  const directory = agentName
    ? getCanonicalAgentAssetDirectoryName(agentName, agentId)
    : getLegacyAgentAssetDirectoryName(agentId);
  return `.fusion/agents/${directory}/HEARTBEAT.md`;
}

/** Extract trackable config fields from an Agent into a snapshot */
export function agentToConfigSnapshot(agent: Agent): AgentConfigSnapshot {
  return {
    name: agent.name,
    role: agent.role,
    title: agent.title,
    icon: agent.icon,
    imageUrl: agent.imageUrl,
    reportsTo: agent.reportsTo,
    runtimeConfig: agent.runtimeConfig ? { ...agent.runtimeConfig } : undefined,
    permissions: agent.permissions ? { ...agent.permissions } : undefined,
    permissionPolicy: agent.permissionPolicy
      ? {
          presetId: agent.permissionPolicy.presetId,
          rules: { ...agent.permissionPolicy.rules },
          ...(agent.permissionPolicy.toolRules ? { toolRules: { ...agent.permissionPolicy.toolRules } } : {}),
        }
      : undefined,
    instructionsPath: agent.instructionsPath,
    instructionsText: agent.instructionsText,
    soul: agent.soul,
    memory: agent.memory,
    bundleConfig: agent.bundleConfig
      ? {
          ...agent.bundleConfig,
          files: [...agent.bundleConfig.files],
        }
      : undefined,
    heartbeatProcedurePath: agent.heartbeatProcedurePath,
    metadata: { ...agent.metadata },
  };
}

/** Compare two config snapshots and return field-level diffs */
export function diffConfigSnapshots(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): RevisionFieldDiff[] {
  const trackedFields: Array<keyof AgentConfigSnapshot> = [
    "name",
    "role",
    "title",
    "icon",
    "imageUrl",
    "reportsTo",
    "runtimeConfig",
    "permissions",
    "permissionPolicy",
    "instructionsPath",
    "instructionsText",
    "soul",
    "memory",
    "bundleConfig",
    "heartbeatProcedurePath",
    "metadata",
  ];

  const diffs: RevisionFieldDiff[] = [];

  for (const field of trackedFields) {
    const oldVal = before[field];
    const newVal = after[field];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }

  return diffs;
}

/** Aggregate statistics for agents */
export interface AgentStats {
  /** Number of agents in active/running state */
  activeCount: number;
  /** Number of tasks assigned to agents */
  assignedTaskCount: number;
  /** Total completed runs */
  completedRuns: number;
  /** Total failed runs */
  failedRuns: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Number of idle non-ephemeral agents available for queue drain */
  idleNonEphemeralCount: number;
  /** Number of tasks currently in the todo column */
  todoTaskCount: number;
}

/** Trigger source for an agent self-reflection run */
export type ReflectionTrigger = "periodic" | "post-task" | "manual" | "user-requested";

/** Quantitative snapshot captured by a reflection */
export interface ReflectionMetrics {
  /** Tasks completed in the analysis window */
  tasksCompleted?: number;
  /** Tasks failed in the analysis window */
  tasksFailed?: number;
  /** Average task duration in milliseconds */
  avgDurationMs?: number;
  /** Total tokens consumed in the analysis window */
  totalTokensUsed?: number;
  /** Number of errors encountered */
  errorCount?: number;
  /** Recurring error patterns */
  commonErrors?: string[];
}

/** A persisted self-reflection generated by an agent */
export interface AgentReflection {
  /** Unique reflection ID */
  id: string;
  /** The agent this reflection belongs to */
  agentId: string;
  /** ISO-8601 timestamp when the reflection was created */
  timestamp: string;
  /** What caused this reflection */
  trigger: ReflectionTrigger;
  /** Optional trigger detail context */
  triggerDetail?: string;
  /** Associated task ID (for post-task reflections) */
  taskId?: string;
  /** Quantitative reflection metrics */
  metrics: ReflectionMetrics;
  /** Key observations from self-analysis */
  insights: string[];
  /** Suggested improvements for future runs */
  suggestedImprovements: string[];
  /** One-paragraph narrative summary */
  summary: string;
}

/** Aggregated performance summary derived from recent reflections */
export interface AgentPerformanceSummary {
  /** Agent identifier */
  agentId: string;
  /** Total tasks completed in the analysis window */
  totalTasksCompleted: number;
  /** Total tasks failed in the analysis window */
  totalTasksFailed: number;
  /** Average task duration in milliseconds */
  avgDurationMs: number;
  /** Success ratio from 0 to 1 */
  successRate: number;
  /** Top recurring errors */
  commonErrors: string[];
  /** Derived strengths from successful patterns */
  strengths: string[];
  /** Derived weaknesses from failure patterns */
  weaknesses: string[];
  /** Number of reflections considered in this summary */
  recentReflectionCount: number;
  /** ISO-8601 timestamp when summary was computed */
  computedAt: string;
}

// ── Multi-Project First-Run & Migration Types ───────────────────────────────

/** Detected project for migration consideration */
export interface DetectedProject {
  /** Absolute path to project directory */
  path: string;
  /** Auto-generated or derived project name */
  name: string;
  /** Whether the project has a valid fusion.db */
  hasDb: boolean;
  /** Persisted project identity id if present */
  identityId?: string;
}

/** Setup state for the first-run wizard UI */
export interface SetupState {
  /** Whether this is a first-run scenario (no projects registered) */
  isFirstRun: boolean;
  /** Whether any projects were detected on the filesystem */
  hasDetectedProjects: boolean;
  /** Projects detected on filesystem for potential registration */
  detectedProjects: DetectedProject[];
  /** Projects already registered in the central database */
  registeredProjects: RegisteredProject[];
  /** Recommended action based on current state */
  recommendedAction: "auto-detect" | "create-new" | "manual-setup";
  /** Local identities whose central rows are missing */
  orphanIdentities?: Array<{ path: string; identityId: string }>;
}

/** Input for setting up a project via the wizard */
export interface ProjectSetupInput {
  /** Project path */
  path: string;
  /** Display name */
  name: string;
  /** Isolation mode preference */
  isolationMode?: "in-process" | "child-process";
  /** Persisted local identity for central re-attachment */
  identity?: { id: string; createdAt: string } | null;
}

/** Result of completing the first-run setup */
export interface SetupCompletionResult {
  /** Whether the setup completed successfully */
  success: boolean;
  /** Projects that were registered */
  projects: RegisteredProject[];
  /** Recommended next steps for the user */
  nextSteps: string[];
}

/** Options for running a migration */
export interface MigrationOptions {
  /** Path to start scanning for projects (default: process.cwd()) */
  startPath?: string;
  /** Maximum recursion depth for scanning (default: 5) */
  maxDepth?: number;
  /** Whether to simulate without making changes */
  dryRun?: boolean;
  /** Whether to auto-register detected projects */
  autoRegister?: boolean;
  /** Progress callback for long-running operations */
  onProgress?: (current: number, total: number, path: string) => void;
}

/** Result of a migration operation (from MigrationOrchestrator) */
export interface MigrationResult {
  /** Projects detected during scanning */
  projectsDetected: DetectedProject[];
  /** Projects that were registered */
  projectsRegistered: RegisteredProject[];
  /** Projects that were skipped with reasons */
  projectsSkipped: Array<{ path: string; reason: string }>;
  /** Errors encountered during migration */
  errors: Array<{ path: string; error: string }>;
}

// ── Messaging Types ──────────────────────────────────────────────────────────

/** Participant types for message routing */
export type ParticipantType = "agent" | "user" | "system";

/** Canonical recipient ID for dashboard user mailbox routing. */
export const DASHBOARD_USER_ID = "dashboard";

const DASHBOARD_USER_ALIASES = new Set([DASHBOARD_USER_ID, "user", "user:dashboard", "User: user:dashboard"]);

/** Normalize participant identity for durable mailbox routing. */
export function normalizeMessageParticipant(id: string, type: ParticipantType): { id: string; type: ParticipantType } {
  if (type !== "user") {
    return { id, type };
  }

  if (DASHBOARD_USER_ALIASES.has(id)) {
    return { id: DASHBOARD_USER_ID, type };
  }

  return { id, type };
}

/** Message types/categories */
export type MessageType = "agent-to-agent" | "agent-to-user" | "user-to-agent" | "system";

/** Stable metadata contract for linking a reply to an earlier message. */
export interface MessageReplyReference {
  /** ID of the message this one is replying to. */
  messageId: string;
}

/** Optional metadata attached to mailbox messages. */
export interface MessageMetadata extends Record<string, unknown> {
  /** Optional link to the original message when this message is a reply. */
  replyTo?: MessageReplyReference;
  /**
   * If true, the recipient agent is woken immediately on receipt regardless
   * of their own `messageResponseMode` setting. Sender-initiated override —
   * use sparingly for urgent messages. Ignored when recipient is a user.
   */
  wakeRecipient?: boolean;
}

/** Message record stored in the system */
export interface Message {
  /** Unique identifier */
  id: string;
  /** Sender identifier */
  fromId: string;
  /** Sender type */
  fromType: ParticipantType;
  /** Recipient identifier */
  toId: string;
  /** Recipient type */
  toType: ParticipantType;
  /** Message body */
  content: string;
  /** Message category */
  type: MessageType;
  /** Whether the recipient has read this message */
  read: boolean;
  /** Optional extra data */
  metadata?: MessageMetadata;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input for creating a new message */
export interface MessageCreateInput {
  /** Sender identifier (auto-filled by the transport layer if omitted) */
  fromId?: string;
  /** Sender type (auto-filled by the transport layer if omitted) */
  fromType?: ParticipantType;
  /** Recipient identifier */
  toId: string;
  /** Recipient type */
  toType: ParticipantType;
  /** Message body */
  content: string;
  /** Message category */
  type: MessageType;
  /** Optional extra data */
  metadata?: MessageMetadata;
}

/** Filter options for querying messages */
export interface MessageFilter {
  /** Filter by message type */
  type?: MessageType;
  /** Filter by read status */
  read?: boolean;
  /** Maximum number of messages to return */
  limit?: number;
  /** Number of messages to skip (for pagination) */
  offset?: number;
}

/** Validate mailbox metadata, including reply-link contract when present. */
export function validateMessageMetadata(metadata: MessageMetadata | undefined): void {
  if (!metadata) {
    return;
  }

  if (metadata.replyTo !== undefined) {
    if (typeof metadata.replyTo !== "object" || metadata.replyTo === null || Array.isArray(metadata.replyTo)) {
      throw new Error("metadata.replyTo must be an object");
    }

    if (typeof metadata.replyTo.messageId !== "string" || metadata.replyTo.messageId.trim().length === 0) {
      throw new Error("metadata.replyTo.messageId must be a non-empty string");
    }
  }

  if (metadata.wakeRecipient !== undefined && typeof metadata.wakeRecipient !== "boolean") {
    throw new Error("metadata.wakeRecipient must be a boolean");
  }
}

/** Mailbox summary for a participant */
export interface Mailbox {
  /** Owner identifier */
  ownerId: string;
  /** Owner type */
  ownerType: ParticipantType;
  /** Number of unread messages */
  unreadCount: number;
  /** Most recent message (if any) */
  lastMessage?: Message;
}


// Re-export PROMPT_KEY_CATALOG for backward compatibility with vite alias
export { PROMPT_KEY_CATALOG } from "./prompt-overrides.js";

// Re-exported here so the dashboard's `@fusion/core` → types.ts alias resolves
// client-side consumers (see packages/dashboard/vite.config.ts).
export { getErrorMessage } from "./error-message.js";
export {
  resolveExecutionSettingsModel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveTitleSummarizerSettingsModel,
  resolveValidatorSettingsModel,
} from "./model-resolution.js";
export type { ResolvedModelSelection } from "./model-resolution.js";
export { resolveResearchSettings } from "./research-settings.js";
export type { ResolvedResearchSettings } from "./research-settings.js";
