import type { AgentLogEntry, AgentRole, SteeringComment, Task, TaskDetail } from "@fusion/core";
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Loader2, Maximize2, Minimize2, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { addSteeringComment, refineTask } from "../api";
import { useAgentLogs } from "../hooks/useAgentLogs";
import type { ToastType } from "../hooks/useToast";
import { getErrorMessage } from "@fusion/core";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import { formatRelativeTimeAgo } from "../utils/relativeTimeAgo";
import { AgentAvatar } from "./AgentAvatar";
import { clampChatInputHeight, resolveChatInputOverflowY } from "../utils/chatInputAutosize";
import { markdownComponents } from "./AgentLogViewer";
import "./TaskChatTab.css";

interface TaskChatTabProps {
  task: Task | TaskDetail;
  projectId?: string;
  active: boolean;
  addToast: (msg: string, type?: ToastType) => void;
  sessionLive?: boolean;
  onTaskUpdated?: (task: Task) => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}

type AgentLogRole = AgentRole | undefined;

type UserChatMessage = Pick<SteeringComment, "id" | "text" | "createdAt"> & { optimistic?: boolean };

type TaskChatTranscriptItem =
  | { kind: "agent"; role: AgentLogRole; label: string; entries: AgentLogEntry[] }
  | { kind: "user"; message: UserChatMessage };

type TaskChatSegment =
  | { kind: "tool"; entries: AgentLogEntry[]; startIndex: number }
  | { kind: "thinking"; entries: AgentLogEntry[]; startIndex: number }
  | { kind: "text"; entries: AgentLogEntry[]; startIndex: number };

type TaskChatToolGroupRow =
  | { kind: "invocation"; call: AgentLogEntry; completion?: AgentLogEntry; callIndex: number; completionIndex?: number }
  | { kind: "entry"; entry: AgentLogEntry; index: number };

const STEERING_BLOCKED_STATUSES = new Set([
  "paused",
  "awaiting-user-input",
  "awaiting-cli-approval",
  "awaiting-user-review",
  "awaiting-approval",
  "awaiting-integration",
  "failed",
  "needs-replan",
]);
const REVIEW_STEERABLE_STATUSES = new Set(["reviewing", "merging", "merging-fix", "fixing"]);
// The scheduler's waiting/blocked marker for a not-yet-dispatched task
// (self-healing.ts documents `status: "queued"` as the blocked marker). A queued
// in-progress row has no agent executing yet, so it stays assignment-gated rather
// than counting as an implied active session.
const SCHEDULER_WAITING_STATUS = "queued";
const BOTTOM_FOLLOW_THRESHOLD = 48;
const TOP_LOAD_THRESHOLD = 48;

function isTranscriptNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_THRESHOLD;
}

function getRoleLabel(role: AgentLogRole, t: TFunction<"app">): string {
  switch (role) {
    case "triage":
      return t("taskChat.roles.planner", "Planner");
    case "executor":
      return t("taskChat.roles.executor", "Executor");
    case "reviewer":
      return t("taskChat.roles.reviewer", "Reviewer");
    case "merger":
      return t("taskChat.roles.merger", "Merger");
    default:
      return t("taskChat.roles.agent", "Agent");
  }
}

function getRoleIcon(role: AgentLogRole): string | undefined {
  switch (role) {
    case "triage":
      return "🧭";
    case "executor":
      return "⚙️";
    case "reviewer":
      return "🔎";
    case "merger":
      return "🔀";
    default:
      return undefined;
  }
}

function getEntryKey(entry: AgentLogEntry, index: number): string {
  return [entry.taskId, entry.timestamp, entry.agent ?? "agent", entry.type, index].join(":");
}

function getTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLatestTranscriptTimestampMs(entries: readonly AgentLogEntry[], userMessages: readonly UserChatMessage[]): number {
  return Math.max(
    0,
    ...entries.map((entry) => getTimestampMs(entry.timestamp)),
    ...userMessages.map((message) => getTimestampMs(message.createdAt)),
  );
}

function getUserMessageDedupKey(message: Pick<SteeringComment, "id" | "text" | "createdAt">): string {
  return message.id ? `id:${message.id}` : `fallback:${message.text}:${message.createdAt}`;
}

function getUserMessageFallbackKey(message: Pick<SteeringComment, "text" | "createdAt">): string {
  return `fallback:${message.text}:${message.createdAt}`;
}

