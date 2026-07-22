import type { AgentLogEntry, AgentRole, SteeringComment, Task, TaskDetail } from "@fusion/core";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Cpu, Loader2, Maximize2, Minimize2, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { addSteeringComment, refineTask } from "../api";
import { useAgentLogs } from "../hooks/useAgentLogs";
import type { ToastType } from "../hooks/useToast";
import { getErrorMessage } from "@fusion/core";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import { formatRelativeTimeAgo } from "../utils/relativeTimeAgo";
import { ProviderIcon } from "./ProviderIcon";
import { clampChatInputHeight, resolveChatInputOverflowY } from "../utils/chatInputAutosize";
import { formatAgentLogTimingLabels, markdownComponents } from "./AgentLogViewer";
import { parseRuntimeModelMarker } from "./effective-model-resolution";
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
  effectiveModels?: Partial<Record<"triage" | "executor" | "reviewer" | "merger", TaskChatModelInfo | null>>;
}

type AgentLogRole = AgentRole | undefined;

type TaskChatModelInfo = {
  provider: string;
  modelId?: string;
};

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

const BOTTOM_FOLLOW_THRESHOLD = 48;
const TOP_LOAD_THRESHOLD = 48;
const INITIAL_LOADING_INDICATOR_DELAY_MS = 150;

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

function parseModelMarker(entry: AgentLogEntry): TaskChatModelInfo | null {
  if (entry.type !== "status" && entry.type !== "text") return null;
  const role = entry.agent === "triage" ? "Planning" : entry.agent === "executor" ? "Executor" : entry.agent === "reviewer" ? "Reviewer" : null;
  if (!role) return null;
  return parseRuntimeModelMarker(entry.text, role);
}

function makeModelInfo(provider: string | undefined, modelId: string | undefined): TaskChatModelInfo | null {
  if (!provider) return null;
  return modelId ? { provider, modelId } : { provider };
}

function getExplicitModelForRole(task: Task | TaskDetail, role: AgentLogRole): TaskChatModelInfo | null {
  if (role === "triage" && task.planningModelProvider) {
    return makeModelInfo(task.planningModelProvider, task.planningModelId);
  }
  if (role === "executor" && task.modelProvider) {
    return makeModelInfo(task.modelProvider, task.modelId);
  }
  if ((role === "reviewer" || role === "merger") && task.validatorModelProvider) {
    return makeModelInfo(task.validatorModelProvider, task.validatorModelId);
  }
  return null;
}

function getRuntimeModelForRole(entries: readonly AgentLogEntry[], role: AgentLogRole): TaskChatModelInfo | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.agent !== role) continue;
    const parsed = parseModelMarker(entry);
    if (parsed) return parsed;
  }
  return null;
}

function getEffectiveModelForRole(
  effectiveModels: TaskChatTabProps["effectiveModels"] | undefined,
  role: AgentLogRole,
): TaskChatModelInfo | null {
  if (!role) return null;
  return effectiveModels?.[role] ?? null;
}

function getModelForRole(
  task: Task | TaskDetail,
  role: AgentLogRole,
  entries: readonly AgentLogEntry[],
  effectiveModels?: TaskChatTabProps["effectiveModels"],
): TaskChatModelInfo | null {
  /*
  FNXC:TaskDetailChat 2026-07-16-00:00:
  FN-8214: Task-detail chat role icons must identify the model that actually ran. Prefer the runtime "using model" marker, then task-detail effective models, and use the explicit task override only before those values are available. Engine lanes emit markers as `status` and historical logs use `text`, so parseModelMarker accepts both. Merger has no marker and continues through its effective validator lane or explicit validator fallback.

  FNXC:TaskDetailChat 2026-06-23-00:54:
  Default executor models such as OpenAI Codex GPT-5.5 can resolve through settings rather than task overrides or log markers. Task chat receives the same effective model resolution used by the task-detail model header so role icons match Chat and Agent Log instead of falling back to CPU for default-backed agents.
  */
  return getRuntimeModelForRole(entries, role) ?? getEffectiveModelForRole(effectiveModels, role) ?? getExplicitModelForRole(task, role);
}

