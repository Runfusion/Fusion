// ChatView.css is imported eagerly from App.tsx to avoid a flash of
// unstyled content when the lazy chunk loads. Do not re-import here.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  Search,
  Trash2,
  Archive,
  Pencil,
  ChevronLeft,
  Bot,
  Paperclip,
  ChevronDown,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  X,
  Hash,
} from "lucide-react";
import { useChat, type ChatMessageInfo } from "../hooks/useChat";
import { RoomMessageDeliveredButReplyFailedError, useChatRooms } from "../hooks/useChatRooms";
import { useChatUnread } from "../hooks/useChatUnread";
import { useViewportMode } from "./Header";
import { updateGlobalSettings, type DiscoveredSkill } from "../api";
import type { Agent } from "@fusion/core";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { AgentMentionPopup } from "./AgentMentionPopup";
import { AgentAvatar } from "./AgentAvatar";
import { ProviderIcon } from "./ProviderIcon";
import { FileMentionPopup } from "./FileMentionPopup";
import { CreateRoomModal } from "./CreateRoomModal";
import { CliChatSurface, type CliChatTier } from "./CliChatSurface";
import { useFileMention } from "../hooks/useFileMention";
import { useModelsCache } from "../hooks/useModelsCache";
import { useDiscoveredSkillsCache } from "../hooks/useDiscoveredSkillsCache";
import { useAgentsMapCache } from "../hooks/useAgentsMapCache";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileKeyboardViewportLock, isIOS } from "../hooks/useMobileScrollLock";
import { matchesAgentMentionFilter } from "./mentionMatching";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { estimateChatTokens, formatTokenCount } from "../utils/estimateChatTokens";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ViewHeader } from "./ViewHeader";
import {
  StandardChatActionButton,
  StandardChatMessageItem,
  StandardStreamingMessage,
  formatModelTag,
} from "./StandardChatSurface";
import { CHAT_COMMANDS, matchChatCommand, filterChatCommands, getSlashTriggerMatch, type ChatCommand } from "./chat-commands";

/**
 * Optional task-bound context that enables the "/" command registry (e.g.
 * `/steer`) in a ChatView instance. When omitted (the default for the
 * general, non-task-bound Chat surface), the command registry contributes
 * nothing to the "/" menu and dispatch-on-submit is a no-op — skills
 * autocomplete behaves exactly as before.
 */
export interface ChatCommandContext {
  taskId: string;
  projectId?: string;
  /** Whether the bound task currently has a running/active agent. `/steer` is only dispatchable when true. */
  agentRunning: boolean;
}

/**
 * A single entry in the generalized "/" menu — either a registered command
 * (e.g. `/steer`) or a discovered skill. Both kinds share one highlighted
 * index / keyboard-nav path; only their selection behavior differs (a
 * command is inserted as trigger text or dispatched later on submit, a
 * skill is always inserted as a `/skill:<name>` text token).
 */
export type SkillMenuEntry =
  | { kind: "command"; command: ChatCommand; disabled: boolean }
  | { kind: "skill"; skill: DiscoveredSkill };

export interface ChatViewProps {
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error" | "warning") => void;
  experimentalFeatures?: Record<string, boolean>;
  floating?: boolean;
  /** Enables the "/" command registry (e.g. `/steer`) for this composer instance. See {@link ChatCommandContext}. */
  chatCommandContext?: ChatCommandContext;
  /*
  FNXC:RightDockChat 2026-06-27-23:12:
  The right dock can host ChatView in a 360px sidebar while the browser viewport remains desktop-sized. Let dock callers force the same narrow list/detail layout used by mobile/resized floating chat without passing floating chrome callbacks.
  */
  compactLayout?: boolean;
  onPopOut?: () => void;
  onMaximize?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
}

// Keep a generous cap so pasted multi-paragraph text stays visible while
// still preventing the composer from overtaking the message pane on short viewports.
const CHAT_INPUT_MAX_HEIGHT_PX = 640;
const TABLET_INPUT_MAX_HEIGHT_PX = 200;
/** Canonical definition lives in packages/dashboard/src/chat.ts (ROOM_SKIP_SENTINEL). */
const ROOM_SKIP_SENTINEL = "__SKIP__";
let chatViewWasPreviouslyInactive = false;

export function resolveChatInputOverflowY(
  scrollHeight: number,
  maxHeight: number = CHAT_INPUT_MAX_HEIGHT_PX,
): "auto" | "hidden" {
  return scrollHeight > maxHeight ? "auto" : "hidden";
}

export function clampChatInputHeight(scrollHeight: number, maxHeight: number = CHAT_INPUT_MAX_HEIGHT_PX): number {
  // Floor matches QuickChat (clampQuickChatInputHeight) and the CSS min-height,
  // so a 0-scrollHeight measurement (e.g. before layout) still yields a
  // sensible inline height instead of collapsing the composer to 0.
  return Math.max(40, Math.min(scrollHeight, maxHeight));
}

function formatRelativeTime(dateStr: string, t: TFunction<"app">): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return t("chat.relativeTimeJustNow", "just now");
  if (diffMins < 60) return t("chat.relativeTimeMinutes", "{{count}}m ago", { count: diffMins });
  if (diffHours < 24) return t("chat.relativeTimeHours", "{{count}}h ago", { count: diffHours });
  if (diffDays < 7) return t("chat.relativeTimeDays", "{{count}}d ago", { count: diffDays });
  return date.toLocaleDateString();
}

/**
 * Constant agent ID for the built-in fn agent.
 * The chat system always uses createFnAgent with CHAT_SYSTEM_PROMPT regardless
 * of the agentId stored on the session. This ID serves as metadata only.
 */
const FN_AGENT_ID = "__fn_agent__";
const CHAT_SIDEBAR_DEFAULT_WIDTH = 280;
const CHAT_SIDEBAR_MIN_WIDTH = 180;
const CHAT_SIDEBAR_MAX_WIDTH = 500;
const CHAT_SIDEBAR_STORAGE_KEY = "fusion:chat-sidebar-width";
const CHAT_SCOPE_STORAGE_KEY = "fusion:chat-scope";
const CHAT_DRAFT_STORAGE_PREFIX = "fusion:chat-draft:";

function findSubmittedQuestionAnswer(messages: ChatMessageInfo[], messageIndex: number): string | undefined {
  return messages.slice(messageIndex + 1).find((message) => message.role === "user")?.content;
}

function getChatDraftKey(scope: "direct" | "rooms", id: string | null | undefined): string | null {
  if (!id) {
    return null;
  }

  return `${CHAT_DRAFT_STORAGE_PREFIX}${scope}:${id}`;
}

function getPersistedChatDraft(key: string | null): string {
  if (!key) {
    return "";
  }

  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

interface PendingAttachment {
  file: File;
  previewUrl: string;
}

const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "application/json",
  "text/yaml",
  "text/markdown",
  "text/csv",
  "application/xml",
  "text/x-log",
];

/**
 * ChatView's local name for the shared slash-trigger matcher used by both
 * skill autocomplete and the command registry (see chat-commands.ts's
 * `getSlashTriggerMatch` doc comment: this alias exists so there is exactly
 * one implementation of the trigger regex in the dashboard package).
 */
const getSkillTriggerMatch = getSlashTriggerMatch;

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

type DefaultModelSelection = {
  provider: string | null;
  modelId: string | null;
};

type SessionModelSelection = {
  modelProvider?: string | null;
  modelId?: string | null;
};

function getRuntimeConfigModelSelection(agent?: Agent): { provider: string; modelId: string } | null {
  const runtimeConfig = agent?.runtimeConfig;
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    return null;
  }

  const modelProvider = Reflect.get(runtimeConfig, "modelProvider");
  const modelId = Reflect.get(runtimeConfig, "modelId");
  if (typeof modelProvider !== "string" || modelProvider.trim().length === 0) {
    return null;
  }
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    return null;
  }

  return {
    provider: modelProvider,
    modelId,
  };
}

export function resolveSessionProvider(
  session: SessionModelSelection | null | undefined,
  agent: Agent | null | undefined,
  defaults: DefaultModelSelection,
): { provider: string; modelId: string } | null {
  if (session?.modelProvider && session?.modelId) {
    return {
      provider: session.modelProvider,
      modelId: session.modelId,
    };
  }

  const runtimeSelection = getRuntimeConfigModelSelection(agent ?? undefined);
  if (runtimeSelection) {
    return runtimeSelection;
  }

  if (defaults.provider && defaults.modelId) {
    return {
      provider: defaults.provider,
      modelId: defaults.modelId,
    };
  }

  return null;
}