function mergeUserMessages(persistedComments: readonly SteeringComment[] | undefined, optimisticMessages: readonly UserChatMessage[]): UserChatMessage[] {
  const messages: UserChatMessage[] = [];
  const seen = new Set<string>();
  const seenFallbacks = new Set<string>();
  const addMessage = (message: UserChatMessage) => {
    const idKey = getUserMessageDedupKey(message);
    const fallbackKey = getUserMessageFallbackKey(message);
    if (seen.has(idKey) || seenFallbacks.has(fallbackKey)) return;
    seen.add(idKey);
    seenFallbacks.add(fallbackKey);
    messages.push(message);
  };

  for (const message of optimisticMessages) {
    addMessage(message);
  }
  for (const comment of persistedComments ?? []) {
    if (comment.author !== "user") continue;
    addMessage({ id: comment.id, text: comment.text, createdAt: comment.createdAt });
  }

  return messages;
}

function buildTranscriptItems(entries: readonly AgentLogEntry[], userMessages: readonly UserChatMessage[], t: TFunction<"app">): TaskChatTranscriptItem[] {
  const orderedItems = [
    ...entries.map((entry, index) => ({ kind: "agent" as const, entry, index, timestamp: getTimestampMs(entry.timestamp) })),
    ...userMessages.map((message, index) => ({ kind: "user" as const, message, index, timestamp: getTimestampMs(message.createdAt) })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.index - b.index || (a.kind === "agent" ? -1 : 1));

  return orderedItems.reduce<TaskChatTranscriptItem[]>((items, item) => {
    if (item.kind === "user") {
      items.push({ kind: "user", message: item.message });
      return items;
    }

    const previousItem = items[items.length - 1];
    const role = item.entry.agent;
    if (previousItem?.kind === "agent" && previousItem.role === role) {
      previousItem.entries.push(item.entry);
      return items;
    }
    items.push({ kind: "agent", role, label: getRoleLabel(role, t), entries: [item.entry] });
    return items;
  }, []);
}

function isActiveAgentSession(task: Task | TaskDetail, opts: { sessionLive?: boolean } = {}): boolean {
  if (task.paused || task.userPaused) return false;
  if (opts.sessionLive) return true;

  if (task.status === SCHEDULER_WAITING_STATUS) return false;

  const hasAssignedAgent = Boolean(task.assignedAgentId || task.checkedOutBy);
  const statusBlocksProgressSteering = task.status ? STEERING_BLOCKED_STATUSES.has(task.status) : false;
  if (statusBlocksProgressSteering) return false;

  const statusAllowsProgressSteering = !statusBlocksProgressSteering;
  const statusAllowsReviewSteering = !task.status || REVIEW_STEERABLE_STATUSES.has(task.status);
  const columnAllowsSteering = (task.column === "triage" && statusAllowsProgressSteering)
    || (task.column === "in-progress" && statusAllowsProgressSteering)
    || (task.column === "in-review" && statusAllowsReviewSteering);
  // FNXC:TaskDetailChat 2026-06-20-20:10:
  // In the default ephemeral-agents mode the scheduler never writes
  // `assignedAgentId`/`checkedOutBy` — those are only set when
  // `ephemeralAgentsEnabled === false` (scheduler.ts). An actively-executing
  // task therefore has no assignment field yet IS being worked, so requiring
  // `hasAssignedAgent` made the chat always show "no agent is working" for
  // default-mode tasks. Treat assignment as sufficient-but-not-necessary:
  // - in-progress with a non-blocked, non-`queued` status is an executing run;
  // - in-review with an active review/merge status (REVIEW_STEERABLE_STATUSES)
  //   has a reviewer/merger running. A null-status in-review row is awaiting
  //   human review, not actively worked, so it stays assignment-gated and idle.
  // FNXC:TaskDetailChat 2026-06-21-13:03:
  // Planning/triage is an execution surface too: triage.ts writes
  // `status: "planning"` only after a planner slot is acquired, while active
  // default-mode planner sessions still omit assignment fields. Treat non-waiting,
  // non-blocked triage rows as active so steering copy does not falsely say no
  // agent is working during spec generation. Keep `queued` and awaiting/failed
  // statuses idle before assignment checks because they are waiting states, not
  // live agent work.
  const executionImpliesActiveAgent =
    (task.column === "triage" && statusAllowsProgressSteering)
    || (task.column === "in-progress" && statusAllowsProgressSteering)
    || (task.column === "in-review" && task.status != null && REVIEW_STEERABLE_STATUSES.has(task.status));
  return columnAllowsSteering
    && (hasAssignedAgent || executionImpliesActiveAgent);
}

function isToolLikeEntry(entry: AgentLogEntry): boolean {
  return entry.type === "tool" || entry.type === "tool_result" || entry.type === "tool_error";
}

function formatEntryLabel(entry: AgentLogEntry, t: TFunction<"app">): string {
  switch (entry.type) {
    case "tool":
      return t("taskChat.toolCall", "Tool call");
    case "tool_result":
      return t("taskChat.toolResult", "Tool result");
    case "tool_error":
      return t("taskChat.toolError", "Tool error");
    case "thinking":
      return t("taskChat.thinking", "Thinking");
    default:
      return t("taskChat.message", "Message");
  }
}

function formatCompletionLabel(entry: AgentLogEntry, t: TFunction<"app">): string {
  return entry.type === "tool_error" ? t("taskChat.error", "Error") : t("taskChat.result", "Result");
}

const TOOL_NAME_SUMMARY_LIMIT = 5;

function formatToolCallCount(count: number, t: TFunction<"app">): string {
  return t("taskChat.toolCallCount", "{{count}} tool call", { count });
}

function getToolInvocationEntries(entries: AgentLogEntry[]): AgentLogEntry[] {
  const callEntries = entries.filter((entry) => entry.type === "tool");
  return callEntries.length > 0 ? callEntries : entries.filter((entry) => isToolLikeEntry(entry));
}

function getToolNameSummary(entries: AgentLogEntry[]): { visibleNames: string[]; overflowCount: number } {
  const invocationEntries = getToolInvocationEntries(entries);
  const names = Array.from(new Set(invocationEntries.map((entry) => entry.text).filter(Boolean)));
  const visibleNames = names.slice(0, TOOL_NAME_SUMMARY_LIMIT);
  return { visibleNames, overflowCount: Math.max(0, names.length - visibleNames.length) };
}

function segmentGroupEntries(entries: AgentLogEntry[]): TaskChatSegment[] {
  const segments: TaskChatSegment[] = [];
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (isToolLikeEntry(entry)) {
      const startIndex = index;
      const toolEntries: AgentLogEntry[] = [];
      while (index < entries.length && isToolLikeEntry(entries[index])) {
        toolEntries.push(entries[index]);
        index += 1;
      }
      segments.push({ kind: "tool", entries: toolEntries, startIndex });
      continue;
    }

    if (entry.type === "thinking") {
      const startIndex = index;
      const thinkingEntries: AgentLogEntry[] = [];
      while (index < entries.length && entries[index].type === "thinking") {
        thinkingEntries.push(entries[index]);
        index += 1;
      }
      segments.push({ kind: "thinking", entries: thinkingEntries, startIndex });
      continue;
    }

    const startIndex = index;
    const textEntries: AgentLogEntry[] = [];
    while (index < entries.length && !isToolLikeEntry(entries[index]) && entries[index].type !== "thinking") {
      textEntries.push(entries[index]);
      index += 1;
    }
    segments.push({ kind: "text", entries: textEntries, startIndex });
  }

  return segments;
}

