import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MessageSquare,
  Send,
  Plus,
  Search,
  Trash2,
  Archive,
  ChevronLeft,
  Bot,
  Square,
  Wrench,
} from "lucide-react";
import { useChat, type ToolCallInfo } from "../hooks/useChat";
import { useViewportMode } from "./Header";
import { fetchAgents, fetchDiscoveredSkills, fetchModels } from "../api";
import type { Agent } from "@fusion/core";
import type { DiscoveredSkill } from "@fusion/dashboard";
import type { ModelInfo } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { AgentMentionPopup } from "./AgentMentionPopup";
import { FileMentionPopup } from "./FileMentionPopup";
import { useFileMention } from "../hooks/useFileMention";

export interface ChatViewProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format a model provider and ID into a human-readable tag.
 * Returns null if provider or modelId is missing/empty.
 */
function formatModelTag(provider?: string | null, modelId?: string | null): string | null {
  if (!provider || !modelId) return null;

  // Handle known provider/model patterns
  const normalizedModel = modelId.toLowerCase();

  // Claude models: "claude-sonnet-4-5" -> "Claude Sonnet 4.5"
  if (normalizedModel.includes("claude")) {
    let formatted = modelId
      .replace(/^claude[- ]/i, "Claude ")
      .replace(/sonnet[- ](\d+)[- ](\d+)/i, "Sonnet $1.$2")
      .replace(/sonnet[- ](\d+)/i, "Sonnet $1")
      .replace(/haiku[- ](\d+)/i, "Haiku $1")
      .replace(/opus[- ](\d+)/i, "Opus $1")
      .replace(/sonnet/i, "Sonnet")
      .replace(/haiku/i, "Haiku")
      .replace(/opus/i, "Opus")
      .replace(/-/g, " ")
      .trim();
    // Fix double spaces
    formatted = formatted.replace(/\s+/g, " ");
    return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
  }

  // OpenAI models: "gpt-4o" -> "GPT-4o", "gpt-4-turbo" -> "GPT-4 Turbo"
  if (normalizedModel.includes("gpt") || normalizedModel.includes("openai")) {
    // Format GPT model names: handle special cases first, then capitalize
    // Note: We don't replace hyphens globally because special cases preserve them
    const formatted = modelId
      .replace(/^gpt-4-turbo$/i, "GPT-4 Turbo")
      .replace(/^gpt-4o-mini$/i, "GPT-4o Mini")
      .replace(/^gpt-4o$/i, "GPT-4o")
      .replace(/^gpt-4$/i, "GPT-4")
      .replace(/^gpt-o1-preview$/i, "GPT-o1 Preview")
      .replace(/^gpt-o1-mini$/i, "GPT-o1 Mini")
      .replace(/^gpt-o1$/i, "GPT-o1")
      .replace(/^gpt/i, "GPT")  // Capitalize remaining GPT prefix
      .trim();
    return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
  }

  // Gemini models: "gemini-2.5-pro" -> "Gemini 2.5 Pro"
  if (normalizedModel.includes("gemini")) {
    const formatted = modelId
      .replace(/^gemini[- ]/i, "Gemini ")
      .replace(/pro[- ](\d+)[- ](\d+)/i, "Pro $1.$2")
      .replace(/pro[- ](\d+)/i, "Pro $1")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
  }

  // Generic fallback: capitalize first letter, replace hyphens with spaces
  const formatted = modelId
    .replace(/-/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
  return formatted.length > 30 ? formatted.slice(0, 30) + "…" : formatted;
}

function truncateValue(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function formatToolArgsSummary(args?: Record<string, unknown>): string | null {
  if (!args) return null;

  const entries = Object.entries(args);
  if (entries.length === 0) return null;

  return entries
    .map(([key, value]) => {
      let stringValue = "";
      if (typeof value === "string") {
        stringValue = value;
      } else {
        try {
          stringValue = JSON.stringify(value);
        } catch {
          stringValue = String(value);
        }
      }
      return `${key}=${truncateValue(stringValue, 50)}`;
    })
    .join(", ");
}

function formatToolResultSummary(result: unknown): string | null {
  if (result === undefined) {
    return null;
  }

  if (typeof result === "string") {
    return truncateValue(result, 200);
  }

  try {
    return truncateValue(JSON.stringify(result), 200);
  } catch {
    return truncateValue(String(result), 200);
  }
}

function renderToolCalls(toolCalls?: ToolCallInfo[]): ReactNode {
  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="chat-tool-calls" data-testid="chat-tool-calls">
      <div className="chat-tool-calls-header">
        <Wrench size={12} aria-hidden="true" />
        <span>Tool calls</span>
      </div>
      {toolCalls.map((toolCall, index) => {
        const isRunning = toolCall.status === "running";
        const isError = toolCall.status === "completed" && toolCall.isError;
        const argsSummary = formatToolArgsSummary(toolCall.args);
        const resultSummary = formatToolResultSummary(toolCall.result);
        const summaryPreview = isRunning
          ? argsSummary
          : resultSummary
            ? `result: ${resultSummary}`
            : argsSummary
              ? `args: ${argsSummary}`
              : null;
        const statusLabel = isRunning ? "running" : isError ? "error" : "completed";

        return (
          <details
            key={`${toolCall.toolName}-${index}`}
            className={`chat-tool-call${isRunning ? " chat-tool-call--running" : ""}${isError ? " chat-tool-call--error" : ""}`}
            open={isRunning}
          >
            <summary>
              <span className="chat-tool-call-status-dot" aria-hidden="true" />
              <span className="chat-tool-call-name">{toolCall.toolName}</span>
              {summaryPreview && (
                <span className="chat-tool-call-preview" title={summaryPreview}>
                  {summaryPreview}
                </span>
              )}
              <span className="chat-tool-call-status-text">{statusLabel}</span>
            </summary>
            <div className="chat-tool-call-content">
              {argsSummary && (
                <div className="chat-tool-call-row">
                  <span className="chat-tool-call-label">args</span>
                  <span className="chat-tool-call-value">{argsSummary}</span>
                </div>
              )}
              {resultSummary && (
                <div className={`chat-tool-call-row${isError ? " chat-tool-call-row--error" : ""}`}>
                  <span className="chat-tool-call-label">result</span>
                  <span className="chat-tool-call-value">{resultSummary}</span>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/**
 * Constant agent ID for the built-in fn agent.
 * The chat system always uses createFnAgent with CHAT_SYSTEM_PROMPT regardless
 * of the agentId stored on the session. This ID serves as metadata only.
 */
const FN_AGENT_ID = "__fn_agent__";

function getSkillTriggerMatch(value: string): { filter: string; start: number; end: number } | null {
  const triggerMatch = /(^|[\s])\/([^\s]*)$/.exec(value);
  if (!triggerMatch) {
    return null;
  }

  const prefix = triggerMatch[1] ?? "";
  const filter = triggerMatch[2] ?? "";
  const start = triggerMatch.index + prefix.length;
  return {
    filter,
    start,
    end: value.length,
  };
}

function getMentionTriggerMatch(
  value: string,
  cursorPos: number,
): { filter: string; start: number; end: number } | null {
  const textBeforeCursor = value.slice(0, cursorPos);
  const triggerMatch = /(^|[\s\n])@([\w-]*)$/.exec(textBeforeCursor);
  if (!triggerMatch) {
    return null;
  }

  const filter = triggerMatch[2] ?? "";
  const start = textBeforeCursor.length - filter.length - 1;
  return {
    filter,
    start,
    end: cursorPos,
  };
}

interface NewChatDialogProps {
  projectId?: string;
  onClose: () => void;
  onCreate: (input: { agentId: string; modelProvider?: string; modelId?: string }) => void;
}

function NewChatDialog({ projectId, onClose, onCreate }: NewChatDialogProps) {
  const [chatMode, setChatMode] = useState<"agent" | "model">("agent");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState<string>("");

  // Load agents on mount (project-scoped)
  useEffect(() => {
    let cancelled = false;
    setAgentsLoading(true);
    fetchAgents(undefined, projectId)
      .then((response) => {
        if (!cancelled) {
          setAgents(response);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Silently fail - show empty list
          setAgents([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load models on mount
  useEffect(() => {
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setModels(response.models);
      })
      .catch(() => {
        // Silently fail - show empty list
        setModels([]);
      })
      .finally(() => {
        setModelsLoading(false);
      });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (chatMode === "agent") {
      if (!selectedAgentId) return;
      onCreate({ agentId: selectedAgentId });
      return;
    }

    // model mode
    if (!selectedModel) return;
    const slashIdx = selectedModel.indexOf("/");
    if (slashIdx <= 0) return;
    const modelProvider = selectedModel.slice(0, slashIdx);
    const modelId = selectedModel.slice(slashIdx + 1);
    onCreate({ agentId: FN_AGENT_ID, modelProvider, modelId });
  };

  const isSubmitDisabled =
    chatMode === "agent" ? !selectedAgentId : !selectedModel;

  return (
    <div className="chat-new-dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="chat-new-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Chat</h3>
        <div className="chat-new-dialog-mode-toggle" data-testid="chat-new-dialog-mode-toggle">
          <button
            type="button"
            className={`chat-new-dialog-mode-btn${chatMode === "agent" ? " chat-new-dialog-mode-btn--active" : ""}`}
            data-testid="chat-new-dialog-mode-agent"
            onClick={() => {
              setChatMode("agent");
              setSelectedModel("");
            }}
          >
            Agent
          </button>
          <button
            type="button"
            className={`chat-new-dialog-mode-btn${chatMode === "model" ? " chat-new-dialog-mode-btn--active" : ""}`}
            data-testid="chat-new-dialog-mode-model"
            onClick={() => {
              setChatMode("model");
              setSelectedAgentId("");
            }}
          >
            Model
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          {chatMode === "agent" && (
            <label className="chat-new-dialog-model-label">
              Agent
              {agentsLoading ? (
                <div className="chat-new-dialog-loading">Loading agents...</div>
              ) : agents.length === 0 ? (
                <div className="chat-new-dialog-empty">No agents available</div>
              ) : (
                <div className="chat-new-dialog-agent-list">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className={`chat-new-dialog-agent-item${selectedAgentId === agent.id ? " chat-new-dialog-agent-item--selected" : ""}`}
                      onClick={() => setSelectedAgentId(agent.id)}
                      data-testid={`agent-option-${agent.id}`}
                    >
                      <Bot size={16} />
                      <span className="chat-new-dialog-agent-name">{agent.name}</span>
                      <span className="chat-new-dialog-agent-role">{agent.role}</span>
                    </button>
                  ))}
                </div>
              )}
            </label>
          )}
          {chatMode === "model" && (
            <div className="chat-new-dialog-model-dropdown" data-testid="chat-new-dialog-model-section">
              {modelsLoading ? (
                <div className="chat-new-dialog-loading">Loading models...</div>
              ) : (
                <CustomModelDropdown
                  models={models}
                  value={selectedModel}
                  onChange={setSelectedModel}
                  label="Model"
                  placeholder="Select a model"
                />
              )}
            </div>
          )}
          <div className="chat-new-dialog-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={isSubmitDisabled}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



export function ChatView({ projectId, addToast }: ChatViewProps) {
  const {
    activeSession,
    sessionsLoading,
    messages,
    messagesLoading,
    isStreaming,
    streamingText,
    streamingThinking,
    streamingToolCalls,
    selectSession,
    createSession,
    archiveSession,
    deleteSession,
    sendMessage,
    stopStreaming,
    pendingMessage,
    clearPendingMessage,
    searchQuery,
    setSearchQuery,
    filteredSessions,
  } = useChat(projectId);

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [agentsMap, setAgentsMap] = useState<Map<string, Agent>>(new Map());
  const [discoveredSkills, setDiscoveredSkills] = useState<DiscoveredSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPopupVisible, setMentionPopupVisible] = useState(false);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);

  // File mention state and hook
  const [, setFileMentionPopupVisible] = useState(false);
  const [fileMentionPosition, setFileMentionPosition] = useState({ top: 0, left: 0 });

  const fileMention = useFileMention({ projectId });

  // Calculate popup position based on caret position in textarea
  const updateFileMentionPosition = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea || !fileMention.mentionActive) return;

    // Get textarea position
    const rect = textarea.getBoundingClientRect();

    // Position above the textarea, using viewport coordinates
    // The popup is absolutely positioned, so we use window coordinates
    setFileMentionPosition({
      top: rect.top - 260, // Popup appears above with gap (accounting for popup height)
      left: rect.left + 8, // Small left offset
    });
  }, [fileMention.mentionActive]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hideSkillMenuTimeoutRef = useRef<number | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionCursorPosRef = useRef(0);
  const mode = useViewportMode();
  const isMobile = mode === "mobile";

  const filteredSkills = useMemo(() => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    const matchingSkills = normalizedFilter
      ? discoveredSkills.filter((skill) => skill.name.toLowerCase().includes(normalizedFilter))
      : discoveredSkills;
    return matchingSkills.slice(0, 10);
  }, [discoveredSkills, skillFilter]);

  const mentionAgents = useMemo(() => Array.from(agentsMap.values()), [agentsMap]);

  const filteredMentionAgents = useMemo(() => {
    const normalizedFilter = mentionFilter.trim().toLowerCase();
    if (!normalizedFilter) {
      return mentionAgents;
    }
    return mentionAgents.filter((agent) => agent.name.toLowerCase().includes(normalizedFilter));
  }, [mentionAgents, mentionFilter]);

  const mentionAgentsByName = useMemo(() => {
    const byName = new Map<string, Agent>();
    for (const agent of mentionAgents) {
      byName.set(agent.name.toLowerCase(), agent);
    }
    return byName;
  }, [mentionAgents]);

  useEffect(() => {
    setHighlightedSkillIndex(0);
  }, [filteredSkills]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionFilter, mentionPopupVisible]);

  useEffect(() => {
    return () => {
      if (hideSkillMenuTimeoutRef.current !== null) {
        window.clearTimeout(hideSkillMenuTimeoutRef.current);
      }
    };
  }, []);

  // Scroll to bottom on new messages or streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  // Fetch agents on mount for name resolution (project-scoped with stale-request protection)
  useEffect(() => {
    let cancelled = false;
    const currentProjectId = projectId;
    fetchAgents(undefined, projectId)
      .then((agents) => {
        // Ignore response if project changed during fetch
        if (cancelled || currentProjectId !== projectId) return;
        const map = new Map<string, Agent>();
        for (const agent of agents) {
          map.set(agent.id, agent);
        }
        setAgentsMap(map);
      })
      .catch(() => {
        // Silently fail - keep empty map
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch discovered skills for slash command autocomplete
  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);

    fetchDiscoveredSkills(projectId)
      .then((skills) => {
        if (!cancelled) {
          setDiscoveredSkills(skills);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiscoveredSkills([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSkillsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Handle create session
  const handleCreateSession = useCallback(
    async (input: { agentId: string; modelProvider?: string; modelId?: string }) => {
      try {
        await createSession(input);
        setShowNewDialog(false);
        // On mobile, hide sidebar after selecting
        if (isMobile) setSidebarVisible(false);
      } catch {
        addToast("Failed to create chat session", "error");
      }
    },
    [createSession, addToast, isMobile],
  );

  // Handle send message
  const handleSend = useCallback(() => {
    const trimmed = messageInput.trim();
    if (!trimmed || !activeSession) return;
    setMessageInput("");
    setShowSkillMenu(false);
    setSkillFilter("");
    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
    sendMessage(trimmed);
  }, [messageInput, activeSession, sendMessage]);

  const handleSkillSelect = useCallback(
    (skill: DiscoveredSkill) => {
      setMessageInput((currentInput) => {
        const triggerMatch = getSkillTriggerMatch(currentInput);
        if (!triggerMatch) {
          return currentInput;
        }

        const replacement = `/skill:${skill.name} `;
        const nextInput =
          currentInput.slice(0, triggerMatch.start) + replacement + currentInput.slice(triggerMatch.end);

        window.requestAnimationFrame(() => {
          if (!inputRef.current) return;
          inputRef.current.style.height = "auto";
          inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
          inputRef.current.focus();
        });

        return nextInput;
      });

      setShowSkillMenu(false);
      setSkillFilter("");
      setHighlightedSkillIndex(0);
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (agent: Agent) => {
      const textarea = inputRef.current;
      if (!textarea || mentionStartPos < 0) {
        return;
      }

      const selectionStart = textarea.selectionStart ?? mentionCursorPosRef.current;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      const cursorPos = Math.max(selectionStart, selectionEnd);
      const safeStart = Math.min(mentionStartPos, cursorPos);
      const mentionText = `@${agent.name.replace(/\s+/g, "_")}`;
      const replacement = `${mentionText} `;
      const nextInput = messageInput.slice(0, safeStart) + replacement + messageInput.slice(cursorPos);
      const nextCursorPos = safeStart + replacement.length;

      setMessageInput(nextInput);
      setMentionPopupVisible(false);
      setMentionFilter("");
      setMentionHighlightIndex(0);
      setMentionStartPos(-1);

      window.requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.style.height = "auto";
        inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [mentionStartPos, messageInput],
  );

  const renderMessageContent = useCallback(
    (content: string) => {
      const mentionRegex = /@([\w-]+)/g;
      const parts: ReactNode[] = [];
      let lastIndex = 0;
      let match = mentionRegex.exec(content);

      while (match) {
        const [fullMatch, rawName = ""] = match;
        const start = match.index;
        if (start > lastIndex) {
          parts.push(content.slice(lastIndex, start));
        }

        const normalizedName = rawName.replace(/_/g, " ").toLowerCase();
        const mentionedAgent = mentionAgentsByName.get(normalizedName);
        if (mentionedAgent) {
          parts.push(
            <span key={`${mentionedAgent.id}-${start}`} className="chat-mention-chip">
              @{mentionedAgent.name.replace(/\s+/g, "_")}
            </span>,
          );
        } else {
          parts.push(fullMatch);
        }

        lastIndex = start + fullMatch.length;
        match = mentionRegex.exec(content);
      }

      if (lastIndex < content.length) {
        parts.push(content.slice(lastIndex));
      }

      if (parts.length === 0) {
        return content;
      }

      return parts;
    },
    [mentionAgentsByName],
  );

  // Handle input key down
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      mentionCursorPosRef.current = e.currentTarget.selectionStart ?? mentionCursorPosRef.current;

      // Handle file mention popup keyboard navigation first
      if (fileMention.mentionActive && fileMention.files.length > 0) {
        fileMention.handleKeyDown(e, messageInput);
        if (e.key === "Enter" || e.key === "Tab") {
          // Select the highlighted file
          const file = fileMention.files[fileMention.selectedIndex];
          if (file) {
            const newText = fileMention.selectFile(file, messageInput);
            setMessageInput(newText);
            fileMention.dismissMention();
            setFileMentionPopupVisible(false);
          }
        }
        return;
      }

      if (mentionPopupVisible && e.key === "ArrowDown") {
        e.preventDefault();
        if (filteredMentionAgents.length > 0) {
          setMentionHighlightIndex((prev) => (prev + 1) % filteredMentionAgents.length);
        }
        return;
      }

      if (mentionPopupVisible && e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredMentionAgents.length > 0) {
          setMentionHighlightIndex((prev) =>
            prev === 0 ? filteredMentionAgents.length - 1 : prev - 1,
          );
        }
        return;
      }

      if (mentionPopupVisible && e.key === "Enter") {
        e.preventDefault();
        const agentToSelect = filteredMentionAgents[mentionHighlightIndex] ?? filteredMentionAgents[0];
        if (agentToSelect) {
          handleMentionSelect(agentToSelect);
        }
        return;
      }

      if (mentionPopupVisible && e.key === "Escape") {
        e.preventDefault();
        setMentionPopupVisible(false);
        setMentionFilter("");
        setMentionStartPos(-1);
        return;
      }

      if (showSkillMenu && e.key === "ArrowDown") {
        e.preventDefault();
        if (filteredSkills.length > 0) {
          setHighlightedSkillIndex((prev) => (prev + 1) % filteredSkills.length);
        }
        return;
      }

      if (showSkillMenu && e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredSkills.length > 0) {
          setHighlightedSkillIndex((prev) =>
            prev === 0 ? filteredSkills.length - 1 : prev - 1,
          );
        }
        return;
      }

      if (showSkillMenu && (e.key === "Enter" || e.key === "Tab") && filteredSkills.length > 0) {
        e.preventDefault();
        const skillToSelect = filteredSkills[highlightedSkillIndex] ?? filteredSkills[0];
        if (skillToSelect) {
          handleSkillSelect(skillToSelect);
        }
        return;
      }

      if (showSkillMenu && e.key === "Escape") {
        e.preventDefault();
        setShowSkillMenu(false);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [
      mentionPopupVisible,
      filteredMentionAgents,
      mentionHighlightIndex,
      handleMentionSelect,
      showSkillMenu,
      filteredSkills,
      highlightedSkillIndex,
      handleSkillSelect,
      handleSend,
      fileMention,
      messageInput,
    ],
  );

  const updateMentionState = useCallback((value: string, cursorPos: number) => {
    const mentionTriggerMatch = getMentionTriggerMatch(value, cursorPos);
    if (mentionTriggerMatch) {
      setMentionPopupVisible(true);
      setMentionFilter(mentionTriggerMatch.filter);
      setMentionStartPos(mentionTriggerMatch.start);
      return;
    }

    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
  }, []);

  // Handle textarea resize
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    const nextValue = textarea.value;
    const cursorPos = textarea.selectionStart ?? nextValue.length;

    mentionCursorPosRef.current = cursorPos;
    setMessageInput(nextValue);

    const skillTriggerMatch = getSkillTriggerMatch(nextValue);
    if (skillTriggerMatch) {
      setShowSkillMenu(true);
      setSkillFilter(skillTriggerMatch.filter);
    } else {
      setShowSkillMenu(false);
      setSkillFilter("");
    }

    updateMentionState(nextValue, cursorPos);

    // Detect file mentions
    fileMention.detectMention(nextValue, cursorPos);
    setFileMentionPopupVisible(fileMention.mentionActive);
    if (fileMention.mentionActive) {
      updateFileMentionPosition(textarea);
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, [updateMentionState]);

  const handleInputSelectionChange = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart ?? textarea.value.length;
      mentionCursorPosRef.current = cursorPos;
      updateMentionState(textarea.value, cursorPos);

      // Detect file mentions
      fileMention.detectMention(textarea.value, cursorPos);
      setFileMentionPopupVisible(fileMention.mentionActive);
      if (fileMention.mentionActive) {
        updateFileMentionPosition(textarea);
      }
    },
    [updateMentionState, fileMention, updateFileMentionPosition],
  );

  const handleInputKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        return;
      }
      handleInputSelectionChange(e);
    },
    [handleInputSelectionChange],
  );

  const handleInputBlur = useCallback(() => {
    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
    }

    hideSkillMenuTimeoutRef.current = window.setTimeout(() => {
      setShowSkillMenu(false);
      setMentionPopupVisible(false);
      setMentionFilter("");
      setMentionStartPos(-1);
      setFileMentionPopupVisible(false);
      fileMention.dismissMention();
      hideSkillMenuTimeoutRef.current = null;
    }, 120);
  }, [fileMention]);

  const handleInputFocus = useCallback(() => {
    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
      hideSkillMenuTimeoutRef.current = null;
    }
  }, []);

  // Handle archive
  const handleArchive = useCallback(
    async (id: string) => {
      setContextMenu(null);
      try {
        await archiveSession(id);
        addToast("Conversation archived", "success");
      } catch {
        addToast("Failed to archive conversation", "error");
      }
    },
    [archiveSession, addToast],
  );

  // Handle delete
  const handleDelete = useCallback(
    async (id: string) => {
      setConfirmDelete(null);
      setContextMenu(null);
      try {
        await deleteSession(id);
        addToast("Conversation deleted", "success");
      } catch {
        addToast("Failed to delete conversation", "error");
      }
    },
    [deleteSession, addToast],
  );

  // Handle session click
  const handleSessionClick = useCallback(
    (id: string) => {
      selectSession(id);
      if (isMobile) setSidebarVisible(false);
    },
    [selectSession, isMobile],
  );

  // Handle back to sidebar (mobile)
  const handleBack = useCallback(() => {
    selectSession("");
    setSidebarVisible(true);
  }, [selectSession]);

  // Render empty state (no active session)
  const renderEmptyState = () => {
    return (
      <div className="chat-empty-state">
        <MessageSquare size={48} strokeWidth={1.5} />
        <h2>Start a new conversation</h2>
        <button className="btn btn-primary" onClick={() => setShowNewDialog(true)}>
          <Plus size={16} />
          New Chat
        </button>
      </div>
    );
  };

  const activeModelTag = formatModelTag(activeSession?.modelProvider, activeSession?.modelId);

  const threadHeaderTitle = activeSession?.agentId === FN_AGENT_ID
    ? (activeModelTag ?? "Fusion")
    : activeSession?.title || agentsMap.get(activeSession?.agentId ?? "")?.name || activeSession?.agentId || "Chat";

  const showThreadHeaderModelTag = Boolean(activeModelTag && activeModelTag !== threadHeaderTitle);

  const agentName =
    agentsMap.get(activeSession?.agentId ?? "")?.name ||
    (activeSession?.agentId === FN_AGENT_ID
      ? (activeModelTag ?? "Fusion")
      : (activeSession?.agentId?.slice(0, 30) ?? "Fusion"));

  const showAssistantModelTag = Boolean(activeModelTag && activeModelTag !== agentName);

  const pendingPreview = pendingMessage.length > 50
    ? `${pendingMessage.slice(0, 50)}…`
    : pendingMessage;

  return (
    <div className="chat-view">
      {/* Sidebar */}
      <div className={`chat-sidebar${!sidebarVisible ? " chat-sidebar--hidden" : ""}`}>
        {/* Desktop header with New Chat button */}
        <div className="chat-sidebar-header">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setShowNewDialog(true)}
            data-testid="chat-new-btn"
          >
            <Plus size={14} />
            New Chat
          </button>
        </div>
        {/* Search section */}
        <div className="chat-sidebar-search">
          <div className="chat-sidebar-search-wrapper">
            <Search size={14} className="chat-sidebar-search-icon" />
            <input
              type="text"
              className="chat-sidebar-search"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="chat-search-input"
            />
          </div>
        </div>
        {/* Session list section */}
        <div className="chat-session-list chat-sidebar-list">
          {sessionsLoading ? (
            <div style={{ padding: "12px", color: "var(--text-secondary)", fontSize: "13px" }}>
              Loading...
            </div>
          ) : filteredSessions.length === 0 ? (
            <div style={{ padding: "12px", color: "var(--text-secondary)", fontSize: "13px" }}>
              No conversations yet
            </div>
          ) : (
            filteredSessions.map((session) => (
              <div
                key={session.id}
                className={`chat-session-item${activeSession?.id === session.id ? " chat-session-item--active" : ""}`}
                onClick={() => handleSessionClick(session.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
                }}
                data-testid={`chat-session-${session.id}`}
              >
                <button
                  className="chat-session-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(session.id);
                  }}
                  data-testid="chat-session-delete-btn"
                  aria-label="Delete conversation"
                >
                  <Trash2 size={14} />
                </button>
                <div className="chat-session-title">{session.title || "Untitled"}</div>
                <div className="chat-session-preview">
                  {session.lastMessagePreview || "No messages"}
                </div>
                <div className="chat-session-meta">
                  <span>
                    {agentsMap.get(session.agentId)?.name ||
                      (session.agentId === FN_AGENT_ID
                        ? (formatModelTag(session.modelProvider, session.modelId) ?? "Fusion")
                        : session.agentId.slice(0, 30))}
                  </span>
                  <span>{session.updatedAt ? formatRelativeTime(session.updatedAt) : ""}</span>
                </div>
              </div>
            ))
          )}
        </div>
        {/* Mobile footer with New Chat action */}
        <div className="chat-sidebar-footer">
          <button
            className="btn btn-sm btn-primary chat-sidebar-footer-btn"
            onClick={() => setShowNewDialog(true)}
            data-testid="chat-new-btn-mobile"
          >
            <Plus size={14} />
            New Chat
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="chat-session-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleArchive(contextMenu.sessionId)}
            data-testid="chat-context-archive"
          >
            <Archive size={14} />
            Archive
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              setConfirmDelete(contextMenu.sessionId);
            }}
            data-testid="chat-context-delete"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && (
        <div className="chat-new-dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="chat-new-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Conversation?</h3>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "16px" }}>
              This action cannot be undone. All messages in this conversation will be permanently deleted.
            </p>
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void handleDelete(confirmDelete)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Thread */}
      <div className="chat-thread">
        {/* Header - always rendered in desktop/tablet, only rendered in mobile when viewing a thread */}
        {(activeSession || !isMobile) && (
          <div className="chat-thread-header">
            {isMobile && activeSession && (
              <button className="btn-icon" onClick={handleBack} data-testid="chat-back-btn">
                <ChevronLeft size={16} />
              </button>
            )}
            <Bot size={16} />
            <span className="chat-thread-header-title">{threadHeaderTitle}</span>
            {showThreadHeaderModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
          </div>
        )}

        {/* Messages */}
        <div className="chat-messages" ref={messagesContainerRef}>
          {messagesLoading ? (
            <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>Loading messages...</div>
          ) : messages.length === 0 && !activeSession ? (
            renderEmptyState()
          ) : messages.length === 0 && activeSession ? (
            <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
              No messages yet. Start the conversation!
            </div>
          ) : (
            <>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`chat-message chat-message--${message.role}`}
                  data-testid={`chat-message-${message.id}`}
                >
                  {message.role === "assistant" && (
                    <div className="chat-message-avatar">
                      <Bot size={14} />
                      <span>{agentName}</span>
                      {showAssistantModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
                    </div>
                  )}
                  <div className="chat-message-content">{renderMessageContent(message.content)}</div>
                  {renderToolCalls(message.toolCalls)}
                  {message.thinkingOutput && (
                    <details className="chat-message-thinking">
                      <summary>Thinking</summary>
                      <pre className="chat-message-thinking-content">{message.thinkingOutput}</pre>
                    </details>
                  )}
                  <div className="chat-message-time">{formatRelativeTime(message.createdAt)}</div>
                </div>
              ))}
              {isStreaming && (
                <div className="chat-message chat-message--assistant chat-message--streaming">
                  <div className="chat-message-avatar">
                    <Bot size={14} />
                    <span>{agentName}</span>
                    {showAssistantModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
                  </div>
                  {streamingText ? (
                    <div className="chat-message-content">{renderMessageContent(streamingText)}</div>
                  ) : (
                    <div className="chat-message-content chat-message-content--waiting">
                      {streamingThinking ? "Thinking…" : "Connecting…"}
                    </div>
                  )}
                  {renderToolCalls(streamingToolCalls)}
                  {streamingThinking && (
                    <details className="chat-message-thinking">
                      <summary>Thinking</summary>
                      <pre className="chat-message-thinking-content">{streamingThinking}</pre>
                    </details>
                  )}
                  <div className="chat-typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        {activeSession && (
          <div className="chat-input-area">
            {showSkillMenu && (
              <div className="chat-skill-menu" data-testid="chat-skill-menu" role="listbox" aria-label="Skill suggestions">
                {skillsLoading ? (
                  <div className="chat-skill-menu-empty">Loading skills…</div>
                ) : filteredSkills.length === 0 ? (
                  <div className="chat-skill-menu-empty">
                    {skillFilter ? "No skills found" : "No skills available"}
                  </div>
                ) : (
                  filteredSkills.map((skill, index) => (
                    <button
                      key={skill.id}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedSkillIndex}
                      className={`chat-skill-menu-item${index === highlightedSkillIndex ? " chat-skill-menu-item--highlighted" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setHighlightedSkillIndex(index)}
                      onClick={() => handleSkillSelect(skill)}
                    >
                      <span className="chat-skill-menu-item-name">{skill.name}</span>
                      <span className="chat-skill-menu-item-description" title={skill.relativePath}>
                        {skill.relativePath}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="chat-input-wrapper">
              <textarea
                ref={inputRef}
                className="chat-input-textarea"
                placeholder="Type a message..."
                value={messageInput}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
                onKeyUp={handleInputKeyUp}
                onClick={handleInputSelectionChange}
                onBlur={handleInputBlur}
                onFocus={handleInputFocus}
                rows={1}
                data-testid="chat-input"
              />
              <AgentMentionPopup
                agents={mentionAgents}
                filter={mentionFilter}
                highlightedIndex={mentionHighlightIndex}
                visible={mentionPopupVisible}
                onSelect={handleMentionSelect}
                position="below"
              />
              <FileMentionPopup
                visible={fileMention.mentionActive && !mentionPopupVisible}
                position={fileMentionPosition}
                files={fileMention.files}
                selectedIndex={fileMention.selectedIndex}
                onSelect={(file) => {
                  const newText = fileMention.selectFile(file, messageInput);
                  setMessageInput(newText);
                  fileMention.dismissMention();
                  setFileMentionPopupVisible(false);
                  inputRef.current?.focus();
                }}
                loading={fileMention.loading}
              />
              {pendingMessage && (
                <div className="chat-pending-message" data-testid="chat-pending-indicator">
                  <span>{`Queued: ${pendingPreview}`}</span>
                  <button
                    type="button"
                    className="chat-pending-message-dismiss"
                    aria-label="Dismiss queued message"
                    data-testid="chat-pending-dismiss"
                    onClick={clearPendingMessage}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
            {isStreaming ? (
              <button
                className="chat-input-stop"
                onClick={stopStreaming}
                aria-label="Stop generation"
                data-testid="chat-stop-btn"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                className="chat-input-send"
                onClick={() => void handleSend()}
                disabled={!messageInput.trim()}
                data-testid="chat-send-btn"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* New Chat Dialog (rendered at root level) */}
      {showNewDialog && (
        <NewChatDialog
          projectId={projectId}
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </div>
  );
}
