/**
 * Planning Mode Session Management
 *
 * Manages AI-guided planning sessions for interactive task creation.
 * Sessions are stored in-memory with TTL cleanup.
 * 
 * Features:
 * - AI agent integration via createFnAgent for real-time planning conversations
 * - Streaming via SSE (createSessionWithAgent) and non-streaming (createSession)
 * - Rate limiting per IP
 * - Session expiration and cleanup
 * - JSON response parsing with robust extraction and repair
 */

import type {
  PlanningQuestion,
  PlanningSummary,
  PlanningResponse,
  TaskPriority,
  TaskSourceIssue,
  TaskStore,
  Settings,
  NtfyNotificationEvent,
  ThinkingLevel,
  MessageStore,
} from "@fusion/core";
import {
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITIES,
  THINKING_LEVELS,
  formatPlanningPlanMd,
  resolvePlanningSettingsModel,
  resolveTaskOutputLanguage,
  summarizeTitle,
  type PromptOverrideMap,
  type ResolvedTaskOutputLanguage,
} from "@fusion/core";
import type { Task } from "@fusion/core";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AiSessionStore, AiSessionRow } from "./ai-session-store.js";
import { SessionEventBuffer, type SessionBufferedEvent } from "./sse-buffer.js";
import { registerBeforeExitCleanup } from "./process-lifecycle.js";
import {
  createSessionDiagnostics,
  resetDiagnosticsSink,
  nonfatal,
} from "./ai-session-diagnostics.js";
import {
  buildSessionSkillContextSync,
  createChatTaskDocumentTools,
  createChatTaskLogsReadTool,
  createResolvedAgentSession,
  createWorkflowAuthoringTools,
  resolveMcpServersForStore,
} from "@fusion/engine";
import * as engineModule from "@fusion/engine";
import { createPlanningBoardTools } from "./planning-board-tools.js";
import { buildPlanningSourceIssueContext, extractSeedIssueContext } from "./github.js";
import { extractIssueImageUrls, githubImagePolicy, importIssueImagesFromUrls } from "./issue-image-attachments.js";

// The planning lane has no ambient task; fn_workflow_select therefore has no
// default target and an agent must pass an explicit task_id.
const PLANNING_NO_AMBIENT_TASK_ID = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
type SkillPluginRunner = Parameters<typeof buildSessionSkillContextSync>[3];
type AgentMessage = {
  role: string;
  content?: string | Array<{ type: string; text?: string; thinking?: string }>;
};

const PLANNING_BUILTIN_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
type PlanningMcpServers = Awaited<ReturnType<typeof resolveMcpServersForStore>>["servers"];
/*
FNXC:PlanningMode 2026-07-21-09:15:
Planning questions must never create dashboard Mailbox messages. Retain the optional MessageStore input only as a source-compatible no-op for callers compiled against the prior planning API while route and session code omit every mailbox read/write path.
*/
export type PlanningSourceIssue = TaskSourceIssue & {
  title?: string;
  imageUrls?: string[];
  commentsUnavailable?: boolean;
  droppedBodyCount?: number;
};

type PlanningSessionOptions = {
  projectId?: string;
  /** Structured import provenance; only GitHub is accepted by the route boundary. */
  sourceIssue?: PlanningSourceIssue;
  ntfyConfig?: PlanningNtfyConfig;
  clarificationEnabled?: boolean;
  /** Workflow selected by the planning entry point; retained for agent rebuilds. */
  workflowId?: string;
  messageStore?: MessageStore;
  pluginRunner?: SkillPluginRunner;
};
/*
FNXC:PlanningRuntimeResolution 2026-07-24-16:20:
Planning sessions must be created through the shared `createResolvedAgentSession` seam that chat, executor, reviewer, merger, and heartbeat already use — NOT through a bare `createFnAgent` call. `createFnAgent` pins the session to the default pi runtime, so a planning selection could never route to a CLI/plugin runtime (claude-local/ACP, grok, omp) that owns its own auth; it always issued a direct HTTPS call to the provider endpoint with a Fusion-resolved key. That divergence is why a subscription/CLI-authenticated operator saw planning fail with a raw-key `401 invalid x-api-key` while every other lane worked. Routing here also emits the `session:runtime-resolved` run-audit event, so planning's resolved runtime and post-transform model pair are finally visible.

Planning has no ambient task or bound agent, so it carries no runtimeHint of its own; `resolveRuntime` falls back to the default pi runtime exactly as before when no plugin runtime claims the purpose. `sessionPurpose: "executor"` matches the role planning already requests for skill selection (`buildSessionSkillContextSync(null, "executor", ...)`) and the purpose chat/QuickChat pass for the same reason.
*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createPlanningRuntimeSession(options: any): Promise<AgentResult> {
  const { pluginRunner, runtimeHint, settings, ...runtimeOptions } = options ?? {};
  // Prefer the live engine binding so `ensureEngineReady()`-driven late loading
  // still resolves, mirroring how this module already reaches engine helpers.
  const create = (engineModule as unknown as {
    createResolvedAgentSession?: typeof createResolvedAgentSession;
  }).createResolvedAgentSession ?? createResolvedAgentSession;
  return create({
    sessionPurpose: "executor",
    ...(runtimeHint ? { runtimeHint } : {}),
    ...(pluginRunner ? { pluginRunner } : {}),
    ...(settings ? { settings } : {}),
    ...runtimeOptions,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createFnAgent: any = createPlanningRuntimeSession;

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

async function resolvePlanningMcpServers(store: TaskStore): Promise<PlanningMcpServers> {
  const resolved = await resolveMcpServersForStore(store);
  /*
  FNXC:McpConfig 2026-07-02-13:45:
  Planning lanes must forward shaped MCP server arrays, while dashboard route-test mocks may omit the resolver result entirely.
  Default only malformed test-seam output to an empty in-memory set so configured servers and secret-bearing materialized fields are never logged or persisted here.
  */
  if (!resolved || !Array.isArray(resolved.servers)) {
    return [];
  }
  return resolved.servers;
}

// ── Notification Integration ────────────────────────────────────────────
//
// The planning module sends "planning-awaiting-input" notifications when an
// AI planning session needs user input. Currently this uses ntfy-specific
// helpers loaded dynamically from @fusion/engine.
//
// The engine now exposes a pluggable NotificationService abstraction
// (NotificationService + NotificationProvider interface) that dispatches
// events to registered providers (ntfy, webhook, etc.). The planning module
// will migrate to using NotificationService.dispatch() for a provider-
// agnostic flow once the broader notification integration is complete.
//
// For now, the ntfy-specific path remains active because "planning-awaiting-input"
// is only supported by the ntfy provider and is not dispatched through the
// NotificationService event listeners (which handle task:moved, task:updated,
// task:merged, settings:updated).

/**
 * Configuration for planning session notifications.
 *
 * Currently drives ntfy-specific notifications for the "planning-awaiting-input" event.
 * This will be generalized to support the pluggable NotificationService abstraction
 * (from @fusion/engine) once additional providers support planning events.
 * Kept as "Ntfy" in the name for backward compatibility with existing call sites.
 */
interface PlanningNtfyConfig {
  enabled: boolean;
  topic?: string;
  dashboardHost?: string;
  events?: NtfyNotificationEvent[];
  ntfyBaseUrl?: string;
}

/**
 * Ntfy-specific helper functions loaded from @fusion/engine at runtime.
 *
 * These wrap the engine's exported notification helpers. In the future, this
 * will be replaced by direct use of NotificationService.dispatch() for a
 * provider-agnostic notification flow.
 */
interface PlanningNtfyHelpers {
  isNtfyEventEnabled: (events: NtfyNotificationEvent[] | undefined, event: NtfyNotificationEvent) => boolean;
  buildNtfyClickUrl: (options: { dashboardHost?: string; projectId?: string; taskId?: string }) => string | undefined;
  sendNtfyNotification: (input: {
    ntfyBaseUrl?: string;
    topic: string;
    title: string;
    message: string;
    priority?: "low" | "default" | "high" | "urgent";
    clickUrl?: string;
  }) => Promise<void>;
}

/** Cached notification helpers. Loaded lazily by ensureNtfyHelpersReady(). */
let planningNtfyHelpers: PlanningNtfyHelpers | undefined;

/**
 * Shared diagnostics helper for the planning module.
 * Uses the shared ai-session-diagnostics helper for consistent scoped logging.
 * @see ai-session-diagnostics.ts for the shared contract
 */
const diagnostics = createSessionDiagnostics("planning");

/**
 * Get the current diagnostics logger (for backward compatibility).
 * @internal - exposed for test hook
 */
export function __getPlanningDiagnostics() {
  return diagnostics;
}

/**
 * Inject a diagnostics sink (test-only).
 * Delegates to the shared ai-session-diagnostics sink.
 * When a sink is injected, all planning module diagnostics route through it.
 * This allows tests to assert on diagnostics without global console spies.
 */
export function __setPlanningDiagnostics(_logger: unknown): void {
  // For backward compatibility, we keep this function but it now delegates
  // to the shared helper's sink mechanism. The actual sink injection
  // should use setDiagnosticsSink() from ai-session-diagnostics.
  // This function is kept for backward compatibility with existing tests.
  if (_logger === null) {
    resetDiagnosticsSink();
  }
}

function ensureEngineReady(): Promise<void> {
  return Promise.resolve();
}

async function ensureNtfyHelpersReady(): Promise<void> {
  if (planningNtfyHelpers) {
    return;
  }

  const hasNotificationService = "NotificationService" in engineModule
    && typeof engineModule.NotificationService === "function";

  const hasAllHelpers =
    "isNtfyEventEnabled" in engineModule
    && "buildNtfyClickUrl" in engineModule
    && "sendNtfyNotification" in engineModule
    && typeof engineModule.isNtfyEventEnabled === "function"
    && typeof engineModule.buildNtfyClickUrl === "function"
    && typeof engineModule.sendNtfyNotification === "function";

  if (!hasAllHelpers) {
    return;
  }

  planningNtfyHelpers = {
    isNtfyEventEnabled: engineModule.isNtfyEventEnabled,
    buildNtfyClickUrl: engineModule.buildNtfyClickUrl,
    sendNtfyNotification: engineModule.sendNtfyNotification,
  };

  if (hasNotificationService) {
    diagnostics.info(
      "NotificationService abstraction detected in engine",
      { operation: "notification-service-detection" },
    );
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

/*
FNXC:PlanningMode 2026-07-23-14:00:
Planning Mode is a collaborative, user-terminated discovery session, not task triage. Its dedicated prompt must not inherit workflow or assigned-triage execution instructions, because those instructions can turn exploratory responses into executor specifications and child-task directives.

A selected direction is a durable plan-backbone decision: every affected running-plan field must be rebuilt around accumulated selections, then exactly one repository-grounded question must narrow that direction another consequential level. The model may update the running plan but must never infer completion; only the visible Proceed with plan action can make a session terminal.

FNXC:PlanningMode 2026-08-07-03:10:
Planning questions normally need 3–5 materially distinct substantive alternatives; two is not sufficient, and a genuinely useful larger set must survive unchanged. Keep exactly one synthetic Other/write-your-own control separate from model alternatives so it remains the canonical free-text path.
*/
/** Self-contained system prompt for the separate collaborative Planning Mode. */
export const PLANNING_SYSTEM_PROMPT = `## Collaborative Planning Mode

Help the operator iteratively turn an idea into a clear, useful plan. First investigate relevant repository and active-board context with the available readonly tools, fn_task_list, and fn_task_show when that context can reduce uncertainty. Explore the problem before assuming a solution: identify assumptions, unknowns, constraints, affected surfaces, and meaningful risks. Compare viable approaches and their trade-offs. Discuss decomposition when it clarifies scope, sequencing, ownership, or deliverables, but do not automatically split work or direct the creation of child tasks.

Build an evolving operator-facing plan, not an executor-ready task specification. Focus on intended outcomes, concrete deliverables, alternatives considered, and observable acceptance criteria. Do not produce task-specification bookkeeping or execution-process instructions such as task-size policy, commit guidance, no-code-change caveats, or task-creation directives. Author the operator-facing plan in Markdown: write the description as concise GitHub-flavored Markdown, while the structured change, acceptance, dependency, and deliverable fields become its Markdown sections and lists.

Use a deliberate iterative narrowing loop: analyze → concrete options → operator selection → plan rebuild → one deeper question. When the opener is vague, subjective, preference-based, or symptom-only, inspect the relevant implementation surface before proposing normally 3–5 materially distinct actionable directions grounded in those findings, plus exactly one Other option. Two alternatives are not sufficient; provide more than five when additional directions are genuinely useful. Do not ask a generic clarification question or silently select a direction. Keep the provisional plan honest about unselected alternatives.

After every selected option, multi-selection, or free-text Other answer, treat the choice as a durable decision and rebuild every affected running-plan field around all accumulated decisions. The title, description, proposedChanges, acceptanceCriteria, keyDeliverables, and suggestedRefinements must make the selected direction—not the original vague complaint or an unselected alternative—the central intended outcome. Preserve Other text verbatim as steering. Then inspect the selected direction and relevant repository context and ask exactly one consequential next question that narrows it one level further with concrete, materially distinct options. A refine turn uses the selected or free-text focus to choose that next question. Continue this loop until the operator chooses Proceed with plan. The model never validates or terminates the session. Only the user can validate it through the visible Proceed with plan action.

For every initial, answer, or refine turn respond only with JSON: {"type":"question","data":{"id":"unique-id","type":"single_select|multi_select","question":"...","description":"...","options":[{"id":"option-a","label":"...","description":"...","pros":["..."],"cons":["..."]},{"id":"option-b","label":"...","description":"...","pros":["..."],"cons":["..."]},{"id":"option-c","label":"...","description":"...","pros":["..."],"cons":["..."]},{"id":"other","label":"...","isOther":true}],"runningPlan":{"title":"...","description":"...","proposedChanges":["specific change"],"acceptanceCriteria":["observable outcome"],"suggestedSize":"S|M|L","priority":"normal","suggestedDependencies":[],"keyDeliverables":["concrete work item"],"suggestedRefinements":["next focus 1","next focus 2"]}}}. Include normally 3–5 substantive alternatives in options; this example is illustrative rather than a maximum.

Every turn must include the running-plan fields: only title, description, concrete proposedChanges, observable acceptanceCriteria, suggestedSize, optional priority, suggestedDependencies, concrete keyDeliverables, and concise suggestedRefinements informed by the idea and answers so far. Include every distinct, high-value unresolved refinement area; do not cap the list at three. Never use interview question text as a deliverable. Proceed with plan serializes the plan as plan.md without priority or suggestedRefinements; priority remains a task field. Every question must provide normally 3–5 materially distinct actionable alternatives, each with a non-empty description, pros, and cons, plus exactly one Other/write-your-own option. Never treat two alternatives as sufficient or truncate a genuinely useful larger set. Write every label, option, and Other label in the language of the user's original input. Incorporate free-text Other answers verbatim as steering context for the following question.`;

/*
FNXC:PlanningMode 2026-07-23-11:35:
The separate Planning Mode prompt has sole default authority. Workflow selection still resolves models and task creation, but workflow planning seams and triage assignments remain execution-task concerns and must never leak into collaborative planning turns.
*/
export async function resolvePlanningModeSystemPrompt(
  store: TaskStore,
  promptOverrides?: PromptOverrideMap,
  _workflowId?: string,
  outputLanguage?: ResolvedTaskOutputLanguage,
): Promise<string> {
  const settings: Partial<Settings> = (await store.getSettings().catch(() => ({}))) ?? {};
  const overrides = promptOverrides ?? settings.promptOverrides;
  const explicitOverride = overrides && Object.prototype.hasOwnProperty.call(overrides, "planning-system")
    && typeof overrides["planning-system"] === "string"
    && overrides["planning-system"].trim().length > 0
    ? overrides["planning-system"]
    : undefined;

  /* FNXC:TaskOutputLanguage 2026-08-19-14:56: Planning prompt resolution is server-side; React receives only form state, never the runtime resolver. */
  const base = explicitOverride ?? PLANNING_SYSTEM_PROMPT;
  const target = outputLanguage ?? resolveTaskOutputLanguage(settings, "");
  return `${base}\n\n## Task Output Language\n${target.instruction} Apply this only to human-readable question, option, and running-plan values; JSON keys and enums remain canonical.`;
}



/** Placeholder title for draft sessions before the user starts planning. */
export const DRAFT_PLACEHOLDER_TITLE = "New planning session";

/**
 * Shape of the JSON blob persisted in `ai_sessions.inputPayload` for draft
 * planning sessions. Carries the in-progress plan text plus an optional
 * model override so reopening a draft restores the model selection the user
 * picked at create time, and so summarizeDraftTitle calls hit that same
 * model rather than silently falling back to project defaults.
 *
 * FNXC:Planning 2026-07-12-00:00:
 * Planning drafts/sessions persist a validated per-session reasoning effort in inputPayload so draft reopen and start-existing rebuilds preserve the selected thinking level without a SQLite schema change.
 *
 * `summarizedFor` records the exact `initialPlan` string the current
 * persisted title was summarized from. The start-existing path uses it to
 * skip re-summarizing when blur/close already produced a title for the
 * final text, avoiding a redundant model call.
 */
export interface DraftInputPayload {
  initialPlan?: string;
  generationPurpose?: "initial_plan" | "plan_update" | "question";
  generationStartedAt?: string;
  generationReturnQuestion?: PlanningQuestion;
  /** Contextual batch retained until its plan-update generation succeeds, so retry can replay it. */
  pendingContextualComments?: ContextualComment[];
  clarificationEnabled?: boolean;
  /* FNXC:PlanningMode 2026-07-21-09:15: Keep old payloads source-compatible without reading or writing this retired mailbox dedupe marker. */
  lastMailboxNotifiedQuestionKey?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /** Immutable target captured at session start so retry and rehydration cannot retarget prose. */
  taskOutputLanguage?: ResolvedTaskOutputLanguage;
  summarizedFor?: string;
  validated?: boolean;
  workflowId?: string;
  sourceIssue?: PlanningSourceIssue;
  createdTaskId?: string;
  createClaimStatus?: "none" | "creating" | "created";
  claimOwnerToken?: string;
  claimStartedAt?: string;
  taskCreationEpoch?: number;
  createdTaskIds?: string[];
}

/** Session TTL in milliseconds (7 days) */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max planning sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 1000;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/*
FNXC:PlanningLiveness 2026-06-24-00:00:
Planning Mode must allow long-running reasoning when the agent is producing new thinking/text, because a fixed wall-clock cap incorrectly fails legitimate sessions. The watchdog is scoped to Planning Mode and treats this value as an inactivity window: non-empty, materially new output refreshes liveness; repeated identical output is counted separately and stopped as a loop so stuck sessions still fail deterministically without changing subtask, mission, milestone, or onboarding timeout semantics.
*/
export const GENERATION_TIMEOUT_MS = 120_000;

/** Repeated identical planning stream chunks before the generation is classified as looping. */
export const GENERATION_LOOP_REPEAT_LIMIT = 8;

const PLANNING_STUCK_ERROR_MESSAGE = "AI generation appears stuck with no new output. You can retry or start a new session.";
const PLANNING_LOOP_ERROR_MESSAGE = "AI generation appears stuck repeating the same output. You can retry or start a new session.";
export const PLANNING_INTERRUPTED_ERROR_MESSAGE = "Planning generation was interrupted before it finished. Retry to continue this session.";

// ── Types ───────────────────────────────────────────────────────────────────

/** SSE event types for planning session streaming */
export type PlanningStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: PlanningSummary }
  | { type: "error"; data: string }
  | { type: "complete" };

/** Callback function for streaming events */
export type PlanningStreamCallback = (event: PlanningStreamEvent, eventId?: number) => void;

interface PlanningHistoryEntry {
  question: PlanningQuestion;
  response: unknown;
  thinkingOutput?: string;
}

interface Session {
  id: string;
  ip: string;
  initialPlan: string;
  title: string;
  /*
  FNXC:PlanningTurnAdmission 2026-07-23-10:40:
  Monotonic in-memory epoch for streaming-callback invalidation. Bumped every time the
  session's agent is disposed/replaced; agent onThinking/onText closures capture the epoch at
  agent creation and no-op when it has moved on. Closes the residual PR #2417 window where a
  provider that ignores cancellation beyond rewind's bounded settle-wait could persist or
  broadcast stale thinking deltas after the rewound state was published. Never persisted.
  */
  agentCallbackEpoch?: number;
  projectId?: string;
  /** Workflow selected at session start, retained for agent reconstruction. */
  workflowId?: string;
  /** Structured GitHub import provenance persisted in inputPayload. */
  sourceIssue?: PlanningSourceIssue;
  /** Model override the user picked at draft-create time. Persisted in inputPayload so reopen restores it. */
  draftModelProvider?: string;
  draftModelId?: string;
  /** Per-session reasoning effort persisted with the draft/session and threaded into planning agents when set. */
  draftThinkingLevel?: ThinkingLevel;
  /** Immutable language target persisted with the first generation attempt. */
  taskOutputLanguage?: ResolvedTaskOutputLanguage;
  /** Plan text the current title was summarized from; lets startExistingSession skip a redundant re-summarize when blur/close already covered the final text. */
  draftSummarizedFor?: string;
  ntfyConfig?: PlanningNtfyConfig;
  /** Persisted per-session override for proactive AI clarification checkpoints. */
  clarificationEnabled?: boolean;
  autoMerge?: boolean;
  /** Last planning question notified via ntfy, keyed as `${sessionId}:${questionId}` for dedupe across reconnect/replay. */
  lastNotifiedQuestionKey?: string;
  history: PlanningHistoryEntry[];
  currentQuestion?: PlanningQuestion;
  /** Question currently being edited; history is preserved rather than truncated. */
  editingQuestionId?: string;
  summary?: PlanningSummary;
  /** User-controlled finalization state. */
  validated: boolean;
  /** Durable create-task linkage; proposalClaimId remains the crash-recovery authority. */
  createdTaskId?: string;
  createClaimStatus?: "none" | "creating" | "created";
  claimOwnerToken?: string;
  claimStartedAt?: string;
  /*
  FNXC:PlanningMultiTask 2026-07-24-00:20:
  One plan may produce multiple tasks. Each creation attempt belongs to an epoch: epoch 0 uses
  the legacy `planning-session:{id}` proposalClaimId, epoch N uses `planning-session:{id}#N`.
  Replaying Proceed without editing stays idempotent within the current epoch (same task,
  alreadyCreated); editing the plan after a task exists ROTATES the epoch so the next Proceed
  creates a fresh task. createdTaskIds records every task created from this plan.
  */
  taskCreationEpoch?: number;
  createdTaskIds?: string[];
  /** Whether the current generation must end at plan review rather than a question. */
  generationPurpose?: "initial_plan" | "plan_update" | "question";
  /** Durable start time for the active turn so each concurrent session owns its elapsed clock. */
  generationStartedAt?: string;
  /** Question restored when the user stops the active turn. */
  generationReturnQuestion?: PlanningQuestion;
  /**
   * FNXC:PlanningComments 2026-07-23-13:00:
   * A contextual batch is a durable pending turn, not UI-only state. Retain its normalized
   * quote/suggestion pairs until the revised summary is accepted so retry and rehydration replay
   * precisely the requested plan update after the agent session is disposed.
   */
  pendingContextualComments?: ContextualComment[];
  /** Last terminal error for retry UX */
  error?: string;
  /** AI agent session for real-time interaction */
  agent?: AgentResult;
  /**
   * TaskStore reference captured at session creation. Used by
   * ensureSessionAgent to rebuild the agent after rehydration (when no
   * store is plumbed through the submitResponse/retry/rewind call sites).
   * Not persisted — restored only for the lifetime of the in-memory session.
   */
  store?: TaskStore;
  /** Project root captured at session creation; mirrors `store` for agent rebuild. */
  rootDir?: string;
  /** Plugin runner captured while the server is alive so rebuilt planning agents keep plugin-contributed skills. */
  pluginRunner?: SkillPluginRunner;
  /** Callback for streaming events to SSE clients */
  streamCallback?: PlanningStreamCallback;
  /** Accumulated thinking output for display */
  thinkingOutput: string;
  /** Thinking output generated while producing currentQuestion */
  lastGeneratedThinking: string;
  createdAt: Date;
  updatedAt: Date;
}

/*
FNXC:GitHubPlanningSourceIssue 2026-08-09-05:36:
A persisted explicit source wins over seed text; only a canonical seed may enrich matching title/body.
This keeps user prose and conflicting stale seeds from changing outward-facing GitHub provenance.
*/
export function resolvePlanningSourceIssue(session: Pick<Session, "initialPlan" | "sourceIssue">): ReturnType<typeof buildPlanningSourceIssueContext> | undefined {
  const explicit = session.sourceIssue;
  const seed = extractSeedIssueContext(session.initialPlan);
  if (explicit) {
    if (explicit.provider !== "github") return undefined;
    const [owner, repo] = explicit.repository.split("/");
    if (!owner || !repo || !Number.isFinite(explicit.issueNumber) || !explicit.url) return undefined;
    const enrich = seed && seed.url.toLowerCase() === explicit.url.toLowerCase() ? seed : undefined;
    return buildPlanningSourceIssueContext({ owner, repo, issueNumber: explicit.issueNumber, url: explicit.url, title: enrich?.title ?? explicit.title, body: enrich?.body });
  }
  return seed ? buildPlanningSourceIssueContext(seed) : undefined;
}

/** Resolve persisted planning image URLs without re-fetching issue data. */
export function resolvePlanningIssueImageUrls(session: Pick<Session, "initialPlan" | "sourceIssue">): { urls: string[]; commentsUnavailable: boolean; droppedBodyCount: number } {
  const persisted = session.sourceIssue;
  // FNXC:GitHubPlanningSourceIssue 2026-08-09-14:51: An empty persisted list is an intentional post-capture result (including L2 drops), not a legacy omission eligible for seed fallback.
  if (Array.isArray(persisted?.imageUrls)) return { urls: persisted.imageUrls, commentsUnavailable: persisted.commentsUnavailable === true, droppedBodyCount: persisted.droppedBodyCount ?? 0 };
  const seed = extractSeedIssueContext(session.initialPlan);
  if (!seed) return { urls: [], commentsUnavailable: false, droppedBodyCount: 0 };
  return { urls: extractIssueImageUrls(seed.body, githubImagePolicy()), commentsUnavailable: true, droppedBodyCount: 0 };
}

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

/** Active planning sessions indexed by session ID */
const sessions = new Map<string, Session>();

/** Rate limiting state indexed by IP */
const rateLimits = new Map<string, RateLimitEntry>();

type PlanningGenerationAbortReason = "stuck" | "loop" | "user-stop" | "displaced";

interface ActivePlanningGeneration {
  abortController: AbortController;
  timer: NodeJS.Timeout;
  abortReason?: PlanningGenerationAbortReason;
  abortTeardownFired: boolean;
  abortTeardown: () => void;
  markProgress: (output: string) => void;
}

/** Active planning generations keyed by session ID. */
const activeGenerations = new Map<string, ActivePlanningGeneration>();

/*
FNXC:PlanningTurnAdmission 2026-07-22-21:00:
Reported bug: "AI returned no valid JSON" recurred whenever the Planning UI was left and
re-entered mid-generation (mobile tab switches unmount the view), and generations visibly
duplicated. Root cause: the `activeGenerations.has()` guard is check-then-act across several
awaits (persistSession/ensureSessionAgent) — the ActivePlanningGeneration record only exists
once runGenerationWithTimeout runs. Two overlapping turn entries (re-submitted answer from a
remounted view, racing auto-retries, duplicate start of an existing session) both passed the
guard; the second displaced the first, and the displaced teardown disposed the session-shared
agent that the surviving turn was actively prompting, so the surviving turn read an empty
assistant message and failed parse with "AI returned no valid JSON".
Invariant: at most one turn may be admitted per session at any time, enforced SYNCHRONOUSLY
(no await between check and reservation). Every generation entry point (submitResponse,
retrySession, startExistingSession, initializeAgent) must hold a reservation for its full span,
so a concurrent entry is rejected with GenerationInProgressError instead of displacing a
healthy in-flight generation.
*/
interface PlanningTurnReservation {
  done: Promise<void>;
  resolveDone: () => void;
}

const pendingTurnReservations = new Map<string, PlanningTurnReservation>();

function isPlanningTurnActive(sessionId: string): boolean {
  return activeGenerations.has(sessionId) || pendingTurnReservations.has(sessionId);
}

/** Synchronously reserve the session's single turn slot; returns the release fn. */
function reservePlanningTurn(sessionId: string): () => void {
  if (isPlanningTurnActive(sessionId)) {
    throw new GenerationInProgressError("Generation already in progress");
  }
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const reservation: PlanningTurnReservation = { done, resolveDone };
  pendingTurnReservations.set(sessionId, reservation);
  return () => {
    if (pendingTurnReservations.get(sessionId) === reservation) {
      pendingTurnReservations.delete(sessionId);
    }
    reservation.resolveDone();
  };
}

/*
FNXC:PlanningTurnAdmission 2026-07-23-08:30:
User-takes-control actions (rewind/edit) abort the in-flight generation and must then WAIT for
that turn's owner to unwind and release its reservation before mutating session state.
Deleting the active-generation record without waiting left both admission sets empty while the
aborted turn was still unwinding, so a concurrent submit/retry could interleave with rewind's
own awaits and corrupt question/history/agent state (review finding on PR #2417).
*/
/*
FNXC:PlanningTurnAdmission 2026-07-23-10:10:
The turn reservation is released as soon as the abort wins runGenerationWithTimeout's race,
but the generation OPERATION (which holds the raw provider prompt) can still be pending if the
provider ignores the AbortSignal. User-takes-control paths (rewind) must also wait — bounded —
for that operation to settle before disposing/replacing the agent, or a slow provider callback
could still be running against the mutable session while the rewound state is published
(review finding on PR #2417). Tracked separately from reservations because settlement can
outlive the owner's release.
*/
const settlingTurnOperations = new Map<string, Promise<void>>();

function trackTurnOperationSettled(sessionId: string, operationPromise: Promise<unknown>): void {
  const settled = operationPromise.then(
    () => {},
    () => {},
  );
  settlingTurnOperations.set(sessionId, settled);
  void settled.then(() => {
    if (settlingTurnOperations.get(sessionId) === settled) {
      settlingTurnOperations.delete(sessionId);
    }
  });
}

/**
 * Bounded wait for a cancelled turn's operation (including its provider prompt) to settle.
 * Returns false on timeout — callers proceed anyway: agent disposal is the backstop, the
 * cancelled closure's post-prompt abort checks prevent state writes, and blocking a user's
 * rewind forever on an unresponsive provider would be worse.
 */
async function waitForTurnOperationSettled(sessionId: string, timeoutMs = 2000): Promise<boolean> {
  const settling = settlingTurnOperations.get(sessionId);
  if (!settling) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    settling.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return !timedOut;
}

async function waitForPlanningTurnRelease(sessionId: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPlanningTurnActive(sessionId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const reservation = pendingTurnReservations.get(sessionId);
    if (reservation) {
      await Promise.race([
        reservation.done,
        new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 50))),
      ]);
    } else {
      // Active generation whose owner has not yet reached its release — brief yield.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return true;
}