function TaskChatText({ entries }: { entries: AgentLogEntry[] }) {
  const firstEntry = entries[0];
  if (!firstEntry) return null;

  return (
    <article
      className={`task-chat-entry task-chat-entry--${firstEntry.type.replace("_", "-")}`}
      data-testid={`task-chat-entry-${firstEntry.type}`}
    >
      <div className="markdown-body task-chat-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {entries.map((entry) => entry.text).join("")}
        </ReactMarkdown>
      </div>
    </article>
  );
}

function TaskChatToolEntry({ entry }: { entry: AgentLogEntry }) {
  const { t } = useTranslation("app");

  return (
    <article
      className={`task-chat-tool-entry task-chat-tool-entry--${entry.type.replace("_", "-")}`}
      data-testid={`task-chat-entry-${entry.type}`}
    >
      <div className="task-chat-entry-kicker">{formatEntryLabel(entry, t)}</div>
      <div className="task-chat-entry-text">{entry.text}</div>
      {entry.detail ? <pre className="task-chat-tool-detail">{linkifyFilePaths(entry.detail)}</pre> : null}
    </article>
  );
}

function getToolGroupRows(entries: AgentLogEntry[]): TaskChatToolGroupRow[] {
  const rows: TaskChatToolGroupRow[] = [];
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (entry.type === "tool") {
      const nextEntry = entries[index + 1];
      const hasCompletion = nextEntry?.type === "tool_result" || nextEntry?.type === "tool_error";
      rows.push({
        kind: "invocation",
        call: entry,
        completion: hasCompletion ? nextEntry : undefined,
        callIndex: index,
        completionIndex: hasCompletion ? index + 1 : undefined,
      });
      index += hasCompletion ? 2 : 1;
      continue;
    }

    rows.push({ kind: "entry", entry, index });
    index += 1;
  }

  return rows;
}

