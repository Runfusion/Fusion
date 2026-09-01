// ChatView.css is imported eagerly from App.tsx to avoid a flash of
// unstyled content when the lazy chunk loads. Do not re-import here.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  Search,
  Trash2,
  Archive,
  ArrowLeft,
  Pencil,
  Bot,
  Paperclip,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Maximize2,
  X,
  Pin,
  PinOff,
  MoreHorizontal,
  ExternalLink,
  Tag,
  FileText,
  PanelLeft,
  PanelLeftClose,
  Bookmark,
} from "lucide-react";
import { FN_AGENT_ID, TASK_PLANNER_CHAT_AGENT_ID_PREFIX, useChat, type ChatMessageInfo, type ChatSessionInfo } from "../hooks/useChat";
import { useChatUnread } from "../hooks/useChatUnread";
import { useComposerDictation } from "../hooks/useComposerDictation";
import { useViewportMode } from "./Header";
import { isTabletTouchViewport } from "../hooks/useViewportMode";
import { fetchSettings, fetchChatSession, type DiscoveredSkill } from "../api";
import { isExperimentalFeatureEnabled, CHAT_FOCUS_FLAG, type Agent, type ChatTag, type Settings } from "@fusion/core";
import { MicButton } from "./MicButton";
import { ChatThinkingLevelControl } from "./ChatThinkingLevelControl";
import { ChatThreadTitleSwitcher } from "./ChatThreadTitleSwitcher";
import { PendingChatMessageQueue } from "./PendingChatMessageQueue";
import { ChatFocusSelector } from "./ChatFocusSelector";
import { AgentMentionPopup } from "./AgentMentionPopup";
import { ProviderIcon } from "./ProviderIcon";
import { FileMentionPopup } from "./FileMentionPopup";
import { CliChatSurface, type CliChatTier } from "./CliChatSurface";
import { useFileMention } from "../hooks/useFileMention";
import { useModelsCache } from "../hooks/useModelsCache";
import { useDiscoveredSkillsCache } from "../hooks/useDiscoveredSkillsCache";
import { useAgentsMapCache } from "../hooks/useAgentsMapCache";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileKeyboardViewportLock, isIOS } from "../hooks/useMobileScrollLock";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { matchesAgentMentionFilter } from "./mentionMatching";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { formatTokenCount } from "../utils/estimateChatTokens";
import { resolveChatContextUsage } from "../utils/chatContextUsage";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import { buildChatQuotePrefill } from "../utils/chatQuotePrefill";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ViewHeader } from "./ViewHeader";
import {
  StandardChatActionButton,
  StandardChatMessageItem,
  StandardStreamingMessage,
  formatModelTag,
} from "./StandardChatSurface";
import { buildChatReportHandoff, type ChatReportHandoff } from "./chatReportHandoff";
import { matchChatCommand, filterChatCommands, getSlashTriggerMatch, selectChatCommands, type ChatCommand } from "./chat-commands";
import { useChatMessageLayout } from "../context/ChatMessageLayoutContext";
import {
  createChatInputAutosizeController,
  type ChatInputAutosizeController,
} from "../utils/chatInputAutosize";

/*
FNXC:AgentMentionPopup 2026-08-24-03:34:
Direct-chat @ suggestions open above the composer like / skills because below-composer placement can hide them.
*/
const AGENT_MENTION_POPUP_POSITION = "above" as const;

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
  /**
   * FNXC:ChatFind 2026-08-21-16:44:
   * A retained-but-hidden Quick Chat must release document Find ownership; visible hosts retain the default.
   */
  findActive?: boolean;
  /*
  FNXC:MainViewKeepAlive 2026-08-30-19:05:
  A kept-alive ChatView retains its selected session, transcript, and composer while hidden.
  Inactive hosts must not acknowledge arriving messages; explicit user session selection remains active.
  */
  active?: boolean;
  /** Enables the "/" command registry (e.g. `/steer`) for this composer instance. See {@link ChatCommandContext}. */
  chatCommandContext?: ChatCommandContext;
  /*
  FNXC:RightDockChat 2026-06-27-23:12:
  The right dock can host ChatView in a 360px sidebar while the browser viewport remains desktop-sized. Let dock callers force the same narrow list/detail layout used by mobile/resized floating chat without passing floating chrome callbacks.
  */
  compactLayout?: boolean;
  onPopOut?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
  /** Opens this exact active Direct session in a separate in-app Quick Chat. */
  onOpenSessionInNewWindow?: (session: ChatSessionInfo) => void;
  /** Secondary windows start in Direct and keep selection/scope storage private. */
  initialDirectSession?: ChatSessionInfo;
  /** Monotonic pop-out focus signal; a repeated open restores this window's detail view. */
  initialDirectSessionNonce?: number;
  persistChatPreferences?: boolean;
  /** Optional external composer seed; paired with a nonce so repeated opens reseed intentionally. */
  initialComposerDraft?: string;
  initialComposerDraftNonce?: number;
  onSendAsReport?: (handoff: ChatReportHandoff) => void;
}

const CHAT_CONTEXT_MENU_FALLBACK_WIDTH_PX = 200;
const CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX = 8;

/** Returns an issue or pull-request URL as a standalone composer line. */
export function buildIssueChatPrefill(url: string): string {
  const trimmedUrl = url.trim();
  return trimmedUrl ? `${trimmedUrl}\n\n` : "";
}

export function resolveChatContextMenuPosition(
  anchorX: number,
  anchorY: number,
  anchorRight: boolean,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const maximumLeft = Math.max(CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX, viewportWidth - menuWidth - CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX);
  const maximumTop = Math.max(CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX, viewportHeight - menuHeight - CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX);
  const proposedLeft = anchorRight ? anchorX - menuWidth : anchorX;
  return {
    x: Math.min(Math.max(CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX, proposedLeft), maximumLeft),
    y: Math.min(Math.max(CHAT_CONTEXT_MENU_VIEWPORT_MARGIN_PX, anchorY), maximumTop),
  };
}
export const CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY = "fusion:chat-docked-sidebar-width";
export const CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY = "fusion:chat-docked-sidebar-open";
export const CHAT_DOCKED_SIDEBAR_MIN_WIDTH = 220;
export const CHAT_DOCKED_SIDEBAR_MAX_WIDTH = 480;
export const CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH = 300;

export function clampChatDockedSidebarWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(CHAT_DOCKED_SIDEBAR_MIN_WIDTH, Math.min(CHAT_DOCKED_SIDEBAR_MAX_WIDTH, width)) : CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH;
}

function readChatDockedSidebarWidth(persist: boolean): number {
  if (!persist || typeof window === "undefined") return CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY);
    const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? clampChatDockedSidebarWidth(value) : CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH;
  } catch { return CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH; }
}

function readChatDockedSidebarOpen(persist: boolean): boolean {
  if (!persist || typeof window === "undefined") return true;
  try { return window.localStorage.getItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY) !== "false"; } catch { return true; }
}

function persistChatDockedSidebarPreference(key: string, value: string, persist: boolean) {
  if (!persist || typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* Ignore unavailable storage. */ }
}
let chatViewWasPreviouslyInactive = false;
let activeChatFindOwner: HTMLElement | null = null;

export { clampChatInputHeight, resolveChatInputOverflowY } from "../utils/chatInputAutosize";

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

const CHAT_DRAFT_STORAGE_PREFIX = "fusion:chat-draft:";

function findSubmittedQuestionAnswer(messages: ChatMessageInfo[], messageIndex: number): string | undefined {
  return messages.slice(messageIndex + 1).find((message) => message.role === "user")?.content;
}

function getChatDraftKey(id: string | null | undefined): string | null {
  return id ? `${CHAT_DRAFT_STORAGE_PREFIX}direct:${id}` : null;
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

/*
FNXC:ChatAttachments 2026-07-23-00:00:
Chat must offer precisely the task-store attachment MIME set so picker, paste, and drop never stage
files that its upload routes reject. Keep this list aligned with CHAT_ALLOWED_MIME_TYPES on the API.
*/
const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/yaml",
  "text/x-toml",
  "text/csv",
  "application/xml",
];
const CHAT_ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime,.txt,.md,.json,.yaml,.yml,.toml,.csv,.xml";

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

/**
 * FNXC:ModalDismissal 2026-08-15-13:11:
 * Chat dialogs share this press-paired backdrop because a portaled model menu can re-anchor under
 * the mobile keyboard and deliver its release or synthesized click to the backdrop. Only a gesture
 * that starts and ends on the backdrop may dismiss its host dialog.
 */
function ChatDialogBackdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const overlayDismiss = useOverlayDismiss(onClose, { enabled: true });
  return <div className="chat-new-dialog-backdrop chat-view-dialog-backdrop" {...overlayDismiss}>{children}</div>;
}

type CopyFeedbackState = "success" | "error" | null;