// ── AI Session Persistence ────────────────────────────────────────────────

/** Optional store for persisting session state across reloads/browsers. */
let _aiSessionStore: AiSessionStore | undefined;
let _aiSessionDeletedListener: ((sessionId: string) => void) | undefined;
const sessionPersistenceQueues = new Map<string, Promise<void>>();

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/*
FNXC:PlanningNormalization 2026-06-25-00:00:
AI responses and persisted planning rows are untrusted runtime data. Normalize omitted or malformed summary arrays to [] at the session boundary so #1743-style undefined `.map` crashes cannot reach live streams, resume, task creation, or breakdown generation.
*/
export function normalizePlanningSummaryPayload(
  summaryInput: unknown,
  fallback?: { title?: string; description?: string },
): PlanningSummary {
  const summary = summaryInput && typeof summaryInput === "object" && !Array.isArray(summaryInput)
    ? summaryInput as Record<string, unknown>
    : {};

  const title = typeof summary.title === "string" && summary.title.trim().length > 0
    ? summary.title.trim()
    : fallback?.title?.trim() || "Untitled planning task";
  const description = typeof summary.description === "string" && summary.description.trim().length > 0
    ? summary.description.trim()
    : fallback?.description?.trim() || title;

  return {
    title,
    description,
    proposedChanges: normalizeStringArray(summary.proposedChanges),
    acceptanceCriteria: normalizeStringArray(summary.acceptanceCriteria),
    suggestedSize: summary.suggestedSize === "S" || summary.suggestedSize === "M" || summary.suggestedSize === "L"
      ? summary.suggestedSize
      : "M",
    priority: isTaskPriority(summary.priority) ? summary.priority : DEFAULT_TASK_PRIORITY,
    suggestedDependencies: normalizeStringArray(summary.suggestedDependencies),
    keyDeliverables: normalizeStringArray(summary.keyDeliverables),
    suggestedRefinements: normalizeStringArray(summary.suggestedRefinements),
  };
}

function safeParseJson<T>(
  text: string | null,
  fallback: T,
  options?: { throwOnError?: boolean; fieldName?: string },
): T {
  if (!text) {
    return fallback;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (options?.throwOnError) {
      const fieldSuffix = options.fieldName ? ` in ${options.fieldName}` : "";
      throw new Error(`Invalid JSON${fieldSuffix}: ${(error as Error).message}`);
    }
    return fallback;
  }
}

/** Wire up the AI session persistence store. Called once from server.ts. */
export function setAiSessionStore(store: AiSessionStore): void {
  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }

  _aiSessionStore = store;
  _aiSessionDeletedListener = (sessionId: string) => {
    cleanupInMemorySession(sessionId);
  };
  _aiSessionStore.on("ai_session:deleted", _aiSessionDeletedListener);
}

/*
FNXC:PlanningMultiTask 2026-07-24-03:40:
Review P1: `fn task plan --resume` / fn_task_plan resumeSessionId advertised cross-invocation
resume, but setAiSessionStore only ever ran inside the dashboard server — CLI planning
sessions were never persisted, getSession always missed in a fresh process, and dashboard
sessions were unreachable from the CLI. Non-server callers wire the same durable
AiSessionStore over their resolved board store's public asyncLayer here. Returns false when
no async layer exists (legacy SQLite mode): planning then stays in-memory and resume is
single-process only — callers must say so instead of failing silently.
*/
export async function ensureDurablePlanningSessionStore(store: TaskStore): Promise<boolean> {
  if (_aiSessionStore) return true;
  const layer = (store as { asyncLayer?: unknown }).asyncLayer;
  if (!layer) return false;
  const { AiSessionStore: DurableAiSessionStore } = await import("./ai-session-store.js");
  setAiSessionStore(new DurableAiSessionStore(layer as ConstructorParameters<typeof DurableAiSessionStore>[0]));
  return true;
}

function cleanupInMemorySession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  const activeGeneration = activeGenerations.get(sessionId);
  if (activeGeneration) {
    clearTimeout(activeGeneration.timer);
    activeGeneration.abortReason = "user-stop";
    activeGeneration.abortTeardown();
    activeGeneration.abortController.abort();
    activeGenerations.delete(sessionId);
  }

  if (session.agent) {
    try {
      const disposeResult = session.agent.session.dispose?.();
      if (disposeResult) {
        disposeResult.catch((err: unknown) => {
          diagnostics.errorFromException("Error disposing agent for session", err, { sessionId, operation: "dispose-session" });
        });
      }
    } catch (err) {
      diagnostics.errorFromException("Error disposing agent for session", err, { sessionId, operation: "dispose-session" });
    }
    session.agent = undefined;
  }

  planningStreamManager.cleanupSession(sessionId);
  sessions.delete(sessionId);
  return true;
}

/** Persist the current session state to PostgreSQL (no-op if store not wired). */
function persistSession(session: Session, status: "generating" | "awaiting_input" | "complete" | "error" | "draft", error?: string): Promise<void> {
  const store = _aiSessionStore;
  if (!store) return Promise.resolve();
  const row: AiSessionRow = {
    id: session.id,
    type: "planning",
    status,
    title: session.title || session.initialPlan.slice(0, 120),
    inputPayload: JSON.stringify({
      ip: session.ip,
      initialPlan: session.initialPlan,
      ...(session.draftModelProvider ? { modelProvider: session.draftModelProvider } : {}),
      ...(session.draftModelId ? { modelId: session.draftModelId } : {}),
      ...(session.draftThinkingLevel ? { thinkingLevel: session.draftThinkingLevel } : {}),
      ...(session.taskOutputLanguage ? { taskOutputLanguage: session.taskOutputLanguage } : {}),
      ...(session.draftSummarizedFor ? { summarizedFor: session.draftSummarizedFor } : {}),
      ...(session.workflowId ? { workflowId: session.workflowId } : {}),
      ...(session.sourceIssue ? { sourceIssue: session.sourceIssue } : {}),
      validated: session.validated,
      ...(session.createdTaskId ? { createdTaskId: session.createdTaskId } : {}),
      ...(session.createClaimStatus ? { createClaimStatus: session.createClaimStatus } : {}),
      ...(session.claimOwnerToken ? { claimOwnerToken: session.claimOwnerToken } : {}),
      ...(session.claimStartedAt ? { claimStartedAt: session.claimStartedAt } : {}),
      ...(session.taskCreationEpoch ? { taskCreationEpoch: session.taskCreationEpoch } : {}),
      ...(session.createdTaskIds?.length ? { createdTaskIds: session.createdTaskIds } : {}),
      ...(typeof session.clarificationEnabled === "boolean"
        ? { clarificationEnabled: session.clarificationEnabled }
        : {}),
      ...(session.generationPurpose ? { generationPurpose: session.generationPurpose } : {}),
      ...(session.generationStartedAt ? { generationStartedAt: session.generationStartedAt } : {}),
      ...(session.generationReturnQuestion ? { generationReturnQuestion: session.generationReturnQuestion } : {}),
      ...(session.pendingContextualComments ? { pendingContextualComments: session.pendingContextualComments } : {}),
    }),
    conversationHistory: JSON.stringify(session.history),
    currentQuestion: session.currentQuestion ? JSON.stringify(session.currentQuestion) : null,
    result: session.summary ? JSON.stringify(session.summary) : null,
    thinkingOutput: session.thinkingOutput,
    error: error ?? null,
    projectId: session.projectId ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };
  /*
  FNXC:PostgresPlanningPersistence 2026-07-14-19:56:
  PostgreSQL writes are asynchronous, so rapid generating→awaiting_input transitions must be serialized per session. The request that creates the first question awaits the final queued write; otherwise an earlier generating upsert can land last and return stale state to another tab.
  */
  const previous = sessionPersistenceQueues.get(session.id) ?? Promise.resolve();
  const queued = previous.then(
    () => store.upsert(row),
    () => store.upsert(row),
  );
  const bestEffort = queued.catch(() => undefined);
  sessionPersistenceQueues.set(session.id, bestEffort);
  void bestEffort.then(() => {
    if (sessionPersistenceQueues.get(session.id) === bestEffort) {
      sessionPersistenceQueues.delete(session.id);
    }
  });
  return bestEffort;
}

/** Persist only thinking output (debounced). */
function persistThinking(sessionId: string, thinkingOutput: string): void {
  if (!_aiSessionStore) return;
  _aiSessionStore.updateThinking(sessionId, thinkingOutput);
}

/** Remove session from persistence after every older write for the session. */
function unpersistSession(sessionId: string): Promise<void> {
  const store = _aiSessionStore;
  if (!store) return Promise.resolve();

  /*
  FNXC:PostgresPlanningPersistence 2026-07-14-21:20:
  Session deletion shares the per-session persistence queue with upserts. A delete that overtakes an upsert after its tombstone check can otherwise allow that older write to recreate a cancelled or cleaned-up planning session.
  */
  const previous = sessionPersistenceQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.then(
    () => store.delete(sessionId),
    () => store.delete(sessionId),
  );
  /*
  FNXC:PostgresPlanningPersistence 2026-07-14-21:46:
  Session deletion is an authoritative operation, so callers must observe a PostgreSQL delete failure instead of reporting successful cleanup while the persisted row remains. The queue retains a handled promise so later operations can proceed, but this deletion call returns the original rejection.
  */
  const bestEffort = queued.catch(() => undefined);
  sessionPersistenceQueues.set(sessionId, bestEffort);
  void bestEffort.then(() => {
    if (sessionPersistenceQueues.get(sessionId) === bestEffort) {
      sessionPersistenceQueues.delete(sessionId);
    }
  });
  return queued;
}

/*
FNXC:PlanningMode 2026-07-21-00:25:
Each active planning turn owns a durable clock and return point. A modal-level Date.now()
clock makes concurrent sessions appear synchronized, while clearing the question before
generation leaves Stop with nowhere safe to return. Persist both at the turn boundary.
*/
/*
FNXC:TaskOutputLanguage 2026-08-19-15:47:
Planning captures the resolved language before an agent is created. The persisted target, not mutable project settings, owns retries, rebuilds, and rehydrated turns.
*/
async function ensurePlanningOutputLanguage(session: Session, store: TaskStore): Promise<ResolvedTaskOutputLanguage> {
  if (!session.taskOutputLanguage) {
    const settings: Partial<Settings> = (await store.getSettings().catch(() => ({}))) ?? {};
    session.taskOutputLanguage = resolveTaskOutputLanguage(settings, session.initialPlan);
  }
  return session.taskOutputLanguage;
}

function beginPlanningGeneration(
  session: Session,
  purpose: NonNullable<Session["generationPurpose"]>,
): void {
  session.generationPurpose = purpose;
  session.generationStartedAt = new Date().toISOString();
  session.generationReturnQuestion = session.currentQuestion ?? session.generationReturnQuestion;
}

/** Release in-memory planning runtime state while keeping persisted history. */
export function releaseSession(sessionId: string): void {
  cleanupInMemorySession(sessionId);
}

function buildSessionFromRow(row: AiSessionRow): Session {
  const payload = safeParseJson<DraftInputPayload & { ip?: string }>(
    row.inputPayload,
    {},
    { throwOnError: true, fieldName: "inputPayload" },
  );

  const thinkingLevel = isThinkingLevel(payload.thinkingLevel) ? payload.thinkingLevel : undefined;

  const createdAt = new Date(row.createdAt);
  const updatedAt = new Date(row.updatedAt);

  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new Error("Invalid session timestamps");
  }

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Only an awaiting_input row has a live question. Rows persisted while generating/error by
  pre-fix builds still carry the already-answered question; restoring it would let the SSE
  catch-up path re-emit it and re-trigger the answered-question retry loop after a restart.

  FNXC:PlanningMode 2026-08-07-03:23:
  Restored awaiting-input questions are untrusted persisted model output, just like live
  responses. Normalize them at the restore boundary so every substantive option survives while
  duplicate model-authored Other entries collapse to the one canonical write-your-own choice.
  The normally 3–5 alternative guidance is not an application maximum.
  */
  const history = safeParseJson<PlanningHistoryEntry[]>(
    row.conversationHistory,
    [],
    { throwOnError: true, fieldName: "conversationHistory" },
  );
  const persistedSummary = row.result
    ? normalizePlanningSummaryPayload(
        safeParseJson<unknown | null>(row.result, null, {
          throwOnError: true,
          fieldName: "result",
        }),
        { title: row.title, description: row.title },
      )
    : undefined;
  const skippedMandatoryInterview = false;
  const currentQuestion = skippedMandatoryInterview
    ? buildMandatoryFirstPlanningQuestion()
    : row.status === "awaiting_input" && row.currentQuestion
      ? (() => {
          const persistedQuestion = safeParseJson<PlanningQuestion | null>(row.currentQuestion, null, {
            throwOnError: true,
            fieldName: "currentQuestion",
          });
          return persistedQuestion ? normalizePlanningQuestion(persistedQuestion, payload.initialPlan ?? row.title) : undefined;
        })()
      : undefined;

  return {
    id: row.id,
    ip: payload.ip ?? "",
    /*
    FNXC:PlanningMode 2026-07-20-18:00:
    FN-8441 must preserve a missing persisted initial request. The create handoff uses
    missingness to fall back to the validated plan body; replacing it with row.title
    would falsely persist the session title as an operator's Original Description.
    */
    initialPlan: payload.initialPlan ?? "",
    title: row.title,
    projectId: row.projectId ?? undefined,
    workflowId: payload.workflowId,
    sourceIssue: payload.sourceIssue,
    draftModelProvider: payload.modelProvider,
    draftModelId: payload.modelId,
    draftThinkingLevel: thinkingLevel,
    taskOutputLanguage: payload.taskOutputLanguage,
    draftSummarizedFor: payload.summarizedFor,
    clarificationEnabled: typeof payload.clarificationEnabled === "boolean"
      ? payload.clarificationEnabled
      : undefined,
    generationPurpose: payload.generationPurpose === "initial_plan"
      || payload.generationPurpose === "plan_update"
      || payload.generationPurpose === "question"
      ? payload.generationPurpose
      : undefined,
    generationStartedAt: typeof payload.generationStartedAt === "string"
      ? payload.generationStartedAt
      : undefined,
    generationReturnQuestion: payload.generationReturnQuestion && typeof payload.generationReturnQuestion === "object"
      ? normalizePlanningQuestion(payload.generationReturnQuestion, payload.initialPlan ?? row.title)
      : undefined,
    pendingContextualComments: getContextualComments({ contextualComments: payload.pendingContextualComments }) ?? undefined,
    history,
    currentQuestion,
    lastNotifiedQuestionKey: currentQuestion ? `${row.id}:${currentQuestion.id}` : undefined,
    summary: persistedSummary ?? buildRunningSummary(payload.initialPlan ?? row.title, history),
    validated: payload.validated === true,
    createdTaskId: typeof payload.createdTaskId === "string" ? payload.createdTaskId : undefined,
    createClaimStatus: payload.createClaimStatus,
    taskCreationEpoch: typeof payload.taskCreationEpoch === "number" && Number.isInteger(payload.taskCreationEpoch) && payload.taskCreationEpoch > 0
      ? payload.taskCreationEpoch
      : undefined,
    createdTaskIds: Array.isArray(payload.createdTaskIds)
      ? payload.createdTaskIds.filter((id): id is string => typeof id === "string")
      : undefined,
    claimOwnerToken: typeof payload.claimOwnerToken === "string" ? payload.claimOwnerToken : undefined,
    claimStartedAt: typeof payload.claimStartedAt === "string" ? payload.claimStartedAt : undefined,
    thinkingOutput: row.thinkingOutput,
    lastGeneratedThinking: row.thinkingOutput || "",
    error: row.error ?? undefined,
    createdAt,
    updatedAt,
    agent: undefined,
  };
}

