import type { AgentLogEntry, AgentRole, Task, TaskDetail } from "@fusion/core";
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Send } from "lucide-react";
import { addSteeringComment } from "../api";
import { useAgentLogs } from "../hooks/useAgentLogs";
import type { ToastType } from "../hooks/useToast";
import { getErrorMessage } from "@fusion/core";
import { linkifyFilePaths } from "../utils/filePathLinkify";
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
}

type AgentLogRole = AgentRole | undefined;

interface AgentLogGroup {
  role: AgentLogRole;
  label: string;
  entries: AgentLogEntry[];
}

type TaskChatSegment =
  | { kind: "tool"; entries: AgentLogEntry[]; startIndex: number }
  | { kind: "thinking"; entries: AgentLogEntry[]; startIndex: number }
  | { kind: "text"; entry: AgentLogEntry; index: number };

type TaskChatToolGroupRow =
  | { kind: "invocation"; call: AgentLogEntry; completion?: AgentLogEntry; callIndex: number; completionIndex?: number }
  | { kind: "entry"; entry: AgentLogEntry; index: number };

const STEERING_BLOCKED_STATUSES = new Set([
  "paused",
  "awaiting-user-input",
  "awaiting-cli-approval",
  "awaiting-user-review",
  "failed",
  "needs-replan",
]);
const REVIEW_STEERABLE_STATUSES = new Set(["reviewing", "merging", "merging-fix", "fixing"]);
const BOTTOM_FOLLOW_THRESHOLD = 48;