function TaskChatAgentIcon({ label, modelInfo }: { label: string; modelInfo: TaskChatModelInfo | null }) {
  if (modelInfo?.provider) {
    const title = modelInfo.modelId ? `${label}: ${modelInfo.provider}/${modelInfo.modelId}` : `${label}: ${modelInfo.provider}`;
    return (
      <span className="task-chat-provider-icon" title={title} aria-label={title}>
        <ProviderIcon provider={modelInfo.provider} size="md" />
      </span>
    );
  }

  /*
  FNXC:TaskDetailChat 2026-06-23-00:42:
  Task chat role headers should use provider logos whenever the role's model provider is known, and a neutral CPU fallback when it is not. Avoid role clip-art avatars so executor/reviewer/merger rows read as professional model execution blocks rather than cartoon agent identities.
  */
  const title = `${label}: model provider unknown`;
  return (
    <span className="task-chat-provider-icon task-chat-provider-icon--fallback" title={title} aria-label={title}>
      <Cpu size={18} aria-hidden="true" />
    </span>
  );
}

function getEntryKey(entry: AgentLogEntry, index: number): string {
  return [entry.taskId, entry.timestamp, entry.agent ?? "agent", entry.type, index].join(":");
}

function getTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLatestEntryTimestamp(entries: readonly AgentLogEntry[]): string {
  let latestTimestamp = "";
  let latestTimestampMs = 0;
  for (const entry of entries) {
    const timestampMs = getTimestampMs(entry.timestamp);
    if (timestampMs > latestTimestampMs) {
      latestTimestamp = entry.timestamp;
      latestTimestampMs = timestampMs;
    }
  }
  return latestTimestamp;
}

/*
FNXC:TaskChatTimestamps 2026-06-29-14:37:
Task Detail Chat requires per-block timestamps in addition to existing group and user headers so operators can scan when each text, tool, thinking, or steering block was produced. Reuse the shared relative-time formatter and return null for empty or invalid dates so transcript blocks never render timestamp shells without meaningful time text.
*/
function getRelativeTimestamp(timestamp: string | undefined): string {
  return timestamp ? formatRelativeTimeAgo(timestamp) : "";
}

function TaskChatTimestamp({ timestamp, testId = "task-chat-block-time", label = "Message timestamp" }: { timestamp: string | undefined; testId?: string; label?: string }) {
  const relativeTime = getRelativeTimestamp(timestamp);
  if (!relativeTime) return null;
  return (
    <span className="task-chat-timestamp" data-testid={testId} aria-label={label}>
      {relativeTime}
    </span>
  );
}

function TaskChatTimingLabels({ entry }: { entry: AgentLogEntry }) {
  const { t } = useTranslation("app");
  const labels = formatAgentLogTimingLabels(entry, t as TFunction<"app">);
  if (labels.length === 0) return null;
  return (
    <span className="task-chat-timing-labels" data-testid="task-chat-timing-labels" aria-label={labels.join(", ")}>
      {labels.map((label) => (
        <span key={label} className="task-chat-timing-label">{label}</span>
      ))}
    </span>
  );
}