export async function rehydrateFromStore(store: AiSessionStore): Promise<number> {
  let rows: AiSessionRow[] = [];

  try {
    rows = (await store.listRecoverable()).filter((row) => row.type === "planning");
  } catch (error) {
    diagnostics.errorFromException("Failed to list recoverable sessions", error, { operation: "list-recoverable" });
    return 0;
  }

  let rehydrated = 0;
  for (const row of rows) {
    try {
      const session = buildSessionFromRow(row);
      sessions.set(session.id, session);
      if (session.currentQuestion && session.history.length === 0 && row.result) {
        /* FNXC:PlanningMode 2026-07-18-11:36: Rehydration repairs legacy no-history summaries into the mandatory interview question so reconnects cannot revive a skipped interview. */
        persistSession(session, "awaiting_input");
      }
      rehydrated += 1;
    } catch (error) {
      diagnostics.errorFromException("Failed to rehydrate session", error, { sessionId: row.id, operation: "rehydrate" });
    }
  }

  return rehydrated;
}

// ── Cleanup Interval ────────────────────────────────────────────────────────

/**
 * Remove expired sessions and stale rate limit entries.
 * Runs periodically via setInterval.
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleanedSessions = 0;
  let cleanedRateLimits = 0;

  // Clean up expired sessions
  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      if (cleanupInMemorySession(id)) {
        cleanedSessions++;
      }
    }
  }

  // Clean up stale rate limit entries
  for (const [ip, entry] of rateLimits) {
    if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(ip);
      cleanedRateLimits++;
    }
  }

  if (cleanedSessions > 0 || cleanedRateLimits > 0) {
    diagnostics.info(
      "Cleanup completed",
      { cleanedSessions, cleanedRateLimits, operation: "cleanup-expired" }
    );
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

// Handle graceful shutdown
registerBeforeExitCleanup(() => {
  clearInterval(cleanupInterval);
});

// ── Planning Stream Manager ─────────────────────────────────────────────────

/**
 * Manages SSE connections for active planning sessions.
 * Each session can have multiple connected clients receiving streaming updates.
 */
export class PlanningStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<PlanningStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();
  private readonly pendingInitialTurns = new Map<string, () => void>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  /**
   * Register a client callback for a planning session.
   * Returns a function to unsubscribe.
   */
  subscribe(sessionId: string, callback: PlanningStreamCallback): () => void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }

    const callbacks = this.sessions.get(sessionId)!;
    callbacks.add(callback);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.sessions.delete(sessionId);
      }
    };
  }

  private getBuffer(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionEventBuffer(this.bufferSize);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  /**
   * Broadcast an event to all clients subscribed to a session.
   * Every event is buffered and assigned a monotonically increasing id.
   */
  broadcast(sessionId: string, event: PlanningStreamEvent): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventData = typeof serialized === "string" ? serialized : "{}";
    const eventId = this.getBuffer(sessionId).push(event.type, eventData);

    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) return eventId;

    for (const callback of callbacks) {
      nonfatal(
        () => callback(event, eventId),
        diagnostics,
        "Error broadcasting to client",
        { sessionId, operation: "broadcast" }
      );
    }

    return eventId;
  }

  /**
   * Get buffered events with id > sinceId for the session.
   */
  getBufferedEvents(sessionId: string, sinceId: number): SessionBufferedEvent[] {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getEventsSince(sinceId);
  }

  registerInitialTurn(sessionId: string, start: () => void): void {
    if (this.pendingInitialTurns.has(sessionId)) {
      throw new Error(`Initial planning turn already registered for session ${sessionId}`);
    }
    this.pendingInitialTurns.set(sessionId, start);
  }

  /** True while a registered initial turn has not been consumed by a stream connection yet. */
  hasPendingInitialTurn(sessionId: string): boolean {
    return this.pendingInitialTurns.has(sessionId);
  }

  consumeInitialTurn(sessionId: string): (() => void) | undefined {
    const start = this.pendingInitialTurns.get(sessionId);
    if (!start) {
      return undefined;
    }
    this.pendingInitialTurns.delete(sessionId);
    return start;
  }

  /**
   * Check if a session has active subscribers.
   */
  hasSubscribers(sessionId: string): boolean {
    const callbacks = this.sessions.get(sessionId);
    return callbacks !== undefined && callbacks.size > 0;
  }

  /**
   * Get the number of subscribers for a session.
   */
  getSubscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * Clean up all subscriptions and buffered events for a session.
   */
  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
    this.pendingInitialTurns.delete(sessionId);
  }

  /**
   * Reset all subscriptions and buffers (test helper).
   */
  reset(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.pendingInitialTurns.clear();
    this.removeAllListeners();
  }
}

/** Singleton instance of the planning stream manager */
/*
FNXC:PlanningStreamCatchup 2026-07-22-21:00:
Reconnecting clients (mobile tab switches unmount the Planning view, so every return opens a
fresh SSE connection) rebuild the loading view exclusively from the buffered-event replay.
The default 100-event buffer only held a suffix of a turn's thinking deltas, which forced the
client to pre-seed from persisted thinkingOutput and then receive the replay again — the
"generation duplicates every time I come back" report. The buffer must be deep enough to hold
a full turn of thinking deltas so replay alone reconstructs the view exactly once.
*/
export const planningStreamManager = new PlanningStreamManager(2000);

// ── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Check if IP can create a new planning session.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry) {
    // First request from this IP
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Check if window has expired
  if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Within window - check limit
  if (entry.count >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    return false;
  }

  // Increment count
  entry.count++;
  return true;
}

/**
 * Get rate limit reset time for an IP.
 * Returns null if no rate limit entry exists.
 */
export function getRateLimitResetTime(ip: string): Date | null {
  const entry = rateLimits.get(ip);
  if (!entry) return null;

  return new Date(entry.firstRequestAt.getTime() + RATE_LIMIT_WINDOW_MS);
}

// ── Session Management ───────────────────────────────────────────────────────

/**
 * Create a new planning session.
 * Uses stubbed AI logic for immediate response (no streaming).
 * For streaming AI responses, use createSessionWithAgent.
 */
export async function createSession(
  ip: string,
  initialPlan: string,
  store?: TaskStore,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
  options?: Pick<PlanningSessionOptions, "ntfyConfig" | "messageStore" | "clarificationEnabled" | "workflowId" | "sourceIssue">,
): Promise<{ sessionId: string; firstQuestion: PlanningQuestion; summary: PlanningSummary; validated: boolean }> {
  // Check rate limit
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} planning sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  if (!rootDir) {
    throw new Error("rootDir is required for AI-powered planning sessions");
  }
  if (!store) {
    throw new Error("store is required for AI-powered planning sessions");
  }

  const sessionId = randomUUID();

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    title: initialPlan.slice(0, 120),
    history: [],
    summary: buildRunningSummary(initialPlan, []),
    validated: false,
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    store,
    rootDir,
    pluginRunner,
    clarificationEnabled: options?.clarificationEnabled === true,
    workflowId: options?.workflowId,
    sourceIssue: options?.sourceIssue,
    ntfyConfig: options?.ntfyConfig,
  };

  session.taskOutputLanguage = await ensurePlanningOutputLanguage(session, store);
  sessions.set(sessionId, session);
  beginPlanningGeneration(session, "initial_plan");
  persistSession(session, "generating");

  /*
  FNXC:PlanningProviderErrors 2026-07-23-20:10:
  Once the session row is persisted "generating", every failure on the way to the first
  question (system-prompt resolution, agent construction, the provider prompt itself) must
  land the session in a retryable persisted "error" state before rethrowing to the route.
  Previously a provider error thrown here left the row "generating" forever with no error
  and no watchdog, so the session appeared stuck on "Generating plan" until a server restart.
  */
  try {
    return await runCreateSessionFirstTurn(session, rootDir, store, promptOverrides, pluginRunner);
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError") && !session.error) {
      setSessionError(session, err instanceof Error ? err.message : "Failed to initialize AI agent");
    }
    throw err;
  }
}

/** First turn of the legacy synchronous planning start; see the provider-error guard in createSession. */
async function runCreateSessionFirstTurn(
  session: Session,
  rootDir: string,
  store: TaskStore,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<{ sessionId: string; firstQuestion: PlanningQuestion; summary: PlanningSummary; validated: boolean }> {
  const sessionId = session.id;
  const systemPrompt = await resolvePlanningModeSystemPrompt(
    store,
    promptOverrides,
    session.workflowId,
    await ensurePlanningOutputLanguage(session, store),
  );

  // Create AI agent and get the first question
  // Only await engineReady if createFnAgent hasn't been set externally (e.g., via __setCreateFnAgent)
  if (!createFnAgent) {
    await ensureEngineReady();
  }

  const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, pluginRunner);

  /*
  FNXC:PlanningModelRehydration 2026-07-24-16:20:
  The non-streaming start is the same surface as the streaming start and the rebuild path:
  it must resolve an explicit provider/model pair instead of leaving the runtime on its
  built-in default. See resolveSessionPlanningModel for why an unset pair is a live bug.
  */
  const { provider: startProvider, modelId: startModelId } = await resolveSessionPlanningModel(session, store);

  /*
  FNXC:PlanningSkills 2026-06-17-19:33:
  Planning sessions are agent-acting lanes with planning and workflow tools, so they must request the same executor role fallback plus enabled plugin skills (for example ce-debug) as task execution sessions.
  */
  const agentResult = await createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    builtinToolsAllowlist: [...PLANNING_BUILTIN_WEB_TOOLS],
    // FNXC:McpConfig 2026-06-25-22:31: Planning/chat session creation resolves trusted MCP servers through the dashboard-scoped store and forwards only the materialized in-memory set to the engine runtime guard.
    // FNXC:McpConfig 2026-06-29-00:00: Planning sessions are intentionally read-only but still need configured MCP documentation/context tools; opt in at the session boundary while preserving engine-side namespacing, filtering, wrappers, and disposal.
    mcpServers: await resolvePlanningMcpServers(store),
    allowMcpToolsInReadonly: true,
    customTools: [
      ...createPlanningBoardTools(store),
      ...createWorkflowAuthoringTools(store, PLANNING_NO_AMBIENT_TASK_ID, { stripApprovalFlags: true }),
      /*
      FNXC:PlanningTools 2026-06-18-07:11:
      FN-6640 gives planning agents parity with chat for `fn_task_document_write` and `fn_task_document_read` after FN-6635. The planning lane has no ambient task (`PLANNING_NO_AMBIENT_TASK_ID`), so these document tools must require an explicit `task_id`, mirroring no-ambient workflow authoring tools.

      FNXC:ArtifactRegistry 2026-06-21-00:00:
      Planning sessions do not own the dashboard MessageStore, so artifact tools stay excluded here until the planning lane can thread the same inbox dependency as chat. This preserves the FN-6778 requirement that registration notifications use an existing MessageStore rather than constructing a new one.
      */
      ...createChatTaskDocumentTools(store),
      createChatTaskLogsReadTool(store),
    ],
    ...(startProvider && startModelId
      ? { defaultProvider: startProvider, defaultModelId: startModelId }
      : {}),
    ...(pluginRunner ? { pluginRunner } : {}),
    onThinking: () => {
      // Non-streaming path ignores thinking output
    },
    onText: () => {
      // Non-streaming path ignores incremental text
    },
  });

  session.agent = agentResult;
  session.updatedAt = new Date();

  const firstResponse = await getFirstQuestionFromAgent(session, formatInitialPlanRequestForAgent(session.initialPlan));

  const firstQuestion = firstResponse.data;
  session.currentQuestion = firstQuestion;
  session.summary = mergeRunningSummary(session, firstResponse);
  session.updatedAt = new Date();
  await persistSession(session, "awaiting_input");
  void maybeNotifyPlanningAwaitingInput(session, firstQuestion, true);

  return { sessionId, firstQuestion, summary: session.summary, validated: false };
}

/**
 * Get the first question from the AI agent by sending the initial plan.
 * Waits for the agent response and parses it as a PlanningQuestion.
 * Throws if the agent returns a summary instead of a question.
 */
async function getFirstQuestionFromAgent(
  session: Session,
  message: string,
): Promise<Extract<PlanningResponse, { type: "question" }>> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  // Send message to agent (context-limit aware — see promptPlanningAgent)
  await promptPlanningAgent(session.agent.session, message);

  // Extract response text
  interface AgentMessage {
    role: string;
    content?: string | Array<{ type: string; text?: string; thinking?: string }>;
  }
  const lastMessage = (session.agent.session.state.messages as AgentMessage[])
    .filter((m: AgentMessage) => m.role === "assistant")
    .pop();

  let responseText = "";
  if (lastMessage?.content) {
    if (typeof lastMessage.content === "string") {
      responseText = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      // Try text blocks first
      const textContent = lastMessage.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      if (textContent) {
        responseText = textContent;
      } else {
        // Fallback: extract thinking blocks when no text blocks are present
        const thinkingContent = lastMessage.content
          .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
          .map((c) => c.thinking)
          .join("");
        responseText = thinkingContent;
      }
    }
  }

  // Diagnostic: warn when response text is empty or very short
  if (!responseText || responseText.length < 10) {
    const contentBlockTypes = Array.isArray(lastMessage?.content)
      ? lastMessage.content.map((c: { type: string }) => c.type)
      : typeof lastMessage?.content === "string" ? ["string"] : [];
    diagnostics.warn(
      "Response text is empty or very short before parse",
      {
        sessionId: session.id,
        responseTextLength: responseText.length,
        contentBlockTypes,
        usedThinkingBlocksFallback: !Array.isArray(lastMessage?.content) ? false : !lastMessage.content.some((c: { type: string }) => c.type === "text"),
        operation: "response-extraction",
      }
    );
  }

  // Parse response with retry
  let parsed: PlanningResponse | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    try {
      parsed = parseAgentResponse(responseText);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_PARSE_RETRIES) {
        try {
          await promptPlanningAgent(
            session.agent.session,
            "Your previous response could not be parsed as JSON. " +
            'Please respond with ONLY a valid JSON object: {"type":"question","data":{"runningPlan":{...},...}}. ' +
            "No markdown, no explanation, just the JSON."
          );

          const retryMessage = (session.agent.session.state.messages as AgentMessage[])
            .filter((m: AgentMessage) => m.role === "assistant")
            .pop();

          if (retryMessage?.content) {
            if (typeof retryMessage.content === "string") {
              responseText = retryMessage.content;
            } else if (Array.isArray(retryMessage.content)) {
              const textContent = retryMessage.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("");
              if (textContent) {
                responseText = textContent;
              } else {
                const thinkingContent = retryMessage.content
                  .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
                  .map((c) => c.thinking)
                  .join("");
                responseText = thinkingContent;
              }
            }
          }
        } catch (retryPromptErr) {
          // FNXC:PlanningProviderErrors 2026-07-23-20:10: a provider failure on the reformat prompt must surface as itself, not as a misleading "no valid JSON" parse error.
          lastError = retryPromptErr instanceof Error ? retryPromptErr : new Error(String(retryPromptErr));
          break;
        }
      }
    }
  }

  if (!parsed) {
    const errorMessage = buildRetryableParseErrorMessage(lastError);
    setSessionError(session, errorMessage);
    // Keep the session and persisted error state so retry can reuse the original project context.
    try {
      await session.agent.session.dispose?.();
    } catch (disposeErr) {
      diagnostics.warn("Failed to dispose planning agent after first question failure", {
        sessionId: session.id,
        message: disposeErr instanceof Error ? disposeErr.message : String(disposeErr),
        operation: "dispose-after-first-question-failure",
      });
    }
    session.agent = undefined;
    throw new Error(`Failed to get first question from AI: ${errorMessage}`);
  }

  if (parsed.type === "question") {
    return {
      type: "question",
      data: {
        ...normalizePlanningQuestion(parsed.data, session.initialPlan),
        ...(parsed.data.runningPlan ? { runningPlan: parsed.data.runningPlan } : {}),
      },
    };
  }

  /*
  FNXC:PlanningMode 2026-07-20-00:00:
  FN-8434 preserves a legacy complete payload's plan as a running-plan update while still
  coercing its control flow into a question. Only the user Validate action may terminalize.
  */
  const mandatoryQuestion = await requestMandatoryFirstPlanningQuestion(session);
  return { type: "question", data: { ...mandatoryQuestion.data, runningPlan: parsed.data } };
}

function buildMandatoryFirstPlanningQuestion(userInput = ""): PlanningQuestion {
  const fallback = planningFallbackCopy(userInput);
  return normalizePlanningQuestion({
    id: "mandatory-planning-clarification",
    type: "single_select",
    question: fallback.question,
  }, userInput);
}

async function requestMandatoryFirstPlanningQuestion(
  session: Session,
  abortSignal?: AbortSignal,
): Promise<{ type: "question"; data: PlanningQuestion }> {
  try {
    await promptPlanningAgent(
      session.agent!.session,
      'Before producing a plan, ask one clarifying question. Return ONLY valid JSON: {"type":"question","data":{...}}.',
      { signal: abortSignal },
    );
    const retryMessage = (session.agent!.session.state.messages as AgentMessage[])
      .filter((m) => m.role === "assistant")
      .pop();
    const retryText = typeof retryMessage?.content === "string"
      ? retryMessage.content
      : Array.isArray(retryMessage?.content)
        ? retryMessage.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("")
        : "";
    const retryResponse = parseAgentResponse(retryText);
    if (retryResponse.type === "question") {
      return { type: "question", data: normalizePlanningQuestion(retryResponse.data, session.initialPlan) };
    }
  } catch (error) {
    diagnostics.warn("Agent did not supply the mandatory first planning question", {
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
      operation: "mandatory-first-question",
    });
  }
  return { type: "question", data: buildMandatoryFirstPlanningQuestion(session.initialPlan) };
}