interface NewChatDialogProps {
  projectId?: string;
  defaultModel: DefaultModelSelection;
  onClose: () => void;
  onCreate: (input: { agentId: string; modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
}

function NewChatDialog({ projectId, defaultModel, onClose, onCreate }: NewChatDialogProps) {
  const { t } = useTranslation("app");
  const [chatMode, setChatMode] = useState<"agent" | "model">("agent");
  const { agents, loading: agentsLoading } = useAgentsMapCache(projectId);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const { models, favoriteProviders: cachedFavoriteProviders, favoriteModels: cachedFavoriteModels, loading: modelsLoading, refresh } = useModelsCache();
  const defaultModelValue = defaultModel.provider && defaultModel.modelId
    ? `${defaultModel.provider}/${defaultModel.modelId}`
    : "";
  const [selectedModel, setSelectedModel] = useState<string>(defaultModelValue);
  /*
   * FNXC:Chat-ThinkingLevel 2026-07-10-00:00:
   * New model-mode chats expose the shared inline thinking selector; an empty value means Default and is omitted from the create-session payload so the backend resolves project/global reasoning effort.
   */
  const [thinkingLevel, setThinkingLevel] = useState<string>("");
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>(cachedFavoriteProviders);
  const [favoriteModels, setFavoriteModels] = useState<string[]>(cachedFavoriteModels);

  useEffect(() => {
    setFavoriteProviders(cachedFavoriteProviders);
  }, [cachedFavoriteProviders]);

  useEffect(() => {
    setFavoriteModels(cachedFavoriteModels);
  }, [cachedFavoriteModels]);

  useEffect(() => {
    if (!defaultModelValue) {
      return;
    }
    setSelectedModel((current) => current || defaultModelValue);
  }, [defaultModelValue]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((value) => value !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
      await refresh();
    } catch {
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels, refresh]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((value) => value !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
      await refresh();
    } catch {
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders, refresh]);

  const resolvedModel = selectedModel || defaultModelValue;

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (chatMode === "agent") {
      if (!selectedAgentId) return;
      onCreate({ agentId: selectedAgentId });
      return;
    }

    // model mode
    if (!resolvedModel) return;
    const slashIdx = resolvedModel.indexOf("/");
    if (slashIdx <= 0) return;
    const modelProvider = resolvedModel.slice(0, slashIdx);
    const modelId = resolvedModel.slice(slashIdx + 1);
    onCreate({ agentId: FN_AGENT_ID, modelProvider, modelId, thinkingLevel: thinkingLevel || undefined });
  };

  const isSubmitDisabled =
    chatMode === "agent" ? !selectedAgentId : !resolvedModel;

  return (
    <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="chat-new-dialog chat-view-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("chat.newChatTitle", "New Chat")}</h3>
        <div className="chat-new-dialog-mode-toggle" data-testid="chat-new-dialog-mode-toggle">
          <button
            type="button"
            className={`chat-new-dialog-mode-btn${chatMode === "agent" ? " chat-new-dialog-mode-btn--active" : ""}`}
            data-testid="chat-new-dialog-mode-agent"
            onClick={() => {
              setChatMode("agent");
            }}
          >
            {t("chat.newChatModeAgent", "Agent")}
          </button>
          <button
            type="button"
            className={`chat-new-dialog-mode-btn${chatMode === "model" ? " chat-new-dialog-mode-btn--active" : ""}`}
            data-testid="chat-new-dialog-mode-model"
            onClick={() => {
              setChatMode("model");
              setSelectedAgentId("");
              setSelectedModel((current) => current || defaultModelValue);
            }}
          >
            {t("chat.newChatModeModel", "Model")}
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          {chatMode === "agent" && (
            <label className="chat-new-dialog-model-label">
              {t("chat.newChatModeAgent", "Agent")}
              {agentsLoading ? (
                <div className="chat-new-dialog-loading">{t("chat.loadingAgents", "Loading agents...")}</div>
              ) : agents.length === 0 ? (
                <div className="chat-new-dialog-empty">{t("chat.noAgentsAvailable", "No agents available")}</div>
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
                <div className="chat-new-dialog-loading">{t("chat.loadingModels", "Loading models...")}</div>
              ) : (
                <CustomModelDropdown
                  models={models}
                  value={selectedModel}
                  onChange={setSelectedModel}
                  label={t("chat.newChatModeModel", "Model")}
                  placeholder={t("chat.selectModel", "Select a model")}
                  favoriteProviders={favoriteProviders}
                  onToggleFavorite={handleToggleFavorite}
                  favoriteModels={favoriteModels}
                  onToggleModelFavorite={handleToggleModelFavorite}
                  showThinkingLevel
                  thinkingLevel={thinkingLevel}
                  onThinkingLevelChange={setThinkingLevel}
                  defaultThinkingLevel="off"
                />
              )}
            </div>
          )}
          <div className="chat-new-dialog-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              {t("chat.cancel", "Cancel")}
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={isSubmitDisabled}
            >
              {t("chat.create", "Create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



type CopyFeedbackState = "success" | "error" | null;

interface RoomContext {
  roomId: string;
  roomName: string;
  memberIds: ReadonlySet<string>;
}

export function ChatView({ projectId, addToast, floating = false, compactLayout = false, onPopOut, onMaximize, onMinimize, onClose, chatCommandContext }: ChatViewProps) {
  const { t } = useTranslation("app");
  useEffect(() => {
    recordResumeEvent({
      view: "ChatView",
      trigger: chatViewWasPreviouslyInactive ? "route-active" : "remount",
      projectId,
      replayAttempted: false,
    });
    chatViewWasPreviouslyInactive = false;

    return () => {
      chatViewWasPreviouslyInactive = true;
      recordResumeEvent({
        view: "ChatView",
        trigger: "route-inactive",
        projectId,
        replayAttempted: false,
      });
    };
  }, [projectId]);

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
    renameSession,
    deleteSession,
    sendMessage,
    editMessageAndResend,
    stopStreaming,
    pendingMessages,
    clearPendingMessage,
    loadMoreMessages,
    hasMoreMessages,
    searchQuery,
    setSearchQuery,
    filteredSessions,
    agentsMap: chatAgentsMap,
  } = useChat(projectId, addToast);

  const [showNewDialog, setShowNewDialog] = useState(false);
  /* FNXC:ChatRooms 2026-06-23-01:28: Chat Rooms graduated from Experimental; stale false flags should not hide rooms in the main view, popout modal, or quick-chat surfaces. */
  const chatRoomsEnabled = true;
  const [chatScope, setChatScope] = useState<"direct" | "rooms">(() => {
    try {
      const persistedScope = localStorage.getItem(CHAT_SCOPE_STORAGE_KEY);
      if (persistedScope === "rooms" && chatRoomsEnabled) {
        return "rooms";
      }
    } catch {
      // Ignore storage errors.
    }

    return "direct";
  });
  // Keep this hook unconditional to preserve hook ordering and test stability.
  // Rooms UI and interactions are fully gated by `chatRoomsEnabled`.
  const rooms = useChatRooms(projectId, addToast);
  const { isUnread, markRead } = useChatUnread(projectId);
  const [messageInput, setMessageInput] = useState(() => {
    const initialDraftKey = getChatDraftKey(
      chatScope,
      chatScope === "rooms" ? rooms.activeRoom?.id : activeSession?.id,
    );
    return getPersistedChatDraft(initialDraftKey);
  });
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ sessionId: string; title: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteRoomId, setConfirmDeleteRoomId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(CHAT_SIDEBAR_DEFAULT_WIDTH);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const { agentsMap: cachedAgentsMap } = useAgentsMapCache(projectId);
  const agentsMap = useMemo(() => (chatAgentsMap.size > 0 ? chatAgentsMap : cachedAgentsMap), [cachedAgentsMap, chatAgentsMap]);
  const { models, defaultProvider, defaultModelId } = useModelsCache();
  const defaultModel = useMemo<DefaultModelSelection>(() => ({ provider: defaultProvider, modelId: defaultModelId }), [defaultModelId, defaultProvider]);
  const { skills: discoveredSkills, loading: skillsLoading } = useDiscoveredSkillsCache(projectId);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionPopupVisible, setMentionPopupVisible] = useState(false);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  // FNXC:ChatRenderToggle 2026-07-04-00:00: The markdown/plain eye toggle
  // (showAllAsPlain / toggleAllAsPlain) was removed per FN-7541. Chat always
  // renders Markdown now; forcePlain is hardcoded to false everywhere below.
  // Attachment state mirrors QuickEntryBox: pending files selected before send.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [copyFeedbackByMessageId, setCopyFeedbackByMessageId] = useState<Record<string, CopyFeedbackState>>({});
  const [mobileSessionMenuOpen, setMobileSessionMenuOpen] = useState(false);
  const [roomSwitcherOpen, setRoomSwitcherOpen] = useState(false);
  const { pushNav } = useNavigationHistoryContext();

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
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const mobileSessionMenuRef = useRef<HTMLDivElement>(null);
  const roomSwitcherRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const lastAnchoredThreadStateRef = useRef<{ threadId: string; loaded: boolean; hasMessages: boolean } | null>(null);
  const previousChatScopeRef = useRef<"direct" | "rooms" | null>(null);
  const directThreadDeferredAnchorTimeoutRef = useRef<number | null>(null);
  const lastMessageCountRef = useRef(0);
  const lastThreadIdRef = useRef<string | null>(null);
  const scrollRestoreSnapshotRef = useRef<{
    threadId: string;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    anchorMessageId: string | null;
    anchorOffset: number;
    wasPinnedBefore: boolean;
    capturedAtMs: number;
  } | null>(null);
  const hideSkillMenuTimeoutRef = useRef<number | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  // FN-5365: mirror QuickChat's mid-dismiss suppress gate so transient
  // visualViewport shrink samples do not jerk the chat thread/composer.
  const suppressVvShrinkRef = useRef(false);
  const suppressVvShrinkTimeoutRef = useRef<number | null>(null);
  // Deferred drift-reset scheduled on blur; cancelled on the next focus so a
  // quick re-tap never scrolls the document while iOS is raising the keyboard.
  const blurScrollResetTimeoutRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const mentionCursorPosRef = useRef(0);
  const copyFeedbackTimeoutsRef = useRef<Map<string, number>>(new Map());
  const roomSendInFlightRef = useRef(false);
  /*
  FNXC:ChatSendDedupe 2026-06-17-08:36:
  FN-6576 refines FN-6563 by matching QuickChatFAB's two-latch touch contract: pointerdown/touchstart claim a per-input-task gesture so one mobile tap sends exactly once, while the separate 700ms latch is consumed only by a trailing click. A suppressed iOS click must never leave the long latch blocking the next tap; a send-to-stop DOM swap must consume the trailing click without swallowing a genuine later stop tap.
  */
  const mode = useViewportMode();
  const isMobile = mode === "mobile";
  const isTablet = mode === "tablet";
  const chatViewRef = useRef<HTMLDivElement>(null);
  const [floatingNarrow, setFloatingNarrow] = useState(false);
  /*
  FNXC:ChatModal 2026-06-22-14:38:
  The popped-out full Chat modal is resizable, so responsive behavior must follow the modal's own width, not only the browser viewport. When the floating Chat surface narrows to mobile width, switch to the mobile list/detail layout and hide the sidebar after a chat is opened.
  */
  useLayoutEffect(() => {
    if (!floating) {
      setFloatingNarrow(false);
      return;
    }

    const element = chatViewRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const update = () => {
      setFloatingNarrow(element.getBoundingClientRect().width <= 768);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [floating]);
  const isChatMobile = isMobile || floatingNarrow || compactLayout;

  useEffect(() => {
    if (!activeSession?.id) {
      return;
    }

    markRead("direct", activeSession.id, activeSession.lastMessageAt ?? activeSession.updatedAt);
  }, [activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, markRead]);

  useEffect(() => {
    if (!rooms.activeRoom?.id) {
      return;
    }

    markRead("room", rooms.activeRoom.id, rooms.activeRoom.updatedAt);
  }, [rooms.activeRoom?.id, rooms.activeRoom?.updatedAt, markRead]);

  useEffect(() => {
    if (!activeSession?.id || messages.length === 0) {
      return;
    }

    const latestMessage = messages[messages.length - 1];
    markRead("direct", activeSession.id, latestMessage?.createdAt ?? activeSession.lastMessageAt ?? activeSession.updatedAt);
  }, [activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, markRead, messages]);

  useEffect(() => {
    if (!rooms.activeRoom?.id || rooms.messages.length === 0) {
      return;
    }

    const latestMessage = rooms.messages[rooms.messages.length - 1];
    markRead("room", rooms.activeRoom.id, latestMessage?.createdAt ?? rooms.activeRoom.updatedAt);
  }, [markRead, rooms.activeRoom?.id, rooms.activeRoom?.updatedAt, rooms.messages]);

  useEffect(() => {
    try {
      const rawWidth = localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY);
      if (!rawWidth) return;
      const parsedWidth = Number.parseInt(rawWidth, 10);
      if (Number.isNaN(parsedWidth)) return;
      const clampedWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, parsedWidth));
      setSidebarWidth(clampedWidth);
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useEffect(() => {
    try {
      const persistedScope = localStorage.getItem(CHAT_SCOPE_STORAGE_KEY);
      if (persistedScope === "direct") {
        setChatScope("direct");
        return;
      }
      if (persistedScope === "rooms" && chatRoomsEnabled) {
        setChatScope("rooms");
      }
    } catch {
      // Ignore storage errors.
    }
  }, [chatRoomsEnabled]);

  useEffect(() => {
    if (!chatRoomsEnabled && chatScope === "rooms") {
      setChatScope("direct");
      return;
    }
    try {
      localStorage.setItem(CHAT_SCOPE_STORAGE_KEY, chatScope);
    } catch {
      // Ignore storage errors.
    }
  }, [chatRoomsEnabled, chatScope]);

  const activeDraftKey = getChatDraftKey(
    chatScope,
    chatScope === "rooms" ? rooms.activeRoom?.id : activeSession?.id,
  );
  const lastDraftKeyRef = useRef<string | null>(activeDraftKey);

  useEffect(() => {
    if (activeDraftKey === lastDraftKeyRef.current) {
      return;
    }

    lastDraftKeyRef.current = activeDraftKey;
    setMessageInput(getPersistedChatDraft(activeDraftKey));
  }, [activeDraftKey]);

  useEffect(() => {
    if (!activeDraftKey || lastDraftKeyRef.current !== activeDraftKey) {
      return;
    }

    try {
      if (messageInput) {
        localStorage.setItem(activeDraftKey, messageInput);
        return;
      }
      localStorage.removeItem(activeDraftKey);
    } catch {
      // Ignore storage errors.
    }
  }, [activeDraftKey, messageInput]);

  const roomThreadActive = chatRoomsEnabled && chatScope === "rooms" && !!rooms.activeRoom;
  const { keyboardOverlap, keyboardOpen } = useMobileKeyboard({
    enabled: (isChatMobile || isTablet) && (!!activeSession || roomThreadActive),
    allowNonMobileViewport: isTablet,
  });
  const tabletKeyboardOpen = isTablet && keyboardOpen;

  const filteredSkills = useMemo(() => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    const matchingSkills = normalizedFilter
      ? discoveredSkills.filter((skill) => skill.name.toLowerCase().includes(normalizedFilter))
      : discoveredSkills;
    return matchingSkills.slice(0, 10);
  }, [discoveredSkills, skillFilter]);

  // Commands only contribute to the "/" menu when this ChatView instance is
  // bound to a task (chatCommandContext provided) — the general, non-task-bound
  // Chat surface never shows/dispatches them, so its skill-only behavior is unchanged.
  const filteredCommands = useMemo(() => {
    if (!chatCommandContext) return [] as ChatCommand[];
    return filterChatCommands(skillFilter, CHAT_COMMANDS);
  }, [chatCommandContext, skillFilter]);

  const skillMenuEntries = useMemo<SkillMenuEntry[]>(() => {
    const commandEntries: SkillMenuEntry[] = filteredCommands.map((command) => ({
      kind: "command",
      command,
      disabled: !chatCommandContext?.agentRunning,
    }));
    const skillEntries: SkillMenuEntry[] = filteredSkills.map((skill) => ({ kind: "skill", skill }));
    return [...commandEntries, ...skillEntries];
  }, [filteredCommands, filteredSkills, chatCommandContext]);

  const mentionAgents = useMemo(() => Array.from(agentsMap.values()), [agentsMap]);

  const roomContext = useMemo<RoomContext | null>(() => {
    if (!chatRoomsEnabled || chatScope !== "rooms" || !rooms.activeRoom) {
      return null;
    }
    return {
      roomId: rooms.activeRoom.id,
      roomName: rooms.activeRoom.name,
      memberIds: new Set(rooms.activeRoomMembers.map((member) => member.agentId)),
    };
  }, [chatRoomsEnabled, chatScope, rooms.activeRoom, rooms.activeRoomMembers]);

  const filteredMentionAgents = useMemo(() => {
    const matchingAgents = mentionAgents.filter((agent) => matchesAgentMentionFilter(agent.name, mentionFilter));
    if (!roomContext) {
      return matchingAgents;
    }

    const memberAgents = matchingAgents.filter((agent) => roomContext.memberIds.has(agent.id));
    if (mentionFilter.trim().length === 0) {
      return memberAgents;
    }

    const otherAgents = matchingAgents.filter((agent) => !roomContext.memberIds.has(agent.id));
    return [...memberAgents, ...otherAgents];
  }, [mentionAgents, mentionFilter, roomContext]);

  const mentionAgentsByName = useMemo(() => {
    const byName = new Map<string, Agent>();
    for (const agent of mentionAgents) {
      byName.set(agent.name.toLowerCase(), agent);
    }
    return byName;
  }, [mentionAgents]);

  // Key the reset on skill ids, not array identity: useDiscoveredSkillsCache
  // (SWR) re-delivers content-identical lists with fresh identities (cache
  // reads re-parse; revalidation notifies a new array). Resetting on identity
  // alone wipes the user's keyboard highlight mid-navigation when a
  // revalidation lands — only a *semantic* list change should reset it.
  const filteredSkillsKey = useMemo(
    () => filteredSkills.map((skill) => skill.id).join(" "),
    [filteredSkills],
  );
  useEffect(() => {
    setHighlightedSkillIndex(0);
  }, [filteredSkillsKey]);

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

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !hasMoreMessages || messagesLoading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          void loadMoreMessages();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreMessages, messagesLoading, loadMoreMessages]);

  const getActiveThreadId = useCallback(() => {
    return roomThreadActive ? (rooms.activeRoom?.id ?? null) : (activeSession?.id ?? null);
  }, [roomThreadActive, rooms.activeRoom?.id, activeSession?.id]);

  const getMessageElement = useCallback((container: HTMLElement, messageId: string) => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return container.querySelector<HTMLElement>(`.chat-message[data-message-id="${CSS.escape(messageId)}"]`);
    }
    return container.querySelector<HTMLElement>(`.chat-message[data-message-id="${messageId.replace(/"/g, "\\\"")}"]`);
  }, []);