function TaskChatTimestampMeta({ timestamp, label }: { timestamp: string | undefined; label: string }) {
  if (!getRelativeTimestamp(timestamp)) return null;
  return (
    <div className="task-chat-entry-meta">
      <TaskChatTimestamp timestamp={timestamp} label={label} />
    </div>
  );
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

/*
FNXC:TaskChat 2026-06-22-03:05:
Tool-call group copy intentionally preserves the pre-i18n grammar contract because the test i18n instance interpolates defaults without plural suffix resolution.
Keep plural branches in source for deterministic "1 tool call" / "N tool calls" and use lowercase completion labels only for the inline "Tool call → result/error" kicker; detail headers remain capitalized below.
*/
function formatCompletionLabel(entry: AgentLogEntry, t: TFunction<"app">): string {
  return entry.type === "tool_error" ? t("taskChat.errorInline", "error") : t("taskChat.resultInline", "result");
}

const TOOL_NAME_SUMMARY_LIMIT = 5;

function formatToolCallCount(count: number, t: TFunction<"app">): string {
  return count === 1
    ? t("taskChat.toolCallCount", "{{count}} tool call", { count })
    : t("taskChat.toolCallCountPlural", "{{count}} tool calls", { count });
}

function formatErrorCount(count: number, t: TFunction<"app">): string {
  return count === 1
    ? t("taskChat.errorCount", "{{count}} error", { count })
    : t("taskChat.errorCountPlural", "{{count}} errors", { count });
}

function formatEntryCount(count: number, t: TFunction<"app">): string {
  return count === 1
    ? t("taskChat.entryCount", "{{count}} entry", { count })
    : t("taskChat.entryCountPlural", "{{count}} entries", { count });
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

    /*
    FNXC:TaskChat-StatusEntries 2026-07-15-11:20:
    A `status` row is a COMPLETE engine message, so it gets its own segment and is never merged with a neighbour. Merging is only correct for `text`, whose rows are streamed delta fragments that `TaskChatText` re-glues with `join("")`.

    This is why a provider outage rendered as one run-on string: engine markers were written as `text`, so N standalone messages ("Reviewer using model: x/y" ×14) were glued edge-to-edge under a "14 entries" header. Fixing it with a separator in `TaskChatText` would corrupt legitimate streamed text (the FN-5787/5789/5803 regression lineage) — the split has to happen here, on the type.
    */
    if (entry.type === "status") {
      segments.push({ kind: "text", entries: [entry], startIndex: index });
      index += 1;
      continue;
    }

    const startIndex = index;
    const textEntries: AgentLogEntry[] = [];
    while (
      index < entries.length
      && !isToolLikeEntry(entries[index])
      && entries[index].type !== "thinking"
      && entries[index].type !== "status"
    ) {
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
      {firstEntry.type === "status" && (
        <div className="task-chat-entry-label-row">
          <span className="status-dot status-dot--pending" aria-hidden="true" />
          <span className="task-chat-entry-kicker">Status update</span>
          <TaskChatTimestamp timestamp={getLatestEntryTimestamp(entries)} label="Status update timestamp" />
        </div>
      )}
      {firstEntry.type !== "status" && <TaskChatTimestampMeta timestamp={getLatestEntryTimestamp(entries)} label="Text block timestamp" />}
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
      <div className="task-chat-entry-label-row">
        <span className="task-chat-entry-kicker">{formatEntryLabel(entry, t)}</span>
        <TaskChatTimingLabels entry={entry} />
        <TaskChatTimestamp timestamp={entry.timestamp} label="Tool entry timestamp" />
      </div>
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
      <div className="task-chat-entry-label-row">
        <span className="task-chat-entry-kicker">{completionLabel ? t("taskChat.toolCallTo", "Tool call → {{label}}", { label: completionLabel }) : t("taskChat.toolCall", "Tool call")}</span>
        <TaskChatTimingLabels entry={completion ?? row.call} />
        <TaskChatTimestamp timestamp={completion?.timestamp ?? row.call.timestamp} label="Tool invocation timestamp" />
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
  /*
  FNXC:TaskChat 2026-06-28-00:00:
  FN-7215 requires task-detail tool groups to match regular Chat's quiet transcript treatment: keep historical tool calls collapsed by default while the summary preserves count, deduped names, overflow, and error context for quick scanning.
  */
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
            {formatErrorCount(errorCount, t)}
          </span>
        ) : null}
        <TaskChatTimestamp timestamp={getLatestEntryTimestamp(entries)} label="Tool group timestamp" />
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

/*
 FNXC:Chat-Thinking 2026-07-15-10:33:
 Chat thinking (reasoning) blocks render collapsed by default so the response is scannable without manually closing each block; the summary remains an expand-on-click affordance. (FN-7974)

 FNXC:Chat-Thinking 2026-07-16-18:05:
 FN-8171 keeps the scannable collapsed default for idle task columns, but opens Live Activity thinking for in-progress and in-review tasks so operators can follow active or awaiting-review reasoning at a glance. The expanded block remains user-collapsible.
*/
function TaskChatThinking({ entries, defaultOpen = false }: { entries: AgentLogEntry[]; defaultOpen?: boolean }) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(defaultOpen);
  const combinedThinkingText = entries.map((entry) => entry.text).join("");

  return (
    <details
      className="task-chat-thinking"
      data-testid="task-chat-thinking"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="task-chat-thinking-summary">
        <span>{t("taskChat.thinking", "Thinking")}</span>
        <TaskChatTimestamp timestamp={getLatestEntryTimestamp(entries)} label="Thinking block timestamp" />
      </summary>
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

function TaskChatSegmentView({ segment, defaultOpen }: { segment: TaskChatSegment; defaultOpen?: boolean }) {
  if (segment.kind === "tool") {
    return <TaskChatToolGroup entries={segment.entries} />;
  }
  if (segment.kind === "thinking") {
    return <TaskChatThinking entries={segment.entries} defaultOpen={defaultOpen} />;
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
        <TaskChatTimestampMeta timestamp={message.createdAt} label="User message block timestamp" />
        <div className="markdown-body task-chat-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.text}
          </ReactMarkdown>
        </div>
      </article>
    </section>
  );
}

export function TaskChatTab({ task, projectId, active, addToast, onTaskUpdated, expanded = false, onToggleExpanded, effectiveModels }: TaskChatTabProps) {
  const { t } = useTranslation("app");
  const { entries, loading, loadMore, hasMore, loadingMore } = useAgentLogs(task.id, active, projectId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingIndicatorTaskId, setLoadingIndicatorTaskId] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const [optimisticMessages, setOptimisticMessages] = useState<UserChatMessage[]>([]);
  const [isTranscriptAtBottom, setIsTranscriptAtBottom] = useState(true);
  const isTranscriptAtBottomRef = useRef(true);
  const thinkingDefaultOpen = task.column === "in-progress" || task.column === "in-review";
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
  const isDoneTask = task.column === "done";
  /*
   * FNXC:TaskDetailActivity 2026-06-30-21:51:
   * Activity → Live (legacy `current`) is the operational steering surface for task execution. Keep the top-level planner-model Chat tab separate; Feed and Raw Logs remain read-only Activity segments without this composer.
   *
   * FNXC:TaskDetailActivity 2026-06-30-23:59:
   * Task Activity must keep the operational composer and existing steering/refinement APIs while removing the visible steering-comment guidance label/hint block from task chat. Use non-visible accessible names on the form/textarea/button so the removed copy does not leave a UI shell or dangling aria-describedby reference.
   */
  const composerFormLabel = isDoneTask
    ? t("taskChat.refinementComposerFormLabel", "Task refinement composer")
    : t("taskChat.activityComposerFormLabel", "Task activity composer");
  const composerPlaceholder = isDoneTask
    ? t("taskChat.donePlaceholder", "Start a refinement task for this completed task")
    : t("taskChat.activePlaceholder", "Steer the currently executing agent");
  const canSend = draft.trim().length > 0 && !sending;

  useEffect(() => {
    if (!loading || transcriptItemCount > 0) {
      setLoadingIndicatorTaskId(null);
      return;
    }

    /*
     * FNXC:TaskDetailChat 2026-07-18-12:21:
     * FN-8303 browser tracing showed that omitted-tab Activity → Live briefly paints
     * “Loading agent output…” before its already-populated initial log response arrives.
     * Delay that indicator so a fast default-open keeps the stable transcript shell rather
     * than flashing spinner-to-content; slow requests still receive explicit feedback.
     * Bind the delayed state to its task so a reused List split-detail instance cannot paint
     * a prior task’s slow-request spinner while its newly selected task initializes.
     */
    const timer = window.setTimeout(() => setLoadingIndicatorTaskId(task.id), INITIAL_LOADING_INDICATOR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading, task.id, transcriptItemCount]);

  const showLoadingIndicator = loadingIndicatorTaskId === task.id;

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

  const setTranscriptFollowing = useCallback((following: boolean) => {
    isTranscriptAtBottomRef.current = following;
    setIsTranscriptAtBottom(following);
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
      if (!container.isConnected || !isTranscriptAtBottomRef.current) return;

      container.scrollTop = container.scrollHeight;
      previousScrollHeightRef.current = container.scrollHeight;
      setTranscriptFollowing(true);
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
  }, [cancelAnchorTranscriptFrame, setTranscriptFollowing]);

  useEffect(() => {
    if (!active) return;
    const container = transcriptRef.current;
    if (!container) return;

    /*
    FNXC:TaskDetailChat 2026-07-18-14:09:
    FN-8339 requires live task output to follow its tail only while the reader remains pinned. Streamed text can grow an existing DOM block without changing the entry count, so observe both layout and DOM growth; the ref is updated synchronously by real scroll events and prevents an in-flight observer or settle frame from yanking a reader back down. TaskPlannerChatTab, WorkflowResultsTab, DevServerLogViewer, and SystemControlsArea have separate transcript ownership and their matching force-follow behavior is deferred to FN-8346 rather than silently changing those surfaces here.
    */
    const followTail = () => {
      if (!isTranscriptAtBottomRef.current) return;
      container.scrollTop = container.scrollHeight;
      previousScrollHeightRef.current = container.scrollHeight;
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(followTail);
    resizeObserver?.observe(container);
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(followTail);
    mutationObserver?.observe(container, { childList: true, characterData: true, subtree: true });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [active]);

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

    setTranscriptFollowing(true);
    anchorTranscriptToBottom(container);
    previousEntryCountRef.current = transcriptItemCount;
    previousScrollHeightRef.current = container.scrollHeight;

    return () => {
      cancelAnchorTranscriptFrame();
    };
  }, [active, anchorTranscriptToBottom, cancelAnchorTranscriptFrame, setTranscriptFollowing, transcriptItemCount]);

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
      setTranscriptFollowing(isTranscriptNearBottom(container));
    } else if (transcriptItemCount > previousCount) {
      const shouldFollow = previousCount === 0 || isTranscriptAtBottomRef.current;
      if (shouldFollow) {
        container.scrollTop = container.scrollHeight;
        setTranscriptFollowing(true);
      } else {
        setTranscriptFollowing(isTranscriptNearBottom(container));
      }
      if (pendingPrependScrollHeightRef.current !== null) {
        pendingPrependScrollHeightRef.current = container.scrollHeight;
        pendingPrependScrollTopRef.current = container.scrollTop;
      }
    }

    previousEntryCountRef.current = transcriptItemCount;
    previousScrollHeightRef.current = container.scrollHeight;
    previousFirstEntryKeyRef.current = firstEntryKey;
    previousAgentEntryCountRef.current = entries.length;
  }, [active, entries.length, firstEntryKey, setTranscriptFollowing, transcriptItemCount]);

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
    setTranscriptFollowing(isTranscriptNearBottom(container));
    if (container.scrollTop <= TOP_LOAD_THRESHOLD) {
      void loadPreviousMessages();
    }
  }, [loadPreviousMessages, setTranscriptFollowing]);

  const scrollTranscriptToBottom = useCallback(() => {
    const container = transcriptRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    previousScrollHeightRef.current = container.scrollHeight;
    setTranscriptFollowing(true);
  }, [setTranscriptFollowing]);

  const handleSubmit = useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;

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
        /*
        FNXC:TaskDetailChat 2026-06-29-21:30:
        Done-task refinement uses the source task's durable workflow inheritance on the backend, so the chat composer must not send board workflow filters or keep a submitted optimistic bubble that looks like steering on the completed task. Success clears only the draft and temporary bubble; failure keeps the draft and rolls back through the shared catch path.
        */
        setOptimisticMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
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
      sendingRef.current = false;
      setSending(false);
    }
  }, [addToast, draft, entries, isDoneTask, onTaskUpdated, projectId, task.id, userMessages]);

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

  /*
  FNXC:TaskDetailChat 2026-07-01-00:00:
  Mobile soft keyboards can blur the focused composer textarea before the Send button receives a click, consuming the first tap. Touch/pen pointer-down submits immediately while the synchronous sendingRef guard preserves empty/disabled and duplicate-send behavior; mouse down only preserves focus so desktop click and keyboard submit semantics remain unchanged.
  */
  const handleSendPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    if (!canSend) return;
    event.preventDefault();
    void handleSubmit();
  }, [canSend, handleSubmit]);

  const handleSendMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!canSend) return;
    event.preventDefault();
  }, [canSend]);

  return (
    <div className="task-chat-tab" data-testid="task-chat-tab">
      {onToggleExpanded ? (
        <button
          type="button"
          className="btn btn-icon btn-sm task-chat-expand-toggle task-chat-expand-toggle--overlay"
          onClick={onToggleExpanded}
          aria-label={expanded ? t("taskChat.collapseActivity", "Collapse activity") : t("taskChat.expandActivity", "Expand activity to full modal")}
          aria-pressed={expanded}
          data-testid="task-chat-expand-toggle"
        >
          {/* FNXC:TaskDetailActivity 2026-07-01-00:00: TaskDetailModal passes Activity-expanded state into Live so this existing chat overlay remains the single Live expand affordance without adding a separate toolbar row. */}
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
          showLoadingIndicator ? (
            <div className="task-chat-empty" role="status">
              <Loader2 className="animate-spin" aria-hidden="true" />
              <span>{t("taskChat.loadingAgentOutput", "Loading agent output…")}</span>
            </div>
          ) : null
        ) : transcriptItemCount === 0 ? (
          <div className="task-chat-empty">{t("taskChat.emptyAgentOutput", "No agent output yet. Live messages from Planner, Executor, Reviewer, and Merger agents will appear here.")}</div>
        ) : (
          transcriptItems.map((item, itemIndex) => {
            if (item.kind === "user") {
              return <TaskChatUserMessage key={`user-${item.message.id}-${itemIndex}`} message={item.message} />;
            }

            const segments = segmentGroupEntries(item.entries);
            const latestEntryTimestamp = item.entries[item.entries.length - 1]?.timestamp ?? "";
            const modelInfo = getModelForRole(task, item.role, item.entries, effectiveModels);
            return (
              <section className="task-chat-group" key={`${item.role ?? "agent"}-${itemIndex}`} aria-label={t("taskChat.agentMessages", "{{label}} messages", { label: item.label })}>
                <header className="task-chat-group-header">
                  <TaskChatAgentIcon label={item.label} modelInfo={modelInfo} />
                  <div>
                    <div className="task-chat-role-label">{item.label}</div>
                    <div className="task-chat-group-meta">
                      <span>{formatEntryCount(item.entries.length, t)}</span>
                      <TaskChatTimestamp timestamp={latestEntryTimestamp} testId="task-chat-group-time" label="Agent group timestamp" />
                    </div>
                  </div>
                </header>
                <div className="task-chat-group-bubbles">
                  {segments.map((segment) => {
                    const segmentKey = `${segment.kind}-${segment.startIndex}-${segment.entries.length}`;
                    return <TaskChatSegmentView key={segmentKey} segment={segment} defaultOpen={thinkingDefaultOpen} />;
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

      <form className="task-chat-composer" onSubmit={handleSubmit} aria-label={composerFormLabel}>
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
            onPointerDown={handleSendPointerDown}
            onMouseDown={handleSendMouseDown}
          >
            {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          </button>
        </div>
      </form>
    </div>
  );
}