export async function createDraftSession(
  ip: string,
  initialPlan: string,
  _rootDir: string,
  modelProvider?: string,
  modelId?: string,
  thinkingLevelOrPromptOverrides?: ThinkingLevel | PromptOverrideMap,
  _promptOverridesOrOptions?: PromptOverrideMap | { projectId?: string; taskOutputLanguage?: ResolvedTaskOutputLanguage },
  optionsMaybe?: { projectId?: string; taskOutputLanguage?: ResolvedTaskOutputLanguage },
): Promise<{ sessionId: string; title: string }> {
  const thinkingLevel = isThinkingLevel(thinkingLevelOrPromptOverrides) ? thinkingLevelOrPromptOverrides : undefined;
  const options = (isThinkingLevel(thinkingLevelOrPromptOverrides) ? optionsMaybe : _promptOverridesOrOptions) as { projectId?: string; taskOutputLanguage?: ResolvedTaskOutputLanguage } | undefined;
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} planning sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`,
    );
  }

  const sessionId = randomUUID();
  const title = DRAFT_PLACEHOLDER_TITLE;

  // Pair modelProvider+modelId — the runtime treats half-set overrides as
  // invalid (resolveTaskPlanningModel etc.), so persist nothing rather than
  // a half-configured override that would mislead reopen.
  const hasModelOverride = Boolean(modelProvider && modelId);

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    title,
    projectId: options?.projectId,
    /* FNXC:TaskOutputLanguage 2026-08-19-16:01: Draft creation receives the server-resolved target so title generation and a later start share one immutable language snapshot. */
    taskOutputLanguage: options?.taskOutputLanguage,
    draftModelProvider: hasModelOverride ? modelProvider : undefined,
    draftModelId: hasModelOverride ? modelId : undefined,
    draftThinkingLevel: thinkingLevel,
    // Draft creation has no resolved settings context; startExistingSession
    // applies the request override/global default before generation begins.
    clarificationEnabled: undefined,
    history: [],
    summary: buildRunningSummary(initialPlan, []),
    validated: false,
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  persistSession(session, "draft");

  return { sessionId, title };
}

/**
 * Replace a draft session's placeholder sidebar title with an AI-summarized
 * one derived from the latest persisted initialPlan. Bounded by status, not
 * by title content, so a user who blurs once then keeps editing still gets
 * the title refreshed on subsequent blurs/close (otherwise the title would
 * lock to the first summary and silently diverge from what they typed).
 *  - Only runs against rows still in `draft` status — once a session has been
 *    started, its title is owned by the start path / final summary and must
 *    not be overwritten by a stale draft summarize call that arrives late.
 *  - Reads the current initialPlan and any persisted model override from
 *    SQLite so the summary reflects whatever the latest debounced PATCH
 *    /draft persisted, and uses the model the draft was created under.
 *  - Re-checks status (not title) after the model call to detect a
 *    concurrent start and avoid clobbering the generating/awaiting_input
 *    title with a stale draft summary.
 *
 * Returns the resolved title (existing or freshly generated) or null if the
 * session was not eligible for summarization.
 */
/*
FNXC:PlanningMode 2026-07-19-12:00:
User session names are an explicit Planning Mode control, unlike AI draft summarization. Keep the
planning-type predicate beside the persistence seam so a by-id dashboard route can never rename chat sessions.
*/
export async function updatePlanningSessionTitle(sessionId: string, title: string): Promise<boolean> {
  if (!_aiSessionStore) return false;

  const row = await _aiSessionStore.get(sessionId);
  if (!row || row.type !== "planning") return false;

  const changed = await _aiSessionStore.updateTitle(sessionId, title);
  if (changed) {
    const session = sessions.get(sessionId);
    if (session) session.title = title;
  }
  return changed;
}

export async function summarizeDraftTitle(
  sessionId: string,
  rootDir: string,
  modelProvider?: string,
  modelId?: string,
  settings?: Partial<Settings>,
): Promise<string | null> {
  if (!_aiSessionStore) return null;

  const row = await _aiSessionStore.get(sessionId);
  if (!row || row.type !== "planning" || row.status !== "draft") {
    return null;
  }

  const payload = safeParseJson<DraftInputPayload>(row.inputPayload, {});
  const trimmed = (payload.initialPlan ?? "").trim();
  if (!trimmed) return null;

  // Prefer the model the draft was created under; fall back to the caller-
  // supplied override (e.g. project/global planning settings).
  const effectiveProvider = payload.modelProvider ?? modelProvider;
  const effectiveModelId = payload.modelId ?? modelId;

  const outputLanguage = payload.taskOutputLanguage ?? resolveTaskOutputLanguage(settings, trimmed);
  /* FNXC:TaskOutputLanguage 2026-08-19-16:01: Legacy drafts without a target capture it before title generation, fencing subsequent retries and rehydration from later settings changes. */
  if (!payload.taskOutputLanguage) {
    await _aiSessionStore.updateDraft(sessionId, {
      initialPlan: payload.initialPlan ?? "",
      modelProvider: payload.modelProvider,
      modelId: payload.modelId,
      thinkingLevel: payload.thinkingLevel,
      taskOutputLanguage: outputLanguage,
    });
  }
  const inMemory = sessions.get(sessionId);
  if (inMemory && !inMemory.taskOutputLanguage) {
    inMemory.taskOutputLanguage = outputLanguage;
    void persistSession(inMemory, "draft");
  }

  let finalTitle = trimmed.slice(0, 60).trim();
  try {
    const generated = await summarizeTitle(trimmed, rootDir, effectiveProvider, effectiveModelId, outputLanguage);
    finalTitle = generated?.trim() || finalTitle;
  } catch (error) {
    diagnostics.errorFromException(
      "summarizeDraftTitle: model call failed, falling back to truncated text",
      error,
      { sessionId, operation: "summarize-draft-title" },
    );
  }

  if (!finalTitle) return null;

  // Re-check status (not title) so a concurrent Start Planning or a later
  // edit-then-blur cycle doesn't overwrite a real generating/complete title.
  const latest = await _aiSessionStore.get(sessionId);
  if (!latest || latest.type !== "planning" || latest.status !== "draft") {
    return latest?.title ?? null;
  }

  _aiSessionStore.markDraftSummarized(sessionId, finalTitle, trimmed).catch(() => { /* best-effort */ });
  const session = sessions.get(sessionId);
  if (session) {
    session.title = finalTitle;
    session.draftSummarizedFor = trimmed;
  }
  return finalTitle;
}

export async function startExistingSession(
  sessionId: string,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  thinkingLevelOrPromptOverrides?: ThinkingLevel | PromptOverrideMap,
  promptOverridesOrPluginRunner?: PromptOverrideMap | SkillPluginRunner,
  pluginRunnerMaybe?: SkillPluginRunner,
  runtimeOptions?: Pick<PlanningSessionOptions, "ntfyConfig" | "messageStore" | "clarificationEnabled" | "workflowId" | "sourceIssue">,
): Promise<void> {
  const thinkingLevel = isThinkingLevel(thinkingLevelOrPromptOverrides) ? thinkingLevelOrPromptOverrides : undefined;
  const promptOverrides = isThinkingLevel(thinkingLevelOrPromptOverrides)
    ? (promptOverridesOrPluginRunner as PromptOverrideMap | undefined)
    : (thinkingLevelOrPromptOverrides as PromptOverrideMap | undefined);
  const pluginRunner = (isThinkingLevel(thinkingLevelOrPromptOverrides) ? pluginRunnerMaybe : promptOverridesOrPluginRunner) as SkillPluginRunner | undefined;
  let session = sessions.get(sessionId);
  if (session && runtimeOptions?.workflowId) session.workflowId = runtimeOptions.workflowId;
  if (session && runtimeOptions?.sourceIssue) session.sourceIssue = runtimeOptions.sourceIssue;

  // Draft sessions aren't included in rehydrateFromStore (which only loads
  // recoverable in-flight sessions), and a backend restart drops the in-memory
  // map entirely. Rebuild lazily from SQLite so persisted drafts can still be
  // started after a restart, and so updateDraft-only state survives.
  if (!session && _aiSessionStore) {
    const row = await _aiSessionStore.get(sessionId);
    if (row && row.type === "planning") {
      try {
        session = buildSessionFromRow(row);
        sessions.set(sessionId, session);
      } catch (error) {
        diagnostics.errorFromException(
          "Failed to rebuild planning session from store",
          error,
          { sessionId, operation: "start-existing-rebuild" },
        );
      }
    }
  }

  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }
  if (runtimeOptions?.workflowId) session.workflowId = runtimeOptions.workflowId;
  if (runtimeOptions?.sourceIssue) session.sourceIssue = runtimeOptions.sourceIssue;

  // Drafts are sync'd via aiSessionStore.updateDraft, which only writes
  // SQLite. Pull the latest initialPlan + persisted model override + the
  // text the current title was already summarized from. Lets the agent
  // see everything the user typed, lets summarize use the original model,
  // and lets us skip a redundant model call when blur/close already
  // summarized this exact text.
  let persistedProvider: string | undefined;
  let persistedModelId: string | undefined;
  let persistedThinkingLevel: ThinkingLevel | undefined;
  let persistedSummarizedFor: string | undefined;
  let cameFromDraft = false;
  if (_aiSessionStore) {
    const row = await _aiSessionStore.get(sessionId);
    if (row) {
      cameFromDraft = row.status === "draft";
      const payload = safeParseJson<DraftInputPayload>(row.inputPayload, {});
      if (payload.initialPlan) {
        session.initialPlan = payload.initialPlan;
      }
      persistedProvider = payload.modelProvider;
      persistedModelId = payload.modelId;
      persistedThinkingLevel = isThinkingLevel(payload.thinkingLevel) ? payload.thinkingLevel : undefined;
      if (payload.taskOutputLanguage) session.taskOutputLanguage = payload.taskOutputLanguage;
      persistedSummarizedFor = payload.summarizedFor;
    }
  }

  await ensurePlanningOutputLanguage(session, store);

  // Re-summarize when transitioning out of draft so the title reflects the
  // FINAL text — but skip the model call when blur/close already produced a
  // summary for this exact text and the user hasn't edited since. Saves
  // tokens when the user blurs the textarea then immediately clicks Start.
  if (cameFromDraft) {
    const trimmed = session.initialPlan.trim();
    const alreadySummarized =
      session.title !== DRAFT_PLACEHOLDER_TITLE && persistedSummarizedFor === trimmed;
    if (!alreadySummarized) {
      const fallback = trimmed.slice(0, 60).trim();
      if (session.title === DRAFT_PLACEHOLDER_TITLE) {
        session.title = fallback || DRAFT_PLACEHOLDER_TITLE;
      }
      const summarizeProvider = modelProvider ?? persistedProvider;
      const summarizeModelId = modelId ?? persistedModelId;
      void (async () => {
        try {
          const generated = await summarizeTitle(trimmed, rootDir, summarizeProvider, summarizeModelId, session.taskOutputLanguage);
          const finalTitle = generated?.trim() || fallback;
          if (!finalTitle) return;
          session.title = finalTitle;
          _aiSessionStore?.updateTitle(sessionId, finalTitle);
        } catch {
          // Keep fallback title
        }
      })();
    }
  }

  session.draftThinkingLevel = thinkingLevel ?? persistedThinkingLevel;
  if (runtimeOptions) {
    session.clarificationEnabled = runtimeOptions.clarificationEnabled === true;
    session.ntfyConfig = runtimeOptions.ntfyConfig;
  }

  /*
  FNXC:PlanningTurnAdmission 2026-07-22-21:00:
  Starting an existing session must be idempotent while its generation is in flight. A
  remounted client (mobile tab switches unmount the Planning view) could re-issue
  start-streaming for a session that is already generating; previously this displaced the
  live generation and disposed its agent mid-prompt. Now the duplicate start is a no-op and
  the client simply reconnects to the stream of the run already in progress.
  */
  if (isPlanningTurnActive(sessionId) || planningStreamManager.hasPendingInitialTurn(sessionId)) {
    diagnostics.warn("Ignoring duplicate start for planning session with an active generation", {
      sessionId,
      operation: "start-existing-duplicate",
    });
    return;
  }

  /*
  FNXC:PlanningTurnAdmission 2026-07-23-08:30:
  The duplicate-start guard and the initial-turn registration must be one synchronous block —
  no await between them. With persistSession in between, two concurrent duplicate starts could
  both pass the guard and the second registerInitialTurn threw "Initial planning turn already
  registered" for a normal duplicate start (review finding on PR #2417). Registration IS the
  claim; persistence follows it.
  */
  beginPlanningGeneration(session, "initial_plan");
  planningStreamManager.registerInitialTurn(sessionId, () => {
    session.pluginRunner = pluginRunner;
    initializeAgent(session, rootDir, store, modelProvider, modelId, session.draftThinkingLevel, promptOverrides, pluginRunner).catch((err) => {
      diagnostics.errorFromException("Failed to initialize agent for session", err, { sessionId, operation: "initialize-agent" });
      persistSession(session, "error", err.message || "Failed to initialize AI agent");
      planningStreamManager.broadcast(sessionId, {
        type: "error",
        data: err.message || "Failed to initialize AI agent",
      });
    });
  });
  await persistSession(session, "generating");
}

/**
 * Create a new planning session with AI agent streaming.
 * This initializes an AI agent that will stream thinking output via SSE.
 * 
 * @param ip - Client IP for rate limiting
 * @param initialPlan - The user's initial plan description
 * @param rootDir - Project root directory for AI agent context
 * @param modelProvider - Optional AI model provider override
 * @param modelId - Optional AI model ID override
 * @param promptOverrides - Optional prompt override map for system prompt customization
 * @returns Session ID (use with planningStreamManager to receive events)
 */
export async function createSessionWithAgent(
  ip: string,
  initialPlan: string,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  thinkingLevelOrPromptOverrides?: ThinkingLevel | PromptOverrideMap,
  promptOverridesOrOptions?: PromptOverrideMap | PlanningSessionOptions,
  optionsMaybe?: PlanningSessionOptions,
): Promise<string> {
  const thinkingLevel = isThinkingLevel(thinkingLevelOrPromptOverrides) ? thinkingLevelOrPromptOverrides : undefined;
  const promptOverrides = isThinkingLevel(thinkingLevelOrPromptOverrides)
    ? (promptOverridesOrOptions as PromptOverrideMap | undefined)
    : (thinkingLevelOrPromptOverrides as PromptOverrideMap | undefined);
  const options = (isThinkingLevel(thinkingLevelOrPromptOverrides) ? optionsMaybe : promptOverridesOrOptions) as PlanningSessionOptions | undefined;
  // Check rate limit
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} planning sessions per hour. ` +
        `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  const sessionId = randomUUID();

  const session: Session = {
    id: sessionId,
    ip,
    initialPlan,
    title: initialPlan.slice(0, 120),
    projectId: options?.projectId,
    workflowId: options?.workflowId,
    sourceIssue: options?.sourceIssue,
    ntfyConfig: options?.ntfyConfig
      ? {
          enabled: options.ntfyConfig.enabled,
          topic: options.ntfyConfig.topic,
          dashboardHost: options.ntfyConfig.dashboardHost,
          events: options.ntfyConfig.events ? [...options.ntfyConfig.events] : undefined,
          ntfyBaseUrl: options.ntfyConfig.ntfyBaseUrl,
        }
      : undefined,
    clarificationEnabled: options?.clarificationEnabled === true,
    history: [],
    summary: buildRunningSummary(initialPlan, []),
    validated: false,
    thinkingOutput: "",
    lastGeneratedThinking: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    draftThinkingLevel: thinkingLevel,
    pluginRunner: options?.pluginRunner,
  };

  session.taskOutputLanguage = await ensurePlanningOutputLanguage(session, store);
  sessions.set(sessionId, session);
  beginPlanningGeneration(session, "initial_plan");
  await persistSession(session, "generating");

  planningStreamManager.registerInitialTurn(sessionId, () => {
    initializeAgent(
      session,
      rootDir,
      store,
      modelProvider,
      modelId,
      thinkingLevel,
      promptOverrides,
      options?.pluginRunner,
    ).catch((err) => {
      diagnostics.errorFromException("Failed to initialize agent for session", err, { sessionId, operation: "initialize-agent" });
      persistSession(session, "error", err.message || "Failed to initialize AI agent");
      planningStreamManager.broadcast(sessionId, {
        type: "error",
        data: err.message || "Failed to initialize AI agent",
      });
    });
  });

  return sessionId;
}

/**
 * Initialize the AI agent for a session and start the first turn.
 */
async function initializeAgent(
  session: Session,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  thinkingLevel?: ThinkingLevel,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<void> {
  /*
  FNXC:PlanningTurnAdmission 2026-07-22-21:00:
  The initial turn reserves the session's single turn slot synchronously (this runs inside
  consumeInitialTurn's synchronous callback). A duplicate initial turn racing an admitted
  generation exits quietly instead of displacing it and disposing its agent mid-prompt.
  */
  let releaseTurn: () => void;
  try {
    releaseTurn = reservePlanningTurn(session.id);
  } catch (err) {
    if (err instanceof GenerationInProgressError) {
      diagnostics.warn("Skipping duplicate initial planning turn — generation already active", {
        sessionId: session.id,
        operation: "initialize-agent-duplicate",
      });
      return;
    }
    throw err;
  }
  try {
    await runGenerationWithTimeout(session, async (abortSignal) => {
      /*
      FNXC:PlanningSession 2026-06-16-20:23:
      FN-6511 requires planning agent construction to be bounded before the first prompt starts. Keep createFnAgent inside the active generation timeout so model-registry or extension-discovery stalls transition the SSE session to a terminal error instead of leaving it pinned in generating.
      */
      const agentPromise = createPlanningAgent(
        session,
        rootDir,
        store,
        modelProvider,
        modelId,
        thinkingLevel,
        promptOverrides,
        pluginRunner,
      );

      void agentPromise.then((lateAgent) => {
        if (abortSignal.aborted) {
          nonfatal(
            () => lateAgent?.session?.dispose?.(),
            diagnostics,
            "Error disposing late-created planning agent",
            { sessionId: session.id, operation: "dispose-late-agent" },
          );
        }
      }, () => undefined);

      const agent = await agentPromise;
      if (abortSignal.aborted) {
        nonfatal(
          () => agent?.session?.dispose?.(),
          diagnostics,
          "Error disposing aborted planning agent",
          { sessionId: session.id, operation: "dispose-aborted-agent" },
        );
        throw createAbortError();
      }
      session.agent = agent;
      session.updatedAt = new Date();
    });

    await continueAgentConversation(session, formatInitialRunningPlanRequestForAgent(session.initialPlan));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }

    const errorMessage = err instanceof Error ? err.message : "Failed to initialize AI agent";
    diagnostics.errorFromException("Agent initialization error for session", err, { sessionId: session.id, operation: "initialize-agent" });
    session.error = errorMessage;
    session.updatedAt = new Date();
    persistSession(session, "error", errorMessage);
    planningStreamManager.broadcast(session.id, {
      type: "error",
      data: errorMessage,
    });
  } finally {
    releaseTurn();
  }
}

async function createPlanningAgent(
  session: Session,
  rootDir: string,
  store: TaskStore,
  modelProvider?: string,
  modelId?: string,
  thinkingLevel?: ThinkingLevel,
  promptOverrides?: PromptOverrideMap,
  pluginRunner?: SkillPluginRunner,
): Promise<AgentResult> {
  // Ensure engine is loaded before using createFnAgent
  await ensureEngineReady();

  const systemPrompt = await resolvePlanningModeSystemPrompt(
    store,
    promptOverrides,
    session.workflowId,
    await ensurePlanningOutputLanguage(session, store),
  );

  const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, pluginRunner);

  /*
  FNXC:PlanningTurnAdmission 2026-07-23-10:40:
  Capture the callback epoch at agent creation. A provider that ignores cancellation beyond
  rewind's bounded settle-wait can keep streaming after this agent is disposed; the epoch
  check makes those late deltas inert (no thinkingOutput mutation, no persist, no broadcast)
  instead of letting them corrupt the state published after the agent was replaced.
  */
  const callbackEpoch = session.agentCallbackEpoch ?? 0;
  const callbacksInvalidated = (): boolean => (session.agentCallbackEpoch ?? 0) !== callbackEpoch;

  /*
  FNXC:PlanningSkills 2026-06-17-19:33:
  Streaming planning sessions share the executor skill contract because custom planning/workflow tools can benefit from agent-declared skills and enabled plugin skills exactly like task execution.
  */
  return createFnAgent({
    cwd: rootDir,
    systemPrompt,
    tools: "readonly",
    ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    builtinToolsAllowlist: [...PLANNING_BUILTIN_WEB_TOOLS],
    // FNXC:McpConfig 2026-06-25-22:31: Streaming planning uses the same dashboard-scoped MCP resolution seam as non-streaming planning so no planning lane silently drops enabled servers.
    // FNXC:McpConfig 2026-06-29-00:00: Streaming planning uses the explicit read-only MCP opt-in; non-planning read-only lanes remain denied unless they set the same reviewed policy flag.
    mcpServers: await resolvePlanningMcpServers(store),
    allowMcpToolsInReadonly: true,
    customTools: [
      ...createPlanningBoardTools(store),
      ...createWorkflowAuthoringTools(store, PLANNING_NO_AMBIENT_TASK_ID, { stripApprovalFlags: true }),
      /* FNXC:ArtifactRegistry 2026-06-21-00:00: Streaming planning excludes artifact tools for the same reason as non-streaming planning: this module has no MessageStore dependency to provide best-effort dashboard inbox notifications. */
      ...createChatTaskDocumentTools(store),
      createChatTaskLogsReadTool(store),
    ],
    ...(modelProvider && modelId
      ? {
          defaultProvider: modelProvider,
          defaultModelId: modelId,
        }
      : {}),
    ...(thinkingLevel ? { defaultThinkingLevel: thinkingLevel } : {}),
    // Runtime resolution needs the plugin runner to see plugin-provided runtimes.
    ...(pluginRunner ? { pluginRunner } : {}),
    onThinking: (delta: string) => {
      if (callbacksInvalidated()) return;
      markPlanningGenerationProgress(session.id, delta);
      session.thinkingOutput += delta;
      persistThinking(session.id, session.thinkingOutput);
      planningStreamManager.broadcast(session.id, {
        type: "thinking",
        data: delta,
      });
    },
    onText: (delta: string) => {
      // Capture AI response text — will be parsed at end of turn. Also
      // surface it through the same stream so non-thinking models (which
      // never emit thinking_delta) still show streaming output in the UI.
      if (callbacksInvalidated()) return;
      markPlanningGenerationProgress(session.id, delta);
      session.thinkingOutput += delta;
      persistThinking(session.id, session.thinkingOutput);
      planningStreamManager.broadcast(session.id, {
        type: "thinking",
        data: delta,
      });
    },
  });
}

function buildHistoryReplayPrompt(
  history: Array<{ question: PlanningQuestion; response: unknown }>,
): string {
  const interviewSummary = formatInterviewQA(history);
  if (!interviewSummary) {
    return "No prior planning interview context is available.";
  }

  return [
    "Previous conversation summary:",
    interviewSummary,
    "Treat every recorded selection and Other answer as an accumulated durable decision. Rebuild affected plan fields around those decisions; do not preserve superseded or unselected alternatives as the plan backbone. Use this as context for the next response. Do not repeat prior questions unless necessary.",
  ].join("\n\n");
}

/*
FNXC:PlanningModelRehydration 2026-07-24-16:20:
A rebuilt planning agent MUST be given the same provider/model pair the session started on. `ensureSessionAgent` previously passed `undefined, undefined` while still preserving `draftThinkingLevel`, so any rebuild — `/planning/respond`, `/planning/:id/retry`, rewind, or a draft resumed after the in-memory agent was dropped — silently discarded the model selection. `createFnAgent`/`createResolvedAgentSession` forward NO `model` when the pair is incomplete (pi.ts `createSessionWithModel`), so pi-coding-agent then picked its OWN built-in default (`anthropic/claude-opus-4-8`). For an operator on a custom provider or a CLI/subscription runtime that means the resumed turn hit `api.anthropic.com` with a raw key they never configured and died on `401 invalid x-api-key` — mid-interview, after earlier turns on the correct model had already streamed. That is the exact reported symptom: the first turns work, the resumed turn does not.

Resolution order mirrors the start route (`register-planning-subtask-routes.ts` → `resolvePlanningSettingsModel`): the pair persisted on the draft wins, then the lane's settings-resolved pair. Both halves must be present — a half-set pair is treated as unset, matching the runtime's own pair semantics.
*/
async function resolveSessionPlanningModel(
  session: Session,
  store: TaskStore,
): Promise<{ provider?: string; modelId?: string }> {
  if (session.draftModelProvider && session.draftModelId) {
    return { provider: session.draftModelProvider, modelId: session.draftModelId };
  }

  try {
    const settings = await store.getSettings();
    const resolved = resolvePlanningSettingsModel(settings);
    if (resolved.provider && resolved.modelId) {
      // Cache onto the session so later rebuilds in this process stay on the
      // same pair even if settings change mid-interview.
      session.draftModelProvider = resolved.provider;
      session.draftModelId = resolved.modelId;
      return { provider: resolved.provider, modelId: resolved.modelId };
    }
  } catch (err) {
    diagnostics.warn("Failed to resolve planning model for rebuilt agent", {
      sessionId: session.id,
      operation: "resolve-session-planning-model",
      error: String(err),
    });
  }

  /*
  No complete pair resolved. The runtime falls back to its built-in default model,
  which is provider-specific and may not match the operator's configured provider —
  warn loudly rather than let that surface as an opaque provider auth error.
  */
  diagnostics.warn(
    "Rebuilt planning agent has no resolved provider/model pair; the runtime will use its built-in default model",
    { sessionId: session.id, operation: "resolve-session-planning-model" },
  );
  return {};
}

async function ensureSessionAgent(
  session: Session,
  rootDir: string | undefined,
  historyForReplay: Array<{ question: PlanningQuestion; response: unknown }>,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<void> {
  if (session.agent) {
    return;
  }

  // Fall back to session-captured context for rehydrated sessions whose
  // submitResponse/retry/rewind call sites don't plumb rootDir/store.
  const effectiveRootDir = rootDir ?? session.rootDir;
  const effectiveStore = store ?? session.store;

  if (!effectiveRootDir) {
    throw new InvalidSessionStateError(
      "Planning session has no AI agent and cannot be resumed without project context",
    );
  }

  if (!effectiveStore) {
    throw new InvalidSessionStateError(
      "Planning session has no task store and cannot be resumed without project context",
    );
  }

  const { provider: resumeProvider, modelId: resumeModelId } = await resolveSessionPlanningModel(
    session,
    effectiveStore,
  );

  session.agent = await createPlanningAgent(
    session,
    effectiveRootDir,
    effectiveStore,
    resumeProvider,
    resumeModelId,
    session.draftThinkingLevel,
    promptOverrides,
    session.pluginRunner,
  );

  if (historyForReplay.length === 0) {
    return;
  }

  const contextMessage = buildHistoryReplayPrompt(historyForReplay);
  await runGenerationWithTimeout(session, async (abortSignal) => {
    /*
    FNXC:AiSessionCancellation 2026-07-13-00:00:
    Planning history replay is an agent prompt surface too. Forward the generation AbortSignal and rely on runGenerationWithTimeout to tear down the in-flight session because Promise.race alone cannot cancel prompt() work.
    */
    if (abortSignal.aborted) {
      throw createAbortError();
    }
    await promptPlanningAgent(session.agent!.session, contextMessage, {
      signal: abortSignal,
    });
    if (abortSignal.aborted) {
      throw createAbortError();
    }
  });
}

async function maybeNotifyPlanningAwaitingInput(
  session: Session,
  question: PlanningQuestion,
  proactiveClarification = false,
): Promise<void> {
  const questionKey = `${session.id}:${question.id}`;

  // Summary deepening checkpoints retain their existing ntfy behavior regardless
  // of the clarification preference; only proactive questions are setting-gated.
  if (proactiveClarification && !session.clarificationEnabled) return;
  const config = session.ntfyConfig;
  if (!config?.enabled || !config.topic) return;

  await ensureNtfyHelpersReady();
  const eventEnabled = planningNtfyHelpers?.isNtfyEventEnabled
    ? planningNtfyHelpers.isNtfyEventEnabled(config.events, "planning-awaiting-input")
    : (config.events ? config.events.includes("planning-awaiting-input") : true);
  if (!eventEnabled || session.lastNotifiedQuestionKey === questionKey) return;
  session.lastNotifiedQuestionKey = questionKey;
  if (!planningNtfyHelpers) return;
  try {
    const clickUrl = planningNtfyHelpers.buildNtfyClickUrl({ dashboardHost: config.dashboardHost, projectId: session.projectId });
    await planningNtfyHelpers.sendNtfyNotification({ ntfyBaseUrl: config.ntfyBaseUrl, topic: config.topic,
      title: "Planning needs your input", message: `Planning mode is waiting for input: ${question.question}`, priority: "high", clickUrl });
  } catch (error) {
    diagnostics.warn("Failed to deliver planning awaiting-input ntfy notification", {
      sessionId: session.id, questionId: question.id, error: error instanceof Error ? error.message : String(error), operation: "planning-notify-awaiting-input",
    });
  }
}

/** Max number of retry attempts when AI returns unparseable output */
const MAX_PARSE_RETRIES = 1;

/*
FNXC:PlanningJsonRecovery 2026-06-24-20:58:
Planning Mode malformed AI output must either recover through the bounded reformat prompt to a valid planning response or persist a retryable session error. Parser candidate selection therefore prefers valid planning-shaped JSON over unrelated larger JSON blobs embedded in model prose.
*/

function buildRetryableParseErrorMessage(error: Error | undefined): string {
  // Strip any trailing "Please try again." suffix AND trailing periods so the appended
  // call to action cannot render as "…no valid JSON.. Retry this planning session…".
  const baseMessage = (error?.message || "Failed to parse AI response")
    .replace(/\s*Please try again\.?\s*$/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  return `${baseMessage}. Retry this planning session or start a new one.`;
}

/**
 * Continue the AI conversation with a user message.
 *
 * Includes a bounded recovery path: if the AI response cannot be parsed,
 * one retry attempt is made with a reformat prompt before emitting a
 * terminal session error.
 */
function setSessionError(session: Session, message: string): void {
  session.error = message;
  session.updatedAt = new Date();
  persistSession(session, "error", message);
  planningStreamManager.broadcast(session.id, {
    type: "error",
    data: message,
  });
}

function createAbortError(): Error {
  const error = new Error("Generation aborted");
  error.name = "AbortError";
  return error;
}

/*
FNXC:PlanningProviderErrors 2026-07-23-20:10:
Terminal-state reconciliation for SSE stream connects. Two hang shapes ended with the Planning
modal pinned on "Thinking/Generating plan" with a stream that will never emit again:
1. The session already holds a terminal error, but the buffered error event is gone (the
   client's reconnect loop treats a persisted "generating" row as healthy and the 8s poll only
   reacts to persisted status changes).
2. The session is persisted "generating" with generation metadata set, but no turn is active
   or pending and the generation started longer ago than the inactivity watchdog window — a
   stranded run (e.g. a pre-fix provider-error escape or a crashed generation promise) that no
   watchdog owns anymore.
Returns the terminal error message the stream route must emit before closing, or undefined
when the session is healthy. Only the stale case writes state: it persists the same retryable
error contract as every other planning failure so Retry and the bounded auto-retry recover it.
*/
export function reconcileStalePlanningGeneration(sessionId: string): string | undefined {
  const session = sessions.get(sessionId);
  if (!session || session.validated) return undefined;
  if (isPlanningTurnActive(sessionId) || planningStreamManager.hasPendingInitialTurn(sessionId)) return undefined;
  if (session.error) return session.error;
  if (session.generationPurpose === undefined) return undefined;
  const startedAtMs = session.generationStartedAt ? Date.parse(session.generationStartedAt) : Number.NaN;
  const ageMs = Number.isNaN(startedAtMs) ? Number.POSITIVE_INFINITY : Date.now() - startedAtMs;
  if (ageMs < GENERATION_TIMEOUT_MS) return undefined;
  diagnostics.warn("Reconciling stranded planning generation to a retryable error", {
    sessionId,
    generationPurpose: session.generationPurpose,
    generationStartedAt: session.generationStartedAt,
    operation: "reconcile-stale-generation",
  });
  setSessionError(session, PLANNING_INTERRUPTED_ERROR_MESSAGE);
  return PLANNING_INTERRUPTED_ERROR_MESSAGE;
}

/*
FNXC:PlanningContextCompaction 2026-07-22-22:40:
Long planning interviews accumulate the whole Q/A history in one agent session and can hit the
model's context window mid-interview. Planning previously called session.prompt() raw, so a
context overflow surfaced as a terminal session error — and the auto-retry then replayed the
FULL history into a fresh agent, overflowing again, unrecoverably. Every planning prompt now
routes through the engine's promptWithFallback, which classifies context-limit errors and
recovers via prompt/memory compaction and session.compact() before retrying. Test fakes that
mock @fusion/engine without promptWithFallback fall back to the raw prompt unchanged.
*/
async function promptPlanningAgent(
  agentSession: { prompt: (input: string, options?: { signal?: AbortSignal }) => Promise<void> },
  message: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  let promptWithFallback: ((session: unknown, prompt: string, options?: unknown) => Promise<void>) | undefined;
  try {
    promptWithFallback = (engineModule as {
      promptWithFallback?: (session: unknown, prompt: string, options?: unknown) => Promise<void>;
    }).promptWithFallback;
  } catch {
    // vi.mock("@fusion/engine") proxies throw on undeclared exports; treat as unavailable.
    promptWithFallback = undefined;
  }
  if (typeof promptWithFallback === "function") {
    await promptWithFallback(agentSession, message, options);
    return;
  }
  await agentSession.prompt(message, options);
}

function normalizeGenerationProgress(output: string): string {
  return output.replace(/\s+/g, " ").trim();
}

function markPlanningGenerationProgress(sessionId: string, output: string): void {
  activeGenerations.get(sessionId)?.markProgress(output);
}

async function runGenerationWithTimeout<T>(session: Session, operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
  const existing = activeGenerations.get(session.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.abortReason = "displaced";
    existing.abortTeardown();
    existing.abortController.abort();
  }

  const abortController = new AbortController();
  let lastProgressSignature = "";
  let repeatedProgressCount = 0;

  const abortGeneration = (reason: PlanningGenerationAbortReason, message?: string): void => {
    if (abortController.signal.aborted) {
      return;
    }
    generationRecord.abortReason = reason;
    clearTimeout(generationRecord.timer);
    if (message) {
      diagnostics.warn("Planning generation watchdog aborting session", {
        sessionId: session.id,
        reason,
        operation: "planning-generation-watchdog",
      });
      setSessionError(session, message);
    }
    generationRecord.abortTeardown();
    abortController.abort();
  };

  const scheduleInactivityTimer = (): NodeJS.Timeout => setTimeout(() => {
    abortGeneration("stuck", PLANNING_STUCK_ERROR_MESSAGE);
  }, GENERATION_TIMEOUT_MS);

  const generationRecord: ActivePlanningGeneration = {
    abortController,
    timer: scheduleInactivityTimer(),
    abortTeardownFired: false,
    abortTeardown: () => {
      if (generationRecord.abortTeardownFired) {
        return;
      }
      generationRecord.abortTeardownFired = true;
      /*
      FNXC:AiSessionCancellation 2026-07-13-00:00:
      Planning has a local generation runner instead of GenerationGuard. Abort teardown must run once for timeout, user-stop, displacement, stuck, and loop aborts so an abandoned prompt cannot continue after the Promise.race waiter rejects.
      */
      disposeSessionAgentForRetry(session);
    },
    markProgress: (output: string) => {
      const signature = normalizeGenerationProgress(output);
      if (!signature) {
        return;
      }

      if (signature === lastProgressSignature) {
        repeatedProgressCount += 1;
        if (repeatedProgressCount >= GENERATION_LOOP_REPEAT_LIMIT) {
          abortGeneration("loop", PLANNING_LOOP_ERROR_MESSAGE);
        }
        return;
      }

      lastProgressSignature = signature;
      repeatedProgressCount = 0;
      clearTimeout(generationRecord.timer);
      generationRecord.timer = scheduleInactivityTimer();
    },
  };

  activeGenerations.set(session.id, generationRecord);

  const abortPromise = new Promise<never>((_, reject) => {
    abortController.signal.addEventListener(
      "abort",
      () => reject(createAbortError()),
      { once: true },
    );
  });

  try {
    // Track the operation's own settlement: on abort the race settles immediately while the
    // operation (and its provider prompt) may still be pending — rewind waits on this.
    const operationPromise = operation(abortController.signal);
    trackTurnOperationSettled(session.id, operationPromise);
    return await Promise.race([operationPromise, abortPromise]);
  } finally {
    clearTimeout(generationRecord.timer);
    if (activeGenerations.get(session.id) === generationRecord) {
      activeGenerations.delete(session.id);
    }
  }
}

/*
FNXC:PlanningMode 2026-07-20-00:00:
FN-8434 makes the Running plan an evolving work product, not an interview transcript.
Fallback text may acknowledge answer choices, but interview questions must never become
key deliverables because task creation and breakdown consume those as implementation work.
*/
function describePlanningAnswer(entry: PlanningHistoryEntry): string {
  const response = entry.response && typeof entry.response === "object" && !Array.isArray(entry.response)
    ? entry.response as Record<string, unknown>
    : {};
  const optionLabels = new Map((entry.question.options ?? []).map((option) => [option.id, option.label]));
  const values = Object.entries(response)
    .filter(([key]) => key !== "_comment")
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .filter((value): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map((value) => typeof value === "string" ? optionLabels.get(value) ?? value : String(value));
  const comment = typeof response._comment === "string" ? response._comment.trim() : "";
  return [...values, ...(comment ? [comment] : [])].join(", ") || "a response";
}

/*
FNXC:PlanningMode 2026-07-20-14:30:
FN-8438 requires the first Planning Mode turn to author a plan from the operator idea, and every
following answer to refine that work product. Repeat this contract at the user-message boundary
for both agent entry points because system instructions alone can be displaced by tool context.
*/
export function formatInitialPlanRequestForAgent(initialPlan: string): string {
  return [
    "Create the initial running plan from this operator idea before asking the first interview question.",
    "If the idea is vague, subjective, preference-based, or symptom-only, first inspect the relevant implementation surface and turn those findings into normally 3–5 concrete, materially distinct first-level directions plus exactly one Other option. Two directions are not sufficient; include more when genuinely useful. Do not ask a generic question, invent repository findings, or commit the provisional plan to an unselected direction.",
    "Return only type:\"question\" JSON with a full runningPlan: a work-product title, a concise implementation description, and concrete work-item keyDeliverables derived from the idea.",
    "Then ask exactly one high-impact, option-driven question with normally 3–5 materially distinct alternatives, descriptions, and pros/cons plus one write-your-own option. Two alternatives are not sufficient; include more when genuinely useful. Never use that question text as a deliverable. Do not complete or validate the plan; only the user can validate it.",
    "Operator idea:",
    initialPlan,
  ].join("\n\n");
}

/** Streaming Planning Mode starts with a reviewable work product and one focused question. */
export function formatInitialRunningPlanRequestForAgent(initialPlan: string): string {
  return [
    "Create a concrete initial implementation plan from this operator idea.",
    "Author the operator-facing plan in Markdown. Write the description as concise GitHub-flavored Markdown; the structured proposed changes, acceptance criteria, dependencies, and deliverables will render as Markdown sections and lists.",
    "Inspect the relevant codebase and active-board context before drafting it. For a vague, subjective, preference-based, or symptom-only idea, turn that inspection into normally 3–5 concrete, materially distinct direction options plus exactly one Other option. Two directions are not sufficient; include more when genuinely useful. Do not invent findings or preselect a direction. Make the provisional description specific about the affected behavior and intended outcome without falsely committing to an unselected direction. Provide concrete proposedChanges that name what behavior, component, interface, data, or configuration should change, and acceptanceCriteria stated as observable pass/fail outcomes. Make every key deliverable an actionable work item rather than generic planning advice.",
    "Also propose concise suggestedRefinements covering every distinct, high-value unresolved area the operator could explore next; do not cap the list at three.",
    "Return only type:\"question\" JSON with the complete plan in runningPlan and exactly one high-impact, option-driven next question. Give that question normally 3–5 useful, materially distinct alternatives with descriptions, pros, and cons, plus one write-your-own option; two alternatives are not sufficient, and a genuinely useful larger set is welcome. Do not validate the plan; only the operator can proceed with it.",
    "Operator idea:",
    initialPlan,
  ].join("\n\n");
}

function buildFallbackDeliverables(initialPlan: string): string[] {
  const subject = initialPlan.trim() || "the requested work";
  return [
    `Define scope and acceptance criteria for ${subject}`,
    `Implement the agreed approach for ${subject}`,
    `Verify delivery and operational readiness for ${subject}`,
  ];
}

function buildRunningSummary(
  initialPlan: string,
  history: PlanningHistoryEntry[],
  previousSummary?: PlanningSummary,
): PlanningSummary {
  const subject = initialPlan.trim() || "the requested work";
  const initialDescription = `Plan and deliver ${subject}. Establish scope, implementation approach, and acceptance criteria through the planning interview.`;
  const decisions = history.map(describePlanningAnswer).filter(Boolean);
  const incorporatedDecisions = decisions.join("; ");
  const priorDescription = previousSummary?.description
    ?.replace(/\n\nPlanning decisions incorporated: [\s\S]*$/, "")
    .replace(/\. Refine scope and implementation around the confirmed planning decisions: [\s\S]*$/, ".");
  const description = decisions.length === 0
    ? initialDescription
    : priorDescription
      ? `${priorDescription}\n\nPlanning decisions incorporated: ${incorporatedDecisions}.`
      : `Plan and deliver ${subject}. Refine scope and implementation around the confirmed planning decisions: ${incorporatedDecisions}.`;
  return normalizePlanningSummaryPayload({
    title: previousSummary?.title || `Plan: ${subject.slice(0, 74)}`,
    description,
    proposedChanges: previousSummary?.proposedChanges?.length
      ? previousSummary.proposedChanges
      : [`Change the affected workflow to support: ${subject}`],
    acceptanceCriteria: previousSummary?.acceptanceCriteria?.length
      ? previousSummary.acceptanceCriteria
      : [`The requested outcome works end to end for: ${subject}`],
    suggestedSize: previousSummary?.suggestedSize ?? "M",
    priority: previousSummary?.priority,
    suggestedDependencies: previousSummary?.suggestedDependencies ?? [],
    keyDeliverables: previousSummary?.keyDeliverables?.length ? previousSummary.keyDeliverables : buildFallbackDeliverables(subject),
    suggestedRefinements: previousSummary?.suggestedRefinements?.length
      ? previousSummary.suggestedRefinements
      : ["Scope and user experience", "Technical approach and integration", "Validation and rollout"],
  }, { title: `Plan: ${subject}`, description: initialDescription });
}

function hasPlanContent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return (typeof plan.title === "string" && plan.title.trim().length > 0)
    || (typeof plan.description === "string" && plan.description.trim().length > 0)
    || (Array.isArray(plan.keyDeliverables) && plan.keyDeliverables.some((item) => typeof item === "string" && item.trim().length > 0));
}

function getModelRunningPlan(response: PlanningResponse): unknown {
  if (response.type === "complete") return response.data;
  return response.data.runningPlan;
}

function mergeRunningSummary(session: Session, response?: PlanningResponse): PlanningSummary {
  const modelPlan = response ? getModelRunningPlan(response) : undefined;
  if (hasPlanContent(modelPlan)) {
    /*
    FNXC:PlanningMode 2026-07-20-00:00:
    FN-8434 permits a question to carry a partial running-plan update. Merge that patch over
    the prior work product before normalization so an update to one field cannot reset the
    model's previously established title, deliverables, dependencies, size, or priority.
    */
    const priorPlan = session.summary ?? buildRunningSummary(session.initialPlan, session.history);
    return normalizePlanningSummaryPayload({
      ...priorPlan,
      ...(modelPlan as Record<string, unknown>),
    }, {
      title: session.initialPlan,
      description: session.initialPlan,
    });
  }
  return buildRunningSummary(session.initialPlan, session.history, session.summary);
}

type PlanningFallbackOption = {
  id: string;
  label: string;
  description: string;
  pros: string[];
  cons: string[];
};

type PlanningFallbackCopy = {
  question: string;
  other: string;
  options: readonly PlanningFallbackOption[];
};

const ENGLISH_PLANNING_FALLBACK: PlanningFallbackCopy = {
  question: "What is the next most important detail or constraint to refine?",
  other: "Other (write your own)",
  options: [
    { id: "fallback-speed", label: "Ship a focused first version", description: "Prioritize the fastest useful delivery.", pros: ["Gets value to users sooner"], cons: ["May defer broader improvements"] },
    { id: "fallback-reliability", label: "Invest in reliability first", description: "Prioritize robust behavior and durable safeguards.", pros: ["Reduces operational risk"], cons: ["Takes more time up front"] },
    { id: "fallback-scope", label: "Reduce the initial scope", description: "Deliver only the smallest essential outcome.", pros: ["Keeps the change easier to validate"], cons: ["Leaves some needs for later"] },
    { id: "fallback-investigate", label: "Investigate before committing", description: "Learn about the problem before choosing an implementation.", pros: ["Improves the next decision"], cons: ["Delays implementation"] },
  ],
};

const PLANNING_FALLBACKS: Record<string, PlanningFallbackCopy> = {
  english: ENGLISH_PLANNING_FALLBACK,
  spanish: {
    question: "¿Cuál es el siguiente detalle o restricción más importante que debemos precisar?",
    other: "Otro (escribe tu respuesta)",
    options: [
      { id: "fallback-speed", label: "Lanzar una primera versión enfocada", description: "Prioriza la entrega útil más rápida.", pros: ["Aporta valor antes"], cons: ["Puede aplazar mejoras más amplias"] },
      { id: "fallback-reliability", label: "Invertir primero en fiabilidad", description: "Prioriza un comportamiento sólido y salvaguardas duraderas.", pros: ["Reduce el riesgo operativo"], cons: ["Requiere más tiempo inicial"] },
      { id: "fallback-scope", label: "Reducir el alcance inicial", description: "Entrega solo el resultado esencial más pequeño.", pros: ["Facilita validar el cambio"], cons: ["Deja algunas necesidades para después"] },
      { id: "fallback-investigate", label: "Investigar antes de decidir", description: "Aprende sobre el problema antes de elegir la implementación.", pros: ["Mejora la siguiente decisión"], cons: ["Retrasa la implementación"] },
    ],
  },
  french: {
    question: "Quel est le prochain détail ou contrainte le plus important à préciser ?", other: "Autre (écrivez votre réponse)",
    options: [
      { id: "fallback-speed", label: "Livrer une première version ciblée", description: "Privilégie la livraison utile la plus rapide.", pros: ["Apporte de la valeur plus tôt"], cons: ["Peut reporter des améliorations"] },
      { id: "fallback-reliability", label: "Privilégier la fiabilité", description: "Privilégie un comportement robuste et durable.", pros: ["Réduit le risque opérationnel"], cons: ["Demande plus de temps initial"] },
      { id: "fallback-scope", label: "Réduire le périmètre initial", description: "Livre seulement le résultat essentiel.", pros: ["Facilite la validation"], cons: ["Laisse des besoins pour plus tard"] },
      { id: "fallback-investigate", label: "Étudier avant de décider", description: "Apprend sur le problème avant de choisir.", pros: ["Améliore la prochaine décision"], cons: ["Retarde l'implémentation"] },
    ],
  },
  korean: {
    question: "다음으로 구체화할 가장 중요한 세부 사항이나 제약은 무엇인가요?", other: "기타(직접 입력)",
    options: [
      { id: "fallback-speed", label: "집중된 첫 버전 빠르게 출시", description: "가장 빠른 유용한 제공을 우선합니다.", pros: ["더 빨리 가치를 제공합니다"], cons: ["넓은 개선을 미룰 수 있습니다"] },
      { id: "fallback-reliability", label: "신뢰성에 먼저 투자", description: "견고한 동작과 지속적인 보호책을 우선합니다.", pros: ["운영 위험을 줄입니다"], cons: ["초기 시간이 더 듭니다"] },
      { id: "fallback-scope", label: "초기 범위 축소", description: "가장 작은 필수 결과만 제공합니다.", pros: ["변경 검증이 쉬워집니다"], cons: ["일부 요구를 나중으로 남깁니다"] },
      { id: "fallback-investigate", label: "결정 전에 조사", description: "구현을 고르기 전에 문제를 학습합니다.", pros: ["다음 결정을 개선합니다"], cons: ["구현이 늦어집니다"] },
    ],
  },
  simplifiedChinese: {
    question: "接下来最需要细化的细节或限制是什么？", other: "其他（自行填写）",
    options: [
      { id: "fallback-speed", label: "快速交付聚焦的首版", description: "优先最快的有用交付。", pros: ["更早提供价值"], cons: ["可能推迟更广泛的改进"] },
      { id: "fallback-reliability", label: "先投资可靠性", description: "优先稳健行为和持久保障。", pros: ["降低运营风险"], cons: ["前期需要更多时间"] },
      { id: "fallback-scope", label: "缩小初始范围", description: "只交付最小的必要结果。", pros: ["更易验证变更"], cons: ["一些需求留待以后"] },
      { id: "fallback-investigate", label: "先调查再决定", description: "在选择实现前了解问题。", pros: ["改善下一次决策"], cons: ["延迟实现"] },
    ],
  },
  traditionalChinese: {
    question: "下一步最需要釐清的細節或限制是什麼？", other: "其他（自行填寫）",
    options: [
      { id: "fallback-speed", label: "快速交付聚焦的首版", description: "優先最快的有用交付。", pros: ["更早提供價值"], cons: ["可能延後更廣泛的改善"] },
      { id: "fallback-reliability", label: "先投資可靠性", description: "優先穩健行為和持久保障。", pros: ["降低營運風險"], cons: ["前期需要更多時間"] },
      { id: "fallback-scope", label: "縮小初始範圍", description: "只交付最小的必要結果。", pros: ["更易驗證變更"], cons: ["一些需求留待以後"] },
      { id: "fallback-investigate", label: "先調查再決定", description: "在選擇實作前了解問題。", pros: ["改善下一次決策"], cons: ["延後實作"] },
    ],
  },
};

function canonicalPlanningOptionText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US").replace(/[\p{P}\p{S}\s]/gu, "");
}

export function __validatePlanningFallbackOptionsForTests(fallback: PlanningFallbackCopy): boolean {
  if (fallback.options.length !== 4 || !fallback.question.trim() || !fallback.other.trim()) return false;
  const ids = new Set<string>();
  const labels = new Set<string>();
  const descriptions = new Set<string>();
  return fallback.options.every((option) => {
    const id = option.id.trim();
    const label = canonicalPlanningOptionText(option.label);
    const description = canonicalPlanningOptionText(option.description);
    const complete = id.length > 0 && label.length > 0 && description.length > 0
      && option.pros.some((item) => item.trim()) && option.cons.some((item) => item.trim());
    if (!complete || ids.has(id) || labels.has(label) || descriptions.has(description)) return false;
    ids.add(id);
    labels.add(label);
    descriptions.add(description);
    return true;
  });
}

const HAS_VALID_PLANNING_FALLBACKS = Object.values(PLANNING_FALLBACKS).every((fallback) => __validatePlanningFallbackOptionsForTests(fallback));

function planningFallbackCopy(input: string): PlanningFallbackCopy {
  const locale = /[一-龯]/.test(input)
    ? (/[繁體臺灣與為這個]/.test(input) ? "traditionalChinese" : "simplifiedChinese")
    : /[가-힣]/.test(input) ? "korean"
      : /\b(le|la|les|une|fonctionnalité)\b/i.test(input) ? "french"
        : /\b(el|la|los|una|función|característica|español(?:es)?)\b/i.test(input) ? "spanish" : "english";
  const selected = PLANNING_FALLBACKS[locale] ?? ENGLISH_PLANNING_FALLBACK;
  return HAS_VALID_PLANNING_FALLBACKS && __validatePlanningFallbackOptionsForTests(selected) ? selected : ENGLISH_PLANNING_FALLBACK;
}

function normalizedStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim())
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : fallback;
}

/*
FNXC:PlanningMode 2026-08-07-03:10:
Planning Mode normally requests 3–5 substantive routes, but normalization must preserve every
valid model-authored route rather than imposing a maximum. This boundary still normalizes Unicode,
whitespace, case, and punctuation collisions and reserves locale fallback archetypes so bad model
output, retries, and restored sessions retain one canonical free-text Other choice.
*/
/** Normalizes untrusted model output so select questions always meet the public option contract. */
export function normalizePlanningQuestion(input: unknown, userInput = ""): PlanningQuestion {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const fallback = planningFallbackCopy(userInput);
  const type = source.type === "multi_select" || source.type === "single_select" ? source.type : "single_select";
  const question = typeof source.question === "string" && source.question.trim() ? source.question.trim() : fallback.question;
  const normalized: PlanningQuestion = { id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : randomUUID(), type, question,
    ...(typeof source.description === "string" && source.description.trim() ? { description: source.description.trim() } : {}) };
  const fallbackIds = new Set(fallback.options.map((option) => option.id));
  const fallbackLabels = new Set(fallback.options.map((option) => canonicalPlanningOptionText(option.label)));
  const fallbackDescriptions = new Set(fallback.options.map((option) => canonicalPlanningOptionText(option.description)));
  const ids = new Set<string>();
  const labels = new Set<string>();
  const descriptions = new Set<string>();
  const alternatives: Array<Omit<PlanningFallbackOption, "description"> & { description?: string }> = [];
  const raw = Array.isArray(source.options) ? source.options : [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const option = item as Record<string, unknown>;
    if (option.isOther === true || option.id === "other" || option.id === "__other__") continue;
    const id = typeof option.id === "string" ? option.id.trim() : "";
    const label = typeof option.label === "string" ? option.label.trim() : "";
    const description = typeof option.description === "string" ? option.description.trim() : "";
    const canonicalLabel = canonicalPlanningOptionText(label);
    const canonicalDescription = canonicalPlanningOptionText(description);
    if (!id || !label || fallbackIds.has(id) || ids.has(id) || fallbackLabels.has(canonicalLabel)
      || labels.has(canonicalLabel) || (description && (fallbackDescriptions.has(canonicalDescription) || descriptions.has(canonicalDescription)))) continue;
    alternatives.push({
      id,
      label,
      ...(description ? { description } : {}),
      pros: normalizedStringArray(option.pros, [fallback.options[0].pros[0]]),
      cons: normalizedStringArray(option.cons, [fallback.options[0].cons[0]]),
    });
    ids.add(id);
    labels.add(canonicalLabel);
    if (description) descriptions.add(canonicalDescription);
  }

  for (const option of fallback.options) {
    if (alternatives.length >= 4) break;
    if (!ids.has(option.id)) alternatives.push({ ...option, pros: [...option.pros], cons: [...option.cons] });
  }
  normalized.options = [...alternatives, { id: "other", label: fallback.other, isOther: true }];
  return normalized;
}

function coerceQuestionResponse(response: PlanningResponse, session: Session): PlanningQuestion {
  if (response.type === "question") return normalizePlanningQuestion(response.data, session.initialPlan);
  return normalizePlanningQuestion({ id: randomUUID(), type: "single_select", question: planningFallbackCopy(session.initialPlan).question }, session.initialPlan);
}

export async function validateSession(sessionId: string): Promise<PlanningSummary> {
  const session = await getSession(sessionId);
  if (!session) throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);

  // FNXC:PlanningMode 2026-07-18-16:00: Validation is the terminal user action.
  // Cancel a concurrent turn and clear its question so it cannot race the completed row
  // back to awaiting_input after the user has finalized the running plan.
  const activeGeneration = activeGenerations.get(session.id);
  if (activeGeneration) {
    activeGeneration.abortReason = "user-stop";
    clearTimeout(activeGeneration.timer);
    activeGeneration.abortTeardown();
    activeGeneration.abortController.abort();
    activeGenerations.delete(session.id);
  }

  // Keep the last model-authored running plan intact; validation only finalizes it.
  session.summary = session.summary ?? buildRunningSummary(session.initialPlan, session.history);
  session.currentQuestion = undefined;
  session.editingQuestionId = undefined;
  /*
  FNXC:PlanningMode 2026-07-23-08:55:
  Validation is the sole terminal transition, including after a synchronous initial turn left
  generation metadata behind. Clear that non-terminal metadata so stream replay recognizes the
  validated session, emits its one terminal complete event, and closes without a synthetic event.
  */
  session.generationPurpose = undefined;
  session.generationStartedAt = undefined;
  session.generationReturnQuestion = undefined;
  session.pendingContextualComments = undefined;
  session.validated = true;
  session.error = undefined;
  session.updatedAt = new Date();
  await persistSession(session, "complete");
  planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
  planningStreamManager.broadcast(session.id, { type: "complete" });
  return session.summary;
}

async function continueAgentConversation(session: Session, message: string): Promise<void> {
  if (!session.agent) {
    throw new InvalidSessionStateError("AI agent not initialized");
  }

  try {
    await runGenerationWithTimeout(session, async (abortSignal) => {
      // Clear thinking output for this turn
      session.thinkingOutput = "";

      /*
      FNXC:AiSessionCancellation 2026-07-13-00:00:
      Planning turns and parse-retry prompts must pass the active AbortSignal to prompt() and short-circuit after abort. The local generation runner also tears down the agent session because provider SDKs may ignore the signal.
      */
      if (abortSignal.aborted) {
        throw createAbortError();
      }
      await promptPlanningAgent(session.agent.session, message, {
        signal: abortSignal,
      });
      if (abortSignal.aborted) {
        throw createAbortError();
      }

    // Get the response text from the agent's state
    interface AgentMessage {
      role: string;
      content?: string | Array<{ type: string; text: string }>;
    }
    const lastMessage = (session.agent.session.state.messages as AgentMessage[])
      .filter((m: AgentMessage) => m.role === "assistant")
      .pop();
    
    let responseText = session.thinkingOutput;
    if (lastMessage?.content) {
      // Handle both string and array content types
      if (typeof lastMessage.content === "string") {
        responseText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        // Extract text from content blocks; only overwrite fallback if non-empty
        const extracted = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("");
        if (extracted) {
          responseText = extracted;
        }
      }
    }

    markPlanningGenerationProgress(session.id, responseText);

    // Diagnostic: warn when response text is empty or very short
    if (!responseText || responseText.length < 10) {
      const contentBlockTypes = Array.isArray(lastMessage?.content)
        ? lastMessage.content.map((c: { type: string }) => c.type)
        : typeof lastMessage?.content === "string" ? ["string"] : [];
      diagnostics.warn(
        "Response text is empty or very short before parse",
        {
          sessionId: session.id,
          responseTextLength: responseText.length,
          contentBlockTypes,
          usedThinkingOutputFallback: responseText === session.thinkingOutput,
          operation: "response-extraction",
        }
      );
    }

    // Parse the JSON response with retry
    let parsed: PlanningResponse | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      try {
        parsed = parseAgentResponse(responseText);
        break; // success
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        
        if (attempt < MAX_PARSE_RETRIES) {
          // Retry: ask the AI to reformat as clean JSON
          diagnostics.warn(
            "Parse attempt failed, requesting reformat",
            { sessionId: session.id, attempt: attempt + 1, operation: "parse-retry" }
          );
          try {
            session.thinkingOutput = "";
            if (abortSignal.aborted) {
              throw createAbortError();
            }
            await promptPlanningAgent(
              session.agent.session,
              "Your previous response could not be parsed as JSON. " +
                'Please respond with ONLY a valid JSON object: {"type":"question","data":{"runningPlan":{...},...}}. ' +
                'No markdown, no explanation, just the JSON.',
              { signal: abortSignal },
            );
            if (abortSignal.aborted) {
              throw createAbortError();
            }
            
            // Get the new response text
            const retryMessage = (session.agent.session.state.messages as AgentMessage[])
              .filter((m: AgentMessage) => m.role === "assistant")
              .pop();
            
            let retryText = session.thinkingOutput;
            if (retryMessage?.content) {
              if (typeof retryMessage.content === "string") {
                retryText = retryMessage.content;
              } else if (Array.isArray(retryMessage.content)) {
                const extracted = retryMessage.content
                  .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
                  .map((c: { type: string; text: string }) => c.text)
                  .join("");
                if (extracted) {
                  retryText = extracted;
                }
              }
            }
            responseText = retryText;
            markPlanningGenerationProgress(session.id, responseText);
          } catch (retryErr) {
            if (retryErr instanceof Error && retryErr.name === "AbortError") {
              throw retryErr;
            }
            // Retry prompt itself failed — give up
            diagnostics.errorFromException(
              "Retry prompt failed for session",
              retryErr,
              { sessionId: session.id, operation: "retry-prompt" }
            );
            // FNXC:PlanningProviderErrors 2026-07-23-20:10: report the provider failure itself instead of a misleading "no valid JSON" parse error.
            lastError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
            break;
          }
        }
      }
    }

    if (!parsed) {
      // All attempts exhausted — emit actionable, retryable error without duplicated "Please try again" suffixes.
      const errorMsg = buildRetryableParseErrorMessage(lastError);
      diagnostics.error(
        "All parse attempts exhausted for session",
        { sessionId: session.id, message: errorMsg, operation: "parse-exhausted" }
      );
      setSessionError(session, errorMsg);
      return;
    }

      session.summary = mergeRunningSummary(session, parsed);
      session.error = undefined;
      session.lastGeneratedThinking = session.thinkingOutput;
      session.updatedAt = new Date();
      session.generationPurpose = undefined;
      session.generationStartedAt = undefined;
      session.generationReturnQuestion = undefined;
      // The revised summary is now durable, so a later retry must not reapply this batch.
      session.pendingContextualComments = undefined;
      session.currentQuestion = coerceQuestionResponse(parsed, session);
      await persistSession(session, "awaiting_input");
      planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
      if (session.currentQuestion) {
        void maybeNotifyPlanningAwaitingInput(session, session.currentQuestion, true);
        planningStreamManager.broadcast(session.id, { type: "question", data: session.currentQuestion });
      }
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }

    const errorMessage = err instanceof Error ? err.message : "AI processing failed";
    diagnostics.errorFromException("Agent conversation error for session", err, { sessionId: session.id, operation: "conversation" });
    setSessionError(session, errorMessage);
  }
}

/**
 * Extract the best JSON candidate from AI response text.
 *
 * Handles:
 * - Markdown-wrapped JSON (```json ... ```)
 * - JSON embedded in leading/trailing prose
 * - Multiple JSON objects (picks the largest balanced one)
 *
 * Returns the extracted JSON string or null if nothing usable is found.
 */
function isPlanningResponseShape(parsed: unknown): parsed is PlanningResponse {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    !("data" in parsed)
  ) {
    return false;
  }

  const typed = parsed as { type: string; data: unknown };
  return (
    (typed.type === "question" || typed.type === "complete") &&
    typed.data !== null &&
    typed.data !== undefined
  );
}

function parseJsonCandidateForShape(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJson(candidate).repaired);
    } catch {
      return undefined;
    }
  }
}

function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;

  // 1. Try markdown code blocks first (most reliable when they contain a planning response).
  const codeBlockMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  const codeBlockCandidates = codeBlockMatches
    .map((match) => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate?.startsWith("{")));
  const planningCodeBlock = codeBlockCandidates.find((candidate) =>
    isPlanningResponseShape(parseJsonCandidateForShape(candidate)),
  );
  if (planningCodeBlock) return planningCodeBlock;
  if (codeBlockCandidates.length > 0) return codeBlockCandidates[0];

  // 2. Find all top-level brace-delimited objects using balanced brace counting.
  const candidates: Array<{ start: number; end: number; text: string; parsed?: unknown }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1).trim();
          candidates.push({ start: i, end: j, text: candidate, parsed: parseJsonCandidateForShape(candidate) });
          break;
        }
      }
    }
  }

  const planningCandidate = candidates.find((candidate) => isPlanningResponseShape(candidate.parsed));
  if (planningCandidate) return planningCandidate.text;

  /*
  FNXC:PlanningJsonRecovery 2026-07-28-12:00:
  FN-8260 must prefer a truncated top-level completion over a complete nested
  deliverable object, so a cutoff cannot silently select that nested object.
  */
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && isPlanningResponseShape(parseJsonCandidateForShape(trimmed))) {
    return trimmed;
  }

  // Pick the largest valid JSON candidate only after planning-shaped candidates are ruled out.
  const validCandidates = candidates.filter((candidate) => candidate.parsed !== undefined);
  if (validCandidates.length > 0) {
    validCandidates.sort((a, b) => b.text.length - a.text.length || a.start - b.start);
    return validCandidates[0].text;
  }

  // 3. Last resort: try the full trimmed text so repairJson can close truncated objects.
  if (trimmed.startsWith("{")) return trimmed;

  return null;
}

/**
 * Attempt to repair common JSON issues:
 * - Truncated JSON (missing closing braces)
 * - Trailing commas before closing braces
 * - Missing closing quotes
 *
 * Returns the repaired string, or the original if no repair was possible.
 */
function repairJson(text: string): { repaired: string; wasTruncationRepaired: boolean } {
  let repaired = text;
  let wasTruncationRepaired = false;

  // Fix trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  // Count open/close braces and brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  // If we're in an unclosed string, close it
  if (inString) {
    repaired += '"';
    wasTruncationRepaired = true;
  }

  // Re-count after potential string fix
  openBraces = 0;
  openBrackets = 0;
  inString = false;
  escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  // Close unclosed brackets and braces
  const missingBrackets = Math.max(0, openBrackets);
  const missingBraces = Math.max(0, openBraces);
  if (missingBrackets > 0 || missingBraces > 0) {
    wasTruncationRepaired = true;
  }
  repaired += "]".repeat(missingBrackets);
  repaired += "}".repeat(missingBraces);

  return { repaired, wasTruncationRepaired };
}

/**
 * Parse agent response JSON with robust extraction and recovery.
 *
 * Strategy:
 * 1. Extract JSON candidate from text (handles markdown wrapping, prose)
 * 2. Try parsing directly
 * 3. If parse fails, attempt repair (truncated JSON, trailing commas)
 * 4. Validate the resulting structure
 */
class TruncatedPlanningCompletionError extends Error {
  constructor() {
    super("AI returned a truncated completion response");
    this.name = "TruncatedPlanningCompletionError";
  }
}

export function parseAgentResponse(text: string): PlanningResponse {
  const candidate = extractJsonCandidate(text);

  if (!candidate) {
    diagnostics.error("No JSON candidate found in agent response", { inputSnippet: text.slice(0, 500), operation: "parse-json" });
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  let wasTruncationRepaired = false;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Attempt repair for truncated/malformed JSON
    try {
      const repair = repairJson(candidate);
      wasTruncationRepaired = repair.wasTruncationRepaired;
      parsed = JSON.parse(repair.repaired);
    } catch (repairErr) {
      diagnostics.error(
        "Failed to parse agent response (repair also failed)",
        { inputSnippet: candidate.slice(0, 500), operation: "parse-json-repair" }
      );
      throw new Error(
        `Failed to parse AI response: ${repairErr instanceof Error ? repairErr.message : "Unknown error"}. Please try again.`
      );
    }
  }

  // Validate structure
  if (isPlanningResponseShape(parsed)) {
    /*
    FNXC:PlanningJsonRecovery 2026-07-28-12:00:
    FN-8260 / GitHub #2240 requires Planning Mode to treat a completion whose
    structure was closed by recovery as incomplete generation. Retrying here
    prevents a token-cutoff plan from reaching the checkpoint as an empty or
    chopped summary, while clean payloads and benign question repairs remain
    accepted.
    */
    if (parsed.type === "complete" && wasTruncationRepaired) {
      throw new TruncatedPlanningCompletionError();
    }
    return parsed;
  }

  diagnostics.error("Invalid response structure from AI", { parsedSnippet: JSON.stringify(parsed).slice(0, 500), operation: "parse-validate" });
  throw new Error("AI returned an invalid response structure. Please try again.");
}

/**
 * Submit a response to the current question and get the next question or summary.
 * Supports both stubbed mode and AI agent mode.
 */
function isRefineRequest(responses: Record<string, unknown>): boolean {
  return responses.refine === true;
}

type ContextualComment = { quote: string; suggestion: string };

function getContextualComments(responses: Record<string, unknown>): ContextualComment[] | null {
  if (!Array.isArray(responses.contextualComments)
    || responses.contextualComments.length === 0
    || responses.contextualComments.length > 20) return null;
  const comments = responses.contextualComments.map((comment) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) return null;
    const { quote, suggestion } = comment as { quote?: unknown; suggestion?: unknown };
    const normalizedQuote = typeof quote === "string" ? quote.trim() : "";
    const normalizedSuggestion = typeof suggestion === "string" ? suggestion.trim() : "";
    return normalizedQuote && normalizedQuote.length <= 4_000 && normalizedSuggestion && normalizedSuggestion.length <= 2_000
      ? { quote: normalizedQuote, suggestion: normalizedSuggestion }
      : null;
  });
  return comments.every((comment): comment is ContextualComment => comment !== null) ? comments : null;
}

export function formatContextualCommentsForAgent(summary: PlanningSummary, comments: ContextualComment[]): string {
  return [
    "The operator reviewed the running plan and submitted contextual comments.",
    "Revise the running plan using every comment below, preserve unaffected content, and continue the established Planning Mode response contract. Treat each accepted comment as a durable decision: rebuild every affected plan field around it rather than appending contradictory notes.",
    "Return the revised plan in Markdown and ask exactly one concrete option-driven next question that narrows the updated direction when more input is needed.",
    "Current summary:",
    JSON.stringify(summary),
    "Contextual comments, in submitted order:",
    ...comments.flatMap((comment, index) => [`${index + 1}. Selected quote: ${comment.quote}`, `Suggestion: ${comment.suggestion}`]),
  ].join("\n\n");
}

function formatRefineRequestForAgent(summary: PlanningSummary, focus?: string): string {
  return [
    "The user clicked Refine Further on the planning summary.",
    "Continue the planning interview from the existing context. Rebuild affected plan fields around every accumulated selection, Other answer, and requested focus; do not retain an unselected alternative as the plan backbone.",
    "Inspect the selected direction and relevant repository context, then ask exactly one focused, high-impact option-driven follow-up question that narrows it one consequential level further with normally 3–5 materially distinct alternatives, descriptions, and pros/cons plus one write-your-own option. Two alternatives are not sufficient; include more when genuinely useful.",
    "Do not return a completion response: only the user can validate a plan.",
    ...(focus ? ["The operator wants this next question to focus on:", focus] : []),
    "Current summary:",
    JSON.stringify(summary),
  ].join("\n\n");
}

/*
FNXC:PlanningQuestionRegeneration 2026-07-23-21:40:
A submission that arrives while the session has no active question (the previous question was
already answered, cleared by a retry, or lost with a cleared summary) must not surface
"No active question in session" to the operator. Instead the turn reprompts the agent to
continue the interview and generate a fresh option-driven question from the accumulated
context, honoring any submitted operator input as context rather than dropping it.
*/
export function formatQuestionRegenerationForAgent(
  summary: PlanningSummary,
  responses: Record<string, unknown>,
): string {
  const operatorInput = Object.entries(responses)
    .filter(([key, value]) =>
      key !== "refine" && key !== "focus" && key !== "contextualComments"
      && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return [
    "The planning session currently has no active interview question; continue the interview instead of treating this as an error.",
    "Rebuild affected plan fields around every accumulated selection and Other answer, then ask exactly one new high-impact, option-driven question that narrows the current direction, with normally 3–5 useful, materially distinct alternatives (descriptions, pros, and cons) plus one write-your-own option. Two alternatives are not sufficient; include more when genuinely useful.",
    'Return only type:"question" JSON with the complete runningPlan. Do not return a completion response: only the user can validate a plan.',
    ...(operatorInput.length
      ? ["The operator submitted this input while no question was active; honor it as context for the plan and the next question:", operatorInput.join("\n")]
      : []),
    "Current summary:",
    JSON.stringify(summary),
  ].join("\n\n");
}

/*
FNXC:PlanningRetry 2026-07-14-00:00:
currentQuestion is cleared once an answer is accepted, so a duplicate re-submit during the
in-flight generation is detected against the last history entry (the turn being generated)
instead of the now-cleared currentQuestion.
*/
function captureOtherCustomText(question: PlanningQuestion, responses: Record<string, unknown>): PlanningQuestion {
  const customText = typeof responses._other === "string" ? responses._other.trim() : "";
  if (!customText || !question.options?.some((option) => option.isOther)) return question;
  return {
    ...question,
    options: question.options.map((option) => option.isOther ? { ...option, customText } : option),
  };
}

function didSubmitSameAnswer(
  session: Session,
  responses: Record<string, unknown>,
): boolean {
  const lastEntry = session.history[session.history.length - 1];
  if (!lastEntry) {
    return false;
  }
  return JSON.stringify(lastEntry.response) === JSON.stringify(responses);
}

export async function submitResponse(
  sessionId: string,
  responses: Record<string, unknown>,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<PlanningResponse> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  // Stash store/rootDir on the session so subsequent ensureSessionAgent calls
  // (after the agent is disposed for retry/rewind) can rebuild without the
  // caller having to thread context through every API.
  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  // FNXC:PlanningTurnAdmission 2026-07-22-21:00: synchronous single-turn admission — see reservePlanningTurn.
  if (isPlanningTurnActive(session.id)) {
    if (didSubmitSameAnswer(session, responses)) {
      throw new GenerationInProgressError("Generation already in progress for this response");
    }
    throw new GenerationInProgressError("Generation already in progress");
  }
  const releaseTurn = reservePlanningTurn(session.id);

  /*
  FNXC:PlanningReopenAfterValidate 2026-07-23-23:30:
  A validated plan must never be a read-only dead end: the operator can keep refining,
  commenting, or answering, and create the task whenever they choose. A new turn on a
  validated session REOPENS it (clears the terminal marker; the turn's own
  persistSession("generating") durably writes validated:false and moves the row out of
  "complete"), rather than rejecting with "already been validated". validateSession remains
  the only terminalizer.

  FNXC:PlanningMultiTask 2026-07-24-01:40:
  Reopen (validated flip) and epoch rotation run only AFTER turn admission succeeds. Review
  finding (3 reviewers): mutating the shared in-memory session before the admission guards
  meant a rejected request (GenerationInProgressError, duplicate submit) burned a phantom
  rotation that was never persisted — in-memory epoch N+1 vs durable N — and a later Proceed
  could derive the wrong claim key. Past admission, every branch reaches
  persistSession("generating"), so the rotation always lands durably with its turn.
  */
  if (session.validated) {
    session.validated = false;
  }
  rotateTaskCreationEpochOnReopen(session);

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Reported bug: planning got stuck cycling retry/regeneration after the user had already answered.
  Root cause: session.currentQuestion kept the just-answered question all through the next
  generation, and the SSE stream route's catch-up path re-emits currentQuestion to every fresh
  connection. Each FN-7946 auto-retry opens a fresh SSE connection, so the client was handed the
  already-answered question again, which reset the bounded auto-retry budget and re-showed a
  stale question — an unbounded retry/regenerate loop. Invariant: currentQuestion is only set
  while the session is genuinely awaiting user input; it is cleared the moment an answer is
  accepted (below), on retry (retrySession), and never restored from non-awaiting_input rows
  (buildSessionFromRow). answeredQuestion preserves the legacy 200 response body for the
  generation-error case so the modal's submit path keeps its existing SSE-driven recovery.
  */
  let answeredQuestion: PlanningQuestion | undefined;
  /*
  FNXC:PlanningProviderErrors 2026-07-23-20:10:
  ensureSessionAgent (agent construction + history-replay prompt) throws provider errors AFTER
  the session row was persisted "generating". continueAgentConversation converts its own
  failures to a persisted session error, but a throw between persist("generating") and that
  call previously escaped to the route with the row left "generating" forever — no error
  event, no watchdog — so the Planning modal hung on "Thinking/Generating plan" (its SSE
  reconnect + 8s poll both treat "generating" as healthy). Track the generating transition and
  convert any non-abort escape into the same retryable persisted error state.
  */
  let enteredGenerating = false;

  try {
    const contextualComments = getContextualComments(responses);
    /*
    FNXC:PlanningQuestionRegeneration 2026-07-23-21:40:
    Refine, contextual comments, and the no-active-question fallback must never depend on
    session.summary being set: a retry that failed mid-regeneration clears it, and the old
    `&& session.summary` guards dropped those submissions into the terminal
    "No active question in session" error. Rebuild the running summary from persisted
    history instead so the interview always continues.
    */
    const effectiveSummary = session.summary ?? buildRunningSummary(session.initialPlan, session.history);
    if (contextualComments) {
      /*
      FNXC:PlanningComments 2026-07-23-12:00:
      Comment batches deliberately reuse the existing session, active-turn reservation, SSE, and
      plan_update generation. They are not a second review authority or agent lifecycle.
      */
      beginPlanningGeneration(session, "plan_update");
      session.currentQuestion = undefined;
      session.error = undefined;
      session.pendingContextualComments = contextualComments;
      await persistSession(session, "generating");
      enteredGenerating = true;
      await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
      await continueAgentConversation(session, formatContextualCommentsForAgent(effectiveSummary, contextualComments));
    } else if (isRefineRequest(responses)) {
      // Refinement steers which question comes next; it is never an answer to the
      // currently displayed question and therefore must not create a history entry.
      beginPlanningGeneration(session, "question");
      session.currentQuestion = undefined;
      session.error = undefined;
      await persistSession(session, "generating");
      enteredGenerating = true;

      await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
      const focus = typeof responses.focus === "string" ? responses.focus.trim() : undefined;
      const refineMessage = formatRefineRequestForAgent(effectiveSummary, focus);
      await continueAgentConversation(session, refineMessage);
    } else if (!session.currentQuestion) {
      /*
      FNXC:PlanningQuestionRegeneration 2026-07-23-21:40:
      A submission with no active question used to throw InvalidSessionStateError
      ("No active question in session") to the operator. Requirement: regenerate instead —
      reprompt the agent to continue the interview and produce a fresh question, carrying any
      submitted operator input along as context. No history entry is recorded because there is
      no question to pair the response with.
      */
      beginPlanningGeneration(session, "question");
      session.error = undefined;
      await persistSession(session, "generating");
      enteredGenerating = true;

      await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
      await continueAgentConversation(session, formatQuestionRegenerationForAgent(effectiveSummary, responses));
    } else {
      const currentQuestion = captureOtherCustomText(session.currentQuestion, responses);
      const historyEntry = {
        question: currentQuestion,
        response: responses,
        thinkingOutput: session.lastGeneratedThinking || "",
      };

      session.error = undefined;
      /*
      FNXC:DashboardSessionPersistence 2026-06-14-09:09:
      Persist the user's answered planning turn before the agent generates the next question or errors. AiSessionStore snapshots happen inside continueAgentConversation, so history must already include the submitted answer for retry replay and SQLite round-trip tests to observe durable state.
      */
      const editIndex = session.editingQuestionId
        ? session.history.findIndex((entry) => entry.question.id === session.editingQuestionId)
        : -1;
      const isEditingPriorAnswer = editIndex >= 0;
      if (isEditingPriorAnswer) {
        session.history[editIndex] = historyEntry;
        session.editingQuestionId = undefined;
        // Rebuild from history before the next turn so stale pre-edit plan prose cannot survive.
        session.summary = buildRunningSummary(session.initialPlan, session.history);
        // Existing agent context contains the old answer; rebuild it from the preserved history.
        disposeSessionAgentForRetry(session);
      } else {
        session.history.push(historyEntry);
      }
      answeredQuestion = currentQuestion;

      // Clear the answered question while generation is active so reconnects cannot replay it.
      // The completed turn persists and broadcasts exactly one newly generated question.
      beginPlanningGeneration(session, "plan_update");
      session.currentQuestion = undefined;
      await persistSession(session, "generating");
      enteredGenerating = true;
      if (!session.agent) {
        // An edited older answer must be replayed in its original position with every
        // later answer retained; only a newly appended answer is sent after replay.
        await ensureSessionAgent(
          session,
          rootDir,
          isEditingPriorAnswer ? session.history : session.history.slice(0, -1),
          promptOverrides,
          store,
        );
      }
      const message = isEditingPriorAnswer
        ? "An earlier answer was edited. Use the complete preserved interview context above, discard downstream assumptions contradicted by the edit, rebuild every affected running-plan field around the accumulated decisions, and ask exactly one concrete option-driven next question that narrows the selected direction."
        : formatResponseForAgent(currentQuestion, responses);
      await continueAgentConversation(session, message);
    }
  } catch (err) {
    if (enteredGenerating && !session.error && !(err instanceof Error && err.name === "AbortError")) {
      setSessionError(session, err instanceof Error ? err.message : "AI processing failed");
    }
    throw err;
  } finally {
    releaseTurn();
  }

  // Return the current state (will be updated via SSE)
  if (session.currentQuestion) {
    return { type: "question", data: session.currentQuestion };
  }

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Generation failed after the answer was accepted (session.error was set and broadcast via SSE).
  Historically this path returned the answered question with a 200 because currentQuestion was
  never cleared; the modal ignores the body and lets the SSE error drive auto-retry. Preserve
  that contract explicitly instead of throwing a 400 that would bounce the client back to the
  already-answered question view.
  */
  if (session.error && answeredQuestion) {
    return { type: "question", data: answeredQuestion };
  }

  if (session.summary) {
    return { type: "complete", data: session.summary };
  }

  throw new InvalidSessionStateError("AI agent did not return a question or summary");
}

export async function retrySession(
  sessionId: string,
  rootDir: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (session.validated) {
    throw new InvalidSessionStateError("Planning session has already been validated");
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  const persisted = _aiSessionStore ? await _aiSessionStore.get(sessionId) : null;
  if (persisted && persisted.type !== "planning") {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  const inErrorState = persisted ? persisted.status === "error" : Boolean(session.error);
  if (!inErrorState) {
    throw new InvalidSessionStateError(`Planning session ${sessionId} is not in an error state`);
  }

  /*
  FNXC:PlanningTurnAdmission 2026-07-22-21:00:
  Two racing retries (e.g. auto-retry from a remounted Planning view plus a second tab) could
  both read status "error" before either persisted "generating"; the loser then disposed the
  agent the winner was actively prompting, producing the empty-response "AI returned no valid
  JSON" failure. Admission is reserved synchronously before any turn state is touched.
  */
  const releaseTurn = reservePlanningTurn(session.id);
  // FNXC:PlanningProviderErrors 2026-07-23-20:10: same generating-strand guard as submitResponse — see the comment there.
  let enteredGenerating = false;
  try {
    disposeSessionAgentForRetry(session);

    session.error = undefined;
    const pendingContextualComments = session.pendingContextualComments;
    // Keep the reviewed plan available while replaying a contextual batch; ordinary answer
    // retries still rebuild their running summary from persisted interview history.
    if (!pendingContextualComments) session.summary = undefined;
    /*
    FNXC:PlanningRetry 2026-07-14-00:00:
    A retry regenerates the last turn, so no question is awaiting input. Clearing here also
    scrubs stale answered questions persisted by pre-fix builds; without this, the fresh SSE
    connection the retry path opens would be handed the answered question by the stream route's
    catch-up emit, resetting the FN-7946 auto-retry budget and looping forever.
    */
    session.currentQuestion = undefined;
    session.updatedAt = new Date();
    beginPlanningGeneration(session, session.history.length === 0 ? "initial_plan" : "plan_update");
    await persistSession(session, "generating");
    enteredGenerating = true;

    if (pendingContextualComments) {
      await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
      await continueAgentConversation(
        session,
        formatContextualCommentsForAgent(
          session.summary ?? buildRunningSummary(session.initialPlan, session.history),
          pendingContextualComments,
        ),
      );
      return;
    }

    if (session.history.length === 0) {
      await ensureSessionAgent(session, rootDir, [], promptOverrides, store);
      await continueAgentConversation(session, formatInitialRunningPlanRequestForAgent(session.initialPlan));
      return;
    }

    const replayHistory = session.history.slice(0, -1);
    const lastEntry = session.history[session.history.length - 1];

    await ensureSessionAgent(session, rootDir, replayHistory, promptOverrides, store);
    const replayMessage = formatResponseForAgent(
      lastEntry.question,
      coerceResponseRecord(lastEntry.question, lastEntry.response),
    );
    await continueAgentConversation(session, replayMessage);
  } catch (err) {
    if (enteredGenerating && !session.error && !(err instanceof Error && err.name === "AbortError")) {
      setSessionError(session, err instanceof Error ? err.message : "AI processing failed");
    }
    throw err;
  } finally {
    releaseTurn();
  }
}

export interface PlanningRewindResult {
  currentQuestion: PlanningQuestion;
  history: PlanningHistoryEntry[];
}

export async function rewindSession(
  sessionId: string,
  questionId?: string,
  rootDir?: string,
  promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<PlanningRewindResult> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  if (store && !session.store) session.store = store;
  if (rootDir && !session.rootDir) session.rootDir = rootDir;

  if (session.history.length === 0) {
    throw new InvalidSessionStateError("Planning session has no previous question to rewind to");
  }

  /*
  FNXC:PlanningTurnAdmission 2026-07-22-21:00:
  Rewind/edit is a user-takes-control action. Cancel any in-flight generation through its own
  abort/teardown path (like validateSession) before disposing the agent, so the turn cannot
  keep running against a disposed session and surface "AI returned no valid JSON".

  FNXC:PlanningTurnAdmission 2026-07-23-08:30:
  After the abort, WAIT for the cancelled turn's owner to unwind and release its reservation,
  then hold the reservation for rewind's own span. Without this, both admission sets were
  empty during rewind's awaits and a concurrent submit/retry could interleave and corrupt
  question/history/agent state; the cancelled turn's post-prompt abort checks plus this
  serialization keep a slow provider prompt from outliving the rewound state (PR #2417).
  All state mutation (including history.pop) happens only after admission succeeds.
  */
  const activeGeneration = activeGenerations.get(session.id);
  if (activeGeneration) {
    activeGeneration.abortReason = "user-stop";
    clearTimeout(activeGeneration.timer);
    activeGeneration.abortTeardown();
    activeGeneration.abortController.abort();
    activeGenerations.delete(session.id);
  }
  if (!(await waitForPlanningTurnRelease(session.id))) {
    throw new GenerationInProgressError("Generation already in progress");
  }
  const releaseTurn = reservePlanningTurn(session.id);

  /*
  FNXC:PlanningReopenAfterValidate 2026-07-23-23:30: editing an earlier answer reopens a validated plan — see submitResponse.
  FNXC:PlanningMultiTask 2026-07-24-01:40: reopen + rotation only after admission and the empty-history precondition, so a rejected rewind never mutates claim state (see submitResponse).
  */
  if (session.validated) {
    session.validated = false;
  }
  rotateTaskCreationEpochOnReopen(session);

  try {
    /*
    FNXC:PlanningTurnAdmission 2026-07-23-10:10:
    Also wait — bounded — for the cancelled turn's OPERATION (including its raw provider
    prompt) to settle before disposing/replacing the agent. The reservation releases as soon
    as the abort wins the race, but a provider that ignores the signal can leave its prompt
    callback live; publishing the rewound state under it was the residual PR #2417 finding.
    On timeout we proceed anyway: disposal is the backstop and the cancelled closure's
    post-prompt abort checks prevent state writes.
    */
    if (!(await waitForTurnOperationSettled(session.id))) {
      diagnostics.warn("Rewinding past a provider prompt that has not settled after abort", {
        sessionId: session.id,
        operation: "rewind-unsettled-prompt",
      });
    }

    // Resolve the rewind target only after admission: a turn that completed while we
    // waited may have appended to history, so an index computed earlier would be stale.
    const rewindIndex = questionId
      ? session.history.findIndex((entry) => entry.question.id === questionId)
      : session.history.length - 1;
    if (rewindIndex < 0) {
      throw new InvalidSessionStateError("Planning question to edit was not found");
    }
    const rewindEntry = session.history[rewindIndex]!;
    if (!questionId) session.history.pop();

    disposeSessionAgentForRetry(session);

    session.currentQuestion = rewindEntry.question;
    session.editingQuestionId = questionId ? questionId : undefined;
    // Re-derive from retained answers so an edit cannot revive a prior question as a deliverable.
    session.summary = buildRunningSummary(session.initialPlan, session.history);
    session.error = undefined;
    session.lastGeneratedThinking = session.history[session.history.length - 1]?.thinkingOutput ?? "";
    session.thinkingOutput = "";
    session.updatedAt = new Date();

    if (!session.agent && rootDir) {
      await ensureSessionAgent(session, rootDir, session.history, promptOverrides, store);
    }

    persistSession(session, "awaiting_input");
    planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
    planningStreamManager.broadcast(session.id, { type: "question", data: rewindEntry.question });

    return {
      currentQuestion: rewindEntry.question,
      history: [...session.history],
    };
  } finally {
    releaseTurn();
  }
}

export function stopGeneration(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  /*
  FNXC:PlanningStopMultiSession 2026-07-23-23:50:
  Stop must work for every generation shape, keyed strictly to this session id so stopping one
  plan never touches other concurrently generating sessions. A just-started session whose
  initial turn is still PENDING (registered by start-streaming but not yet consumed by a
  stream connect) has no activeGenerations record; without discarding that pending turn here,
  Stop returned false and the "stopped" generation sprang back to life on the next stream
  connect. Consuming (and dropping) the callback cancels the future turn.
  */
  const discardedInitialTurn = planningStreamManager.consumeInitialTurn(sessionId) !== undefined;
  const activeGeneration = activeGenerations.get(sessionId);

  if (!activeGeneration && !discardedInitialTurn) {
    return false;
  }

  if (activeGeneration) {
    activeGeneration.abortReason = "user-stop";
    clearTimeout(activeGeneration.timer);
    activeGeneration.abortTeardown();
    activeGeneration.abortController.abort();
    activeGenerations.delete(sessionId);
  }

  const returnQuestion = session.generationReturnQuestion;
  const stoppedPurpose = session.generationPurpose;
  session.error = undefined;
  session.thinkingOutput = "";
  session.generationPurpose = undefined;
  session.generationStartedAt = undefined;
  session.generationReturnQuestion = undefined;
  session.updatedAt = new Date();

  if (returnQuestion) {
    session.currentQuestion = returnQuestion;
    session.editingQuestionId = session.history.some((entry) => entry.question.id === returnQuestion.id)
      ? returnQuestion.id
      : undefined;
    session.summary = buildRunningSummary(session.initialPlan, session.history, session.summary);
    void persistSession(session, "awaiting_input");
    planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
    planningStreamManager.broadcast(session.id, { type: "question", data: returnQuestion });
  } else {
    session.currentQuestion = undefined;
    session.editingQuestionId = undefined;
    // A stopped initial turn with a usable running plan resumes at plan review; only a turn
    // stopped before any plan exists returns to the initial draft editor.
    const hasReviewablePlan = Boolean(session.summary);
    void persistSession(session, hasReviewablePlan || stoppedPurpose !== "initial_plan" ? "awaiting_input" : "draft");
    if (session.summary) {
      planningStreamManager.broadcast(session.id, { type: "summary", data: session.summary });
    }
  }
  return true;
}

/**
 * Format user response as a message for the AI agent.
 */
export function formatResponseForAgent(
  question: PlanningQuestion,
  responses: Record<string, unknown>
): string {
  const responseValue = responses[question.id];
  const comment = typeof responses._comment === "string" ? responses._comment.trim() : "";
  const other = typeof responses._other === "string" ? responses._other.trim() : "";

  let formatted: string;

  switch (question.type) {
    case "text":
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "single_select":
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      GitHub #1794 requires Other-only single-select answers to reach the planning agent as the user's own answer instead of forcing a provided option id or rendering an undefined fallback.
      */
      if (other.length > 0) {
        formatted = `Question: ${question.question}\n\nSelected: ${other} (user's own answer)`;
        break;
      }
      if (typeof responseValue === "string") {
        const option = question.options?.find((o) => o.id === responseValue);
        formatted = `Question: ${question.question}\n\nSelected: ${option?.label || responseValue}`;
        break;
      }
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "multi_select":
      if (Array.isArray(responseValue) || other.length > 0) {
        const selected = Array.isArray(responseValue) ? responseValue.map((id) => {
          const option = question.options?.find((o) => o.id === id);
          return option?.label || id;
        }) : [];
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        Multi-select Other answers are additive agent context; append the free-text answer to the selected list and keep Other-only payloads from collapsing to a blank/undefined answer.
        */
        if (other.length > 0) {
          selected.push(`${other} (user's own answer)`);
        }
        formatted = `Question: ${question.question}\n\nSelected: ${selected.join(", ")}`;
        break;
      }
      formatted = `Question: ${question.question}\n\nAnswer: ${responseValue}`;
      break;

    case "confirm":
      /*
      FNXC:PlanningInterview 2026-07-01-00:00:
      GitHub #1832 lets Planning Mode confirm questions submit `_other` instead of a boolean. Preserve that user-authored answer for the agent; otherwise history replay would turn missing confirm ids into an unintended "No".
      */
      formatted = other.length > 0
        ? `Question: ${question.question}\n\nAnswer: ${other} (user's own answer)`
        : `Question: ${question.question}\n\nAnswer: ${responseValue === true ? "Yes" : "No"}`;
      break;

    default:
      formatted = `Question: ${question.question}\n\nAnswer: ${JSON.stringify(responseValue)}`;
      break;
  }

  const answerContext = comment.length > 0 ? `${formatted}\n\nAdditional context: ${comment}` : formatted;
  /*
  FNXC:PlanningMode 2026-07-23-14:10:
  System prompts can be displaced by long tool/context turns. Repeat the selection-as-plan-backbone contract at the invocation boundary so every submitted option, multi-selection, or Other answer rebuilds the work product before the one deeper question, instead of becoming an append-only note or inviting model-authored completion.
  */
  return `${answerContext}\n\nThis answer is a durable planning decision, not an append-only note. Regenerate the runningPlan fields (title, description, concrete proposedChanges, observable acceptanceCriteria, suggestedSize, optional priority, suggestedDependencies, concrete keyDeliverables, and all distinct high-value suggestedRefinements) around this selected label/description and every accumulated decision; do not cap suggestedRefinements at three. Rewrite every affected field so the selected direction is the central intended outcome, not the original vague complaint or an unselected alternative. Preserve free-text Other verbatim as steering. Author the operator-facing plan in Markdown: use concise GitHub-flavored Markdown in the description, with the structured fields supplying its Markdown sections and lists. Never list interview questions as deliverables or PROMPT.md sections such as Mission, Steps, File Scope, Review Level, Completion Criteria, or Do NOT. Inspect the selected direction and relevant repository context, return type:"question" with that complete runningPlan, and ask exactly one next question: a deeper concrete option-driven question with normally 3–5 materially distinct alternatives, descriptions, and pros/cons plus one write-your-own option. Two alternatives are not sufficient; include more when genuinely useful. Do not validate the plan; only the user can proceed with it.`;
}