  const captureScrollSnapshot = useCallback(() => {
    const messagesContainer = messagesContainerRef.current;
    const threadId = getActiveThreadId();
    if (!messagesContainer || !threadId) return;

    const scrollTop = messagesContainer.scrollTop;
    const messageElements = messagesContainer.querySelectorAll<HTMLElement>(".chat-message[data-message-id]");
    const anchorMessage = Array.from(messageElements).find((element) => element.offsetTop + element.offsetHeight >= scrollTop)
      ?? messageElements[0]
      ?? null;
    const anchorMessageId = anchorMessage?.getAttribute("data-message-id") ?? null;
    const anchorOffset = anchorMessage ? anchorMessage.offsetTop - scrollTop : 0;

    scrollRestoreSnapshotRef.current = {
      threadId,
      scrollTop,
      scrollHeight: messagesContainer.scrollHeight,
      clientHeight: messagesContainer.clientHeight,
      anchorMessageId,
      anchorOffset,
      wasPinnedBefore: !isUserScrollingRef.current,
      capturedAtMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
    };
  }, [getActiveThreadId]);

  const updateScrollState = useCallback(() => {
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;

    const threshold = 50;
    const atBottom = messagesContainer.scrollTop + messagesContainer.clientHeight >= messagesContainer.scrollHeight - threshold;
    setIsUserScrolling(!atBottom);
    isUserScrollingRef.current = !atBottom;
    captureScrollSnapshot();
  }, [captureScrollSnapshot]);