export function ChatView({ projectId, addToast, floating = false, compactLayout = false, findActive = true, active = true, onPopOut, onMaximize, onClose, onOpenSessionInNewWindow, initialDirectSession, initialDirectSessionNonce, persistChatPreferences = true, chatCommandContext, initialComposerDraft, initialComposerDraftNonce, onSendAsReport }: ChatViewProps) {
  const { t } = useTranslation("app");
  const chatMessageLayout = useChatMessageLayout();
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

  const [chatSettings, setChatSettings] = useState<Settings | null>(null);
  /*
  FNXC:Chat-ThinkingLevel 2026-07-12-20:05:
  The chat Default thinking-level labels must surface the same resolved project/global default every dashboard model picker reads from Settings (`defaultThinkingLevel ?? "off"`) instead of hardcoding `off`.
  This fetch supplies the shared thinking-level control; send-time resolution remains centralized in `resolveExecutorThinkingLevel` in dashboard chat.ts.
  */
  useEffect(() => {
    let cancelled = false;
    setChatSettings(null);
    fetchSettings(projectId)
      .then((settings) => {
        if (!cancelled) {
          setChatSettings(settings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChatSettings(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const resolvedDefaultThinkingLevel = chatSettings?.defaultThinkingLevel ?? "off";
  const chatFocusEnabled = isExperimentalFeatureEnabled(chatSettings ?? undefined, CHAT_FOCUS_FLAG);
  const selectedChatCommands = useMemo(() => selectChatCommands({ chatFocusEnabled }), [chatFocusEnabled]);
  const chatDefaultTarget = useMemo(() => {
    /*
    FNXC:ChatModels 2026-07-12-20:45:
    New Chat has one project-scoped default target resolver shared by every affordance. A complete agent default wins only when kind=agent; a complete model pair wins only when kind=model; incomplete always-default settings fall back to the picker instead of creating an unroutable session.
    */
    if (chatSettings?.chatDefaultKind === "agent" && chatSettings.chatDefaultAgentId) {
      return {
        kind: "agent" as const,
        agentId: chatSettings.chatDefaultAgentId,
      };
    }
    if (chatSettings?.chatDefaultKind === "model" && chatSettings.chatDefaultModelProvider && chatSettings.chatDefaultModelId) {
      return {
        kind: "model" as const,
        modelProvider: chatSettings.chatDefaultModelProvider,
        modelId: chatSettings.chatDefaultModelId,
        thinkingLevel: chatSettings.chatDefaultThinkingLevel,
      };
    }
    return null;
  }, [chatSettings]);

  const {
    activeSession,
    sessions,
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
    archivedSessions,
    refreshArchivedSessions,
    unarchiveSession,
    renameSession,
    pinSession,
    pinnedCount,
    setSessionModel,
    setSessionThinkingLevel,
    deleteSession,
    backfillStashSession,
    tags = [],
    selectedTagId,
    setSelectedTagId,
    createTag,
    renameTag,
    deleteTag,
    setSessionTags,
    sendMessage,
    editMessageAndResend,
    stopStreaming,
    pendingMessages,
    pendingQueueAction,
    clearPendingMessage,
    updatePendingMessage,
    movePendingMessage,
    forceSendPendingMessage,
    loadMoreMessages,
    hasMoreMessages,
    searchQuery,
    setSearchQuery,
    filteredSessions,
    agentsMap: chatAgentsMap,
  } = useChat(projectId, addToast, { initialSession: initialDirectSession, persistActiveSession: persistChatPreferences });

  const { isUnread, markRead } = useChatUnread(projectId);
  const [messageInput, setMessageInput] = useState(() => getPersistedChatDraft(getChatDraftKey(activeSession?.id)));
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; anchorX: number; anchorY: number; anchorRight: boolean; x: number; y: number } | null>(null);
  /*
  FNXC:ChatStashBackfill 2026-08-19-16:28:
  (operator request 2026-08-19) Busy marker for the "Preserve to Stash" context-menu
  action — a backfill of a long chat is a chunked batch upload (Stash caps /events/batch
  at 100 events), so the button stays disabled for its duration instead of allowing a
  double-fire from the menu.
  */
  const [stashBackfillBusyId, setStashBackfillBusyId] = useState<string | null>(null);
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  /*
  FNXC:ChatMemoryFocus 2026-08-13:
  RUFU-068: local override of the active session's memoryFocus so a /focus slash
  dispatch (which persists via the API) reflects instantly on the chip without mutating
  the shared useChat store. undefined means "no override": fall back to the session's
  own memoryFocus. Switched/cleared together with the active session so a focus never
  leaks across conversations.
  */
  const [chatFocusOverride, setChatFocusOverride] = useState<string | null | undefined>(undefined);
  /*
  FNXC:ChatMemoryFocus 2026-08-13:
  The active session's persisted memory_focus topic, fetched once from the full session
  detail when the active session switches (the session-list item the useChat hook manages
  does not carry memoryFocus). Used only to seed the focus chip; recall scoping itself is
  enforced server-side by the Stash backend.
  */
  const [activeSessionFocus, setActiveSessionFocus] = useState<string | null>(null);
  const resolvedChatFocus = chatFocusOverride !== undefined ? chatFocusOverride : activeSessionFocus;
  useEffect(() => {
    // Reset any prior focus (override + fetched) the moment conversation changes so
    // a focus never leaks across sessions.
    setChatFocusOverride(undefined);
    setActiveSessionFocus(null);
    const sessionId = activeSession?.id;
    if (!sessionId) return;
    let cancelled = false;
    void fetchChatSession(sessionId, projectId)
      .then(({ session }) => {
        if (!cancelled) setActiveSessionFocus(session.memoryFocus ?? null);
      })
      .catch(() => {
        // Focus is a soft display signal; on a detail-fetch failure the chip simply
        // falls back to the whole-project/cleared state.
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, projectId]);
  /*
  FNXC:ChatSidebar 2026-07-17-00:12:
  FN-8191 positions each conversation-row action menu from its rendered dimensions, rather than a width derived from the default theme. This keeps the trigger edge aligned under alternate spacing themes and clamps all four actions inside both viewport axes.
  */
  const openSessionMenu = (
    sessionId: string,
    anchorX: number,
    anchorY: number,
    options?: { anchorRight?: boolean },
  ) => {
    if (typeof window === "undefined") return;

    setContextMenu({
      sessionId,
      anchorX,
      anchorY,
      anchorRight: options?.anchorRight ?? false,
      x: anchorX,
      y: anchorY,
    });
  };

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current || typeof window === "undefined") return;

    const menu = contextMenuRef.current;
    const bounds = menu.getBoundingClientRect();
    /* FNXC:ChatSidebar 2026-07-17-00:12: JSDOM has no layout, so its non-visual test fallback preserves the default-theme menu width while browsers always use rendered dimensions. */
    const width = bounds.width || menu.offsetWidth || CHAT_CONTEXT_MENU_FALLBACK_WIDTH_PX;
    const height = bounds.height || menu.offsetHeight;
    const position = resolveChatContextMenuPosition(
      contextMenu.anchorX,
      contextMenu.anchorY,
      contextMenu.anchorRight,
      width,
      height,
      window.innerWidth,
      window.innerHeight,
    );

    if (position.x !== contextMenu.x || position.y !== contextMenu.y) {
      setContextMenu({ ...contextMenu, ...position });
    }
  }, [contextMenu]);
  const [renameDialog, setRenameDialog] = useState<{ sessionId: string; title: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [renameTagDialog, setRenameTagDialog] = useState<{ id: string; name: string } | null>(null);
  const [renameTagName, setRenameTagName] = useState("");
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<ChatTag | null>(null);
  /*
  FNXC:ChatNavigation 2026-08-19-19:36:
  Chat is a list/detail flow on every host. The list alone owns selection and
  conversation management; detail owns the thread and its single return path.
  Keep this local state independent of useChat's restored active session so a
  remount never creates a phantom drill-in history entry or replaces a stream.
  A dedicated pop-out starts on its requested thread; ordinary hosts still start on the list.
  Visible Back must consume its pushed navigation entry; popstate uses the raw
  return callback so either route restores the same list state.

  FNXC:ChatWindows 2026-08-27-09:09:
  FN-193 makes useChat expose initialDirectSession on the first committed render. Seed detail and previous detail state from that same requested session so a dedicated pop-out paints its thread without pushing a phantom navigation-history entry.
  */
  const [detailOpen, setDetailOpen] = useState(() => Boolean(initialDirectSession));
  /*
  FNXC:ChatNavigation 2026-08-23-03:33:
  FN-169 automatic detail opening is not a user drill-in. Suppress exactly its next false-to-true
  transition, including when selection resolves after the first render; manual Back then selection
  still contributes one history entry.
  */
  const suppressAutomaticDetailNavRef = useRef(Boolean(initialDirectSession));
  const previousInitialDirectSessionNonceRef = useRef(initialDirectSessionNonce);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const { agentsMap: cachedAgentsMap } = useAgentsMapCache(projectId);
  const agentsMap = useMemo(() => (chatAgentsMap.size > 0 ? chatAgentsMap : cachedAgentsMap), [cachedAgentsMap, chatAgentsMap]);
  const { models, favoriteProviders, favoriteModels, defaultProvider, defaultModelId } = useModelsCache();
  const defaultModel = useMemo<DefaultModelSelection>(() => ({ provider: defaultProvider, modelId: defaultModelId }), [defaultModelId, defaultProvider]);
  const _dialogDefaultModel = useMemo<DefaultModelSelection>(() => {
    if (chatDefaultTarget?.kind === "model") {
      return { provider: chatDefaultTarget.modelProvider, modelId: chatDefaultTarget.modelId };
    }
    return defaultModel;
  }, [chatDefaultTarget, defaultModel]);
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
  const { pushNav, removeNav } = useNavigationHistoryContext();

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
  const listSearchInputRef = useRef<HTMLInputElement>(null);
  const conversationSearchInputRef = useRef<HTMLInputElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const lastAnchoredThreadStateRef = useRef<{ threadId: string; loaded: boolean; hasMessages: boolean } | null>(null);
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
  const clippedMessageFrameRef = useRef<number | null>(null);
  const [topClippedMessageIds, setTopClippedMessageIds] = useState<Set<string>>(() => new Set());
  // FN-5365: mirror QuickChat's mid-dismiss suppress gate so transient
  // visualViewport shrink samples do not jerk the chat thread/composer.
  const suppressVvShrinkRef = useRef(false);
  const suppressVvShrinkTimeoutRef = useRef<number | null>(null);
  // Deferred drift-reset scheduled on blur; cancelled on the next focus so a
  // quick re-tap never scrolls the document while iOS is raising the keyboard.
  const blurScrollResetTimeoutRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputAutosizeRef = useRef<ChatInputAutosizeController | null>(null);
  // FNXC:VoiceInput 2026-08-24-03:34:
  // Direct Chat owns one composer ref and dictation adapter so transcripts always target its textarea.
  const appliedComposerDraftNonceRef = useRef<number | undefined>(undefined);
  const focusComposerAfterPrefillRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const mentionCursorPosRef = useRef(0);
  const copyFeedbackTimeoutsRef = useRef<Map<string, number>>(new Map());
  /*
  FNXC:ChatSendDedupe 2026-06-17-08:36:
  FN-6576 refines FN-6563 by matching QuickChatFAB's two-latch touch contract: pointerdown/touchstart claim a per-input-task gesture so one mobile tap sends exactly once, while the separate 700ms latch is consumed only by a trailing click. A suppressed iOS click must never leave the long latch blocking the next tap; a send-to-stop DOM swap must consume the trailing click without swallowing a genuine later stop tap.
  */
  const mode = useViewportMode();
  const isMobile = mode === "mobile";
  const isTablet = mode === "tablet";
  const chatViewRef = useRef<HTMLDivElement>(null);
  const appliedThreadTranslateYRef = useRef(0);
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
  const keyboardTrackedHost = isChatMobile || isTablet;
  /*
  FNXC:ChatNavigation 2026-08-23-03:40:
  FN-9193 restores an optional conversation list only for non-floating tablet-or-wider hosts.
  Mobile, compact dock, and floating hosts retain their one-pane list/detail contract.
  */
  const [dockedSidebarWidth, setDockedSidebarWidth] = useState(() => readChatDockedSidebarWidth(persistChatPreferences));
  const [dockedSidebarOpen, setDockedSidebarOpen] = useState(() => readChatDockedSidebarOpen(persistChatPreferences));
  const resizeTeardownRef = useRef<(() => void) | null>(null);
  const dockedSidebarEligible = !floating && !isChatMobile;
  const dockedSidebarVisible = dockedSidebarEligible && dockedSidebarOpen;

  useEffect(() => {
    if (!active || !activeSession?.id) {
      return;
    }

    markRead("direct", activeSession.id, activeSession.lastMessageAt ?? activeSession.updatedAt);
  }, [active, activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, markRead]);


  useEffect(() => {
    if (!active || !activeSession?.id || messages.length === 0) {
      return;
    }

    const latestMessage = messages[messages.length - 1];
    markRead("direct", activeSession.id, latestMessage?.createdAt ?? activeSession.lastMessageAt ?? activeSession.updatedAt);
  }, [active, activeSession?.id, activeSession?.lastMessageAt, activeSession?.updatedAt, markRead, messages]);



  const activeDraftKey = getChatDraftKey(activeSession?.id);
  const lastDraftKeyRef = useRef<string | null>(activeDraftKey);
  const skipNextDraftRestoreRef = useRef(false);

  useEffect(() => {
    if (activeDraftKey === lastDraftKeyRef.current) {
      return;
    }

    lastDraftKeyRef.current = activeDraftKey;
    if (skipNextDraftRestoreRef.current) {
      skipNextDraftRestoreRef.current = false;
      return;
    }
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

  /*
  FNXC:ChatComposer 2026-08-23-16:07:
  The composer must track the soft keyboard on every Fusion-classified Chat host, not only a
  phone-width viewport. Keep enabled and allowNonMobileViewport on keyboardTrackedHost so the
  hook's internal width heuristic cannot disagree with Chat's tablet, dock, or floating host.
  */
  const { keyboardOverlap, keyboardOpen } = useMobileKeyboard({
    enabled: keyboardTrackedHost && !!activeSession,
    allowNonMobileViewport: keyboardTrackedHost,
  });

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
    return filterChatCommands(skillFilter, selectedChatCommands);
  }, [chatCommandContext, skillFilter, selectedChatCommands]);

  const skillMenuEntries = useMemo<SkillMenuEntry[]>(() => {
    const commandEntries: SkillMenuEntry[] = filteredCommands.map((command) => ({
      kind: "command",
      command,
      disabled: command.requiresAgent && !chatCommandContext?.agentRunning,
    }));
    const skillEntries: SkillMenuEntry[] = filteredSkills.map((skill) => ({ kind: "skill", skill }));
    return [...commandEntries, ...skillEntries];
  }, [filteredCommands, filteredSkills, chatCommandContext]);

  /*
  FNXC:ChatDirectOnly 2026-08-23-03:10:
  ChatView no longer subscribes to or renders persistent Rooms. @agent suggestions list every
  available agent because a mention dispatches that one direct-chat turn to the agent's own model.
  */
  const mentionAgents = useMemo(() => Array.from(agentsMap.values()), [agentsMap]);
  const filteredMentionAgents = useMemo(
    () => mentionAgents.filter((agent) => matchesAgentMentionFilter(agent.name, mentionFilter)),
    [mentionAgents, mentionFilter],
  );

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
    return activeSession?.id ?? null;
  }, [activeSession?.id]);

  const getMessageElement = useCallback((container: HTMLElement, messageId: string) => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return container.querySelector<HTMLElement>(`.chat-message[data-message-id="${CSS.escape(messageId)}"]`);
    }
    return container.querySelector<HTMLElement>(`.chat-message[data-message-id="${messageId.replace(/"/g, "\\\"")}"]`);
  }, []);

  const updateTopClippedMessages = useCallback(() => {
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;

    const containerTop = messagesContainer.getBoundingClientRect().top;
    const nextIds = new Set<string>();
    messagesContainer.querySelectorAll<HTMLElement>(".chat-message--assistant:not(.chat-message--failure)[data-message-id]").forEach((element) => {
      const messageId = element.getAttribute("data-message-id");
      if (!messageId) return;
      if (element.getBoundingClientRect().top < containerTop) {
        nextIds.add(messageId);
      }
    });

    setTopClippedMessageIds((previousIds) => {
      if (previousIds.size === nextIds.size && Array.from(previousIds).every((id) => nextIds.has(id))) {
        return previousIds;
      }
      return nextIds;
    });
  }, []);

  const scheduleTopClippedMessageUpdate = useCallback(() => {
    if (!messagesContainerRef.current || clippedMessageFrameRef.current !== null) return;
    clippedMessageFrameRef.current = window.requestAnimationFrame(() => {
      clippedMessageFrameRef.current = null;
      updateTopClippedMessages();
    });
  }, [updateTopClippedMessages]);

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
    scheduleTopClippedMessageUpdate();
  }, [captureScrollSnapshot, scheduleTopClippedMessageUpdate]);

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

  const activeThreadMessages = messages;
  const conversationSearchMatches = useMemo(() => {
    const query = conversationSearchQuery.trim().toLocaleLowerCase();
    if (!query) return [] as string[];
    const messageIds = activeThreadMessages
      .filter((message) => message.content.toLocaleLowerCase().includes(query))
      .map((message) => message.id);
    if (isStreaming && streamingText.toLocaleLowerCase().includes(query)) messageIds.push("__streaming__");
    return messageIds;
  }, [activeThreadMessages, conversationSearchQuery, isStreaming, streamingText]);
  const activeConversationMatchId = conversationSearchMatches[conversationSearchIndex] ?? null;

  /*
  FNXC:ChatMessageScrollToTop 2026-07-12-23:16:
  ChatView owns the `.chat-messages` viewport, so it measures assistant message tops against the container's visible top on scroll/message changes and passes clipped membership down. The go-to-top control remains DOM-mounted by StandardChatSurface but becomes visually available only after the message's top has moved above this container edge.
  */
  useLayoutEffect(() => {
    scheduleTopClippedMessageUpdate();
    return () => {
      if (clippedMessageFrameRef.current !== null) {
        window.cancelAnimationFrame(clippedMessageFrameRef.current);
        clippedMessageFrameRef.current = null;
      }
    };
  }, [activeThreadMessages, scheduleTopClippedMessageUpdate]);

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
    });
  }, [activeThreadMessages.length]);

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

    const threadId = activeSession?.id ?? null;
    if (!threadId) {
      lastAnchoredThreadStateRef.current = null;
      return;
    }

    const nextState = {
      threadId,
      loaded: !messagesLoading,
      hasMessages: messages.length > 0,
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
    {
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
  /*
  FNXC:ChatScrollAnchor 2026-08-23-23:20:
  `detailOpen` is a dependency because list-first navigation (FN-054) mounts `.chat-messages` only
  when the conversation is opened. Without it this effect last ran while the thread pane did not
  exist, bailed at the missing container WITHOUT recording `lastAnchoredThreadStateRef`, and so (a)
  opening a conversation never anchored to its newest message and (b) the next message growth saw a
  null previous state and FORCE-anchored, yanking a reader who had scrolled up to the bottom.
  */
  }, [
    activeSession?.id,
    messages.length,
    messagesLoading,
    detailOpen,
    anchorToBottom,
  ]);

  /*
  FNXC:Chat 2026-07-18-14:09:
  FN-8339 confirms regular Chat shares the pinned-bottom invariant with task chat and agent logs. `isUserScrollingRef` changes synchronously on a genuine scroll event, so streamed deltas and their settle frames must return without writing while the reader is above the bottom threshold; explicit jump-to-latest resets that ref before anchoring.
  */
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

  /*
  FNXC:ChatComposer 2026-08-23-16:07:
  The composer must remain inside the visual viewport whenever Fusion knows a soft keyboard is
  up on phone portrait/landscape, tablet, compact dock, or narrow floating Chat. The writer,
  hook enabled state, and allowNonMobileViewport deliberately share keyboardTrackedHost so their
  host gates cannot drift. Detection remains a layout-height-minus-visual-height gap; the measured
  thread top lets CSS account for dock/floating chrome instead of assuming only the app header.
  Landscape-phone keyboard state newly reaches the existing touch guard while its body lock keeps
  its own phone-width iOS gate, so this does not add body pinning on wide hosts.
  */
  useLayoutEffect(() => {
    if (!keyboardTrackedHost || !activeSession) return;
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
        thread.style.removeProperty("--chat-thread-viewport-top");
        thread.style.transform = "";
        thread.style.willChange = "";
        appliedThreadTranslateYRef.current = 0;
        return;
      }
      const overlap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      const offsetTop = vv.offsetTop || 0;
      thread.style.setProperty("--vv-height", `${vv.height}px`);
      thread.style.setProperty("--vv-offset-top", `${offsetTop}px`);
      thread.style.setProperty("--keyboard-overlap", `${overlap}px`);

      const threadRect = thread.getBoundingClientRect();
      if (threadRect.height > 0) {
        const untransformedTop = Math.max(0, threadRect.top - appliedThreadTranslateYRef.current - offsetTop);
        const viewportTop = Math.min(vv.height, untransformedTop);
        thread.style.setProperty("--chat-thread-viewport-top", `${viewportTop}px`);
      } else {
        thread.style.removeProperty("--chat-thread-viewport-top");
      }

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
        appliedThreadTranslateYRef.current = offsetTop;
      } else {
        thread.style.transform = "";
        thread.style.willChange = "";
        appliedThreadTranslateYRef.current = 0;
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
      thread.style.removeProperty("--chat-thread-viewport-top");
      thread.style.transform = "";
      thread.style.willChange = "";
      appliedThreadTranslateYRef.current = 0;
    };
  }, [activeSession, keyboardTrackedHost]);

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
    if (!activeSession) {
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
  }, [isChatMobile, isMobile, activeSession, captureScrollSnapshot, scrollToBottom]);

  useEffect(() => {
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
  }, [anchorToBottom, activeSession?.id]);

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
    /*
    FNXC:ChatAttachments 2026-07-23-00:00:
    Chat paste must use the same MIME validation path as picker and drop. Filtering clipboard data
    to images made supported text files disappear before the authoritative server validation ran.
    */
    handleAttachmentFiles(event.clipboardData?.files);
  }, [handleAttachmentFiles]);

  // Handle create session
  const handleCreateSession = useCallback(
    async (
      input: { agentId: string; modelProvider?: string; modelId?: string; thinkingLevel?: string },
      options?: { openInNewWindow?: boolean },
    ): Promise<ChatSessionInfo | null> => {
      try {
        if (options?.openInNewWindow) {
          const session = await createSession(input, { keepActiveSession: true });
          onOpenSessionInNewWindow?.(session);
          return session;
        }
        const session = await createSession(input);
        setDetailOpen(true);
        return session;
      } catch {
        addToast(t("chat.failedToCreateSession", "Failed to create chat session"), "error");
        return null;
      }
    },
    [addToast, createSession, onOpenSessionInNewWindow, t],
  );

  /*
  FNXC:ChatWindows 2026-08-23-04:29:
  Ctrl/Cmd-click must create a conversation beside, never in place of, the conversation currently
  open in this host. The plain path intentionally retains the existing in-place selection behavior.
  */
  const handleNewChat = useCallback((event?: React.MouseEvent<HTMLButtonElement>) => {
    const openInNewWindow = Boolean((event?.ctrlKey || event?.metaKey) && onOpenSessionInNewWindow);
    if (chatDefaultTarget?.kind === "agent") {
      const input = { agentId: chatDefaultTarget.agentId };
      void (openInNewWindow ? handleCreateSession(input, { openInNewWindow: true }) : handleCreateSession(input));
      return;
    }
    if (chatDefaultTarget?.kind === "model") {
      const input = { agentId: FN_AGENT_ID, modelProvider: chatDefaultTarget.modelProvider, modelId: chatDefaultTarget.modelId, thinkingLevel: chatDefaultTarget.thinkingLevel };
      void (openInNewWindow ? handleCreateSession(input, { openInNewWindow: true }) : handleCreateSession(input));
      return;
    }
    if (defaultModel.provider && defaultModel.modelId) {
      const input = { agentId: FN_AGENT_ID, modelProvider: defaultModel.provider, modelId: defaultModel.modelId };
      void (openInNewWindow ? handleCreateSession(input, { openInNewWindow: true }) : handleCreateSession(input));
      return;
    }
    addToast(t("chat.noDefaultModelConfigured", "Configure a default chat model in Settings before creating a conversation."), "error");
  }, [addToast, chatDefaultTarget, defaultModel, handleCreateSession, onOpenSessionInNewWindow, t]);

  const resizeComposer = useCallback(() => {
    inputAutosizeRef.current?.resize();
  }, []);

  // FNXC:VoiceInput 2026-07-24-05:00: Dictation uses this same post-render resize path as
  // keyboard input in the single direct composer.
  const composerDictation = useComposerDictation({
    textareaRef: inputRef,
    value: messageInput,
    onChange: setMessageInput,
    onResize: () => resizeComposer(),
    projectId,
  });

  const handleComposerRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    inputAutosizeRef.current?.destroy();
    inputAutosizeRef.current = null;
    inputRef.current = textarea;
    if (!textarea) return;
    inputAutosizeRef.current = createChatInputAutosizeController(textarea);
  }, []);

  useLayoutEffect(() => {
    resizeComposer();
    if (focusComposerAfterPrefillRef.current) {
      focusComposerAfterPrefillRef.current = false;
      inputRef.current?.focus();
    }
  }, [messageInput, activeSession?.id, resizeComposer]);

  /*
  FNXC:ChatComposerPrefill 2026-07-30-12:00:
  The GitHub Import Chat action seeds, but never sends, a selected issue or PR link. A nonce makes
  repeated opens deliberate reseeds rather than render-time clobbers; each seed returns Chat to
  direct scope and focuses the composer so the operator can add their question immediately.

  FNXC:ChatComposerPrefill 2026-07-30-12:30:
  Draft-restore suppression is only armed when the prefill changes draft scope/session. If an
  always-default session creation fails while already direct, leave other sessions' saved drafts
  eligible for restoration instead of leaking the imported link into the next selected session.
  */
  useEffect(() => {
    if (
      initialComposerDraftNonce === undefined ||
      initialComposerDraftNonce === appliedComposerDraftNonceRef.current ||
      !initialComposerDraft?.trim()
    ) {
      return;
    }

    appliedComposerDraftNonceRef.current = initialComposerDraftNonce;
    /*
    FNXC:ChatComposerPrefill 2026-08-23-23:20:
    List-first navigation (FN-054) renders the composer only inside an opened conversation, so a seed
    that merely sets state would leave the imported link invisible and unfocusable behind the
    conversation list. Opening detail is part of the seed: the operator must land in the composer with
    the link already typed.
    */
    const seedComposer = (willChangeDraftTarget: boolean) => {
      if (willChangeDraftTarget) {
        skipNextDraftRestoreRef.current = true;
      }
      setDetailOpen(true);
      focusComposerAfterPrefillRef.current = true;
      setMessageInput(initialComposerDraft);
    };

    seedComposer(false);
  }, [initialComposerDraft, initialComposerDraftNonce]);

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

  /*
  FNXC:ChatAttachments 2026-08-10-05:53:
  Composer previews leave only after the server accepts their File set, not after stream or refetch completion. Filtering inside the state updater makes repeated terminal backstops idempotent and preserves files staged after acceptance.
  */
  const releaseSentAttachments = useCallback((sentFiles: Set<File>) => {
    setPendingAttachments((prev) => {
      const released = prev.filter((attachment) => sentFiles.has(attachment.file));
      for (const attachment of released) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return prev.filter((attachment) => !sentFiles.has(attachment.file));
    });
  }, []);

  // Handle send message including pending attachment uploads.
  const handleSend = useCallback(() => {
    const trimmed = messageInput.trim();
    const files = pendingAttachments.map((attachment) => attachment.file);
    if ((!trimmed && files.length === 0) || !activeSession) return;

    if (chatCommandContext) {
      const commandMatch = matchChatCommand(trimmed, selectedChatCommands);
      if (commandMatch) {
        // FNXC:ChatMemoryFocus (RUFU-068): only agent-gated commands (steer) are
        // refused without a running agent. /focus is a local session-setting command
        // and stays dispatchable regardless of agent state.
        if (commandMatch.command.requiresAgent && !chatCommandContext.agentRunning) {
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
            sessionId: activeSession?.id ?? "",
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
      /*
      FNXC:ChatSlashCommands 2026-08-10-05:57:
      Exact /clear and /new route through clearComposerState(), which revokes staged preview URLs and discards unsent Files. Refuse with feedback, matching command attachment handling, instead of silently destroying them.
      */
      if (files.length > 0) {
        addToast(t("chat.clearNoAttachments", "Remove the attachments before running /clear or /new — they would be discarded unsent"), "warning");
        return;
      }

      /*
      FNXC:ChatSlashCommands 2026-07-23-12:00:
      `/new`//`/clear` must never wipe a task-bound planner chat. With `showTaskChatsInCommonFeed`
      enabled, task-planner sessions appear in the common Direct feed, so a user can run `/new`
      against one directly — but that transcript is the task's planner history, and createSession
      would orphan it behind a fresh session. Consume the command with feedback instead of clearing.
      */
      if (activeSession.agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX)) {
        clearComposerState();
        addToast(t("chat.newNotAllowedForTaskChat", "This chat is tied to a task — /new and /clear can't clear it"), "warning");
        return;
      }
      clearComposerState();
      clearPendingMessage();
      /*
      FNXC:ChatCancellation 2026-08-21-01:36:
      `/new` and `/clear` cross the cancellation barrier even when local isStreaming is false,
      because only the project-scoped manager can fence active work. Its idle success result means
      no interrupted response exists to save, so session replacement must not show a recovery error.
      */
      void stopStreaming()
        .then(() => createSession({
          agentId: activeSession.agentId,
          modelProvider: activeSession.modelProvider ?? undefined,
          modelId: activeSession.modelId ?? undefined,
          thinkingLevel: activeSession.thinkingLevel ?? undefined,
        }))
        .catch(() => {
          addToast(t("chat.failedToClearConversation", "Failed to clear conversation"), "error");
        });
      return;
    }

    if (isStreaming && files.length > 0) {
      /*
      FNXC:ChatAttachments 2026-08-10-05:53:
      Queued direct turns carry text only, so refuse staged attachments during a live reply rather than orphaning previews for files the queue cannot send.
      */
      addToast(t("chat.attachmentsNotQueued", "Attachments can't be queued while a reply is streaming — wait for it to finish"), "warning");
      return;
    }

    const sentFiles = new Set(files);
    setMessageInput("");
    try {
      sendMessage(trimmed, files, {
        onAccepted: () => releaseSentAttachments(sentFiles),
        // Completion remains an idempotent backstop for accepted provider-error and legacy paths.
        onDelivered: () => releaseSentAttachments(sentFiles),
        onFailed: () => {
          // Do not overwrite text the user entered while the failed request was in flight.
          setMessageInput((current) => current || trimmed);
        },
      });
    } catch {
      setMessageInput(trimmed);
    }
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
    isStreaming,
    releaseSentAttachments,
    selectedChatCommands,
    t,
  ]);


  const handleSendDispatch = useCallback(async () => {
    const trimmed = messageInput.trim();
    const files = pendingAttachments.map((attachment) => attachment.file);
    /**
     * FNXC:Chat 2026-08-24-03:34:
     * Direct Chat permits attachment-only sends. Block only a truly empty composer so staged files reach the backend without filler text.
     */
    if (!trimmed && files.length === 0) {
      return;
    }

    handleSend();
  }, [messageInput, pendingAttachments, handleSend]);

  const handleQuestionSubmit = useCallback(async (answerText: string) => {
    if (!activeSession) {
      return;
    }

    sendMessage(answerText);
  }, [activeSession, sendMessage]);

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
          resizeComposer();
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
          resizeComposer();
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
        resizeComposer();
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
        resizeComposer();
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
    resizeComposer();

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

  const handleRestoreArchived = useCallback(async (id: string) => {
    try { await unarchiveSession(id); addToast(t("chat.conversationRestored", "Conversation restored"), "success"); }
    catch { addToast(t("chat.failedToRestoreConversation", "Failed to restore conversation"), "error"); }
  }, [unarchiveSession, addToast, t]);

  const openRenameDialog = useCallback(
    (id: string) => {
      const session = filteredSessions.find((item) => item.id === id) ?? (activeSession?.id === id ? activeSession : null);
      setContextMenu(null);
      setRenameTitle(session?.title ?? "");
      setRenameDialog({ sessionId: id, title: session?.title ?? "" });
    },
    [activeSession, filteredSessions],
  );

  /** Regular chat saves list-owned rename actions through the shared hook. */
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

  const handlePin = useCallback(
    async (id: string, pinned: boolean) => {
      setContextMenu(null);
      try {
        await pinSession(id, pinned);
        addToast(pinned ? t("chat.conversationPinned", "Conversation pinned") : t("chat.conversationUnpinned", "Conversation unpinned"), "success");
      } catch {
        // useChat restores optimistic state and reports the server rejection.
      }
    },
    [addToast, pinSession, t],
  );

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

  useEffect(() => () => resizeTeardownRef.current?.(), []);

  const persistDockedWidth = useCallback((nextWidth: number) => {
    persistChatDockedSidebarPreference(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth), persistChatPreferences);
  }, [persistChatPreferences]);

  const handleDockedResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = dockedSidebarWidth;
    let latestWidth = startWidth;
    const priorUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (move: PointerEvent) => { latestWidth = clampChatDockedSidebarWidth(startWidth + move.clientX - startX); setDockedSidebarWidth(latestWidth); };
    const teardown = (up?: PointerEvent) => {
      if (up) handle.releasePointerCapture?.(up.pointerId);
      document.body.style.userSelect = priorUserSelect;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      resizeTeardownRef.current = null;
      persistDockedWidth(latestWidth);
    };
    const onUp = (up: PointerEvent) => teardown(up);
    resizeTeardownRef.current?.();
    resizeTeardownRef.current = () => teardown();
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }, [dockedSidebarWidth, persistDockedWidth]);

  const handleDockedResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextWidth = clampChatDockedSidebarWidth(dockedSidebarWidth + (event.key === "ArrowRight" ? 16 : -16));
    setDockedSidebarWidth(nextWidth);
    persistDockedWidth(nextWidth);
  }, [dockedSidebarWidth, persistDockedWidth]);

  /*
  FNXC:ChatStashBackfill 2026-08-19-16:28:
  (operator request 2026-08-19) "Preserve to Stash" context-menu action: backfills this
  chat's FULL message history into Stash (old chats predate the live per-turn capture).
  Rendered only when the project memory backend is Stash (chatSettings gate); the route
  re-validates the same gates server-side, so the UI gate is affordance, not security.
  */
  const handleBackfillStash = useCallback(
    async (id: string) => {
      setContextMenu(null);
      if (stashBackfillBusyId) return;
      setStashBackfillBusyId(id);
      try {
        const result = await backfillStashSession(id);
        addToast(
          result.ok
            ? t("chat.preserveToStashDone", "Uploaded {{uploaded}} messages to Stash ({{skipped}} already stored)", {
                uploaded: result.uploaded,
                skipped: result.skipped,
              })
            : t("chat.preserveToStashFailed", "Stash upload failed: {{error}}", { error: result.error ?? "unknown error" }),
          result.ok ? "success" : "error",
        );
      } catch (err) {
        addToast(
          t("chat.preserveToStashFailed", "Stash upload failed: {{error}}", {
            error: err instanceof Error ? err.message : String(err),
          }),
          "error",
        );
      } finally {
        setStashBackfillBusyId(null);
      }
    },
    [addToast, backfillStashSession, stashBackfillBusyId, t],
  );

  // Handle session click
  const handleSessionClick = useCallback(
    (id: string) => {
      const selectedSession = filteredSessions.find((session) => session.id === id);
      markRead("direct", id, selectedSession?.lastMessageAt ?? selectedSession?.updatedAt);
      selectSession(id);
      setDetailOpen(true);
    },
    [filteredSessions, markRead, selectSession],
  );

  const handleBack = useCallback(() => {
    setDetailOpen(false);
    setConversationSearchOpen(false);
    setConversationSearchQuery("");
    setConversationSearchIndex(0);
  }, []);

  const handleVisibleDetailBack = useCallback(() => {
    handleBack();
    removeNav?.(handleBack);
  }, [handleBack, removeNav]);

  // Render empty state (no active session)
  const renderEmptyState = () => {
    return (
      <div className="chat-empty-state">
        <MessageSquare size={48} strokeWidth={1.5} />
        <h2>{t("chat.startNewConversation", "Start a new conversation")}</h2>
        <button
          className="btn btn-primary"
          onClick={handleNewChat}
          data-testid="chat-new-btn-empty"
          title={onOpenSessionInNewWindow ? t("chat.newChatOpenInNewWindowHint", "Ctrl/Cmd + click to open the new conversation in a separate window") : undefined}
        >
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
  const chatContextUsage = useMemo(
    () => resolveChatContextUsage({
      messages,
      streamingText: isStreaming ? streamingText : null,
      fallbackContextWindow: activeContextWindow,
    }),
    [activeContextWindow, isStreaming, messages, streamingText],
  );
  const activeModelTag = formatModelTag(activeResolvedModel?.provider, activeResolvedModel?.modelId);
  const activeModelProvider = activeResolvedModel?.provider ?? null;
  const hasThreadInView = Boolean(activeSession || isStreaming || messages.length > 0);
  const hasDetailSelection = detailOpen && hasThreadInView;
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

  const previousDetailOpenRef = useRef(hasDetailSelection);
  const focusedComposerThreadRef = useRef<string | null>(null);
  const suppressComposerFocus = isMobile || isTabletTouchViewport(mode);

  /*
  FNXC:ChatComposerFocus 2026-09-01-01:04:
  Opening or creating a conversation must put the caret in its composer so operators can type immediately without a mouse click. `findActive` is the focus-ownership gate because a retained-but-hidden Quick Chat stays mounted and portaled; reopening it onto an existing thread is itself an open.

  Phone and touch-tablet hosts deliberately keep focus off the composer: an unsolicited software keyboard would cover a freshly opened thread, and programmatic focus without a user gesture cannot reliably raise the iOS keyboard. Record the thread before that suppression so a later viewport or orientation change cannot retroactively steal focus.
  */
  useEffect(() => {
    if (!findActive || !hasDetailSelection || !activeSession) {
      focusedComposerThreadRef.current = null;
      return;
    }

    const threadKey = `${activeSession.id}:${initialDirectSessionNonce ?? 0}`;
    if (focusedComposerThreadRef.current === threadKey) return;
    focusedComposerThreadRef.current = threadKey;
    if (suppressComposerFocus) return;

    inputRef.current?.focus();
  }, [activeSession?.id, findActive, hasDetailSelection, initialDirectSessionNonce, suppressComposerFocus]);

  useEffect(() => {
    if (initialDirectSessionNonce === previousInitialDirectSessionNonceRef.current) return;
    previousInitialDirectSessionNonceRef.current = initialDirectSessionNonce;
    if (!initialDirectSession) return;
    suppressAutomaticDetailNavRef.current = true;
    setDetailOpen(true);
    /*
    FNXC:ChatWindows 2026-08-23-03:33:
    FN-169 must not re-select an already active streaming session: selectSession clears transient
    composer and stream state. A re-open only selects when its requested session is different.
    */
    if (activeSession?.id !== initialDirectSession.id) {
      selectSession(initialDirectSession.id, initialDirectSession);
    }
  }, [activeSession?.id, initialDirectSession, initialDirectSessionNonce, selectSession]);

  /*
  FNXC:ChatFind 2026-08-21-16:29:
  FN-110 keeps browser Find outside Chat while the visible, activated Chat host owns Ctrl/Cmd+F. List Find reuses its server-backed input; thread Find is presentation-only over rendered rows and never changes chat state.
  */
  useEffect(() => {
    if (!conversationSearchOpen) return;
    setConversationSearchIndex((index) => Math.min(index, Math.max(0, conversationSearchMatches.length - 1)));
  }, [conversationSearchMatches.length, conversationSearchOpen]);

  useEffect(() => {
    setConversationSearchOpen(false);
    setConversationSearchQuery("");
    setConversationSearchIndex(0);
  }, [activeSession?.id]);

  const focusConversationSearch = useCallback(() => {
    setConversationSearchOpen(true);
    window.setTimeout(() => conversationSearchInputRef.current?.focus(), 0);
  }, []);

  const closeConversationSearch = useCallback(() => {
    setConversationSearchOpen(false);
    setConversationSearchQuery("");
    setConversationSearchIndex(0);
  }, []);

  const navigateConversationSearch = useCallback((direction: 1 | -1) => {
    if (conversationSearchMatches.length === 0) return;
    setConversationSearchIndex((index) => (index + direction + conversationSearchMatches.length) % conversationSearchMatches.length);
  }, [conversationSearchMatches.length]);

  useEffect(() => {
    if (!activeConversationMatchId) return;
    const message = messagesContainerRef.current?.querySelector<HTMLElement>(`[data-message-id="${activeConversationMatchId}"]`);
    message?.scrollIntoView({ block: "nearest" });
  }, [activeConversationMatchId]);

  useEffect(() => {
    const root = chatViewRef.current;
    if (!root) return;
    if (!findActive) {
      if (activeChatFindOwner === root) activeChatFindOwner = null;
      return;
    }
    const activate = () => { activeChatFindOwner = root; };
    root.addEventListener("pointerdown", activate);
    root.addEventListener("focusin", activate);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || event.altKey || (!event.ctrlKey && !event.metaKey)) return;
      const target = event.target instanceof Element ? event.target : null;
      const ownsTarget = Boolean(target?.closest(".chat-view") === root);
      const nestedDialog = target?.closest("[role=dialog]");
      if ((!ownsTarget && activeChatFindOwner !== root) || nestedDialog || target?.closest(".xterm, [data-terminal-owner]")) return;
      if (!hasDetailSelection) {
        event.preventDefault();
        listSearchInputRef.current?.focus();
        return;
      }
      if (cliChatActive && cliChatTier === "generic") return;
      event.preventDefault();
      focusConversationSearch();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("pointerdown", activate);
      root.removeEventListener("focusin", activate);
      if (activeChatFindOwner === root) activeChatFindOwner = null;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [cliChatActive, cliChatTier, findActive, focusConversationSearch, hasDetailSelection]);

  const renderConversationSearch = () => {
    if (!conversationSearchOpen) return null;
    const count = conversationSearchMatches.length;
    const status = count === 0
      ? t("chat.conversationSearchNoMatches", "No matches")
      : t("chat.conversationSearchMatchCount", "{{current}} of {{count}} matches", { current: conversationSearchIndex + 1, count });
    return <div className="chat-conversation-search" data-testid="chat-conversation-search">
      <Search size={14} aria-hidden="true" />
      <input ref={conversationSearchInputRef} className="input chat-conversation-search-input" value={conversationSearchQuery} onChange={(event) => { setConversationSearchQuery(event.target.value); setConversationSearchIndex(0); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeConversationSearch(); } else if (event.key === "Enter") { event.preventDefault(); navigateConversationSearch(event.shiftKey ? -1 : 1); } }} placeholder={t("chat.conversationSearchPlaceholder", "Find in conversation") } aria-label={t("chat.conversationSearchLabel", "Find in conversation")} data-testid="chat-conversation-search-input" />
      <span className="chat-conversation-search-status" role="status" aria-live="polite">{status}</span>
      <button type="button" className="btn-icon" aria-label={t("chat.conversationSearchPrevious", "Previous match")} disabled={count === 0} onClick={() => navigateConversationSearch(-1)}><ChevronUp size={14} /></button>
      <button type="button" className="btn-icon" aria-label={t("chat.conversationSearchNext", "Next match")} disabled={count === 0} onClick={() => navigateConversationSearch(1)}><ChevronDown size={14} /></button>
      <button type="button" className="btn-icon" aria-label={t("chat.conversationSearchClose", "Close search")} onClick={closeConversationSearch}><X size={14} /></button>
    </div>;
  };

  useEffect(() => {
    const previousDetailOpen = previousDetailOpenRef.current;
    previousDetailOpenRef.current = hasDetailSelection;
    if (previousDetailOpen || !hasDetailSelection) {
      if (previousDetailOpen && hasDetailSelection && suppressAutomaticDetailNavRef.current) {
        suppressAutomaticDetailNavRef.current = false;
      }
      return;
    }
    if (suppressAutomaticDetailNavRef.current) {
      suppressAutomaticDetailNavRef.current = false;
      return;
    }
    if (dockedSidebarVisible) return;
    pushNav({ type: "view", revert: handleBack });
  }, [dockedSidebarVisible, handleBack, hasDetailSelection, pushNav]);


  /*
  FNXC:ChatNavigation 2026-08-20-05:25:
  FN-068 makes the saved conversation title the direct-thread identity for every host. Model metadata remains secondary, and titleless legacy sessions use a stable label rather than promoting a model name into the title slot.
  */
  const threadHeaderTitle = activeSession?.title?.trim() || t("chat.untitledConversation", "Untitled conversation");

  const showThreadHeaderModelTag = Boolean(activeModelTag);
  const showThreadHeaderContextWindow = !isChatMobile && hasThreadInView && chatContextUsage !== null;
  const threadHeaderContextTotal = chatContextUsage ? formatTokenCount(chatContextUsage.total, { approximate: false }) : null;
  const threadHeaderContextUsed = chatContextUsage?.used === null || chatContextUsage?.used === undefined
    ? null
    : formatTokenCount(chatContextUsage.used, { approximate: chatContextUsage.approximate });
  const threadHeaderContextValue = chatContextUsage?.source === "pending" && threadHeaderContextTotal
    ? t("chat.contextWindowPendingValue", "— / {{total}}", { total: threadHeaderContextTotal })
    : threadHeaderContextUsed && threadHeaderContextTotal
      ? `${threadHeaderContextUsed} / ${threadHeaderContextTotal}`
      : null;
  const threadHeaderContextLabel = chatContextUsage && threadHeaderContextTotal
    ? chatContextUsage.source === "measured"
      ? t("chat.contextWindowMeasuredAria", "Session context {{used}} of {{total}} tokens ({{percent}}%), provider-reported input and output", {
        used: threadHeaderContextUsed,
        total: threadHeaderContextTotal,
        percent: Number((chatContextUsage.percent ?? 0).toFixed(1)),
      })
      : chatContextUsage.source === "pending"
        ? t("chat.contextWindowPendingAria", "Session context unknown until the next reply — {{total}} token window", { total: threadHeaderContextTotal })
        : t("chat.contextWindowAria", "Estimated {{used}} of {{total}} context tokens", {
          used: threadHeaderContextUsed,
          total: threadHeaderContextTotal,
        })
    : null;

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

  /*
  FNXC:ChatMentionDispatch 2026-08-23-02:52:
  Per-message mention dispatch persists its author in metadata. Resolve that identity for completed
  replies so model-only sessions do not hide summoned agents and multi-agent turns retain attribution.
  */
  const resolveMessageAssistantIdentity = useCallback((message: ChatMessageInfo) => {
    const senderId = typeof message.metadata?.senderAgentId === "string" ? message.metadata.senderAgentId : null;
    if (!senderId) return { agentName, hideAssistantIdentity };
    return {
      agentName: agentsMap.get(senderId)?.name
        ?? (typeof message.metadata?.senderAgentName === "string" ? message.metadata.senderAgentName : senderId.slice(0, 30)),
      hideAssistantIdentity: false,
    };
  }, [agentName, agentsMap, hideAssistantIdentity]);

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

  const handleQuoteMessage = useCallback((message: ChatMessageInfo) => {
    const senderId = typeof message.metadata?.senderAgentId === "string" ? message.metadata.senderAgentId : undefined;
    const sessionAgent = activeSession?.agentId && activeSession.agentId !== FN_AGENT_ID ? agentsMap.get(activeSession.agentId) : undefined;
    const agentName = senderId
      ? (agentsMap.get(senderId)?.name ?? (typeof message.metadata?.senderAgentName === "string" ? message.metadata.senderAgentName : undefined))
      : message.role === "assistant" ? sessionAgent?.name : undefined;
    setMessageInput((draft) => buildChatQuotePrefill({ quotedText: message.content, agentName, existingDraft: draft }));
    requestAnimationFrame(() => { inputRef.current?.focus(); resizeComposer(); });
  }, [activeSession?.agentId, agentsMap, resizeComposer]);

  const showProviderResponseCopy = activeSession?.agentId === FN_AGENT_ID;

  const renderMessageActions = useCallback((messageId: string, content: string, role: "assistant" | "user" | "system", testId?: string, allowReport = true) => {
    const canCopy = showProviderResponseCopy && role === "assistant";
    const report = allowReport && role === "assistant" && onSendAsReport ? buildChatReportHandoff(content, t("chat.reportFallbackTitle", "Chat report")) : null;
    if (!canCopy && !report?.handoff) return undefined;
    return <>
      {canCopy && <button type="button" className={`btn-icon chat-message-copy-action${copyFeedbackByMessageId[messageId] === "success" ? " chat-message-copy-action--success" : ""}${copyFeedbackByMessageId[messageId] === "error" ? " chat-message-copy-action--error" : ""}`} data-testid={testId ?? `chat-copy-response-${messageId}`} aria-label={copyFeedbackByMessageId[messageId] === "success" ? t("chat.responseCopied", "Response copied") : copyFeedbackByMessageId[messageId] === "error" ? t("chat.copyFailed", "Copy failed") : t("chat.copyResponse", "Copy response")} onClick={() => { void handleCopyResponse(messageId, content); }}>
        {copyFeedbackByMessageId[messageId] === "success" ? <Check size={14} /> : <Copy size={14} />}
      </button>}
      {report?.handoff && <button type="button" className="btn-icon" data-testid={`chat-send-as-report-${messageId}`} aria-label={t("chat.sendAsReport", "Send as report")} onClick={() => { if (report.truncated) addToast(t("chat.reportTrimmed", "Message trimmed to 2000 characters for mail"), "warning"); onSendAsReport?.(report.handoff!); }}><FileText size={14} /></button>}
    </>;
  }, [addToast, copyFeedbackByMessageId, handleCopyResponse, onSendAsReport, showProviderResponseCopy, t]);

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

  /*
   * FNXC:ChatMessageEdit 2026-08-24-03:34:
   * Editing is supported only for direct model-loop sessions: never CLI-agent-backed sessions
   * (a live PTY owns the transcript), and never while a generation is streaming.
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
              agentName={resolveMessageAssistantIdentity(message).agentName}
              hideAssistantIdentity={resolveMessageAssistantIdentity(message).hideAssistantIdentity}
              showAssistantModelTag={showAssistantModelTag}
              activeModelTag={activeModelTag}
              activeModelProvider={activeModelProvider}
              activeSessionId={activeSession?.id ?? null}
              projectId={projectId}
              mentionAgentsByName={mentionAgentsByName}
              roomContext={null}
              copyAction={renderMessageActions(message.id, message.content, message.role)}
              onQuoteMessage={handleQuoteMessage}
              onScrollToTop={handleScrollMessageToTop}
              isTopClipped={topClippedMessageIds.has(message.id)}
              isAwaitingQuestionAnswer={message.role === "assistant" && index === messages.length - 1 && !isStreaming}
              submittedQuestionAnswer={findSubmittedQuestionAnswer(messages, index)}
              onQuestionSubmit={handleQuestionSubmit}
              canEdit={canEditChatMessages}
              onEditMessage={editMessageAndResend}
              isSearchMatch={conversationSearchMatches.includes(message.id)}
              isSearchActive={activeConversationMatchId === message.id}
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
            /* FNXC:StructuralMail 2026-08-09-09:09: A streaming answer is unfinished and must never be routed as a report. */
            copyAction={showProviderResponseCopy && streamingText ? renderMessageActions("__streaming__", streamingText, "assistant", "chat-copy-response-streaming", false) : undefined}
            onQuestionSubmit={handleQuestionSubmit}
            isSearchMatch={conversationSearchMatches.includes("__streaming__")}
            isSearchActive={activeConversationMatchId === "__streaming__"}
          />
        </>
      ) : messagesLoading && messages.length === 0 ? (
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
              agentName={resolveMessageAssistantIdentity(message).agentName}
              hideAssistantIdentity={resolveMessageAssistantIdentity(message).hideAssistantIdentity}
              showAssistantModelTag={showAssistantModelTag}
              activeModelTag={activeModelTag}
              activeModelProvider={activeModelProvider}
              activeSessionId={activeSession?.id ?? null}
              projectId={projectId}
              mentionAgentsByName={mentionAgentsByName}
              roomContext={null}
              copyAction={renderMessageActions(message.id, message.content, message.role)}
              onQuoteMessage={handleQuoteMessage}
              onScrollToTop={handleScrollMessageToTop}
              isTopClipped={topClippedMessageIds.has(message.id)}
              isAwaitingQuestionAnswer={message.role === "assistant" && index === messages.length - 1 && !isStreaming}
              submittedQuestionAnswer={findSubmittedQuestionAnswer(messages, index)}
              onQuestionSubmit={handleQuestionSubmit}
              canEdit={canEditChatMessages}
              onEditMessage={editMessageAndResend}
              isSearchMatch={conversationSearchMatches.includes(message.id)}
              isSearchActive={activeConversationMatchId === message.id}
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
        accept={CHAT_ATTACHMENT_ACCEPT}
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
      <PendingChatMessageQueue
        messages={pendingMessages}
        disabled={pendingQueueAction}
        onEdit={updatePendingMessage ?? (() => undefined)}
        onMove={movePendingMessage ?? (() => undefined)}
        onDelete={clearPendingMessage}
        onForceSend={forceSendPendingMessage ?? (() => undefined)}
        testIdPrefix="chat-pending"
      />
      <div className="chat-input-row">
        <button
          type="button"
          className="btn-icon chat-attach-btn"
          data-testid="chat-attach-btn"
          aria-label={t("chat.attachFiles", "Attach files")}
          onClick={() => fileInputRef.current?.click()}
          disabled={pendingQueueAction}
        >
          <Paperclip size={16} />
        </button>
        {/*
        FNXC:ChatMemoryFocus 2026-08-24-04:21:
        Per-conversation memory focus is opt-in. Hide its direct-session chip until Settings
        enables experimentalFeatures.chatFocus; persisted values remain inert while hidden.
        */}
        {chatFocusEnabled && (
          <ChatFocusSelector
            sessionId={activeSession?.id ?? null}
            projectId={projectId}
            memoryFocus={resolvedChatFocus}
            onPersist={(focus) => setChatFocusOverride(focus)}
            addToast={addToast}
          />
        )}
        {/*
        FNXC:Chat-ThinkingLevel 2026-08-24-03:34:
        Direct sessions retain model/agent targeting here. CLI-backed sessions broker to a live PTY and never receive
        defaultThinkingLevel (FN-7775), so this direct-chat control stays gated by cliChatActive.
        */}
        {!cliChatActive && (
          <ChatThinkingLevelControl
            level={activeSession?.thinkingLevel}
            defaultThinkingLevel={resolvedDefaultThinkingLevel}
            models={models}
            favoriteProviders={favoriteProviders}
            favoriteModels={favoriteModels}
            agents={Array.from(agentsMap.values())}
            agentId={activeSession?.agentId}
            modelProvider={activeSession?.modelProvider}
            modelId={activeSession?.modelId}
            targetKey={activeSession?.id ?? null}
            onChange={(level) => {
              if (activeSession) {
                void setSessionThinkingLevel(activeSession.id, level);
              }
            }}
            onChangeModel={(selection) => {
              if (activeSession) {
                void setSessionModel(activeSession.id, selection);
              }
            }}
            disabled={!activeSession || pendingQueueAction}
          />
        )}
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
            disabled={pendingQueueAction}
            data-testid="chat-input"
          />
          <AgentMentionPopup
            agents={mentionAgents}
            filter={mentionFilter}
            highlightedIndex={mentionHighlightIndex}
            visible={mentionPopupVisible}
            onSelect={handleMentionSelect}
            position={AGENT_MENTION_POPUP_POSITION}
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
        <MicButton {...composerDictation.micProps} disabled={pendingQueueAction} />
        {/*
        FNXC:ChatPendingQueue 2026-08-19-06:25:
        Force-send cancellation must own the Direct composer until server reconciliation completes; otherwise a new send is queued while the selected entry is being dispatched and loses its priority.
        */}
        <StandardChatActionButton
          isStreaming={isStreaming}
          canSend={!pendingQueueAction && Boolean(messageInput.trim() || pendingAttachments.length > 0)}
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
  /*
  FNXC:ChatDirectOnly 2026-08-24-03:34:
  The session list is direct-chat only; the canonical ViewHeader carries New Chat and docked-list actions without a stale Rooms scope control.
  */
  const visibleSidebarSessions = showArchivedSessions ? archivedSessions : filteredSessions;
  const pinnedFilteredSessions = visibleSidebarSessions.filter((session) => session.pinnedAt != null);
  const unpinnedFilteredSessions = visibleSidebarSessions.filter((session) => session.pinnedAt == null);
  const contextMenuSession = contextMenu
    ? filteredSessions.find((session) => session.id === contextMenu.sessionId) ?? (activeSession?.id === contextMenu.sessionId ? activeSession : undefined)
    : undefined;

  /**
   * FNXC:ChatTags 2026-07-24-23:19:
   * A tag created from a session context menu must be assigned to that open session immediately,
   * preserving its existing tags so the user never has to select the newly created tag twice.
   */
  const handleCreateTagForSession = useCallback(async () => {
    const name = newTagName.trim();
    if (!name) return;

    let tag;
    try {
      tag = await createTag(name);
    } catch {
      addToast(t("chat.failedToCreateTag", "Failed to create tag"), "error");
      return;
    }

    if (contextMenu?.sessionId) {
      const tagIds = (contextMenuSession?.tags ?? []).map((candidate) => candidate.id);
      if (!tagIds.includes(tag.id)) {
        try {
          await setSessionTags(contextMenu.sessionId, [...tagIds, tag.id]);
        } catch {
          addToast(t("chat.failedToUpdateTags", "Failed to update tags"), "error");
          return;
        }
      }
    }

    setNewTagName("");
  }, [addToast, contextMenu, contextMenuSession, createTag, newTagName, setSessionTags, t]);


  return (
    /*
    FNXC:ChatNavigation 2026-08-20-05:25:
    FN-068 reserves the shared ViewHeader for view-level actions. A selected conversation owns its sole textual Back action in the thread row, preserving one list/detail state machine across desktop, floating, compact, and mobile hosts.

    FNXC:ChatNavigation 2026-08-20-23:57:
    FN-096 keeps the canonical New Chat action in this shared header for both list and selected-detail states. Embedded, floating, and dock hosts must reuse this one creation entry point while the thread row retains the sole Back action.
    */
    <div ref={chatViewRef} className={`chat-view${floating ? " chat-view--floating" : ""}${isChatMobile ? " chat-view--narrow" : ""}${hasDetailSelection ? " chat-view--detail" : ""}${dockedSidebarVisible ? " chat-view--docked-list" : ""}${chatMessageLayout === "full-width" ? " chat-view--full-width" : ""}`}>
      <ViewHeader
        icon={MessageSquare}
        title={t("chat.title", "Chat")}
        actions={
          <>
            {dockedSidebarEligible ? (
              <button type="button" className="btn-icon chat-view-header-icon" data-testid="chat-docked-sidebar-toggle"
                aria-pressed={dockedSidebarOpen}
                aria-label={dockedSidebarOpen ? t("chat.hideConversationList", "Hide conversation list") : t("chat.showConversationList", "Show conversation list")}
                title={dockedSidebarOpen ? t("chat.hideConversationList", "Hide conversation list") : t("chat.showConversationList", "Show conversation list")}
                onClick={() => { const next = !dockedSidebarOpen; setDockedSidebarOpen(next); persistChatDockedSidebarPreference(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY, String(next), persistChatPreferences); }}>
                {dockedSidebarOpen ? <PanelLeftClose /> : <PanelLeft />}
              </button>
            ) : null}

            <button
              className="btn btn-sm btn-primary chat-view-header-new-chat"
              onClick={handleNewChat}
              data-testid="chat-new-btn"
              title={onOpenSessionInNewWindow ? t("chat.newChatOpenInNewWindowHint", "Ctrl/Cmd + click to open the new conversation in a separate window") : undefined}
            >
              <Plus size={14} />
              {t("chat.newChat", "New Chat")}
            </button>
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
        className={`chat-sidebar${hasDetailSelection && !dockedSidebarVisible ? " chat-sidebar--hidden" : ""}${dockedSidebarVisible ? " chat-sidebar--docked" : ""}`}
        style={dockedSidebarVisible ? { width: dockedSidebarWidth, minWidth: dockedSidebarWidth } : undefined}
      >
        <>
            {/* Search section */}
            {/*
            FNXC:ChatSearch 2026-07-07-12:00:
            Search always matches message content (server round trip) in addition to
            title/agentId; there is no client toggle to restrict it back to title-only (FN-7651
            removed the "Search in title only" button per user request). Rendered on both desktop
            and mobile because the direct-chat sidebar markup is shared across breakpoints.
            */}
            <div className="chat-sidebar-search-container">
              <div className="chat-sidebar-search-wrapper">
                <Search size={14} className="chat-sidebar-search-icon" />
                <input
                  ref={listSearchInputRef}
                  type="text"
                  className="chat-sidebar-search"
                  placeholder={t("chat.searchConversations", "Search conversations...")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="chat-search-input"
                />
              </div>
              {/*
              FNXC:ChatArchived 2026-08-23-16:27:
              The archived affordance is a compact Archived toggle sharing the tag-filter line, so the sidebar does not spend a full row on it. aria-pressed and active styling convey state instead of changing the visible label.
              */}
              <div className="chat-sidebar-filter-row">
                <label className="chat-tag-filter" htmlFor="chat-tag-filter">
                  <Tag size={14} aria-hidden="true" />
                  <select
                    id="chat-tag-filter"
                    value={selectedTagId ?? ""}
                    onChange={(event) => setSelectedTagId(event.target.value || null)}
                    data-testid="chat-tag-filter"
                    aria-label={t("chat.filterByTag", "Filter conversations by tag")}
                  >
                    <option value="">{t("chat.allTags", "All tags")}</option>
                    {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                  </select>
                  {selectedTagId ? <button type="button" className="btn-icon" aria-label={t("chat.clearTagFilter", "Clear tag filter")} onClick={() => setSelectedTagId(null)}><X size={14} /></button> : null}
                </label>
                <button
                  type="button"
                  className={`btn btn-sm chat-archived-toggle${showArchivedSessions ? " chat-archived-toggle--active" : ""}`}
                  data-testid="chat-archived-toggle"
                  aria-pressed={showArchivedSessions}
                  title={t("chat.showArchivedConversations", "Show archived conversations")}
                  aria-label={t("chat.showArchivedConversations", "Show archived conversations")}
                  onClick={() => { const next = !showArchivedSessions; setShowArchivedSessions(next); if (next) void refreshArchivedSessions(); }}
                >
                  {t("chat.archived", "Archived")}
                </button>
              </div>
            </div>
            {/* Session list section */}
            <div className="chat-session-list chat-sidebar-list">
              {sessionsLoading ? (
                <div className="chat-empty-state chat-empty-state--padded">{t("chat.loadingConversations", "Loading...")}</div>
              ) : ((showArchivedSessions ? archivedSessions : filteredSessions).length === 0) ? (
                <div className="chat-empty-state chat-empty-state--padded">{t("chat.noConversationsYet", "No conversations yet")}</div>
              ) : (
                <>
                  {/*
                  FNXC:ChatPinned 2026-07-19-00:00:
                  Direct conversation pins must be two explicit sections on every session-list surface.
                  Do not flatten Recent rows beneath Pinned: labels and wrappers make the pin boundary
                  clear for desktop, mobile, full Chat, and Quick Chat (all share this component).
                  */}
                  {[
                    { id: "pinned", label: t("chat.pinned", "Pinned"), testId: "chat-pinned-divider", sessions: pinnedFilteredSessions },
                    { id: "recent", label: t("chat.recent", "Recent"), testId: "chat-recent-divider", sessions: unpinnedFilteredSessions },
                  ].filter((group) => group.sessions.length > 0).map((group) => (
                    <section className="chat-session-section" data-testid={`chat-session-section-${group.id}`} key={group.id}>
                      <div className="chat-pinned-divider" data-testid={group.testId}>{group.label}</div>
                      {group.sessions.map((session) => {
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
                        openSessionMenu(session.id, e.clientX, e.clientY);
                      }}
                      data-testid={showArchivedSessions ? `chat-archived-session-${session.id}` : `chat-session-${session.id}`}
                    >
                      {/*
                      FNXC:ChatSidebar 2026-07-16-00:00:
                      FN-8173 consolidates Pin, Rename, and Delete into this single three-dot trigger so long conversation titles retain usable row width. It opens the existing context-menu state so click and right-click share the same labeled action list and handlers.
                      */}
                      <button
                        type="button"
                        className="btn-icon chat-session-menu-btn"
                        data-testid="chat-session-menu-btn"
                        aria-label={t("chat.conversationActionsAria", "Conversation actions for {{title}}", { title: sessionTitle })}
                        aria-haspopup="menu"
                        aria-expanded={contextMenu?.sessionId === session.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (contextMenu?.sessionId === session.id) {
                            setContextMenu(null);
                            return;
                          }
                          const bounds = e.currentTarget.getBoundingClientRect();
                          openSessionMenu(session.id, bounds.right, bounds.bottom, { anchorRight: true });
                        }}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      <div className="chat-session-title">
                        {sessionTitle}
                        {session.pinnedAt ? <Pin className="chat-session-pinned-indicator" size={14} data-testid={`chat-session-pinned-indicator-${session.id}`} aria-label={t("chat.pinned", "Pinned")} /> : null}
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
                      {(session.tags ?? []).length > 0 ? <div className="chat-session-tags" data-testid={`chat-session-tags-${session.id}`}>{(session.tags ?? []).map((tag) => <span className="chat-session-tag" key={tag.id}>{tag.name}</span>)}</div> : null}
                      {session.matchedMessagePreview ? (
                        <div className="chat-session-preview chat-session-preview--matched" data-testid={`chat-session-matched-preview-${session.id}`}>
                          {t("chat.matchedInMessage", "Matched: \"{{preview}}\"", { preview: session.matchedMessagePreview })}
                        </div>
                      ) : null}
                      {showArchivedSessions ? <button type="button" className="btn btn-sm btn-secondary" data-testid={`chat-archived-restore-${session.id}`} onClick={(event) => { event.stopPropagation(); void handleRestoreArchived(session.id); }}>{t("chat.restore", "Restore")}</button> : null}
                      <div className="chat-session-meta">
                        <span className="chat-session-meta-model">
                          {sessionResolvedModel?.provider ? <ProviderIcon provider={sessionResolvedModel.provider} size="sm" /> : null}
                          <span>{agentsMap.get(session.agentId)?.name || (session.agentId === FN_AGENT_ID ? "Fusion" : session.agentId.slice(0, 30))}</span>
                          <span data-testid={`chat-session-model-tag-${session.id}`}>{sessionModelTag || "Fusion"}</span>
                        </span>
                        <span>{session.updatedAt ? formatRelativeTime(session.updatedAt, t) : ""}</span>
                      </div>
                    </div>
                  );
                      })}
                    </section>
                  ))}
                </>
              )}
            </div>
        </>
        {dockedSidebarVisible ? <div className="chat-sidebar__resize-handle" role="separator" aria-orientation="vertical" tabIndex={0}
          aria-valuenow={dockedSidebarWidth} aria-valuemin={CHAT_DOCKED_SIDEBAR_MIN_WIDTH} aria-valuemax={CHAT_DOCKED_SIDEBAR_MAX_WIDTH}
          aria-label={t("chat.resizeSidebar", "Resize chat sidebar")} data-testid="chat-sidebar-resize-handle"
          onPointerDown={handleDockedResizeStart} onKeyDown={handleDockedResizeKeyDown} /> : null}

      </div>



      {/* Context Menu */}
      {contextMenu && (
        <div
          className="chat-session-context-menu"
          ref={contextMenuRef}
          role="menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {onOpenSessionInNewWindow && !showArchivedSessions && contextMenuSession ? (
            <button
              type="button"
              role="menuitem"
              data-testid="chat-context-open-window"
              onClick={() => {
                onOpenSessionInNewWindow(contextMenuSession);
                setContextMenu(null);
              }}
            >
              <ExternalLink size={14} />
              {t("chat.openInNewWindow", "Open in new window")}
            </button>
          ) : null}
          <button
            onClick={() => handlePin(
              contextMenu.sessionId,
              !contextMenuSession?.pinnedAt,
            )}
            data-testid="chat-context-pin"
            title={pinnedCount >= 3 && !contextMenuSession?.pinnedAt ? t("chat.pinLimit", "You can pin up to 3 conversations") : undefined}
            disabled={pinnedCount >= 3 && !contextMenuSession?.pinnedAt}
          >
            {contextMenuSession?.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
            {contextMenuSession?.pinnedAt ? t("chat.unpin", "Unpin") : t("chat.pin", "Pin")}
          </button>
          <button
            onClick={() => openRenameDialog(contextMenu.sessionId)}
            data-testid="chat-context-rename"
          >
            <Pencil size={14} />
            {t("chat.rename", "Rename")}
          </button>
          <div className="chat-session-tag-menu" role="group" aria-label={t("chat.conversationTags", "Conversation tags")}>
            {tags.map((tag) => {
              const assigned = (contextMenuSession?.tags ?? []).some((candidate) => candidate.id === tag.id);
              return <div className="chat-tag-menu-item" key={tag.id}>
                <button type="button" role="menuitemcheckbox" aria-checked={assigned} data-testid={`chat-context-tag-${tag.id}`} onClick={() => void setSessionTags(contextMenu.sessionId, assigned ? (contextMenuSession?.tags ?? []).filter((candidate) => candidate.id !== tag.id).map((candidate) => candidate.id) : [...(contextMenuSession?.tags ?? []).map((candidate) => candidate.id), tag.id]).catch(() => addToast(t("chat.failedToUpdateTags", "Failed to update tags"), "error"))}>{assigned ? "✓ " : ""}{tag.name}</button>
                <button type="button" className="btn-icon" aria-label={t("chat.renameTag", "Rename tag {{name}}", { name: tag.name })} data-testid={`chat-context-rename-tag-${tag.id}`} onClick={(event) => { event.stopPropagation(); setRenameTagName(tag.name); setRenameTagDialog(tag); }}><Pencil size={14} /></button>
                <button type="button" className="btn-icon" aria-label={t("chat.deleteTag", "Delete tag {{name}}", { name: tag.name })} data-testid={`chat-context-delete-tag-${tag.id}`} onClick={(event) => { event.stopPropagation(); setConfirmDeleteTag(tag); }}><Trash2 size={14} /></button>
              </div>;
            })}
            <div className="chat-tag-create-row">
              <input className="input" value={newTagName} placeholder={t("chat.newTag", "New tag")} aria-label={t("chat.newTag", "New tag")} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void handleCreateTagForSession(); } }} />
              <button type="button" className="btn btn-sm" onClick={() => void handleCreateTagForSession()}>{t("chat.addTag", "Add")}</button>
            </div>
          </div>
          <button
            onClick={() => handleArchive(contextMenu.sessionId)}
            data-testid="chat-context-archive"
          >
            <Archive size={14} />
            {t("chat.archive", "Archive")}
          </button>
          {chatSettings?.memoryBackendType === "stash" && chatSettings.memoryEnabled !== false ? (
            <button
              onClick={() => void handleBackfillStash(contextMenu.sessionId)}
              data-testid="chat-context-stash-backfill"
              disabled={stashBackfillBusyId !== null}
              title={stashBackfillBusyId ? t("chat.preserveToStashWorking", "Uploading to Stash…") : undefined}
            >
              <Bookmark size={14} />
              {stashBackfillBusyId === contextMenu.sessionId
                ? t("chat.preserveToStashWorking", "Uploading to Stash…")
                : t("chat.preserveToStash", "Preserve to Stash")}
            </button>
          ) : null}
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
        <ChatDialogBackdrop onClose={() => setRenameDialog(null)}>
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
        </ChatDialogBackdrop>
      )}

      {renameTagDialog && (
        <ChatDialogBackdrop onClose={() => setRenameTagDialog(null)}>
          <div className="chat-new-dialog chat-view-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-rename-tag-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="chat-rename-tag-dialog-title">{t("chat.renameTagTitle", "Rename tag")}</h3>
            <label className="chat-rename-label" htmlFor="chat-rename-tag-input">{t("chat.tagName", "Tag name")}</label>
            <input id="chat-rename-tag-input" className="input chat-rename-input" value={renameTagName} data-testid="chat-rename-tag-input" onChange={(event) => setRenameTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void renameTag(renameTagDialog.id, renameTagName).then(() => setRenameTagDialog(null)).catch(() => addToast(t("chat.failedToRenameTag", "Failed to rename tag"), "error")); } }} autoFocus />
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setRenameTagDialog(null)}>{t("chat.cancel", "Cancel")}</button>
              <button className="btn btn-sm btn-primary" data-testid="chat-rename-tag-save" onClick={() => void renameTag(renameTagDialog.id, renameTagName).then(() => setRenameTagDialog(null)).catch(() => addToast(t("chat.failedToRenameTag", "Failed to rename tag"), "error"))}>{t("chat.save", "Save")}</button>
            </div>
          </div>
        </ChatDialogBackdrop>
      )}

      {confirmDeleteTag && (
        <ChatDialogBackdrop onClose={() => setConfirmDeleteTag(null)}>
          <div className="chat-new-dialog chat-view-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-delete-tag-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="chat-delete-tag-dialog-title">{t("chat.deleteTagTitle", "Delete tag?")}</h3>
            <p className="chat-view-delete-dialog-copy">{t("chat.deleteTagBody", "This removes the tag from all conversations, but does not delete conversations.")}</p>
            <div className="chat-new-dialog-actions">
              <button className="btn btn-sm" onClick={() => setConfirmDeleteTag(null)}>{t("chat.cancel", "Cancel")}</button>
              <button className="btn btn-sm btn-danger" data-testid="chat-delete-tag-confirm" onClick={() => void deleteTag(confirmDeleteTag.id).then(() => setConfirmDeleteTag(null)).catch(() => addToast(t("chat.failedToDeleteTag", "Failed to delete tag"), "error"))}>{t("chat.delete", "Delete")}</button>
            </div>
          </div>
        </ChatDialogBackdrop>
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && (
        <ChatDialogBackdrop onClose={() => setConfirmDelete(null)}>
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
        </ChatDialogBackdrop>
      )}

      {/* Thread */}
      {hasDetailSelection ? (

      <div ref={chatThreadRef} className="chat-thread">
        {/* FNXC:ChatRenderToggle 2026-07-04-00:00: The markdown/plain eye toggle
            button (desktop `.chat-thread-header-render-toggle` and the mobile
            floating `--floating` variant) was removed per FN-7541. Chat now
            always renders Markdown (forcePlain is hardcoded to false). */}
        {hasThreadInView && (
          <div className="chat-thread-header">
            {!dockedSidebarVisible ? <button
              type="button"
              className="btn btn-sm chat-thread-header-back chat-back-btn"
              onClick={handleVisibleDetailBack}
              data-testid="chat-back-btn"
              aria-label={t("chat.backToConversations", "Back to conversations")}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>{t("chat.back", "Back")}</span>
            </button> : null}
            <div className="chat-thread-header-identity" data-testid="chat-thread-header-identity">
              {activeModelProvider ? <ProviderIcon provider={activeModelProvider} size="md" /> : <Bot size={16} />}
              {/*
              FNXC:ChatTitleSwitcher 2026-08-23-03:13:
              FN-9192 makes the Direct title the in-place conversation switcher because the detail
              view hides the sidebar on every host. Selection must use handleSessionClick so unread
              state, selectSession, and detail-open behavior remain owned by the existing path.
              */}
              <ChatThreadTitleSwitcher
                title={threadHeaderTitle}
                sessions={sessions}
                activeSessionId={activeSession?.id ?? null}
                onSelect={handleSessionClick}
                onViewAll={handleBack}
                isUnread={(session) => isUnread("direct", session.id, session.lastMessageAt ?? session.updatedAt)}
              />
              {showThreadHeaderModelTag && <span className="chat-model-tag">{activeModelTag}</span>}
              {showThreadHeaderContextWindow && threadHeaderContextValue && threadHeaderContextLabel && chatContextUsage ? (
                <span
                  className="chat-thread-header-context"
                  data-testid="chat-thread-context-window"
                  data-context-source={chatContextUsage.source}
                  title={threadHeaderContextLabel}
                  aria-label={threadHeaderContextLabel}
                >
                  {threadHeaderContextValue}
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
            renderSearch={renderConversationSearch}
          />
        ) : (
          <>
            {renderConversationSearch()}
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
      ) : null}

      </div>

    </div>
  );
}
