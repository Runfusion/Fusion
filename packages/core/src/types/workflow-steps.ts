/**
 * Workflow step templates, run instances, notifications, and model-preset types.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts; re-exported from the browser-safe types barrel.
 */

import type { ThinkingLevel } from "./board.js";

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
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Workflow IR nodes may pin reasoning effort independently from the model pair so authors can inherit the model while overriding thinking level. Runtime precedence is node/step `thinkingLevel` > task `thinkingLevel` > settings `defaultThinkingLevel`.
   */
  thinkingLevel?: ThinkingLevel;
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
  /**
   * FNXC:ProviderAuth 2026-07-08-00:00:
   * FN-7689: opt-in for custom `openai-compatible`/`openai-responses` gateways that proxy an
   * Anthropic-format backend (e.g. `usai/claude_4_6_sonnet`). When true, registered
   * `openai-completions` models get pi-ai's `compat.cacheControlFormat = "anthropic"`, which makes
   * pi-ai emit Anthropic-style `cache_control` breakpoints on the system prompt, last
   * conversation message, and last tool. Without this, pi-ai's `detectCompat` only auto-enables
   * caching for OpenRouter `anthropic/*` models, so a generic custom gateway re-bills the entire
   * context prefix uncached every turn (measured cachedTokens=0/cacheWriteTokens=0 across 243
   * runs, ~327.5:1 input:output ratio). Default off — never force cache_control on gateways that
   * did not opt in, since non-Anthropic-compatible backends (Together, Fireworks, etc.) can 400 on
   * unexpected `cache_control` fields. Inert for `anthropic-compatible` (already auto-caches) and
   * `google-generative-ai` (no cache_control concept).
   */
  anthropicPromptCaching?: boolean;
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
  /** Optional per-node reasoning-effort override; inherits from task/settings when omitted. */
  thinkingLevel?: ThinkingLevel;
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
  /*
   * FNXC:PlanReviewLease 2026-07-18-23:20:
   * U3 / KTD-4 — a `pending` review-gate result is a LEASE. `leaseOwner` records
   * the session/run id that claimed the gate; `startedAt` is the lease clock. The
   * graph's plan-review dedup honors a live lease (adopt/skip re-dispatch) and
   * reclaims only past the staleness floor via compare-and-set, so a crash/restart
   * mid-review can never dispatch a second reviewer (the FN-1315-shaped duplicate
   * "Starting workflow step: Plan Review" race). Absent on non-leased results and
   * on every terminal (passed/failed/…) record — a lease only exists while pending.
   */
  leaseOwner?: string;
  /*
   * FNXC:ReviewLaneBypass 2026-07-09-00:00:
   * A privileged operator can bypass a `status:"failed"` pre-merge review step
   * (leading real-world cause: the Runfusion/Fusion#1946 `(no feedback captured)`
   * no-verdict dispatch defect) so a card stranded solely by that failure can
   * advance to merge (FN-7720). The bypass REWRITES this result's `status` to a
   * terminal, non-blocking value (`"skipped"`) and stamps the fields below as an
   * explicit audit trail — it never fabricates a reviewer `verdict`. Only the
   * `getTaskMergeBlocker` "task has failed pre-merge workflow steps" reason is
   * cleared; every other merge-blocker condition (paused, incomplete steps,
   * blocking task status, still-`pending` pre-merge steps) is untouched.
   */
  /** Operator identity that performed the bypass, if this result was bypassed. */
  bypassedBy?: string;
  /** ISO-8601 timestamp when the bypass was applied. */
  bypassedAt?: string;
  /** Mandatory operator-supplied justification for the bypass. */
  bypassReason?: string;
  /** The `status` this result carried immediately before the bypass rewrote it (always `"failed"` for the supported bypass path). */
  bypassedFromStatus?: WorkflowStepResult["status"];
  /** The `verdict` (if any) this result carried immediately before the bypass, preserved for audit only — never promoted to `verdict`. */
  bypassedFromVerdict?: WorkflowStepResult["verdict"];
  /*
   * FNXC:WorkflowStepResults 2026-07-09-00:10:
   * FN-7727: self-healing recovery re-runs a failed pre-merge review node
   * (`code-review`, `code-review-remediation`, `plan-review`,
   * `browser-verification`) in place, and the recorder upsert previously
   * REPLACED the prior `status:"failed"` entry — erasing its captured
   * `output`/`notes`/`verdict`/timestamps forever (the diagnostic trail
   * FN-7642 worked to capture, and the history FN-7720's bypass affordance
   * needs to show). `priorAttempts` preserves a BOUNDED, single-level history
   * of prior terminal-failure (`failed`/`advisory_failure`) attempts on the
   * surviving entry — snapshots never carry their own nested `priorAttempts`,
   * so history cannot grow unbounded. This field is READ-ONLY history: it
   * never participates in merge-blocking (`getTaskMergeBlocker`), self-healing
   * recovery selection (`latestFailedPreMergeStep`), or progress/timing
   * computation — only the current (this) entry's fields do. Written by the
   * shared `upsertWorkflowStepResult` helper (`workflow-step-results.ts`).
   */
  /** Bounded, single-level history of prior terminal-failure attempts this entry replaced. Read-only; never affects merge-blocking or recovery selection. */
  priorAttempts?: WorkflowStepResult[];
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
  /** Optional per-node reasoning-effort override for prompt-mode templates. */
  thinkingLevel?: ThinkingLevel;
  /** Grouping category (e.g., "Quality", "Security") */
  category: string;
  /** Optional icon identifier for UI (e.g., "file-text", "shield") */
  icon?: string;
  /** Optional default enabled state for plugin-provided templates. */
  enabled?: boolean;
}