function coerceResponseRecord(question: PlanningQuestion, response: unknown): Record<string, unknown> {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return response as Record<string, unknown>;
  }

  return {
    [question.id]: response,
  };
}

function disposeSessionAgentForRetry(session: Session): void {
  // FNXC:PlanningTurnAdmission 2026-07-23-10:40: invalidate the disposed agent's streaming
  // callbacks even when the provider keeps running past dispose — see Session.agentCallbackEpoch.
  session.agentCallbackEpoch = (session.agentCallbackEpoch ?? 0) + 1;
  if (!session.agent) {
    return;
  }

  nonfatal(
    () => session.agent.session.dispose?.(),
    diagnostics,
    "Error disposing agent for retry",
    { sessionId: session.id, operation: "dispose-retry" }
  );

  session.agent = undefined;
}

function formatInterviewAnswer(question: PlanningQuestion, responseValue: unknown, other = ""): string {
  switch (question.type) {
    case "text":
      return typeof responseValue === "string" ? responseValue : String(responseValue ?? "");

    case "single_select": {
      const selected = typeof responseValue === "string"
        ? question.options?.find((candidate) => candidate.id === responseValue)?.label || responseValue
        : String(responseValue ?? "");
      return [selected, other.length > 0 ? `${other} (user's own answer)` : ""].filter(Boolean).join(", ");
    }

    case "multi_select": {
      const selected = Array.isArray(responseValue) ? responseValue.map((id) => {
        if (typeof id !== "string") {
          return String(id);
        }
        const option = question.options?.find((candidate) => candidate.id === id);
        return option?.label || id;
      }) : [];
      if (other.length > 0) {
        selected.push(`${other} (user's own answer)`);
      }
      return selected.length > 0 ? selected.join(", ") : String(responseValue ?? "");
    }

    case "confirm": {
      const selected = responseValue === true ? "Yes" : "No";
      return [selected, other.length > 0 ? `${other} (user's own answer)` : ""].filter(Boolean).join(", ");
    }

    default:
      return JSON.stringify(responseValue);
  }
}

