/**
 * Chat System — Dashboard AI Integration
 *
 * Manages AI agent chat sessions with SSE streaming for real-time responses.
 * Follows the PlanningStreamManager pattern for SSE broadcast.
 *
 * Features:
 * - AI agent integration via createFnAgent for real-time chat responses
 * - Streaming via SSE (sendMessage) with thinking/text/done/error events
 * - Rate limiting per IP (30 messages per minute)
 * - Message persistence through ChatStore
 * - Session management for conversation history
 */

import type {
  Agent,
  AgentStore,
  ChatMention,
  ChatAttachment,
  ChatInFlightGenerationState,
  ChatMessage,
  ChatStore,
  ChatRoomMessage,
  ChatSession,
  ChatSessionCreateInput,
  ChatTokenUsageCreateInput,
  MessageStore,
  Settings,
  TaskStore,
} from "@fusion/core";
import type { SkillSelectionContext } from "@fusion/engine";
import { summarizeTitle, FUSION_RUNTIME_SELF_AWARENESS } from "@fusion/core";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionEventBuffer } from "./sse-buffer.js";
import {
  formatChatAttachmentContents,
  formatChatImageAttachmentHints,
  readChatAttachmentContents,
} from "./chat-attachment-content.js";
import { buildTaskPlannerChatContext, TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE } from "./task-planner-chat-context.js";
import { formatTaskPlannerChatMetrics } from "./task-planner-chat-metrics.js";
import { emitWorkflowSseEvent, type WorkflowSseEventType } from "./sse.js";

import {
  createFnAgent as engineCreateFnAgent,
  createResolvedAgentSession as engineCreateResolvedAgentSession,
  promptWithFallback as enginePromptWithFallback,
  extractRuntimeHint,
  extractRuntimeModel,
  buildSessionSkillContextSync,
  createSendMessageTool,
  createReadMessagesTool,
  createAskQuestionTool,
  createChatArtifactTools,
  createChatTaskDocumentTools,
  createWorkflowAuthoringTools,
  resolveMcpServersForStore,
  resolveExecutorThinkingLevel,
} from "@fusion/engine";
import * as engineModule from "@fusion/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createFnAgent: any = engineCreateFnAgent;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createResolvedAgentSession: any = engineCreateResolvedAgentSession;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildAgentChatPromptFn: any;

/**
 * Diagnostics logger for the chat module.
 * Provides consistent [chat] prefixed output with test-injectable handlers.
 * Mirrors the pattern established in planning.ts (FN-2225).
 */
interface DiagnosticsLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const defaultDiagnostics: DiagnosticsLogger = {
  log(message: string, ...args: unknown[]) {
    console.log(`[chat] ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    console.warn(`[chat] ${message}`, ...args);
  },
  error(message: string, ...args: unknown[]) {
    console.error(`[chat] ${message}`, ...args);
  },
};

let _diagnostics: DiagnosticsLogger = defaultDiagnostics;

/**
 * Get the current diagnostics logger.
 * @internal - exposed for test hook
 */
export function __getChatDiagnostics(): DiagnosticsLogger {
  return _diagnostics;
}

/**
 * Inject a diagnostics logger (test-only).
 * When a logger is injected, all chat module diagnostics route through it.
 * This allows tests to assert on diagnostics without global console spies.
 * @internal - exposed for test hook
 */
export function __setChatDiagnostics(diagnostics: DiagnosticsLogger | null): void {
  _diagnostics = diagnostics ?? defaultDiagnostics;
}

/**
 * Shared diagnostics helper used throughout the chat module.
 * Routes all informational, warning, and error diagnostics through the current logger.
 * Mirrors the pattern from planning.ts (FN-2225).
 */
const diagnostics: DiagnosticsLogger = {
  log(message: string, ...args: unknown[]) {
    _diagnostics.log(message, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    _diagnostics.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    _diagnostics.error(message, ...args);
  },
};

const SKILL_COMMAND_PATTERN = /(^|\s)\/skill:([^\s]+)/gi;

function bareChatSkillCommandName(name: string): string {
  return name
    .replace(/\/SKILL\.md$/i, "")
    .replace(/[.,;!?)]*$/g, "")
    .trim();
}

function pushDedupedSkillName(names: string[], seen: Set<string>, name: string): void {
  const bareName = bareChatSkillCommandName(name);
  if (!bareName) {
    return;
  }
  const key = bareName.toLowerCase();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  names.push(bareName);
}

function parseSkillCommands(content: string): { requestedSkillNames: string[]; strippedContent: string } {
  const requestedSkillNames: string[] = [];
  const seen = new Set<string>();
  let foundCommand = false;

  const strippedContent = content.replace(SKILL_COMMAND_PATTERN, (match, leadingWhitespace: string, rawName: string) => {
    foundCommand = true;
    pushDedupedSkillName(requestedSkillNames, seen, rawName);
    return leadingWhitespace ? " " : "";
  });

  if (!foundCommand) {
    return { requestedSkillNames, strippedContent: content };
  }

  return {
    requestedSkillNames,
    strippedContent: strippedContent.replace(/\s+/g, " ").trim(),
  };
}

function mergeTypedSkillCommands(
  baseSkillSelection: SkillSelectionContext | undefined,
  typedSkillNames: string[],
  projectRootDir: string,
  sessionPurpose: string,
): SkillSelectionContext | undefined {
  if (typedSkillNames.length === 0) {
    return baseSkillSelection;
  }

  const requestedSkillNames: string[] = [];
  const seen = new Set<string>();
  for (const name of baseSkillSelection?.requestedSkillNames ?? []) {
    pushDedupedSkillName(requestedSkillNames, seen, name);
  }
  for (const name of typedSkillNames) {
    pushDedupedSkillName(requestedSkillNames, seen, name);
  }

  /*
  FNXC:ChatSkills 2026-06-17-18:16:
  The advertised chat `/skill:{name}` command must request that skill for the model-loop session while keeping execution settings authoritative; this merge only adds requested names to the existing skill-selection context so the resolver still filters disabled or excluded skills.
  */
  return {
    projectRootDir: baseSkillSelection?.projectRootDir ?? projectRootDir,
    requestedSkillNames,
    sessionPurpose: baseSkillSelection?.sessionPurpose ?? sessionPurpose,
  };
}

async function ensureEngineReady(): Promise<void> {
  if (buildAgentChatPromptFn) {
    return;
  }

  if ("buildAgentChatPrompt" in engineModule && typeof engineModule.buildAgentChatPrompt === "function") {
    buildAgentChatPromptFn = engineModule.buildAgentChatPrompt;
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Chat system prompt for the AI agent */
export const CHAT_SYSTEM_PROMPT = `${FUSION_RUNTIME_SELF_AWARENESS}

You are a helpful AI assistant integrated into the fn task board system. You help users with questions about their project, code, architecture, and tasks. You have access to project files and can read them to provide informed responses, including referencing specific file paths and line numbers when possible. Response length policy: default to a short, crisp reply (a few sentences or a short bulleted list) that directly answers the user; avoid preamble, restating the question, and filler. If a thorough answer genuinely needs long-form content (for example multi-step plans, design proposals, deep analyses, or long file excerpts), keep the chat reply brief with a one- or two-sentence summary and then send the full write-up via \`fn_send_message\` using \`type: "agent-to-user"\` and \`to_id: "dashboard"\`. That mailbox follow-up must add new substantive detail and must not duplicate the chat reply.`;

export const CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE = `## Messaging Semantics\n\nYour chat reply is the primary response to the user. Do not also call \`fn_send_message\` with the same content just to mirror your chat response into mailbox.\n\nUse \`fn_send_message\` only when either (a) the user explicitly asks for mailbox/inbox/notification delivery (for example: "send me this in mail", "ntfy me when…", or "leave me a note in my inbox"), or (b) you are sending a genuinely longer follow-up that did not fit in a short chat reply. In either case, send with \`type: "agent-to-user"\` and target the dashboard user alias (\`to_id: "dashboard"\` is preferred), and ensure the mailbox message is additive rather than a duplicate of the chat reply. Never route that as a user/CLI → agent message.`;

/**
 * FNXC:ChatAskQuestion 2026-06-17-13:17:
 * Only the dashboard chat lane registers `fn_ask_question`, so append this guidance during sendMessage prompt assembly instead of baking it into room-responder prompts that do not receive the tool.
 *
 * FNXC:ChatAskQuestion 2026-06-18-05:53:
 * Agents presenting a set of options, choices, or alternatives should render them as `fn_ask_question` cards instead of prose so users can select an answer in chat.
 */
export const CHAT_ASK_QUESTION_GUIDANCE = `## Asking the User\n\nWhen you need structured input, or whenever you present options, choices, or a decision between alternatives, call \`fn_ask_question\` with one or more questions using the right shape (single_select, multi_select, confirm/yes-no, or text) instead of listing options only in prose, then stop and wait for the user's next chat message.`;

/** Rate limiting window in milliseconds (1 minute) */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Max messages per IP per minute */
const MAX_MESSAGES_PER_IP_PER_MINUTE = 30;

/** Maximum file size for # mentions (50KB). Files larger than this are skipped. */
const MAX_REFERENCED_FILE_SIZE = 50 * 1024;
export const TASK_PLANNER_CHAT_AGENT_ID_PREFIX = "task-planner:";
const ROOM_AMBIENT_MAX_RESPONDERS = 5;

type ChatSessionStatsLike = { tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } };
type ChatTokenDelta = Pick<ChatTokenUsageCreateInput, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens">;

function normalizeChatTokenDelta(stats: ChatSessionStatsLike | undefined): ChatTokenDelta | undefined {
  const tokens = stats?.tokens;
  if (!tokens) return undefined;
  const inputTokens = Math.max(0, Math.trunc(tokens.input ?? 0));
  const outputTokens = Math.max(0, Math.trunc(tokens.output ?? 0));
  const cachedTokens = Math.max(0, Math.trunc(tokens.cacheRead ?? 0));
  const cacheWriteTokens = Math.max(0, Math.trunc(tokens.cacheWrite ?? 0));
  const totalTokens = Math.max(0, Math.trunc(tokens.total ?? (inputTokens + outputTokens + cachedTokens + cacheWriteTokens)));
  if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && cacheWriteTokens === 0 && totalTokens === 0) return undefined;
  return { inputTokens, outputTokens, cachedTokens, cacheWriteTokens, totalTokens };
}

async function readChatSessionTokenDelta(session: unknown): Promise<ChatTokenDelta | undefined> {
  const accessor = (session as { getSessionStats?: () => ChatSessionStatsLike | Promise<ChatSessionStatsLike> }).getSessionStats;
  if (typeof accessor !== "function") return undefined;
  try {
    return normalizeChatTokenDelta(await accessor.call(session));
  } catch {
    return undefined;
  }
}

function modelSnapshotForTokenUsage(session: unknown, fallback?: { fallbackModel?: string }): { provider: string | null; modelId: string | null } {
  const model = (session as { model?: { provider?: string; id?: string } }).model;
  if (model?.provider || model?.id) {
    return { provider: model.provider ?? null, modelId: model.id ?? null };
  }
  if (fallback?.fallbackModel?.includes("/")) {
    const [provider, ...modelParts] = fallback.fallbackModel.split("/");
    return { provider: provider || null, modelId: modelParts.join("/") || null };
  }
  return { provider: null, modelId: fallback?.fallbackModel ?? null };
}

type ChatCustomTool = ReturnType<typeof createWorkflowAuthoringTools>[number];
type ChatToolExecute = (...args: unknown[]) => Promise<unknown>;

function workflowEventForToolName(toolName: string): WorkflowSseEventType | null {
  if (toolName === "fn_workflow_create") return "workflow:created";
  if (toolName === "fn_workflow_update" || toolName === "fn_workflow_select" || toolName === "fn_workflow_settings") return "workflow:updated";
  if (toolName === "fn_workflow_delete") return "workflow:deleted";
  return null;
}

function wrapWorkflowMutationTool(tool: ChatCustomTool, projectId?: string | null): ChatCustomTool {
  const event = workflowEventForToolName(tool.name);
  if (!event || typeof tool.execute !== "function") return tool;
  return {
    ...tool,
    execute: (async (...args: Parameters<ChatToolExecute>) => {
      const result = await (tool.execute as unknown as ChatToolExecute)(...args);
      const resultRecord = result && typeof result === "object" ? result as { isError?: boolean; details?: unknown } : null;
      if (!resultRecord?.isError) {
        const details = resultRecord?.details && typeof resultRecord.details === "object" ? resultRecord.details as Record<string, unknown> : {};
        /*
        FNXC:ChatWorkflowAuthoring 2026-07-01-10:55:
        Chat, planner, and room responders mutate workflows outside the REST workflow routes, so successful workflow tools must emit the same lifecycle SSE events as the editor routes. Workflow selectors and editors rely on those events to bypass stale in-flight/cache state and show chat-created definitions without a hard reload.
        */
        const workflowId = typeof (details as { workflowId?: unknown }).workflowId === "string"
          ? (details as { workflowId: string }).workflowId
          : typeof (details as { id?: unknown }).id === "string"
            ? (details as { id: string }).id
            : undefined;
        emitWorkflowSseEvent(event, workflowId ? { ...details, id: workflowId } : details, projectId ?? undefined);
      }
      return result;
    }) as ChatCustomTool["execute"],
  };
}

function createChatWorkflowAuthoringTools(taskStore: TaskStore | undefined, projectId?: string | null): ChatCustomTool[] {
  if (!taskStore) return [];
  /*
  FNXC:ChatWorkflowAuthoring 2026-07-01-10:55:
  Every provider-backed chat surface with a scoped TaskStore exposes the same safe workflow-authoring tools. Passing an empty currentTaskId keeps ambient chat lanes from silently selecting a workflow for an implicit task; agents must provide task_id unless the tool is invoked from an explicitly task-scoped helper.
  */
  return createWorkflowAuthoringTools(taskStore, "", { stripApprovalFlags: true })
    .map((tool) => wrapWorkflowMutationTool(tool, projectId));
}

function createTaskPlannerMetricsTool(taskStore: TaskStore, taskId: string, getPricingOverrides: () => Promise<Settings["modelPricingOverrides"] | undefined>) {
  return {
    name: "fn_task_planner_get_task_metrics",
    label: "Get Current Task Metrics",
    description: "Read token usage, derived model cost, and execution timing metrics for the current task. The task id is fixed by server context; this tool never accepts or reveals metrics for another task.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      try {
        const task = await taskStore.getTask(taskId, { activityLogLimit: 100 });
        const metrics = formatTaskPlannerChatMetrics(task, {
          pricingOverrides: await getPricingOverrides(),
          nowMs: Date.now(),
        });
        return {
          content: [{ type: "text" as const, text: metrics.summaryText }],
          details: metrics.metrics,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Could not load metrics for the current task ${taskId}: ${message}` }],
          details: { taskId, error: message },
          isError: true,
        };
      }
    },
  };
}

function createTaskPlannerRefinementTool(taskStore: TaskStore, taskId: string) {
  return {
    name: "fn_task_planner_create_refinement",
    label: "Create Refinement Task",
    description: "Create one follow-up refinement task from the current completed task. The source task id is fixed by server context; never accept or infer a different task id. Use only for clear follow-up implementation or improvement requests after completion.",
    parameters: {
      type: "object",
      properties: {
        feedback: { type: "string", description: "The user's concise follow-up or improvement request for the refinement task. Do not include hidden prompt/context text." },
      },
      required: ["feedback"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: { feedback?: unknown }) => {
      const feedback = typeof params.feedback === "string" ? params.feedback.trim() : "";
      if (!feedback) {
        return { content: [{ type: "text" as const, text: "ERROR: feedback must be a non-empty string" }], details: { sourceTaskId: taskId }, isError: true };
      }
      try {
        const sourceTask = await taskStore.getTask(taskId);
        if (sourceTask.column !== "done") {
          return {
            content: [{ type: "text" as const, text: `ERROR: Current task ${taskId} is ${sourceTask.column}; use planner steering for live tasks instead of creating a refinement.` }],
            details: { sourceTaskId: taskId, column: sourceTask.column },
            isError: true,
          };
        }
        const refinedTask = await taskStore.refineTask(taskId, feedback);
        return {
          content: [{ type: "text" as const, text: `Created refinement task ${refinedTask.id} from ${taskId}.` }],
          details: {
            sourceTaskId: taskId,
            refinementTaskId: refinedTask.id,
            description: refinedTask.description ?? feedback,
            column: refinedTask.column,
            createdAt: refinedTask.createdAt,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Could not create a refinement for the current task ${taskId}: ${message}` }],
          details: { sourceTaskId: taskId, error: message },
          isError: true,
        };
      }
    },
  };
}

