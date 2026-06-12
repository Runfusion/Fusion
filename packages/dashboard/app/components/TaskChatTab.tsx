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
}

type AgentLogRole = AgentRole | undefined;

interface AgentLogGroup {
  role: AgentLogRole;
  label: string;
  entries: AgentLogEntry[];
}

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

function isActiveAgentSession(task: Task | TaskDetail): boolean {
  const hasAssignedAgent = Boolean(task.assignedAgentId || task.checkedOutBy);
  const statusBlocksProgressSteering = task.status ? STEERING_BLOCKED_STATUSES.has(task.status) : false;
  const statusAllowsProgressSteering = !statusBlocksProgressSteering;
  const statusAllowsReviewSteering = !task.status || REVIEW_STEERABLE_STATUSES.has(task.status);
  const columnAllowsSteering = (task.column === "in-progress" && statusAllowsProgressSteering)
    || (task.column === "in-review" && statusAllowsReviewSteering);
  return columnAllowsSteering
    && hasAssignedAgent
    && !task.paused
    && !task.userPaused;
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

function TaskChatEntry({ entry }: { entry: AgentLogEntry }) {
  const isToolEntry = entry.type === "tool" || entry.type === "tool_result" || entry.type === "tool_error";
  const className = [
    "task-chat-entry",
    `task-chat-entry--${entry.type.replace("_", "-")}`,
    isToolEntry ? "task-chat-entry--tool" : "",
  ].filter(Boolean).join(" ");

  if (isToolEntry) {
    return (
      <article className={className} data-testid={`task-chat-entry-${entry.type}`}>
        <div className="task-chat-entry-kicker">{formatEntryLabel(entry)}</div>
        <div className="task-chat-entry-text">{entry.text}</div>
        {entry.detail ? <pre className="task-chat-tool-detail">{linkifyFilePaths(entry.detail)}</pre> : null}
      </article>
    );
  }

  return (
    <article className={className} data-testid={`task-chat-entry-${entry.type}`}>
      {entry.type === "thinking" ? <div className="task-chat-entry-kicker">{formatEntryLabel(entry)}</div> : null}
      <div className="markdown-body task-chat-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {entry.text}
        </ReactMarkdown>
      </div>
    </article>
  );
}

export function TaskChatTab({ task, projectId, active, addToast }: TaskChatTabProps) {
  const { entries, loading } = useAgentLogs(task.id, active, projectId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const previousEntryCountRef = useRef(0);
  const previousScrollHeightRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const groups = useMemo(() => groupEntriesByAgent(entries), [entries]);
  const activeSession = isActiveAgentSession(task);
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

  useLayoutEffect(() => {
    const container = transcriptRef.current;
    if (!container) return;

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
  }, [entries]);

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
                  {group.entries.map((entry, entryIndex) => (
                    <TaskChatEntry key={getEntryKey(entry, entryIndex)} entry={entry} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      <form className="task-chat-composer card" onSubmit={handleSubmit}>
        {!activeSession ? (
          <div className="task-chat-session-hint" role="status">
            No active assigned agent session is available. An active, assigned, non-paused agent session is required to send guidance.
          </div>
        ) : null}
        <div className="task-chat-composer-row">
          <textarea
            ref={textareaRef}
            className="input task-chat-input"
            value={draft}
            placeholder={activeSession ? "Message the active agent session…" : "Active non-paused agent session required"}
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