/**
 * Format planning interview Q&A history for task descriptions and logs.
 */
export function formatInterviewQA(
  history: Array<{ question: PlanningQuestion; response: unknown }>
): string {
  if (history.length === 0) {
    return "";
  }

  const entries = history.map(({ question, response }) => {
    const responseRecord =
      response && typeof response === "object" && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : undefined;
    const responseValue = responseRecord ? responseRecord[question.id] : response;
    const comment = typeof responseRecord?._comment === "string" ? responseRecord._comment.trim() : "";
    const other = typeof responseRecord?._other === "string" ? responseRecord._other.trim() : "";

    const answerLine = `**Q: ${question.question}**\nA: ${formatInterviewAnswer(question, responseValue, other)}`;
    return comment.length > 0 ? `${answerLine}\nComment: ${comment}` : answerLine;
  });

  return `## Planning Interview Context\n\n${entries.join("\n\n")}`;
}

/*
FNXC:PlanningMode 2026-08-03-10:03:
Every task created from Planning Mode must retain the ordered interview decisions that shaped its
lean plan. Compose a copy for the task handoff so the authoritative running summary stays lean,
empty sessions add no shell, and replaying an already-composed child cannot duplicate Q&A.
*/
export function formatPlanningTaskHandoff(
  summary: PlanningSummary,
  history: Array<{ question: PlanningQuestion; response: unknown }>,
): string {
  const qaSection = formatInterviewQA(history);
  const description = summary.description.trim();
  const handoffDescription = qaSection && !description.includes(qaSection)
    ? `${description}\n\n${qaSection}`
    : description;

  return formatPlanningPlanMd({ ...summary, description: handoffDescription });
}