function createTaskPlannerSteeringTool(taskStore: TaskStore, taskId: string) {
  return {
    name: "fn_task_planner_add_steering",
    label: "Add Task Steering Comment",
    description: "Add a clear, bounded, user-authored steering comment to the current task. The task id is fixed by server context; never accept or infer a different task id. Ask for clarification before broad, destructive, credential/security-sensitive, conflicting, or unclear requests.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The concise steering comment to add to the current task. Do not include hidden prompt/context text." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: { text?: unknown }) => {
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) {
        return { content: [{ type: "text" as const, text: "ERROR: text must be a non-empty string" }], details: {}, isError: true };
      }
      const task = await taskStore.addSteeringComment(taskId, text, "user");
      const steeringComment = task.steeringComments
        ?.filter((comment) => comment.author === "user" && comment.text === text)
        .at(-1);
      return {
        content: [{ type: "text" as const, text: `Added as steering comment on ${task.id}.` }],
        details: {
          taskId: task.id,
          text,
          taskUpdatedAt: task.updatedAt,
          steeringComment: steeringComment
            ? {
                id: steeringComment.id,
                text: steeringComment.text,
                author: steeringComment.author,
                createdAt: steeringComment.createdAt,
              }
            : { text, author: "user" },
        },
      };
    },
  };
}

/** Sentinel response from room responders indicating an intentional no-op/silence. */
export const ROOM_SKIP_SENTINEL = "__SKIP__";

export function isRoomSkipSentinel(content: string): boolean {
  return content.trim() === ROOM_SKIP_SENTINEL;
}
const DEFAULT_ROOM_THREAD_RECENT_VERBATIM_MESSAGES = 25;
const DEFAULT_ROOM_THREAD_COMPACTION_FETCH_LIMIT = 200;
const ROOM_THREAD_CONTEXT_MAX_CHARS = 20_000;
const ROOM_THREAD_MESSAGE_CONTENT_MAX_CHARS = 1_200;
const DEFAULT_ROOM_THREAD_SUMMARY_MAX_CHARS = 3_000;
const IN_FLIGHT_PERSIST_DEBOUNCE_MS = 200;

type RoomTranscriptMessage = Pick<ChatRoomMessage, "id" | "role" | "content" | "createdAt" | "senderAgentId">;

function getRoomSenderLabel(message: Pick<RoomTranscriptMessage, "role" | "senderAgentId">): string {
  return message.role === "user"
    ? "User"
    : message.role === "system"
      ? "System"
      : (message.senderAgentId ? `Agent ${message.senderAgentId}` : "Assistant");
}

function truncateWithEllipsis(content: string, maxChars: number): string {
  return content.length > maxChars
    ? `${content.slice(0, maxChars - 1)}…`
    : content;
}

function formatRoomThreadLine(message: RoomTranscriptMessage, latestUserMessageId: string): string {
  const marker = message.id === latestUserMessageId ? " [LATEST USER MESSAGE — ANSWER THIS]" : "";
  return `- [${message.createdAt}] (${message.role}) ${getRoomSenderLabel(message)}: ${truncateWithEllipsis(message.content, ROOM_THREAD_MESSAGE_CONTENT_MAX_CHARS)}${marker}`;
}

function formatRoomThreadContext(messages: RoomTranscriptMessage[], latestUserMessageId: string): string {
  return messages.map((message) => formatRoomThreadLine(message, latestUserMessageId)).join("\n");
}