function TaskChatToolInvocation({ row }: { row: Extract<TaskChatToolGroupRow, { kind: "invocation" }> }) {
  const { t } = useTranslation("app");
  const completion = row.completion;
  const completionLabel = completion ? formatCompletionLabel(completion, t) : undefined;
  const className = `task-chat-tool-entry task-chat-tool-invocation${completion?.type === "tool_error" ? " task-chat-tool-entry--tool-error" : ""}`;

  return (
    <article className={className} data-testid="task-chat-tool-invocation">
      <div className="task-chat-entry-kicker">
        {completionLabel ? t("taskChat.toolCallTo", "Tool call → {{label}}", { label: completionLabel }) : t("taskChat.toolCall", "Tool call")}
      </div>
      <div className="task-chat-entry-text">{row.call.text}</div>
      {row.call.detail ? (
        <div className="task-chat-tool-detail-block">
          <div className="task-chat-tool-detail-label">{t("taskChat.arguments", "Arguments")}</div>
          <pre className="task-chat-tool-detail">{linkifyFilePaths(row.call.detail)}</pre>
        </div>
      ) : null}
      {completion?.detail ? (
        <div className="task-chat-tool-detail-block">
          <div className="task-chat-tool-detail-label">{completion.type === "tool_error" ? t("taskChat.error", "Error") : t("taskChat.result", "Result")}</div>
          <pre className="task-chat-tool-detail">{linkifyFilePaths(completion.detail)}</pre>
        </div>
      ) : null}
    </article>
  );
}

function TaskChatToolGroup({ entries }: { entries: AgentLogEntry[] }) {
  const { t } = useTranslation("app");
  const invocationEntries = getToolInvocationEntries(entries);
  const invocationCount = invocationEntries.length;
  const errorCount = entries.filter((entry) => entry.type === "tool_error").length;
  const { visibleNames, overflowCount } = getToolNameSummary(entries);
  const rows = getToolGroupRows(entries);

  return (
    <details className="task-chat-tool-group" data-testid="task-chat-tool-group">
      <summary className="task-chat-tool-group-summary">
        <span className="task-chat-tool-group-count">{formatToolCallCount(invocationCount, t)}</span>
        {visibleNames.length > 0 ? (
          <span className="task-chat-tool-group-names" aria-label={t("taskChat.toolNames", "Tool names")}>
            {visibleNames.join(", ")}
            {overflowCount > 0 ? <span className="task-chat-tool-group-overflow">{t("taskChat.moreTools", ", +{{count}} more", { count: overflowCount })}</span> : null}
          </span>
        ) : null}
        {errorCount > 0 ? (
          <span className="task-chat-tool-group-error-count">
            {t("taskChat.errorCount", "{{count}} error", { count: errorCount })}
          </span>
        ) : null}
      </summary>
      <div className="task-chat-tool-group-entries">
        {rows.map((row) => (
          row.kind === "invocation" ? (
            <TaskChatToolInvocation key={getEntryKey(row.call, row.callIndex)} row={row} />
          ) : (
            <TaskChatToolEntry key={getEntryKey(row.entry, row.index)} entry={row.entry} />
          )
        ))}
      </div>
    </details>
  );
}

function TaskChatThinking({ entries }: { entries: AgentLogEntry[] }) {
  const { t } = useTranslation("app");
  const combinedThinkingText = entries.map((entry) => entry.text).join("");

  return (
    <details className="task-chat-thinking" data-testid="task-chat-thinking" open>
      <summary className="task-chat-thinking-summary">{t("taskChat.thinking", "Thinking")}</summary>
      <div className="task-chat-thinking-body">
        <div
          className="markdown-body task-chat-markdown task-chat-thinking-markdown"
          data-testid="task-chat-entry-thinking"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {combinedThinkingText}
          </ReactMarkdown>
        </div>
      </div>
    </details>
  );
}