/**
 * Cancel and cleanup a planning session.
 */
export async function cancelSession(sessionId: string): Promise<void> {
  const removed = cleanupInMemorySession(sessionId);
  if (!removed) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }

  await unpersistSession(sessionId);
}

/**
 * Get session details.
 */
/** Attach live-only route dependencies after session rehydration. */
export async function attachPlanningRuntime(
  sessionId: string,
  options: Pick<PlanningSessionOptions, "ntfyConfig" | "messageStore" | "clarificationEnabled">,
): Promise<void> {
  const session = await getSession(sessionId);
  /*
  FNXC:AgentClarification 2026-07-16-16:15:
  The following mutator owns the authoritative missing-session error. Runtime
  attachment is best-effort so restored live sessions receive current ntfy
  settings without changing existing route error semantics.
  */
  if (!session) return;
  session.ntfyConfig = options.ntfyConfig;
  // Persisted session choice wins on resumed sessions; route defaults only fill old rows.
  if (session.clarificationEnabled === undefined) session.clarificationEnabled = options.clarificationEnabled === true;
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  const inMemory = sessions.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  if (!_aiSessionStore) {
    return undefined;
  }

  const row = await _aiSessionStore.get(sessionId);
  if (!row || row.type !== "planning") {
    return undefined;
  }

  try {
    const restored = buildSessionFromRow(row);
    sessions.set(restored.id, restored);
    return restored;
  } catch (error) {
    diagnostics.errorFromException("Failed to restore session from SQLite", error, { sessionId, operation: "restore" });
    return undefined;
  }
}

