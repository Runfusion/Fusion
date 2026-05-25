/**
 * HeartbeatMonitor - Runtime monitoring and execution for agents
 * 
 * Monitors agents via periodic polling, detects missed heartbeats,
 * and provides the Paperclip-style heartbeat execution engine:
 * 
 *   wake → check inbox → work → exit
 * 
 * When `executeHeartbeat()` is called (via API, timer, or assignment),
 * the system wakes the agent, checks its assigned task from AgentStore,
 * executes work in a lightweight agent session with `fn_task_create` capability,
 * records results, and transitions the run to completed.
 * 
 * Callback pattern (not EventEmitter):
 * - onMissed: Called when an agent misses its heartbeat
 * - onRecovered: Called when an agent recovers after a missed heartbeat
 * - onTerminated: Called when a heartbeat run is terminated
 */

import type { AgentStore, AgentHeartbeatRun, HeartbeatInvocationSource, AgentHeartbeatConfig, AgentBudgetStatus, Message, MessageStore, TaskStore, TaskDetail, AgentRole, Agent, InboxTask, RunMutationContext, Settings, AgentConfigRevision, ReflectionStore, ChatStore, ChatRoom, ChatRoomMessage, AgentMemoryInclusionMode } from "@fusion/core";
import { AutoClaimSnapshotManager, type AutoClaimCandidate } from "./auto-claim-snapshot.js";
import { ApprovalRequestStore, buildExecutionMemoryInstructions, isEphemeralAgent, hasAgentIdentity, resolveEffectiveAgentPermissionPolicy, canAgentTakeImplementationTask, canAgentTakeImplementationTaskForExplicitRouting, resolvePersistAgentThinkingLog, resolveAgentMemoryInclusionMode } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";
import { createHash } from "node:crypto";
import { createTaskCreateTool, createTaskLogToolWithContext, createTaskDocumentWriteTool, createTaskDocumentReadTool, createListAgentsTool, createDelegateTaskTool, createGetAgentConfigTool, createUpdateAgentConfigTool, createAgentCreateTool, createAgentDeleteTool, createSendMessageTool, createReadMessagesTool, createPostRoomMessageTool, createMemoryTools, createReadEvaluationsTool, createUpdateIdentityTool, createReflectOnPerformanceTool, createWebFetchTool, readAgentMemoryWorkspaceLongTerm, taskCreateParams } from "./agent-tools.js";
import { AgentLogger } from "./agent-logger.js";
import {
  resolveAgentInstructionsWithRatings,
  buildPluginPromptSection,
  resolveAgentHeartbeatProcedure,
} from "./agent-instructions.js";
import { resolveHeartbeatPromptTemplate, resolveHeartbeatScopeDisciplineMode, selectHeartbeatProcedure } from "./heartbeat-procedure-resolver.js";
import { buildPromptLayers, collapsePromptLayers } from "./prompt-layers.js";
import { createLogger, heartbeatLog, formatError } from "./logger.js";
import { acquireTaskWorktree } from "./worktree-acquisition.js";
import { createRunAuditor, type EngineRunContext } from "./run-audit.js";
import { promptWithFallback } from "./pi.js";
import { createResolvedAgentSession, extractRuntimeHint, resolveHeartbeatSessionModels } from "./agent-session-helpers.js";
import type { AgentActionGateContext } from "./agent-action-gate.js";
import { buildSessionSkillContextSync } from "./session-skill-context.js";
import type { AgentReflectionService } from "./agent-reflection.js";
import { trimPromptMd, trimTaskDescription, trimTriggeringComments } from "./heartbeat-prompt-trim.js";
import { detectDeicticReference, extractAntecedentCandidates, renderAmbiguityPromptBlock, scoreReferentConfidence } from "./room-ambiguity.js";
import { countActiveAgentMembers, decideRoomCoordination, detectTaskFilingIntent, renderRoomCoordinationPromptBlock } from "./room-coordination.js";

const promptSizeLog = createLogger("prompt-size");

function adjustHeartbeatMemoryPrimer(basePrompt: string, mode: AgentMemoryInclusionMode): string {
  if (mode === "full") return basePrompt;
  const memoryPrimer = /\nYou may receive an Agent Memory section and a Project Memory section\.[\s\S]*?- Project Memory examples:[^\n]*\n/;
  if (mode === "off") return basePrompt.replace(memoryPrimer, "\n");
  return basePrompt.replace(
    memoryPrimer,
    "\nWhen an Agent Memory Index is provided instead of full memory, call fn_memory_search first for task-relevant context. Use fn_memory_get to open only relevant snippets.\n",
  );
}

interface SelfImproveServiceLike {
  shouldRunSelfImprove(agentId: string): Promise<boolean>;
  getSelfImprovePrompt(agentId: string): Promise<string>;
  recordSelfImprove(agentId: string): Promise<void>;
}

/** Resolved per-agent heartbeat config after validation and fallback */
interface ResolvedHeartbeatConfig {
  pollIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxConcurrentRuns: number;
}

/** Options for HeartbeatMonitor constructor */
export interface HeartbeatMonitorOptions {
  /** AgentStore instance for persistence */
  store: AgentStore;
  /** Optional separate AgentStore reference for reading per-agent runtimeConfig.
   *  If not provided, falls back to `store`. */
  agentStore?: AgentStore;
  /** Optional MessageStore for wake-on-message behavior */
  messageStore?: MessageStore;
  /** Optional ChatStore for room-message visibility during heartbeats */
  chatStore?: ChatStore;
  /** Polling interval in milliseconds (default: 3600000) */
  pollIntervalMs?: number;
  /** Heartbeat timeout in milliseconds (default: 60000) */
  heartbeatTimeoutMs?: number;
  /** Max concurrent runs per agent (default: 1) */
  maxConcurrentRuns?: number;
  /** Callback when an agent misses its heartbeat */
  onMissed?: (agentId: string, reason: string) => void;
  /** Callback when an agent recovers after a missed heartbeat */
  onRecovered?: (agentId: string) => void;
  /** Callback when a heartbeat run is terminated (run status only; agent state is handled separately). */
  onTerminated?: (agentId: string, reason: string) => void;
  /** Callback when a run starts */
  onRunStarted?: (agentId: string, run: AgentHeartbeatRun) => void;
  /** Callback when a run completes */
  onRunCompleted?: (agentId: string, run: AgentHeartbeatRun) => void;
  /** Project-wide auto-claim snapshot manager. */
  snapshotManager?: AutoClaimSnapshotManager;
  /** TaskStore for fn_task_create and fn_task_log tools during heartbeat execution.
   *  When not provided, executeHeartbeat() will throw. */
  taskStore?: TaskStore;
  /** Project root directory for agent session CWD.
   *  When not provided, executeHeartbeat() will throw. */
  rootDir?: string;
  /** Plugin runner for runtime selection. When provided, enables plugin runtime lookup. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
  /** Optional ReflectionStore for evaluation-reading tools */
  reflectionStore?: ReflectionStore;
  /** Optional AgentReflectionService for fn_reflect_on_performance tool */
  reflectionService?: AgentReflectionService;
  /** Optional self-improvement service for periodic self-improve injection */
  selfImproveService?: SelfImproveServiceLike;
  secretsStore?: Pick<import("@fusion/core").SecretsStore, "listEnvExportable">;
}

/** Options for waking up an agent */
export interface WakeupOptions {
  /** What triggered the wakeup */
  source: HeartbeatInvocationSource;
  /** Detail about the trigger (manual, ping, scheduler, system) */
  triggerDetail?: string;
  /** Context snapshot for the run */
  contextSnapshot?: Record<string, unknown>;
}

/** Options for executing a heartbeat run */
export interface WakeMessageContext {
  messageId: string;
  fromType: string;
  fromId: string;
  forced: boolean;
  createdAt: string;
}

export interface HeartbeatExecutionOptions {
  /** Agent ID to execute heartbeat for */
  agentId: string;
  /** What triggered this heartbeat */
  source: HeartbeatInvocationSource;
  /** Human-readable trigger detail */
  triggerDetail?: string;
  /** Optional task ID override (uses agent.taskId if not set) */
  taskId?: string;
  /** IDs of comments that triggered this wake (if any) */
  triggeringCommentIds?: string[];
  /** Type of comment that triggered this wake */
  triggeringCommentType?: "steering" | "task" | "pr";
  /** Wake-on-message triggering message metadata for diagnostics */
  wakeMessage?: WakeMessageContext;
  /** Optional structured context persisted on the run record */
  contextSnapshot?: Record<string, unknown>;
}

export interface PauseAgentOptions {
  pauseReason?: string;
  stopActiveRun?: boolean;
  /**
   * When true (default), assigned tasks are also paused with `pausedByAgentId`
   * set to this agent. Set to false for internal/recovery flows that should
   * not visibly pause user-facing tasks (e.g. heartbeat-unresponsive recovery,
   * which immediately calls resumeAgent afterward).
   */
  cascadeToTasks?: boolean;
}

export interface ResumeAgentOptions {
  triggerDetail?: string;
  triggerSource?: string;
  clearPauseReason?: boolean;
  /** When true (default), unpauses tasks paused by this agent. */
  cascadeToTasks?: boolean;
}

/** Session interface for disposing agent resources */
export interface AgentSession {
  /** Dispose the agent session (stop execution, cleanup resources) */
  dispose(): void;
}

/** In-memory tracking data for a monitored agent */
interface TrackedAgent {
  agentId: string;
  session: AgentSession;
  runId: string;
  lastSeen: number; // timestamp from Date.now()
  missedHeartbeatReported: boolean;
  /** Session ID before this execution started */
  sessionIdBefore?: string;
}

/**
 * A direct report is flagged stale only when its last heartbeat is older than
 * 1.5 × its configured `heartbeatIntervalMs`. This matches the human CEO's
 * manual rule (see FN-4295) and avoids false positives for long-cadence
 * reports (e.g. 180-minute PM/CTO agents).
 */
const REPORTS_STALE_INTERVAL_MULTIPLIER = 1.5;

/**
 * Minimum staleness threshold floor for very short heartbeat intervals.
 */
const MIN_HEARTBEAT_STALENESS_MS = 5 * 60_000;

/** Format milliseconds into a human-readable duration string (e.g. "5m", "1h 20m", "2h"). */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "never";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown";
  const elapsed = Date.now() - parsed;
  if (elapsed < 0) return "just now";
  return `${formatDuration(elapsed)} ago`;
}

function getHeartbeatAgeMs(agent: Agent, now: number = Date.now()): number {
  const lastTs = agent.lastHeartbeatAt ? Date.parse(agent.lastHeartbeatAt) : Number.NaN;
  return Number.isFinite(lastTs) ? Math.max(0, now - lastTs) : Number.NaN;
}

function resolveHeartbeatMultiplier(rawMultiplier: unknown): number {
  if (typeof rawMultiplier !== "number" || !Number.isFinite(rawMultiplier) || rawMultiplier <= 0) {
    return 1;
  }
  return rawMultiplier;
}

async function terminatePersistedHeartbeatRun(
  store: AgentStore,
  agentId: string,
  runId: string,
  stderrExcerpt: string,
): Promise<boolean> {
  const detail = await store.getRunDetail(agentId, runId);
  if (detail && detail.status !== "completed" && detail.status !== "failed" && detail.status !== "terminated") {
    await store.saveRun({
      ...detail,
      endedAt: new Date().toISOString(),
      status: "terminated",
      stderrExcerpt,
    });
  }
  await store.endHeartbeatRun(runId, "terminated");
  return true;
}

function isAutoClaimRelevantTasksEnabled(agent: Agent): boolean {
  const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
  return runtimeConfig.autoClaimRelevantTasks !== false;
}

function resolveAutoClaimCandidatesInPromptLimit(agent: Agent, settings?: Settings): number {
  const runtimeConfig = (agent.runtimeConfig ?? {}) as AgentHeartbeatConfig;
  const perAgent = runtimeConfig.autoClaimCandidatesInPrompt;
  const projectValue = settings?.autoClaimCandidatesInPrompt;
  const raw = typeof perAgent === "number" ? perAgent : (typeof projectValue === "number" ? projectValue : 5);
  const integer = Number.isFinite(raw) ? Math.trunc(raw) : 5;
  return Math.max(0, Math.min(10, integer));
}

type RelevanceScorableTask = { title?: string | null; description: string };

const agentSoulWordsCache = new Map<string, { soulSnapshot: string; words: readonly string[] }>();

export function getAgentSoulWords(agent: Pick<Agent, "id" | "soul">): readonly string[] {
  const soulSnapshot = agent.soul ?? "";
  const existing = agentSoulWordsCache.get(agent.id);
  if (existing && existing.soulSnapshot === soulSnapshot) {
    return existing.words;
  }

  const words = soulSnapshot
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .slice(0, 8);

  agentSoulWordsCache.set(agent.id, { soulSnapshot, words });
  return words;
}

export function taskRelevanceScore(agent: Agent, task: RelevanceScorableTask): number {
  const haystack = `${task.title ?? ""} ${task.description}`.toLowerCase();
  let score = 0;

  const role = agent.role.toLowerCase();
  if (haystack.includes(role)) {
    score += 3;
  }

  const soulWords = getAgentSoulWords(agent);

  for (const word of soulWords) {
    if (haystack.includes(word)) {
      score += 1;
    }
  }

  return score;
}

/**
 * System prompt for heartbeat agent sessions.
 * This is an ambient heartbeat: task implementation runs in a separate executor path.
 * The heartbeat handles coordination, communication, memory, and routing only.
 */
export const HEARTBEAT_SYSTEM_PROMPT = `You are a heartbeat agent running in a short execution window.

## Your Role

This is an ambient heartbeat. Task implementation work (coding, running tests, making commits) runs in a separate
execution path handled by the executor. Do NOT do task body work or implementation in this heartbeat.

Your purpose is to keep momentum through coordination: surface blockers, respond to messages, manage memory,
delegate, and route work to the right place. Think in single-pass interventions, not coding sessions.

Your job:
1. Check your assigned task context — review its state, blockedBy field, and any new comments.
2. Do ONE useful coordination action.
3. Use fn_task_create to spawn follow-up work, fn_task_log to record observations, and fn_task_document_write for durable artifacts. Before calling fn_task_create, scan existing open tasks (the board context provided to you, or fn_task_list when in doubt) — if an open task already covers this work, log against it or update it instead of creating a duplicate.
4. Use fn_list_agents + fn_delegate_task when work should be assigned to a specific capable agent now.
5. Use fn_get_agent_config and fn_update_agent_config to tune direct reports before delegating recurring work.
6. Call fn_heartbeat_done when finished with an optional summary of what was accomplished.

**If your bound task is blocked** (blockedBy is set in the task context):
- Surface the blocker concretely with fn_task_log.
- Chase the dependency: comment on the blocking task, send a message to the responsible agent, or ping an owner.
- Look for unblocking work you can spawn or delegate right now.
- Pivot to other relevant coordination work if the blocker cannot be immediately resolved.

**If your bound task is not blocked:**
- Surface progress, status, or coordination needs with fn_task_log or fn_task_document_write.
- Create follow-up tasks for discovered risks or gaps.
- Respond to new steering comments or user messages.

Examples of ONE useful coordination action:
- DO: log a concrete blocker with next steps and message the agent responsible for unblocking.
- DO: create a focused follow-up task when a missing dependency is discovered.
- DO: delegate a well-scoped task to an appropriate idle specialist agent.
- DO: save a short investigation note with fn_task_document_write when the analysis is reusable.
- DON'T: attempt full implementation, run tests, commit code, or do multi-step coding work.
- DON'T: create vague tasks like "investigate stuff" without actionable scope.

Keep work lightweight — this is a single-pass coordination check, not an implementation run.
You have workspace read tools (for context gathering) plus fn_task_create, fn_task_log, fn_task_document tools,
fn_send_message, fn_read_messages, fn_post_room_message, fn_list_agents, fn_delegate_task, and memory tools.

**Task Documents:** Save important findings with fn_task_document_write(key="...", content="...").
Documents persist across sessions and are visible in the dashboard's Documents tab.

## Triage and Routing Decisions

Use this decision rule:
- **Log only (fn_task_log):** when the information is contextual, transient, or tied to this task's current state.
- **Task document (fn_task_document_write):** when findings are structured and likely useful across future sessions for the same task.
- **Create task (fn_task_create):** when someone must do new executable work.
- **Delegate task (fn_delegate_task):** when that new work should go to a specific agent based on role/availability.
- **Manage report config (fn_get_agent_config / fn_update_agent_config):** when direct reports need heartbeat, instruction, or personality tuning.

Prefer fn_task_create when assignment is unclear and scheduler routing is fine.
Prefer fn_delegate_task when immediate ownership by a specific agent materially reduces latency or risk.

## Common Patterns

- **Blocked task:** log the concrete blocker, chase the dependency via fn_send_message, create a narrowly scoped unblocker task if needed.
- **Stuck task with no blockedBy:** log the observation and create a follow-up task to investigate the root cause.
- **Completed task with follow-up risk:** create explicit follow-up task(s) for residual risk instead of burying notes in a long log.
- **New user/agent comments:** summarize what changed, identify required action, and route via task creation/delegation.
- **Dependency drift:** log the mismatch and create reconciliation tasks with clear dependencies.

## Memory Boundaries

You may receive an Agent Memory section and a Project Memory section.
- Agent Memory is specific to you, including imported and user-created agents such as CEO-style coordinator agents. It has its own long-term memory, daily notes, dreams, and qmd-backed retrieval under .fusion/agent-memory/{agentId}/.
- Project Memory is the workspace memory system under .fusion/memory/ with long-term memory, daily notes, dreams, and qmd-backed retrieval.
- Keep these separate: do not copy personal agent operating notes into Project Memory unless they are genuinely useful to every future agent in this workspace.
- Agent Memory examples: your own delegation habits, personal review checklist, preferred communication style.
- Project Memory examples: repository-wide conventions, durable pitfalls, architecture constraints every future agent should know.

## Processing Messages

When you are woken by an incoming message (source includes "wake-on-message"), you should:
1. Use fn_read_messages to check your inbox for unread messages.
2. For each message, classify it: informational, question, request, or escalation.
3. Take one concrete action per actionable message:
   - If the message requires a response, use fn_send_message to reply.
   - When replying, include 'reply_to_message_id' with the original message ID from fn_read_messages output.
   - If the message is informational, acknowledge it by logging with fn_task_log.
   - If the message requests net-new work, first check whether an open task already covers it; only call fn_task_create when no existing open task matches.
   - If ownership is clear and an agent is available, delegate using fn_delegate_task.
4. If a Pending Room Messages section is present, review it too:
   - Use fn_post_room_message only when the room content is relevant to your role, soul, or identity.
   - If a Room Ambiguity Notices section is present, follow it exactly: echo resolved referents before acting, and under clarification notices do not create tasks.
   - If a Room Coordination Notices section is present, follow its claim/defer branch exactly: under "claim" post a one-line claim before calling fn_task_create; under "defer-suggested" do NOT call fn_task_create and instead acknowledge the prior claim via fn_post_room_message.
   - Reference room message IDs when replying so humans can trace context.
5. After processing messages, continue with your normal heartbeat duties.

Example flow:
- Read unread messages → identify "needs action" item → reply with intent (reply_to_message_id) → create/delegate task if execution is needed → log key decision.

When sending messages:
- Be concise and clear about what you need or what you've done.
- Use 'reply_to_message_id' when replying so threaded conversations stay linked.
- Include relevant context (task IDs, file paths) in metadata when applicable.
- Use agent-to-agent for inter-agent communication.`;

/**
 * System prompt for no-task heartbeat agent sessions.
 * Instructs the agent to perform ambient work only with tools that do not require task context.
 */
export const HEARTBEAT_NO_TASK_SYSTEM_PROMPT = `You are a heartbeat agent running in a short execution window with no task assignment.

## Your Role

You are an ambient coordinator. You scan signals (messages, memory, board state), make one high-leverage move, and hand execution to the right workflow.
You are not expected to implement large code changes in no-task mode.

Your job:
1. Review your context — check messages, memory, and project state.
2. Do ONE useful action: analyze, create follow-up tasks, delegate work, or update memory.
3. Use fn_task_create to spawn follow-up work — but first scan the board/context for an existing open task covering the same work; do not duplicate.
4. Use fn_list_agents and fn_delegate_task to coordinate with other agents.
5. Use fn_get_agent_config and fn_update_agent_config to read/tune direct-report agents for better routing outcomes.
6. Call fn_heartbeat_done when finished with an optional summary of what was accomplished.

Examples of ONE useful action:
- DO: create a clearly scoped task for a newly discovered reliability issue.
- DO: delegate a ready-to-run task to an idle specialist agent.
- DO: append durable cross-task conventions to memory.
- DON'T: open multiple loosely defined tasks in one run.
- DON'T: attempt implementation work that requires task-scoped tooling/context.

Keep work lightweight — this is a single-pass ambient check, not a full implementation run.
You have coding-capable workspace tools (read/write/edit/bash within worktree boundaries) plus:
- fn_task_create
- fn_list_agents and fn_delegate_task
- fn_get_agent_config and fn_update_agent_config (for direct reports only)
- fn_agent_create and fn_agent_delete (for direct reports only)
- fn_read_evaluations and fn_update_identity (available in no-task runs)
- fn_reflect_on_performance when reflection is enabled for this run
- fn_web_fetch
- fn_memory_search, fn_memory_get, and fn_memory_append
- fn_heartbeat_done
- fn_send_message, fn_read_messages, and fn_post_room_message when messaging/room tools are enabled for this run (they may not always be available)

## Triage and Routing Decisions

Use this decision rule:
- **fn_task_create:** create executable work when ownership is not predetermined.
- **fn_delegate_task:** assign immediately when a specific agent should own the work now.
- **fn_memory_append:** use \`scope="agent"\` for your own operating context and \`scope="project"\` for repo-wide durable knowledge; avoid transient run-by-run chatter.

If unsure who should do the work, prefer fn_task_create and let scheduler routing happen naturally.

## Common Patterns

- **Unowned risk discovered:** create one focused task with concrete acceptance language.
- **Known specialist needed:** list agents, then delegate to matching role/capability.
- **Repeated confusion across runs:** append a concise memory entry so future agents avoid the same mistake.
- **Message requests action:** reply first, then create/delegate follow-up work when execution is required.

## Memory Boundaries

You may receive an Agent Memory section and a Project Memory section.
- Agent Memory is specific to you, including imported and user-created agents such as CEO-style coordinator agents. It has its own long-term memory, daily notes, dreams, and qmd-backed retrieval under .fusion/agent-memory/{agentId}/.
- Project Memory is the workspace memory system under .fusion/memory/ with long-term memory, daily notes, dreams, and qmd-backed retrieval.
- Keep these separate: do not copy personal agent operating notes into Project Memory unless they are genuinely useful to every future agent in this workspace.
- Agent Memory examples: your personal decision heuristics or preferred delegation style.
- Project Memory examples: durable architecture constraints, testing conventions, or known repository pitfalls.

## Processing Messages

When you are woken by an incoming message (source includes "wake-on-message"), you should:
1. If fn_read_messages is available, use it to check your inbox for unread messages.
2. Review each message and determine the appropriate action:
   - If the message requires a response and fn_send_message is available, use fn_send_message to reply.
   - When replying, include 'reply_to_message_id' with the original message ID from fn_read_messages output.
   - If the message is informational, acknowledge it and respond via fn_send_message when appropriate.
   - If the message requests work, check whether an open task already covers it; only create a follow-up with fn_task_create when no existing open task matches.
   - If the request has a clear owner and fn_delegate_task is available, delegate it directly.
3. If a Pending Room Messages section is present, review it too and use fn_post_room_message only when the room content is relevant to your role or identity; if Room Ambiguity Notices are present, follow their resolve/clarify branch instructions exactly. If a Room Coordination Notices section is present, follow its claim/defer branch exactly: under "claim" post a one-line claim before calling fn_task_create; under "defer-suggested" do NOT call fn_task_create and instead acknowledge the prior claim via fn_post_room_message.
4. After processing messages, continue with your ambient work.

Example flow:
- Read inbox → classify message → reply with reply_to_message_id → create/delegate follow-up if needed → finish with fn_heartbeat_done.

When sending messages:
- Be concise and clear about what you need or what you've done.
- Use 'reply_to_message_id' when replying so threaded conversations stay linked.
- Include relevant context (task IDs, file paths) in metadata when applicable.
- Use agent-to-agent for inter-agent communication.`;