  const anchorToBottom = useCallback((container: HTMLElement, options?: { force?: boolean }) => {
    if (!container.isConnected) return;
    if (!options?.force && isUserScrollingRef.current) {
      return;
    }

    let frame = 0;
    let stableFrames = 0;
    let lastScrollHeight = -1;
    const maxFrames = 6;

    const writeBottom = () => {
      if (!container.isConnected) return;
      if (!options?.force && isUserScrollingRef.current) {
        return;
      }

      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastScrollHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastScrollHeight = container.scrollHeight;
      }

      frame += 1;
      if (frame >= maxFrames || stableFrames >= 2) {
        setIsUserScrolling(false);
        isUserScrollingRef.current = false;
        return;
      }

      window.requestAnimationFrame(writeBottom);
    };

    writeBottom();
  }, []);

  const activeThreadMessages = roomThreadActive ? rooms.messages : messages;

  useLayoutEffect(() => {
    const messagesContainer = messagesContainerRef.current;
    const threadId = getActiveThreadId();
    const snapshot = scrollRestoreSnapshotRef.current;
    if (!messagesContainer || !threadId || !snapshot || snapshot.threadId !== threadId || snapshot.wasPinnedBefore) {
      return;
    }

    const snapshotAgeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - snapshot.capturedAtMs;
    const hasScrollableOverflow = messagesContainer.scrollHeight > messagesContainer.clientHeight;
    const isStaleSnapshot = snapshotAgeMs > 3000;
    const isLikelyInvalidTopSample = snapshot.scrollTop <= 0 && snapshot.anchorOffset <= 0 && hasScrollableOverflow;
    if (!isUserScrollingRef.current || isStaleSnapshot || isLikelyInvalidTopSample) {
      scrollRestoreSnapshotRef.current = null;
      return;
    }

    let restoredScrollTop = snapshot.scrollTop;
    if (snapshot.anchorMessageId) {
      const anchorElement = getMessageElement(messagesContainer, snapshot.anchorMessageId);
      if (anchorElement) {
        restoredScrollTop = anchorElement.offsetTop - snapshot.anchorOffset;
      } else {
        restoredScrollTop = snapshot.scrollTop + (messagesContainer.scrollHeight - snapshot.scrollHeight);
      }
    } else {
      restoredScrollTop = snapshot.scrollTop + (messagesContainer.scrollHeight - snapshot.scrollHeight);
    }

    messagesContainer.scrollTop = Math.max(0, restoredScrollTop);
    isUserScrollingRef.current = true;
    setIsUserScrolling(true);
    scrollRestoreSnapshotRef.current = null;
  }, [activeThreadMessages, getActiveThreadId, getMessageElement]);

  const logScrollDebug = useCallback((cause: string) => {
    if (typeof window === "undefined") {
      return;
    }
    if (process.env.NODE_ENV === "production" || !(window as unknown as { FN_5380_DEBUG?: boolean }).FN_5380_DEBUG) {
      return;
    }
    const container = messagesContainerRef.current;
    const threshold = 50;
    const atBottom = container
      ? container.scrollTop + container.clientHeight >= container.scrollHeight - threshold
      : true;
    console.debug("[chat-scroll]", {
      cause,
      wasPinnedBefore: !isUserScrollingRef.current,
      atBottomNow: atBottom,
      messageCount: activeThreadMessages.length,
      roomThreadActive,
    });
  }, [activeThreadMessages.length, roomThreadActive]);

  const scrollToBottom = useCallback((cause: string) => {
    logScrollDebug(cause);
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;
    // Cancel any pending scroll restoration so it doesn't override the explicit jump-to-bottom.
    scrollRestoreSnapshotRef.current = null;
    isUserScrollingRef.current = false;
    anchorToBottom(messagesContainer);
  }, [anchorToBottom, logScrollDebug]);

  useLayoutEffect(() => {
    if (directThreadDeferredAnchorTimeoutRef.current !== null) {
      window.clearTimeout(directThreadDeferredAnchorTimeoutRef.current);
      directThreadDeferredAnchorTimeoutRef.current = null;
    }

    const threadId = roomThreadActive ? (rooms.activeRoom?.id ?? null) : (activeSession?.id ?? null);
    if (!threadId) {
      lastAnchoredThreadStateRef.current = null;
      return;
    }

    const nextState = {
      threadId,
      loaded: roomThreadActive ? !rooms.messagesLoading : !messagesLoading,
      hasMessages: roomThreadActive ? rooms.messages.length > 0 : messages.length > 0,
    };
    const previousState = lastAnchoredThreadStateRef.current;
    const isThreadChanged = previousState?.threadId !== threadId;
    const finishedLoading = previousState?.threadId === threadId && !previousState.loaded && nextState.loaded;
    const firstMessagesArrived =
      previousState?.threadId === threadId && !previousState.hasMessages && nextState.hasMessages;

    const shouldAnchor = previousState === null || isThreadChanged || finishedLoading || firstMessagesArrived;
    if (!shouldAnchor) {
      return;
    }

    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    logScrollDebug(isThreadChanged ? "thread-change" : finishedLoading ? "finished-loading" : firstMessagesArrived ? "first-messages" : "mount");
    anchorToBottom(messagesContainer, { force: true });
    if (!roomThreadActive) {
      directThreadDeferredAnchorTimeoutRef.current = window.setTimeout(() => {
        directThreadDeferredAnchorTimeoutRef.current = null;
        if (isUserScrollingRef.current) {
          return;
        }
        const latestContainer = messagesContainerRef.current;
        if (!latestContainer) {
          return;
        }
        anchorToBottom(latestContainer);
      }, 250);
    }
    lastAnchoredThreadStateRef.current = nextState;

    return () => {
      if (directThreadDeferredAnchorTimeoutRef.current !== null) {
        window.clearTimeout(directThreadDeferredAnchorTimeoutRef.current);
        directThreadDeferredAnchorTimeoutRef.current = null;
      }
    };
  }, [
    roomThreadActive,
    rooms.activeRoom?.id,
    rooms.messages.length,
    rooms.messagesLoading,
    activeSession?.id,
    messages.length,
    messagesLoading,
    anchorToBottom,
  ]);

  // Scroll thread container to bottom during streaming only when already pinned.
  useEffect(() => {
    if (!isStreaming || isUserScrollingRef.current) {
      return;
    }
    scrollToBottom("streaming");
  }, [isStreaming, streamingText, streamingThinking, scrollToBottom]);

  // Snap to latest on new messages only when the user was pinned before growth.
  useEffect(() => {
    const threadId = getActiveThreadId();
    if (!threadId) {
      lastMessageCountRef.current = 0;
      lastThreadIdRef.current = null;
      return;
    }

    if (lastThreadIdRef.current !== threadId) {
      lastThreadIdRef.current = threadId;
      lastMessageCountRef.current = activeThreadMessages.length;
      return;
    }

    const previousCount = lastMessageCountRef.current;
    const nextCount = activeThreadMessages.length;
    const didGrow = nextCount > previousCount;
    const wasPinnedBefore = !isUserScrollingRef.current;

    lastMessageCountRef.current = nextCount;

    if (didGrow && wasPinnedBefore) {
      scrollToBottom("new-message");
    }
  }, [activeThreadMessages, getActiveThreadId, scrollToBottom]);

  useEffect(() => {
    if (keyboardOverlap <= 0) {
      return;
    }

    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    scrollToBottom("keyboard");
  }, [keyboardOverlap, scrollToBottom]);

  // Lock body scroll on mobile while the keyboard is up so iOS can't shift
  // the visual viewport (offsetTop > 0). Uses the overflow-only keyboard
  // lock (NOT position:fixed): the composer is focused before the lock
  // applies, and pinning body to position:fixed afterwards blurs the input
  // on iOS, collapsing the keyboard the instant it opens. Restores
  // window.scrollTo(0, 0) on cleanup to recover from any iOS drift.
  useMobileKeyboardViewportLock(isMobile && keyboardOpen);

  // FN-5365: mirror QuickChatFAB keyboard handling by writing visualViewport
  // metrics directly to .chat-thread, avoiding React commit lag/jitter.
  useLayoutEffect(() => {
    if (!isMobile || (!activeSession && !roomThreadActive)) return;
    if (typeof window === "undefined") return;

    const thread = chatThreadRef.current;
    const vv = window.visualViewport;
    if (!thread || !vv) return;

    const isKeyboardTrackingFocusable = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.tagName === "TEXTAREA") return true;
      if (element.tagName !== "INPUT") return false;
      const inputType = (element as HTMLInputElement).type.toLowerCase();
      return ["", "text", "search", "email", "url", "tel", "password", "number"].includes(inputType);
    };

    const apply = () => {
      if (suppressVvShrinkRef.current) {
        thread.classList.remove("chat-thread--keyboard-active");
        thread.style.setProperty("--chat-keyboard-accessory-clearance", "0px");
        thread.style.transform = "";
        thread.style.willChange = "";
        return;
      }
      const overlap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      const offsetTop = vv.offsetTop || 0;
      thread.style.setProperty("--vv-height", `${vv.height}px`);
      thread.style.setProperty("--vv-offset-top", `${offsetTop}px`);
      thread.style.setProperty("--keyboard-overlap", `${overlap}px`);

      const keyboardActive = (overlap > 0 || offsetTop > 0) && isKeyboardTrackingFocusable(document.activeElement);
      thread.classList.toggle("chat-thread--keyboard-active", keyboardActive);
      /*
      FNXC:ChatComposer 2026-07-04-09:42:
      Mobile Chat's composer must stay fully visible above the soft keyboard and the iOS input-assistant/autofill bar, which Safari does not subtract from visualViewport.height. Keep the clearance ChatView-local and keyed to iOS keyboard-active state so the shared keyboard hook contract stays stable, .chat-thread does not gain a persistent transform (anti-blur invariant), and Android resizes-content does not regain an empty reserved gap.
      */
      thread.style.setProperty(
        "--chat-keyboard-accessory-clearance",
        keyboardActive && isIOS() ? "calc(var(--space-2xl) + var(--space-md))" : "0px",
      );

      // Drift compensation is applied here (not in CSS) so .chat-thread —
      // an ancestor of the focused composer textarea — only gets a
      // non-`none` transform when iOS actually shifts the visual viewport
      // (offsetTop > 0). Keeping a transform/will-change on it at all times
      // (as the old CSS did) makes iOS Safari blur the input and collapse
      // the keyboard the moment it opens, because at focus time offsetTop
      // is 0 and translateY(0) still establishes a containing block over
      // the focused element.
      if (keyboardActive && offsetTop > 0) {
        thread.style.transform = `translateY(${offsetTop}px)`;
        thread.style.willChange = "transform";
      } else {
        thread.style.transform = "";
        thread.style.willChange = "";
      }
    };

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    document.addEventListener("focusin", apply);
    document.addEventListener("focusout", apply);
    window.addEventListener("pageshow", apply);
    document.addEventListener("visibilitychange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", apply);
      window.removeEventListener("pageshow", apply);
      document.removeEventListener("visibilitychange", apply);
      thread.classList.remove("chat-thread--keyboard-active");
      thread.style.setProperty("--chat-keyboard-accessory-clearance", "0px");
      thread.style.transform = "";
      thread.style.willChange = "";
    };
  }, [activeSession, isMobile, roomThreadActive]);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  // While the keyboard is up on mobile, block touchmove gestures that
  // would otherwise pan the iOS visualViewport (or scroll the document)
  // and let the composer / header drift. We attach a non-passive listener
  // to document so that gestures starting anywhere — header, composer
  // padding, body — are cancelled. The exception is when the touch path
  // crosses the messages list, which is the one place we DO want pan-y.
  // useMobileScrollLock only pins document scroll; this complements it
  // by stopping vv pan on top of the locked layout.
  // React's synthetic onTouchMove is passive by default, so this has to
  // be a native addEventListener with { passive: false }.
  useEffect(() => {
    if (!isMobile || !keyboardOpen) return;
    const onTouchMove = (event: TouchEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".chat-messages")) return; // allow messages scroll
      event.preventDefault();
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, [isMobile, keyboardOpen]);

  // NOTE: a previous iOS-only "resync" effect here force-blurred and
  // re-focused the active textarea on visibilitychange/pageshow to nudge
  // iOS out of a stuck visualViewport half-state (composer pushed up /
  // blank pane). It was removed because it was the cause of the iOS
  // "keyboard won't stay up" bug: the effect only ever ran while the
  // composer was already focused (its `document.activeElement !== ta`
  // guard), and on iOS a programmatic focus() fired from setTimeout has
  // no user-gesture context, so it cannot re-raise the keyboard after the
  // blur(). In practice it never resynced the keyboard up — it only
  // dismissed it whenever iOS emitted a visibilitychange (Control Center,
  // notification banners, app switches, etc.) mid-session.
  //
  // The visualViewport half-state it targeted is now owned by
  // useMobileKeyboard, which re-snapshots vv metrics on
  // visibilitychange/pageshow via its settle tail + rAF stability poll —
  // without ever touching textarea focus. Do not reintroduce a
  // blur()+focus() resync here.

  useEffect(() => {
    const previousScope = previousChatScopeRef.current;
    previousChatScopeRef.current = chatScope;

    if (chatScope === "rooms" && !rooms.activeRoom) {
      lastAnchoredThreadStateRef.current = null;
      return;
    }

    const enteredDirect =
      chatScope === "direct" &&
      (previousScope === null || previousScope === "rooms");
    const enteredRooms =
      chatScope === "rooms" &&
      (previousScope === null || previousScope === "direct");

    if (!enteredDirect && !enteredRooms) {
      return;
    }

    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    anchorToBottom(messagesContainer, { force: true });
    isUserScrollingRef.current = false;
    setIsUserScrolling(false);
  }, [chatScope, rooms.activeRoom, anchorToBottom]);

  useEffect(() => {
    if (!activeSession && !roomThreadActive) {
      return;
    }
    if (roomThreadActive && !isChatMobile) {
      return;
    }

    const captureForRefetch = () => {
      const wasPinnedBefore = !isUserScrollingRef.current;
      captureScrollSnapshot();
      if (wasPinnedBefore && isChatMobile && messagesContainerRef.current) {
        scrollToBottom("visibility-restore");
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      captureForRefetch();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", captureForRefetch);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", captureForRefetch);
    };
  }, [isChatMobile, isMobile, activeSession, roomThreadActive, captureScrollSnapshot, scrollToBottom]);

  useEffect(() => {
    if (roomThreadActive) {
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (isUserScrollingRef.current) {
        return;
      }
      anchorToBottom(messagesContainer);
    });

    observer.observe(messagesContainer);

    return () => {
      observer.disconnect();
    };
  }, [roomThreadActive, anchorToBottom, activeSession?.id, chatScope]);

  // Fetch agents on mount for name resolution (project-scoped with stale-request protection)
  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      for (const attachment of pendingAttachmentsRef.current) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      for (const timeoutId of copyFeedbackTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      copyFeedbackTimeoutsRef.current.clear();
    };
  }, []);

  const handleAttachmentFiles = useCallback((files: FileList | File[] | null | undefined) => {
    if (!files || files.length === 0) return;

    const nextAttachments: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
        continue;
      }
      const isImage = file.type.startsWith("image/");
      nextAttachments.push({
        file,
        previewUrl: isImage ? URL.createObjectURL(file) : "",
      });
    }

    if (nextAttachments.length > 0) {
      setPendingAttachments((prev) => [...prev, ...nextAttachments]);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => {
      const attachment = prev[index];
      if (attachment?.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return prev.filter((_, attachmentIndex) => attachmentIndex !== index);
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = event.clipboardData?.files;
    if (!clipboardFiles || clipboardFiles.length === 0) return;
    const imageFiles = Array.from(clipboardFiles).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    handleAttachmentFiles(imageFiles);
  }, [handleAttachmentFiles]);

  // Handle create session
  const handleCreateSession = useCallback(
    async (input: { agentId: string; modelProvider?: string; modelId?: string; thinkingLevel?: string }) => {
      try {
        await createSession(input);
        setShowNewDialog(false);
        // On mobile, hide sidebar after selecting
        if (isChatMobile) setSidebarVisible(false);
      } catch {
        addToast(t("chat.failedToCreateSession", "Failed to create chat session"), "error");
      }
    },
    [createSession, addToast, isChatMobile],
  );

  const resizeComposer = useCallback((textarea?: HTMLTextAreaElement | null) => {
    const composer = textarea ?? inputRef.current;
    if (!composer) {
      return;
    }

    const effectiveMax = mode === "tablet" ? TABLET_INPUT_MAX_HEIGHT_PX : CHAT_INPUT_MAX_HEIGHT_PX;

    composer.style.height = "auto";
    composer.style.height = `${clampChatInputHeight(composer.scrollHeight, effectiveMax)}px`;
    composer.style.overflowY = resolveChatInputOverflowY(composer.scrollHeight, effectiveMax);
  }, [mode]);

  const handleComposerRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    inputRef.current = textarea;
    if (!textarea) {
      return;
    }

    resizeComposer(textarea);
  }, [resizeComposer]);

  useLayoutEffect(() => {
    resizeComposer();
  }, [chatScope, messageInput, activeSession?.id, rooms.activeRoom?.id, resizeComposer]);

  const clearComposerState = useCallback(() => {
    setMessageInput("");
    if (activeDraftKey) {
      try {
        localStorage.removeItem(activeDraftKey);
      } catch {
        // Ignore storage errors.
      }
    }
    setShowSkillMenu(false);
    setSkillFilter("");
    setMentionPopupVisible(false);
    setMentionFilter("");
    setMentionStartPos(-1);
    setPendingAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return [];
    });
  }, [activeDraftKey]);

  // Handle send message including pending attachment uploads.
  const handleSend = useCallback(() => {
    const trimmed = messageInput.trim();
    const files = pendingAttachments.map((attachment) => attachment.file);
    if ((!trimmed && files.length === 0) || !activeSession) return;

    if (chatCommandContext) {
      const commandMatch = matchChatCommand(trimmed, CHAT_COMMANDS);
      if (commandMatch) {
        if (!chatCommandContext.agentRunning) {
          // Do not silently fall back to a normal chat message: /steer with no
          // running agent is a no-op with feedback, not a plain send.
          addToast(t("chat.commandNoRunningAgent", "No running agent to steer"), "warning");
          return;
        }

        /*
        FNXC:ChatSlashCommands 2026-07-10-11:40:
        Slash commands carry no attachments. Block dispatch (rather than silently dropping) when files are staged, since clearing the composer below revokes their object URLs before they could ever be sent.
        */
        if (files.length > 0) {
          addToast(
            t("chat.commandNoAttachments", "Attachments aren't supported with commands — remove them before sending"),
            "warning",
          );
          return;
        }

        /*
        FNXC:ChatSlashCommands 2026-07-10-11:40:
        Clear the composer immediately on submit — BEFORE the network round-trip — not inside the success callback. Clearing late wipes any text the user typed while the command was in flight (composer-wipe race, FUX-015).
        */
        clearComposerState();
        void commandMatch.command
          .run({
            taskId: chatCommandContext.taskId,
            projectId: chatCommandContext.projectId,
            remainder: commandMatch.remainder,
          })
          .then(() => {
            addToast(t("chat.commandSteerSuccess", "Sent to the running agent"), "success");
          })
          .catch((error: unknown) => {
            const message = error instanceof Error && error.message.trim()
              ? error.message
              : t("chat.commandSteerFailed", "Failed to send to the running agent");
            addToast(message, "error");
          });
        return;
      }
    }

    if (trimmed === "/clear" || trimmed === "/new") {
      clearComposerState();
      clearPendingMessage();
      stopStreaming();
      void createSession({
        agentId: activeSession.agentId,
        modelProvider: activeSession.modelProvider ?? undefined,
        modelId: activeSession.modelId ?? undefined,
        thinkingLevel: activeSession.thinkingLevel ?? undefined,
      }).catch(() => {
        addToast(t("chat.failedToClearConversation", "Failed to clear conversation"), "error");
      });
      return;
    }

    clearComposerState();
    sendMessage(trimmed, files);
  }, [
    messageInput,
    pendingAttachments,
    activeSession,
    clearComposerState,
    stopStreaming,
    clearPendingMessage,
    createSession,
    addToast,
    sendMessage,
    chatCommandContext,
    t,
  ]);


  const handleSendDispatch = useCallback(async () => {
    const trimmed = messageInput.trim();
    const files = pendingAttachments.map((attachment) => attachment.file);
    /**
     * FNXC:Chat 2026-06-17-02:12:
     * Main Chat room dispatch must permit attachment-only sends. Block only a truly empty composer so staged files can reach the backend without requiring filler text.
     */
    if (!trimmed && files.length === 0) {
      return;
    }

    if (chatRoomsEnabled && chatScope === "rooms") {
      if (!rooms.activeRoom) {
        return;
      }

      if (trimmed === "/clear" || trimmed === "/new") {
        clearComposerState();
        try {
          await rooms.clearRoom(rooms.activeRoom.id);
        } catch {
          addToast(t("chat.failedToClearRoomConversation", "Failed to clear room conversation"), "error");
        }
        return;
      }

      if (roomSendInFlightRef.current) {
        return;
      }

      roomSendInFlightRef.current = true;
      const previousInput = messageInput;
      clearComposerState();

      try {
        await rooms.sendRoomMessage(trimmed, { files });
      } catch (error) {
        if (error instanceof RoomMessageDeliveredButReplyFailedError) {
          const message = error.message.trim()
            ? error.message
            : t("chat.messageSentButReplyFailed", "Message sent, but assistant reply failed");
          addToast(t("chat.messageSentButReplyFailedDetail", "Message sent, but assistant reply failed: {{detail}}", { detail: message }), "error");
          return;
        }

        setMessageInput(previousInput);
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : t("chat.failedToSendRoomMessage", "Failed to send room message");
        addToast(message, "error");
      } finally {
        roomSendInFlightRef.current = false;
      }
      return;
    }

    handleSend();
  }, [messageInput, pendingAttachments, chatRoomsEnabled, chatScope, rooms, rooms.clearRoom, clearComposerState, addToast, handleSend]);

  const handleQuestionSubmit = useCallback(async (answerText: string) => {
    if (chatRoomsEnabled && chatScope === "rooms") {
      if (!rooms.activeRoom) {
        return;
      }

      try {
        await rooms.sendRoomMessage(answerText);
      } catch (error) {
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : t("chat.failedToSendRoomMessage", "Failed to send room message");
        addToast(message, "error");
      }
      return;
    }

    if (!activeSession) {
      return;
    }

    sendMessage(answerText);
  }, [activeSession, addToast, chatRoomsEnabled, chatScope, rooms, sendMessage, t]);

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
          resizeComposer(inputRef.current);
          inputRef.current.focus();
        });

        return nextInput;
      });

      setShowSkillMenu(false);
      setSkillFilter("");
      setHighlightedSkillIndex(0);
    },
    [resizeComposer],
  );

  const handleCommandSelect = useCallback(
    (command: ChatCommand, disabled: boolean) => {
      if (disabled) {
        addToast(t("chat.commandNoRunningAgent", "No running agent to steer"), "warning");
        return;
      }

      setMessageInput((currentInput) => {
        const triggerMatch = getSkillTriggerMatch(currentInput);
        if (!triggerMatch) {
          return currentInput;
        }

        const replacement = `${command.trigger} `;
        const nextInput =
          currentInput.slice(0, triggerMatch.start) + replacement + currentInput.slice(triggerMatch.end);

        window.requestAnimationFrame(() => {
          if (!inputRef.current) return;
          resizeComposer(inputRef.current);
          inputRef.current.focus();
        });

        return nextInput;
      });

      setShowSkillMenu(false);
      setSkillFilter("");
      setHighlightedSkillIndex(0);
    },
    [resizeComposer, addToast, t],
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
        resizeComposer(inputRef.current);
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [mentionStartPos, messageInput, resizeComposer],
  );

  const insertHashMention = useCallback(
    (nextInput: string, insertedToken: string) => {
      const textarea = inputRef.current;
      const cursorPos = textarea?.selectionStart ?? mentionCursorPosRef.current;
      const mentionStart = messageInput.lastIndexOf("#", cursorPos);
      const nextCursorPos = mentionStart >= 0
        ? mentionStart + insertedToken.length
        : nextInput.length;

      setMessageInput(nextInput);
      fileMention.dismissMention();
      setFileMentionPopupVisible(false);

      window.requestAnimationFrame(() => {
        if (!inputRef.current) return;
        resizeComposer(inputRef.current);
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      });
    },
    [fileMention, messageInput, resizeComposer],
  );

  // Handle input key down
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      mentionCursorPosRef.current = e.currentTarget.selectionStart ?? mentionCursorPosRef.current;

      // Handle file mention popup keyboard navigation first
      if (fileMention.mentionActive && fileMention.combinedItems.length > 0) {
        fileMention.handleKeyDown(e, messageInput);
        if (e.key === "Enter" || e.key === "Tab") {
          const item = fileMention.combinedItems[fileMention.selectedIndex];
          if (item?.kind === "task") {
            insertHashMention(fileMention.selectTask(item.task, messageInput), `#${item.task.id}`);
          } else if (item?.kind === "file") {
            insertHashMention(fileMention.selectFile(item.file, messageInput), `#${item.file.path}`);
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
        if (skillMenuEntries.length > 0) {
          setHighlightedSkillIndex((prev) => (prev + 1) % skillMenuEntries.length);
        }
        return;
      }

      if (showSkillMenu && e.key === "ArrowUp") {
        e.preventDefault();
        if (skillMenuEntries.length > 0) {
          setHighlightedSkillIndex((prev) =>
            prev === 0 ? skillMenuEntries.length - 1 : prev - 1,
          );
        }
        return;
      }

      if (showSkillMenu && (e.key === "Enter" || e.key === "Tab") && skillMenuEntries.length > 0) {
        e.preventDefault();
        const entryToSelect = skillMenuEntries[highlightedSkillIndex] ?? skillMenuEntries[0];
        if (entryToSelect?.kind === "skill") {
          handleSkillSelect(entryToSelect.skill);
        } else if (entryToSelect?.kind === "command") {
          handleCommandSelect(entryToSelect.command, entryToSelect.disabled);
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
        void handleSendDispatch();
      }
    },
    [
      mentionPopupVisible,
      filteredMentionAgents,
      mentionHighlightIndex,
      handleMentionSelect,
      showSkillMenu,
      skillMenuEntries,
      highlightedSkillIndex,
      handleSkillSelect,
      handleCommandSelect,
      handleSendDispatch,
      fileMention,
      insertHashMention,
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

    // Resize BEFORE the state update so the textarea grows in the same frame
    // the user typed in (matches QuickChat). Doing it after setMessageInput
    // works in tests but can lose the height in production because React 18
    // batches the state update and the controlled-component value reset can
    // happen before our direct DOM height assignment lands.
    resizeComposer(textarea);

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
  }, [updateMentionState, resizeComposer]);

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
    if (typeof window !== "undefined" && window.innerWidth <= 768) {
      suppressVvShrinkRef.current = true;
      if (suppressVvShrinkTimeoutRef.current !== null) {
        window.clearTimeout(suppressVvShrinkTimeoutRef.current);
      }
      suppressVvShrinkTimeoutRef.current = window.setTimeout(() => {
        suppressVvShrinkRef.current = false;
        suppressVvShrinkTimeoutRef.current = null;
      }, 450);

      // Undo iOS layout-viewport drift HERE, on blur, not on the next focus.
      // After a keyboard dismiss iOS can leave window.scrollY > 0; if that
      // residual scroll is still present on the next focus, the keyboard
      // lock's scrollTo(0,0) fires a *real* scroll while iOS is raising the
      // keyboard and dismisses it (the "second tap dismisses" regression).
      // Resetting on blur — when the keyboard is already closing, so there is
      // nothing to dismiss — means the next focus starts at scrollY 0 and the
      // lock's scroll is a no-op. We reset immediately and once more after the
      // dismiss animation settles (iOS can re-drift mid-animation). The
      // deferred reset is cancelled on focus so a fast re-tap can't scroll
      // mid-raise.
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
      if (blurScrollResetTimeoutRef.current !== null) {
        window.clearTimeout(blurScrollResetTimeoutRef.current);
      }
      blurScrollResetTimeoutRef.current = window.setTimeout(() => {
        blurScrollResetTimeoutRef.current = null;
        if (document.activeElement?.tagName === "TEXTAREA") return;
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
      }, 350);
    }

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
    suppressVvShrinkRef.current = false;
    if (suppressVvShrinkTimeoutRef.current !== null) {
      window.clearTimeout(suppressVvShrinkTimeoutRef.current);
      suppressVvShrinkTimeoutRef.current = null;
    }
    if (hideSkillMenuTimeoutRef.current !== null) {
      window.clearTimeout(hideSkillMenuTimeoutRef.current);
      hideSkillMenuTimeoutRef.current = null;
    }
    // Cancel any deferred blur drift-reset: it would scroll the document while
    // iOS is raising the keyboard for THIS focus and dismiss it.
    if (blurScrollResetTimeoutRef.current !== null) {
      window.clearTimeout(blurScrollResetTimeoutRef.current);
      blurScrollResetTimeoutRef.current = null;
    }
    // NOTE: deliberately no window.scrollTo(0,0) here. Scrolling on the focus
    // event fires while iOS is still raising the soft keyboard, and iOS treats
    // a programmatic scroll mid-raise as a reason to abort it — the keyboard
    // opens then immediately dismisses, so the input can't be typed in. This
    // mirrors QuickChatFAB's handleInputFocus, which does not scroll and works.
    // Drift is instead reset on blur (see handleInputBlur), so by the time this
    // focus runs the document is already at scrollY 0.
  }, []);

  useEffect(() => {
    return () => {
      if (suppressVvShrinkTimeoutRef.current !== null) {
        window.clearTimeout(suppressVvShrinkTimeoutRef.current);
      }
      if (blurScrollResetTimeoutRef.current !== null) {
        window.clearTimeout(blurScrollResetTimeoutRef.current);
      }
    };
  }, []);

  // Handle archive
  const handleArchive = useCallback(
    async (id: string) => {
      setContextMenu(null);
      try {
        await archiveSession(id);
        addToast(t("chat.conversationArchived", "Conversation archived"), "success");
      } catch {
        addToast(t("chat.failedToArchiveConversation", "Failed to archive conversation"), "error");
      }
    },
    [archiveSession, addToast],
  );

  const openRenameDialog = useCallback(
    (id: string) => {
      const session = filteredSessions.find((item) => item.id === id) ?? (activeSession?.id === id ? activeSession : null);
      setContextMenu(null);
      setMobileSessionMenuOpen(false);
      setRenameTitle(session?.title ?? "");
      setRenameDialog({ sessionId: id, title: session?.title ?? "" });
    },
    [activeSession, filteredSessions],
  );

  /**
   * FNXC:Chat 2026-06-16-22:08:
   * Regular chat exposes rename from the desktop context menu and mobile session switcher; saving delegates to the shared hook so the sidebar list and active thread header update from one optimistic state path.
   */
  const handleRename = useCallback(async () => {
    if (!renameDialog) return;
    try {
      await renameSession(renameDialog.sessionId, renameTitle);
      setRenameDialog(null);
      setRenameTitle("");
      addToast(t("chat.conversationRenamed", "Conversation renamed"), "success");
    } catch {
      // useChat owns rollback and error toast so both regular-chat rename surfaces share failure behavior.
    }
  }, [addToast, renameDialog, renameSession, renameTitle, t]);

  // Handle delete
  const handleDelete = useCallback(
    async (id: string) => {
      setConfirmDelete(null);
      setContextMenu(null);
      try {
        await deleteSession(id);
        addToast(t("chat.conversationDeleted", "Conversation deleted"), "success");
      } catch {
        addToast(t("chat.failedToDeleteConversation", "Failed to delete conversation"), "error");
      }
    },
    [deleteSession, addToast],
  );

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isChatMobile || tabletKeyboardOpen) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const resizeHandle = event.currentTarget;
    if (typeof resizeHandle.setPointerCapture === "function") {
      resizeHandle.setPointerCapture(event.pointerId);
    }

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, startWidth + deltaX));
      latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
      persistSidebarWidth(nextWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (typeof resizeHandle.releasePointerCapture === "function") {
        resizeHandle.releasePointerCapture(upEvent.pointerId);
      }

      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      persistSidebarWidth(latestWidth);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [isChatMobile, persistSidebarWidth, sidebarWidth, tabletKeyboardOpen]);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isChatMobile || tabletKeyboardOpen) {
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();

    const step = event.shiftKey ? 50 : 10;
    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, sidebarWidth + delta));
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isChatMobile, persistSidebarWidth, sidebarWidth, tabletKeyboardOpen]);

  // Handle session click
  const handleSessionClick = useCallback(
    (id: string) => {
      const selectedSession = filteredSessions.find((session) => session.id === id);
      markRead("direct", id, selectedSession?.lastMessageAt ?? selectedSession?.updatedAt);
      selectSession(id);
      setMobileSessionMenuOpen(false);
      if (isChatMobile) setSidebarVisible(false);
    },
    [filteredSessions, isChatMobile, markRead, selectSession],
  );

  // Handle back to sidebar (mobile)
  const handleBack = useCallback(() => {
    selectSession("");
    setSidebarVisible(true);
    setMobileSessionMenuOpen(false);
  }, [selectSession]);

  const handleRoomBack = useCallback(() => {
    rooms.selectRoom(null);
    setSidebarVisible(true);
    setMobileSessionMenuOpen(false);
  }, [rooms]);

  // Render empty state (no active session)
  const renderEmptyState = () => {
    return (
      <div className="chat-empty-state">
        <MessageSquare size={48} strokeWidth={1.5} />
        <h2>{t("chat.startNewConversation", "Start a new conversation")}</h2>
        <button className="btn btn-primary" onClick={() => setShowNewDialog(true)}>
          <Plus size={16} />
          {t("chat.newChat", "New Chat")}
        </button>
      </div>
    );
  };

  const activeResolvedModel = resolveSessionProvider(
    activeSession,
    activeSession?.agentId ? (agentsMap.get(activeSession.agentId) ?? null) : null,
    defaultModel,
  );
  const activeContextWindow = useMemo(() => {
    if (!activeResolvedModel?.provider || !activeResolvedModel.modelId) {
      return null;
    }
    const matchedModel = models.find(
      (model) => model.provider === activeResolvedModel.provider && model.id === activeResolvedModel.modelId,
    );
    return matchedModel?.contextWindow ? matchedModel.contextWindow : null;
  }, [activeResolvedModel?.modelId, activeResolvedModel?.provider, models]);
  const estimatedChatTokens = useMemo(
    () => estimateChatTokens(messages, isStreaming ? streamingText : undefined),
    [isStreaming, messages, streamingText],
  );
  const activeModelTag = formatModelTag(activeResolvedModel?.provider, activeResolvedModel?.modelId);
  const activeModelProvider = activeResolvedModel?.provider ?? null;
  const hasThreadInView = Boolean(activeSession || isStreaming || messages.length > 0);
  /*
  FNXC:ChatHeader 2026-07-10-00:00:
  After Chat remounts, useChat/useChatRooms can restore persisted activeSession/activeRoom while sidebarVisible resets to true. On mobile, header controls, the direct-thread shell class, and swipe-back history must follow the pane the body is actually showing, so detail-open requires the sidebar/list to be hidden instead of relying on restored thread presence alone.
  */
  const mobileThreadPaneOpen = isChatMobile && !sidebarVisible && (chatScope === "rooms" ? roomThreadActive : hasThreadInView);
  const hasMobileDetailSelection = isChatMobile
    ? mobileThreadPaneOpen
    : chatScope === "rooms" ? roomThreadActive : Boolean(activeSession);
  const previousHasMobileDetailSelectionRef = useRef(hasMobileDetailSelection);

  useEffect(() => {
    const previousHasMobileDetailSelection = previousHasMobileDetailSelectionRef.current;
    previousHasMobileDetailSelectionRef.current = hasMobileDetailSelection;

    if (!isChatMobile) {
      return;
    }

    if (previousHasMobileDetailSelection || !hasMobileDetailSelection) {
      return;
    }

    // Mobile list/detail surfaces must stack a view entry on top of the
    // shared browser-history nav entry so swipe-back returns to the list.
    pushNav({
      type: "view",
      revert: chatScope === "rooms" ? handleRoomBack : handleBack,
    });
  }, [chatScope, handleBack, handleRoomBack, hasMobileDetailSelection, isChatMobile, pushNav]);

  const threadHeaderTitle = activeSession?.agentId === FN_AGENT_ID
    ? (activeModelTag ?? "Fusion")
    : activeSession?.title || agentsMap.get(activeSession?.agentId ?? "")?.name || activeSession?.agentId || "Chat";
  const mobileDirectSessionTitle = activeSession?.title || t("chat.untitledSession", "Untitled");

  const showThreadHeaderModelTag = Boolean(activeModelTag && activeModelTag !== threadHeaderTitle);
  const showThreadHeaderContextWindow = !isChatMobile && hasThreadInView && activeContextWindow !== null;
  const threadHeaderContextUsed = formatTokenCount(estimatedChatTokens);
  const threadHeaderContextTotal = activeContextWindow !== null ? formatTokenCount(activeContextWindow) : null;
  const threadHeaderContextLabel = threadHeaderContextTotal
    ? t("chat.contextWindowAria", "Estimated {{used}} of {{total}} context tokens", {
      used: threadHeaderContextUsed,
      total: threadHeaderContextTotal,
    })
    : null;
  const showMobileSessionSwitcher = mobileThreadPaneOpen && chatScope === "direct" && !!activeSession;
  const showMobileDirectThreadHeaderControls = mobileThreadPaneOpen && chatScope === "direct";
  const showMobileRoomThreadHeaderControls = mobileThreadPaneOpen && chatScope === "rooms";

  const agentName =
    agentsMap.get(activeSession?.agentId ?? "")?.name ||
    (activeSession?.agentId === FN_AGENT_ID
      ? (activeModelTag ?? "Fusion")
      : (activeSession?.agentId?.slice(0, 30) ?? "Fusion"));

  // The model tag is already visible in the thread header — repeating it on
  // every assistant message is noise. Keep it suppressed for regular chat
  // (real agent name is the identity); QuickChat already collapses the tag
  // because its `agentName` IS the model tag, so the per-message slot was
  // always empty there too.
  const showAssistantModelTag = false;

  // In model-only chats (no real agent picked) the agent identity *is* the
  // model name, which is already in the thread header. Repeating it on every
  // assistant bubble is noise. Hide the per-message identity row entirely.
  const hideAssistantIdentity = activeSession?.agentId === FN_AGENT_ID;

  const getPendingPreview = (message: string) => message.length > 50
    ? `${message.slice(0, 50)}…`
    : message;

  useEffect(() => {
    if (!mobileSessionMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (mobileSessionMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setMobileSessionMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [mobileSessionMenuOpen]);

  useEffect(() => {
    if (!roomSwitcherOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (roomSwitcherRef.current?.contains(event.target as Node)) {
        return;
      }
      setRoomSwitcherOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRoomSwitcherOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [roomSwitcherOpen]);

  useEffect(() => {
    if (!isChatMobile || chatScope !== "direct" || sidebarVisible) {
      setMobileSessionMenuOpen(false);
    }
  }, [isChatMobile, chatScope, sidebarVisible]);

  useEffect(() => {
    setRoomSwitcherOpen(false);
  }, [rooms.activeRoom?.id]);

  const setCopyFeedback = useCallback((messageId: string, feedback: CopyFeedbackState) => {
    const existingTimeout = copyFeedbackTimeoutsRef.current.get(messageId);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    setCopyFeedbackByMessageId((current) => ({ ...current, [messageId]: feedback }));

    const timeoutId = window.setTimeout(() => {
      setCopyFeedbackByMessageId((current) => {
        const { [messageId]: _removed, ...rest } = current;
        return rest;
      });
      copyFeedbackTimeoutsRef.current.delete(messageId);
    }, 2000);

    copyFeedbackTimeoutsRef.current.set(messageId, timeoutId);
  }, []);

  /*
  FNXC:Chat 2026-07-12-17:50:
  Direct Clipboard API calls mis-report "Copy failed" on non-secure origins such as mobile http://fusionstudio:4040, where navigator.clipboard is undefined. Route provider-response copies through copyTextToClipboard so the secure-context guard and execCommand fallback drive the existing success/error feedback.
  */
  const handleCopyResponse = useCallback(async (messageId: string, content: string) => {
    const copied = await copyTextToClipboard(content);
    setCopyFeedback(messageId, copied ? "success" : "error");
  }, [setCopyFeedback]);

  const showProviderResponseCopy = activeSession?.agentId === FN_AGENT_ID;

  const renderCopyAction = useCallback((messageId: string, content: string, testId?: string) => (
    <button
      type="button"
      className={`btn-icon chat-message-copy-action${copyFeedbackByMessageId[messageId] === "success" ? " chat-message-copy-action--success" : ""}${copyFeedbackByMessageId[messageId] === "error" ? " chat-message-copy-action--error" : ""}`}
      data-testid={testId ?? `chat-copy-response-${messageId}`}
      aria-label={copyFeedbackByMessageId[messageId] === "success" ? t("chat.responseCopied", "Response copied") : copyFeedbackByMessageId[messageId] === "error" ? t("chat.copyFailed", "Copy failed") : t("chat.copyResponse", "Copy response")}
      onClick={() => {
        void handleCopyResponse(messageId, content);
      }}
    >
      {copyFeedbackByMessageId[messageId] === "success" ? <Check size={14} /> : <Copy size={14} />}
    </button>
  ), [copyFeedbackByMessageId, handleCopyResponse]);

  const handleScrollMessageToTop = useCallback((messageId: string) => {
    const containerEl = messagesContainerRef.current;
    if (!containerEl) return;
    const selector = `[data-testid="chat-message-${messageId}"]`;
    const targetEl = containerEl.querySelector<HTMLElement>(selector);
    if (!targetEl) return;

    const top = targetEl.getBoundingClientRect().top - containerEl.getBoundingClientRect().top + containerEl.scrollTop;
    const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    containerEl.scrollTo({ top, behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, []);

  // ── CLI-backed chat mount (U12) ──────────────────────────────────────────
  // When the active chat session selects a cli-agent executor, the message-pane
  // + composer region is delegated to <CliChatSurface> (transcript + raw-terminal
  // toggle for hybrid/native adapters, terminal-only for the generic adapter).
  // The transcript renderer and composer renderer are the EXISTING ChatView JSX
  // passed through as thunks so there is no parallel message/composer UI.
  const cliAdapterId = activeSession?.cliExecutorAdapterId ?? null;
  const cliChatActive = Boolean(cliAdapterId);
  // Generic adapter has no structured transcript → terminal-only; every other
  // bundled adapter exposes a transcript and gets the toggle (the authoritative
  // tier is resolved server-side; this only needs the generic vs. non-generic
  // split that drives the toggle's presence).
  const cliChatTier: CliChatTier = cliAdapterId === "generic" ? "generic" : "hybrid";
  // Terminal attach id: the native session linkage when known, else the chat id.
  const cliTerminalSessionId = activeSession?.cliSessionFile || activeSession?.id || "";

  /*
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Editing is supported only for direct (model-loop) chat sessions: never CLI-agent-backed
   * sessions (a live PTY owns the transcript, not a rewindable pi session), and never while a
   * generation is streaming (an edit cannot race a live send). Rooms don't route through this
   * pane at all, so no additional gate is needed here for that surface.
   */
  const canEditChatMessages = !cliChatActive && !isStreaming;

  // The session message pane and composer, captured once so both the normal
  // provider path and the CLI-backed path (CliChatSurface thunks) render the
  // exact same JSX — no parallel message/composer UI.
  const renderSessionMessagesPane = () => (
    <div className="chat-messages" ref={messagesContainerRef} onScroll={updateScrollState}>
      <div ref={loadMoreSentinelRef} className="chat-load-more-sentinel">
        {hasMoreMessages && messagesLoading && (
          <div className="chat-loading-older">{t("chat.loadingOlderMessages", "Loading older messages…")}</div>
        )}
      </div>
      {isStreaming ? (
        <>
          {messages.map((message, index) => (
            <StandardChatMessageItem
              key={message.id}
              message={message}
              forcePlain={false}
              agentName={agentName}
              hideAssistantIdentity={hideAssistantIdentity}
              showAssistantModelTag={showAssistantModelTag}
              activeModelTag={activeModelTag}
              activeModelProvider={activeModelProvider}
              activeSessionId={activeSession?.id ?? null}
              mentionAgentsByName={mentionAgentsByName}
              roomContext={null}
              copyAction={showProviderResponseCopy && message.role === "assistant" ? renderCopyAction(message.id, message.content) : undefined}
              onScrollToTop={handleScrollMessageToTop}
              isAwaitingQuestionAnswer={message.role === "assistant" && index === messages.length - 1 && !isStreaming}
              submittedQuestionAnswer={findSubmittedQuestionAnswer(messages, index)}
              onQuestionSubmit={handleQuestionSubmit}
              canEdit={canEditChatMessages}
              onEditMessage={editMessageAndResend}
            />
          ))}
          <StandardStreamingMessage
            streamingText={streamingText}
            streamingThinking={streamingThinking}
            streamingToolCalls={streamingToolCalls}
            forcePlain={false}
            agentName={agentName}
            hideAssistantIdentity={hideAssistantIdentity}
            showAssistantModelTag={showAssistantModelTag}
            activeModelTag={activeModelTag}
            activeModelProvider={activeModelProvider}
            copyAction={showProviderResponseCopy && streamingText ? renderCopyAction("__streaming__", streamingText, "chat-copy-response-streaming") : undefined}
            onQuestionSubmit={handleQuestionSubmit}
          />
        </>
      ) : messagesLoading ? (
        <div className="chat-empty-state">{t("chat.loadingMessages", "Loading messages...")}</div>
      ) : messages.length === 0 && !activeSession ? (
        renderEmptyState()
      ) : messages.length === 0 && activeSession ? (
        <div className="chat-empty-state">{t("chat.noMessagesYet", "No messages yet. Start the conversation!")}</div>
      ) : (
        <>
          {messages.map((message, index) => (
            <StandardChatMessageItem
              key={message.id}
              message={message}
              forcePlain={false}
              agentName={agentName}
              hideAssistantIdentity={hideAssistantIdentity}
              showAssistantModelTag={showAssistantModelTag}
              activeModelTag={activeModelTag}
              activeModelProvider={activeModelProvider}
              activeSessionId={activeSession?.id ?? null}
              mentionAgentsByName={mentionAgentsByName}
              roomContext={null}
              copyAction={showProviderResponseCopy && message.role === "assistant" ? renderCopyAction(message.id, message.content) : undefined}
              onScrollToTop={handleScrollMessageToTop}
              isAwaitingQuestionAnswer={message.role === "assistant" && index === messages.length - 1 && !isStreaming}
              submittedQuestionAnswer={findSubmittedQuestionAnswer(messages, index)}
              onQuestionSubmit={handleQuestionSubmit}
              canEdit={canEditChatMessages}
              onEditMessage={editMessageAndResend}
            />
          ))}
        </>
      )}
      <div ref={messagesEndRef} />
    </div>
  );

  const renderSessionComposerPane = () => (
    <div className="chat-input-area">
      <input
        ref={fileInputRef}
        type="file"
        data-testid="chat-file-input"
        accept="image/*,.txt,.json,.yaml,.yml,.log,.csv,.xml,.md"
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          handleAttachmentFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {showSkillMenu && (
        <div className="chat-skill-menu" data-testid="chat-skill-menu" role="listbox" aria-label={t("chat.skillSuggestions", "Skill suggestions")}>
          {skillsLoading && filteredCommands.length === 0 ? (
            <div className="chat-skill-menu-empty">{t("chat.loadingSkills", "Loading skills…")}</div>
          ) : skillMenuEntries.length === 0 ? (
            <div className="chat-skill-menu-empty">
              {skillFilter ? t("chat.noSkillsFound", "No skills found") : t("chat.noSkillsAvailable", "No skills available")}
            </div>
          ) : (
            skillMenuEntries.map((entry, index) =>
              entry.kind === "command" ? (
                <button
                  key={`command-${entry.command.trigger}`}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedSkillIndex}
                  aria-disabled={entry.disabled}
                  className={`chat-skill-menu-item chat-command-menu-item${index === highlightedSkillIndex ? " chat-skill-menu-item--highlighted" : ""}${entry.disabled ? " chat-command-menu-item--disabled" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlightedSkillIndex(index)}
                  onClick={() => handleCommandSelect(entry.command, entry.disabled)}
                >
                  <span className="chat-skill-menu-item-name">{entry.command.trigger}</span>
                  <span className="chat-skill-menu-item-description">
                    {entry.disabled
                      ? t("chat.commandNoRunningAgentHint", "No running agent to steer")
                      : entry.command.description}
                  </span>
                </button>
              ) : (
                <button
                  key={entry.skill.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedSkillIndex}
                  className={`chat-skill-menu-item${index === highlightedSkillIndex ? " chat-skill-menu-item--highlighted" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlightedSkillIndex(index)}
                  onClick={() => handleSkillSelect(entry.skill)}
                >
                  <span className="chat-skill-menu-item-name">{entry.skill.name}</span>
                  <span className="chat-skill-menu-item-description" title={entry.skill.relativePath}>
                    {entry.skill.relativePath}
                  </span>
                </button>
              ),
            )
          )}
        </div>
      )}
      {pendingAttachments.length > 0 && (
        <div className="chat-attachment-previews" data-testid="chat-attachment-previews">
          {pendingAttachments.map((attachment, index) => (
            <div
              key={attachment.previewUrl || `${attachment.file.name}-${index}`}
              className="chat-attachment-preview"
              data-testid={`chat-attachment-preview-${index}`}
            >
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt={attachment.file.name} />
              ) : (
                <span className="chat-attachment-preview-name">{attachment.file.name}</span>
              )}
              <button
                type="button"
                className="chat-attachment-remove"
                onClick={() => removeAttachment(index)}
                data-testid={`chat-attachment-remove-${index}`}
                aria-label={`Remove ${attachment.file.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingMessages.length > 0 && (
        <>
          {/*
          FNXC:ChatComposer 2026-06-27-00:00:
          Queued direct-chat messages stack above the input in FIFO order with one shared divider, so multiple sends remain visible without changing the above-composer placement established by FN-7121.
          */}
          <div className="chat-pending-stack" data-testid="chat-pending-stack">
            {pendingMessages.map((pendingMessage, index) => (
              <div className="chat-pending-message" data-testid="chat-pending-indicator" key={`${index}-${pendingMessage}`}>
                <span>{t("chat.queuedMessage", "Queued: {{preview}}", { preview: getPendingPreview(pendingMessage) })}</span>
                <button
                  type="button"
                  className="chat-pending-message-dismiss"
                  aria-label={t("chat.dismissQueuedMessage", "Dismiss queued message")}
                  data-testid={`chat-pending-dismiss-${index}`}
                  onClick={() => clearPendingMessage(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="chat-pending-divider" aria-hidden="true" />
        </>
      )}
      <div className="chat-input-row">
        <button
          type="button"
          className="btn-icon chat-attach-btn"
          data-testid="chat-attach-btn"
          aria-label={t("chat.attachFiles", "Attach files")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={16} />
        </button>
        <div
          className={`chat-input-wrapper${isDragOver ? " chat-input-wrapper--dragover" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragOver(false);
            handleAttachmentFiles(event.dataTransfer.files);
          }}
        >
          <textarea
            ref={handleComposerRef}
            className="chat-input-textarea"
            placeholder={t("chat.typeMessage", "Type a message...")}
            value={messageInput}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onKeyUp={handleInputKeyUp}
            onClick={handleInputSelectionChange}
            onBlur={handleInputBlur}
            onFocus={handleInputFocus}
            onPaste={handlePaste}
            onTouchStart={(event) => {
              if (typeof window === "undefined") return;
              if (window.innerWidth > 768) return;
              if (!isIOS()) return;
              if (document.activeElement === event.currentTarget) return;
              // FN-6301: do not preventDefault on the first unfocused iOS tap.
              // Native focus is the reliable path that raises the soft keyboard;
              // the visualViewport/input-focus effects own scroll compensation.
            }}
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
            roomMemberIds={roomContext?.memberIds}
            roomName={roomContext?.roomName}
          />
          <FileMentionPopup
            visible={fileMention.mentionActive && !mentionPopupVisible}
            position={fileMentionPosition}
            tasks={fileMention.tasks}
            files={fileMention.files}
            selectedIndex={fileMention.selectedIndex}
            onSelectTask={(task) => {
              insertHashMention(fileMention.selectTask(task, messageInput), `#${task.id}`);
            }}
            onSelectFile={(file) => {
              insertHashMention(fileMention.selectFile(file, messageInput), `#${file.path}`);
            }}
            loading={fileMention.loading}
          />
        </div>
        <StandardChatActionButton
          isStreaming={isStreaming}
          canSend={Boolean(messageInput.trim() || pendingAttachments.length > 0)}
          onSend={handleSend}
          onStop={stopStreaming}
        />
      </div>
    </div>
  );

  /**
   * FNXC:ChatTabletKeyboard 2026-06-16-17:46:
   * FN-6494 reverses the FN-6178/FN-6210 tablet-keyboard auto-hide: a visible chat sidebar must stay visible while the software keyboard is up. The user's persisted width remains untouched and returns when the keyboard closes; mobile keeps CSS-driven one-pane sizing.
   *
   * FNXC:ChatTabletKeyboard 2026-06-16-22:59:
   * FN-6516 refines the tablet keyboard behavior: keep the sidebar at the same persisted width while the keyboard is open instead of narrowing to the minimum. The FN-6210 CSS max-width guard remains the upper bound, and resize controls still stay disabled while typing.
   */
  const sidebarInlineStyle: React.CSSProperties | undefined = isChatMobile ? undefined : { width: `${sidebarWidth}px` };
  /*
  FNXC:ChatHeader 2026-06-22-16:18:
  Direct/Rooms is a view-level scope switch, so it belongs in Chat's canonical header directly before New Chat instead of consuming the first row of the sidebar. Keep the existing test ids while moving the DOM so direct and room conversations share one header control surface.

  FNXC:ChatHeader 2026-06-22-18:44:
  Very narrow chat headers collapse Direct/Rooms to icons while retaining aria-selected tabs and text labels for wider headers. The segmented control must stay height-aligned with the ViewHeader action row, so icon+label markup is stable and CSS hides only the label.
  */
  const mobileDirectSessionSwitcher = showMobileSessionSwitcher ? (
    <div className="chat-mobile-session-menu" ref={mobileSessionMenuRef}>
      <button
        type="button"
        className="btn chat-mobile-session-trigger"
        data-testid="chat-mobile-session-trigger"
        aria-haspopup="menu"
        aria-expanded={mobileSessionMenuOpen}
        onClick={() => setMobileSessionMenuOpen((open) => !open)}
      >
        {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="md" /> : <Bot size={16} />}
        {/*
        FNXC:ChatHeader 2026-07-03-00:00:
        Mobile direct-chat needs one compact, conversation-oriented dropdown trigger. Show the active conversation title (or Untitled) beside only the provider/model logo and chevron; keep model-name badges exclusive to the desktop/thread identity row.
        */}
        <span className="chat-thread-header-title">{mobileDirectSessionTitle}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {mobileSessionMenuOpen && (
        <div className="chat-mobile-session-dropdown" role="menu" data-testid="chat-mobile-session-dropdown">
          {filteredSessions.map((session) => (
            <div
              key={session.id}
              className={`chat-mobile-session-option-row${activeSession?.id === session.id ? " chat-mobile-session-option-row--active" : ""}`}
              role="none"
            >
              <button
                type="button"
                role="menuitem"
                className={`chat-mobile-session-option${activeSession?.id === session.id ? " chat-mobile-session-option--active" : ""}`}
                data-testid={`chat-mobile-session-option-${session.id}`}
                onClick={() => handleSessionClick(session.id)}
              >
                <span className="chat-mobile-session-option-title">{session.title || t("chat.untitledSession", "Untitled")}</span>
              </button>
              <button
                type="button"
                className="btn-icon chat-mobile-session-rename"
                data-testid={`chat-mobile-session-rename-${session.id}`}
                aria-label={t("chat.renameConversationAria", "Rename conversation {{title}}", { title: session.title || t("chat.untitledSession", "Untitled") })}
                onClick={() => openRenameDialog(session.id)}
              >
                <Pencil size={14} />
              </button>
            </div>
          ))}
          {/*
          FNXC:Chat 2026-06-27-00:00:
          Mobile Direct-scope quick session switching must let users start a new chat without leaving the open thread. Route this affordance through the same setShowNewDialog(true) / NewChatDialog path as the header and sidebar-footer controls.
          */}
          <button
            type="button"
            role="menuitem"
            className="chat-mobile-session-new"
            data-testid="chat-mobile-session-new"
            onClick={() => {
              setMobileSessionMenuOpen(false);
              setShowNewDialog(true);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            <span>{t("chat.newChat", "New Chat")}</span>
          </button>
        </div>
      )}
    </div>
  ) : null;

  const scopeToggle = chatRoomsEnabled ? (
    <div className="chat-sidebar-scope-toggle chat-view-header-scope-toggle" role="tablist" data-testid="chat-sidebar-scope-toggle">
      <button
        type="button"
        role="tab"
        className={`chat-sidebar-scope-btn${chatScope === "direct" ? " chat-sidebar-scope-btn--active" : ""}`}
        aria-selected={chatScope === "direct"}
        data-testid="chat-sidebar-scope-direct"
        onClick={() => setChatScope("direct")}
      >
        <MessageSquare size={14} aria-hidden="true" />
        <span>{t("chat.scopeDirect", "Direct")}</span>
      </button>
      <button
        type="button"
        role="tab"
        className={`chat-sidebar-scope-btn${chatScope === "rooms" ? " chat-sidebar-scope-btn--active" : ""}`}
        aria-selected={chatScope === "rooms"}
        data-testid="chat-sidebar-scope-rooms"
        onClick={() => setChatScope("rooms")}
      >
        <Hash size={14} aria-hidden="true" />
        <span>{t("chat.scopeRooms", "Rooms")}</span>
      </button>
    </div>
  ) : null;

  return (
    /*
    FNXC:Chat 2026-06-22-12:55:
    Chat uses the shared ViewHeader so its page chrome matches the other main-content views. The height-sensitive two-pane chat layout remains isolated in .chat-view__body beneath that header, preserving sidebar resize, thread scrolling, and mobile keyboard compensation while moving the desktop New Chat action into the canonical header actions cluster.
    */
    <div ref={chatViewRef} className={`chat-view${floating ? " chat-view--floating" : ""}${isChatMobile ? " chat-view--narrow" : ""}${showMobileDirectThreadHeaderControls ? " chat-view--mobile-direct-thread" : ""}`}>
      <ViewHeader
        icon={MessageSquare}
        title={t("chat.title", "Chat")}
        actions={
          <>
            {showMobileDirectThreadHeaderControls ? (
              <>
                {/*
                FNXC:ChatHeader 2026-07-02-17:26:
                Mobile direct-thread view has a single top row: back navigation must be the first visible/focusable control at the far-left edge and the active conversation switcher must stay beside it. The ViewHeader still owns the accessible Chat title; ChatView-scoped CSS hides the entire title/icon shell only in this direct-thread mobile state so it cannot reserve left-edge layout space.
                */}
                <button className="btn-icon chat-back-btn" onClick={handleBack} data-testid="chat-back-btn" aria-label={t("chat.backToConversations", "Back to conversations")}>
                  <ChevronLeft size={16} />
                </button>
                {mobileDirectSessionSwitcher}
              </>
            ) : (
              scopeToggle
            )}
            {!isChatMobile ? (
              <button
                className="btn btn-sm btn-primary chat-view-header-new-chat"
                onClick={() => setShowNewDialog(true)}
                data-testid="chat-new-btn"
              >
                <Plus size={14} />
                {t("chat.newChat", "New Chat")}
              </button>
            ) : null}
            {!floating && onPopOut ? (
              <button
                type="button"
                className="btn-icon chat-view-header-icon"
                onClick={onPopOut}
                aria-label={t("chat.popOut", "Pop out chat")}
                title={t("chat.popOut", "Pop out chat")}
                data-testid="chat-pop-out"
              >
                <Maximize2 size={16} />
              </button>
            ) : null}
            {floating && onMaximize ? (
              <button
                type="button"
                className="btn-icon chat-view-header-icon"
                onClick={onMaximize}
                aria-label={t("chat.maximizeToChatView", "Open in Chat view")}
                title={t("chat.maximizeToChatView", "Open in Chat view")}
                data-testid="chat-modal-maximize"
              >
                <Maximize2 size={16} />
              </button>
            ) : null}
            {floating && onMinimize ? (
              <button
                type="button"
                className="btn-icon chat-view-header-icon"
                onClick={onMinimize}
                aria-label={t("chat.minimizeToQuickChat", "Minimize to quick chat")}
                title={t("chat.minimizeToQuickChat", "Minimize to quick chat")}
                data-testid="chat-modal-minimize"
              >
                <Minimize2 size={16} />
              </button>
            ) : null}
            {floating && onClose ? (
              <button
                type="button"
                className="btn-icon chat-view-header-icon"
                onClick={onClose}
                aria-label={t("chat.closeChat", "Close chat")}
                title={t("chat.closeChat", "Close chat")}
                data-testid="chat-modal-close"
              >
                <X size={16} />
              </button>
            ) : null}
          </>
        }
      />
      <div className="chat-view__body">
      {/* Sidebar */}
      <div
        className={`chat-sidebar${!sidebarVisible ? " chat-sidebar--hidden" : ""}`}
        style={sidebarInlineStyle}
      >
        {!chatRoomsEnabled || chatScope === "direct" ? (
          <>
            {/* Search section */}
            {/*
            FNXC:ChatSearch 2026-07-07-12:00:
            Search always matches message content (server round trip) in addition to
            title/agentId; there is no client toggle to restrict it back to title-only (FN-7651
            removed the "Search in title only" button per user request). Rendered on both desktop
            and mobile since this sidebar markup is shared (mobile layout is a CSS breakpoint of
            the same DOM), and only within the Direct scope — Rooms already hides search/list
            entirely.
            */}
            <div className="chat-sidebar-search-container">
              <div className="chat-sidebar-search-wrapper">
                <Search size={14} className="chat-sidebar-search-icon" />
                <input
                  type="text"
                  className="chat-sidebar-search"
                  placeholder={t("chat.searchConversations", "Search conversations...")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="chat-search-input"
                />
              </div>
            </div>
            {/* Session list section */}
            <div className="chat-session-list chat-sidebar-list">
              {sessionsLoading ? (
                <div className="chat-empty-state chat-empty-state--padded">{t("chat.loadingConversations", "Loading...")}</div>
              ) : filteredSessions.length === 0 ? (
                <div className="chat-empty-state chat-empty-state--padded">{t("chat.noConversationsYet", "No conversations yet")}</div>
              ) : (
                filteredSessions.map((session) => {
                  const isActive = activeSession?.id === session.id;
                  const showUnreadDot = !isActive && isUnread("direct", session.id, session.lastMessageAt ?? session.updatedAt);
                  const sessionResolvedModel = resolveSessionProvider(
                    session,
                    agentsMap.get(session.agentId) ?? null,
                    defaultModel,
                  );
                  const sessionModelTag = formatModelTag(sessionResolvedModel?.provider, sessionResolvedModel?.modelId) ?? "Fusion";
                  const sessionTitle = session.title || t("chat.untitledSession", "Untitled");

                  return (
                    <div
                      key={session.id}
                      className={`chat-session-item${isActive ? " chat-session-item--active" : ""}`}
                      onClick={() => handleSessionClick(session.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
                      }}
                      data-testid={`chat-session-${session.id}`}
                    >
                      {/*
                      FNXC:ChatSidebar 2026-07-02-00:00:
                      Direct conversation rows need an always-discoverable rename affordance before delete while preserving row selection. Keep edit/delete as sibling buttons that stop propagation and share the existing rename/delete flows.
                      */}
                      <div className="chat-session-actions">
                        <button
                          type="button"
                          className="btn-icon chat-session-action-btn chat-session-rename-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRenameDialog(session.id);
                          }}
                          data-testid="chat-session-rename-btn"
                          aria-label={t("chat.renameConversationAria", "Rename conversation {{title}}", { title: sessionTitle })}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn-icon chat-session-action-btn chat-session-delete-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete(session.id);
                          }}
                          data-testid="chat-session-delete-btn"
                          aria-label={t("chat.deleteConversation", "Delete conversation")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="chat-session-title">
                        {sessionTitle}
                        {showUnreadDot ? (
                          <span
                            className="chat-unread-dot"
                            data-testid={`chat-unread-dot-${session.id}`}
                            aria-label={t("chat.unreadMessages", "Unread messages")}
                          />
                        ) : null}
                      </div>
                      <div className="chat-session-preview">
                        {session.lastMessagePreview || t("chat.noMessages", "No messages")}
                      </div>
                      {session.matchedMessagePreview ? (
                        <div className="chat-session-preview chat-session-preview--matched" data-testid={`chat-session-matched-preview-${session.id}`}>
                          {t("chat.matchedInMessage", "Matched: \"{{preview}}\"", { preview: session.matchedMessagePreview })}
                        </div>
                      ) : null}
                      <div className="chat-session-meta">
                        <span className="chat-session-meta-model">
                          {sessionResolvedModel?.provider ? <ProviderIcon provider={sessionResolvedModel.provider} size="sm" /> : null}
                          <span>
                            {agentsMap.get(session.agentId)?.name ||
                              (session.agentId === FN_AGENT_ID ? sessionModelTag : session.agentId.slice(0, 30))}
                          </span>
                        </span>
                        <span>{session.updatedAt ? formatRelativeTime(session.updatedAt, t) : ""}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <div className="chat-sidebar-rooms" data-testid="chat-sidebar-rooms">
            {!isChatMobile && (
              <div className="chat-sidebar-rooms-header" data-testid="chat-sidebar-rooms-header">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  data-testid="chat-create-room-btn"
                  onClick={() => setCreateRoomOpen(true)}
                >
                  <Plus size={14} />
                  {t("chat.createRoom", "Create room")}
                </button>
              </div>
            )}
            {rooms.rooms.length === 0 ? (
              <div className="chat-sidebar-rooms-empty" data-testid="chat-sidebar-rooms-empty">
                {t("chat.noRoomsYet", "No rooms yet.")}
              </div>
            ) : (
              <div className="chat-session-list chat-sidebar-list">
                {rooms.rooms.map((room) => {
                  const isActive = rooms.activeRoom?.id === room.id;
                  const showUnreadDot = !isActive && isUnread("room", room.id, room.updatedAt);
                  return (
                    <div
                      key={room.id}
                      role="button"
                      tabIndex={0}
                      className={`chat-room-item${isActive ? " chat-room-item--active" : ""}`}
                      data-testid={`chat-room-item-${room.slug}`}
                      onClick={() => {
                        markRead("room", room.id, room.updatedAt);
                        rooms.selectRoom(room.id);
                        if (isChatMobile) {
                          setSidebarVisible(false);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          markRead("room", room.id, room.updatedAt);
                          rooms.selectRoom(room.id);
                          if (isChatMobile) {
                            setSidebarVisible(false);
                          }
                        }
                      }}
                    >
                      <span className="chat-room-item-details">
                        <span className="chat-room-item-name-row">
                          <span className="chat-room-item-name">#{room.name}</span>
                          {showUnreadDot ? (
                            <span
                              className="chat-unread-dot"
                              data-testid={`chat-unread-dot-${room.id}`}
                              aria-label={t("chat.unreadMessages", "Unread messages")}
                            />
                          ) : null}
                        </span>
                        {isActive ? (
                          <span className="chat-room-item-meta">
                            {t("chat.roomMemberCount", "{{count}} member", { count: rooms.activeRoomMembers.length, defaultValue_one: "{{count}} member", defaultValue_other: "{{count}} members" })}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        className="btn-icon chat-room-item-delete"
                        data-testid={`chat-room-delete-${room.slug}`}
                        aria-label={t("chat.deleteRoom", "Delete room {{name}}", { name: room.name })}
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmDeleteRoomId(room.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {chatScope === "rooms" ? (
          isChatMobile ? (
            <div className="chat-sidebar-footer">
              <button
                type="button"
                className="btn btn-sm btn-primary chat-sidebar-footer-btn"
                data-testid="chat-create-room-btn"
                onClick={() => setCreateRoomOpen(true)}
              >
                <Plus size={14} />
                {t("chat.createRoom", "Create room")}
              </button>
            </div>
          ) : null
        ) : (
          isChatMobile ? (
            <div className="chat-sidebar-footer">
              <button
                className="btn btn-sm btn-primary chat-sidebar-footer-btn"
                onClick={() => setShowNewDialog(true)}
                data-testid="chat-new-btn"
              >
                <Plus size={14} />
                {t("chat.newChat", "New Chat")}
              </button>
            </div>
          ) : null
        )}
      </div>

      {!isChatMobile && sidebarVisible && !tabletKeyboardOpen && (
        <div
          className="chat-sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={CHAT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={CHAT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          aria-label={t("chat.resizeSidebar", "Resize chat sidebar")}
          tabIndex={0}
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="chat-session-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => openRenameDialog(contextMenu.sessionId)}
            data-testid="chat-context-rename"
          >
            <Pencil size={14} />
            {t("chat.rename", "Rename")}
          </button>
          <button
            onClick={() => handleArchive(contextMenu.sessionId)}
            data-testid="chat-context-archive"
          >
            <Archive size={14} />
            {t("chat.archive", "Archive")}
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              setConfirmDelete(contextMenu.sessionId);
            }}
            data-testid="chat-context-delete"
          >
            <Trash2 size={14} />
            {t("chat.delete", "Delete")}
          </button>
        </div>
      )}

      {/* Rename Dialog */}
      {renameDialog && (
        <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={() => setRenameDialog(null)}>
          <div
            className="chat-new-dialog chat-view-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-rename-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="chat-rename-dialog-title">{t("chat.renameConversationTitle", "Rename Conversation")}</h3>
            <p className="chat-view-delete-dialog-copy">
              {t("chat.renameConversationBody", "Choose a new name for this conversation. Leave it blank to show Untitled.")}
            </p>
            <label className="chat-rename-label" htmlFor="chat-rename-input">
              {t("chat.conversationName", "Conversation name")}
            </label>
            <input
              id="chat-rename-input"
              className="input chat-rename-input"
              type="text"
              value={renameTitle}
              placeholder={t("chat.renamePlaceholder", "Untitled")}
              data-testid="chat-rename-input"
              onChange={(event) => setRenameTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleRename();
                }
              }}
              autoFocus
            />
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setRenameDialog(null)}>
                {t("chat.cancel", "Cancel")}
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void handleRename()}
                data-testid="chat-rename-save"
              >
                {t("chat.save", "Save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && (
        <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="chat-new-dialog chat-view-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chat.deleteConversationTitle", "Delete Conversation?")}</h3>
            <p className="chat-view-delete-dialog-copy">
              {t("chat.deleteConversationBody", "This action cannot be undone. All messages in this conversation will be permanently deleted.")}
            </p>
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>
                {t("chat.cancel", "Cancel")}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void handleDelete(confirmDelete)}
              >
                {t("chat.delete", "Delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {chatRoomsEnabled && confirmDeleteRoomId && (
        <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" onClick={() => setConfirmDeleteRoomId(null)}>
          <div className="chat-new-dialog chat-view-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chat.deleteRoomTitle", "Delete Room?")}</h3>
            <p className="chat-view-delete-dialog-copy">
              {t("chat.deleteRoomBody", "This action cannot be undone. This room and all its messages will be permanently deleted.")}
            </p>
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setConfirmDeleteRoomId(null)}>
                {t("chat.cancel", "Cancel")}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  void (async () => {
                    try {
                      await rooms.deleteRoom(confirmDeleteRoomId);
                      setConfirmDeleteRoomId(null);
                    } catch {
                      addToast(t("chat.failedToDeleteRoom", "Failed to delete room"), "error");
                    }
                  })();
                }}
              >
                {t("chat.delete", "Delete")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Thread */}
      {chatRoomsEnabled && chatScope === "rooms" ? (
        <div ref={chatThreadRef} className="chat-thread">
          {rooms.activeRoom ? (
            <>
              {(!isChatMobile || showMobileRoomThreadHeaderControls) && (
              <div className="chat-room-thread-header">
                {showMobileRoomThreadHeaderControls && (
                  <button className="btn-icon" onClick={handleRoomBack} data-testid="chat-back-btn">
                    <ChevronLeft size={16} />
                  </button>
                )}
                <div className="chat-room-switcher-menu" ref={roomSwitcherRef}>
                  <button
                    type="button"
                    className="chat-room-switcher-trigger"
                    data-testid="chat-room-switcher-trigger"
                    aria-haspopup="menu"
                    aria-expanded={roomSwitcherOpen}
                    onClick={() => setRoomSwitcherOpen((open) => !open)}
                  >
                    <span className="chat-thread-header-title">#{rooms.activeRoom.name}</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                  {roomSwitcherOpen && (
                    <div
                      role="menu"
                      className="chat-room-switcher-dropdown"
                      data-testid="chat-room-switcher-dropdown"
                    >
                      {rooms.rooms.map((room) => (
                        <button
                          key={room.id}
                          type="button"
                          role="menuitem"
                          className={`chat-room-switcher-option${room.id === rooms.activeRoom?.id ? " chat-room-switcher-option--active" : ""}`}
                          data-testid={`chat-room-switcher-option-${room.id}`}
                          onClick={() => {
                            markRead("room", room.id, room.updatedAt);
                            rooms.selectRoom(room.id);
                            setRoomSwitcherOpen(false);
                          }}
                        >
                          #{room.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="chat-room-thread-members">
                  {rooms.activeRoomMembers.map((member) => (
                    <AgentAvatar
                      key={member.agentId}
                      agent={
                        agentsMap.get(member.agentId) ?? {
                          id: member.agentId,
                          name: member.agentId.slice(0, 30),
                        }
                      }
                    />
                  ))}
                </div>
              </div>
              )}
              <div className="chat-messages" ref={messagesContainerRef} onScroll={updateScrollState}>
                {rooms.messagesLoading ? (
                  <div className="chat-empty-state">{t("chat.loadingMessages", "Loading messages...")}</div>
                ) : rooms.messages.filter((message) => message.content.trim() !== ROOM_SKIP_SENTINEL).length === 0 ? (
                  <div className="chat-empty-state">{t("chat.noMessagesYet", "No messages yet. Start the conversation!")}</div>
                ) : (
                  rooms.messages
                    .filter((message) => message.content.trim() !== ROOM_SKIP_SENTINEL)
                    .map((message) => {
                    const senderName = message.senderAgentId ? (agentsMap.get(message.senderAgentId)?.name ?? message.senderAgentId.slice(0, 30)) : t("chat.you", "You");
                    const roomMessage: ChatMessageInfo = {
                      id: message.id,
                      sessionId: message.roomId,
                      role: message.role,
                      content: message.content,
                      thinkingOutput: message.thinkingOutput ?? undefined,
                      toolCalls: undefined,
                      fallbackInfo: undefined,
                      attachments: message.attachments,
                      createdAt: message.createdAt,
                    };
                    return (
                      <StandardChatMessageItem
                        key={message.id}
                        message={roomMessage}
                        forcePlain={false}
                        agentName={senderName}
                        hideAssistantIdentity={false}
                        showAssistantModelTag={false}
                        activeModelTag={null}
                        activeModelProvider={null}
                        activeSessionId={rooms.activeRoom?.id ?? null}
                        mentionAgentsByName={mentionAgentsByName}
                        roomContext={roomContext}
                        onScrollToTop={handleScrollMessageToTop}
                        isAwaitingQuestionAnswer={false}
                        onQuestionSubmit={handleQuestionSubmit}
                      />
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
              {rooms.activeRoom && isUserScrolling && (
                <button
                  type="button"
                  className="btn btn-sm chat-jump-to-latest"
                  data-testid="chat-jump-to-latest"
                  onClick={() => scrollToBottom("fab-click")}
                >
                  <ChevronDown size={14} />
                  {t("chat.latest", "Latest")}
                </button>
              )}
            </>
          ) : (
            <div className="chat-room-empty-pane" data-testid="chat-rooms-empty-pane">{t("chat.selectRoomOrCreate", "Select a room or create one")}</div>
          )}

          {rooms.activeRoom && (
            <div className="chat-input-area">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.txt,.json,.yaml,.yml,.log,.csv,.xml,.md"
                multiple
                style={{ display: "none" }}
                onChange={(event) => {
                  handleAttachmentFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              {pendingAttachments.length > 0 && (
                <div className="chat-attachment-previews" data-testid="chat-attachment-previews">
                  {pendingAttachments.map((attachment, index) => (
                    <div
                      key={attachment.previewUrl || `${attachment.file.name}-${index}`}
                      className="chat-attachment-preview"
                      data-testid={`chat-attachment-preview-${index}`}
                    >
                      {attachment.previewUrl ? (
                        <img src={attachment.previewUrl} alt={attachment.file.name} />
                      ) : (
                        <span className="chat-attachment-preview-name">{attachment.file.name}</span>
                      )}
                      <button
                        type="button"
                        className="chat-attachment-remove"
                        onClick={() => removeAttachment(index)}
                        data-testid={`chat-attachment-remove-${index}`}
                        aria-label={`Remove ${attachment.file.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="chat-input-row">
                <button
                  type="button"
                  className="btn-icon chat-attach-btn"
                  data-testid="chat-attach-btn"
                  aria-label={t("chat.attachFiles", "Attach files")}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={16} />
                </button>
                <div
                  className={`chat-input-wrapper${isDragOver ? " chat-input-wrapper--dragover" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setIsDragOver(false);
                    handleAttachmentFiles(event.dataTransfer.files);
                  }}
                >
                  <textarea
                    ref={handleComposerRef}
                    className="chat-input-textarea"
                    placeholder={t("chat.typeMessage", "Type a message...")}
                    value={messageInput}
                    onChange={handleInputChange}
                    onKeyDown={handleInputKeyDown}
                    onKeyUp={handleInputKeyUp}
                    onClick={handleInputSelectionChange}
                    onBlur={handleInputBlur}
                    onFocus={handleInputFocus}
                    onPaste={handlePaste}
                    onTouchStart={(event) => {
                      if (typeof window === "undefined") return;
                      if (window.innerWidth > 768) return;
                      if (!isIOS()) return;
                      if (document.activeElement === event.currentTarget) return;
                      // FN-6301: do not preventDefault on the first unfocused iOS tap.
                      // Native focus is the reliable path that raises the soft keyboard;
                      // the visualViewport/input-focus effects own scroll compensation.
                    }}
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
                    roomMemberIds={roomContext?.memberIds}
                    roomName={roomContext?.roomName}
                  />
                </div>
                <StandardChatActionButton
                  isStreaming={false}
                  canSend={Boolean(messageInput.trim() || pendingAttachments.length > 0)}
                  onSend={handleSendDispatch}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
      <div ref={chatThreadRef} className="chat-thread">
        {/* Header - desktop/tablet keeps the thread identity row; mobile direct-thread controls move into ViewHeader. */}
        {/* FNXC:ChatRenderToggle 2026-07-04-00:00: The markdown/plain eye toggle
            button (desktop `.chat-thread-header-render-toggle` and the mobile
            floating `--floating` variant) was removed per FN-7541. Chat now
            always renders Markdown (forcePlain is hardcoded to false). */}
        {!isChatMobile && (hasThreadInView || !isChatMobile) && (
          <div className="chat-thread-header">
            <div className="chat-thread-header-identity" data-testid="chat-thread-header-identity">
              {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="md" /> : <Bot size={16} />}
              <span className="chat-thread-header-title">{threadHeaderTitle}</span>
              {showThreadHeaderModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
              {showThreadHeaderContextWindow && threadHeaderContextTotal && threadHeaderContextLabel ? (
                <span
                  className="chat-thread-header-context"
                  data-testid="chat-thread-context-window"
                  title={threadHeaderContextLabel}
                  aria-label={threadHeaderContextLabel}
                >
                  {threadHeaderContextUsed} / {threadHeaderContextTotal}
                </span>
              ) : null}
            </div>
          </div>
        )}

        {/* Messages + composer. CLI-backed chat sessions delegate this
            region to <CliChatSurface> (transcript/raw-terminal toggle +
            queued composer); generic-tier adapters render terminal-only. */}
        {cliChatActive ? (
          <CliChatSurface
            cliSessionId={cliTerminalSessionId}
            tier={cliChatTier}
            projectId={projectId}
            renderTranscript={renderSessionMessagesPane}
            renderComposer={() => (activeSession ? renderSessionComposerPane() : null)}
          />
        ) : (
          <>
            {renderSessionMessagesPane()}
            {isUserScrolling && (
              <button
                type="button"
                className="btn btn-sm chat-jump-to-latest"
                data-testid="chat-jump-to-latest"
                onClick={() => scrollToBottom("fab-click")}
              >
                <ChevronDown size={14} />
                {t("chat.latest", "Latest")}
              </button>
            )}
            {activeSession && renderSessionComposerPane()}
          </>
        )}
      </div>
      )}

      {chatRoomsEnabled && (
        <CreateRoomModal
          isOpen={createRoomOpen}
          onClose={() => setCreateRoomOpen(false)}
          projectId={projectId}
          existingRoomNames={rooms.rooms.map((room) => room.name)}
          onCreate={async (draft) => {
            await rooms.createRoom({ name: draft.name, memberAgentIds: draft.memberAgentIds });
            if (chatScope !== "rooms") {
              setChatScope("rooms");
            }
            setCreateRoomOpen(false);
            if (isChatMobile) {
              setSidebarVisible(false);
            }
          }}
        />
      )}
      </div>

      {/* New Chat Dialog (rendered at root level) */}
      {showNewDialog && (
        <NewChatDialog
          projectId={projectId}
          defaultModel={defaultModel}
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </div>
  );
}