function TaskChatSegmentView({ segment }: { segment: TaskChatSegment }) {
  if (segment.kind === "tool") {
    return <TaskChatToolGroup entries={segment.entries} />;
  }
  if (segment.kind === "thinking") {
    return <TaskChatThinking entries={segment.entries} />;
  }
  return <TaskChatText entries={segment.entries} />;
}

/*
FNXC:TaskChatTimestamps 2026-06-17-15:43:
FN-6597 requires small relative timestamps on both task-chat agent group headers and user message headers, computed at render time from existing transcript timestamps without adding a live timer.
*/
function TaskChatUserMessage({ message }: { message: UserChatMessage }) {
  const { t } = useTranslation("app");
  const relativeTime = formatRelativeTimeAgo(message.createdAt);

  return (
    <section className="task-chat-user-group" aria-label={t("taskChat.youMessage", "You message")}>
      <div className="task-chat-user-header">
        <div className="task-chat-role-label">{t("taskChat.you", "You")}</div>
        {relativeTime ? (
          <span className="task-chat-timestamp" data-testid="task-chat-user-time">
            {relativeTime}
          </span>
        ) : null}
      </div>
      <article className="task-chat-entry task-chat-entry--user" data-testid="task-chat-entry-user">
        <div className="markdown-body task-chat-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.text}
          </ReactMarkdown>
        </div>
      </article>
    </section>
  );
}