// Backward-compatible alias; prefer HEARTBEAT_NO_TASK_SYSTEM_PROMPT.
export const HEARTBEAT_SYSTEM_PROMPT_NO_TASK = HEARTBEAT_NO_TASK_SYSTEM_PROMPT;

/**
 * Per-tick heartbeat procedure appended to every execution prompt. Forces the
 * agent to re-anchor on its own operating procedure each wake instead of
 * silently grinding on a previously assigned task.
 */
export const HEARTBEAT_PROCEDURE_STRICT = `## Heartbeat Procedure (run every tick, in order)

1. **Identity & context** — review the **Identity Snapshot** at the top of
   this prompt. Confirm your role, soul, instructions, and memory match what
   you expect, and surface any anomalies in your first text output before
   doing anything else. The full content is in the Custom Instructions
   section of your system prompt.
2. **Inbox** — when fn_read_messages is available, call it immediately and
   process unread/pending messages before any other action; reply with
   reply_to_message_id when answering. If Pending Room Messages are present,
   review them in the prompt and use fn_post_room_message only when relevant.
   When Room Ambiguity Notices appear, follow the resolve/clarify branch and do
   not create tasks under clarification notices. If a Room Coordination Notices
   section is present, follow its claim/defer branch exactly: under "claim" post
   a one-line claim before calling fn_task_create; under "defer-suggested" do
   NOT call fn_task_create and instead acknowledge the prior claim via
   fn_post_room_message.
3. **Wake delta** — read the Wake Delta block above. The wake reason is the
   highest-priority change for this heartbeat. If you were woken by a comment
   or a message, acknowledge it before doing anything else.
4. **Classify the bound task** — if you have an assigned task, classify it as
   exactly one of:
   - **executor-class** — implementation work: writing code, tests,
     documentation prose, or running build/lint/typecheck.
   - **blocked** — task has blockedBy set, or is waiting on a peer / dependency
     / external input.
   - **coordination-class** — planning, triage, routing, decision-making, or
     review.
   Then branch:
   - If the bound task is **executor-class** or **blocked**, skim it once for
     blocker risk, do not re-read PROMPT.md to advance it, and pivot this
     heartbeat to broader board signals (in-progress risk scan, stale in-review
     queue, idle direct reports, and strategic themes in memory). Inbox is
     already handled in step 2.
   - If the bound task is **coordination-class**, engage directly with the
     bound task.
5. **Pick the next concrete action** — exactly ONE useful action this heartbeat:
   advance the task, create a follow-up, log findings, delegate, or update
   memory. Don't stop at planning unless the task is a planning task.
6. **Persist progress** — fn_task_log for observations, fn_task_document_write
   for durable findings, status updates only when the work warrants it.
7. **Per-tick self-check** — before exiting, verify all three:
   - Was the inbox processed?
   - Is the chosen action on a coordination-shaped lever?
   - If the bound task was executor-class, did I avoid re-planning it?
8. **Exit** — call fn_heartbeat_done with a one-line summary of what changed
   this tick. If you took no action, say so and explain why.

Critical: a heartbeat without observable progress (a log, a document write, a
status change, a comment, a delegation, or an explicit "no-op with reason") is
a bug. Do not loop on the same plan across heartbeats without recording why.`;

export const HEARTBEAT_PROCEDURE_LITE = `## Heartbeat Procedure (run every tick, in order)

1. **Identity & context** — review the **Identity Snapshot** at the top of
   this prompt. Confirm your role, soul, instructions, and memory match what
   you expect, and surface any anomalies in your first text output before
   doing anything else. The full content is in the Custom Instructions
   section of your system prompt.
2. **Inbox** — when fn_read_messages is available, call it immediately and
   process unread/pending messages before any other action; reply with
   reply_to_message_id when answering.
3. **Wake delta** — read the Wake Delta block above. The wake reason is the
   highest-priority change for this heartbeat. If you were woken by a comment
   or a message, acknowledge it before doing anything else.
4. **Assignment review** — if you have an assigned task, re-read its current
   description, latest comments, and any task documents. Decide whether the
   prior plan is still valid given the wake delta. Do not assume yesterday's
   plan is still correct.
5. **Classify scope before acting** — label the next action as either:
   - **In-scope execution:** directly advances the assigned task's current
     acceptance criteria.
   - **Out-of-scope discovery:** useful but separate work; capture it as a
     focused follow-up task instead of expanding the current task silently.
6. **Pick the next concrete action** — exactly ONE useful action this heartbeat:
   advance the task, create a follow-up, log findings, delegate, or update
   memory. Don't stop at planning unless the task is a planning task.
7. **Persist progress** — fn_task_log for observations, fn_task_document_write
   for durable findings, status updates only when the work warrants it.
8. **Exit** — call fn_heartbeat_done with a one-line summary of what changed
   this tick. If you took no action, say so and explain why.

Critical: a heartbeat without observable progress (a log, a document write, a
status change, a comment, a delegation, or an explicit "no-op with reason") is
a bug. Do not loop on the same plan across heartbeats without recording why.`;

export const HEARTBEAT_PROCEDURE_OFF = `## Heartbeat Procedure (run every tick, in order)

1. **Identity & context** — review the **Identity Snapshot** at the top of this prompt.
2. **Inbox** — when fn_read_messages is available, call it immediately and process unread/pending messages.
3. **Wake delta** — read the Wake Delta block above and handle the highest-priority change first.
4. **Pick one concrete action** — do exactly one useful thing this tick.
5. **Persist progress** — record the action via available task/memory tools.
6. **Exit** — call fn_heartbeat_done with a one-line summary.

Critical: a heartbeat without observable progress (or an explicit no-op reason) is a bug.`;

// Backward-compatible alias; prefer HEARTBEAT_PROCEDURE_STRICT.
export const HEARTBEAT_PROCEDURE = HEARTBEAT_PROCEDURE_STRICT;

/**
 * No-task variant of HEARTBEAT_PROCEDURE. Keep this aligned with the ambient
 * tool set (no fn_task_log / fn_task_document_* in no-task runs).
 */
export const HEARTBEAT_NO_TASK_PROCEDURE_STRICT = `## Heartbeat Procedure (run every tick, in order)

1. **Identity & context** — review the **Identity Snapshot** at the top of
   this prompt. Confirm your role, soul, instructions, and memory match what
   you expect, and surface any anomalies in your first text output before
   doing anything else. The full content is in the Custom Instructions
   section of your system prompt.
2. **Inbox** — when fn_read_messages is available, call it immediately and
   process unread/pending messages before any other action; reply with
   reply_to_message_id when answering. If Pending Room Messages are present,
   review them in the prompt and use fn_post_room_message only when relevant.
   When Room Ambiguity Notices appear, follow the resolve/clarify branch and do
   not create tasks under clarification notices. If a Room Coordination Notices
   section is present, follow its claim/defer branch exactly: under "claim" post
   a one-line claim before calling fn_task_create; under "defer-suggested" do
   NOT call fn_task_create and instead acknowledge the prior claim via
   fn_post_room_message.
3. **Wake delta** — read the Wake Delta block above. The wake reason is the
   highest-priority change for this heartbeat. If you were woken by a comment
   or a message, acknowledge it before doing anything else.
4. **Ambient review** — since you have no assigned task, review board/project
   signals and recent memory context before acting. No-task heartbeat runs are
   inherently coordination-class because no bound task exists to classify.
5. **Classify scope before acting** — label the next action as either:
   - **Board-scope execution:** work that can be completed now with ambient
     tools (coordination, delegation, messaging, memory updates).
   - **Implementation-scope discovery:** code/product work that needs a task;
     create a focused task instead of attempting unscheduled implementation.
6. **Pick the next concrete action** — exactly ONE useful action this heartbeat:
   create a focused task, delegate work, send/reply to a message, or append
   durable memory.
7. **Persist progress** — use available ambient tools only:
   fn_task_create, fn_delegate_task, fn_send_message, fn_memory_append.
8. **Exit** — call fn_heartbeat_done with a one-line summary of what changed
   this tick. If you took no action, say so and explain why.

Critical: a heartbeat without observable progress (a created task, delegation,
message reply, memory append, or explicit "no-op with reason") is a bug. Do
not loop on the same plan across heartbeats without recording why.`;

export const HEARTBEAT_NO_TASK_PROCEDURE_LITE = `## Heartbeat Procedure (run every tick, in order)

1. **Identity & context** — review the **Identity Snapshot** at the top of
   this prompt. Confirm your role, soul, instructions, and memory match what
   you expect, and surface any anomalies in your first text output before
   doing anything else. The full content is in the Custom Instructions
   section of your system prompt.
2. **Inbox** — when fn_read_messages is available, call it immediately and
   process unread/pending messages before any other action; reply with
   reply_to_message_id when answering.
3. **Wake delta** — read the Wake Delta block above. The wake reason is the
   highest-priority change for this heartbeat. If you were woken by a comment
   or a message, acknowledge it before doing anything else.
4. **Ambient review** — since you have no assigned task, review board/project
   signals and recent memory context before acting.
5. **Classify scope before acting** — label the next action as either:
   - **Board-scope execution:** work that can be completed now with ambient
     tools (coordination, delegation, messaging, memory updates).
   - **Implementation-scope discovery:** code/product work that needs a task;
     create a focused task instead of attempting unscheduled implementation.
6. **Pick the next concrete action** — exactly ONE useful action this heartbeat:
   create a focused task, delegate work, send/reply to a message, or append
   durable memory.
7. **Persist progress** — use available ambient tools only:
   fn_task_create, fn_delegate_task, fn_send_message, fn_memory_append.
8. **Exit** — call fn_heartbeat_done with a one-line summary of what changed
   this tick. If you took no action, say so and explain why.

Critical: a heartbeat without observable progress (a created task, delegation,
message reply, memory append, or explicit "no-op with reason") is a bug. Do
not loop on the same plan across heartbeats without recording why.`;

export const HEARTBEAT_NO_TASK_PROCEDURE_OFF = `## Heartbeat Procedure (run every tick, in order)

1. **Identity & context** — review the **Identity Snapshot** at the top of this prompt.
2. **Inbox** — when fn_read_messages is available, call it immediately and process unread/pending messages.
3. **Wake delta** — read the Wake Delta block above and handle the highest-priority change first.
4. **Pick one concrete action** — do exactly one useful thing this tick.
5. **Persist progress** — use available ambient tools only.
6. **Exit** — call fn_heartbeat_done with a one-line summary.

Critical: a heartbeat without observable progress (or an explicit no-op reason) is a bug.`;

// Backward-compatible alias; prefer HEARTBEAT_NO_TASK_PROCEDURE_STRICT.
export const HEARTBEAT_NO_TASK_PROCEDURE = HEARTBEAT_NO_TASK_PROCEDURE_STRICT;

/** Parameter schema for the fn_heartbeat_done tool */
const heartbeatDoneParams = Type.Object({
  summary: Type.Optional(Type.String({ description: "Summary of what was accomplished this heartbeat" })),
});

/**
 * Truncate a string to `maxChars`, appending a marker so callers can see
 * content was clipped.  Returns the original string unchanged when it fits.
 */
function truncatePrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n... (truncated, ${text.length} chars)`;
}

/**
 * Build the per-tick **Identity Snapshot** block injected into every
 * heartbeat execution prompt.
 *
 * Why inline (not just a tool): plugin runtimes (openclaw, hermes, paperclip)
 * wrap external CLIs and may not propagate JS `customTools` callbacks to the
 * underlying agent. Embedding the snapshot in the prompt body guarantees the
 * agent always sees its identity regardless of runtime tool support.
 *
 * The full soul/instructions/memory content is already loaded in the system
 * prompt's Custom Instructions section. The snapshot intentionally carries
 * only presence flags + 8-char content hashes — enough to detect drift or
 * misload, without paying a multi-KB preview tax on every tick.
 */
function shortContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

type SnapshotFieldStatus = "loaded" | "unset" | "empty" | "load-error";

type SnapshotFieldState = {
  status: SnapshotFieldStatus;
  value?: string;
};

export function buildIdentitySnapshot(args: {
  agent: Agent;
  resolvedInstructions: SnapshotFieldState;
  workspaceMemory: SnapshotFieldState;
}): string {
  const { agent, resolvedInstructions, workspaceMemory } = args;

  const toSnapshotState = (value: unknown): SnapshotFieldState => {
    if (value === undefined || value === null) {
      return { status: "unset" };
    }
    const normalized = typeof value === "string" ? value.trim() : String(value).trim();
    if (!normalized) {
      return { status: "empty" };
    }
    return { status: "loaded", value: normalized };
  };

  const formatField = (
    field: SnapshotFieldState,
    source?: "inline" | "workspace",
  ): string => {
    if (field.status !== "loaded") {
      return field.status;
    }
    const sourceLabel = source ? `, source: ${source}` : "";
    return `loaded (${field.value!.length} chars, sha256:${shortContentHash(field.value!)}${sourceLabel})`;
  };

  const soulState = toSnapshotState(agent.soul);
  const inlineMemoryState = toSnapshotState(agent.memory);
  const memoryState = inlineMemoryState.status === "loaded"
    ? inlineMemoryState
    : workspaceMemory;
  const memorySource = inlineMemoryState.status === "loaded"
    ? "inline"
    : memoryState.status === "loaded" ? "workspace" : undefined;

  return [
    "## Identity Snapshot",
    "",
    "Full content is in the Custom Instructions section of your system prompt. Surface anomalies in your first text output before acting.",
    "",
    `- agentId: ${agent.id}`,
    `- name: ${agent.name}`,
    `- role: ${agent.role}`,
    `- soul: ${formatField(soulState)}`,
    `- instructions: ${formatField(resolvedInstructions)}`,
    `- memory: ${formatField(memoryState, memorySource)}`,
  ].join("\n");
}

async function getHeartbeatMemorySettings(taskStore: TaskStore): Promise<Settings | undefined> {
  const maybeGetSettings = (taskStore as { getSettings?: () => Promise<Settings> }).getSettings;
  if (!maybeGetSettings) {
    return undefined;
  }
  return maybeGetSettings.call(taskStore);
}

/**
 * HeartbeatMonitor monitors agents via periodic polling.
 * Detects missed heartbeats, auto-terminates unresponsive agents,
 * and provides the Paperclip-style execution engine via executeHeartbeat().
 */
export class HeartbeatMonitor {
  private store: AgentStore;
  private configStore: AgentStore;
  private pollIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private maxConcurrentRuns: number;
  private onMissed?: (agentId: string, reason: string) => void;
  private onRecovered?: (agentId: string) => void;
  private onTerminated?: (agentId: string, reason: string) => void;
  private onRunStarted?: (agentId: string, run: AgentHeartbeatRun) => void;
  private onRunCompleted?: (agentId: string, run: AgentHeartbeatRun) => void;
  private taskStore?: TaskStore;
  private rootDir?: string;
  private messageStore?: MessageStore;
  private chatStore?: ChatStore;
  private pluginRunner?: import("./plugin-runner.js").PluginRunner;
  private reflectionStore?: ReflectionStore;
  private reflectionService?: AgentReflectionService;
  private selfImproveService?: SelfImproveServiceLike;
  private approvalRequestStore?: ApprovalRequestStore;
  private snapshotManager?: AutoClaimSnapshotManager;
  private secretsStore?: Pick<import("@fusion/core").SecretsStore, "listEnvExportable">;

  private trackedAgents: Map<string, TrackedAgent> = new Map();
  private agentStartLocks: Map<string, Promise<unknown>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private cachedHeartbeatMultiplier = 1;
  private cachedHeartbeatMultiplierAt = 0;

  /** Tasks created per agent during heartbeat runs (keyed by agentId) */
  private runCreatedTasks: Map<string, Array<{ id: string; description: string }>> = new Map();

  constructor(options: HeartbeatMonitorOptions) {
    this.store = options.store;
    this.configStore = options.agentStore ?? options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_600_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60000;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
    this.onMissed = options.onMissed;
    this.onRecovered = options.onRecovered;
    this.onTerminated = options.onTerminated;
    this.onRunStarted = options.onRunStarted;
    this.onRunCompleted = options.onRunCompleted;
    this.taskStore = options.taskStore;
    this.rootDir = options.rootDir;
    this.messageStore = options.messageStore;
    this.chatStore = options.chatStore;
    this.pluginRunner = options.pluginRunner;
    this.reflectionStore = options.reflectionStore;
    this.reflectionService = options.reflectionService;
    this.selfImproveService = options.selfImproveService;
    this.snapshotManager = options.snapshotManager ?? (this.taskStore ? new AutoClaimSnapshotManager({ taskStore: this.taskStore }) : undefined);
    this.secretsStore = options.secretsStore;
  }

  getChatStore(): ChatStore | undefined {
    return this.chatStore;
  }

  private async resolveRoomMessageSinceIso(agent: Agent, activeRunId: string): Promise<string> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const recentRuns = await this.store.getRecentRuns(agent.id, 10);
      const previousCompletedRun = recentRuns.find((candidate) => candidate.id !== activeRunId && candidate.endedAt);
      const candidateIso = previousCompletedRun?.endedAt ?? agent.lastHeartbeatAt ?? twentyFourHoursAgo;
      const candidateTime = Date.parse(candidateIso);
      if (!Number.isFinite(candidateTime)) {
        return twentyFourHoursAgo;
      }
      return new Date(Math.max(candidateTime, Date.now() - 24 * 60 * 60 * 1000)).toISOString();
    } catch (error) {
      heartbeatLog.warn(`Failed to resolve room-message lookback for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
      const fallbackTime = Date.parse(agent.lastHeartbeatAt ?? twentyFourHoursAgo);
      if (!Number.isFinite(fallbackTime)) {
        return twentyFourHoursAgo;
      }
      return new Date(Math.max(fallbackTime, Date.now() - 24 * 60 * 60 * 1000)).toISOString();
    }
  }

  private getPendingRoomMessagesSection(entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }>, truncatedCount: number): string[] {
    if (entries.length === 0) {
      return [];
    }

    const lines = ["", "Pending Room Messages:"];
    for (const entry of entries) {
      lines.push(`- [room: ${entry.room.name} (${entry.room.id})]`);
      for (const message of entry.messages) {
        const normalized = message.content.replace(/\s+/g, " ").trim();
        const truncatedContent = normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
        lines.push(`  - [from: ${message.senderAgentId ?? "user"}] [${message.id}] ${truncatedContent}`);
      }
    }
    if (truncatedCount > 0) {
      lines.push(`  - (${truncatedCount} more truncated)`);
    }
    return lines;
  }

  private async getRoomAmbiguityNoticesSection(
    agent: Agent,
    runId: string,
    entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }>,
    audit: ReturnType<typeof createRunAuditor>,
  ): Promise<string[]> {
    if (!this.chatStore || entries.length === 0) {
      return [];
    }

    const lines: string[] = [];

    for (const entry of entries) {
      for (const message of entry.messages) {
        const detection = detectDeicticReference(message.content);
        if (!detection.isDeictic) {
          continue;
        }

        const roomTimeline = this.chatStore.getRoomMessages(entry.room.id, { limit: 100 });
        const messageIndex = roomTimeline.findIndex((roomMessage) => roomMessage.id === message.id);
        if (messageIndex <= 0) {
          continue;
        }
        const recentMessages = roomTimeline.slice(Math.max(0, messageIndex - 15), messageIndex);
        const candidates = extractAntecedentCandidates(recentMessages);
        const decision = scoreReferentConfidence(candidates);
        const branch = decision.confidence === "high" ? "resolved" : "clarification";
        const promptBlock = renderAmbiguityPromptBlock({ ...decision, candidates }, message);

        if (lines.length === 0) {
          lines.push("", "Room Ambiguity Notices:");
        }

        lines.push(
          `- [room: ${entry.room.name} (${entry.room.id})] [message: ${message.id}] [branch: ${branch}]`,
          ...promptBlock.map((line) => `  - ${line}`),
        );

        await audit.database({
          type: "room:ambiguity:branch",
          target: message.id,
          metadata: {
            roomId: entry.room.id,
            agentId: agent.id,
            branch,
            candidateCount: candidates.length,
            cues: detection.cues,
          },
        });

        heartbeatLog.log(
          `[room-ambiguity] agent=${agent.id} run=${runId} room=${entry.room.id} messageId=${message.id} branch=${branch} candidates=${candidates.length}`,
        );
      }
    }

    return lines;
  }

  private async getRoomCoordinationNoticesSection(
    agent: Agent,
    runId: string,
    entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }>,
    audit: ReturnType<typeof createRunAuditor>,
  ): Promise<string[]> {
    if (!this.chatStore || entries.length === 0) {
      return [];
    }

    const lines: string[] = [];

    for (const entry of entries) {
      for (const message of entry.messages) {
        try {
          const detection = detectTaskFilingIntent(message.content);
          if (!detection.isTaskFilingIntent) {
            continue;
          }

          const members = this.chatStore.listRoomMembers(entry.room.id);
          if (countActiveAgentMembers(members) < 2) {
            continue;
          }

          const roomTimeline = this.chatStore.getRoomMessages(entry.room.id, { limit: 100 });
          const messageIndex = roomTimeline.findIndex((roomMessage) => roomMessage.id === message.id);
          if (messageIndex < 0) {
            continue;
          }
          // messageIndex === 0 means no prior messages; coordination correctly defaults to claim.
          const recentMessages = messageIndex === 0
            ? []
            : roomTimeline.slice(Math.max(0, messageIndex - 15), messageIndex);

          const decision = decideRoomCoordination({
            detection,
            members,
            recentMessages,
            pendingSenderAgentId: message.senderAgentId ?? agent.id,
          });
          if (!decision) {
            continue;
          }

          if (lines.length === 0) {
            lines.push("", "Room Coordination Notices:");
          }

          lines.push(
            `- [room: ${entry.room.name} (${entry.room.id})] [message: ${message.id}] [branch: ${decision.branch}]`,
            ...renderRoomCoordinationPromptBlock(decision, message).map((line) => `  - ${line}`),
          );

          await audit.database({
            type: "room:coordination:branch",
            target: message.id,
            metadata: {
              roomId: entry.room.id,
              agentId: agent.id,
              branch: decision.branch,
              memberCount: decision.memberCount,
              intentCue: detection.cues[0] ?? null,
              priorClaimMessageId: decision.priorClaimMessageId ?? null,
              priorTaskId: decision.priorTaskId ?? null,
            },
          });

          heartbeatLog.log(
            `[room-coordination] agent=${agent.id} run=${runId} room=${entry.room.id} messageId=${message.id} branch=${decision.branch} members=${decision.memberCount}`,
          );
        } catch (err) {
          heartbeatLog.warn(`Room coordination notice failed for ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return lines;
  }

  private async getPendingRoomMessages(agent: Agent, sinceIso: string): Promise<{
    entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }>;
    total: number;
    truncatedCount: number;
  }> {
    if (!this.chatStore) {
      return { entries: [], total: 0, truncatedCount: 0 };
    }

    try {
      const rooms = this.chatStore.listRoomsForAgent(agent.id, { status: "active" });
      const entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }> = [];
      let total = 0;
      let surfaced = 0;
      let truncatedCount = 0;

      for (const room of rooms) {
        const messages = this.chatStore.listRoomMessagesSince(room.id, sinceIso, {
          excludeSenderAgentId: agent.id,
          limit: 10,
        });
        if (messages.length === 0) {
          continue;
        }

        total += messages.length;
        const remaining = 30 - surfaced;
        if (remaining <= 0) {
          truncatedCount += messages.length;
          continue;
        }

        const surfacedMessages = messages.slice(0, remaining);
        truncatedCount += messages.length - surfacedMessages.length;
        entries.push({ room, messages: surfacedMessages });
        surfaced += surfacedMessages.length;
      }

      return { entries, total, truncatedCount };
    } catch (error) {
      heartbeatLog.warn(`Failed to fetch room messages for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
      return { entries: [], total: 0, truncatedCount: 0 };
    }
  }

  private getApprovalRequestStore(): ApprovalRequestStore {
    if (!this.approvalRequestStore) {
      if (!this.taskStore) {
        throw new Error("HeartbeatMonitor missing taskStore for approval request persistence");
      }
      this.approvalRequestStore = new ApprovalRequestStore(this.taskStore.getDatabase());
    }
    return this.approvalRequestStore;
  }

  private buildActionGateContext(agent: Agent, taskId?: string, runId?: string, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]> }): AgentActionGateContext | undefined {
    if (isEphemeralAgent(agent)) {
      return undefined;
    }
    const policy = resolveEffectiveAgentPermissionPolicy(agent.permissionPolicy, projectDefaultPolicy);
    return {
      agentId: agent.id,
      agentName: agent.name,
      isEphemeral: false,
      taskId,
      runId,
      permissionPolicy: policy,
      createApprovalRequest: async (decision, args) => this.getApprovalRequestStore().create({
        requester: { actorId: agent.id, actorType: "agent", actorName: agent.name },
        taskId,
        runId,
        targetAction: {
          category: decision.category === "exempt" ? "command_execution" : decision.category,
          action: decision.operation,
          summary: decision.summary,
          resourceType: decision.resourceType,
          resourceId: decision.resourceId ?? "",
          context: { ...decision.metadata, approvalDedupeKey: decision.approvalDedupeKey, toolName: decision.toolName, toolArgs: args },
        },
      }),
      findApprovalByDedupeKey: async (dedupeKey) => {
        const latest = this.getApprovalRequestStore().findLatestByDedupeKey({ requesterActorId: agent.id, taskId, dedupeKey });
        return latest ? { id: latest.id, status: latest.status } : null;
      },
      findPendingApprovalByDedupeKey: async (dedupeKey) => {
        const latest = this.getApprovalRequestStore().findLatestByDedupeKey({ requesterActorId: agent.id, taskId, dedupeKey });
        return latest?.status === "pending" ? { id: latest.id } : null;
      },
      pauseForApproval: async ({ approvalRequestId, decision }) => {
        if (taskId && this.taskStore) {
          await this.taskStore.pauseTask(taskId, true, undefined, { pausedByAgentId: agent.id });
          await this.taskStore.logEntry(
            taskId,
            `Approval required for ${decision.toolName}. Request ${approvalRequestId} created; task and agent paused awaiting decision.`,
          );
        }
        await this.store.updateAgentState(agent.id, "paused");
        await this.store.updateAgent(agent.id, { pauseReason: "awaiting-approval" });
      },
      markApprovalCompleted: async (approvalRequestId) => {
        await this.getApprovalRequestStore().markCompleted(approvalRequestId, {
          actor: { actorId: agent.id, actorType: "agent", actorName: agent.name },
          note: "Tool executed after approval",
        });
      },
    };
  }

  private buildPermanentAgentGatingContext(agent: Agent, taskId?: string, runId?: string, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]> }): import("@fusion/core").PermanentAgentGatingContext | undefined {
    if (isEphemeralAgent(agent)) {
      return undefined;
    }

    return {
      permissionPolicy: resolveEffectiveAgentPermissionPolicy(agent.permissionPolicy, projectDefaultPolicy),
      requester: { actorId: agent.id, actorType: "agent", actorName: agent.name },
      taskId,
      runId,
      createApprovalRequest: async ({ category, toolName, args }) => this.getApprovalRequestStore().create({
        requester: { actorId: agent.id, actorType: "agent", actorName: agent.name },
        taskId,
        runId,
        targetAction: {
          category,
          action: toolName,
          summary: `Permanent-agent gated action for ${toolName}`,
          resourceType: "tool",
          resourceId: toolName,
          context: {
            toolName,
            toolArgs: args,
            source: "permanent-agent-gating",
          },
        },
      }),
      findPendingApprovalRequest: async (dedupeKey) => {
        const pending = this.getApprovalRequestStore().list({ status: "pending", requesterActorId: agent.id, taskId, limit: 100 });
        return pending.find((request) => request.targetAction.context?.approvalDedupeKey === dedupeKey) ?? null;
      },
    };
  }

  /**
   * Start the heartbeat monitoring loop.
   * Safe to call multiple times - no-op if already running.
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    if (this.messageStore) {
      this.messageStore.setMessageToAgentHook(this.handleMessageToAgent.bind(this));
    }
    // Warm heartbeat multiplier cache for sync health paths before reconcile.
    void this.warmHeartbeatMultiplierCache();
    // Reconcile any agents stuck in `state="running"` with no active run.
    // Past versions of governance-skip paths (budget/global-pause) called
    // completeRun with skipStateTransition=true after startRun had already
    // moved the agent to "running", leaving the row stuck. New runs no
    // longer leak this way, but pre-existing rows need a one-shot fix.
    void this.reconcileOrphanedRunningAgents();
    this.pollInterval = setInterval(() => {
      void this.checkMissedHeartbeats();
    }, this.pollIntervalMs);
  }

  /**
   * Find agents in `state="running"` that are not actually running and flip
   * them to `"active"`. An agent is considered orphaned when either:
   *   (a) it has no active heartbeat run record, or
   *   (b) it is not in this monitor's in-memory tracked set AND its
   *       lastHeartbeatAt is older than 3× the configured timeout.
   *
   * Case (a) covers historical bypass paths (governance-skip, supersede-on-
   * startRun, safety-net run termination) that ended the run record but
   * never propagated the agent-state transition. Case (b) covers a process
   * that crashed mid-run, leaving both the run row and the agent row stuck.
   *
   * Called on monitor start AND periodically from the polling loop to keep
   * the system self-healing across versions. Best-effort — failures are
   * logged but do not block the caller.
   *
   * Complements SelfHealingManager.recoverAgentsRunningOnInactiveTasks():
   * heartbeat reconciliation handles stale/no-run conditions, while self-healing
   * handles task-column mismatches (for example running agents linked to todo tasks).
   */
  private async reconcileOrphanedRunningAgents(): Promise<void> {
    try {
      const runningAgents = await this.store.listAgents({ state: "running", includeEphemeral: true });
      const now = Date.now();
      for (const agent of runningAgents) {
        let reason: string | null = null;
        const activeRun = await this.store.getActiveHeartbeatRun(agent.id);
        if (!activeRun) {
          reason = "no active run";
        } else if (!this.trackedAgents.has(agent.id)) {
          const timeoutMs = this.resolveAgentConfig(agent.id).heartbeatTimeoutMs;
          const heartbeatAgeMs = getHeartbeatAgeMs(agent, now);
          // NOTE(FN-4278): this stale gate intentionally uses a per-run work-budget
          // multiplier (`heartbeatTimeoutMs × 3`) because this path is only for
          // untracked persisted `state="running"` rows where an in-memory tracked
          // session is absent. It is not the direct-report freshness classifier.
          // Freshness/staleness for active+idle reports is interval-based in
          // `buildReportsHealthSection()` and dashboard `agentHealth.tsx` via
          // `max(heartbeatIntervalMs × 4, 5m)` (FN-4255).
          if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > timeoutMs * 3) {
            try {
              await terminatePersistedHeartbeatRun(
                this.store,
                agent.id,
                activeRun.id,
                `Reconciled stale run (no heartbeat for ${Number.isFinite(heartbeatAgeMs) ? formatDuration(heartbeatAgeMs) : "unknown"}; threshold ${formatDuration(timeoutMs * 3)})`,
              );
            } catch (runEndErr) {
              heartbeatLog.warn(`Failed to terminate stale run ${activeRun.id} for ${agent.id}: ${runEndErr instanceof Error ? runEndErr.message : String(runEndErr)}`);
            }
            reason = `stale heartbeat (${Number.isFinite(heartbeatAgeMs) ? formatDuration(heartbeatAgeMs) : "unknown"} since lastHeartbeatAt)`;
          }
        }
        if (!reason) continue;
        try {
          await this.store.updateAgentState(agent.id, "active");
          this.clearRunState(agent.id);
          heartbeatLog.log(`Reconciled orphaned running agent ${agent.id} → active (${reason})`);
        } catch (err) {
          heartbeatLog.warn(`Failed to reconcile orphaned running agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      heartbeatLog.warn(`reconcileOrphanedRunningAgents scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stop the heartbeat monitoring loop.
   * Does not untrack agents - they remain in memory.
   */
  stop(): void {
    if (this.messageStore) {
      this.messageStore.setMessageToAgentHook(() => {});
    }
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Check if the monitor is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get the project root directory this monitor is bound to.
   * Returns undefined when not configured for execution.
   */
  getRootDir(): string | undefined {
    return this.rootDir;
  }

  /**
   * Register an agent for monitoring with optional session context.
   * @param agentId - The agent ID
   * @param session - Session with dispose() for cleanup
   * @param runId - The heartbeat run ID
   * @param sessionIdBefore - Optional session ID from before execution
   */
  trackAgent(agentId: string, session: AgentSession, runId: string, sessionIdBefore?: string): void {
    const tracked: TrackedAgent = {
      agentId,
      session,
      runId,
      lastSeen: Date.now(),
      missedHeartbeatReported: false,
      sessionIdBefore,
    };

    this.trackedAgents.set(agentId, tracked);

    // Record initial heartbeat
    void this.store.recordHeartbeat(agentId, "ok", runId);
  }

  /**
   * Serialize run starts per agent to prevent concurrent execution.
   * @param agentId - The agent ID
   * @param fn - Function to execute with the lock
   */
  async withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.agentStartLocks.get(agentId) ?? Promise.resolve();
    const operation = existing.then(
      async () => {
        try {
          return await fn();
        } finally {
          // Clean up accumulated run state for this agent at end of each serialized run.
          // This guarantees cleanup even when the run path throws without calling completeRun
          // (e.g., execution error before completeRun is reached, or completeRun itself throws).
          // Because withAgentStartLock serializes runs per agent, the finally runs after each
          // run completes but before the next concurrent call's callback starts.
          this.clearRunState(agentId);
        }
      },
      async (err) => {
        try {
          throw err;
        } finally {
          this.clearRunState(agentId);
        }
      },
    );
    this.agentStartLocks.set(agentId, operation);
    return operation as Promise<T>;
  }

  /**
   * Start a rich heartbeat run with full context capture.
   * Creates a structured run record and saves it to the run store.
   * @param agentId - The agent ID
   * @param options - Wakeup options with trigger context
   * @returns The created run
   */
  async startRun(agentId: string, options?: WakeupOptions): Promise<AgentHeartbeatRun> {
    // Safety net: fail any existing active runs for this agent before creating a new one.
    // This prevents accumulation of zombie runs when startRun is called multiple times
    // (e.g., concurrent timer + on-demand triggers, or retries after crashes).
    try {
      const existingRun = await this.store.getActiveHeartbeatRun(agentId);
      if (existingRun) {
        heartbeatLog.warn(
          `Agent ${agentId} has active run ${existingRun.id} — marking failed before starting new run`,
        );
        try {
          const existingDetail = await this.store.getRunDetail(agentId, existingRun.id);
          if (existingDetail) {
            await this.store.saveRun({
              ...existingDetail,
              endedAt: new Date().toISOString(),
              status: "terminated",
              stderrExcerpt: "Superseded by new heartbeat run (previous run was stale)",
            });
          }
          await this.store.endHeartbeatRun(existingRun.id, "terminated");
          this.clearRunState(agentId);
        } catch (failErr) {
          const failErrMessage = failErr instanceof Error ? failErr.message : String(failErr);
          heartbeatLog.warn(
            `Failed to terminate stale active run ${existingRun.id} for ${agentId}: ${failErrMessage} — continuing anyway`,
          );
        }
      }
    } catch (activeRunCheckErr) {
      const msg = activeRunCheckErr instanceof Error ? activeRunCheckErr.message : String(activeRunCheckErr);
      heartbeatLog.warn(`Failed to check for existing active run for ${agentId}: ${msg} — continuing with new run`);
    }

    const run = await this.store.startHeartbeatRun(agentId);

    // Enrich with execution context
    const enrichedRun: AgentHeartbeatRun = {
      ...run,
      invocationSource: options?.source ?? "on_demand",
      triggerDetail: options?.triggerDetail ?? "manual",
      contextSnapshot: options?.contextSnapshot,
      processPid: process.pid,
    };

    // Save rich run data
    await this.store.saveRun(enrichedRun);

    // Transition agent to running state
    try {
      await this.store.updateAgentState(agentId, "running");
    } catch (startRunErr) {
      heartbeatLog.warn(`updateAgentState(running) failed for ${agentId}: ${startRunErr instanceof Error ? startRunErr.message : String(startRunErr)} — continuing`);
    }

    this.onRunStarted?.(agentId, enrichedRun);
    return enrichedRun;
  }

  /**
   * Complete a heartbeat run with results.
   * @param agentId - The agent ID
   * @param runId - The run ID to complete
   * @param result - Execution results
   */
  async completeRun(
    agentId: string,
    runId: string,
    result: {
      status: "completed" | "failed" | "terminated";
      exitCode?: number;
      sessionIdAfter?: string;
      usageJson?: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number };
      resultJson?: Record<string, unknown>;
      stdoutExcerpt?: string;
      stderrExcerpt?: string;
      /** When true, preserve current agent state instead of forcing a terminal transition. */
      skipStateTransition?: boolean;
    }
  ): Promise<void> {
    // Load and update the run
    const run = await this.store.getRunDetail(agentId, runId);
    if (!run) return;

    const tracked = this.trackedAgents.get(agentId);
    let completionResult = result;

    // Merge accumulated task creations into resultJson
    const createdTasks = this.runCreatedTasks.get(agentId);
    const enrichedResultJson = createdTasks?.length
      ? { ...completionResult.resultJson, tasksCreated: createdTasks }
      : completionResult.resultJson;

    const completedRun: AgentHeartbeatRun = {
      ...run,
      endedAt: new Date().toISOString(),
      status: completionResult.status,
      exitCode: completionResult.exitCode,
      sessionIdBefore: tracked?.sessionIdBefore,
      sessionIdAfter: completionResult.sessionIdAfter,
      usageJson: completionResult.usageJson,
      resultJson: enrichedResultJson,
      stdoutExcerpt: completionResult.stdoutExcerpt,
      stderrExcerpt: completionResult.stderrExcerpt,
    };

    await this.store.saveRun(completedRun);

    // Clear accumulated run state for this agent.
    // Safe to call even when runCreatedTasks was already cleared by withAgentStartLock's
    // finally block (idempotent Map.delete), and necessary for direct completeRun calls
    // that bypass the lock (e.g., test scenarios, edge-case error paths).
    this.clearRunState(agentId);

    // Update cumulative usage on agent
    if (completionResult.usageJson) {
      try {
        const agent = await this.store.getAgent(agentId);
        if (agent) {
          await this.store.updateAgent(agentId, {
            totalInputTokens: (agent.totalInputTokens ?? 0) + completionResult.usageJson.inputTokens,
            totalOutputTokens: (agent.totalOutputTokens ?? 0) + completionResult.usageJson.outputTokens,
          });
        }
      } catch (usageUpdateErr) {
        heartbeatLog.warn(`Agent ${agentId} usage update failed: ${usageUpdateErr instanceof Error ? usageUpdateErr.message : String(usageUpdateErr)} — continuing`);
      }
    }

    // Budget governance: pause agent if over budget after usage update
    if (completionResult.usageJson && completionResult.status !== "failed" && completionResult.status !== "terminated") {
      try {
        const budgetStatus = await this.store.getBudgetStatus(agentId);
        if (budgetStatus.isOverBudget) {
          heartbeatLog.log(`Agent ${agentId} is over budget — pausing with reason "budget-exhausted"`);
          await this.store.updateAgentState(agentId, "paused");
          await this.store.updateAgent(agentId, { pauseReason: "budget-exhausted" });
          // Skip the normal state transition below since we already set the correct state
          completionResult = { ...completionResult, skipStateTransition: true };
        }
      } catch (budgetCheckErr) {
        heartbeatLog.warn(`Agent ${agentId} budget check failed: ${budgetCheckErr instanceof Error ? budgetCheckErr.message : String(budgetCheckErr)} — proceeding with normal state transition`);
      }
    }

    // Transition agent state based on result
    if (!completionResult.skipStateTransition) {
      try {
        if (completionResult.status === "failed") {
          await this.store.updateAgentState(agentId, "error");
          await this.store.updateAgent(agentId, { lastError: completionResult.stderrExcerpt ?? "Run failed" });
        } else if (completionResult.status === "terminated") {
          await this.store.updateAgentState(agentId, "paused");
        } else {
          // Completed successfully - back to active and clear any stale failure marker.
          await this.store.updateAgentState(agentId, "active");
          await this.store.updateAgent(agentId, { lastError: undefined });
        }
      } catch (stateTransErr) {
        heartbeatLog.warn(`Agent ${agentId} state transition failed: ${stateTransErr instanceof Error ? stateTransErr.message : String(stateTransErr)} — continuing`);
      }
    }

    // End the heartbeat run tracking
    await this.store.endHeartbeatRun(runId, completionResult.status === "completed" ? "completed" : "terminated");

    if (completionResult.status === "terminated") {
      this.onTerminated?.(agentId, completionResult.stderrExcerpt ?? "Run terminated");
    }
    this.onRunCompleted?.(agentId, completedRun);
  }

  /**
   * Stop an active heartbeat run for an agent.
   *
   * If an in-memory tracked session exists, dispose it and complete the run as terminated.
   * If no tracked session exists, fall back to persisted active-run state and terminate that run record.
   *
   * No-op when no active run exists.
   */
  async stopRun(agentId: string): Promise<void> {
    const tracked = this.trackedAgents.get(agentId);

    if (tracked) {
      heartbeatLog.log(`Stopping tracked run ${tracked.runId} for ${agentId}`);

      try {
        tracked.session.dispose();
      } catch (error) {
        heartbeatLog.warn(`Failed to dispose tracked session while stopping run for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      this.untrackAgent(agentId);

      await this.completeRun(agentId, tracked.runId, {
        status: "terminated",
        stderrExcerpt: "Run stopped by user",
      });

      try {
        await this.store.updateAgentState(agentId, "active");
      } catch (stopStateErr) {
        heartbeatLog.warn(`Agent ${agentId} updateAgentState(active) failed during stop: ${stopStateErr instanceof Error ? stopStateErr.message : String(stopStateErr)}`);
      }

      this.clearRunState(agentId);
      return;
    }

    const activeRun = await this.store.getActiveHeartbeatRun(agentId);
    if (!activeRun) {
      this.clearRunState(agentId);
      return;
    }

    heartbeatLog.log(`Stopping persisted run ${activeRun.id} for ${agentId} (no tracked session)`);

    const existingRun = await this.store.getRunDetail(agentId, activeRun.id);
    if (existingRun) {
      await this.store.saveRun({
        ...existingRun,
        endedAt: new Date().toISOString(),
        status: "terminated",
        stderrExcerpt: existingRun.stderrExcerpt ?? "Run stopped by user",
      });
    }

    await this.store.endHeartbeatRun(activeRun.id, "terminated");

    try {
      await this.store.updateAgentState(agentId, "active");
    } catch (stopPersistErr) {
      heartbeatLog.warn(`Agent ${agentId} updateAgentState(active) failed during persisted-run stop: ${stopPersistErr instanceof Error ? stopPersistErr.message : String(stopPersistErr)}`);
    }

    this.clearRunState(agentId);
  }

  async pauseAgent(agentId: string, options: PauseAgentOptions = {}): Promise<Agent> {
    const { pauseReason, stopActiveRun = false, cascadeToTasks = true } = options;

    if (stopActiveRun) {
      try {
        await this.stopRun(agentId);
      } catch (error) {
        heartbeatLog.warn(`pauseAgent(${agentId}) stopRun failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const current = await this.store.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent ${agentId} not found`);
    }

    let updated = current;
    if (current.state !== "paused") {
      updated = await this.store.updateAgentState(agentId, "paused");
    }

    if (pauseReason !== undefined && updated.pauseReason !== pauseReason) {
      updated = await this.store.updateAgent(agentId, { pauseReason });
    }

    if (this.taskStore && cascadeToTasks) {
      const assignedTasks = await this.taskStore.getTasksByAssignedAgent(agentId, { excludeArchived: true });
      const toPause = assignedTasks.filter((task) => task.paused !== true);
      const results = await Promise.allSettled(
        toPause.map((task) => this.taskStore!.pauseTask(task.id, true, undefined, { pausedByAgentId: agentId })),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          heartbeatLog.warn(`pauseAgent(${agentId}) failed to pause assigned task ${toPause[index]?.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      });
    }

    return updated;
  }

  async resumeAgent(agentId: string, options: ResumeAgentOptions = {}): Promise<Agent> {
    const {
      triggerDetail = "Triggered from state resume",
      triggerSource = "state-resume",
      clearPauseReason = true,
      cascadeToTasks = true,
    } = options;

    const current = await this.store.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent ${agentId} not found`);
    }

    let updated = current;
    if (current.state !== "active") {
      updated = await this.store.updateAgentState(agentId, "active");
    }

    if (clearPauseReason && updated.pauseReason !== undefined) {
      updated = await this.store.updateAgent(agentId, { pauseReason: undefined });
    }

    if (this.taskStore && cascadeToTasks) {
      const pausedTasks = await this.taskStore.getTasksByAssignedAgent(agentId, {
        pausedOnly: true,
        excludeArchived: true,
      });
      const toUnpause = pausedTasks.filter((task) => task.pausedByAgentId === agentId);
      const results = await Promise.allSettled(toUnpause.map((task) => this.taskStore!.pauseTask(task.id, false)));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          heartbeatLog.warn(`resumeAgent(${agentId}) failed to unpause assigned task ${toUnpause[index]?.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      });
    }

    const latest = await this.store.getAgent(agentId);
    const isHeartbeatEnabled = latest?.runtimeConfig?.enabled !== false;
    if (isHeartbeatEnabled) {
      try {
        await this.executeHeartbeat({
          agentId,
          source: "on_demand",
          triggerDetail,
          contextSnapshot: {
            wakeReason: "on_demand",
            triggerDetail,
            triggerSource,
          },
        });
      } catch (error) {
        heartbeatLog.warn(`resumeAgent(${agentId}) executeHeartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return (await this.store.getAgent(agentId)) ?? updated;
  }

  /**
   * Remove an agent from monitoring.
   * Does NOT end the heartbeat run - caller's responsibility.
   * @param agentId - The agent ID
   */
  untrackAgent(agentId: string): void {
    this.trackedAgents.delete(agentId);
  }

  /**
   * Record a heartbeat for a tracked agent.
   * @param agentId - The agent ID
   */
  recordHeartbeat(agentId: string): void {
    const tracked = this.trackedAgents.get(agentId);
    if (!tracked) return;

    tracked.lastSeen = Date.now();

    // If recovering from a missed heartbeat
    if (tracked.missedHeartbeatReported) {
      tracked.missedHeartbeatReported = false;
      void this.store.recordHeartbeat(agentId, "recovered", tracked.runId);
      this.onRecovered?.(agentId);
    } else {
      void this.store.recordHeartbeat(agentId, "ok", tracked.runId);
    }
  }

  /**
   * Check if an agent is healthy (heartbeat within timeout window).
   * Uses per-agent heartbeatTimeoutMs from runtimeConfig if available,
   * otherwise falls back to the monitor-level default.
   * @param agentId - The agent ID
   * @returns true if healthy, false if missed heartbeat or not tracked
   */
  isAgentHealthy(agentId: string): boolean {
    const tracked = this.trackedAgents.get(agentId);
    if (!tracked) return false;

    const config = this.resolveAgentConfig(agentId);
    const elapsed = Date.now() - tracked.lastSeen;
    return elapsed < config.heartbeatTimeoutMs;
  }

  /**
   * Get list of currently tracked agent IDs.
   * Useful for testing and debugging.
   */
  getTrackedAgents(): string[] {
    return Array.from(this.trackedAgents.keys());
  }

  /**
   * Get the last seen timestamp for a tracked agent.
   * @param agentId - The agent ID
   * @returns Last seen timestamp, or undefined if not tracked
   */
  getLastSeen(agentId: string): number | undefined {
    return this.trackedAgents.get(agentId)?.lastSeen;
  }

  private handleMessageToAgent(message: Message): void {
    if (message.toType !== "agent") {
      return;
    }

    const agent = this.configStore.getCachedAgent(message.toId);
    if (!agent) {
      return;
    }

    const runtimeConfig = agent.runtimeConfig as AgentHeartbeatConfig | undefined;
    // Only human-originated (user) messages may override an agent's
    // messageResponseMode setting. Agent-to-agent traffic must respect the
    // recipient's configured behavior to prevent agents from forcing wakes
    // on each other.
    const senderForcedWake =
      message.metadata?.wakeRecipient === true && message.fromType === "user";
    if (!senderForcedWake && runtimeConfig?.messageResponseMode !== "immediate") {
      return;
    }

    const validStates = new Set(["active", "idle", "running"]);
    if (!validStates.has(agent.state)) {
      return;
    }

    void this.executeHeartbeat({
      agentId: message.toId,
      source: "on_demand",
      triggerDetail: senderForcedWake ? "wake-on-message-forced" : "wake-on-message",
      wakeMessage: {
        messageId: message.id,
        fromType: message.fromType,
        fromId: message.fromId,
        forced: senderForcedWake,
        createdAt: message.createdAt,
      },
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      heartbeatLog.warn(`Wake-on-message heartbeat failed for ${message.toId}: ${errorMessage}`);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heartbeat execution (Paperclip wake → check → work → exit)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a heartbeat run for an agent.
   * 
   * Implements the Paperclip-style execution model:
   * 1. Wake — start a heartbeat run record
   * 2. Check inbox — resolve the agent's assigned task
   * 3. Work — run a lightweight agent session with coding-capable tools + fn_task_create/fn_task_log
   * 4. Exit — record results and complete the run
   * 
   * Budget governance:
   * - Skip all triggers when the agent is over budget (`isOverBudget`)
   * - Skip timer triggers when over the warning threshold (`isOverThreshold`)
   * - Continue normal execution for critical triggers (assignment/on_demand) when only over threshold
   * 
   * Per-agent execution is serialized via `withAgentStartLock` — concurrent calls
   * for the same agent wait for the previous run to complete.
   * 
   * @param options - Execution options (agent ID, source, optional task override)
   * @returns The completed heartbeat run, or null if the monitor isn't configured for execution
   * @throws Error if taskStore or rootDir are not configured
   */
  async executeHeartbeat(options: HeartbeatExecutionOptions): Promise<AgentHeartbeatRun> {
    const {
      agentId,
      source,
      triggerDetail,
      taskId: explicitTaskId,
      contextSnapshot,
      triggeringCommentIds,
      triggeringCommentType,
      wakeMessage,
    } = options;

    // Validate execution dependencies
    if (!this.taskStore || !this.rootDir) {
      throw new Error("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
    }
    const taskStore = this.taskStore;
    const rootDir = this.rootDir;

    // Serialize per-agent
    return this.withAgentStartLock(agentId, async () => {
      heartbeatLog.log(`Executing heartbeat for ${agentId} (source=${source})`);

      let preloadedAgent: Agent | null = null;
      try {
        preloadedAgent = await this.store.getAgent(agentId);
      } catch (preloadErr) {
        heartbeatLog.warn(`Agent ${agentId} agent preloading failed: ${preloadErr instanceof Error ? preloadErr.message : String(preloadErr)} — will resolve in execution path`);
      }

      const resolvedTaskId = explicitTaskId ?? preloadedAgent?.taskId;
      const contextTriggeringCommentIds = Array.isArray(contextSnapshot?.triggeringCommentIds)
        ? contextSnapshot.triggeringCommentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : undefined;
      const contextTriggeringCommentType =
        contextSnapshot?.triggeringCommentType === "steering"
        || contextSnapshot?.triggeringCommentType === "task"
        || contextSnapshot?.triggeringCommentType === "pr"
          ? contextSnapshot.triggeringCommentType
          : undefined;
      const effectiveTriggeringCommentIds = triggeringCommentIds ?? contextTriggeringCommentIds;
      const effectiveTriggeringCommentType = triggeringCommentType ?? contextTriggeringCommentType;

      const runContextSnapshot = {
        ...(contextSnapshot ?? {}),
        ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
        ...(effectiveTriggeringCommentIds?.length
          ? { triggeringCommentIds: effectiveTriggeringCommentIds }
          : {}),
        ...(effectiveTriggeringCommentType ? { triggeringCommentType: effectiveTriggeringCommentType } : {}),
      };

      // Start run
      const run = await this.startRun(agentId, {
        source,
        triggerDetail,
        contextSnapshot: Object.keys(runContextSnapshot).length > 0 ? runContextSnapshot : undefined,
      });

      // Build run context for mutation correlation
      const runContext: RunMutationContext = {
        runId: run.id,
        agentId,
        source,
      };

      // Build engine run context for audit instrumentation
      const engineRunContext: EngineRunContext = {
        runId: run.id,
        agentId,
        source,
        phase: "heartbeat",
      };

      // Create run auditor for audit trail (FN-1404)
      // Uses TaskStore.recordRunAuditEvent when available; no-ops otherwise
      const audit = createRunAuditor(taskStore, engineRunContext);

      let agentLogger: AgentLogger | null = null;
      const flushAgentLogger = async (): Promise<void> => {
        if (!agentLogger) {
          return;
        }
        try {
          await agentLogger.flush();
        } catch (error) {
          heartbeatLog.warn(`Failed to flush heartbeat logs for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      try {
        // Budget governance: check if agent can run
        try {
          const budgetStatus = await this.store.getBudgetStatus(agentId);
          if (budgetStatus.isOverBudget) {
            heartbeatLog.log(`Agent ${agentId} budget exhausted — heartbeat skipped`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "budget_exhausted", budgetStatus },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
          // Above threshold: only allow critical triggers (assignment, on_demand)
          if (budgetStatus.isOverThreshold && source === "timer") {
            heartbeatLog.log(`Agent ${agentId} over budget threshold (${budgetStatus.usagePercent}%) — timer heartbeat skipped`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "budget_threshold_exceeded", budgetStatus },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        } catch (budgetErr) {
          heartbeatLog.warn(`Agent ${agentId} budget status check failed: ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)} — proceeding without budget check`);
        }

        // Pause governance: globalPause blocks all heartbeat sources;
        // enginePaused is a soft pause that only blocks timer ticks.
        try {
          const settings = await taskStore.getSettings();
          if (settings.globalPause) {
            heartbeatLog.log(`Agent ${agentId} heartbeat skipped — global pause active (source=${source})`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "global_pause", source },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
          if (settings.enginePaused && source === "timer") {
            heartbeatLog.log(`Agent ${agentId} timer heartbeat skipped — engine paused (soft pause)`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "engine_paused", source },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        } catch (pauseErr) {
          heartbeatLog.warn(`Pause status check failed for ${agentId}: ${pauseErr instanceof Error ? pauseErr.message : String(pauseErr)} — proceeding`);
        }

        // Resolve agent
        const agent = preloadedAgent ?? await this.store.getAgent(agentId);
        if (!agent) {
          heartbeatLog.warn(`Agent ${agentId} not found — completing run as failed`);
          await this.completeRun(agentId, run.id, {
            status: "failed",
            stderrExcerpt: `Agent ${agentId} not found`,
          });
          return (await this.store.getRunDetail(agentId, run.id))!;
        }

        // Check if agent has identity (used later for no-task run decisions)
        const agentHasIdentity = hasAgentIdentity(agent);
        const isAgentEphemeral = isEphemeralAgent(agent);
        const canRunNoTaskHeartbeat = agentHasIdentity && !isAgentEphemeral;

        // Resolve task assignment (explicit override → existing assignment → inbox-lite selection)
        let taskId = explicitTaskId ?? agent.taskId;
        let inboxSelection: InboxTask | null = null;

        if (!taskId) {
          inboxSelection = await taskStore.selectNextTaskForAgent(agentId, { id: agent.id, role: agent.role });
          if (inboxSelection && !canAgentTakeImplementationTaskForExplicitRouting(agent, inboxSelection.task)) {
            const hasRoleOverride = inboxSelection.task.sourceMetadata?.executorRoleOverride === true;
            if (!hasRoleOverride) {
              heartbeatLog.log(
                `Agent ${agentId} (role=${agent.role}) skipped inbox-selected task ${inboxSelection.task.id} due to executor-role assignment policy`,
              );
              inboxSelection = null;
            }
          }
          if (inboxSelection) {
            taskId = inboxSelection.task.id;
            heartbeatLog.log(`Inbox selected task ${taskId} (priority: ${inboxSelection.priority}) for agent ${agentId}`);

            // Persist assignment to AgentStore so subsequent runs retain linkage.
            if (agent.taskId !== taskId) {
              await this.store.assignTask(agentId, taskId, runContext);
              // Audit trail: record assignment mutation (FN-1404)
              await audit.database({ type: "task:assign", target: taskId });
            }

            // FN-1253 compatibility: if checkout API is available on TaskStore,
            // try to claim the lease. On conflict, skip this task gracefully.
            const checkoutTask = (taskStore as TaskStore & {
              checkoutTask?: (taskId: string, agentId: string, runContext?: RunMutationContext) => Promise<unknown>;
            }).checkoutTask;
            if (typeof checkoutTask === "function") {
              try {
                await checkoutTask.call(taskStore, taskId, agentId, runContext);
                // Audit trail: record checkout mutation (FN-1404)
                await audit.database({ type: "task:checkout", target: taskId });
              } catch (checkoutErr) {
                heartbeatLog.warn(`Task ${taskId} checkout failed: ${checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr)} — skipping`);
                taskId = undefined;
                inboxSelection = null;
              }
            }
          }
        }

        if (taskId && run.contextSnapshot?.taskId !== taskId) {
          const updatedRun: AgentHeartbeatRun = {
            ...run,
            contextSnapshot: {
              ...(run.contextSnapshot ?? {}),
              taskId,
            },
          };
          await this.store.saveRun(updatedRun);

          // Update engine run context with resolved taskId for audit trail (FN-1404)
          engineRunContext.taskId = taskId;
        }

        let autoClaimCandidates: AutoClaimCandidate[] = [];
        const autoClaimEnabled = isAutoClaimRelevantTasksEnabled(agent);
        if (!taskId && canRunNoTaskHeartbeat && autoClaimEnabled && this.snapshotManager) {
          try {
            const snapshot = await this.snapshotManager.getSnapshot();
            const roleCompatibleCandidates = snapshot.tasks.filter((candidate) => canAgentTakeImplementationTask(agent, candidate));
            const skippedIncompatibleCount = snapshot.tasks.length - roleCompatibleCandidates.length;
            if (skippedIncompatibleCount > 0) {
              heartbeatLog.log(
                `Agent ${agentId} (role=${agent.role}) skipped auto-claim of ${skippedIncompatibleCount} implementation task(s) — only executor agents may claim implementation work`,
              );
            }

            autoClaimCandidates = roleCompatibleCandidates;
            const ranked = roleCompatibleCandidates
              .map((candidate) => ({ candidate, score: candidate.baseScore + taskRelevanceScore(agent, candidate) }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score || (a.candidate.columnMovedAt ?? a.candidate.createdAt).localeCompare(b.candidate.columnMovedAt ?? b.candidate.createdAt));

            if (ranked.length > 0) {
              const winnerId = ranked[0].candidate.id;
              const winner = await taskStore.getTask(winnerId);
              const claimResult = await this.store.claimTaskForAgent(agentId, winner.id, runContext);
              if (claimResult.ok) {
                taskId = winner.id;
                heartbeatLog.log(`Agent ${agentId} auto-claimed relevant task ${taskId}`);
              } else {
                heartbeatLog.log(`Agent ${agentId} auto-claim skipped (${claimResult.reason})`);
              }
            }
          } catch (autoClaimError) {
            heartbeatLog.warn(`Auto-claim scan failed for ${agentId}: ${autoClaimError instanceof Error ? autoClaimError.message : String(autoClaimError)}`);
          }
        }
        if (!taskId) {
          // Agents with identity (soul, instructions, memory) should run a full heartbeat
          // session even without a task, so they can do ambient work like messaging,
          // memory management, task creation, and delegation.
          // Ephemeral agents and agents without identity still exit gracefully.
          if (!canRunNoTaskHeartbeat) {
            heartbeatLog.log(`Agent ${agentId} has no task assignment — graceful exit`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "no_assignment" },
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
          heartbeatLog.log(`Agent ${agentId} has no task but has identity — running no-task heartbeat`);
        }
        let isNoTaskRun = !taskId;

        // Validate agent state (only for task-scoped runs)
        if (!isNoTaskRun) {
          const validStates = ["active", "running", "idle"];
          if (!validStates.includes(agent.state)) {
            heartbeatLog.log(`Agent ${agentId} state is "${agent.state}" — graceful exit`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "invalid_state", state: agent.state },
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        }

        // Fetch task context (only for task-scoped runs)
        let taskDetail: TaskDetail | undefined;
        if (!isNoTaskRun) {
          // taskId is guaranteed to be defined here because isNoTaskRun = !taskId
          const resolvedTaskId = taskId!;
          try {
            taskDetail = await taskStore.getTask(resolvedTaskId);
          } catch (taskDetailErr) {
            heartbeatLog.warn(`Task ${resolvedTaskId} fetch failed: ${taskDetailErr instanceof Error ? taskDetailErr.message : String(taskDetailErr)} — graceful exit`);
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "task_not_found", taskId: resolvedTaskId },
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }

          if (taskDetail.column === "done" || taskDetail.column === "archived") {
            if (agent.taskId === resolvedTaskId) {
              heartbeatLog.log(
                `Agent ${agentId} linked task ${resolvedTaskId} is ${taskDetail.column} — clearing assignment and running heartbeat without task context`,
              );
              try {
                await this.store.assignTask(agentId, undefined, runContext);
              } catch (clearErr) {
                heartbeatLog.warn(
                  `Failed to clear terminal task assignment ${resolvedTaskId} for ${agentId}: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`,
                );
              }

              taskId = undefined;
              taskDetail = undefined;
              isNoTaskRun = true;

              if (!canRunNoTaskHeartbeat) {
                await this.completeRun(agentId, run.id, {
                  status: "completed",
                  resultJson: { reason: "no_assignment" },
                });
                return (await this.store.getRunDetail(agentId, run.id))!;
              }
            } else {
              heartbeatLog.log(
                `Heartbeat for ${agentId} targeted terminal task ${resolvedTaskId} (${taskDetail.column}) — graceful exit`,
              );
              await this.completeRun(agentId, run.id, {
                status: "completed",
                resultJson: { reason: "terminal_task", taskId: resolvedTaskId, column: taskDetail.column },
              });
              return (await this.store.getRunDetail(agentId, run.id))!;
            }
          }

          if (isNoTaskRun) {
            heartbeatLog.log(`Agent ${agentId} terminal task assignment resolved into no-task heartbeat`);
          } else {
            const liveTaskDetail = taskDetail;
            if (!liveTaskDetail) {
              heartbeatLog.warn(`Task ${resolvedTaskId} lost detail after terminal-assignment handling — graceful exit`);
              await this.completeRun(agentId, run.id, {
                status: "completed",
                resultJson: { reason: "task_not_found", taskId: resolvedTaskId },
              });
              return (await this.store.getRunDetail(agentId, run.id))!;
            }

            // Checkout enforcement: agent must hold the lease to work on this task.
            // The heartbeat only validates existing checkout state — it does NOT attempt
            // to acquire a checkout itself. The calling system (scheduler, API trigger)
            // is responsible for checking out the task before the heartbeat starts.
            if (liveTaskDetail.checkedOutBy && liveTaskDetail.checkedOutBy !== agentId) {
              heartbeatLog.warn(
                `Agent ${agentId} does not hold checkout for ${resolvedTaskId} (held by ${liveTaskDetail.checkedOutBy}) — graceful exit`
              );
              await this.completeRun(agentId, run.id, {
                status: "completed",
                resultJson: {
                  reason: "checkout_conflict",
                  taskId: resolvedTaskId,
                  checkedOutBy: liveTaskDetail.checkedOutBy,
                },
              });
              return (await this.store.getRunDetail(agentId, run.id))!;
            }

          }
        }

        // Track usage via callbacks
        const STDOUT_EXCERPT_LIMIT = 4000;
        let outputLength = 0;
        let toolCallCount = 0;
        let heartbeatSummary: string | undefined;
        let stdoutExcerpt = "";

        const appendStdoutExcerpt = (delta: string): void => {
          if (stdoutExcerpt.length >= STDOUT_EXCERPT_LIMIT) {
            return;
          }
          const remaining = STDOUT_EXCERPT_LIMIT - stdoutExcerpt.length;
          stdoutExcerpt += delta.slice(0, remaining);
        };

        // Create fn_heartbeat_done tool
        const heartbeatDoneTool: ToolDefinition = {
          name: "fn_heartbeat_done",
          label: "Heartbeat Done",
          description: "Signal that the heartbeat execution is complete. Call when finished.",
          parameters: heartbeatDoneParams,
          execute: async (_id: string, params: Static<typeof heartbeatDoneParams>) => {
            if (params.summary) {
              heartbeatSummary = params.summary;
            }
            return {
              content: [{
                type: "text" as const,
                text: `Heartbeat complete.${params.summary ? ` Summary: ${params.summary}` : ""}`,
              }],
              details: {},
            };
          },
        };

        // Build tools with task creation tracking and run context for mutation correlation
        // For no-task runs, exclude fn_task_log and document tools (they require a taskId)
        let heartbeatTools: ToolDefinition[];
        if (isNoTaskRun) {
          // No-task runs: task creation/delegation, direct-report config + provisioning,
          // optional messaging/room + reflection, evaluation/identity, web fetch,
          // memory tools, and fn_heartbeat_done. Task-scoped tools are intentionally excluded.
          heartbeatTools = [];

          // fn_task_create tool
          heartbeatTools.push(createTaskCreateTool(taskStore, {
            sourceType: "agent_heartbeat",
            sourceAgentId: agentId,
            sourceRunId: runContext?.runId,
          }, { rootDir: this.rootDir }));

          // Agent delegation tools
          heartbeatTools.push(createListAgentsTool(this.store));
          heartbeatTools.push(createDelegateTaskTool(this.store, taskStore, { rootDir: this.rootDir }));
          heartbeatTools.push(createGetAgentConfigTool(this.store, agentId));
          heartbeatTools.push(createUpdateAgentConfigTool(this.store, agentId));
          heartbeatTools.push(createAgentCreateTool(this.store, agentId));
          heartbeatTools.push(createAgentDeleteTool(this.store, agentId));

          // Messaging tools — when MessageStore is available
          if (this.messageStore) {
            heartbeatTools.push(createSendMessageTool(this.messageStore, agentId));
            heartbeatTools.push(createReadMessagesTool(this.messageStore, agentId));
          }
          if (this.chatStore) {
            heartbeatTools.push(createPostRoomMessageTool(this.chatStore, agentId));
          }

          heartbeatTools.push(createReadEvaluationsTool(this.store, this.reflectionStore, agentId));
          heartbeatTools.push(createUpdateIdentityTool(this.store, agentId));
          if (this.reflectionService) {
            heartbeatTools.push(createReflectOnPerformanceTool(this.reflectionService, agentId));
          }
        } else {
          // Task-scoped runs: full tool set including fn_task_log and document tools
          // taskId is guaranteed to be defined here because isNoTaskRun = !taskId
          heartbeatTools = this.createHeartbeatTools(agentId, taskStore, taskId!, runContext, audit, this.messageStore);
        }

        heartbeatTools.push(createWebFetchTool());

        let memorySettings: Settings | undefined;
        try {
          memorySettings = await getHeartbeatMemorySettings(taskStore);
          heartbeatTools.push(...createMemoryTools(rootDir, memorySettings, {
            agentMemory: {
              agentId: agent.id,
              agentName: agent.name,
              memory: agent.memory,
            },
          }));
        } catch (memorySettingsError) {
          const message = memorySettingsError instanceof Error ? memorySettingsError.message : String(memorySettingsError);
          heartbeatLog.warn(`Failed to configure heartbeat memory tools for ${agentId}: ${message}`);
        }
        // Build skill selection context for heartbeat session (uses waking agent's skills, no role fallback)
        const skillContext = buildSessionSkillContextSync(agent, "heartbeat", rootDir, this.pluginRunner);

        const resolvedMemoryMode = resolveAgentMemoryInclusionMode({
          agent,
          globalSettings: memorySettings,
        });
        const priorMemoryMode = agent.runtimeConfig?.lastAgentMemoryInclusionMode;
        const baseHeartbeatSystemPrompt = adjustHeartbeatMemoryPrimer(
          isNoTaskRun ? HEARTBEAT_NO_TASK_SYSTEM_PROMPT : HEARTBEAT_SYSTEM_PROMPT,
          resolvedMemoryMode.mode,
        );
        let resolvedInstructionsText = "";
        let resolvedInstructionsForIdentity: SnapshotFieldState = { status: "unset" };
        let workspaceMemoryForIdentity: SnapshotFieldState = { status: "unset" };
        try {
          const resolvedInstructions = await resolveAgentInstructionsWithRatings(agent, rootDir, this.store, resolvedMemoryMode.mode);
          resolvedInstructionsText = resolvedInstructions;
          const trimmed = resolvedInstructions.trim();
          resolvedInstructionsForIdentity = trimmed
            ? { status: "loaded", value: trimmed }
            : { status: "empty" };
        } catch (instructionError) {
          const message = instructionError instanceof Error ? instructionError.message : String(instructionError);
          heartbeatLog.warn(`Failed to resolve agent instructions for heartbeat ${agentId}: ${message}`);
          resolvedInstructionsForIdentity = { status: "load-error" };
        }

        try {
          const workspaceMemory = await readAgentMemoryWorkspaceLongTerm(rootDir, agent.id);
          const trimmed = workspaceMemory.trim();
          workspaceMemoryForIdentity = trimmed
            ? { status: "loaded", value: trimmed }
            : { status: "empty" };
        } catch (memoryReadErr) {
          const message = memoryReadErr instanceof Error ? memoryReadErr.message : String(memoryReadErr);
          heartbeatLog.warn(`Failed to resolve workspace memory for heartbeat ${agentId}: ${message}`);
          workspaceMemoryForIdentity = { status: "load-error" };
        }

        let memoryInstructions = "";
        if (resolvedMemoryMode.mode !== "off" && memorySettings?.memoryEnabled !== false) {
          try {
            memoryInstructions = resolvedMemoryMode.mode === "index"
              ? "## Project Memory (Index Only)\n\nProject memory is available via fn_memory_search and fn_memory_get. Search first, then fetch only relevant excerpts."
              : buildExecutionMemoryInstructions(rootDir, memorySettings);
          } catch (memoryInstructionErr) {
            const message = memoryInstructionErr instanceof Error ? memoryInstructionErr.message : String(memoryInstructionErr);
            heartbeatLog.warn(`Failed to resolve project memory instructions for heartbeat ${agentId}: ${message}`);
          }
        }

        let selfImprovePrompt = "";
        let shouldRecordSelfImprove = false;
        if (this.selfImproveService) {
          try {
            const shouldSelfImprove = await this.selfImproveService.shouldRunSelfImprove(agentId);
            if (shouldSelfImprove) {
              selfImprovePrompt = await this.selfImproveService.getSelfImprovePrompt(agentId);
              shouldRecordSelfImprove = true;
            }
          } catch (selfImproveErr) {
            heartbeatLog.warn(`Failed to resolve self-improvement prompt for ${agentId}: ${selfImproveErr instanceof Error ? selfImproveErr.message : String(selfImproveErr)}`);
          }
        }

        // Build structured layers for cross-session prompt caching.
        const heartbeatPluginContributions = buildPluginPromptSection(
          "heartbeat",
          this.pluginRunner,
        );
        if (heartbeatPluginContributions) {
          heartbeatLog.log(`applied plugin prompt contributions for heartbeat surface`);
        }

        const heartbeatLayers = buildPromptLayers({
          basePrompt: baseHeartbeatSystemPrompt,
          agentInstructions: [resolvedInstructionsText, memoryInstructions, selfImprovePrompt].filter((part) => part.trim()).join("\n\n"),
          pluginContributions: heartbeatPluginContributions,
        });

        const systemPromptFinal = collapsePromptLayers(heartbeatLayers);

        if (priorMemoryMode !== resolvedMemoryMode.mode) {
          const from = priorMemoryMode ? priorMemoryMode : "(initial)";
          try {
            await this.store.appendRunLog(agentId, run.id, {
              timestamp: new Date().toISOString(),
              taskId: taskId ?? "heartbeat",
              type: "text",
              text: `Agent memory inclusion mode: ${from} → ${resolvedMemoryMode.mode} (source: ${resolvedMemoryMode.source})`,
            });
          } catch (modeLogError) {
            heartbeatLog.warn(`Failed to append memory-mode transition run log for ${agentId}: ${modeLogError instanceof Error ? modeLogError.message : String(modeLogError)}`);
          }
          try {
            await this.store.updateAgent(agentId, {
              runtimeConfig: {
                ...(agent.runtimeConfig ?? {}),
                lastAgentMemoryInclusionMode: resolvedMemoryMode.mode,
              },
            });
          } catch (modePersistError) {
            heartbeatLog.warn(`Failed to persist memory-mode transition for ${agentId}: ${modePersistError instanceof Error ? modePersistError.message : String(modePersistError)}`);
          }
        }

        // fn_heartbeat_done must be the last tool in the array (stable terminal signal)
        heartbeatTools.push(heartbeatDoneTool);

        // Always-on AgentLogger: no-task runs use the callback sink wired to run-scoped JSONL;
        // task-scoped runs write to both the task store AND the run-scoped JSONL.
        if (isNoTaskRun) {
          agentLogger = new AgentLogger({
            appendLog: (entry) => this.store.appendRunLog(agentId, run.id, entry),
            agent: agent.role as AgentRole,
            persistAgentToolOutput: memorySettings?.persistAgentToolOutput,
            persistAgentThinkingLog: resolvePersistAgentThinkingLog(memorySettings, { ephemeral: isAgentEphemeral }),
          });
        } else if (taskId) {
          agentLogger = new AgentLogger({
            store: taskStore,
            taskId,
            agent: agent.role as AgentRole,
            appendLog: (entry) => this.store.appendRunLog(agentId, run.id, entry),
            persistAgentToolOutput: memorySettings?.persistAgentToolOutput,
            persistAgentThinkingLog: resolvePersistAgentThinkingLog(memorySettings, { ephemeral: isAgentEphemeral }),
          });
        }

        const isModelUnavailableError = (errorMessage: string): boolean => {
          const normalized = errorMessage.toLowerCase();
          return normalized.includes("no api key for provider")
            || normalized.includes("configured primary model")
            || normalized.includes("was not found in the pi model registry");
        };

        const extractUnavailableProvider = (errorMessage: string): string | undefined => {
          const providerMatch = /no api key for provider:\s*([^\s)]+)/i.exec(errorMessage);
          if (providerMatch?.[1]) return providerMatch[1];
          const modelMatch = /configured primary model\s+([^/\s]+)\//i.exec(errorMessage);
          if (modelMatch?.[1]) return modelMatch[1];
          return undefined;
        };

        const completeAsModelUnavailable = async (errorMessage: string): Promise<void> => {
          const provider = extractUnavailableProvider(errorMessage);
          const detail = provider
            ? `${errorMessage}. Configure credentials for provider "${provider}" in settings, then resume the agent.`
            : `${errorMessage}. Configure valid provider credentials in settings, then resume the agent.`;

          if (source === "timer") {
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: {
                reason: "heartbeat_model_unavailable",
                source,
                detail,
              },
              stderrExcerpt: detail,
              stdoutExcerpt: stdoutExcerpt || undefined,
            });
            return;
          }

          await this.completeRun(agentId, run.id, {
            status: "completed",
            resultJson: {
              reason: "heartbeat_model_unavailable",
              source,
              detail,
              actionRequired: true,
            },
            stderrExcerpt: detail,
            stdoutExcerpt: stdoutExcerpt || undefined,
            skipStateTransition: true,
          });

          await this.store.updateAgentState(agentId, "paused");
          await this.store.updateAgent(agentId, {
            pauseReason: "heartbeat-model-unavailable",
            lastError: detail,
          });
        };

        let heartbeatModelSettings: Settings | undefined;
        try {
          heartbeatModelSettings = await taskStore.getSettings();
        } catch (settingsErr) {
          heartbeatLog.warn(`Failed to read heartbeat model settings for ${agentId}: ${settingsErr instanceof Error ? settingsErr.message : String(settingsErr)}`);
        }

        let sessionCwd = rootDir;
        if (!isNoTaskRun && taskDetail) {
          try {
            const acquisition = await acquireTaskWorktree({
              task: taskDetail,
              rootDir,
              store: taskStore,
              settings: heartbeatModelSettings ?? {},
              logger: heartbeatLog,
              audit,
              runContext,
              runInitCommand: false,
              secretsStore: this.secretsStore,
            });
            sessionCwd = acquisition.worktreePath;
          } catch (worktreeErr) {
            const detail = worktreeErr instanceof Error ? worktreeErr.message : String(worktreeErr);
            heartbeatLog.warn(`Heartbeat worktree acquisition failed for ${agentId}: ${detail}`);
            if (taskDetail.column !== "done" && taskDetail.column !== "archived") {
              await taskStore.moveTask(taskDetail.id, "todo", { preserveProgress: true });
            }
            await this.completeRun(agentId, run.id, {
              status: "completed",
              resultJson: { reason: "worktree_acquisition_failed", detail },
              stderrExcerpt: detail,
              skipStateTransition: true,
            });
            return (await this.store.getRunDetail(agentId, run.id))!;
          }
        }

        const heartbeatSessionModels = resolveHeartbeatSessionModels(heartbeatModelSettings, agent.runtimeConfig);

        // Create agent session
        const { session } = await createResolvedAgentSession({
          sessionPurpose: "heartbeat",
          runtimeHint: extractRuntimeHint(agent.runtimeConfig),
          pluginRunner: this.pluginRunner,
          cwd: sessionCwd,
          systemPrompt: systemPromptFinal,
          systemPromptLayers: heartbeatLayers,
          tools: "coding",
          customTools: heartbeatTools,
          defaultProvider: heartbeatSessionModels.defaultProvider,
          defaultModelId: heartbeatSessionModels.defaultModelId,
          fallbackProvider: heartbeatSessionModels.fallbackProvider,
          fallbackModelId: heartbeatSessionModels.fallbackModelId,
          runAuditor: audit,
          settings: heartbeatModelSettings,
          onText: (delta) => {
            outputLength += delta.length;
            appendStdoutExcerpt(delta);
            agentLogger?.onText(delta);
          },
          onThinking: (delta) => {
            agentLogger?.onThinking(delta);
          },
          onToolStart: (name, args) => {
            agentLogger?.onToolStart(name, args);
          },
          onToolEnd: (name, isError, result) => {
            toolCallCount++;
            agentLogger?.onToolEnd(name, isError, result);
          },
          // Skill selection: use waking agent's skills (heartbeat has no role fallback)
          ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
          actionGateContext: this.buildActionGateContext(agent, taskId, run.id, heartbeatModelSettings?.defaultAgentPermissionPolicy),
          permanentAgentGating: this.buildPermanentAgentGatingContext(agent, taskId, run.id, heartbeatModelSettings?.defaultAgentPermissionPolicy),
        });

        // Track for monitoring
        this.trackAgent(agentId, { dispose: () => session.dispose() }, run.id);

        try {
          // Build execution prompt
          let pendingMessages: Message[] = [];
          let executionPrompt: string;

          const sinceIso = await this.resolveRoomMessageSinceIso(agent, run.id);
          const pendingRoomMessages = await this.getPendingRoomMessages(agent, sinceIso);
          const pendingRoomMessagesLines = this.getPendingRoomMessagesSection(
            pendingRoomMessages.entries,
            pendingRoomMessages.truncatedCount,
          );
          const roomAmbiguityNoticesLines = await this.getRoomAmbiguityNoticesSection(
            agent,
            run.id,
            pendingRoomMessages.entries,
            audit,
          );
          const roomCoordinationNoticesLines = await this.getRoomCoordinationNoticesSection(
            agent,
            run.id,
            pendingRoomMessages.entries,
            audit,
          );

          // Fetch unread messages when messageStore is available (for all trigger types)
          if (this.messageStore) {
            try {
              pendingMessages = this.messageStore.getInbox(agentId, "agent", { read: false, limit: 10 });
            } catch (inboxErr) {
              heartbeatLog.warn(`Failed to fetch inbox messages for ${agentId}: ${inboxErr instanceof Error ? inboxErr.message : String(inboxErr)}`);
            }
          }

          const wakeInboxEmpty =
            pendingMessages.length === 0
            && pendingRoomMessages.total === 0
            && (effectiveTriggeringCommentIds?.length ?? 0) === 0;

          // Derive a stable wake reason from source, triggerDetail, and trigger
          // type so the agent can change its strategy based on *why* it woke up.
          // Mirrors paperclip's PAPERCLIP_WAKE_REASON (see plan: wake delta).
          const deriveWakeReason = (): string => {
            if (effectiveTriggeringCommentType) return `comment_${effectiveTriggeringCommentType}`;
            if (triggerDetail === "wake-on-message") {
              return wakeInboxEmpty ? "message_received_already_consumed" : "message_received";
            }
            if (triggerDetail === "wake-on-message-forced") {
              return wakeInboxEmpty ? "message_received_urgent_already_consumed" : "message_received_urgent";
            }
            if (triggerDetail === "wake-on-comment") return "comment_mention";
            if (triggerDetail === "task-assigned") return "task_assigned";
            if (source === "timer") return "timer";
            if (source === "assignment") return "task_assigned";
            if (source === "automation") return "automation";
            if (source === "routine") return "routine";
            return triggerDetail || source;
          };
          const wakeReason = deriveWakeReason();
          const isWakeOnMessageTrigger = triggerDetail?.startsWith("wake-on-message") ?? false;
          const wakeMessageStillUnread = wakeMessage
            ? pendingMessages.some((message) => message.id === wakeMessage.messageId)
            : undefined;

          if (wakeInboxEmpty && (triggerDetail === "wake-on-message" || triggerDetail === "wake-on-message-forced")) {
            heartbeatLog.log("wake-empty-inbox", {
              agentId,
              runId: run.id,
              triggerDetail,
              source,
            });
          }

          if (isWakeOnMessageTrigger) {
            heartbeatLog.log(
              `[wake-trigger-diagnostics] agent=${agentId} run=${run.id} triggerDetail=${triggerDetail} source=${source} messageId=${wakeMessage?.messageId ?? "none"} from=${wakeMessage ? `${wakeMessage.fromType}:${wakeMessage.fromId}` : "none"} forced=${wakeMessage?.forced ?? false} createdAt=${wakeMessage?.createdAt ?? "none"} inboxUnreadCount=${pendingMessages.length} wakeMessageStillUnread=${wakeMessageStillUnread ?? "unknown"} pendingRoomMessages=${pendingRoomMessages.total}`,
            );
          }

          const wakeInboxSnapshotLine = wakeInboxEmpty
            ? "- inbox snapshot: empty (already consumed)"
            : `- inbox snapshot: ${pendingMessages.length} message(s)`;
          const wakeTriggerSourceLine = isWakeOnMessageTrigger
            ? (`- wake trigger source: ${wakeMessage
              ? `message ${wakeMessage.messageId} from ${wakeMessage.fromType}:${wakeMessage.fromId}${wakeMessage.forced ? " (forced)" : ""}, ${wakeMessageStillUnread ? "still unread" : "already consumed at snapshot"}`
              : "no triggering-message metadata"}`)
            : null;

          // Per-agent override of the default HEARTBEAT_PROCEDURE: if the agent
          // configured a heartbeatProcedurePath pointing to a markdown file in
          // the project, use that instead. Reloaded fresh each tick (matches the
          // existing instructionsPath/instructionsText reload contract) so an
          // operator can iterate on procedure text without restarting agents.
          const customProcedure = await resolveAgentHeartbeatProcedure(agent, rootDir);
          const customProcedureConfigured = Boolean(customProcedure);
          const shouldOverrideCustomProcedureForNoTaskRun = isNoTaskRun && customProcedureConfigured;
          if (shouldOverrideCustomProcedureForNoTaskRun) {
            heartbeatLog.log(
              `Agent ${agentId} no-task heartbeat bypassed configured heartbeatProcedurePath and used HEARTBEAT_NO_TASK_PROCEDURE to keep prompt guidance aligned with ambient tools`,
            );
          }
          const heartbeatScopeDiscipline = resolveHeartbeatScopeDisciplineMode(heartbeatModelSettings, agent);
          const promptTemplate = resolveHeartbeatPromptTemplate(heartbeatModelSettings, agent);
          const resolvedProcedureTemplate = selectHeartbeatProcedure(heartbeatScopeDiscipline, isNoTaskRun, {
            task: {
              strict: HEARTBEAT_PROCEDURE_STRICT,
              lite: HEARTBEAT_PROCEDURE_LITE,
              off: HEARTBEAT_PROCEDURE_OFF,
            },
            noTask: {
              strict: HEARTBEAT_NO_TASK_PROCEDURE_STRICT,
              lite: HEARTBEAT_NO_TASK_PROCEDURE_LITE,
              off: HEARTBEAT_NO_TASK_PROCEDURE_OFF,
            },
          });
          const heartbeatProcedureText = shouldOverrideCustomProcedureForNoTaskRun
            ? resolvedProcedureTemplate
            : (customProcedure ?? resolvedProcedureTemplate);
          // Precedence: heartbeatProcedurePath (custom file) > resolved heartbeatScopeDiscipline template > strict default.
          const heartbeatProcedureSource = shouldOverrideCustomProcedureForNoTaskRun
            ? "default-no-task-override"
            : (customProcedure ? "custom" : "default");
          const reportsHealthSection = await this.buildReportsHealthSection(agent.id, this.store);
          const identitySnapshot = buildIdentitySnapshot({
            agent,
            resolvedInstructions: resolvedInstructionsForIdentity,
            workspaceMemory: workspaceMemoryForIdentity,
          });
          if (resolvedInstructionsForIdentity.status === "load-error" || workspaceMemoryForIdentity.status === "load-error") {
            heartbeatLog.warn(
              `Identity snapshot rendered with load-error status for ${agentId}: instructions=${resolvedInstructionsForIdentity.status}, memory=${workspaceMemoryForIdentity.status}`,
            );
          }

          if (isNoTaskRun) {
            // No-task heartbeat: agent has identity but no assigned task
            // Build pending messages section
            const pendingMessagesLines: string[] = [];
            if (pendingMessages.length > 0) {
              pendingMessagesLines.push(
                "",
                "Pending Messages:",
                ...pendingMessages.map((msg) => {
                  const timestamp = new Date(msg.createdAt).toLocaleString();
                  return `- [id: ${msg.id}] [from: ${msg.fromType}:${msg.fromId}] ${msg.content} (${timestamp})`;
                }),
              );
            }

            const promptCandidateLimit = resolveAutoClaimCandidatesInPromptLimit(agent, heartbeatModelSettings);
            const candidateLines = promptCandidateLimit > 0
              ? [
                "",
                "Open Task Candidates (auto-claim scan):",
                ...autoClaimCandidates
                  .slice(0, promptCandidateLimit)
                  .map((candidate) => `- ${candidate.id}: ${candidate.title ?? candidate.descriptionFirstLine}`),
              ]
              : [];

            executionPrompt = [
              `Heartbeat execution for agent "${agent.name}" (ID: ${agent.id})`,
              `Source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
              "",
              identitySnapshot,
              "",
              "## Wake Delta",
              `- source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
              `- wake reason: ${wakeReason}`,
              `- assigned task: none`,
              wakeInboxSnapshotLine,
              ...(wakeTriggerSourceLine ? [wakeTriggerSourceLine] : []),
              `- pending messages: ${pendingMessages.length}`,
              `- pending room messages: ${pendingRoomMessages.total}`,
              `- auto-claim relevant tasks: ${autoClaimEnabled ? (promptCandidateLimit === 0 ? "disabled (prompt-suppressed)" : "enabled") : "disabled"}`,
              "",
              "Treat this wake delta as the highest-priority change for this heartbeat.",
              "This is an autonomous heartbeat run (manual or automatic): re-anchor on",
              "identity, process wake context, then complete ONE concrete action.",
              "Run the Heartbeat Procedure (below) before doing anything else — even a",
              "timer-only wake should re-check messages, memory, and project state.",
              "",
              heartbeatProcedureText,
              "",
              "**No assigned task** — This heartbeat run has no task assignment.",
              "",
              "You have identity (soul, instructions, and/or memory) loaded, which means you can perform",
              "useful ambient work. Pick ONE high-value action and finish it clearly before ending:",
              "",
              "1. **Check your messages** — Use fn_read_messages to review pending messages.",
              "   If replying, use fn_send_message and include reply_to_message_id so threads stay linked.",
              "",
              "2. **Create new tasks** — Use fn_task_create for net-new executable work.",
              "   Prefer concrete tasks with clear outcomes; avoid vague placeholders.",
              "",
              "3. **Delegate work** — Use fn_list_agents to find available specialists, then",
              "   fn_delegate_task when immediate ownership by a specific agent is beneficial.",
              "",
              "4. **Update memory** — Use fn_memory_append for durable, reusable learnings",
              "   (conventions, pitfalls, architecture constraints), not transient chatter.",
              "",
              "5. **Monitor project flow** — Review board/project signals and surface issues",
              "   by creating or delegating follow-up work as appropriate.",
              "",
              "When auto-claim relevant tasks is enabled, review Open Task Candidates above and",
              "prioritize tasks that align with your role and soul before creating net-new tasks.",
              ...candidateLines,
              ...pendingMessagesLines,
              ...pendingRoomMessagesLines,
              ...roomAmbiguityNoticesLines,
              ...roomCoordinationNoticesLines,
              "",
              "Your soul, instructions, and memory are already loaded in the system prompt.",
              "Focus on work that benefits the project without requiring a specific task context.",
              ...(reportsHealthSection ? ["", reportsHealthSection] : []),
              "",
              "Call fn_heartbeat_done when finished.",
            ].join("\n");
            heartbeatLog.log(`[auto-claim-prompt] agent=${agentId} chars=${executionPrompt.length} count=${Math.min(promptCandidateLimit, autoClaimCandidates.length)}`);
          } else {
            // Task-scoped heartbeat: agent has an assigned task
            const taskTitle = taskDetail!.title ?? taskDetail!.description.slice(0, 100);

            const triggeringCommentLines: string[] = [];
            if (effectiveTriggeringCommentIds && effectiveTriggeringCommentIds.length > 0) {
              const commentLookup = new Map<string, { author: string; text: string }>();
              for (const comment of taskDetail!.comments ?? []) {
                commentLookup.set(comment.id, { author: comment.author, text: comment.text });
              }
              for (const steeringComment of taskDetail!.steeringComments ?? []) {
                commentLookup.set(steeringComment.id, { author: steeringComment.author, text: steeringComment.text });
              }

              const formatCommentText = (text: string): string => text.replace(/\s+/g, " ").trim();

              for (const commentId of effectiveTriggeringCommentIds) {
                const comment = commentLookup.get(commentId);
                if (comment) {
                  triggeringCommentLines.push(`- [${comment.author}]: "${formatCommentText(comment.text)}"`);
                }
              }

              if (triggeringCommentLines.length > 0) {
                triggeringCommentLines.unshift(
                  "",
                  "You were woken because of new comments on this task. Review them and take appropriate action.",
                  `Triggering comment type: ${effectiveTriggeringCommentType ?? "task"}`,
                  "New comments since last run:",
                );
              }
            }

            // Build pending messages section
            const pendingMessagesLines: string[] = [];
            if (pendingMessages.length > 0) {
              pendingMessagesLines.push(
                "",
                "Pending Messages:",
                ...pendingMessages.map((msg) => {
                  const timestamp = new Date(msg.createdAt).toLocaleString();
                  return `- [id: ${msg.id}] [from: ${msg.fromType}:${msg.fromId}] ${msg.content} (${timestamp})`;
                }),
              );
            }

            executionPrompt = [
              `Heartbeat execution for agent "${agent.name}" (ID: ${agent.id})`,
              `Source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
              `Assigned task: ${taskId} — ${taskTitle}`,
              "",
              identitySnapshot,
              "",
              "## Wake Delta",
              `- source: ${source}${triggerDetail ? ` (${triggerDetail})` : ""}`,
              `- wake reason: ${wakeReason}`,
              `- assigned task: ${taskId}`,
              wakeInboxSnapshotLine,
              ...(wakeTriggerSourceLine ? [wakeTriggerSourceLine] : []),
              `- pending messages: ${pendingMessages.length}`,
              `- pending room messages: ${pendingRoomMessages.total}`,
              `- triggering comments: ${effectiveTriggeringCommentIds?.length ?? 0}`,
              "",
              "Treat this wake delta as the highest-priority change for this heartbeat.",
              "This is an autonomous heartbeat run (manual or automatic): re-anchor on",
              "identity, process wake context, then complete ONE concrete action.",
              "Before resuming prior task work, run the Heartbeat Procedure (below) and",
              "decide what action this delta requires. Your assigned task is one input",
              "to the procedure — not the only thing to consider.",
              "",
              heartbeatProcedureText,
              "",
              "Task description:",
              trimTaskDescription(taskDetail!.description, promptTemplate),
              "",
              taskDetail!.prompt ? `PROMPT.md:\n${trimPromptMd(taskDetail!.prompt, promptTemplate)}` : "No PROMPT.md available.",
              ...trimTriggeringComments(triggeringCommentLines, promptTemplate),
              ...pendingMessagesLines,
              ...pendingRoomMessagesLines,
              ...roomAmbiguityNoticesLines,
              ...roomCoordinationNoticesLines,
              ...(reportsHealthSection ? ["", reportsHealthSection] : []),
              "",
              "Run the Heartbeat Procedure above. Call fn_heartbeat_done when finished.",
            ].join("\n");
          }

          // Persist prompts on the run record before executing so they are
          // observable in the dashboard even if execution fails partway through.
          try {
            const runWithPrompts: AgentHeartbeatRun = {
              ...run,
              systemPrompt: truncatePrompt(systemPromptFinal, 100_000),
              executionPrompt: truncatePrompt(executionPrompt, 100_000),
              heartbeatProcedureSource,
              contextSnapshot: {
                ...(run.contextSnapshot ?? {}),
                heartbeatScopeDiscipline,
                heartbeatPromptTemplate: promptTemplate,
              },
            };
            promptSizeLog.log("prompt-size", {
              agentId: agent.id,
              role: agent.role,
              runId: run.id,
              template: promptTemplate,
              systemChars: systemPromptFinal.length,
              execChars: executionPrompt.length,
              totalChars: systemPromptFinal.length + executionPrompt.length,
              isNoTaskRun,
            });
            await this.store.saveRun(runWithPrompts);
            // Update local run reference so completeRun merges correctly
            Object.assign(run, {
              systemPrompt: runWithPrompts.systemPrompt,
              executionPrompt: runWithPrompts.executionPrompt,
              heartbeatProcedureSource: runWithPrompts.heartbeatProcedureSource,
              contextSnapshot: runWithPrompts.contextSnapshot,
            });
          } catch (promptPersistErr) {
            heartbeatLog.warn(`Failed to persist prompts for ${agentId}/${run.id}: ${promptPersistErr instanceof Error ? promptPersistErr.message : String(promptPersistErr)}`);
          }

          // Execute
          await promptWithFallback(session, executionPrompt);

          // Capture real per-session token counts from pi-coding-agent's
          // SessionStats. Falls back to a 4-chars-per-token estimate of output
          // when the runtime doesn't expose stats. When this heartbeat is
          // task-scoped, also accumulate the delta onto task.tokenUsage so the
          // stats panel reflects heartbeat-driven runs.
          let usageInput = 0;
          let usageOutput = Math.ceil(outputLength / 4);
          let usageCached = 0;
          let usageCacheWrite = 0;
          try {
            const sessionStats = (session as unknown as {
              getSessionStats?: () => { tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
            }).getSessionStats?.();
            const tokens = sessionStats?.tokens;
            if (tokens) {
              usageInput = tokens.input ?? 0;
              usageOutput = tokens.output ?? usageOutput;
              usageCached = tokens.cacheRead ?? 0;
              usageCacheWrite = tokens.cacheWrite ?? 0;
            }
          } catch (statsErr) {
            heartbeatLog.warn(`Agent ${agentId} session stats read failed: ${statsErr instanceof Error ? statsErr.message : String(statsErr)} — using estimated tokens`);
          }

          if (!isNoTaskRun && taskId) {
            try {
              const { accumulateSessionTokenUsage } = await import("./session-token-usage.js");
              await accumulateSessionTokenUsage(taskStore, taskId, session);
            } catch (accumulateErr) {
              heartbeatLog.warn(`Agent ${agentId} task token usage accumulate failed: ${accumulateErr instanceof Error ? accumulateErr.message : String(accumulateErr)}`);
            }
          }

          await flushAgentLogger();

          // Mark messages as read after successful processing (only if messages were included in prompt)
          if (pendingMessages.length > 0 && this.messageStore) {
            try {
              this.messageStore.markAllAsRead(agentId, "agent");
            } catch (markReadErr) {
              heartbeatLog.warn(`Failed to mark messages as read for ${agentId}: ${markReadErr instanceof Error ? markReadErr.message : String(markReadErr)}`);
            }
          }

          // Complete run successfully
          const completionResultJson: Record<string, unknown> = {
            summary: heartbeatSummary,
            toolCallCount,
          };
          if (isNoTaskRun) {
            // Identity agents without tasks get a special reason for observability
            completionResultJson.reason = "no_assignment_identity_run";
          } else if (inboxSelection) {
            completionResultJson.reason = "inbox_selected";
            completionResultJson.priority = inboxSelection.priority;
            completionResultJson.taskId = taskId;
          }

          await this.completeRun(agentId, run.id, {
            status: "completed",
            usageJson: { inputTokens: usageInput, outputTokens: usageOutput, cachedTokens: usageCached, cacheWriteTokens: usageCacheWrite },
            resultJson: completionResultJson,
            stdoutExcerpt: stdoutExcerpt || undefined,
          });

          if (shouldRecordSelfImprove && this.selfImproveService) {
            try {
              await this.selfImproveService.recordSelfImprove(agentId);
            } catch (selfImproveRecordErr) {
              heartbeatLog.warn(`Failed to record self-improvement checkpoint for ${agentId}: ${selfImproveRecordErr instanceof Error ? selfImproveRecordErr.message : String(selfImproveRecordErr)}`);
            }
          }

          heartbeatLog.log(`Heartbeat completed for ${agentId} (${toolCallCount} tool calls, ${usageInput} input + ${usageOutput} output + ${usageCached} cache-read + ${usageCacheWrite} cache-write tokens)`);
        } catch (err) {
          const errorDetail = formatError(err).detail;
          heartbeatLog.error(`Heartbeat execution failed for ${agentId}: ${errorDetail}`);
          await flushAgentLogger();

          if (isModelUnavailableError(errorDetail)) {
            await completeAsModelUnavailable(errorDetail);
          } else {
            await this.completeRun(agentId, run.id, {
              status: "failed",
              stderrExcerpt: errorDetail,
              stdoutExcerpt: stdoutExcerpt || undefined,
            });
          }
        } finally {
          await flushAgentLogger();
          // Defensively untrack the agent — wrap in try/catch to guarantee cleanup
          // can't be blocked by an exception in untrackAgent itself.
          try { this.untrackAgent(agentId); } catch (untrackErr) {
            heartbeatLog.warn(`untrackAgent failed for ${agentId}: ${untrackErr instanceof Error ? untrackErr.message : String(untrackErr)}`);
          }
          try {
            session.dispose();
          } catch (disposeErr: unknown) {
            const errorMessage = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
            heartbeatLog.warn(`session.dispose() failed for ${agentId}: ${errorMessage}`);
          }
        }

        return (await this.store.getRunDetail(agentId, run.id))!;
      } catch (err) {
        const errorDetail = formatError(err).detail;
        const errorMessage = err instanceof Error ? err.message : String(err);
        heartbeatLog.error(`Heartbeat execution error for ${agentId}: ${errorDetail}`);
        await flushAgentLogger();

        const normalizedError = errorDetail.toLowerCase();
        const isModelUnavailable = normalizedError.includes("no api key for provider")
          || normalizedError.includes("configured primary model")
          || normalizedError.includes("was not found in the pi model registry");

        // Attempt to complete the run if it's still active.
        // If completeRun also fails, fall back to a direct DB update to ensure
        // the run is not permanently stuck in "active" state.
        try {
          if (isModelUnavailable) {
            const providerMatch = /no api key for provider:\s*([^\s)]+)/i.exec(errorDetail);
            const modelMatch = /configured primary model\s+([^/\s]+)\//i.exec(errorDetail);
            const provider = providerMatch?.[1] ?? modelMatch?.[1];
            const detail = provider
              ? `${errorDetail}. Configure credentials for provider "${provider}" in settings, then resume the agent.`
              : `${errorDetail}. Configure valid provider credentials in settings, then resume the agent.`;

            if (source === "timer") {
              await this.completeRun(agentId, run.id, {
                status: "completed",
                resultJson: {
                  reason: "heartbeat_model_unavailable",
                  source,
                  detail,
                },
                stderrExcerpt: detail,
              });
            } else {
              await this.completeRun(agentId, run.id, {
                status: "completed",
                resultJson: {
                  reason: "heartbeat_model_unavailable",
                  source,
                  detail,
                  actionRequired: true,
                },
                stderrExcerpt: detail,
                skipStateTransition: true,
              });
              await this.store.updateAgentState(agentId, "paused");
              await this.store.updateAgent(agentId, {
                pauseReason: "heartbeat-model-unavailable",
                lastError: detail,
              });
            }
          } else {
            await this.completeRun(agentId, run.id, {
              status: "failed",
              stderrExcerpt: errorDetail,
            });
          }
        } catch (completeRunErr) {
          const completeRunErrMsg = completeRunErr instanceof Error ? completeRunErr.message : String(completeRunErr);
          heartbeatLog.error(`completeRun failed for ${agentId}/${run.id}: ${completeRunErrMsg} — attempting safety-net completion`);

          // Safety net: directly update the run record to prevent zombie run state.
          // This runs only when completeRun itself threw, guaranteeing the run
          // doesn't remain permanently stuck in "active" state.
          try {
            const runDetail = await this.store.getRunDetail(agentId, run.id);
            if (runDetail && runDetail.status !== "completed" && runDetail.status !== "failed" && runDetail.status !== "terminated") {
              await this.store.saveRun({
                ...runDetail,
                endedAt: new Date().toISOString(),
                status: "failed",
                stderrExcerpt: `Heartbeat execution failed: ${errorMessage}. Run completion also failed: ${completeRunErrMsg}`,
              });
              await this.store.endHeartbeatRun(run.id, "terminated");
              // Also clean up run state accumulator
              this.clearRunState(agentId);
              heartbeatLog.log(`Safety-net run completion for ${agentId}/${run.id} — run terminated`);
            }
          } catch (safetyNetErr) {
            const safetyNetErrMsg = safetyNetErr instanceof Error ? safetyNetErr.message : String(safetyNetErr);
            heartbeatLog.error(`Safety-net run completion also failed for ${agentId}/${run.id}: ${safetyNetErrMsg} — run may be stuck permanently`);
          }
        }

        return (await this.store.getRunDetail(agentId, run.id))!;
      }
    });
  }

  private async buildReportsHealthSection(agentId: string, agentStore: AgentStore): Promise<string | null> {
    const storeWithReports = agentStore as AgentStore & {
      getAgentsByReportsTo?: (id: string) => Promise<Agent[]>;
      getAgent?: (id: string) => Promise<Agent | null>;
    };
    if (typeof storeWithReports.getAgentsByReportsTo !== "function") {
      return null;
    }

    let reports: Agent[];
    try {
      reports = await storeWithReports.getAgentsByReportsTo(agentId);
    } catch (err) {
      heartbeatLog.warn(`Failed to load reports for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (reports.length === 0) {
      return null;
    }

    const now = Date.now();
    const rows = await Promise.all(reports.map(async (report) => {
      const resolvedConfig = this.resolveAgentConfig(report.id);
      let pollIntervalMs = resolvedConfig.pollIntervalMs;
      let intervalSource: "runtimeConfig" | "persisted-agent" | "monitor-default" = "monitor-default";

      try {
        const cachedAgent = this.configStore.getCachedAgent?.(report.id);
        if (cachedAgent?.runtimeConfig && typeof cachedAgent.runtimeConfig.heartbeatIntervalMs === "number" && Number.isFinite(cachedAgent.runtimeConfig.heartbeatIntervalMs)) {
          pollIntervalMs = Math.max(1000, cachedAgent.runtimeConfig.heartbeatIntervalMs);
          intervalSource = "runtimeConfig";
        } else if (typeof storeWithReports.getAgent === "function") {
          const persisted = await storeWithReports.getAgent(report.id);
          if (persisted?.runtimeConfig && typeof persisted.runtimeConfig.heartbeatIntervalMs === "number" && Number.isFinite(persisted.runtimeConfig.heartbeatIntervalMs)) {
            pollIntervalMs = Math.max(1000, persisted.runtimeConfig.heartbeatIntervalMs);
            intervalSource = "persisted-agent";
          }
        }
      } catch (reportsHealthConfigErr) {
        heartbeatLog.warn(`[reports-health] failed to resolve interval for ${report.id}: ${reportsHealthConfigErr instanceof Error ? reportsHealthConfigErr.message : String(reportsHealthConfigErr)} — using monitor-default`);
      }

      const { heartbeatTimeoutMs } = resolvedConfig;
      const staleThresholdMs = Math.max(
        pollIntervalMs * REPORTS_STALE_INTERVAL_MULTIPLIER,
        MIN_HEARTBEAT_STALENESS_MS,
      );
      const lastHeartbeatTs = report.lastHeartbeatAt ? Date.parse(report.lastHeartbeatAt) : NaN;
      const heartbeatAgeMs = Number.isFinite(lastHeartbeatTs) ? Math.max(0, now - lastHeartbeatTs) : Infinity;

      let health = "healthy";
      if (report.state === "paused") {
        health = report.pauseReason ? `paused (${report.pauseReason})` : "paused";
      } else if (report.state === "error") {
        health = "**stuck**";
      } else if (report.state === "running") {
        health = heartbeatAgeMs <= heartbeatTimeoutMs * 2 ? "healthy" : "**stuck**";
      } else if ((report.state === "active" || report.state === "idle") && heartbeatAgeMs > staleThresholdMs) {
        health = "**stale**";
        heartbeatLog.log(`[reports-health] stale report ${report.id} intervalSource=${intervalSource} staleThresholdMs=${staleThresholdMs} heartbeatAgeMs=${heartbeatAgeMs}`);
      }

      const task = report.taskId ?? "—";
      const state = report.state;
      const heartbeat = formatRelativeTime(report.lastHeartbeatAt);
      return `| ${report.name} | ${state} | ${task} | ${heartbeat} | ${health} |`;
    }));

    const hasStuck = rows.some((row) => row.includes("**stuck**"));
    const hasStale = rows.some((row) => row.includes("**stale**"));

    const actionLines = ["### Actions for Unresponsive Reports"];
    if (hasStuck) {
      actionLines.push("- For **stuck** reports: consider sending a message via fn_send_message asking for status, or reassigning their task via fn_delegate_task to a healthy agent.");
    }
    if (hasStale) {
      actionLines.push("- For **stale** reports: the agent may have lost its heartbeat trigger — create a follow-up task to investigate.");
    }

    return [
      "## Reports Health Check",
      "",
      `You have ${reports.length} agent(s) reporting to you. Review their status and intervene if any are unresponsive.`, 
      "",
      "| Name | State | Task | Last Heartbeat | Health |",
      "|------|-------|------|----------------|--------|",
      ...rows,
      "",
      ...actionLines,
    ].join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Heartbeat tools: createHeartbeatTools / clearRunState
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create the tool set for a heartbeat agent session.
   *
   * Returns tools with tracking wrappers that record task creations
   * so they can be included in the run's `resultJson.tasksCreated`.
   *
   * @param agentId - The agent ID (used for tracking and logging)
   * @param taskStore - TaskStore for task creation and logging
   * @param taskId - The assigned task ID (for fn_task_log context)
   * @param runContext - Optional run context for mutation correlation
   * @param audit - Optional run auditor for audit trail (FN-1404)
   * @param messageStore - Optional MessageStore for messaging tools
   * @returns Array of ToolDefinitions for the heartbeat session
   */
  createHeartbeatTools(
    agentId: string,
    taskStore: TaskStore,
    taskId: string,
    runContext?: RunMutationContext,
    audit?: ReturnType<typeof createRunAuditor>,
    messageStore?: MessageStore,
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // Wrap createTaskCreateTool with tracking and agent-link logging.
    // Stamp the parent task ID so sibling tasks spawned from the same parent
    // can be deduped even if the AI rewrites their titles during triage.
    const baseCreateTool = createTaskCreateTool(taskStore, {
      sourceType: "agent_heartbeat",
      sourceAgentId: agentId,
      sourceRunId: runContext?.runId,
      sourceParentTaskId: taskId,
    }, { rootDir: this.rootDir });
    const trackedCreateTool: ToolDefinition = {
      ...baseCreateTool,
      execute: async (id: string, params: Static<typeof taskCreateParams>, signal, onUpdate, ctx) => {
        const result = await baseCreateTool.execute(id, params, signal, onUpdate, ctx);

        const createdTaskId = (result.details as { taskId?: string })?.taskId ?? "unknown";

        // Log agent link on the created task with run context for correlation
        try {
          await taskStore.logEntry(createdTaskId, `Created by agent ${agentId} during heartbeat run`, undefined, runContext);
        } catch (taskCreateLogErr) {
          heartbeatLog.warn(`Task ${createdTaskId} agent-link log failed: ${taskCreateLogErr instanceof Error ? taskCreateLogErr.message : String(taskCreateLogErr)}`);
        }

        // Audit trail: record task creation (FN-1404)
        await audit?.database({ type: "task:create", target: createdTaskId });

        // Accumulate for inclusion in run resultJson
        if (!this.runCreatedTasks.has(agentId)) {
          this.runCreatedTasks.set(agentId, []);
        }
        this.runCreatedTasks.get(agentId)!.push({
          id: createdTaskId,
          description: params.description,
        });

        return result;
      },
    };
    tools.push(trackedCreateTool);

    // fn_task_log tool (with run context for mutation correlation)
    tools.push(createTaskLogToolWithContext(taskStore, taskId, runContext));

    // Document tools for persisting durable findings
    tools.push(createTaskDocumentWriteTool(taskStore, taskId));
    tools.push(createTaskDocumentReadTool(taskStore, taskId));
    // Agent delegation tools — discover and delegate work to other agents
    tools.push(createListAgentsTool(this.store));
    tools.push(createDelegateTaskTool(this.store, taskStore, { rootDir: this.rootDir }));
    tools.push(createGetAgentConfigTool(this.store, agentId));
    tools.push(createUpdateAgentConfigTool(this.store, agentId));
    tools.push(createAgentCreateTool(this.store, agentId));
    tools.push(createAgentDeleteTool(this.store, agentId));

    // Messaging tools — when MessageStore is available, agents can send and receive messages
    if (messageStore) {
      tools.push(createSendMessageTool(messageStore, agentId));
      tools.push(createReadMessagesTool(messageStore, agentId));
    }
    if (this.chatStore) {
      tools.push(createPostRoomMessageTool(this.chatStore, agentId));
    }

    tools.push(createReadEvaluationsTool(this.store, this.reflectionStore, agentId));
    tools.push(createUpdateIdentityTool(this.store, agentId));
    if (this.reflectionService) {
      tools.push(createReflectOnPerformanceTool(this.reflectionService, agentId));
    }

    return tools;
  }

  /**
   * Clear accumulated run state for an agent.
   * Called after completing a run to reset the `runCreatedTasks` accumulator.
   * @param agentId - The agent ID
   */
  clearRunState(agentId: string): void {
    this.runCreatedTasks.delete(agentId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the resolved heartbeat configuration for an agent.
   * Reads per-agent config from runtimeConfig with fallback to monitor defaults.
   * @param agentId - The agent ID
   * @returns Resolved config with validated values
   */
  async getAgentHeartbeatConfig(agentId: string): Promise<ResolvedHeartbeatConfig> {
    return this.getAgentConfig(agentId);
  }

  /**
   * Resolve per-agent heartbeat config from runtimeConfig with validation and fallbacks.
   */
  private resolveAgentConfig(agentId: string): ResolvedHeartbeatConfig {
    // Defaults from monitor-level construction
    const result: ResolvedHeartbeatConfig = {
      pollIntervalMs: this.pollIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      maxConcurrentRuns: this.maxConcurrentRuns,
    };

    try {
      const agent = this.configStore.getCachedAgent?.(agentId);
      if (agent?.runtimeConfig) {
        const rc = agent.runtimeConfig;

        if (typeof rc.heartbeatIntervalMs === "number" && Number.isFinite(rc.heartbeatIntervalMs)) {
          result.pollIntervalMs = Math.max(1000, rc.heartbeatIntervalMs);
        }
        if (typeof rc.heartbeatTimeoutMs === "number" && Number.isFinite(rc.heartbeatTimeoutMs)) {
          result.heartbeatTimeoutMs = Math.max(5000, rc.heartbeatTimeoutMs);
        }
        if (typeof rc.maxConcurrentRuns === "number" && Number.isFinite(rc.maxConcurrentRuns)) {
          result.maxConcurrentRuns = Math.max(1, Math.round(rc.maxConcurrentRuns));
        }
      }
    } catch (agentLookupErr) {
      heartbeatLog.warn(`getAgentConfig(${agentId}) agent lookup failed: ${agentLookupErr instanceof Error ? agentLookupErr.message : String(agentLookupErr)} — using monitor defaults`);
    }

    // Sync health checks (isAgentHealthy / orphan reconcile / reports-health)
    // are best-effort and use the most recent async-loaded multiplier cache.
    const multiplier = this.cachedHeartbeatMultiplierAt > 0 ? this.cachedHeartbeatMultiplier : 1;
    result.pollIntervalMs = Math.max(1000, Math.round(result.pollIntervalMs * multiplier));
    result.heartbeatTimeoutMs = Math.max(5000, Math.round(result.heartbeatTimeoutMs * multiplier));

    return result;
  }

  private async warmHeartbeatMultiplierCache(): Promise<void> {
    if (!this.taskStore) return;
    try {
      const settings = await getHeartbeatMemorySettings(this.taskStore);
      this.cachedHeartbeatMultiplier = resolveHeartbeatMultiplier(settings?.heartbeatMultiplier);
      this.cachedHeartbeatMultiplierAt = Date.now();
    } catch {
      // Keep existing cache value on warm failures.
    }
  }

  private async getAgentConfig(agentId: string): Promise<ResolvedHeartbeatConfig> {
    const result = this.resolveAgentConfig(agentId);

    if (!this.taskStore) {
      return result;
    }

    try {
      const settings = await getHeartbeatMemorySettings(this.taskStore);
      const multiplier = resolveHeartbeatMultiplier(settings?.heartbeatMultiplier);
      this.cachedHeartbeatMultiplier = multiplier;
      this.cachedHeartbeatMultiplierAt = Date.now();

      result.pollIntervalMs = Math.max(1000, Math.round(result.pollIntervalMs * multiplier));
      result.heartbeatTimeoutMs = Math.max(5000, Math.round(result.heartbeatTimeoutMs * multiplier));
    } catch (settingsErr) {
      heartbeatLog.warn(`getAgentConfig(${agentId}) settings lookup failed: ${settingsErr instanceof Error ? settingsErr.message : String(settingsErr)} — using base interval`);
    }

    return result;
  }

  private async checkMissedHeartbeats(): Promise<void> {
    const now = Date.now();

    for (const tracked of this.trackedAgents.values()) {
      const config = await this.getAgentConfig(tracked.agentId);
      const elapsed = now - tracked.lastSeen;

      if (elapsed >= config.heartbeatTimeoutMs) {
        const reason = `No heartbeat for ${formatDuration(elapsed)} (threshold: ${formatDuration(config.heartbeatTimeoutMs)})`;
        // Missed heartbeat detected
        if (!tracked.missedHeartbeatReported) {
          tracked.missedHeartbeatReported = true;
          await this.handleMissedHeartbeat(tracked, reason);
        } else {
          // Already reported - check if we should terminate
          // Give 2x timeout for recovery before auto-terminate
          if (elapsed >= config.heartbeatTimeoutMs * 2) {
            await this.recoverUnresponsiveAgent(tracked, config.heartbeatTimeoutMs);
          }
        }
      }
    }

    // Periodically scan for orphaned `state="running"` rows so that a single
    // missed termination can't leave an agent permanently stuck. Cheap query
    // (indexed by state) so running it every poll is fine.
    await this.reconcileOrphanedRunningAgents();
  }

  private async handleMissedHeartbeat(tracked: TrackedAgent, reason: string): Promise<void> {
    // Record missed heartbeat
    await this.store.recordHeartbeat(tracked.agentId, "missed", tracked.runId);

    // Notify callback
    this.onMissed?.(tracked.agentId, reason);
  }

  private async recoverUnresponsiveAgent(tracked: TrackedAgent, heartbeatTimeoutMs: number): Promise<void> {
    const now = Date.now();
    const elapsed = now - tracked.lastSeen;
    const reason = `No heartbeat for ${formatDuration(elapsed)} (2× timeout threshold: ${formatDuration(heartbeatTimeoutMs * 2)})`;

    heartbeatLog.warn(`Recovering unresponsive agent ${tracked.agentId}: ${reason}`);

    const runIdToTerminate = tracked.runId;

    try {
      tracked.session.dispose();
    } catch (err) {
      heartbeatLog.warn(`Error disposing session for ${tracked.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.untrackAgent(tracked.agentId);

    // Canonically end the run record. Without this, dispose() relies on the
    // in-flight execution self-completing — which never happens when the run
    // is actually hung. completeRun also updates agent state, but we still
    // call pauseAgent below to set `pauseReason="heartbeat-unresponsive"`.
    // We pass cascadeToTasks:false on both pause and resume — this is an
    // internal recovery cycle, not a user-initiated pause, and shouldn't
    // visibly toggle the user's task pause state.
    try {
      await this.completeRun(tracked.agentId, runIdToTerminate, {
        status: "terminated",
        stderrExcerpt: reason,
      });
    } catch (err) {
      heartbeatLog.warn(`completeRun(terminated) failed for ${tracked.agentId}/${runIdToTerminate}: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.pauseAgent(tracked.agentId, {
        pauseReason: "heartbeat-unresponsive",
        stopActiveRun: false,
        cascadeToTasks: false,
      });
    } catch (err) {
      heartbeatLog.warn(`Error pausing unresponsive agent ${tracked.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.resumeAgent(tracked.agentId, {
        triggerDetail: "unresponsive-recovery",
        triggerSource: "heartbeat-unresponsive",
        clearPauseReason: true,
        cascadeToTasks: false,
      });
    } catch (err) {
      heartbeatLog.warn(`Error resuming unresponsive agent ${tracked.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HeartbeatTriggerScheduler — timer, assignment, and on-demand triggers
// ─────────────────────────────────────────────────────────────────────────

/** Structured context passed when a trigger fires. */
export interface WakeContext {
  /** Optional task ID associated with this trigger */
  taskId?: string;
  /** Why the agent was woken */
  wakeReason: string;
  /** Detail about the specific trigger */
  triggerDetail: string;
  /** IDs of comments that triggered this wake (if any) */
  triggeringCommentIds?: string[];
  /** Type of comment that triggered this wake */
  triggeringCommentType?: "steering" | "task" | "pr";
  /** Budget governance status for the agent at trigger time */
  budgetStatus?: AgentBudgetStatus;
  /** Additional context (intervalMs, etc.) */
  [key: string]: unknown;
}

/** Callback invoked when a trigger fires. */
export type TriggerCallback = (
  agentId: string,
  source: HeartbeatInvocationSource,
  context: WakeContext,
) => Promise<void>;

/** Per-agent timer state. The active handle is either the initial
 *  phase-aligned `setTimeout` waiting for the first overdue tick, or the
 *  steady-state `setInterval` installed once that first tick fires.
 */
interface AgentTimer {
  intervalMs: number;
  kind: "timeout" | "interval";
  handle: ReturnType<typeof setInterval>;
}

/** Optional context passed to registerAgent, used to phase-align the
 *  initial timer fire to the agent's persisted heartbeat history.
 */
export interface RegisterAgentOptions {
  /** ISO timestamp of the agent's last heartbeat. When set, the initial
   *  fire is scheduled at `lastHeartbeatAt + intervalMs` rather than
   *  `now + intervalMs`, so a process restart does not cost agents up to
   *  one full interval of silence.
   */
  lastHeartbeatAt?: string | null;
}

/** Maximum random jitter (ms) added to the initial fire when an agent's
 *  next tick is already overdue. Prevents a thundering herd when the
 *  scheduler boots and many agents want to fire immediately.
 */
const OVERDUE_FIRE_JITTER_MS = 5_000;

/**
 * True when an agent's state indicates it should be ticking right now.
 * Heartbeats track liveness while the agent is meant to be doing work.
 * 
 * States where timers should remain armed:
 * - "active" — Agent is working
 * - "running" — Agent has an active heartbeat run
 * - "idle" — Agent is between tasks, waiting for work (FN-2289 fix)
 * 
 * States where timers should be cleared:
 * - "paused" — Agent is paused by budget exhaustion or manual action
 * - "error" — Agent encountered an error
 */
function isTickableState(state: Agent["state"]): boolean {
  return state === "active" || state === "running" || state === "idle";
}

/**
 * True when the scheduler should manage this agent at all. Ephemeral
 * (task-worker) agents are driven directly by TaskExecutor and must never
 * acquire a scheduler timer.
 */
function isHeartbeatManaged(agent: Agent): boolean {
  return !isEphemeralAgent(agent);
}

/**
 * HeartbeatTriggerScheduler manages timer-based heartbeat triggers for agents.
 *
 * Timers are armed only for durable agents where all of the following hold:
 * - `runtimeConfig.enabled !== false`
 * - `state ∈ {active, running, idle}`
 *
 * Any other state, or any ephemeral/task-worker agent, clears the timer.
 * State changes and heartbeat config updates are observed via AgentStore
 * lifecycle events, while callers can still explicitly register existing
 * agents during startup bootstrap.
 *
 * Other config knobs still apply:
 * - `heartbeatIntervalMs`: Timer interval (default 1h)
 * - `maxConcurrentRuns`: Skip tick if agent already has an active run
 */
type HeartbeatTimerRepairMetadata = {
  repairedAt?: string;
  staleAtRepair?: boolean;
  staleRepairReason?: string;
};

function readHeartbeatTimerRepairMetadata(agent: Agent): HeartbeatTimerRepairMetadata {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata.heartbeatTimerRepair;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const candidate = raw as Record<string, unknown>;
  return {
    repairedAt: typeof candidate.repairedAt === "string" ? candidate.repairedAt : undefined,
    staleAtRepair: typeof candidate.staleAtRepair === "boolean" ? candidate.staleAtRepair : undefined,
    staleRepairReason: typeof candidate.staleRepairReason === "string" ? candidate.staleRepairReason : undefined,
  };
}

export class HeartbeatTriggerScheduler {
  private store: AgentStore;
  private callback: TriggerCallback;
  private taskStore?: TaskStore;
  private timers: Map<string, AgentTimer> = new Map();
  private registrationEpochs: Map<string, number> = new Map();
  private running = false;
  private assignedListener: ((agent: import("@fusion/core").Agent, taskId: string) => void) | null = null;
  private createdListener: ((agent: import("@fusion/core").Agent) => void) | null = null;
  private updatedListener: ((agent: import("@fusion/core").Agent) => void) | null = null;
  private configRevisionListener: ((agentId: string, revision: AgentConfigRevision) => void) | null = null;
  private deletedListener: ((agentId: string) => void) | null = null;
  private isTaskExecuting?: (taskId: string) => boolean;
  private timerAuditIntervalHandle: ReturnType<typeof setInterval> | null = null;

  private static readonly TIMER_AUDIT_INTERVAL_MS = 60_000;
  private static readonly DEFAULT_REPAIR_STALE_MULTIPLIER = 2;
  private static readonly DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

  constructor(store: AgentStore, callback: TriggerCallback, taskStore?: TaskStore, options?: { isTaskExecuting?: (taskId: string) => boolean }) {
    this.store = store;
    this.callback = callback;
    this.taskStore = taskStore;
    this.isTaskExecuting = options?.isTaskExecuting;
  }

  /**
   * Start the scheduler. Enables assignment watching.
   * Existing agents still need one startup bootstrap pass via registerAgent().
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchAssignments();
    this.watchAgentLifecycle();
    void this.auditTimerRegistrations("start");
    this.timerAuditIntervalHandle = setInterval(() => {
      void this.auditTimerRegistrations("interval");
    }, HeartbeatTriggerScheduler.TIMER_AUDIT_INTERVAL_MS);
    heartbeatLog.log("HeartbeatTriggerScheduler started");
  }

  /**
   * Stop the scheduler and clear all timers.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Unwatch assignments
    this.unwatchAssignments();
    this.unwatchAgentLifecycle();

    // Clear all timers (mix of phase-alignment timeouts and steady intervals).
    for (const [agentId, timer] of this.timers) {
      if (timer.kind === "timeout") {
        clearTimeout(timer.handle as unknown as ReturnType<typeof setTimeout>);
      } else {
        clearInterval(timer.handle);
      }
      heartbeatLog.log(`Cleared timer for ${agentId}`);
    }
    this.timers.clear();

    if (this.timerAuditIntervalHandle) {
      clearInterval(this.timerAuditIntervalHandle);
      this.timerAuditIntervalHandle = null;
    }

    heartbeatLog.log("HeartbeatTriggerScheduler stopped");
  }

  /**
   * Check if the scheduler is running.
   */
  isActive(): boolean {
    return this.running;
  }

  /** Default heartbeat interval when not explicitly configured (3600 seconds / 1 hour) */
  private static readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 3_600_000;

  /**
   * Register an agent for timer-based heartbeat triggers.
   *
   * The first fire is phase-aligned to `options.lastHeartbeatAt + intervalMs`
   * when supplied. This means a process restart resumes each agent's
   * existing schedule rather than waiting up to a full interval before the
   * first tick — the previous behavior caused agents on long intervals
   * (e.g. 1h) to appear "overdue" in the UI for nearly a full interval after
   * every dashboard restart even though nothing was actually wrong with them.
   *
   * @param agentId - The agent ID
   * @param config - Per-agent heartbeat config
   * @param options - Optional registration context (e.g., lastHeartbeatAt)
   */
  registerAgent(agentId: string, config: AgentHeartbeatConfig, options?: RegisterAgentOptions): void {
    if (config.enabled === false) {
      this.unregisterAgent(agentId);
      return;
    }

    // Apply default interval if not explicitly configured
    // This ensures agents with heartbeat monitoring enabled but no explicit interval
    // still get periodic timer triggers (matching HeartbeatMonitor constructor default)
    let rawIntervalMs = config.heartbeatIntervalMs;
    let usingDefaultInterval = false;
    if (!rawIntervalMs || typeof rawIntervalMs !== "number" || !Number.isFinite(rawIntervalMs) || rawIntervalMs <= 0) {
      rawIntervalMs = HeartbeatTriggerScheduler.DEFAULT_HEARTBEAT_INTERVAL_MS;
      usingDefaultInterval = true;
    }

    const intervalMs = Math.max(1000, Math.round(rawIntervalMs));
    const registrationEpoch = (this.registrationEpochs.get(agentId) ?? 0) + 1;
    this.registrationEpochs.set(agentId, registrationEpoch);

    const lastHeartbeatAt = options?.lastHeartbeatAt ?? null;

    // Register immediately with multiplier=1 so agents don't wait for async settings I/O.
    this.applyTimerRegistration(agentId, intervalMs, 1, usingDefaultInterval, lastHeartbeatAt);

    // If project settings are available, refresh registration with the current multiplier.
    if (this.taskStore && typeof (this.taskStore as { getSettings?: () => Promise<Settings> }).getSettings === "function") {
      void this.applyProjectMultiplierRegistration(agentId, intervalMs, usingDefaultInterval, registrationEpoch, lastHeartbeatAt);
    }
  }

  private async applyProjectMultiplierRegistration(
    agentId: string,
    baseIntervalMs: number,
    usingDefaultInterval: boolean,
    expectedEpoch: number,
    lastHeartbeatAt: string | null,
  ): Promise<void> {
    let multiplier = 1;

    try {
      const settings = await getHeartbeatMemorySettings(this.taskStore!);
      multiplier = HeartbeatTriggerScheduler.resolveHeartbeatMultiplier(settings?.heartbeatMultiplier);
    } catch (settingsErr) {
      heartbeatLog.warn(
        `Failed to read heartbeatMultiplier for ${agentId}: ${settingsErr instanceof Error ? settingsErr.message : String(settingsErr)} — using 1x`,
      );
      multiplier = 1;
    }

    // Guard against stale async completions after subsequent register/unregister calls.
    if (this.registrationEpochs.get(agentId) !== expectedEpoch) {
      return;
    }

    this.applyTimerRegistration(agentId, baseIntervalMs, multiplier, usingDefaultInterval, lastHeartbeatAt);
  }

  /**
   * Compute the delay until the agent's next scheduled fire, given when it
   * last heartbeat. When `lastHeartbeatAt` is missing or unparseable, falls
   * back to a full-interval delay (matching the original behavior for
   * agents that have never ticked). When the next fire is already overdue,
   * returns a small randomized jitter to spread thundering herds at boot.
   */
  private static computeInitialDelayMs(
    intervalMs: number,
    lastHeartbeatAt: string | null,
    now: number = Date.now(),
  ): number {
    if (!lastHeartbeatAt) {
      return intervalMs;
    }
    const lastMs = Date.parse(lastHeartbeatAt);
    if (!Number.isFinite(lastMs)) {
      return intervalMs;
    }
    const remaining = lastMs + intervalMs - now;
    if (remaining <= 0) {
      return Math.floor(Math.random() * OVERDUE_FIRE_JITTER_MS);
    }
    return Math.min(remaining, intervalMs);
  }

  private applyTimerRegistration(
    agentId: string,
    baseIntervalMs: number,
    multiplier: number,
    usingDefaultInterval: boolean,
    lastHeartbeatAt: string | null,
  ): void {
    const effectiveIntervalMs = Math.max(1000, Math.round(baseIntervalMs * multiplier));
    const initialDelayMs = HeartbeatTriggerScheduler.computeInitialDelayMs(
      effectiveIntervalMs,
      lastHeartbeatAt,
    );

    this.clearAgentTimer(agentId);

    const armSteadyInterval = () => {
      // The setTimeout fired and was consumed; replace it with the long-lived
      // setInterval that drives every subsequent tick. Use the same
      // effectiveIntervalMs so the cadence remains correct.
      const intervalHandle = setInterval(() => {
        void this.onTimerTick(agentId, effectiveIntervalMs);
      }, effectiveIntervalMs);
      this.timers.set(agentId, {
        intervalMs: effectiveIntervalMs,
        kind: "interval",
        handle: intervalHandle,
      });
    };

    if (initialDelayMs >= effectiveIntervalMs) {
      // No phase-shift needed (agent has never ticked, or the saved
      // lastHeartbeatAt is somehow in the future). Skip the timeout hop and
      // arm the steady-state interval directly so the behavior matches the
      // pre-phase-alignment scheduler.
      armSteadyInterval();
    } else {
      const timeoutHandle = setTimeout(() => {
        // Fire the overdue/phase-aligned tick first, then transition to the
        // steady cadence. The tick fires regardless of whether the steady
        // interval install succeeds, so a missed tick can never silently
        // happen here.
        void this.onTimerTick(agentId, effectiveIntervalMs);
        armSteadyInterval();
      }, initialDelayMs);
      this.timers.set(agentId, {
        intervalMs: effectiveIntervalMs,
        kind: "timeout",
        handle: timeoutHandle as unknown as ReturnType<typeof setInterval>,
      });
    }

    const phaseSuffix = lastHeartbeatAt
      ? `, first fire in ${initialDelayMs}ms (phase-aligned to lastHeartbeatAt)`
      : "";

    if (multiplier !== 1) {
      heartbeatLog.log(
        `Registered timer for ${agentId} (every ${baseIntervalMs}ms, multiplier ${multiplier} → ${effectiveIntervalMs}ms effective${phaseSuffix})`,
      );
      return;
    }

    heartbeatLog.log(
      usingDefaultInterval
        ? `Registered timer for ${agentId} (every ${effectiveIntervalMs}ms, default interval${phaseSuffix})`
        : `Registered timer for ${agentId} (every ${effectiveIntervalMs}ms${phaseSuffix})`,
    );
  }

  private clearAgentTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (!timer) {
      return;
    }
    // Both kinds share the same opaque handle type at runtime, but we route
    // through the matching clear function for clarity and to satisfy strict
    // type narrowing on platforms that distinguish the two.
    if (timer.kind === "timeout") {
      clearTimeout(timer.handle as unknown as ReturnType<typeof setTimeout>);
    } else {
      clearInterval(timer.handle);
    }
    this.timers.delete(agentId);
  }

  private static resolveHeartbeatMultiplier(rawMultiplier: unknown): number {
    return resolveHeartbeatMultiplier(rawMultiplier);
  }

  /**
   * Unregister an agent, clearing its timer.
   * @param agentId - The agent ID
   */
  unregisterAgent(agentId: string): void {
    this.registrationEpochs.set(agentId, (this.registrationEpochs.get(agentId) ?? 0) + 1);
    if (this.timers.has(agentId)) {
      this.clearAgentTimer(agentId);
      heartbeatLog.log(`Unregistered timer for ${agentId}`);
    }
  }

  /**
   * Get the set of currently registered agent IDs.
   * Useful for testing.
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.timers.keys());
  }

  /**
   * Subscribe to agent:assigned events on the AgentStore.
   * When a task is assigned to an agent, the trigger callback fires
   * with source "assignment" and the task ID in the context.
   */
  watchAssignments(): void {
    if (this.assignedListener) return; // Already watching

    this.assignedListener = async (agent, taskId) => {
      if (!this.running) return;

      try {
        if (!isHeartbeatManaged(agent)) {
          heartbeatLog.log(`Assignment trigger skipped for ${agent.id} (ephemeral/internal)`);
          return;
        }

        const runtimeConfig = (agent.runtimeConfig ?? {}) as { enabled?: boolean; allowParallelExecution?: boolean };
        if (runtimeConfig.enabled === false) {
          heartbeatLog.log(`Assignment trigger skipped for ${agent.id} (disabled)`);
          return;
        }

        // Guard: skip if agent already has an active run
        const activeRun = await this.store.getActiveHeartbeatRun(agent.id);
        if (activeRun) {
          heartbeatLog.log(`Assignment trigger skipped for ${agent.id} (active run)`);
          return;
        }

        // Guard: when parallel execution is disabled, skip if the bound task is actively executing
        if (runtimeConfig.allowParallelExecution === false && this.isTaskExecuting?.(taskId)) {
          heartbeatLog.log(`Assignment tick skipped for ${agent.id} (parallel execution disabled, task ${taskId} executing)`);
          return;
        }

        let budgetStatus: AgentBudgetStatus | undefined;
        // Budget governance: block even critical triggers when budget is fully exhausted
        try {
          budgetStatus = await this.store.getBudgetStatus(agent.id);
          if (budgetStatus.isOverBudget) {
            heartbeatLog.log(`Agent ${agent.id} budget exhausted — assignment trigger skipped`);
            return;
          }
        } catch (budgetErr) {
          heartbeatLog.warn(`Assignment trigger budget check failed for ${agent.id}: ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)} — proceeding without budget check`);
        }

        let triggeringCommentIds: string[] | undefined;
        if (this.taskStore && typeof this.taskStore.getTask === "function") {
          try {
            const [task, recentRuns] = await Promise.all([
              this.taskStore.getTask(taskId),
              this.store.getRecentRuns(agent.id, 1),
            ]);

            const lastRunAt = recentRuns[0]?.startedAt;
            const newSteeringComments = (task.steeringComments ?? []).filter((comment) =>
              !lastRunAt || comment.createdAt > lastRunAt,
            );
            if (newSteeringComments.length > 0) {
              triggeringCommentIds = newSteeringComments.map((comment) => comment.id);
            }
          } catch (error) {
            heartbeatLog.warn(
              `Failed to resolve triggering steering comments for assignment wake (${agent.id}/${taskId}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        heartbeatLog.log(`Assignment trigger for ${agent.id} (task: ${taskId})`);
        await this.callback(agent.id, "assignment", {
          taskId,
          wakeReason: "assignment",
          triggerDetail: "task-assigned",
          ...(triggeringCommentIds?.length
            ? {
              triggeringCommentIds,
              triggeringCommentType: "steering" as const,
            }
            : {}),
          ...(budgetStatus && { budgetStatus }),
        });
      } catch (err) {
        heartbeatLog.error(`Assignment trigger error for ${agent.id}: ${err instanceof Error ? err.message : err}`);
      }
    };

    this.store.on("agent:assigned", this.assignedListener);
    heartbeatLog.log("Watching agent:assigned events");
  }

  /**
   * Unsubscribe from agent:assigned events.
   */
  unwatchAssignments(): void {
    if (this.assignedListener) {
      this.store.off("agent:assigned", this.assignedListener);
      this.assignedListener = null;
      heartbeatLog.log("Stopped watching agent:assigned events");
    }
  }

  private isTimerEligibleAgent(agent: Agent): boolean {
    return isHeartbeatManaged(agent)
      && agent.runtimeConfig?.enabled !== false
      && isTickableState(agent.state);
  }

  private getAgentTimerConfig(agent: Agent): AgentHeartbeatConfig {
    const rc = (agent.runtimeConfig ?? {}) as {
      enabled?: boolean;
      heartbeatIntervalMs?: number;
      maxConcurrentRuns?: number;
    };
    return {
      enabled: rc.enabled,
      heartbeatIntervalMs: rc.heartbeatIntervalMs,
      maxConcurrentRuns: rc.maxConcurrentRuns,
    };
  }

  private syncTimerForAgent(agent: Agent, reason: string): void {
    if (!this.isTimerEligibleAgent(agent)) {
      this.unregisterAgent(agent.id);
      return;
    }

    if (this.timers.has(agent.id)) {
      // Already ticking — non-config updates should not reset the interval.
      return;
    }

    this.registerAgent(agent.id, this.getAgentTimerConfig(agent), {
      lastHeartbeatAt: agent.lastHeartbeatAt,
    });
    heartbeatLog.log(`Timer armed for ${agent.id} (${reason})`);
  }

  private async syncTimerForAgentFromStore(agentId: string, reason: string): Promise<void> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) {
      this.unregisterAgent(agentId);
      return;
    }

    if (!this.isTimerEligibleAgent(agent)) {
      this.unregisterAgent(agentId);
      return;
    }

    this.registerAgent(agent.id, this.getAgentTimerConfig(agent), {
      lastHeartbeatAt: agent.lastHeartbeatAt,
    });
    heartbeatLog.log(`Timer refreshed for ${agent.id} (${reason})`);
  }

  private didHeartbeatScheduleChange(revision: AgentConfigRevision): boolean {
    const before = (revision.before.runtimeConfig ?? {}) as Record<string, unknown>;
    const after = (revision.after.runtimeConfig ?? {}) as Record<string, unknown>;

    const pickScheduleFields = (runtimeConfig: Record<string, unknown>) => ({
      enabled: runtimeConfig.enabled,
      heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
      maxConcurrentRuns: runtimeConfig.maxConcurrentRuns,
    });

    return JSON.stringify(pickScheduleFields(before)) !== JSON.stringify(pickScheduleFields(after));
  }

  private watchAgentLifecycle(): void {
    if (this.createdListener || this.updatedListener || this.configRevisionListener || this.deletedListener) return;

    this.createdListener = (agent) => {
      this.syncTimerForAgent(agent, `created:${agent.state}`);
    };

    // State-driven registration: when an agent transitions into a tickable
    // state arm the timer; transitioning out clears it. Existing timers are
    // left alone here so unrelated agent updates do not reset the interval.
    this.updatedListener = (agent) => {
      this.syncTimerForAgent(agent, `state:${agent.state}`);
    };
    this.configRevisionListener = (agentId, revision) => {
      if (!this.didHeartbeatScheduleChange(revision)) {
        return;
      }

      void this.syncTimerForAgentFromStore(agentId, "runtime-config-updated");
    };
    this.deletedListener = (agentId) => {
      this.unregisterAgent(agentId);
    };

    this.store.on("agent:created", this.createdListener);
    this.store.on("agent:updated", this.updatedListener);
    this.store.on("agent:configRevision", this.configRevisionListener);
    this.store.on("agent:deleted", this.deletedListener);
  }

  private unwatchAgentLifecycle(): void {
    if (this.createdListener) {
      this.store.off("agent:created", this.createdListener);
      this.createdListener = null;
    }
    if (this.updatedListener) {
      this.store.off("agent:updated", this.updatedListener);
      this.updatedListener = null;
    }
    if (this.configRevisionListener) {
      this.store.off("agent:configRevision", this.configRevisionListener);
      this.configRevisionListener = null;
    }
    if (this.deletedListener) {
      this.store.off("agent:deleted", this.deletedListener);
      this.deletedListener = null;
    }
  }

  private resolveRepairStaleMultiplier(settings: Settings | null | undefined): number {
    const value = (settings as Record<string, unknown> | undefined)?.heartbeatRepairStaleMultiplier;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return HeartbeatTriggerScheduler.DEFAULT_REPAIR_STALE_MULTIPLIER;
    }
    return value;
  }

  private getRepairStaleThresholdMs(agent: Agent, staleMultiplier: number): number {
    const config = this.getAgentTimerConfig(agent);
    let rawIntervalMs = config.heartbeatIntervalMs;
    if (!rawIntervalMs || typeof rawIntervalMs !== "number" || !Number.isFinite(rawIntervalMs) || rawIntervalMs <= 0) {
      rawIntervalMs = HeartbeatTriggerScheduler.DEFAULT_HEARTBEAT_INTERVAL_MS;
    }
    const intervalMs = Math.max(1000, Math.round(rawIntervalMs));
    return Math.round(intervalMs * staleMultiplier);
  }

  private getActiveRunStaleThresholdMs(agent: Agent, staleMultiplier: number): number {
    const runtimeConfig = (agent.runtimeConfig ?? {}) as { heartbeatTimeoutMs?: number };
    const rawTimeoutMs = runtimeConfig.heartbeatTimeoutMs;
    const timeoutMs = typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
      ? Math.max(5000, Math.round(rawTimeoutMs))
      : HeartbeatTriggerScheduler.DEFAULT_HEARTBEAT_TIMEOUT_MS;
    return Math.round(timeoutMs * staleMultiplier);
  }

  private async maybeReapStaleActiveRun(
    agent: Agent,
    activeRun: AgentHeartbeatRun,
    reason: "audit" | "timer",
    staleMultiplier: number,
  ): Promise<{ reaped: boolean; elapsedMs: number; thresholdMs: number }> {
    if (!isHeartbeatManaged(agent)) {
      return { reaped: false, elapsedMs: Number.NaN, thresholdMs: Number.NaN };
    }

    const thresholdMs = this.getActiveRunStaleThresholdMs(agent, staleMultiplier);
    const elapsedMs = getHeartbeatAgeMs(agent);
    if (!Number.isFinite(elapsedMs) || elapsedMs <= thresholdMs) {
      return { reaped: false, elapsedMs, thresholdMs };
    }

    await terminatePersistedHeartbeatRun(
      this.store,
      agent.id,
      activeRun.id,
      `Reaped stale heartbeat run before next tick (no heartbeat for ${formatDuration(elapsedMs)}; threshold ${formatDuration(thresholdMs)})`,
    );
    heartbeatLog.warn(
      `Heartbeat stale-run reaped reason=orphaned-run-reaped agentId=${agent.id} runId=${activeRun.id} elapsedMs=${elapsedMs} thresholdMs=${thresholdMs} source=${reason}`,
    );
    return { reaped: true, elapsedMs, thresholdMs };
  }

  private async markRepairMetadata(agent: Agent, staleAtRepair: boolean, staleRepairReason?: string): Promise<void> {
    const updater = (this.store as { updateAgent?: (agentId: string, updates: { metadata: Record<string, unknown> }) => Promise<unknown> }).updateAgent;
    if (typeof updater !== "function") {
      return;
    }

    const existing = readHeartbeatTimerRepairMetadata(agent);
    const repairedAt = new Date().toISOString();
    const nextRepair: HeartbeatTimerRepairMetadata = {
      repairedAt,
      staleAtRepair,
      ...(staleAtRepair && staleRepairReason ? { staleRepairReason } : {}),
    };

    const didChange =
      existing.repairedAt !== nextRepair.repairedAt ||
      existing.staleAtRepair !== nextRepair.staleAtRepair ||
      existing.staleRepairReason !== nextRepair.staleRepairReason;
    if (!didChange) {
      return;
    }

    const metadata = { ...(agent.metadata ?? {}) } as Record<string, unknown>;
    metadata.heartbeatTimerRepair = nextRepair;
    await updater.call(this.store, agent.id, { metadata });
  }

  async auditTimerRegistrations(reason: "start" | "interval" = "interval"): Promise<void> {
    if (!this.running) return;

    try {
      const settings = this.taskStore && typeof this.taskStore.getSettings === "function"
        ? await this.taskStore.getSettings()
        : null;
      const staleMultiplier = this.resolveRepairStaleMultiplier(settings);
      const agents = await this.store.listAgents();
      let rearmedCount = 0;
      for (const agent of agents) {
        if (!this.isTimerEligibleAgent(agent)) continue;
        if (this.timers.has(agent.id)) continue;

        const activeRun = await this.store.getActiveHeartbeatRun(agent.id);
        const activeRunId = activeRun?.id ?? null;
        let reapedActiveRun = false;
        let activeRunElapsedMs = Number.NaN;
        let activeRunThresholdMs = Number.NaN;
        if (activeRun) {
          if (settings?.globalPause || settings?.enginePaused) {
            heartbeatLog.log(`Timer audit skipped re-arm for ${agent.id} (active run)`);
            continue;
          }
          const reapResult = await this.maybeReapStaleActiveRun(agent, activeRun, "audit", staleMultiplier);
          reapedActiveRun = reapResult.reaped;
          activeRunElapsedMs = reapResult.elapsedMs;
          activeRunThresholdMs = reapResult.thresholdMs;
          if (!reapedActiveRun) {
            heartbeatLog.log(`Timer audit skipped re-arm for ${agent.id} (active run)`);
            continue;
          }
        }

        this.registerAgent(agent.id, this.getAgentTimerConfig(agent), {
          lastHeartbeatAt: agent.lastHeartbeatAt,
        });

        const staleThresholdMs = this.getRepairStaleThresholdMs(agent, staleMultiplier);
        const elapsedMs = getHeartbeatAgeMs(agent);
        const staleAtRepair = Number.isFinite(elapsedMs) && elapsedMs > staleThresholdMs;
        const staleRepairReason = staleAtRepair
          ? `No heartbeat for ${Math.round(elapsedMs / 1000)}s before timer audit repair (threshold ${Math.round(staleThresholdMs / 1000)}s)`
          : undefined;
        await this.markRepairMetadata(agent, staleAtRepair, staleRepairReason);

        rearmedCount++;
        if (reapedActiveRun && activeRunId) {
          heartbeatLog.log(
            `Timer audit re-armed after stale-run reap reason=timer-audit-rearmed agentId=${agent.id} runId=${activeRunId} elapsedMs=${activeRunElapsedMs} thresholdMs=${activeRunThresholdMs}`,
          );
        }
        if (staleAtRepair) {
          heartbeatLog.warn(`Timer re-armed stale agent ${agent.id} (audit:${reason}): ${staleRepairReason ?? "heartbeat exceeded stale threshold before repair"}`);
        } else {
          heartbeatLog.log(`Timer re-armed for ${agent.id} (audit:${reason})`);
        }
      }

      if (rearmedCount > 0) {
        heartbeatLog.log(`Timer audit repaired ${rearmedCount} missing registration(s) (${reason})`);
      }
    } catch (error) {
      heartbeatLog.warn(`Timer audit failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle a timer tick for an agent.
   * Checks for active runs before invoking the callback.
   */
  private async onTimerTick(agentId: string, intervalMs: number): Promise<void> {
    if (!this.running) return;

    try {
      const agent = await this.store.getAgent(agentId);
      if (!agent) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (agent missing)`);
        this.unregisterAgent(agentId);
        return;
      }
      if (!isHeartbeatManaged(agent) || !isTickableState(agent.state)) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (state=${agent.state})`);
        this.unregisterAgent(agentId);
        return;
      }

      // Guard: skip timer ticks for idle agents when configured
      const timerRc = (agent.runtimeConfig ?? {}) as {
        allowParallelExecution?: boolean;
        skipHeartbeatWhenIdle?: boolean;
      };
      if (timerRc.skipHeartbeatWhenIdle === true && (!agent.taskId || agent.taskId.length === 0)) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (skipHeartbeatWhenIdle, no task assigned)`);
        return;
      }

      // Guard: when parallel execution is disabled, skip if the agent's bound task is actively executing
      if (timerRc.allowParallelExecution === false && agent.taskId && this.isTaskExecuting?.(agent.taskId)) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (parallel execution disabled, task ${agent.taskId} executing)`);
        return;
      }

      // Global/engine pause guard: scheduler should not dispatch timer callbacks
      // while globally paused (hard stop) or engine paused (soft stop for timers).
      const settings = this.taskStore ? await this.taskStore.getSettings() : null;
      if (settings?.globalPause) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (global pause active)`);
        return;
      }
      if (settings?.enginePaused) {
        heartbeatLog.log(`Timer tick skipped for ${agentId} (engine paused)`);
        return;
      }

      // Check for active runs
      const activeRun = await this.store.getActiveHeartbeatRun(agentId);
      if (activeRun) {
        const staleMultiplier = this.resolveRepairStaleMultiplier(settings);
        const reapResult = await this.maybeReapStaleActiveRun(agent, activeRun, "timer", staleMultiplier);
        if (!reapResult.reaped) {
          heartbeatLog.log(`Timer tick skipped for ${agentId} (active run)`);
          return;
        }
        heartbeatLog.log(
          `Heartbeat tick resumed after stale-run reap reason=tick-proceeded-after-reap agentId=${agentId} runId=${activeRun.id} elapsedMs=${reapResult.elapsedMs} thresholdMs=${reapResult.thresholdMs}`,
        );
      }

      // Budget enforcement is handled in HeartbeatMonitor.executeHeartbeat() for timer sources.
      // The scheduler dispatches the callback regardless of budget status so that executeHeartbeat()
      // can create explicit run records with budget_exhausted/budget_threshold_exceeded reasons.
      // This makes timer budget skips observable rather than silent drops.

      await this.callback(agentId, "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs,
      });
    } catch (err) {
      heartbeatLog.error(`Timer tick error for ${agentId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