/**
 * Get the current question for a session.
 */
export function getCurrentQuestion(sessionId: string): PlanningQuestion | undefined {
  return sessions.get(sessionId)?.currentQuestion;
}

/**
 * Get the summary for a completed session.
 */
export function getSummary(sessionId: string): PlanningSummary | undefined {
  return sessions.get(sessionId)?.summary;
}

/**
 * Persist planning create-task claim/linkage state. The task row's stable proposalClaimId is
 * authoritative after a crash; these fields make restore and UI handoff deterministic.
 */
export async function updatePlanningCreateClaim(
  sessionId: string,
  patch: Pick<Session, "createClaimStatus" | "createdTaskId" | "claimOwnerToken" | "claimStartedAt">,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  Object.assign(session, patch);
  session.updatedAt = new Date();
  await persistSession(session, session.validated ? "complete" : "awaiting_input");
}

function restoreClaimSession(row: import("./ai-session-store.js").AiSessionRow): Session {
  const restored = buildSessionFromRow(row);
  sessions.set(restored.id, restored);
  return restored;
}

/*
FNXC:PlanningMultiTask 2026-07-24-00:20:
One plan may produce multiple tasks, one per creation epoch. The task table's partial unique
proposalClaimId index stays the multi-process crash authority WITHIN an epoch. A new explicit
create action carrying the latest task id advances the epoch; transport retries carrying the
prior id stay on the already-advanced epoch and dedupe to its canonical task. Editing the plan
after a task exists also rotates to a new epoch/key.
Epoch 0 keeps the legacy un-suffixed key so pre-existing linked sessions stay reconciled.
*/
export function planningProposalClaimId(sessionId: string, taskCreationEpoch?: number): string {
  const epoch = taskCreationEpoch ?? 0;
  return epoch > 0 ? `planning-session:${sessionId}#${epoch}` : `planning-session:${sessionId}`;
}

/*
Reopen-time rotation: a plan edited after its current epoch created a task starts a new epoch.

FNXC:PlanningMultiTask 2026-07-24-01:40:
Rotation is rotate-on-intent: it commits with the edit turn's persistSession("generating"),
so an edit turn that later FAILS still leaves the epoch advanced — a subsequent Proceed on
the unchanged plan then creates a second task with identical content. Accepted trade-off
(review finding): the alternative (rotate only on turn success) would let a failed edit
silently re-link the edited plan to the pre-edit task, which is worse. The guard below also
deliberately requires finalize's "created" status or a set createdTaskId, so a crash between
claim ("creating") and finalize can never rotate away from the epoch whose task row needs
reconciliation.
*/
function rotateTaskCreationEpochOnReopen(session: Session): void {
  const currentEpochHasTask = Boolean(session.createdTaskId) || session.createClaimStatus === "created";
  if (!currentEpochHasTask) return;
  if (session.createdTaskId) {
    const history = session.createdTaskIds ?? [];
    if (!history.includes(session.createdTaskId)) {
      session.createdTaskIds = [...history, session.createdTaskId];
    }
  }
  session.taskCreationEpoch = (session.taskCreationEpoch ?? 0) + 1;
  session.createdTaskId = undefined;
  session.createClaimStatus = "none";
  session.claimOwnerToken = undefined;
  session.claimStartedAt = undefined;
}

/*
FNXC:PlanningMultiTask 2026-07-24-02:30:
Agent-surface twin of POST /planning/create-task (review finding: fn task plan / fn_task_plan
created tasks via a raw store.createTask with no proposalClaimId, so agent-created tasks had
no idempotency, no session linkage, and lived outside the epoch sequence — a later dashboard
Proceed would create a duplicate). This function shares every invariant primitive with the
route (planningProposalClaimId, claim/finalize/reconcile/release CAS lifecycle including the
30s stale-lease takeover, formatPlanningPlanMd task shape, validate-on-create); only the HTTP
concerns (branch selection, workflow lane, GitHub tracking dispatch) stay route-only. The
route remains the dashboard authority — keep the two orchestrations semantically aligned.
*/
export async function createTaskFromPlanSession(
  sessionId: string,
  store: TaskStore,
  options?: { baseBranch?: string; sourceType?: "cli" | "api" },
): Promise<{ task: Task; alreadyCreated: boolean }> {
  let session = (await getDurablePlanningSession(sessionId).catch(() => undefined)) ?? await getSession(sessionId);
  if (!session) throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  if (isPlanningTurnActive(sessionId) || planningStreamManager.hasPendingInitialTurn(sessionId)) {
    throw new GenerationInProgressError("Plan is still generating — wait for the current turn to finish, then create the task.");
  }
  // FNXC:PlanningMultiTask 2026-07-24-03:40: cross-process guard (review finding) — mirror the route's durable status check so a turn generating in ANOTHER process cannot have its linkage torn by this creation.
  if (_aiSessionStore) {
    const liveRow = await _aiSessionStore.get(sessionId).catch(() => null);
    if (liveRow?.type === "planning" && liveRow.status === "generating") {
      throw new GenerationInProgressError("Plan is still generating — wait for the current turn to finish, then create the task.");
    }
  }
  const summary = session.summary ?? buildRunningSummary(session.initialPlan, session.history);
  if (!summary) throw new InvalidSessionStateError("Planning session has no plan to create a task from");

  let claimEpoch = session.taskCreationEpoch ?? 0;
  const currentProposalClaimId = () => planningProposalClaimId(sessionId, claimEpoch);
  const findCreatedTask = async (): Promise<Task | undefined> =>
    (await store.listTasks({ includeArchived: false })).find((candidate) => candidate.proposalClaimId === currentProposalClaimId());
  const markSessionComplete = async (): Promise<void> => {
    const current = await getSession(sessionId);
    if (current && !current.validated) {
      await validateSession(sessionId).catch((err) => {
        diagnostics.warn("Planning create-task session completion failed", { sessionId, message: err instanceof Error ? err.message : String(err), operation: "create-task-session" });
      });
    }
  };
  const returnExisting = async (task: Task): Promise<{ task: Task; alreadyCreated: true }> => {
    await reconcilePlanningTaskCreation(sessionId, task.id, claimEpoch).catch((err) => {
      diagnostics.warn("Planning create-task linkage reconcile failed", { sessionId, taskId: task.id, message: err instanceof Error ? err.message : String(err), operation: "create-task-session" });
    });
    await markSessionComplete();
    return { task, alreadyCreated: true };
  };
  /*
  FNXC:PlanningMultiTask 2026-07-24-03:20:
  Reported bug (dashboard surface, same contract here): deleting the task created from a plan
  dead-ended the session forever. When the linked task is absent from the live task list (task-row authority — a successful scan proves deletion, not a flaky read), clear
  the stale linkage so this attempt creates a fresh task; a transient read failure keeps
  failing closed so we never fork on a hiccup.
  */
  const clearStaleLinkedTask = async (staleTaskId: string): Promise<boolean> => {
    const allTasks = await store.listTasks({ includeArchived: false }).catch(() => null);
    if (allTasks === null || allTasks.some((candidate) => candidate.id === staleTaskId)) return false;
    diagnostics.warn("Planning session linked task no longer exists; advancing creation epoch", {
      sessionId,
      staleTaskId,
      operation: "create-task-session",
    });
    const advanced = await advancePlanningTaskCreationEpoch(
      sessionId,
      staleTaskId,
      claimEpoch,
    );
    if (!advanced) {
      /*
      FNXC:PlanningMultiTask 2026-08-03-18:32:
      Losing the epoch CAS means another process may already have advanced this session.
      Refresh that state once so agent creation can reconcile or claim the winning epoch.
      */
      const refreshed = await getDurablePlanningSession(sessionId).catch(() => undefined);
      if (!refreshed
        || ((refreshed.taskCreationEpoch ?? 0) === claimEpoch && refreshed.createdTaskId === staleTaskId)) return false;
      session = refreshed;
      claimEpoch = refreshed.taskCreationEpoch ?? claimEpoch;
      return true;
    }
    session = advanced;
    claimEpoch = advanced.taskCreationEpoch ?? claimEpoch + 1;
    return true;
  };

  // The task row under this epoch's key is the crash-window authority.
  const existingTask = await findCreatedTask();
  if (existingTask) return returnExisting(existingTask);
  if (session.createdTaskId) {
    const linked = await store.getTask(session.createdTaskId).catch(() => null);
    if (linked) {
      await markSessionComplete();
      return { task: linked, alreadyCreated: true };
    }
    if (!(await clearStaleLinkedTask(session.createdTaskId))) {
      throw new InvalidSessionStateError("PLANNING_CREATED_TASK_MISSING");
    }
  }

  const claimOwnerToken = randomUUID();
  let claimed = await claimPlanningTaskCreation(sessionId, claimOwnerToken, new Date().toISOString(), claimEpoch);
  if (!claimed) {
    session = (await getDurablePlanningSession(sessionId).catch(() => undefined)) ?? session;
    const recovered = await findCreatedTask();
    if (recovered) return returnExisting(recovered);
    if (session.createdTaskId) {
      const linked = await store.getTask(session.createdTaskId).catch(() => null);
      if (linked) {
        await markSessionComplete();
        return { task: linked, alreadyCreated: true };
      }
      if (await clearStaleLinkedTask(session.createdTaskId)) {
        claimed = await claimPlanningTaskCreation(sessionId, claimOwnerToken, new Date().toISOString(), claimEpoch);
      }
      if (!claimed) {
        throw new GenerationInProgressError("Planning task creation is already in progress");
      }
    }
    if (!claimed) {
      const startedAt = session.claimStartedAt ? Date.parse(session.claimStartedAt) : Number.NaN;
      const leaseExpired = session.createClaimStatus === "creating" && Number.isFinite(startedAt) && Date.now() - startedAt >= 30_000;
      if (!leaseExpired || !session.claimOwnerToken) {
        throw new GenerationInProgressError("Planning task creation is already in progress");
      }
      await releasePlanningTaskCreation(sessionId, session.claimOwnerToken);
      claimed = await claimPlanningTaskCreation(sessionId, claimOwnerToken, new Date().toISOString(), claimEpoch);
      if (!claimed) throw new GenerationInProgressError("Planning task creation is already in progress");
    }
  }

  // FNXC:PlanningMultiTask 2026-07-24-03:40: review finding — a post-insert failure (e.g. finalize) lands in the raced-insert catch; without this marker the task WE created was mislabeled alreadyCreated:true.
  let insertedTask: Task | undefined;
  try {
    const planMd = formatPlanningTaskHandoff(summary, session.history);
    const originalRequest = session.initialPlan?.trim() || summary.description.trim();
    const sourceContext = resolvePlanningSourceIssue(session);
    const trackingDecision = sourceContext
      ? await (await import("./github-tracking.js")).resolvePlanningGithubTrackingDecision(store, await store.getSettings(), { owner: sourceContext.sourceIssue.repository.split("/")[0], repo: sourceContext.sourceIssue.repository.split("/")[1], issueNumber: sourceContext.sourceIssue.issueNumber, url: sourceContext.sourceIssue.url ?? "" })
      : undefined;
    const task = await store.createTask({
      title: summary.title,
      description: sourceContext ? (await import("./github.js")).appendSourceIssueBlock(planMd, sourceContext.markdown, sourceContext.sourceIssue.url ?? "") : planMd,
      dependencies: summary.suggestedDependencies?.length ? summary.suggestedDependencies : undefined,
      priority: isTaskPriority(summary.priority) ? summary.priority : DEFAULT_TASK_PRIORITY,
      ...(sourceContext ? { sourceIssue: sourceContext.sourceIssue, source: { sourceType: "github_import" as const, sourceMetadata: sourceContext.sourceMetadata }, ...(trackingDecision?.githubTracking ? { githubTracking: trackingDecision.githubTracking } : {}) } : { source: { sourceType: options?.sourceType ?? "cli" } }),
      ...(options?.baseBranch?.trim() ? { baseBranch: options.baseBranch.trim() } : {}),
      proposalClaimId: currentProposalClaimId(),
    });
    insertedTask = task;
    // FNXC:PlanningMultiTask 2026-07-24-03:20: best-effort side effects must be LOUD on failure (review finding) — a task missing its plan document with no signal is undebuggable.
    const sideEffect = async (label: string, work: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await work();
      } catch (err) {
        diagnostics.warn(label, { sessionId, taskId: task.id, message: err instanceof Error ? err.message : String(err), operation: "create-task-session" });
      }
    };
    if (summary.suggestedSize) {
      await sideEffect("Planning create-task size update failed", () => store.updateTask?.(task.id, { size: summary.suggestedSize }));
    }
    await sideEffect("Planning create-task plan document write failed", () => store.upsertTaskDocument?.(task.id, { key: "plan", content: planMd, author: "planning", metadata: { planningSessionId: sessionId, source: "planning-mode" } }));
    if (originalRequest) {
      await sideEffect("Planning create-task original description document write failed", () => store.upsertTaskDocument?.(task.id, { key: "original-description", content: originalRequest, author: "planning", metadata: { planningSessionId: sessionId, source: "planning-mode-initial-plan" } }));
    }
    if (sourceContext) {
      await sideEffect("Planning create-task GitHub issue document write failed", () => store.upsertTaskDocument?.(task.id, { key: "github-issue", content: sourceContext.markdown, author: "planning", metadata: { planningSessionId: sessionId, source: "github-source-issue" } }));
      await sideEffect("Planning create-task GitHub source log failed", () => store.logEntry?.(task.id, "Imported from GitHub", sourceContext.sourceIssue.url));
      const images = resolvePlanningIssueImageUrls(session);
      /* FNXC:GitHubPlanningSourceIssue 2026-08-09-14:09: CLI planning shares post-create best-effort image download and never reads GitHub at creation time. */
      await sideEffect("Planning create-task GitHub image import failed", async () => {
        const result = await importIssueImagesFromUrls(store, task.id, images.urls, githubImagePolicy());
        if (result.attached) await store.logEntry?.(task.id, `Imported ${result.attached} image attachment${result.attached === 1 ? "" : "s"} from GitHub issue`, sourceContext.sourceIssue.url);
      });
      if (images.commentsUnavailable || images.droppedBodyCount) diagnostics.warn("Planning GitHub image capture was partial", { taskId: task.id, issueUrl: sourceContext.sourceIssue.url, commentsUnavailable: images.commentsUnavailable, droppedBodyCount: images.droppedBodyCount });
    }
    if (trackingDecision?.suppressedByTaskId) await sideEffect("Planning create-task duplicate source issue log failed", () => store.logEntry?.(task.id, `Source issue already tracked by ${trackingDecision.suppressedByTaskId}`));
    await sideEffect("Planning create-task log entry failed", () => store.logEntry?.(task.id, "Created via Planning Mode", `Initial plan: ${(session?.initialPlan ?? "").slice(0, 200)}`));
    await finalizePlanningTaskCreation(sessionId, claimOwnerToken, task.id, claimEpoch);
    await markSessionComplete();
    return { task, alreadyCreated: false };
  } catch (err) {
    // A raced insert under the same key is the idempotent success case; anything else releases the claim.
    const raced = await findCreatedTask().catch(() => undefined);
    await releasePlanningTaskCreation(sessionId, claimOwnerToken).catch(() => undefined);
    if (raced) {
      const recovered = await returnExisting(raced);
      // A post-insert failure (e.g. finalize) lands here for the task WE just created — it is not "already created".
      return insertedTask && raced.id === insertedTask.id ? { task: recovered.task, alreadyCreated: false } : recovered;
    }
    throw err;
  }
}

/** Read durable claim state rather than trusting a process-local session cache. */
export async function getDurablePlanningSession(sessionId: string): Promise<Session | undefined> {
  if (!_aiSessionStore) return getSession(sessionId);
  const row = await _aiSessionStore.get(sessionId);
  return row?.type === "planning" ? restoreClaimSession(row) : undefined;
}

/** Atomically claim a planning session for one creation epoch's task. */
export async function claimPlanningTaskCreation(sessionId: string, ownerToken: string, startedAt: string, expectedTaskCreationEpoch?: number): Promise<Session | undefined> {
  if (!_aiSessionStore || typeof (_aiSessionStore as unknown as { claimPlanningTaskCreation?: unknown }).claimPlanningTaskCreation !== "function") {
    const session = await getSession(sessionId);
    if (!session || session.createClaimStatus === "creating" || session.createClaimStatus === "created") return undefined;
    if (expectedTaskCreationEpoch !== undefined && (session.taskCreationEpoch ?? 0) !== expectedTaskCreationEpoch) return undefined;
    Object.assign(session, { createClaimStatus: "creating", claimOwnerToken: ownerToken, claimStartedAt: startedAt });
    return session;
  }
  const row = await _aiSessionStore.claimPlanningTaskCreation(sessionId, ownerToken, startedAt, expectedTaskCreationEpoch);
  return row ? restoreClaimSession(row) : undefined;
}

export async function finalizePlanningTaskCreation(sessionId: string, ownerToken: string, taskId: string, expectedTaskCreationEpoch?: number): Promise<Session | undefined> {
  if (!_aiSessionStore || typeof (_aiSessionStore as unknown as { finalizePlanningTaskCreation?: unknown }).finalizePlanningTaskCreation !== "function") {
    const session = await getSession(sessionId);
    if (!session || session.claimOwnerToken !== ownerToken) return undefined;
    if (expectedTaskCreationEpoch !== undefined && (session.taskCreationEpoch ?? 0) !== expectedTaskCreationEpoch) return undefined;
    Object.assign(session, { createClaimStatus: "created", createdTaskId: taskId, claimOwnerToken: undefined, claimStartedAt: undefined });
    return session;
  }
  const row = await _aiSessionStore.finalizePlanningTaskCreation(sessionId, ownerToken, taskId, expectedTaskCreationEpoch);
  return row ? restoreClaimSession(row) : undefined;
}

// FNXC:PlanningMultiTask 2026-07-24-01:40: expectedTaskCreationEpoch makes reconcile a no-op when the plan was edited (epoch rotated) since the task's claim key was derived; never re-link a stale task to the new epoch.
export async function reconcilePlanningTaskCreation(sessionId: string, taskId: string, expectedTaskCreationEpoch?: number): Promise<Session | undefined> {
  if (!_aiSessionStore || typeof (_aiSessionStore as unknown as { reconcilePlanningTaskCreation?: unknown }).reconcilePlanningTaskCreation !== "function") {
    const session = await getSession(sessionId);
    if (session && (expectedTaskCreationEpoch === undefined || (session.taskCreationEpoch ?? 0) === expectedTaskCreationEpoch)) {
      Object.assign(session, { createClaimStatus: "created", createdTaskId: taskId, claimOwnerToken: undefined, claimStartedAt: undefined });
    }
    return session;
  }
  const row = await _aiSessionStore.reconcilePlanningTaskCreation(sessionId, taskId, expectedTaskCreationEpoch);
  return row ? restoreClaimSession(row) : undefined;
}

export async function releasePlanningTaskCreation(sessionId: string, ownerToken: string): Promise<Session | undefined> {
  if (!_aiSessionStore || typeof (_aiSessionStore as unknown as { releasePlanningTaskCreation?: unknown }).releasePlanningTaskCreation !== "function") {
    const session = await getSession(sessionId);
    if (!session || session.claimOwnerToken !== ownerToken) return undefined;
    Object.assign(session, { createClaimStatus: "none", claimOwnerToken: undefined, claimStartedAt: undefined });
    return session;
  }
  const row = await _aiSessionStore.releasePlanningTaskCreation(sessionId, ownerToken);
  return row ? restoreClaimSession(row) : undefined;
}

/** FNXC:PlanningMultiTask 2026-08-03-18:32: Advance once when an explicit new create action identifies the session's latest task. */
export async function advancePlanningTaskCreationEpoch(
  sessionId: string,
  previousTaskId: string,
  expectedTaskCreationEpoch: number,
): Promise<Session | undefined> {
  if (_aiSessionStore && typeof (_aiSessionStore as unknown as { advancePlanningTaskCreationEpoch?: unknown }).advancePlanningTaskCreationEpoch === "function") {
    const row = await _aiSessionStore.advancePlanningTaskCreationEpoch(
      sessionId,
      previousTaskId,
      expectedTaskCreationEpoch,
    );
    return row ? restoreClaimSession(row) : undefined;
  }

  const session = await getSession(sessionId);
  if (!session
    || session.createdTaskId !== previousTaskId
    || (session.taskCreationEpoch ?? 0) !== expectedTaskCreationEpoch) return undefined;
  rotateTaskCreationEpochOnReopen(session);
  await updatePlanningCreateClaim(sessionId, {
    createClaimStatus: "none",
    createdTaskId: undefined,
    claimOwnerToken: undefined,
    claimStartedAt: undefined,
  });
  return session;
}


/**
 * Cleanup a session and remove its persisted row.
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  cleanupInMemorySession(sessionId);
  await unpersistSession(sessionId);
}

/**
 * Reset all planning state. Used for testing only.
 */
export function __resetPlanningState(): void {
  // Cleanup all agent sessions
  for (const [id] of sessions) {
    cleanupInMemorySession(id);
  }
  sessions.clear();
  sessionPersistenceQueues.clear();
  rateLimits.clear();
  planningStreamManager.reset();
  activeGenerations.clear();
  pendingTurnReservations.clear();
  settlingTurnOperations.clear();

  if (_aiSessionStore && _aiSessionDeletedListener) {
    _aiSessionStore.off("ai_session:deleted", _aiSessionDeletedListener);
  }
  _aiSessionDeletedListener = undefined;
  _aiSessionStore = undefined;

  planningNtfyHelpers = undefined;

  // Reset diagnostics sink to default
  resetDiagnosticsSink();
}

/**
 * Inject a mock createFnAgent function. Used for testing only.
 */
export function __setCreateFnAgent(mock: typeof createFnAgent): void {
  createFnAgent = mock;
}

/** Inject ntfy helper implementations (test-only). */
export function __setPlanningNtfyHelpers(mock: PlanningNtfyHelpers | undefined): void {
  planningNtfyHelpers = mock;
}

/** Test-only helper for validating generation tracking behavior. */
export function __getActiveGenerationForTests(sessionId: string):
  | { abortController: AbortController; timer: NodeJS.Timeout }
  | undefined {
  return activeGenerations.get(sessionId);
}

/** Test-only helper for exercising generation timeout orchestration directly. */
export async function __runGenerationWithTimeoutForTests<T>(
  sessionId: string,
  operation: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Planning session ${sessionId} not found or expired`);
  }
  return runGenerationWithTimeout(session, operation);
}

// ── Custom Errors ───────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

export class InvalidSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionStateError";
  }
}

export class GenerationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationInProgressError";
  }
}