export function TaskChatTab({ task, projectId, active, addToast, sessionLive, onTaskUpdated, expanded = false, onToggleExpanded }: TaskChatTabProps) {
  const { t } = useTranslation("app");
  const { entries, loading, loadMore, hasMore, loadingMore } = useAgentLogs(task.id, active, projectId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<UserChatMessage[]>([]);
  const [isTranscriptAtBottom, setIsTranscriptAtBottom] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const previousEntryCountRef = useRef(0);
  const previousScrollHeightRef = useRef(0);
  const previousFirstEntryKeyRef = useRef<string | null>(null);
  const previousAgentEntryCountRef = useRef(0);
  const pendingPrependScrollHeightRef = useRef<number | null>(null);
  const pendingPrependScrollTopRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  const previousActiveRef = useRef(false);
  const anchorFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const userMessages = useMemo(
    () => mergeUserMessages(task.steeringComments, optimisticMessages),
    [optimisticMessages, task.steeringComments],
  );
  const transcriptItems = useMemo(() => buildTranscriptItems(entries, userMessages, t), [entries, t, userMessages]);
  const transcriptItemCount = entries.length + userMessages.length;
  const firstEntryKey = entries[0] ? getEntryKey(entries[0], 0) : null;
  const activeSession = isActiveAgentSession(task, { sessionLive });
  const isDoneTask = task.column === "done";
  const isIdleSession = !isDoneTask && !activeSession;
  /**
   * FNXC:TaskDetailChat 2026-06-19-22:54:
   * The task-detail chat must never silently accept a question when no agent session will consume it. Keep idle chats sendable, but surface that the message is saved as guidance for the next task run instead of implying a live reply.
   *
   * FNXC:TaskDetailChat 2026-06-22-21:20:
   * The idle "No agent is working on this task right now…" hint is suppressed (empty) per user request — idle chats stay sendable but no longer show the banner. Done/active hints remain. The render gates on a truthy sessionHint, so the empty idle case renders nothing.
   */
  const sessionHint = isDoneTask
    ? t("taskChat.doneSessionHint", "Send a message to start a refinement task for this completed task.")
    : activeSession
      ? t("taskChat.activeSessionHint", "Message the active agent session. Guidance is delivered to the running session in real time.")
      : "";
  const composerPlaceholder = isDoneTask
    ? t("taskChat.donePlaceholder", "Start a refinement task for this completed task")
    : t("taskChat.activePlaceholder", "Steer the currently executing agent");
  const canSend = draft.trim().length > 0 && !sending;

  const resizeComposer = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0";
    const maxHeight = typeof window !== "undefined" && window.matchMedia?.("(max-width: 768px)").matches ? 200 : undefined;
    const nextHeight = clampChatInputHeight(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = resolveChatInputOverflowY(textarea.scrollHeight, maxHeight);
  }, []);

  useLayoutEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  const cancelAnchorTranscriptFrame = useCallback(() => {
    if (anchorFrameRef.current === null) return;
    window.cancelAnimationFrame(anchorFrameRef.current);
    anchorFrameRef.current = null;
  }, []);

  const anchorTranscriptToBottom = useCallback((container: HTMLElement) => {
    cancelAnchorTranscriptFrame();
    if (!container.isConnected) return;

    let frame = 0;
    let stableFrames = 0;
    let lastScrollHeight = -1;
    const maxFrames = 6;

    const writeBottom = () => {
      anchorFrameRef.current = null;
      if (!container.isConnected) return;

      container.scrollTop = container.scrollHeight;
      previousScrollHeightRef.current = container.scrollHeight;
      setIsTranscriptAtBottom(true);
      if (container.scrollHeight === lastScrollHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastScrollHeight = container.scrollHeight;
      }

      frame += 1;
      if (frame >= maxFrames || stableFrames >= 2) {
        return;
      }

      anchorFrameRef.current = window.requestAnimationFrame(writeBottom);
    };

    writeBottom();
  }, [cancelAnchorTranscriptFrame]);

  useLayoutEffect(() => () => {
    cancelAnchorTranscriptFrame();
  }, [cancelAnchorTranscriptFrame]);

  useLayoutEffect(() => {
    const container = transcriptRef.current;
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (!container || !active || transcriptItemCount === 0) return;

    const becameActive = !wasActive;
    const receivedInitialItems = previousEntryCountRef.current === 0;
    if (!becameActive && !receivedInitialItems) return;

    anchorTranscriptToBottom(container);
    previousEntryCountRef.current = transcriptItemCount;
    previousScrollHeightRef.current = container.scrollHeight;

    return () => {
      cancelAnchorTranscriptFrame();
    };
  }, [active, anchorTranscriptToBottom, cancelAnchorTranscriptFrame, transcriptItemCount]);

  useLayoutEffect(() => {
    const container = transcriptRef.current;
    if (!container) return;

    if (!active) {
      previousEntryCountRef.current = transcriptItemCount;
      previousScrollHeightRef.current = container.scrollHeight;
      previousFirstEntryKeyRef.current = firstEntryKey;
      previousAgentEntryCountRef.current = entries.length;
      return;
    }

    if (transcriptItemCount === 0) {
      previousEntryCountRef.current = transcriptItemCount;
      previousScrollHeightRef.current = container.scrollHeight;
      previousFirstEntryKeyRef.current = firstEntryKey;
      previousAgentEntryCountRef.current = entries.length;
      return;
    }

    const previousCount = previousEntryCountRef.current;
    const previousScrollHeight = previousScrollHeightRef.current || container.scrollHeight;
    const previousFirstEntryKey = previousFirstEntryKeyRef.current;
    const previousAgentEntryCount = previousAgentEntryCountRef.current;
    const prependedOlderEntries = Boolean(
      pendingPrependScrollHeightRef.current !== null
        && transcriptItemCount > previousCount
        && entries.length > previousAgentEntryCount
        && firstEntryKey
        && (!previousFirstEntryKey || firstEntryKey !== previousFirstEntryKey),
    );

    if (prependedOlderEntries) {
      /*
       * FNXC:TaskDetailChat 2026-06-16-23:03:
       * Task-detail chat must load older paginated agent history at the top without disturbing the reader's viewport. Treat a changed first agent-log key as a prepend so bottom-follow remains reserved for live appends at the transcript tail.
       */
      const previousTop = pendingPrependScrollTopRef.current;
      const previousHeight = pendingPrependScrollHeightRef.current ?? previousScrollHeight;
      const heightDelta = container.scrollHeight - previousHeight;
      container.scrollTop = previousTop + Math.max(0, heightDelta);
      pendingPrependScrollHeightRef.current = null;
      setIsTranscriptAtBottom(isTranscriptNearBottom(container));
    } else if (transcriptItemCount > previousCount) {
      const shouldFollow = previousCount === 0 || previousScrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_THRESHOLD;
      if (shouldFollow) {
        container.scrollTop = container.scrollHeight;
        setIsTranscriptAtBottom(true);
      } else {
        setIsTranscriptAtBottom(isTranscriptNearBottom(container));
      }
      if (pendingPrependScrollHeightRef.current !== null) {
        pendingPrependScrollHeightRef.current = container.scrollHeight;
        pendingPrependScrollTopRef.current = container.scrollTop;
      }
    } else {
      setIsTranscriptAtBottom(isTranscriptNearBottom(container));
    }

    previousEntryCountRef.current = transcriptItemCount;
    previousScrollHeightRef.current = container.scrollHeight;
    previousFirstEntryKeyRef.current = firstEntryKey;
    previousAgentEntryCountRef.current = entries.length;
  }, [active, entries.length, firstEntryKey, transcriptItemCount]);

  const loadPreviousMessages = useCallback(async () => {
    const container = transcriptRef.current;
    if (!container || !active || !hasMore || loadingMore || loadMoreInFlightRef.current) return;
    pendingPrependScrollHeightRef.current = container.scrollHeight;
    pendingPrependScrollTopRef.current = container.scrollTop;
    loadMoreInFlightRef.current = true;
    try {
      await loadMore();
    } finally {
      loadMoreInFlightRef.current = false;
    }
  }, [active, hasMore, loadMore, loadingMore]);

  const handleTranscriptScroll = useCallback(() => {
    const container = transcriptRef.current;
    if (!container) return;
    previousScrollHeightRef.current = container.scrollHeight;
    setIsTranscriptAtBottom(isTranscriptNearBottom(container));
    if (container.scrollTop <= TOP_LOAD_THRESHOLD) {
      void loadPreviousMessages();
    }
  }, [loadPreviousMessages]);

  const scrollTranscriptToBottom = useCallback(() => {
    const container = transcriptRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    previousScrollHeightRef.current = container.scrollHeight;
    setIsTranscriptAtBottom(true);
  }, []);

  const handleSubmit = useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    const latestTimestampMs = getLatestTranscriptTimestampMs(entries, userMessages);
    const optimisticCreatedAtMs = Math.max(Date.now(), latestTimestampMs + 1);
    /*
    FNXC:TaskDetailChat 2026-06-17-08:12:
    Freshly-sent user steering must appear immediately at the transcript tail below current agent output and keep that display order after persistence reconciliation, so the agent's follow-up thinking or response renders after the user's bubble even when client and server clocks are skewed.
    */
    const optimisticMessage: UserChatMessage = {
      id: `optimistic-${task.id}-${optimisticCreatedAtMs}-${Math.random().toString(36).slice(2)}`,
      text,
      createdAt: new Date(optimisticCreatedAtMs).toISOString(),
      optimistic: true,
    };
    setOptimisticMessages((current) => [...current, optimisticMessage]);
    setSending(true);
    try {
      if (isDoneTask) {
        const newTask = await refineTask(task.id, text, projectId);
        addToast(`Refinement task created: ${newTask.id}`, "success");
      } else {
        const updatedTask = await addSteeringComment(task.id, text, projectId);
        const persistedComment = updatedTask.steeringComments
          ?.filter((comment) => comment.author === "user" && comment.text === text)
          .at(-1);
        if (persistedComment) {
          setOptimisticMessages((current) => current.map((message) => (
            message.id === optimisticMessage.id
              ? { id: persistedComment.id, text: persistedComment.text, createdAt: message.createdAt, optimistic: true }
              : message
          )));
        }
        onTaskUpdated?.(updatedTask);
      }
      setDraft("");
    } catch (error) {
      setOptimisticMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
      addToast(`Unable to send message: ${getErrorMessage(error)}`, "error");
    } finally {
      setSending(false);
    }
  }, [addToast, draft, entries, isDoneTask, onTaskUpdated, projectId, sending, task.id, userMessages]);

  /**
   * FNXC:TaskDetailChat 2026-06-13-19:05:
   * Task-detail chat follows chat composer keyboard expectations: Enter sends, Shift+Enter keeps textarea newline entry, Cmd/Ctrl+Enter remains supported for existing users, and IME composition Enter is ignored so CJK candidate selection is not submitted mid-composition.
   */
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.shiftKey) return;

    event.preventDefault();
    void handleSubmit();
  }, [handleSubmit]);

  return (
    <div className="task-chat-tab" data-testid="task-chat-tab">
      {onToggleExpanded ? (
        <button
          type="button"
          className="btn btn-icon btn-sm task-chat-expand-toggle task-chat-expand-toggle--overlay"
          onClick={onToggleExpanded}
          aria-label={expanded ? t("taskChat.collapseChat", "Collapse chat") : t("taskChat.expandChat", "Expand chat to full modal")}
          aria-pressed={expanded}
          data-testid="task-chat-expand-toggle"
        >
          {/* FNXC:TaskChat 2026-06-13-00:00: FN-6425 refines FN-6405 by keeping the task-chat expand affordance icon-only and pinned to the chat view corner so transcript scrolling never removes access to expansion controls. */}
          {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      ) : null}
      <div
        className="task-chat-transcript"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
        aria-live="polite"
        data-testid="task-chat-transcript"
      >
        {hasMore || loadingMore ? (
          <div className="task-chat-load-previous-row">
            {loadingMore ? (
              <div className="task-chat-load-previous-status" role="status" data-testid="task-chat-load-previous-loading">
                <Loader2 className="animate-spin" aria-hidden="true" />
                <span>{t("taskChat.loadingEarlierMessages", "Loading earlier messages…")}</span>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm task-chat-load-previous"
                onClick={() => { void loadPreviousMessages(); }}
                aria-label={t("taskChat.loadPreviousMessages", "Load previous messages")}
                data-testid="task-chat-load-previous"
              >
                {t("taskChat.loadPreviousMessages", "Load previous messages")}
              </button>
            )}
          </div>
        ) : null}
        {loading && transcriptItemCount === 0 ? (
          <div className="task-chat-empty" role="status">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span>{t("taskChat.loadingAgentOutput", "Loading agent output…")}</span>
          </div>
        ) : transcriptItemCount === 0 ? (
          <div className="task-chat-empty">{t("taskChat.emptyAgentOutput", "No agent output yet. Live messages from Planner, Executor, Reviewer, and Merger agents will appear here.")}</div>
        ) : (
          transcriptItems.map((item, itemIndex) => {
            if (item.kind === "user") {
              return <TaskChatUserMessage key={`user-${item.message.id}-${itemIndex}`} message={item.message} />;
            }

            const avatarAgent = {
              id: item.role ?? "agent",
              name: item.label,
              icon: getRoleIcon(item.role),
            };
            const segments = segmentGroupEntries(item.entries);
            const latestEntryTimestamp = item.entries[item.entries.length - 1]?.timestamp ?? "";
            const relativeTime = formatRelativeTimeAgo(latestEntryTimestamp);
            return (
              <section className="task-chat-group" key={`${item.role ?? "agent"}-${itemIndex}`} aria-label={t("taskChat.agentMessages", "{{label}} messages", { label: item.label })}>
                <header className="task-chat-group-header">
                  <AgentAvatar agent={avatarAgent} className="task-chat-avatar" />
                  <div>
                    <div className="task-chat-role-label">{item.label}</div>
                    <div className="task-chat-group-meta">
                      <span>{t("taskChat.entryCount", "{{count}} entry", { count: item.entries.length })}</span>
                      {relativeTime ? (
                        <span className="task-chat-timestamp" data-testid="task-chat-group-time">
                          {relativeTime}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </header>
                <div className="task-chat-group-bubbles">
                  {segments.map((segment) => {
                    const segmentKey = `${segment.kind}-${segment.startIndex}-${segment.entries.length}`;
                    return <TaskChatSegmentView key={segmentKey} segment={segment} />;
                  })}
                </div>
              </section>
            );
          })
        )}
        {transcriptItemCount > 0 && !isTranscriptAtBottom ? (
          <button
            type="button"
            className="task-chat-jump-to-bottom"
            onClick={scrollTranscriptToBottom}
            aria-label={t("taskChat.jumpToLatestMessage", "Jump to latest message")}
            data-testid="task-chat-jump-to-bottom"
          >
            <ChevronDown aria-hidden="true" />
            <span>{t("taskChat.latest", "Latest")}</span>
          </button>
        ) : null}
      </div>

      <form className="task-chat-composer card" onSubmit={handleSubmit}>
        {sessionHint ? (
          <div
            className={`task-chat-session-hint${isIdleSession ? " task-chat-session-hint--idle" : ""}`}
            role="status"
            data-testid={isIdleSession ? "task-chat-idle-hint" : undefined}
          >
            {sessionHint}
          </div>
        ) : null}
        <div className="task-chat-composer-row">
          <textarea
            ref={textareaRef}
            className="input task-chat-input"
            value={draft}
            placeholder={composerPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            aria-label={t("taskChat.messageActiveAgentSession", "Message active agent session")}
            rows={1}
          />
          <button
            type="submit"
            className="btn btn-primary btn-icon task-chat-send"
            disabled={!canSend}
            aria-label={sending ? t("taskChat.sending", "Sending") : t("common:actions.send", "Send")}
            title={sending ? t("taskChat.sending", "Sending") : t("common:actions.send", "Send")}
          >
            {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          </button>
        </div>
      </form>
    </div>
  );
}