function getRoleLabel(role: AgentLogRole): string {
  switch (role) {
    case "triage":
      return "Planner";
    case "executor":
      return "Executor";
    case "reviewer":
      return "Reviewer";
    case "merger":
      return "Merger";
    default:
      return "Agent";
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

function groupEntriesByAgent(entries: AgentLogEntry[]): AgentLogGroup[] {
  return entries.reduce<AgentLogGroup[]>((groups, entry) => {
    const previousGroup = groups[groups.length - 1];
    const role = entry.agent;
    if (previousGroup && previousGroup.role === role) {
      previousGroup.entries.push(entry);
      return groups;
    }
    groups.push({ role, label: getRoleLabel(role), entries: [entry] });
    return groups;
  }, []);
}

function isActiveAgentSession(task: Task | TaskDetail, opts: { sessionLive?: boolean } = {}): boolean {
  if (task.paused || task.userPaused) return false;
  if (opts.sessionLive) return true;

  const hasAssignedAgent = Boolean(task.assignedAgentId || task.checkedOutBy);
  const statusBlocksProgressSteering = task.status ? STEERING_BLOCKED_STATUSES.has(task.status) : false;
  const statusAllowsProgressSteering = !statusBlocksProgressSteering;
  const statusAllowsReviewSteering = !task.status || REVIEW_STEERABLE_STATUSES.has(task.status);
  const columnAllowsSteering = (task.column === "in-progress" && statusAllowsProgressSteering)
    || (task.column === "in-review" && statusAllowsReviewSteering);
  return columnAllowsSteering
    && hasAssignedAgent;
}

function isToolLikeEntry(entry: AgentLogEntry): boolean {
  return entry.type === "tool" || entry.type === "tool_result" || entry.type === "tool_error";
}

function formatEntryLabel(entry: AgentLogEntry): string {
  switch (entry.type) {
    case "tool":
      return "Tool call";
    case "tool_result":
      return "Tool result";
    case "tool_error":
      return "Tool error";
    case "thinking":
      return "Thinking";
    default:
      return "Message";
  }
}

const TOOL_NAME_SUMMARY_LIMIT = 5;

function formatToolCallCount(count: number): string {
  return count === 1 ? "1 tool call" : `${count} tool calls`;
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

    segments.push({ kind: "text", entry, index });
    index += 1;
  }

  return segments;
}

function TaskChatTextEntry({ entry }: { entry: AgentLogEntry }) {
  return (
    <article
      className={`task-chat-entry task-chat-entry--${entry.type.replace("_", "-")}`}
      data-testid={`task-chat-entry-${entry.type}`}
    >
      <div className="markdown-body task-chat-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {entry.text}
        </ReactMarkdown>
      </div>
    </article>
  );
}

function TaskChatToolEntry({ entry }: { entry: AgentLogEntry }) {
  return (
    <article
      className={`task-chat-tool-entry task-chat-tool-entry--${entry.type.replace("_", "-")}`}
      data-testid={`task-chat-entry-${entry.type}`}
    >
      <div className="task-chat-entry-kicker">{formatEntryLabel(entry)}</div>
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
  const completion = row.completion;
  const completionLabel = completion ? formatEntryLabel(completion).replace("Tool ", "") : undefined;
  const className = `task-chat-tool-entry task-chat-tool-invocation${completion?.type === "tool_error" ? " task-chat-tool-entry--tool-error" : ""}`;

  return (
    <article className={className} data-testid="task-chat-tool-invocation">
      <div className="task-chat-entry-kicker">
        {completionLabel ? `Tool call → ${completionLabel}` : "Tool call"}
      </div>
      <div className="task-chat-entry-text">{row.call.text}</div>
      {row.call.detail ? (
        <div className="task-chat-tool-detail-block">
          <div className="task-chat-tool-detail-label">Arguments</div>
          <pre className="task-chat-tool-detail">{linkifyFilePaths(row.call.detail)}</pre>
        </div>
      ) : null}
      {completion?.detail ? (
        <div className="task-chat-tool-detail-block">
          <div className="task-chat-tool-detail-label">{completion.type === "tool_error" ? "Error" : "Result"}</div>
          <pre className="task-chat-tool-detail">{linkifyFilePaths(completion.detail)}</pre>
        </div>
      ) : null}
    </article>
  );
}

function TaskChatToolGroup({ entries }: { entries: AgentLogEntry[] }) {
  const invocationEntries = getToolInvocationEntries(entries);
  const invocationCount = invocationEntries.length;
  const errorCount = entries.filter((entry) => entry.type === "tool_error").length;
  const { visibleNames, overflowCount } = getToolNameSummary(entries);
  const rows = getToolGroupRows(entries);

  return (
    <details className="task-chat-tool-group" data-testid="task-chat-tool-group">
      <summary className="task-chat-tool-group-summary">
        <span className="task-chat-tool-group-count">{formatToolCallCount(invocationCount)}</span>
        {visibleNames.length > 0 ? (
          <span className="task-chat-tool-group-names" aria-label="Tool names">
            {visibleNames.join(", ")}
            {overflowCount > 0 ? <span className="task-chat-tool-group-overflow">, +{overflowCount} more</span> : null}
          </span>
        ) : null}
        {errorCount > 0 ? (
          <span className="task-chat-tool-group-error-count">
            {errorCount === 1 ? "1 error" : `${errorCount} errors`}
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
  return (
    <details className="task-chat-thinking" data-testid="task-chat-thinking" open>
      <summary className="task-chat-thinking-summary">
        {entries.length === 1 ? "Thinking" : `${entries.length} thinking entries`}
      </summary>
      <div className="task-chat-thinking-body">
        {entries.map((entry, entryIndex) => (
          <div
            className="markdown-body task-chat-markdown task-chat-thinking-markdown"
            data-testid="task-chat-entry-thinking"
            key={getEntryKey(entry, entryIndex)}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {entry.text}
            </ReactMarkdown>
          </div>
        ))}
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
  return <TaskChatTextEntry entry={segment.entry} />;
}

export function TaskChatTab({ task, projectId, active, addToast, sessionLive }: TaskChatTabProps) {
  const { entries, loading } = useAgentLogs(task.id, active, projectId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const previousEntryCountRef = useRef(0);
  const previousScrollHeightRef = useRef(0);
  const previousActiveRef = useRef(false);
  const anchorFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const groups = useMemo(() => groupEntriesByAgent(entries), [entries]);
  const activeSession = isActiveAgentSession(task, { sessionLive });
  const canSend = activeSession && draft.trim().length > 0 && !sending;

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
    if (!container || !active || entries.length === 0) return;

    const becameActive = !wasActive;
    const receivedInitialEntries = previousEntryCountRef.current === 0;
    if (!becameActive && !receivedInitialEntries) return;

    anchorTranscriptToBottom(container);
    previousEntryCountRef.current = entries.length;
    previousScrollHeightRef.current = container.scrollHeight;

    return () => {
      cancelAnchorTranscriptFrame();
    };
  }, [active, anchorTranscriptToBottom, cancelAnchorTranscriptFrame, entries.length]);

  useLayoutEffect(() => {
    const container = transcriptRef.current;
    if (!container) return;

    if (!active) {
      previousEntryCountRef.current = entries.length;
      previousScrollHeightRef.current = container.scrollHeight;
      return;
    }

    const previousCount = previousEntryCountRef.current;
    const previousScrollHeight = previousScrollHeightRef.current || container.scrollHeight;
    if (entries.length > previousCount) {
      const shouldFollow = previousCount === 0 || previousScrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_THRESHOLD;
      if (shouldFollow) {
        container.scrollTop = container.scrollHeight;
      }
    }

    previousEntryCountRef.current = entries.length;
    previousScrollHeightRef.current = container.scrollHeight;
  }, [active, entries]);

  const handleTranscriptScroll = useCallback(() => {
    const container = transcriptRef.current;
    if (!container) return;
    previousScrollHeightRef.current = container.scrollHeight;
  }, []);

  const handleSubmit = useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !activeSession || sending) return;

    setSending(true);
    try {
      await addSteeringComment(task.id, text, projectId);
      setDraft("");
    } catch (error) {
      addToast(`Unable to send message: ${getErrorMessage(error)}`, "error");
    } finally {
      setSending(false);
    }
  }, [activeSession, addToast, draft, projectId, sending, task.id]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      void handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="task-chat-tab" data-testid="task-chat-tab">
      <div
        className="task-chat-transcript"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
        aria-live="polite"
        data-testid="task-chat-transcript"
      >
        {loading && entries.length === 0 ? (
          <div className="task-chat-empty" role="status">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span>Loading agent output…</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="task-chat-empty">No agent output yet. Live messages from Planner, Executor, Reviewer, and Merger agents will appear here.</div>
        ) : (
          groups.map((group, groupIndex) => {
            const avatarAgent = {
              id: group.role ?? "agent",
              name: group.label,
              icon: getRoleIcon(group.role),
            };
            const segments = segmentGroupEntries(group.entries);
            return (
              <section className="task-chat-group" key={`${group.role ?? "agent"}-${groupIndex}`} aria-label={`${group.label} messages`}>
                <header className="task-chat-group-header">
                  <AgentAvatar agent={avatarAgent} className="task-chat-avatar" />
                  <div>
                    <div className="task-chat-role-label">{group.label}</div>
                    <div className="task-chat-group-meta">{group.entries.length === 1 ? "1 entry" : `${group.entries.length} entries`}</div>
                  </div>
                </header>
                <div className="task-chat-group-bubbles">
                  {segments.map((segment) => {
                    const segmentKey = segment.kind === "text"
                      ? `text-${getEntryKey(segment.entry, segment.index)}`
                      : `${segment.kind}-${segment.startIndex}-${segment.entries.length}`;
                    return <TaskChatSegmentView key={segmentKey} segment={segment} />;
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>

      <form className="task-chat-composer card" onSubmit={handleSubmit}>
        {!activeSession ? (
          <div className="task-chat-session-hint" role="status">
            No active steerable agent session is available. An active assigned task agent or live, non-paused CLI session is required to send guidance.
          </div>
        ) : null}
        <div className="task-chat-composer-row">
          <textarea
            ref={textareaRef}
            className="input task-chat-input"
            value={draft}
            placeholder={activeSession ? "Message the active agent session…" : "Active steerable agent session required"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeSession || sending}
            aria-label="Message active agent session"
            rows={1}
          />
          <button type="submit" className="btn btn-primary task-chat-send" disabled={!canSend}>
            {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            <span>{sending ? "Sending" : "Send"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