function buildRoomSummaryBlock(
  olderMessages: RoomTranscriptMessage[],
  opts?: { summaryMaxChars?: number },
): string {
  if (olderMessages.length === 0) {
    return "";
  }

  const participants = Array.from(new Set(olderMessages.map((message) => getRoomSenderLabel(message))));
  const rankedHighlights = olderMessages
    .map((message, index) => ({
      message,
      index,
      score: (message.role === "user" ? 2 : message.role === "assistant" ? 1 : 0) * 1000 + message.content.length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 5)
    .sort((left, right) => left.index - right.index)
    .map(({ message }) => `  - [${message.createdAt}] ${getRoomSenderLabel(message)}: ${truncateWithEllipsis(message.content, 240)}`);

  const summaryLines = [
    "## Earlier room context (compacted)",
    `- Span: ${olderMessages.length} messages from ${olderMessages[0]?.createdAt ?? ""} to ${olderMessages.at(-1)?.createdAt ?? ""}`,
    `- Participants: ${participants.join(", ")}`,
    "- Highlights:",
  ];

  const baseSummary = summaryLines.join("\n");
  if (rankedHighlights.length === 0) {
    return baseSummary;
  }

  const highlights = [...rankedHighlights];
  const summaryMaxChars = opts?.summaryMaxChars ?? DEFAULT_ROOM_THREAD_SUMMARY_MAX_CHARS;
  while (`${baseSummary}\n${highlights.join("\n")}`.length > summaryMaxChars && highlights.length > 0) {
    highlights.pop();
  }

  return highlights.length > 0
    ? `${baseSummary}\n${highlights.join("\n")}`
    : baseSummary;
}

export function buildCompactedRoomTranscript(
  messages: RoomTranscriptMessage[],
  latestUserMessageId: string,
  opts?: { recentVerbatim?: number; summaryMaxChars?: number },
): string {
  if (messages.length === 0) {
    return "";
  }

  const messageIndexes = new Map(messages.map((message, index) => [message.id, index]));
  const latestUserMessage = messages.find((message) => message.id === latestUserMessageId);
  const recentVerbatim = Math.max(1, Math.floor(opts?.recentVerbatim ?? DEFAULT_ROOM_THREAD_RECENT_VERBATIM_MESSAGES));
  const splitIndex = Math.max(0, messages.length - recentVerbatim);
  let olderMessages = messages.slice(0, splitIndex);
  let recentMessages = messages.slice(splitIndex);

  if (latestUserMessage && !recentMessages.some((message) => message.id === latestUserMessageId)) {
    olderMessages = olderMessages.filter((message) => message.id !== latestUserMessageId);
    recentMessages = [...recentMessages, latestUserMessage]
      .sort((left, right) => (messageIndexes.get(left.id) ?? 0) - (messageIndexes.get(right.id) ?? 0));
  }

  const summaryLines = buildRoomSummaryBlock(olderMessages, opts).split("\n").filter((line) => line.length > 0);

  const renderTranscript = () => {
    const summary = summaryLines.length > 0 ? summaryLines.join("\n") : "";
    const recent = formatRoomThreadContext(recentMessages, latestUserMessageId);
    if (summary && recent) {
      return `${summary}\n\n${recent}`;
    }
    return summary || recent;
  };

  let transcript = renderTranscript();
  while (transcript.length > ROOM_THREAD_CONTEXT_MAX_CHARS && summaryLines.at(-1)?.startsWith("  - ")) {
    summaryLines.pop();
    transcript = renderTranscript();
  }

  while (transcript.length > ROOM_THREAD_CONTEXT_MAX_CHARS && recentMessages.length > 1) {
    const removableIndex = recentMessages.findIndex((message) => message.id !== latestUserMessageId);
    if (removableIndex === -1) {
      break;
    }
    recentMessages.splice(removableIndex, 1);
    transcript = renderTranscript();
  }

  return transcript;
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function normalizeFailureCode(code: unknown): string | undefined {
  if (typeof code === "string" && code.trim()) {
    return code.trim();
  }
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  return undefined;
}

function buildChatFailureInfo(error: unknown, fallbackSummary = "AI processing failed"): ChatFailureInfo {
  if (typeof error === "string") {
    const summary = error.trim() || fallbackSummary;
    return { summary };
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const summary = typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : fallbackSummary;
    const detail = typeof record.stack === "string" && record.stack.trim() && record.stack.trim() !== summary
      ? record.stack.trim()
      : undefined;
    return {
      summary,
      ...(typeof record.name === "string" && record.name.trim() && record.name.trim() !== "Error"
        ? { errorClass: record.name.trim() }
        : {}),
      ...(normalizeFailureCode(record.code) ? { code: normalizeFailureCode(record.code) } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  return { summary: fallbackSummary };
}

function addModelContextToFailureInfo(
  failureInfo: ChatFailureInfo,
  provider: string | undefined,
  modelId: string | undefined,
): ChatFailureInfo {
  if (!provider || !modelId) {
    return failureInfo;
  }
  const modelRef = `${provider}/${modelId}`;
  if (failureInfo.summary.includes(modelRef) || failureInfo.summary.includes(modelId)) {
    return failureInfo;
  }
  /*
   * FNXC:ChatModels 2026-07-01-16:42:
   * No-fallback chat failures for explicit model picks must name the selected provider/model. Anthropic Sonnet 5 can return a structured 404 `not_found_error` whose payload says only "Not found"; without this context the dashboard shows an unhelpful generic failure while hiding which model selection needs operator action.
   */
  return {
    ...failureInfo,
    summary: `Model ${modelRef} response failed: ${failureInfo.summary}`,
    ...(failureInfo.detail && !failureInfo.detail.includes(modelRef) && !failureInfo.detail.includes(modelId)
      ? { detail: `Selected model: ${modelRef}\n${failureInfo.detail}` }
      : {}),
  };
}

function persistFailureMessage(
  chatStore: ChatStore,
  sessionId: string,
  failureInfo: ChatFailureInfo,
  metadata?: Record<string, unknown>,
) {
  return chatStore.addMessage(sessionId, {
    role: "assistant",
    content: failureInfo.summary,
    metadata: {
      failureInfo,
      ...(metadata ?? {}),
    },
  });
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatFailureReference {
  kind: string;
  id: string;
  label?: string;
}

export interface ChatFailureInfo {
  summary: string;
  errorClass?: string;
  code?: string;
  detail?: string;
  reference?: ChatFailureReference;
}

/** SSE event types for chat streaming */
export type ChatStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "text"; data: string }
  | { type: "tool_start"; data: { toolName: string; args?: Record<string, unknown> } }
  | { type: "tool_end"; data: { toolName: string; isError: boolean; result?: unknown } }
  | { type: "fallback"; data: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" } }
  | {
      type: "done";
      data: {
        messageId: string;
        message?: {
          id: string;
          sessionId: string;
          role: "assistant";
          content: string;
          thinkingOutput: string | null;
          metadata: Record<string, unknown> | null;
          attachments?: ChatAttachment[];
          createdAt: string;
        };
        attachments?: ChatAttachment[];
      };
    }
  | { type: "error"; data: string | ChatFailureInfo };

/** Callback function for streaming events */
export type ChatStreamCallback = (event: ChatStreamEvent, eventId?: number) => void;

/** Per-subscription record. `generationId` (if set) filters which broadcasts are delivered. */
interface ChatStreamSubscription {
  callback: ChatStreamCallback;
  generationId?: number;
}

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

/** Rate limiting state indexed by IP */
const rateLimits = new Map<string, RateLimitEntry>();

// ── File Reference Resolution ───────────────────────────────────────────────

/**
 * Validate that a resolved path stays within the base directory.
 * Prevents path traversal attacks (e.g., ../../../etc/passwd).
 * Mirrors the logic from file-service.ts validatePath().
 */
function validateFilePath(basePath: string, filePath: string): string {
  // Reject paths with null bytes
  if (filePath.includes("\0")) {
    throw new Error(`Access denied: Invalid characters in path`);
  }

  // Decode URL-encoded characters for security check
  const decodedPath = decodeURIComponent(filePath);

  // Reject absolute paths
  if (decodedPath.startsWith("/") || decodedPath.match(/^[a-zA-Z]:/)) {
    throw new Error(`Access denied: Absolute paths not allowed`);
  }

  // Resolve the path against base path
  const resolvedBase = resolve(basePath);
  const resolvedPath = resolve(join(resolvedBase, decodedPath));

  // Ensure the resolved path is within the base path
  const relativePath = relative(resolvedBase, resolvedPath);

  if (relativePath.startsWith("..") || relativePath.startsWith("../") || relativePath === "..") {
    throw new Error(`Access denied: Path traversal detected`);
  }

  // Additional check: ensure resolved path actually starts with base
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error(`Access denied: Path outside allowed directory`);
  }

  return resolvedPath;
}

/**
 * Resolve #file references from a message and inject their contents.
 *
 * Parses #path/to/file.ext patterns and reads matching file contents.
 * Files larger than MAX_REFERENCED_FILE_SIZE are skipped.
 * Invalid paths (traversal attempts) are silently skipped.
 *
 * @param content - The user message content
 * @param rootDir - The project root directory
 * @returns The content with file context blocks appended
 */
export async function resolveFileReferences(content: string, rootDir: string): Promise<string> {
  // Regex to match #path/to/file.ext patterns (files must have an extension)
  const fileMentionRegex = /#([a-zA-Z0-9._\-/]+\.[a-zA-Z0-9]+)/g;

  // Find all unique file mentions
  const matches = Array.from(content.matchAll(fileMentionRegex), (match) => match[1] ?? "");
  const uniquePaths = [...new Set(matches)];

  if (uniquePaths.length === 0) {
    return content;
  }

  const resolvedFiles: Array<{ path: string; content: string }> = [];
  const fsPromises = await import("node:fs/promises");

  for (const filePath of uniquePaths) {
    try {
      const fullPath = validateFilePath(rootDir, filePath);

      // Check file size before reading
      const stats = await fsPromises.stat(fullPath);
      if (!stats.isFile()) {
        continue;
      }
      if (stats.size > MAX_REFERENCED_FILE_SIZE) {
        continue;
      }

      const fileContent = await fsPromises.readFile(fullPath, "utf-8");
      resolvedFiles.push({ path: filePath, content: fileContent });
    } catch {
      // Skip files that don't exist or have invalid paths
      continue;
    }
  }

  if (resolvedFiles.length === 0) {
    return content;
  }

  // Build the augmented content with file context blocks
  const fileContextBlocks = resolvedFiles
    .map((file) => `[Referenced File: ${file.path}]\n${file.content}\n\n[/Referenced File: ${file.path}]`)
    .join("\n\n");

  return `${content}\n\n${fileContextBlocks}`;
}

// ── Chat Stream Manager ─────────────────────────────────────────────────────

/**
 * Manages SSE connections for active chat sessions.
 * Each session can have multiple connected clients receiving streaming updates.
 * Follows the PlanningStreamManager pattern.
 */
export class ChatStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<ChatStreamSubscription>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  /**
   * Register a client callback for a chat session.
   * Returns a function to unsubscribe.
   *
   * If `options.generationId` is provided, this subscriber only receives broadcasts
   * tagged with the same generationId (or untagged broadcasts). This isolates each
   * client SSE connection to events from its own `chatManager.sendMessage` call so
   * that a previous generation's late "Generation cancelled" event cannot leak into
   * a new request that has just subscribed for the same session.
   */
  subscribe(
    sessionId: string,
    callback: ChatStreamCallback,
    options?: { generationId?: number },
  ): () => void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }

    const subscriptions = this.sessions.get(sessionId)!;
    const subscription: ChatStreamSubscription = { callback, generationId: options?.generationId };
    subscriptions.add(subscription);

    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) {
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
   *
   * When `options.generationId` is set, the event is delivered only to subscribers
   * that registered without a generation filter or whose generation matches.
   * Subscribers tied to a different generation will not receive it. Untagged
   * broadcasts (no generationId) reach every subscriber for backward compatibility.
   */
  broadcast(
    sessionId: string,
    event: ChatStreamEvent,
    options?: { generationId?: number },
  ): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventData = typeof serialized === "string" ? serialized : "{}";
    const eventId = this.getBuffer(sessionId).push(event.type, eventData);

    const subscriptions = this.sessions.get(sessionId);
    if (!subscriptions) return eventId;

    const broadcastGenerationId = options?.generationId;

    for (const subscription of subscriptions) {
      if (
        broadcastGenerationId !== undefined &&
        subscription.generationId !== undefined &&
        subscription.generationId !== broadcastGenerationId
      ) {
        continue;
      }
      try {
        subscription.callback(event, eventId);
      } catch (err) {
        diagnostics.error(`Error broadcasting to client for session ${sessionId}:`, err);
      }
    }

    return eventId;
  }

  /**
   * Get buffered events with id > sinceId for the session.
   */
  getBufferedEvents(sessionId: string, sinceId: number): Array<{ id: number; event: string; data: string }> {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getEventsSince(sinceId);
  }

  /**
   * Check if a session has active subscribers.
   */
  hasSubscribers(sessionId: string): boolean {
    const subscriptions = this.sessions.get(sessionId);
    return subscriptions !== undefined && subscriptions.size > 0;
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
  }

  /**
   * Reset all subscriptions and buffers (test helper).
   */
  reset(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.removeAllListeners();
  }
}

/** Singleton instance of the chat stream manager */
export const chatStreamManager = new ChatStreamManager();

// ── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Check if IP can send a new message.
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
  if (entry.count >= MAX_MESSAGES_PER_IP_PER_MINUTE) {
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

// ── Chat Manager ────────────────────────────────────────────────────────────

/**
 * Manages AI agent chat sessions.
 * Creates sessions, sends messages, and streams AI responses via SSE.
 */
export class RoomReplyGenerationError extends Error {
  readonly roomId: string;

  constructor(message: string, roomId: string) {
    super(message);
    this.name = "RoomReplyGenerationError";
    this.roomId = roomId;
  }
}

export class ChatManager {
  private agentStoreReady?: Promise<void>;
  private generationCounter = 0;
  private inFlightPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeGenerations = new Map<string, {
    abortController: AbortController;
    agentResult?: AgentResult;
    generationId: number;
  }>();

  constructor(
    private chatStore: ChatStore,
    private rootDir: string,
    private agentStore?: AgentStore,
    private pluginRunner?: {
      getRuntimeById?(runtimeId: string): unknown;
      createRuntimeContext?(pluginId: string): Promise<unknown>;
      /*
      FNXC:ChatSkills 2026-06-16-19:10:
      Agent chat receives the project plugin runner through this narrow structural type, so expose enabled plugin skill contributions here without requiring dashboard code to depend on the full engine runner class.
      */
      getPluginSkills?(): Array<{ pluginId: string; skill: { name: string; enabled?: boolean } }>;
    },
    private getSettings?: () => Promise<Pick<Settings,
      | "fallbackProvider"
      | "fallbackModelId"
      | "defaultProvider"
      | "defaultModelId"
      | "defaultThinkingLevel"
      | "defaultThinkingLevelOverride"
      | "executionThinkingLevel"
      | "executionGlobalThinkingLevel"
      | "chatRoomRecentVerbatimMessages"
      | "chatRoomCompactionFetchLimit"
      | "chatRoomSummaryMaxChars"
      | "modelPricingOverrides"
    > | undefined> | Pick<Settings,
      | "fallbackProvider"
      | "fallbackModelId"
      | "defaultProvider"
      | "defaultModelId"
      | "defaultThinkingLevel"
      | "defaultThinkingLevelOverride"
      | "executionThinkingLevel"
      | "executionGlobalThinkingLevel"
      | "chatRoomRecentVerbatimMessages"
      | "chatRoomCompactionFetchLimit"
      | "chatRoomSummaryMaxChars"
      | "modelPricingOverrides"
    > | undefined,
    private messageStore?: MessageStore,
    // Scoped task store for the chat's project — enables workflow-authoring
    // tools (fn_workflow_*) and explicit-task document tools. Optional so
    // existing test/construction sites that don't author workflows keep working.
    private taskStore?: TaskStore,
  ) {}

  /**
   * FNXC:ProjectChatRuntime 2026-07-05-18:10:
   * Project chat managers can be created before a project engine finishes booting. Refreshing the plugin runner after construction prevents early requests from permanently binding Hermes/runtime hints to the global fallback runner; callers must only refresh from a confirmed project runner so transient engine unavailability cannot downgrade a scoped manager.
   */
  setPluginRunner(pluginRunner: ChatManager["pluginRunner"] | undefined): void {
    this.pluginRunner = pluginRunner;
  }

  private getPluginRunnerForSkillSelection(): Parameters<typeof buildSessionSkillContextSync>[3] {
    return this.pluginRunner?.getPluginSkills
      ? (this.pluginRunner as unknown as Parameters<typeof buildSessionSkillContextSync>[3])
      : undefined;
  }

  /**
   * Runner for CLI-agent-backed chat sessions (CLI Agent Executor). When a chat
   * session selects a cli-agent executor (`cliExecutorAdapterId`), composer sends
   * are brokered to the live PTY through this runner instead of the model agent
   * loop. Injected post-construction (the runtime is built per-project at boot,
   * after the ChatManager) so the positional ctor stays stable.
   */
  private cliChatRunner?: {
    ensureSession(chatSessionId: string, opts: { projectId: string; worktreePath?: string | null }): Promise<string>;
    send(chatSessionId: string, text: string): Promise<"sent" | "queued">;
    getSessionStats?(chatSessionId: string): ChatSessionStatsLike | Promise<ChatSessionStatsLike | undefined> | undefined;
    getTokenUsageSnapshot?(chatSessionId: string): ({
      tokens?: ChatSessionStatsLike["tokens"];
      modelProvider?: string | null;
      modelId?: string | null;
      messageId?: string | null;
      createdAt?: string | null;
    }) | Promise<{
      tokens?: ChatSessionStatsLike["tokens"];
      modelProvider?: string | null;
      modelId?: string | null;
      messageId?: string | null;
      createdAt?: string | null;
    } | undefined> | undefined;
  };
  /** Project id used when the runner spawns a CLI session for a chat. */
  private cliChatProjectId?: string;

  /** Wire (or clear) the CLI-agent chat runner and its owning project id. */
  setCliChatRunner(
    runner: ChatManager["cliChatRunner"] | undefined,
    projectId?: string,
  ): void {
    this.cliChatRunner = runner;
    this.cliChatProjectId = projectId;
  }

  private queueInFlightGenerationPersist(sessionId: string, snapshot: ChatInFlightGenerationState | null): void {
    const existingTimer = this.inFlightPersistTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.inFlightPersistTimers.delete(sessionId);
      this.chatStore.setInFlightGeneration(sessionId, snapshot);
    }, IN_FLIGHT_PERSIST_DEBOUNCE_MS);
    this.inFlightPersistTimers.set(sessionId, timer);
  }

  private flushInFlightGenerationPersist(sessionId: string, snapshot: ChatInFlightGenerationState | null): void {
    const existingTimer = this.inFlightPersistTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.inFlightPersistTimers.delete(sessionId);
    }
    this.chatStore.setInFlightGeneration(sessionId, snapshot);
  }

  private async getChatModelSettings(): Promise<{
    fallbackProvider?: string;
    fallbackModelId?: string;
    defaultProvider?: string;
    defaultModelId?: string;
    defaultThinkingLevel?: Settings["defaultThinkingLevel"];
    defaultThinkingLevelOverride?: Settings["defaultThinkingLevelOverride"];
    executionThinkingLevel?: Settings["executionThinkingLevel"];
    executionGlobalThinkingLevel?: Settings["executionGlobalThinkingLevel"];
  }> {
    if (!this.getSettings) {
      return {};
    }

    try {
      const settings = await this.getSettings();
      return {
        fallbackProvider: settings?.fallbackProvider ?? undefined,
        fallbackModelId: settings?.fallbackModelId ?? undefined,
        defaultProvider: settings?.defaultProvider ?? undefined,
        defaultModelId: settings?.defaultModelId ?? undefined,
        defaultThinkingLevel: settings?.defaultThinkingLevel ?? undefined,
        defaultThinkingLevelOverride: settings?.defaultThinkingLevelOverride ?? undefined,
        executionThinkingLevel: settings?.executionThinkingLevel ?? undefined,
        executionGlobalThinkingLevel: settings?.executionGlobalThinkingLevel ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.warn(`Failed to load chat fallback settings: ${message}`);
      return {};
    }
  }

  private async getModelPricingOverrides(): Promise<Settings["modelPricingOverrides"] | undefined> {
    if (!this.getSettings) {
      return undefined;
    }
    try {
      const settings = await this.getSettings();
      return settings?.modelPricingOverrides;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.warn(`Failed to load model pricing overrides for chat tools: ${message}`);
      return undefined;
    }
  }

  private async getRoomCompactionSettings(): Promise<{
    recentVerbatim: number;
    fetchLimit: number;
    summaryMaxChars: number;
  }> {
    const defaults = {
      recentVerbatim: DEFAULT_ROOM_THREAD_RECENT_VERBATIM_MESSAGES,
      fetchLimit: DEFAULT_ROOM_THREAD_COMPACTION_FETCH_LIMIT,
      summaryMaxChars: DEFAULT_ROOM_THREAD_SUMMARY_MAX_CHARS,
    };
    if (!this.getSettings) {
      return defaults;
    }

    const sanitize = (value: unknown, fallback: number, min = 1): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value) || value <= 0) {
        return fallback;
      }
      return Math.max(min, Math.floor(value));
    };

    try {
      const settings = await this.getSettings();
      return {
        recentVerbatim: sanitize(settings?.chatRoomRecentVerbatimMessages, defaults.recentVerbatim),
        fetchLimit: sanitize(settings?.chatRoomCompactionFetchLimit, defaults.fetchLimit),
        summaryMaxChars: sanitize(settings?.chatRoomSummaryMaxChars, defaults.summaryMaxChars, 200),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.warn(`Failed to load room compaction settings: ${message}`);
      return defaults;
    }
  }

  private handleFallbackModelUsed(
    sessionId: string,
    generationId: number,
    payload: {
      primaryModel: string;
      fallbackModel: string;
      triggerPoint: "session-creation" | "prompt-time";
    },
  ): void {
    const slashIndex = payload.fallbackModel.indexOf("/");
    if (slashIndex > 0 && slashIndex < payload.fallbackModel.length - 1) {
      this.chatStore.updateSession(sessionId, {
        modelProvider: payload.fallbackModel.slice(0, slashIndex),
        modelId: payload.fallbackModel.slice(slashIndex + 1),
      });
    }

    diagnostics.warn(
      `[fallback] chat ${sessionId} switched from ${payload.primaryModel} to ${payload.fallbackModel} (${payload.triggerPoint})`,
    );
    chatStreamManager.broadcast(sessionId, {
      type: "fallback",
      data: payload,
    }, { generationId });
  }

  /**
   * Allocate a fresh generation slot for a session before subscribing/streaming.
   *
   * Returns a monotonically increasing `generationId` plus an `AbortController` that
   * later steps (the SSE route, `sendMessage`, `cancelGeneration`) use to drive and
   * tear down this specific generation. Any in-flight generation for the same
   * session is pre-emptively aborted; its lingering broadcasts will carry the old
   * generationId, which `ChatStreamManager` filters out for new subscribers.
   *
   * Routes that subscribe to SSE before invoking `sendMessage` should call this
   * first so subscription and broadcast generationIds are tied together.
   */
  beginGeneration(sessionId: string): { generationId: number; abortController: AbortController } {
    // If a previous generation is still tracked (e.g. its browser disconnected
    // mid-stream and its agent loop hasn't reached `finally` yet), abort its
    // controller so it stops issuing further prompts/tool calls that would
    // race against the new generation for the same CLI session file.
    //
    // We deliberately do NOT dispose its agent here — the previous generation
    // owns its own dispose in its `finally`. Calling dispose pre-emptively can
    // yank the underlying CLI process out from under the new generation's
    // freshly-opened SessionManager pointing at the same session file.
    const existing = this.activeGenerations.get(sessionId);
    if (existing) {
      existing.abortController.abort();
    }
    this.generationCounter += 1;
    const generationId = this.generationCounter;
    const abortController = new AbortController();
    this.activeGenerations.set(sessionId, { abortController, generationId });
    return { generationId, abortController };
  }

  /**
   * Resolve the per-chat pi/Claude CLI SessionManager.
   *
   * - If the chat has a recorded session file that still exists on disk,
   *   reopen it so the CLI --resume sees the full prior transcript.
   * - Otherwise, create a fresh file-backed session and persist its path
   *   on the chat row. The path is computed synchronously by SessionManager
   *   on construction, so we can store it before the first prompt() call.
   * - If a recorded path has gone missing (manual cleanup, disk wipe), fall
   *   through to "create" and overwrite the stale pointer.
   *
   * Note: we deliberately use file-backed sessions even though pi's history
   * is also tracked in chat_messages. The file is what the Claude CLI's
   * --resume reads, and its session id is what pi-claude-cli passes as
   * `--session-id`. Pinning both via SessionManager.open is the only way to
   * keep the CLI session stable across user messages.
   */
  private resolveCliSessionManager(session: ChatSession): SessionManager {
    if (session.cliSessionFile && existsSync(session.cliSessionFile)) {
      try {
        return SessionManager.open(session.cliSessionFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          `Failed to reopen chat ${session.id} CLI session at ${session.cliSessionFile} (${message}); starting fresh`,
        );
      }
    }

    const manager = SessionManager.create(this.rootDir);
    const sessionFile = manager.getSessionFile();
    if (sessionFile) {
      try {
        this.chatStore.setCliSessionFile(session.id, sessionFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          `Failed to persist CLI session file for chat ${session.id}: ${message}`,
        );
      }
    }
    return manager;
  }

  private async listAgentsForMentions(): Promise<Agent[]> {
    if (!this.agentStore) {
      return [];
    }

    try {
      this.agentStoreReady ??= this.agentStore.init();
      await this.agentStoreReady;
      return await this.agentStore.listAgents();
    } catch (agentListError) {
      const message = agentListError instanceof Error ? agentListError.message : String(agentListError);
      diagnostics.warn(`Failed to list agents for mention parsing: ${message}`);
      return [];
    }
  }

  private async getAgentById(agentId: string): Promise<Agent | null> {
    if (!this.agentStore) {
      return null;
    }

    try {
      this.agentStoreReady ??= this.agentStore.init();
      await this.agentStoreReady;
      const agent = await this.agentStore.getAgent(agentId);
      return agent ?? null;
    } catch (agentLookupError) {
      const message = agentLookupError instanceof Error ? agentLookupError.message : String(agentLookupError);
      diagnostics.warn(`Failed to resolve room member agent ${agentId}: ${message}`);
      return null;
    }
  }

  /** A parsed @ mention of an agent in a chat message */
  private async parseMentions(content: string, agents?: Agent[]): Promise<ChatMention[]> {
    if (!this.agentStore) {
      return [];
    }

    const candidates = Array.from(content.matchAll(/@([\w-]+)/g), (match) => match[1] ?? "");
    if (candidates.length === 0) {
      return [];
    }

    const availableAgents = agents ?? (await this.listAgentsForMentions());
    if (availableAgents.length === 0) {
      return [];
    }

    const agentsByName = new Map<string, Agent>();
    for (const agent of availableAgents) {
      agentsByName.set(agent.name.toLowerCase(), agent);
    }

    const mentions: ChatMention[] = [];
    const seenAgentIds = new Set<string>();

    for (const candidate of candidates) {
      const normalizedName = candidate.replace(/_/g, " ").toLowerCase();
      const matchedAgent = agentsByName.get(normalizedName);
      if (!matchedAgent || seenAgentIds.has(matchedAgent.id)) {
        continue;
      }

      mentions.push({
        agentId: matchedAgent.id,
        agentName: matchedAgent.name,
      });
      seenAgentIds.add(matchedAgent.id);
    }

    return mentions;
  }

  private async buildMentionContext(mentions: ChatMention[], agents?: Agent[]): Promise<string> {
    if (!this.agentStore || mentions.length === 0) {
      return "";
    }

    const availableAgents = agents ?? (await this.listAgentsForMentions());
    if (availableAgents.length === 0) {
      return "";
    }

    const agentsById = new Map<string, Agent>();
    for (const agent of availableAgents) {
      agentsById.set(agent.id, agent);
    }

    const lines: string[] = [];
    for (const mention of mentions) {
      const matchedAgent = agentsById.get(mention.agentId);
      if (!matchedAgent) {
        continue;
      }

      const taskAssignment = matchedAgent.taskId?.trim() ? matchedAgent.taskId.trim() : "none";
      const soulOrInstructions = (matchedAgent.soul?.trim() || matchedAgent.instructionsText?.trim() || "")
        .replace(/\s+/g, " ");
      const description = soulOrInstructions.length > 200
        ? `${soulOrInstructions.slice(0, 200)}…`
        : soulOrInstructions;

      const base = `- @${mention.agentName.replace(/\s+/g, "_")} (role: ${matchedAgent.role}, currently working on: ${taskAssignment})`;
      lines.push(description ? `${base}: ${description}` : base);
    }

    if (lines.length === 0) {
      return "";
    }

    return [
      "The user mentioned the following agents in their message:",
      ...lines,
    ].join("\n");
  }

  private resolveRoomResponders(
    session: ChatSession,
    mentions: ChatMention[],
    availableAgents: Agent[],
  ): { direct: Agent[]; ambient: Agent[]; nonMemberMentions: ChatMention[] } {
    if (session.kind !== "room" || !session.roomId) {
      return { direct: [], ambient: [], nonMemberMentions: [] };
    }

    const roomMembers = this.chatStore.listRoomMembers(session.roomId);
    const memberIds = new Set(roomMembers.map((member) => member.agentId));
    const agentsById = new Map(availableAgents.map((agent) => [agent.id, agent]));

    const direct: Agent[] = [];
    const seenDirect = new Set<string>();
    const nonMemberMentions: ChatMention[] = [];

    for (const mention of mentions) {
      if (!memberIds.has(mention.agentId)) {
        nonMemberMentions.push(mention);
        continue;
      }
      if (seenDirect.has(mention.agentId)) {
        continue;
      }
      const agent = agentsById.get(mention.agentId);
      if (!agent) {
        continue;
      }
      direct.push(agent);
      seenDirect.add(mention.agentId);
    }

    const ambientCandidates = roomMembers
      .map((member) => agentsById.get(member.agentId))
      .filter((agent): agent is Agent => agent !== undefined)
      .filter((agent) => !seenDirect.has(agent.id));

    const ambient = ambientCandidates.slice(0, ROOM_AMBIENT_MAX_RESPONDERS);
    if (ambientCandidates.length > ROOM_AMBIENT_MAX_RESPONDERS) {
      diagnostics.warn(
        `Room ${session.roomId} ambient responders capped at ${ROOM_AMBIENT_MAX_RESPONDERS} (from ${ambientCandidates.length})`,
      );
    }

    return { direct, ambient, nonMemberMentions };
  }

  /**
   * Create a new chat session.
   */
  createSession(input: ChatSessionCreateInput): ChatSession {
    return this.chatStore.createSession(input);
  }

  async sendRoomMessage(
    roomId: string,
    content: string,
    attachments?: ChatAttachment[],
    modelProvider?: string,
    modelId?: string,
  ) {
    const room = this.chatStore.getRoom(roomId);
    if (!room) {
      throw new Error(`Chat room ${roomId} not found`);
    }

    const trimmedContent = content.trim();
    const hasMentionCandidates = /@[\w-]+/.test(trimmedContent);
    const availableAgents = await this.listAgentsForMentions();
    const availableAgentsById = new Map(availableAgents.map((agent) => [agent.id, agent]));

    for (const member of this.chatStore.listRoomMembers(roomId)) {
      if (availableAgentsById.has(member.agentId)) {
        continue;
      }
      const memberAgent = await this.getAgentById(member.agentId);
      if (!memberAgent) {
        continue;
      }
      availableAgentsById.set(memberAgent.id, memberAgent);
      availableAgents.push(memberAgent);
    }

    const mentions = hasMentionCandidates ? await this.parseMentions(trimmedContent, availableAgents) : [];

    const responderPlan = this.resolveRoomResponders(
      { id: `room-${roomId}`, kind: "room", roomId, agentId: "room", status: "active" } as ChatSession,
      mentions,
      availableAgents,
    );

    const userMessage = this.chatStore.addRoomMessage(roomId, {
      role: "user",
      content: trimmedContent,
      senderAgentId: null,
      mentions: mentions.map((mention) => mention.agentId),
      metadata: responderPlan.nonMemberMentions.length > 0
        ? {
            nonMemberMentions: responderPlan.nonMemberMentions,
          }
        : undefined,
      ...(Array.isArray(attachments) ? { attachments } : {}),
    });

    const roomMembers = this.chatStore.listRoomMembers(roomId);
    const responders = [...responderPlan.direct, ...responderPlan.ambient];
    if (responders.length === 0) {
      if (responderPlan.nonMemberMentions.length > 0) {
        const labels = responderPlan.nonMemberMentions
          .map((mention) => `@${mention.agentName.replace(/\s+/g, "_")}`)
          .join(", ");
        this.chatStore.addRoomMessage(roomId, {
          role: "assistant",
          senderAgentId: null,
          content: `I couldn't route ${labels} because they are not members of this room.`,
        });
      }

      if (roomMembers.length > 0) {
        throw new RoomReplyGenerationError(`No active room responders available for room ${roomId}`, roomId);
      }

      return { userMessage, responders: [] };
    }

    const successfulResponderIds: string[] = [];
    const skippedResponderIds: string[] = [];
    const responderFailures: string[] = [];

    for (const responder of responders) {
      try {
        const response = await this.generateRoomResponderReply({
          roomId,
          roomName: room.name,
          roomProjectId: room.projectId ?? null,
          content: trimmedContent,
          latestUserMessageId: userMessage.id,
          attachments,
          mentions,
          responder,
          modelProvider,
          modelId,
        });

        if (isRoomSkipSentinel(response.content)) {
          skippedResponderIds.push(responder.id);
          continue;
        }

        const assistantMessage = this.chatStore.addRoomMessage(roomId, {
          role: "assistant",
          content: response.content,
          thinkingOutput: response.thinkingOutput,
          metadata: response.metadata,
          senderAgentId: responder.id,
          mentions: mentions.map((mention) => mention.agentId),
        });
        if (response.tokenUsage) {
          this.chatStore.recordTokenUsage({
            sourceKind: "room-chat",
            roomId,
            messageId: assistantMessage.id,
            projectId: room.projectId ?? null,
            agentId: responder.id,
            createdAt: assistantMessage.createdAt,
            ...response.tokenUsage,
          });
        }
        successfulResponderIds.push(responder.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics.error(`Room responder ${responder.id} failed in room ${roomId}: ${reason}`);
        responderFailures.push(`${responder.id}: ${reason}`);
      }
    }

    if (successfulResponderIds.length === 0 && skippedResponderIds.length === 0) {
      throw new RoomReplyGenerationError(
        `Failed to generate room replies for room ${roomId}: ${responderFailures.join("; ")}`,
        roomId,
      );
    }

    if (responderPlan.nonMemberMentions.length > 0) {
      const labels = responderPlan.nonMemberMentions
        .map((mention) => `@${mention.agentName.replace(/\s+/g, "_")}`)
        .join(", ");
      this.chatStore.addRoomMessage(roomId, {
        role: "assistant",
        senderAgentId: null,
        content: `Note: ${labels} are not members of this room, so they did not respond.`,
      });
    }

    return {
      userMessage,
      responders: successfulResponderIds,
    };
  }

  private async generateRoomResponderReply(input: {
    roomId: string;
    roomName: string;
    roomProjectId?: string | null;
    content: string;
    latestUserMessageId: string;
    attachments?: ChatAttachment[];
    mentions: ChatMention[];
    responder: Agent;
    modelProvider?: string;
    modelId?: string;
  }): Promise<{ content: string; thinkingOutput: string | null; metadata?: Record<string, unknown>; tokenUsage?: ChatTokenDelta & { modelProvider: string | null; modelId: string | null } }> {
    await ensureEngineReady();

    let systemPrompt = CHAT_SYSTEM_PROMPT;
    if (buildAgentChatPromptFn) {
      try {
        systemPrompt = await buildAgentChatPromptFn({
          agent: input.responder,
          rootDir: this.rootDir,
          agentStore: this.agentStore,
          basePrompt: CHAT_SYSTEM_PROMPT,
          includeProjectMemory: true,
        });
      } catch (error) {
        diagnostics.warn(`Failed to build chat prompt for room responder ${input.responder.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const mentionContext = await this.buildMentionContext(input.mentions);
    if (mentionContext) {
      systemPrompt = `${systemPrompt}\n\n${mentionContext}`;
    }
    systemPrompt = `${systemPrompt}\n\n${CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE}`;

    const roomCompactionSettings = await this.getRoomCompactionSettings();
    const roomMessages = this.chatStore.getRoomMessages(input.roomId, { limit: roomCompactionSettings.fetchLimit });
    const { attachmentContents, imageContents } = await readChatAttachmentContents(
      this.rootDir,
      { kind: "room", roomId: input.roomId },
      input.attachments,
      diagnostics,
    );
    const attachmentContentBlock = formatChatAttachmentContents(attachmentContents);
    const imagePathHints = formatChatImageAttachmentHints(imageContents);
    const parsedSkillCommands = parseSkillCommands(input.content);
    const roomPromptParts = [
      `You are replying as ${input.responder.name} in room #${input.roomName}.`,
      "Reply to the latest user room message in the context of this shared room thread.",
      "Room transcript (oldest to newest, bounded):",
      this.compactRoomThreadContext(roomMessages, input.latestUserMessageId, {
        recentVerbatim: roomCompactionSettings.recentVerbatim,
        summaryMaxChars: roomCompactionSettings.summaryMaxChars,
      }),
      "Latest user message to answer:",
      parsedSkillCommands.strippedContent,
    ];
    if (attachmentContentBlock) {
      roomPromptParts.push(attachmentContentBlock);
    }
    if (imagePathHints) {
      roomPromptParts.push(imagePathHints);
    }
    const roomPrompt = roomPromptParts.join("\n\n");

    const responderRuntimeModel = extractRuntimeModel(input.responder.runtimeConfig);
    const chatModelSettings = await this.getChatModelSettings();
    /*
     * FNXC:GrokCliRouting 2026-07-09-22:10:
     * Room responders with no explicit send-time or responder runtime model still need the configured chat/project default to reach createResolvedAgentSession. Without forwarding a defaultProvider of grok-cli, the no-visible-key auto-derive seam cannot route to the Grok CLI runtime and pi can surface the direct xAI missing-key error.
     */
    const effectiveModelProvider = input.modelProvider ?? responderRuntimeModel.provider ?? chatModelSettings.defaultProvider;
    const effectiveModelId = input.modelId ?? responderRuntimeModel.modelId ?? chatModelSettings.defaultModelId;
    /*
     * FNXC:ChatModels 2026-07-01-16:42:
     * Room responders should pass configured fallback models even when the room send chose an explicit model. The engine still swaps only for retryable provider/model-selection failures, so an unavailable Sonnet 5 can recover without making ordinary prompt errors ambiguous.
     */
    const allowFallback = true;
    let roomFallbackInfo: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" } | undefined;

    const roomSkillContext = buildSessionSkillContextSync(
      input.responder,
      "heartbeat",
      this.rootDir,
      this.getPluginRunnerForSkillSelection(),
    );
    const mergedRoomSkillSelection = mergeTypedSkillCommands(
      roomSkillContext.skillSelectionContext,
      parsedSkillCommands.requestedSkillNames,
      this.rootDir,
      "heartbeat",
    );

    const workflowTools = createChatWorkflowAuthoringTools(this.taskStore, input.roomProjectId);

    const resolvedSession = await createResolvedAgentSession({
      sessionPurpose: "heartbeat",
      pluginRunner: this.pluginRunner,
      runtimeHint: extractRuntimeHint(input.responder.runtimeConfig),
      /*
      FNXC:ChatSkills 2026-06-16-19:13:
      Chat-room responder sessions must request the responder agent skills plus enabled plugin skills so chat-only agent replies can use skills such as ce-debug just like heartbeat/executor lanes.

      FNXC:ChatSkills 2026-06-17-18:16:
      Room responders share the chat slash-command contract: `/skill:{name}` is removed from the prompt text and merged into heartbeat skill selection without changing persisted room-message text.
      */
      ...(mergedRoomSkillSelection ? { skillSelection: mergedRoomSkillSelection } : {}),
      cwd: this.rootDir,
      systemPrompt,
      tools: "coding",
      ...(workflowTools.length > 0 ? { customTools: workflowTools } : {}),
      ...(effectiveModelProvider && effectiveModelId
        ? {
            defaultProvider: effectiveModelProvider,
            defaultModelId: effectiveModelId,
          }
        : {}),
      ...(allowFallback && chatModelSettings.fallbackProvider && chatModelSettings.fallbackModelId
        ? {
            fallbackProvider: chatModelSettings.fallbackProvider,
            fallbackModelId: chatModelSettings.fallbackModelId,
          }
        : {}),
      onFallbackModelUsed: (payload: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }) => {
        roomFallbackInfo = payload;
        diagnostics.warn(
          `[fallback] room responder ${input.responder.id} switched from ${payload.primaryModel} to ${payload.fallbackModel} (${payload.triggerPoint})`,
        );
      },
    });

    try {
      await enginePromptWithFallback(
        resolvedSession.session,
        roomPrompt,
        imageContents.length > 0 ? { images: imageContents } : undefined,
      );

      type AgentMessage = { role?: string; type?: string; content?: string | Array<{ type?: string; text?: string }> };
      /*
       * FNXC:Chat 2026-07-10-00:00:
       * Plugin CLI runtime sessions (grok/droid/cursor) expose top-level `messages` and stream via `onText` without a pi-shaped `state`, so room responders must read messages null-safely while preserving pi/openclaw state-backed sessions.
       */
      const roomSessionState = resolvedSession.session.state as { messages?: AgentMessage[]; errorMessage?: string } | undefined;
      const roomTopLevelMessages = (resolvedSession.session as { messages?: AgentMessage[] }).messages;
      const messages = roomSessionState?.messages ?? roomTopLevelMessages ?? [];
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" || message.type === "assistant");
      let content = "";
      if (typeof lastAssistant?.content === "string") {
        content = lastAssistant.content;
      } else if (Array.isArray(lastAssistant?.content)) {
        content = lastAssistant.content
          .map((part) => (part?.type === "text" ? part.text ?? "" : ""))
          .join("");
      }

      const stateError = roomSessionState?.errorMessage;
      if (stateError?.trim()) {
        throw new Error(stateError.trim());
      }

      const finalContent = content.trim();
      if (!finalContent) {
        throw new Error("Room responder returned an empty reply");
      }

      const tokenDelta = await readChatSessionTokenDelta(resolvedSession.session);
      const model = modelSnapshotForTokenUsage(resolvedSession.session, roomFallbackInfo);
      return {
        content: finalContent,
        thinkingOutput: null,
        metadata: {
          roomId: input.roomId,
          ...(roomFallbackInfo ? { fallback: roomFallbackInfo } : {}),
        },
        ...(tokenDelta ? { tokenUsage: { ...tokenDelta, modelProvider: model.provider, modelId: model.modelId } } : {}),
      };
    } finally {
      resolvedSession.session.dispose?.();
    }
  }

  /**
   * Preserve the newest room turns verbatim while compacting older history into
   * a deterministic summary block so long-running rooms keep continuity.
   */
  private compactRoomThreadContext(
    messages: RoomTranscriptMessage[],
    latestUserMessageId: string,
    opts?: { recentVerbatim?: number; summaryMaxChars?: number },
  ): string {
    return buildCompactedRoomTranscript(messages, latestUserMessageId, opts);
  }

  /**
   * Send a message and stream AI response via SSE.
   *
   * This method:
   * 1. Validates session exists
   * 2. Persists user message
   * 3. Creates AI agent session
   * 4. Streams thinking/text via chatStreamManager
   * 5. Persists assistant response
   * 6. Broadcasts done/error event
   *
   * @param sessionId - The chat session ID
   * @param content - User message content
   * @param modelProvider - Optional model provider override
   * @param modelId - Optional model ID override
   */
  async sendMessage(
    sessionId: string,
    content: string,
    modelProvider?: string,
    modelId?: string,
    attachments?: ChatAttachment[],
    options?: { generationId?: number },
  ): Promise<void> {
    // The SSE route allocates a generation via `beginGeneration` so it can subscribe
    // with a matching filter before this method runs. Direct callers (tests, internal
    // code) pass nothing and we allocate a generation here.
    const preallocated = options?.generationId !== undefined
      ? this.activeGenerations.get(sessionId)
      : undefined;
    let generationId: number;
    let abortController: AbortController;
    if (preallocated && preallocated.generationId === options?.generationId) {
      generationId = preallocated.generationId;
      abortController = preallocated.abortController;
    } else {
      const allocated = this.beginGeneration(sessionId);
      generationId = allocated.generationId;
      abortController = allocated.abortController;
    }
    const broadcastOptions = { generationId };

    const session = this.chatStore.getSession(sessionId);

    // CLI-agent-backed chat: a session that selected a cli-agent executor brokers
    // its composer sends to the live PTY (via the runner) rather than running the
    // model agent loop. The runner persists the user message + the transcript.
    /*
    FNXC:ChatAttachments 2026-06-16-20:00:
    Attachment content inlining is intentionally limited to model-loop chat sessions. CLI-agent-backed chat sends to a live PTY, so changing it here would alter terminal input semantics instead of using promptWithFallback image/text options.
    */
    if (session?.cliExecutorAdapterId && this.cliChatRunner) {
      const runner = this.cliChatRunner;
      try {
        await runner.ensureSession(sessionId, {
          projectId: this.cliChatProjectId ?? session.projectId ?? "",
        });
        await runner.send(sessionId, content);
        const usageSnapshot = await runner.getTokenUsageSnapshot?.(sessionId);
        const sessionStats = usageSnapshot ?? (await runner.getSessionStats?.(sessionId));
        const tokenDelta = normalizeChatTokenDelta(sessionStats);
        if (tokenDelta) {
          /*
           * FNXC:ChatTokenAccounting 2026-07-02-00:00:
           * CLI-agent-backed chat returns before the dashboard model loop, so read the runner's per-turn telemetry snapshot here and persist it as `cli-chat`. This keeps CLI/pi chat tokens in Command Center while leaving task execution tokenUsage untouched.
           */
          this.chatStore.recordTokenUsage({
            sourceKind: "cli-chat",
            chatSessionId: sessionId,
            messageId: usageSnapshot?.messageId ?? null,
            projectId: session.projectId ?? this.cliChatProjectId ?? null,
            agentId: session.agentId ?? null,
            modelProvider: usageSnapshot?.modelProvider ?? null,
            modelId: usageSnapshot?.modelId ?? session.modelId ?? null,
            createdAt: usageSnapshot?.createdAt ?? new Date().toISOString(),
            ...tokenDelta,
          });
        }
      } finally {
        const current = this.activeGenerations.get(sessionId);
        if (current?.generationId === generationId) {
          this.activeGenerations.delete(sessionId);
        }
      }
      return;
    }

    let agentResult: AgentResult | undefined;
    let accumulatedThinking = "";
    let accumulatedText = "";
    let lastStreamEventId = 0;
    type ToolCallRecord = {
      toolName: string;
      args?: Record<string, unknown>;
      isError: boolean;
      result?: unknown;
    };
    const toolCallsAccum: ToolCallRecord[] = [];
    const pendingToolStarts = new Map<string, Array<{ toolName: string; args?: Record<string, unknown> }>>();
    let fallbackInfo:
      | { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }
      | undefined;
    let failureContextProvider: string | undefined;
    let failureContextModelId: string | undefined;

    const persistInFlightSnapshot = (): void => {
      const runningToolCalls = [...pendingToolStarts.entries()].flatMap(([toolName, starts]) =>
        starts.map((start) => ({
          toolName,
          args: start.args,
          isError: false,
          result: undefined,
          status: "running" as const,
        })),
      );

      this.queueInFlightGenerationPersist(sessionId, {
        status: "generating",
        streamingText: accumulatedText,
        streamingThinking: accumulatedThinking,
        toolCalls: [
          ...toolCallsAccum.map((toolCall) => ({
            toolName: toolCall.toolName,
            args: toolCall.args,
            isError: toolCall.isError,
            result: toolCall.result,
            status: "completed" as const,
          })),
          ...runningToolCalls,
        ],
        replayFromEventId: lastStreamEventId,
        updatedAt: new Date().toISOString(),
      });
    };

    try {
      // Validate session exists
      if (!session) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: `Chat session ${sessionId} not found`,
        }, broadcastOptions);
        return;
      }

      this.flushInFlightGenerationPersist(sessionId, {
        status: "generating",
        streamingText: "",
        streamingThinking: "",
        toolCalls: [],
        replayFromEventId: 0,
        updatedAt: new Date().toISOString(),
      });

      const parsedSkillCommands = parseSkillCommands(content);

      const hasMentionCandidates = /@[\w-]+/.test(content);
      const mentionAgents = hasMentionCandidates ? await this.listAgentsForMentions() : [];
      const mentions = hasMentionCandidates ? await this.parseMentions(content, mentionAgents) : [];

      // Persist user message
      let persistedUserMessageId: string | undefined;
      try {
        const persistedUserMessage = this.chatStore.addMessage(sessionId, {
          role: "user",
          content,
          metadata: mentions.length > 0 ? { mentions } : undefined,
          attachments,
        });
        persistedUserMessageId = persistedUserMessage.id;
      } catch (err) {
        this.flushInFlightGenerationPersist(sessionId, null);
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: `Failed to save message: ${err instanceof Error ? err.message : "Unknown error"}`,
        }, broadcastOptions);
        return;
      }

      // Use model from session if not overridden (needed for both AI response and title generation)
      const requestedModelProvider = modelProvider ?? session.modelProvider ?? undefined;
      const requestedModelId = modelId ?? session.modelId ?? undefined;
      let effectiveModelProvider = requestedModelProvider;
      let effectiveModelId = requestedModelId;
      failureContextProvider = effectiveModelProvider;
      failureContextModelId = effectiveModelId;
      let hasExplicitAgentRuntimeModel = false;

      const needsTitle = session.title === null || session.title === undefined || session.title.trim() === "";

      // Ensure engine is loaded
      await ensureEngineReady();

      if (!createFnAgent) {
        throw new Error("AI agent not available");
      }

      let systemPrompt = CHAT_SYSTEM_PROMPT;
      let agent: Agent | null = null;

      if (this.agentStore && session.agentId) {
        try {
          this.agentStoreReady ??= this.agentStore.init();
          await this.agentStoreReady;
          agent = await this.agentStore.getAgent(session.agentId);
        } catch (agentLoadError) {
          const message = agentLoadError instanceof Error ? agentLoadError.message : String(agentLoadError);
          diagnostics.warn(`Failed to load agent context for ${session.agentId}: ${message}`);
        }
      }

      if (agent && buildAgentChatPromptFn) {
        try {
          systemPrompt = await buildAgentChatPromptFn({
            agent,
            rootDir: this.rootDir,
            agentStore: this.agentStore,
            basePrompt: CHAT_SYSTEM_PROMPT,
            includeProjectMemory: true,
          });
          systemPrompt = `${systemPrompt}\n\n${CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE}`;
        } catch (promptBuildError) {
          const message = promptBuildError instanceof Error ? promptBuildError.message : String(promptBuildError);
          diagnostics.warn(`Failed to build enriched system prompt for ${agent.id}: ${message}`);
        }
      }
      systemPrompt = `${systemPrompt}\n\n${CHAT_ASK_QUESTION_GUIDANCE}`;

      const taskPlannerChatTaskId = typeof session.agentId === "string" && session.agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX)
        ? session.agentId.slice(TASK_PLANNER_CHAT_AGENT_ID_PREFIX.length).trim()
        : "";
      let taskPlannerTaskColumn = "";
      if (taskPlannerChatTaskId) {
        let taskContext = `Task ID: ${taskPlannerChatTaskId}\n\nContext availability notes:\n- Task store context is not available for this chat manager.`;
        if (this.taskStore) {
          try {
            const context = await buildTaskPlannerChatContext(this.taskStore, taskPlannerChatTaskId);
            taskPlannerTaskColumn = context.snapshot.column ?? "";
            taskContext = context.promptContext;
          } catch (taskLoadError) {
            const message = taskLoadError instanceof Error ? taskLoadError.message : String(taskLoadError);
            taskContext = `Task ID: ${taskPlannerChatTaskId}\n\nContext availability notes:\n- Task context could not be loaded: ${message}`;
            diagnostics.warn(`Failed to load task planner-chat context for ${taskPlannerChatTaskId}: ${message}`);
          }
        }
        /*
        FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
        Task-detail planner Chat sessions use a synthetic task-planner agent id and the planning-model lane. Include compact task state, dependency, comment, step, and recent activity context so the planner can answer status questions; convert only explicit steering intent through the scoped steering tool and use `fn_ask_question` for ambiguous clarification.

        FNXC:TaskDetailChat 2026-06-30-23:59:
        Clear, bounded operator change requests in task-detail Chat are user intent and should become persisted steering comments through the task store's steering path. Ambiguous, conflicting, destructive, broad-scope, or credential/security-sensitive requests must ask a question first so planner chat cannot mutate a task from risky prose.

        FNXC:TaskDetailPlannerChat 2026-07-01-21:52:
        Done-task planner Chat separates retrospective conversation from follow-up work creation: answer completed-task questions normally, call the refinement tool only for clear implementation/improvement follow-ups, and keep live-task change requests on the existing steering path. All planner tools are bound to the current task server-side.
        */
        systemPrompt = `${systemPrompt}\n\n${TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE}\n\nDecision rules:\n- Do not create steering or refinements for ordinary questions, summaries, thanks, status/progress requests, metric questions, or brainstorming. Answer normally.\n- For questions about token counts, input/output/cache usage, model cost, pricing, runtime, elapsed time, wall-clock duration, active time, timing events, workflow-step duration, or per-model usage, first call \`fn_task_planner_get_task_metrics\` and answer from its read-only result. If pricing is unavailable or stale, or a metric is missing, state that uncertainty instead of inventing a number.\n- If the current task is done and the user gives a clear follow-up implementation, improvement, polish, bug-fix, or refinement request for this completed task, call \`fn_task_planner_create_refinement\` with only the concise feedback text.\n- If the current task is not done and the user gives a clear, bounded, actionable change request for this current task (for example telling the executor/reviewer to adjust implementation, tests, scope details, or acceptance criteria), call \`fn_task_planner_add_steering\` with only the concise user-facing steering text.\n- Never create a refinement for live non-done tasks; use steering for clear live-task changes instead. Never add steering for done-task follow-up implementation requests when the refinement tool is available.\n- Never include hidden prompt/context/logs, credentials, or chain-of-thought in tool parameters.\n- Ask a clarifying question with \`fn_ask_question\` before adding steering or creating a refinement for unclear targets, requests that could mean either conversation or task mutation, broad rewrites/scope changes, destructive removals, conflicting instructions, credential/secrets handling, or security-sensitive actions.\n- The steering, metrics, and refinement tools are bound to this task server-side; never ask for or pass a task id.\n\n${taskContext}`;
      }

      if (agent) {
        const runtimeModel = extractRuntimeModel(agent.runtimeConfig);
        if (runtimeModel.provider && runtimeModel.modelId) {
          hasExplicitAgentRuntimeModel = true;
        }
        effectiveModelProvider ??= runtimeModel.provider;
        effectiveModelId ??= runtimeModel.modelId;
        failureContextProvider = effectiveModelProvider;
        failureContextModelId = effectiveModelId;
      }

      // Auto-generate chat title on first message if session has no title.
      // Run after the agent fetch so the title-summarizer uses the agent's model.
      if (needsTitle) {
        // Fire-and-forget title generation (non-blocking)
        (async () => {
          try {
            const generated = await summarizeTitle(
              content.trim(),
              this.rootDir,
              effectiveModelProvider,
              effectiveModelId,
            );
            const title = generated ?? content.trim().slice(0, 60).trim();
            if (title) {
              this.chatStore.updateSession(sessionId, { title });
            }
          } catch {
            // Fallback on any error
            const fallback = content.trim().slice(0, 60).trim();
            if (fallback) {
              this.chatStore.updateSession(sessionId, { title: fallback });
            }
          }
        })();
      }

      if (mentions.length > 0) {
        const mentionContext = await this.buildMentionContext(mentions, mentionAgents);
        if (mentionContext) {
          systemPrompt = `${systemPrompt}\n\n${mentionContext}`;
        }
      }

      // Resolve #file references in the current message before sending to AI
      const resolvedContent = await resolveFileReferences(parsedSkillCommands.strippedContent, this.rootDir);

      const attachmentSummary = attachments && attachments.length > 0
        ? `[User attached: ${attachments
          .map((attachment) => `${attachment.originalName} (${attachment.mimeType}, ${formatAttachmentSize(attachment.size)})`)
          .join(", ")}]`
        : "";
      const { attachmentContents, imageContents } = await readChatAttachmentContents(
        this.rootDir,
        { kind: "session", sessionId },
        attachments,
        diagnostics,
      );
      const attachmentContentBlock = formatChatAttachmentContents(attachmentContents);
      /*
      FNXC:GrokAcp 2026-07-12-07:30:
      Name/size-only attachmentSummary is not enough for Grok ACP (image ContentBlocks
      are unsupported). Include absolute filesystem paths so the agent can open pixels.
      */
      const imagePathHints = formatChatImageAttachmentHints(imageContents);

      // Send only the new user content. Prior turns are reloaded by the
      // pi/Claude CLI session via SessionManager.open() below — stuffing the
      // transcript back into the user message would balloon the on-disk
      // session every turn (and previously did, see chat-store.ts:setCliSessionFile).
      const promptContent = [attachmentSummary, imagePathHints, attachmentContentBlock, resolvedContent]
        .filter(Boolean)
        .join("\n\n");

      // Per-chat session continuity: the pi SessionManager (and, transitively,
      // the Claude CLI --resume session it owns) is keyed off the chat. On the
      // first user message we create a fresh, file-backed session and persist
      // its path; subsequent messages reopen the same file.
      const sessionManager = this.resolveCliSessionManager(session);

      /*
       * FNXC:ChatMessageEdit 2026-07-07-09:00:
       * Capture the pi SessionManager leaf BEFORE prompt() appends the user turn (and the
       * assistant reply) as children of it. Persisting this parent-leaf id onto the just-saved
       * user message is what lets a later edit rewind losslessly via SessionManager.branch()/
       * resetLeaf() (null when this is the first turn) instead of falling back to a lossy
       * text-only session rebuild. Best-effort: a persistence failure must not block sending.
       */
      const parentLeafId = sessionManager.getLeafId();
      if (persistedUserMessageId) {
        try {
          this.chatStore.updateMessageMetadata(persistedUserMessageId, { piParentLeafId: parentLeafId });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          diagnostics.warn(
            `Failed to record pi parent-leaf id for chat ${sessionId} message ${persistedUserMessageId}: ${message}`,
          );
        }
      }

      const chatModelSettings = await this.getChatModelSettings();
      /*
       * FNXC:GrokCliRouting 2026-07-09-22:10:
       * Model-less Chat/QuickChat sessions must pass the configured default model into the shared engine session helper. This keeps grok-cli defaults on the Grok CLI runtime when Fusion has no visible key instead of bypassing FN-7753/FN-7758 routing by omitting defaultProvider entirely.
       */
      effectiveModelProvider ??= chatModelSettings.defaultProvider;
      effectiveModelId ??= chatModelSettings.defaultModelId;
      failureContextProvider = effectiveModelProvider;
      failureContextModelId = effectiveModelId;
      const usesConfiguredDefaultModel =
        requestedModelProvider === chatModelSettings.defaultProvider
        && requestedModelId === chatModelSettings.defaultModelId
        && !!requestedModelProvider
        && !!requestedModelId;
      /*
       * FNXC:ChatModels 2026-07-01-16:42:
       * Explicit chat model selections still receive the configured fallback for provider/model unavailability. A selected Anthropic Sonnet 5 should not end as a generic Response failed when the engine can safely do its single retryable model swap; permanent-agent runtime models remain authoritative unless the user-selected chat model is the configured default.
       */
      const allowFallback =
        !hasExplicitAgentRuntimeModel
        || usesConfiguredDefaultModel
        || !!(requestedModelProvider && requestedModelId);
      /*
       * FNXC:Chat-ThinkingLevel 2026-07-10-00:00:
       * Model-loop chat sessions apply the per-session thinking level through the engine `defaultThinkingLevel` session option; an empty session value inherits the project/global execution default resolved by resolveExecutorThinkingLevel.
       */
      const effectiveThinkingLevel = resolveExecutorThinkingLevel(session.thinkingLevel ?? undefined, chatModelSettings);

      const messagingTools = agent?.id && this.messageStore
        ? [
            createSendMessageTool(this.messageStore, agent.id),
            createReadMessagesTool(this.messageStore, agent.id),
          ]
        : [];

      const workflowTools = createChatWorkflowAuthoringTools(this.taskStore, session.projectId);

      /*
      FNXC:ChatAgentTools 2026-06-18-06:51:
      The dashboard chat lane has no ambient task, so task-document tools must require explicit `task_id` while keeping the canonical `fn_task_document_write` and `fn_task_document_read` names available to chat agents.
      */
      const documentTools = this.taskStore
        ? createChatTaskDocumentTools(this.taskStore)
        : [];
      const artifactTools = this.taskStore
        ? createChatArtifactTools(this.taskStore, this.messageStore)
        : [];
      const taskPlannerSteeringTools = this.taskStore && taskPlannerChatTaskId
        ? [createTaskPlannerSteeringTool(this.taskStore, taskPlannerChatTaskId)]
        : [];
      /*
      FNXC:TaskPlannerChatMetrics 2026-07-01-20:55:
      Task-detail planner Chat needs a read-only, task-scoped metrics tool so token, cost, and timing answers come from persisted task fields. Register it only for synthetic task-planner:<taskId> sessions and bind the task id server-side so normal Chat, room Chat, and arbitrary task lookup stay out of scope.
      */
      const taskPlannerMetricsTools = this.taskStore && taskPlannerChatTaskId
        ? [createTaskPlannerMetricsTool(this.taskStore, taskPlannerChatTaskId, () => this.getModelPricingOverrides())]
        : [];
      /*
      FNXC:TaskDetailPlannerChat 2026-07-01-21:44:
      Done-task planner Chat uses a separate task-scoped refinement tool rather than Activity steering. The tool is registered only for synthetic task-planner sessions whose server-loaded current task is done, accepts only feedback text, and calls TaskStore.refineTask with the bound source id so models cannot route refinements to arbitrary tasks/projects/workflows.
      */
      const taskPlannerRefinementTools = this.taskStore && taskPlannerChatTaskId && taskPlannerTaskColumn === "done"
        ? [createTaskPlannerRefinementTool(this.taskStore, taskPlannerChatTaskId)]
        : [];

      const customTools = [createAskQuestionTool(), ...taskPlannerSteeringTools, ...taskPlannerMetricsTools, ...taskPlannerRefinementTools, ...messagingTools, ...workflowTools, ...documentTools, ...artifactTools];

      const sessionOptions = {
        cwd: this.rootDir,
        systemPrompt,
        tools: "coding" as const,
        ...(customTools.length > 0 ? { customTools } : {}),
        sessionManager,
        ...(effectiveModelProvider && effectiveModelId
          ? {
              defaultProvider: effectiveModelProvider,
              defaultModelId: effectiveModelId,
            }
          : {}),
        ...(effectiveThinkingLevel ? { defaultThinkingLevel: effectiveThinkingLevel } : {}),
        ...(allowFallback && chatModelSettings.fallbackProvider && chatModelSettings.fallbackModelId
          ? {
              fallbackProvider: chatModelSettings.fallbackProvider,
              fallbackModelId: chatModelSettings.fallbackModelId,
            }
          : {}),
        onFallbackModelUsed: (payload: {
          primaryModel: string;
          fallbackModel: string;
          triggerPoint: "session-creation" | "prompt-time";
        }) => {
          fallbackInfo = payload;
          this.handleFallbackModelUsed(sessionId, generationId, payload);
        },
        onThinking: (delta: string) => {
          accumulatedThinking += delta;
          lastStreamEventId = chatStreamManager.broadcast(sessionId, {
            type: "thinking",
            data: delta,
          }, broadcastOptions);
          persistInFlightSnapshot();
        },
        onText: (delta: string) => {
          accumulatedText += delta;
          lastStreamEventId = chatStreamManager.broadcast(sessionId, {
            type: "text",
            data: delta,
          }, broadcastOptions);
          persistInFlightSnapshot();
        },
        onToolStart: (name: string, args?: Record<string, unknown>) => {
          const pendingForTool = pendingToolStarts.get(name) ?? [];
          pendingForTool.push({ toolName: name, args });
          pendingToolStarts.set(name, pendingForTool);

          lastStreamEventId = chatStreamManager.broadcast(sessionId, {
            type: "tool_start",
            data: { toolName: name, args },
          }, broadcastOptions);
          persistInFlightSnapshot();
        },
        onToolEnd: (name: string, isError: boolean, result?: unknown) => {
          const pendingForTool = pendingToolStarts.get(name);
          const pendingStart = pendingForTool?.pop();
          if (pendingForTool && pendingForTool.length === 0) {
            pendingToolStarts.delete(name);
          }

          toolCallsAccum.push({
            toolName: name,
            args: pendingStart?.args,
            isError,
            result,
          });

          lastStreamEventId = chatStreamManager.broadcast(sessionId, {
            type: "tool_end",
            data: { toolName: name, isError, result },
          }, broadcastOptions);
          persistInFlightSnapshot();
        },
      };

      // Single agent-creation path for both regular chat and QuickChat. When
      // the chat is bound to an agent that declares a runtime hint we pass it
      // through; when there's no agent (e.g. QuickChat's model-only mode) or
      // no hint, `createResolvedAgentSession` falls back to the default
      // runtime via `resolveRuntime`. This avoids the previous divergence
      // where QuickChat went through `createFnAgent` and hit pi-ai's shared
      // `cleanupSessionResources(sessionId)` tear-down across overlapping
      // sessions opened from the same CLI session file.
      const agentRuntimeHint = agent ? extractRuntimeHint(agent.runtimeConfig) : undefined;
      const chatSkillContext = buildSessionSkillContextSync(
        agent ?? null,
        "executor",
        this.rootDir,
        this.getPluginRunnerForSkillSelection(),
      );
      const mergedChatSkillSelection = mergeTypedSkillCommands(
        chatSkillContext.skillSelectionContext,
        parsedSkillCommands.requestedSkillNames,
        this.rootDir,
        "executor",
      );
      agentResult = await createResolvedAgentSession({
        sessionPurpose: "executor",
        ...(agentRuntimeHint ? { runtimeHint: agentRuntimeHint } : {}),
        pluginRunner: this.pluginRunner,
        /*
        FNXC:ChatSkills 2026-06-16-19:13:
        Regular chat and QuickChat must request bound-agent skills plus enabled plugin skills so dashboard chat loads capabilities such as ce-debug instead of creating skill-less sessions.
        */
        ...(mergedChatSkillSelection ? { skillSelection: mergedChatSkillSelection } : {}),
        // FNXC:McpConfig 2026-06-25-22:36: Dashboard chat/QuickChat reuses the scoped task store when available to resolve trusted MCP servers at session creation without persisting materialized secrets.
        ...(this.taskStore ? { mcpServers: (await resolveMcpServersForStore(this.taskStore, { agentId: agent?.id })).servers } : {}),
        ...sessionOptions,
      });
      this.activeGenerations.set(sessionId, { abortController, agentResult, generationId });

      if (abortController.signal.aborted) {
        agentResult.session.dispose?.();
        return;
      }

      // Send user message and get response
      await enginePromptWithFallback(
        agentResult.session,
        promptContent,
        imageContents.length > 0 ? { images: imageContents } : undefined,
      );

      if (abortController.signal.aborted) {
        return;
      }

      interface AgentMessage {
        role: string;
        content?: string | Array<{ type: string; text: string }>;
      }
      /*
       * FNXC:Chat 2026-07-10-00:00:
       * Plugin CLI runtime sessions (grok/droid/cursor) expose top-level `messages` and stream via `onText` without a pi-shaped `state`; keep `state.errorMessage` optional so successful streams do not become TypeErrors, while pi/openclaw/hermes provider errors still surface when set.
       */
      const agentSessionState = agentResult.session.state as { errorMessage?: unknown; messages?: AgentMessage[] } | undefined;
      const sessionErrorMessage = agentSessionState?.errorMessage;
      if (typeof sessionErrorMessage === "string" && sessionErrorMessage.trim().length > 0
          && !accumulatedText && !accumulatedThinking && toolCallsAccum.length === 0) {
        const failureInfo = addModelContextToFailureInfo(
          buildChatFailureInfo(sessionErrorMessage, "Model response failed"),
          effectiveModelProvider,
          effectiveModelId,
        );
        persistFailureMessage(this.chatStore, sessionId, failureInfo);
        this.flushInFlightGenerationPersist(sessionId, null);
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: failureInfo,
        }, broadcastOptions);
        return;
      }

      // Extract response text from agent state
      let responseText = "";
      /*
       * FNXC:Chat 2026-07-10-00:00:
       * Plugin CLI runtimes can omit `state` entirely; use streamed text first, then fall back through state-backed messages and top-level session messages so no-state sessions persist successful replies instead of crashing during extraction.
       */
      const agentMessages = agentSessionState?.messages ?? (agentResult.session as { messages?: AgentMessage[] }).messages ?? [];
      const lastMessage = agentMessages
        .filter((m: AgentMessage) => m.role === "assistant")
        .pop();

      if (lastMessage?.content) {
        if (typeof lastMessage.content === "string") {
          responseText = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
          responseText = lastMessage.content
            .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: string; text: string }) => c.text)
            .join("");
        }
      }

      // Use accumulated text from streaming (most reliable) with extraction fallback
      const finalResponseText = accumulatedText || responseText;

      // Persist assistant message
      const assistantMetadata: Record<string, unknown> = {};
      if (toolCallsAccum.length > 0) {
        assistantMetadata.toolCalls = toolCallsAccum;
      }
      if (fallbackInfo) {
        assistantMetadata.fallback = fallbackInfo;
      }
      const assistantMessage = this.chatStore.addMessage(sessionId, {
        role: "assistant",
        content: finalResponseText,
        thinkingOutput: accumulatedThinking || undefined,
        metadata: Object.keys(assistantMetadata).length > 0 ? assistantMetadata : undefined,
      });

      const tokenDelta = await readChatSessionTokenDelta(agentResult.session);
      if (tokenDelta) {
        const model = modelSnapshotForTokenUsage(agentResult.session, fallbackInfo);
        /*
         * FNXC:ChatTokenAccounting 2026-07-02-00:00:
         * Successful dashboard chat turns persist provider-reported session stats as chat-token rows. Task-detail planner chat uses sourceKind `task-planner-chat` instead of task.tokenUsage so the planner's own model call is visible in Command Center without mutating execution totals for the task it discusses.
         */
        this.chatStore.recordTokenUsage({
          sourceKind: taskPlannerChatTaskId ? "task-planner-chat" : "chat",
          chatSessionId: sessionId,
          messageId: assistantMessage.id,
          projectId: session.projectId ?? null,
          agentId: session.agentId ?? null,
          modelProvider: model.provider,
          modelId: model.modelId,
          createdAt: assistantMessage.createdAt,
          ...tokenDelta,
        });
      }

      this.flushInFlightGenerationPersist(sessionId, null);

      // Broadcast done event with persisted assistant snapshot so clients can
      // render completion even when incremental text deltas were absent.
      chatStreamManager.broadcast(sessionId, {
        type: "done",
        data: {
          messageId: assistantMessage.id,
          message: {
            id: assistantMessage.id,
            sessionId: assistantMessage.sessionId,
            role: "assistant",
            content: assistantMessage.content,
            thinkingOutput: assistantMessage.thinkingOutput,
            metadata: assistantMessage.metadata,
            attachments: assistantMessage.attachments,
            createdAt: assistantMessage.createdAt,
          },
          attachments,
        },
      }, broadcastOptions);
    } catch (err) {
      if (abortController.signal.aborted) {
        this.flushInFlightGenerationPersist(sessionId, null);
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: "Generation cancelled",
        }, broadcastOptions);
        return;
      }

      let failureInfo = buildChatFailureInfo(err, "AI processing failed");
      if (!fallbackInfo) {
        failureInfo = addModelContextToFailureInfo(failureInfo, failureContextProvider, failureContextModelId);
      }
      diagnostics.error(`Error in sendMessage for session ${sessionId}:`, err);

      if (accumulatedText || accumulatedThinking || toolCallsAccum.length > 0) {
        try {
          this.chatStore.addMessage(sessionId, {
            role: "assistant",
            content: accumulatedText || "(response interrupted before text generation)",
            thinkingOutput: accumulatedThinking || undefined,
            metadata: {
              interrupted: true,
              ...(fallbackInfo ? { fallback: fallbackInfo } : {}),
              ...(toolCallsAccum.length > 0 ? { toolCalls: toolCallsAccum } : {}),
            },
          });
        } catch (persistErr) {
          diagnostics.error(`Failed to persist partial response for session ${sessionId}:`, persistErr);
        }
      }

      try {
        persistFailureMessage(this.chatStore, sessionId, failureInfo, fallbackInfo ? { fallback: fallbackInfo } : undefined);
      } catch (persistErr) {
        diagnostics.error(`Failed to persist failure message for session ${sessionId}:`, persistErr);
      }

      this.flushInFlightGenerationPersist(sessionId, null);

      chatStreamManager.broadcast(sessionId, {
        type: "error",
        data: failureInfo,
      }, broadcastOptions);
    } finally {
      // Only clear the active-generation slot if it still belongs to us. If a
      // newer sendMessage pre-empted us via beginGeneration, the slot now holds
      // that newer generation's controller and must not be deleted by us.
      const current = this.activeGenerations.get(sessionId);
      const stillOwnsSlot = current?.generationId === generationId;
      if (stillOwnsSlot) {
        this.activeGenerations.delete(sessionId);
      }

      // Dispose the agent session — but ONLY when we still own the slot.
      //
      // pi-ai's `cleanupSessionResources(sessionId)` fires globally-registered
      // cleanup callbacks keyed by sessionId, and two agents opened from the
      // same CLI session file share that sessionId. If a newer generation has
      // taken over for the same chat session, disposing this (older) agent
      // tears down resources the newer agent is actively using — the model
      // produces no output and the next turn looks like a silent failure.
      //
      // The newer generation will dispose its own agent in its own finally.
      // The older agent's resources are largely garbage-collectible without
      // an explicit dispose; the small leak per pre-empted generation is
      // worth avoiding the cross-generation tear-down.
      if (stillOwnsSlot && agentResult) {
        try {
          agentResult.session.dispose?.();
        } catch (err) {
          diagnostics.error(`Error disposing agent session:`, err);
        }
      }
    }
  }

  cancelGeneration(sessionId: string): boolean {
    const entry = this.activeGenerations.get(sessionId);
    if (!entry) {
      return false;
    }

    entry.abortController.abort();

    if (entry.agentResult) {
      try {
        entry.agentResult.session.dispose?.();
      } catch (err) {
        diagnostics.error(`Error disposing agent session during cancellation:`, err);
      }
    }

    this.flushInFlightGenerationPersist(sessionId, null);

    chatStreamManager.broadcast(sessionId, {
      type: "error",
      data: "Generation cancelled",
    }, { generationId: entry.generationId });

    return true;
  }

  /**
   * Check whether a generation is currently in progress for the given session.
   */
  isGenerating(sessionId: string): boolean {
    return this.activeGenerations.has(sessionId);
  }

  /**
   * Return the active generation ID for a session, if any.
   */
  getActiveGenerationId(sessionId: string): number | undefined {
    return this.activeGenerations.get(sessionId)?.generationId;
  }

  /**
   * Return all session IDs that currently have an active generation.
   * Useful for batch-enriching session lists without N+1 lookups.
   */
  getGeneratingSessionIds(): string[] {
    return [...this.activeGenerations.keys()];
  }

  /**
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Rewind a direct (model-loop) chat session so an edit to an earlier user message resumes
   * the conversation from that point with everything after it — the edited turn included —
   * forgotten. This is a two-part invariant: (1) the persisted `chat_messages` rows are
   * truncated via `ChatStore.deleteMessagesFrom`, and (2) the pi SessionManager leaf is rewound
   * so `buildSessionContext()` no longer includes the discarded turns, otherwise the model would
   * still "remember" content that the UI claims was forgotten. Regeneration is NOT triggered
   * here — callers resend the edited content through the existing streaming `sendMessage` path.
   */
  async rewindSessionForEdit(sessionId: string, fromMessageId: string): Promise<{ retained: ChatMessage[] }> {
    const session = this.chatStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} not found`);
    }

    const target = this.chatStore.getMessage(fromMessageId);
    if (!target || target.sessionId !== sessionId) {
      throw new Error(`Message ${fromMessageId} not found in session ${sessionId}`);
    }
    if (target.role !== "user") {
      throw new Error(`Message ${fromMessageId} is not a user message and cannot be edited`);
    }

    // Guard against racing a live stream: rewinding mid-generation would pull the pi session
    // leaf out from under the in-flight prompt() call.
    if (this.activeGenerations.has(sessionId)) {
      throw new Error(`Cannot edit message ${fromMessageId}: a generation is currently in progress for session ${sessionId}`);
    }

    const parentLeafId = (target.metadata as { piParentLeafId?: string | null } | null)?.piParentLeafId;
    const hasRecordedParentLeaf = target.metadata != null && Object.prototype.hasOwnProperty.call(target.metadata, "piParentLeafId");

    const { retained } = this.chatStore.deleteMessagesFrom(sessionId, fromMessageId);

    if (hasRecordedParentLeaf) {
      /*
       * Primary path. `SessionManager.branch()`/`resetLeaf()` only mutate the calling
       * instance's IN-MEMORY leaf pointer — nothing is written to disk, and a fresh
       * `SessionManager.open()` on the next turn recomputes the leaf from the file itself, which
       * would silently undo the rewind. Persisting the truncation therefore requires materializing
       * a NEW session file: `createBranchedSession(leafId)` writes a file containing only the
       * root→leafId path, which we then adopt as the chat's `cliSessionFile`. The abandoned turns
       * remain physically present in the OLD file (never mutated) but are no longer reachable from
       * the new file, so `buildSessionContext()` on the next open cannot include them.
       */
      try {
        const sessionManager = this.resolveCliSessionManager(session);
        if (parentLeafId) {
          const branchedFile = sessionManager.createBranchedSession(parentLeafId);
          if (!branchedFile) {
            throw new Error("createBranchedSession returned no file (non-persisting session)");
          }
          this.chatStore.setCliSessionFile(sessionId, branchedFile);
        } else {
          // First-turn edit: nothing precedes the edited message, so there is no path to
          // branch from. A brand-new empty session is the correct "forget everything" state.
          const fresh = SessionManager.create(this.rootDir);
          this.chatStore.setCliSessionFile(sessionId, fresh.getSessionFile() ?? null);
        }
        return { retained };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          `Failed to branch pi session for chat ${sessionId} at leaf ${String(parentLeafId)} (${message}); rebuilding session from retained history`,
        );
      }
    }

    // Fallback path: legacy sessions with no recorded parent-leaf id (created before this
    // feature shipped), or a failed branch/resetLeaf above. Best-effort: rebuild a fresh
    // session containing only the retained (pre-edit) turns as text-only messages — tool-call
    // and thinking fidelity is a documented limitation of this path. On ANY failure, fall back
    // further to a clean, empty session rather than risk leaving the model able to recall a
    // turn the UI says was discarded.
    try {
      const rebuilt = SessionManager.create(this.rootDir);
      for (const message of retained) {
        if (message.role === "user") {
          rebuilt.appendMessage({
            role: "user",
            content: message.content,
            timestamp: Date.parse(message.createdAt) || Date.now(),
          });
        } else if (message.role === "assistant") {
          rebuilt.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            api: "chat",
            provider: session.modelProvider ?? "unknown",
            model: session.modelId ?? "unknown",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.parse(message.createdAt) || Date.now(),
          });
        }
      }
      const rebuiltFile = rebuilt.getSessionFile();
      this.chatStore.setCliSessionFile(sessionId, rebuiltFile ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.warn(
        `Failed to rebuild pi session for chat ${sessionId} from retained history (${message}); clearing CLI session file so no discarded turn can be recalled`,
      );
      try {
        this.chatStore.setCliSessionFile(sessionId, null);
      } catch {
        // best-effort; nothing further we can do here
      }
    }

    return { retained };
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Inject a mock createFnAgent function. Used for testing only.
 */
export function __setCreateFnAgent(mock: typeof createFnAgent): void {
  createFnAgent = mock;
  // chat.ts now routes both regular chat and QuickChat through
  // `createResolvedAgentSession`, which would normally bypass this mock and
  // hit the real engine. Mirror the same fake into the resolved-session slot
  // so existing test setups that only call `__setCreateFnAgent` continue to
  // work.
  createResolvedAgentSession = (async (options: Parameters<typeof createResolvedAgentSession>[0]) =>
    mock(options)) as typeof createResolvedAgentSession;
}

/**
 * Inject a mock createResolvedAgentSession function. Used for testing only.
 */
export function __setCreateResolvedAgentSession(mock: typeof createResolvedAgentSession): void {
  createResolvedAgentSession = mock;
}

/**
 * Inject a mock buildAgentChatPrompt function. Used for testing only.
 */
export function __setBuildAgentChatPrompt(mock: typeof buildAgentChatPromptFn): void {
  buildAgentChatPromptFn = mock;
}

/**
 * Reset all chat state. Used for testing only.
 */
export function __resetChatState(): void {
  chatStreamManager.reset();
  rateLimits.clear();
  buildAgentChatPromptFn = undefined;
  createFnAgent = engineCreateFnAgent;
  createResolvedAgentSession = engineCreateResolvedAgentSession;

  // Reset diagnostics logger to default
  __setChatDiagnostics(null);
}
