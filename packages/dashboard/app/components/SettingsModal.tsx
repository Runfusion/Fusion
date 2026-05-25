import { useState, useEffect, useCallback, useRef, lazy, Suspense, type CSSProperties, type MouseEvent } from "react";
import { Globe, Folder, RefreshCw, Star, HelpCircle, Loader2, CheckCircle, AlertTriangle } from "lucide-react";
import {
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  THINKING_LEVELS,
  getErrorMessage,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  resolvePlanningSettingsModel,
  resolvePersistAgentThinkingLog,
  resolveProjectDefaultModel,
  resolveTitleSummarizerSettingsModel,
  normalizeMergeIntegrationWorktreeMode,
  normalizeMergeAdvanceAutoSyncMode,
} from "@fusion/core";
import type { AgentPermissionPolicyRules, Settings, GlobalSettings, ThemeMode, ColorTheme, ModelPreset, NtfyNotificationEvent, AgentPromptsConfig, ThinkingLevel } from "@fusion/core";
import { fetchSettings, fetchSettingsByScope, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, cancelProviderLogin, saveApiKey, clearApiKey, fetchModels, testNotification, fetchBackups, createBackup, exportSettings, importSettings, fetchMemoryFile, fetchMemoryFiles, saveMemoryFile, compactMemory, fetchGlobalConcurrency, updateGlobalConcurrency, installQmd, testMemoryRetrieval, triggerMemoryDreams, fetchGitRemotes, fetchGitRemotesDetailed, fetchGitBranches, fetchProjects, fetchDashboardHealth, checkForUpdates, fetchRemoteSettings, updateRemoteSettings, fetchRemoteStatus, installCloudflared, startRemoteTunnel, stopRemoteTunnel, killExternalTunnel, regenerateRemotePersistentToken, generateShortLivedRemoteToken, fetchRemoteQr, fetchRemoteUrl, submitProviderManualCode } from "../api";
import type { AuthProvider, ManualOAuthCodeInfo, ModelInfo, BackupListResponse, SettingsExportData, MemoryFileInfo, MemoryRetrievalTestResult, GitRemote, GitRemoteDetailed, ProjectInfo, RemoteSettings, RemoteStatus, UpdateCheckResponse, OAuthDeviceCodeInfo } from "../api";
import { useMemoryBackendStatus } from "../hooks/useMemoryBackendStatus";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import type { ToastType } from "../hooks/useToast";
import { ThemeSelector } from "./ThemeSelector";
import { useSessionBannersHidden, setSessionBannersHidden } from "../hooks/useSessionBannerPref";
import "./SettingsModal.css";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { FileEditor } from "./FileEditor";
import { FileBrowser } from "./FileBrowser";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
const PluginManager = lazy(() => import("./PluginManager").then((m) => ({ default: m.PluginManager })));
const PiExtensionsManager = lazy(() => import("./PiExtensionsManager").then((m) => ({ default: m.PiExtensionsManager })));
import { ClaudeCliProviderCard } from "./ClaudeCliProviderCard";
import { CursorCliProviderCard } from "./CursorCliProviderCard";
import { CliBinaryPanel } from "./CliBinaryPanel";
import { LlamaCppProviderCard } from "./LlamaCppProviderCard";
import { HermesRuntimeCard } from "./HermesRuntimeCard";
import { OpenClawRuntimeCard } from "./OpenClawRuntimeCard";
import { PaperclipRuntimeCard } from "./PaperclipRuntimeCard";
import { PluginSlot } from "./PluginSlot";
import { AgentPromptsManager } from "./AgentPromptsManager";
import { LoginInstructions } from "./LoginInstructions";
import { OAuthManualCodeForm } from "./OAuthManualCodeForm";
import { ProviderIcon } from "./ProviderIcon";
import { CustomProvidersSection } from "./CustomProvidersSection";
import { AgentPermissionPolicyEditor } from "./AgentPermissionPolicyEditor";
import { AgentProvisioningPolicyEditor } from "./AgentProvisioningPolicyEditor";
import { applyPresetToSelection, generateUniquePresetId } from "../utils/modelPresets";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import { appendTokenQuery } from "../auth";
import { useConfirm } from "../hooks/useConfirm";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useNodes } from "../hooks/useNodes";
import { useViewportMode } from "../hooks/useViewportMode";
import { useWorktrunkInstallStatus } from "../hooks/useWorktrunkInstallStatus";
import { NodeHealthDot } from "./NodeHealthDot";
import { TrackingRepoSelect, type TrackingRepoOption } from "./TrackingRepoSelect";
import { filterVisibleOnboardingAndSettingsProviders } from "./providerVisibility";

// ---------------------------------------------------------------------------
// GitHub star count — fetched once per session, cached in localStorage (1 h).
// ---------------------------------------------------------------------------
const GITHUB_STAR_CACHE_KEY = "fusion_github_star_count";
const GITHUB_STAR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_STAR_CLICKED_KEY = "fusion:github-star-clicked";

function toCompleteAgentPermissionRules(rules?: Partial<AgentPermissionPolicyRules>): AgentPermissionPolicyRules {
  return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.reduce((acc, category) => {
    acc[category] = rules?.[category] ?? "allow";
    return acc;
  }, {} as AgentPermissionPolicyRules);
}

function getNodeStatusLabel(status: "online" | "offline" | "connecting" | "error"): string {
  if (status === "online") return "Online";
  if (status === "connecting") return "Connecting";
  if (status === "error") return "Error";
  return "Offline";
}

function toTrackingRepoOptions(remotes: GitRemote[]): TrackingRepoOption[] {
  const byValue = new Map<string, TrackingRepoOption>();
  for (const remote of remotes) {
    const value = `${remote.owner}/${remote.repo}`;
    if (!byValue.has(value)) {
      byValue.set(value, { value, label: value });
    }
  }
  return [...byValue.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Has the user already clicked the "Star on GitHub" button at any point in
 * the past? Used to permanently hide the button afterward — clicking opens
 * the repo where the actual star happens, so we treat that click as intent
 * to star and stop nagging.
 */
function useStarClickedFlag(): [boolean, () => void] {
  const [clicked, setClicked] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GITHUB_STAR_CLICKED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const markClicked = useCallback(() => {
    setClicked(true);
    try {
      localStorage.setItem(GITHUB_STAR_CLICKED_KEY, "true");
    } catch {
      // quota / private mode — best-effort
    }
  }, []);
  return [clicked, markClicked];
}

interface StarCache {
  count: number;
  fetchedAt: number;
}

function useGitHubStarCount(): number | null {
  const [count, setCount] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(GITHUB_STAR_CACHE_KEY);
      if (raw) {
        const parsed: StarCache = JSON.parse(raw) as StarCache;
        if (Date.now() - parsed.fetchedAt < GITHUB_STAR_CACHE_TTL_MS) {
          return parsed.count;
        }
      }
    } catch {
      // ignore malformed cache
    }
    return null;
  });

  useEffect(() => {
    // If we already have a fresh count from the initial state, skip the fetch.
    try {
      const raw = localStorage.getItem(GITHUB_STAR_CACHE_KEY);
      if (raw) {
        const parsed: StarCache = JSON.parse(raw) as StarCache;
        if (Date.now() - parsed.fetchedAt < GITHUB_STAR_CACHE_TTL_MS) {
          return;
        }
      }
    } catch {
      // ignore
    }

    fetch("https://api.github.com/repos/Runfusion/Fusion")
      .then((res) => {
        if (!res.ok) return;
        return res.json() as Promise<{ stargazers_count?: number }>;
      })
      .then((data) => {
        if (data && typeof data.stargazers_count === "number") {
          const cache: StarCache = { count: data.stargazers_count, fetchedAt: Date.now() };
          try {
            localStorage.setItem(GITHUB_STAR_CACHE_KEY, JSON.stringify(cache));
          } catch {
            // quota exceeded — just skip
          }
          setCount(data.stargazers_count);
        }
      })
      .catch(() => {
        // Network failure — hide count gracefully, no update
      });
  }, []);

  return count;
}

/**
 * Settings sections configuration.
 *
 * Each section groups related settings fields under a sidebar nav item.
 * Sections have a `scope` to indicate where their settings are stored:
 *   - "global": User-level settings stored in ~/.fusion/settings.json (shared across projects)
 *   - "project": Project-specific settings stored in .fusion/config.json
 *   - undefined: Section operates independently of settings storage (e.g. authentication)
 *
 * Group headers (isGroupHeader: true) are non-clickable labels that visually group sections.
 * The sidebar is organized into three groups:
 *   - Account: Scope-less sections (authentication)
 *   - Global: Global-scoped sections (appearance, notifications, node-sync, global-models)
 *   - Project: Project-scoped sections (project-models, general, scheduling, node-routing,
 *     worktrees, commands, merge, memory, experimental, prompts, backups, plugins)
 *
 * To add a new section:
 *   1. Add an entry to SETTINGS_SECTIONS with a unique id, label, and scope
 *   2. Add a corresponding case in renderSectionFields()
 */
/** Section entry type with optional icon */
type SettingsSection = {
  id: string;
  label: string;
  scope: "global" | "project" | undefined;
  icon?: typeof Globe;
  isGroupHeader?: boolean;
};

const MOBILE_SETTINGS_MEDIA_QUERY = "(max-width: 768px)";
const DEFAULT_MEMORY_EDITOR_PATH = ".fusion/memory/DREAMS.md";
const MEMORY_FILE_OPTION_LABEL_MAX_CHARS = 72;

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const visibleChars = Math.max(1, maxChars - 1);
  const startChars = Math.ceil(visibleChars / 2);
  const endChars = Math.floor(visibleChars / 2);
  return `${value.slice(0, startChars)}…${value.slice(value.length - endChars)}`;
}

function formatMemoryFileOptionLabel(file: MemoryFileInfo): string {
  const fullLabel = `${file.label} — ${file.path}`;
  return truncateMiddle(fullLabel, MEMORY_FILE_OPTION_LABEL_MAX_CHARS);
}

function toCommaSeparatedInput(values?: string[]): string {
  return values?.join(", ") ?? "";
}

function fromCommaSeparatedInput(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  // Account group (scope-less items — independent of settings storage)
  { id: "__account_header", label: "Account", scope: undefined, isGroupHeader: true },
  { id: "authentication", label: "Authentication", scope: undefined, icon: Globe },

  // Global group (shared across all Fusion projects)
  { id: "__global_header", label: "Global", scope: undefined, isGroupHeader: true },
  { id: "global-general", label: "General", scope: "global" },
  { id: "appearance", label: "Appearance", scope: "global" },
  { id: "notifications", label: "Notifications", scope: "global" },
  { id: "node-sync", label: "Node Sync", scope: "global" },
  { id: "global-models", label: "Models", scope: "global" },
  { id: "research-global", label: "Research Defaults", scope: "global" },
  { id: "experimental", label: "Experimental Features", scope: "global" },
  { id: "remote", label: "Remote Access", scope: "global" },

  // Runtimes group (plugin runtimes with their own settings)
  { id: "__runtimes_header", label: "Runtimes", scope: undefined, isGroupHeader: true },
  { id: "hermes-runtime", label: "Hermes", scope: "global" },
  { id: "openclaw-runtime", label: "OpenClaw", scope: "global" },
  { id: "paperclip-runtime", label: "Paperclip", scope: "global" },

  // Project group (specific to this project)
  { id: "__project_header", label: "Project", scope: undefined, isGroupHeader: true },
  { id: "general", label: "Project General", scope: "project" },
  { id: "project-models", label: "Project Models", scope: "project" },
  { id: "scheduling", label: "Scheduling", scope: "project" },
  { id: "scheduled-evals", label: "Scheduled Evals", scope: "project" },
  { id: "node-routing", label: "Node Routing", scope: "project" },
  { id: "worktrees", label: "Worktrees", scope: "project" },
  { id: "commands", label: "Commands", scope: "project" },
  { id: "merge", label: "Merge", scope: "project" },
  { id: "agent-permissions", label: "Agent Permissions", scope: "project" },
  { id: "memory", label: "Memory", scope: "project" },
  { id: "research-project", label: "Research", scope: "project" },
  { id: "prompts", label: "Prompts", scope: "project" },
  { id: "backups", label: "Backups", scope: "project" },
  { id: "plugins", label: "Plugins", scope: "project" },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AUTO_ARCHIVE_DEFAULT_AFTER_DAYS = 2;
const DEFAULT_NTFY_EVENTS: NtfyNotificationEvent[] = [
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
  "gridlock",
  "fallback-used",
  "memory-dreams-processed",
  "message:agent-to-user",
  "message:agent-to-agent",
  "message:room",
  "oauth-token-expired",
];

const NOTIFICATION_EVENT_OPTIONS: Array<{ event: NtfyNotificationEvent; label: string; description: string }> = [
  { event: "in-review", label: "Task completed (in-review)", description: "When a task moves to In Review (ready for review)" },
  { event: "merged", label: "Task merged", description: "When a task is successfully merged to main" },
  { event: "failed", label: "Task failed", description: "When a task fails during execution (high priority)" },
  { event: "awaiting-approval", label: "Plan needs approval", description: "When a task specification needs manual approval before execution" },
  { event: "awaiting-user-review", label: "User review needed", description: "When an agent hands off a task for human review (high priority)" },
  { event: "planning-awaiting-input", label: "Planning needs input", description: "When planning mode is waiting for your response to continue" },
  { event: "gridlock", label: "Pipeline gridlocked", description: "When all schedulable todo tasks are blocked and work cannot advance" },
  { event: "fallback-used", label: "Fallback model used (recovered)", description: "When Fusion recovers from a retryable model failure by switching to a fallback model" },
  { event: "memory-dreams-processed", label: "DREAMS.md entry added", description: "When manual dream processing writes a new entry to project or agent DREAMS.md" },
  { event: "message:agent-to-user", label: "Agent → user message", description: "An agent sent you a direct message" },
  { event: "message:agent-to-agent", label: "Agent → agent message", description: "Agents are talking to each other (including replies)" },
  { event: "message:room", label: "Agent message in room", description: "An agent posted a reply in a chat room you're watching" },
  { event: "oauth-token-expired", label: "OAuth token expired", description: "Notify when a provider OAuth token (Codex, Claude, etc.) expires." },
];

/** Well-known experimental feature flags with display labels.
 *  These always appear in the Experimental Features settings tab,
 *  regardless of whether they exist in the project's settings blob.
 *  IMPORTANT: Dev Server is canonically keyed by `devServerView`; `devServer`
 *  is treated as a legacy alias and must never render as a second row. */
const KNOWN_EXPERIMENTAL_FEATURES: Record<string, string> = {
  insights: "Insights",
  roadmap: "Roadmaps",
  memoryView: "Memory Editor",
  remoteAccess: "Remote Access",
  skillsView: "Skills View",
  nodesView: "Nodes View",
  devServerView: "Dev Server",
  todoView: "Todo List",
  researchView: "Research View",
  evalsView: "Evals View",
  goalsView: "Goals View",
  sandbox: "Sandbox (command isolation)",
  chatRooms: "Chat Rooms",
  agentOnboarding: "Planning-style Agent Onboarding",
};

const EXPERIMENTAL_FEATURE_LEGACY_ALIASES: Record<string, string> = {
  devServer: "devServerView",
};

function getCanonicalExperimentalFeatureKey(key: string): string {
  return EXPERIMENTAL_FEATURE_LEGACY_ALIASES[key] ?? key;
}

function isExperimentalFeatureEnabled(features: Record<string, boolean>, key: string): boolean {
  if (features[key] === true) {
    return true;
  }

  return Object.entries(EXPERIMENTAL_FEATURE_LEGACY_ALIASES).some(
    ([legacyKey, canonicalKey]) => canonicalKey === key && features[legacyKey] === true,
  );
}

function normalizeExperimentalFeaturesForSave(features?: Record<string, boolean>): Record<string, boolean | null> {
  if (!features) {
    return {};
  }

  const normalized: Record<string, boolean | null> = {};
  for (const [key, enabled] of Object.entries(features)) {
    normalized[getCanonicalExperimentalFeatureKey(key)] = enabled;
  }

  for (const [legacyKey, canonicalKey] of Object.entries(EXPERIMENTAL_FEATURE_LEGACY_ALIASES)) {
    if (normalized[canonicalKey] !== undefined && !(legacyKey in normalized)) {
      normalized[legacyKey] = null;
    }
  }

  return normalized;
}

type LegacySectionId = "pi-extensions";
export type SectionId = SettingsSection["id"] | LegacySectionId;

const DEFAULT_SETTINGS_SECTION: SectionId = "global-general";

type PluginsSubsectionId = "fusion-plugins" | "pi-extensions";

/** Local form state extends Settings with a worktreeInitCommand override and lets tokenCap carry null (delete semantic). */
type SettingsFormState = Settings & { worktreeInitCommand?: string; tokenCap?: number | null };

interface SettingsModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  /** Optional section to show when the modal first opens. Defaults to the global General section. */
  initialSection?: SectionId;
  /** Current theme mode */
  themeMode?: ThemeMode;
  /** Current color theme */
  colorTheme?: ColorTheme;
  /** Called when theme mode changes */
  onThemeModeChange?: (mode: ThemeMode) => void;
  /** Called when color theme changes */
  onColorThemeChange?: (theme: ColorTheme) => void;
  /** Current dashboard font scale percentage */
  dashboardFontScalePct?: number;
  /** Called when dashboard font scale changes */
  onDashboardFontScaleChange?: (scalePct: number) => void;
  /** Optional callback when user wants to reopen the onboarding guide */
  onReopenOnboarding?: () => void;
  /** Optional callback to open approvals/mailbox view. */
  onOpenApprovals?: (approvalId?: string) => void;
  /** Optional callback to navigate from settings to Secrets view. */
  onNavigateToSecrets?: () => void;
}

export function SettingsModal({
  onClose,
  addToast,
  projectId,
  initialSection,
  themeMode = "dark",
  colorTheme = "default",
  onThemeModeChange,
  onColorThemeChange,
  dashboardFontScalePct = 100,
  onDashboardFontScaleChange,
  onReopenOnboarding,
  onOpenApprovals,
  onNavigateToSecrets,
}: SettingsModalProps) {
  const { confirm } = useConfirm();
  const worktrunkInstall = useWorktrunkInstallStatus(projectId);
  const worktrunkInstallVerified = worktrunkInstall.status === "installed";
  const viewportMode = useViewportMode();
  useMobileScrollLock(true);
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: viewportMode === "mobile",
  });
  const keyboardStyle: CSSProperties = keyboardOpen
    ? ({
        "--keyboard-overlap": `${keyboardOverlap}px`,
        "--vv-offset-top": `${viewportOffsetTop}px`,
        ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
      } as CSSProperties)
    : {};
  const modalRef = useRef<HTMLDivElement>(null);
  const settingsContentRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, true, "fusion:settings-modal-size");
  const sessionBannersHidden = useSessionBannersHidden();
  const [form, setForm] = useState<SettingsFormState>({
    maxConcurrent: 2,
    maxTriageConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    heartbeatMultiplier: 1,
    groupOverlappingFiles: true,
    overlapIgnorePaths: [],
    autoMerge: true,
    mergeStrategy: "direct",
    mergeIntegrationWorktree: "reuse-task-worktree",
    mergeAdvanceAutoSync: "stash-and-ff",
    recycleWorktrees: false,
    executorAllowSiblingBranchRename: false,
    worktreeNaming: "random",
    worktreesDir: "",
    worktrunk: {
      enabled: false,
      binaryPath: "",
      onFailure: "fail",
    },
    includeTaskIdInCommit: true,
    worktreeInitCommand: "",
    ntfyEnabled: false,
    ntfyTopic: undefined,
    ntfyAccessToken: undefined,
    failureNotificationMode: "sticky-only",
    failureNotificationDelayMs: 30000,
    webhookEnabled: false,
    webhookUrl: undefined,
    webhookFormat: "generic",
    webhookEvents: undefined,
  });
  const [loading, setLoading] = useState(true);
  // Track initial values to detect explicit clears for null-as-delete semantics
  const [initialValues, setInitialValues] = useState<Settings | null>(null);
  // Track scoped settings for inheritance detection (fetched alongside merged settings)
  // This stores the raw { global, project } structure from the API
  const [scopedSettings, setScopedSettings] = useState<{ global: GlobalSettings; project: Partial<Settings> } | null>(null);
  // Track initial scoped values for null-as-delete semantics on project overrides
  const [initialScopedValues, setInitialScopedValues] = useState<{ global: GlobalSettings; project: Partial<Settings> } | null>(null);
  // Find the first non-group-header section for visibility fallback handling
  const firstNonHeaderSection = SETTINGS_SECTIONS.find((s) => !s.isGroupHeader);
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    if (initialSection === "pi-extensions") {
      return "plugins";
    }
    return initialSection ?? DEFAULT_SETTINGS_SECTION;
  });
  // Deterministic default: opening Plugins starts on Fusion Plugins unless legacy
  // `initialSection="pi-extensions"` is explicitly provided.
  const [activePluginsSubsection, setActivePluginsSubsection] = useState<PluginsSubsectionId>(() =>
    initialSection === "pi-extensions" ? "pi-extensions" : "fusion-plugins",
  );
  const [showMobileSectionPicker, setShowMobileSectionPicker] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_SETTINGS_MEDIA_QUERY)?.matches === true
      : false,
  );
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateCheckLoading, setUpdateCheckLoading] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResponse | null>(null);
  const gitHubStarCount = useGitHubStarCount();
  const [starClicked, markStarClicked] = useStarClickedFlag();
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [researchLimitError, setResearchLimitError] = useState<string | null>(null);
  const [overlapPathPickerIndex, setOverlapPathPickerIndex] = useState<number | null>(null);
  const [worktreesDirPickerOpen, setWorktreesDirPickerOpen] = useState(false);

  const {
    entries: overlapPathPickerEntries,
    currentPath: overlapPathPickerCurrentPath,
    setPath: setOverlapPathPickerPath,
    loading: overlapPathPickerLoading,
    error: overlapPathPickerError,
    refresh: refreshOverlapPathPicker,
  } = useWorkspaceFileBrowser("project", overlapPathPickerIndex !== null, projectId);

  const {
    entries: worktreesDirPickerEntries,
    currentPath: worktreesDirPickerCurrentPath,
    setPath: setWorktreesDirPickerPath,
    loading: worktreesDirPickerLoading,
    error: worktreesDirPickerError,
    refresh: refreshWorktreesDirPicker,
  } = useWorkspaceFileBrowser("project", worktreesDirPickerOpen, projectId);

  const { nodes } = useNodes();
  const experimentalFeatures = form.experimentalFeatures ?? {};
  const remoteAccessEnabled = isExperimentalFeatureEnabled(experimentalFeatures, "remoteAccess");
  const researchViewEnabled = isExperimentalFeatureEnabled(experimentalFeatures, "researchView");
  const evalsViewEnabled = isExperimentalFeatureEnabled(experimentalFeatures, "evalsView");
  const visibleSections = SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "remote") {
      return remoteAccessEnabled;
    }

    if (section.id === "research-global" || section.id === "research-project") {
      return researchViewEnabled;
    }

    if (section.id === "scheduled-evals") {
      return evalsViewEnabled;
    }

    return true;
  });
  const firstVisibleSectionId = visibleSections.some((section) => section.id === DEFAULT_SETTINGS_SECTION)
    ? DEFAULT_SETTINGS_SECTION
    : (visibleSections.find((section) => !section.isGroupHeader)?.id ?? firstNonHeaderSection?.id ?? "general");

  /** Get the scope of the currently active section */
  const activeSectionScope = visibleSections.find((s) => s.id === activeSection)?.scope;

  useEffect(() => {
    if (activeSection === "remote" && !remoteAccessEnabled) {
      setActiveSection(firstVisibleSectionId);
      return;
    }

    if ((activeSection === "research-global" || activeSection === "research-project") && !researchViewEnabled) {
      setActiveSection(firstVisibleSectionId);
      return;
    }

    if (activeSection === "scheduled-evals" && !evalsViewEnabled) {
      setActiveSection(firstVisibleSectionId);
      return;
    }

    if (!visibleSections.some((section) => section.id === activeSection)) {
      setActiveSection(firstVisibleSectionId);
    }
  }, [activeSection, remoteAccessEnabled, researchViewEnabled, evalsViewEnabled, firstVisibleSectionId, visibleSections]);

  // Auth state (independent of the settings save flow)
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
  const [loginInstructions, setLoginInstructions] = useState<Record<string, string>>({});
  const [manualCodeConfigs, setManualCodeConfigs] = useState<Record<string, ManualOAuthCodeInfo>>({});
  const [deviceCodes, setDeviceCodes] = useState<Record<string, OAuthDeviceCodeInfo>>({});
  const [manualCodeInputs, setManualCodeInputs] = useState<Record<string, string>>({});
  const [manualCodeSubmitInProgress, setManualCodeSubmitInProgress] = useState<string | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyErrors, setApiKeyErrors] = useState<Record<string, string>>({});
  const [opencodeApiKeyRefreshStatus, setOpencodeApiKeyRefreshStatus] = useState<Record<string, {
    tone: "success" | "error";
    message: string;
  }>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAutoCopiedDeviceCodesRef = useRef<Record<string, string>>({});

  // Model state
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);

  // Test notification state
  const [testNotificationLoading, setTestNotificationLoading] = useState<Record<string, boolean>>({});
  const [testNotificationResult, setTestNotificationResult] = useState<Record<string, { status: "success" | "error"; message: string }>>({});
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetDraft, setPresetDraft] = useState<ModelPreset | null>(null);

  // Backup state
  const [backupInfo, setBackupInfo] = useState<BackupListResponse | null>(null);
  const [backupLoading, setBackupLoading] = useState(false);

  // Remote access state
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [externalTunnel, setExternalTunnel] = useState<{ provider: string; url: string | null } | null>(null);
  const [remoteBusyAction, setRemoteBusyAction] = useState<string | null>(null);
  const [cloudflaredInstalling, setCloudflaredInstalling] = useState(false);
  const [cloudflaredInstallError, setCloudflaredInstallError] = useState<string | null>(null);
  const [remoteAuthLinkTokenType, setRemoteAuthLinkTokenType] = useState<"persistent" | "short-lived">("persistent");
  const [remoteUrlPreview, setRemoteUrlPreview] = useState<{ url: string; expiresAt: string | null; tokenType: "persistent" | "short-lived" } | null>(null);
  const [remoteQrSvg, setRemoteQrSvg] = useState<string | null>(null);
  const [remoteShortLivedToken, setRemoteShortLivedToken] = useState<{ token: string; expiresAt: string; ttlMs: number } | null>(null);
  const [tunnelShareLink, setTunnelShareLink] = useState<{ url: string; qrSvg: string | null } | null>(null);

  // Project memory state
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  // Git remotes for the worktree rebase dropdown. Loaded lazily; empty list
  // is a valid state (fresh repo, no remotes configured yet).
  const [gitRemotes, setGitRemotes] = useState<GitRemoteDetailed[]>([]);
  // Branch list for the Integration branch dropdown. Loaded lazily when the
  // merge section becomes visible. Empty list is a valid state (fresh repo /
  // permissions issue); the UI falls back to allowing custom free-text entry.
  const [integrationBranchOptions, setIntegrationBranchOptions] = useState<string[]>([]);
  // Sticky toggle: once the user picks "Custom..." we keep them in text-input
  // mode even when the typed value happens to match an existing branch.
  const [integrationBranchCustomMode, setIntegrationBranchCustomMode] = useState(false);
  const [projectTrackingRepoOptions, setProjectTrackingRepoOptions] = useState<TrackingRepoOption[]>([]);
  const [projectTrackingRepoLoading, setProjectTrackingRepoLoading] = useState(false);
  const [projectTrackingRepoError, setProjectTrackingRepoError] = useState<string | null>(null);
  const [globalTrackingRepoOptions, setGlobalTrackingRepoOptions] = useState<TrackingRepoOption[]>([]);
  const [globalTrackingRepoLoading, setGlobalTrackingRepoLoading] = useState(false);
  const [globalTrackingRepoError, setGlobalTrackingRepoError] = useState<string | null>(null);
  const globalTrackingRepoLoadedRef = useRef(false);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [selectedMemoryPath, setSelectedMemoryPath] = useState(DEFAULT_MEMORY_EDITOR_PATH);
  const [memoryTestQuery, setMemoryTestQuery] = useState("");
  const [memoryTestLoading, setMemoryTestLoading] = useState(false);
  const [memoryTestResult, setMemoryTestResult] = useState<MemoryRetrievalTestResult | null>(null);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [memoryCompactLoading, setMemoryCompactLoading] = useState(false);
  const [qmdInstallLoading, setQmdInstallLoading] = useState(false);
  const skipNextMemoryReloadRef = useRef(false);

  // Global concurrency state
  const [globalMaxConcurrent, setGlobalMaxConcurrent] = useState<number | undefined>(4);
  const initialGlobalMaxConcurrentRef = useRef<number | undefined>(4);
  const hasFetchedGlobalConcurrencyRef = useRef(false);
  const globalConcurrencyDirtyRef = useRef(false);

  // Import/Export state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<SettingsExportData | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importScope, setImportScope] = useState<'global' | 'project' | 'both'>('both');
  const [importMerge, setImportMerge] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Memory backend status - called at component top level to comply with React Rules of Hooks
  const {
    status: memoryBackendStatus,
    capabilities: memoryCapabilities,
    loading: memoryBackendLoading,
    error: memoryBackendError,
    refresh: refreshMemoryBackend,
  } = useMemoryBackendStatus({
    projectId,
    enabled: activeSection === "memory",
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_SETTINGS_MEDIA_QUERY);
    if (!mediaQuery) {
      return;
    }
    const updateMobilePicker = (event?: MediaQueryListEvent) => {
      setShowMobileSectionPicker(event ? event.matches : mediaQuery.matches);
    };

    updateMobilePicker();
    mediaQuery.addEventListener("change", updateMobilePicker);
    return () => mediaQuery.removeEventListener("change", updateMobilePicker);
  }, []);

  useEffect(() => {
    // Load both merged and scoped settings to enable inheritance detection
    Promise.all([fetchSettings(projectId), fetchSettingsByScope(projectId)])
      .then(([s, scoped]) => {
        const normalizedSettings = {
          ...s,
          mergeIntegrationWorktree: normalizeMergeIntegrationWorktreeMode(s.mergeIntegrationWorktree),
          mergeAdvanceAutoSync: normalizeMergeAdvanceAutoSyncMode(s.mergeAdvanceAutoSync),
        };
        setForm(normalizedSettings);
        setInitialValues(normalizedSettings); // Store initial values to detect explicit clears
        setScopedSettings(scoped);
        setInitialScopedValues({
          ...scoped,
          project: {
            ...scoped.project,
            mergeIntegrationWorktree: scoped.project.mergeIntegrationWorktree === undefined
              ? undefined
              : normalizeMergeIntegrationWorktreeMode(scoped.project.mergeIntegrationWorktree),
            mergeAdvanceAutoSync: scoped.project.mergeAdvanceAutoSync === undefined
              ? undefined
              : normalizeMergeAdvanceAutoSyncMode(scoped.project.mergeAdvanceAutoSync),
          },
        }); // Store initial scoped values for null-as-delete
        setLoading(false);
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
        setLoading(false);
      });
  }, [addToast, projectId]);

  useEffect(() => {
    if (activeSection !== "scheduling" || hasFetchedGlobalConcurrencyRef.current) {
      return;
    }

    let cancelled = false;
    fetchGlobalConcurrency()
      .then((state) => {
        if (cancelled) {
          return;
        }
        if (!globalConcurrencyDirtyRef.current) {
          setGlobalMaxConcurrent(state.globalMaxConcurrent);
        }
        initialGlobalMaxConcurrentRef.current = state.globalMaxConcurrent;
        hasFetchedGlobalConcurrencyRef.current = true;
      })
      .catch(() => {
        // Silently fail — global concurrency may not be available
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  useEffect(() => {
    let cancelled = false;

    fetchDashboardHealth()
      .then((health) => {
        if (cancelled) {
          return;
        }

        if (typeof health.version === "string" && health.version.trim().length > 0) {
          setAppVersion(health.version);
        }
      })
      .catch(() => {
        // Non-blocking metadata only — settings remains usable when unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckForUpdates = useCallback(async () => {
    setUpdateCheckLoading(true);

    try {
      const result = await checkForUpdates();
      setUpdateCheckResult(result);

      if (result.error) {
        addToast(result.error, "error");
      }
    } catch (error) {
      const message = getErrorMessage(error) || "Failed to check for updates";
      setUpdateCheckResult({
        currentVersion: appVersion ?? "unknown",
        latestVersion: null,
        updateAvailable: false,
        error: message,
      });
      addToast(message, "error");
    } finally {
      setUpdateCheckLoading(false);
    }
  }, [addToast, appVersion]);

  const renderUpdateCheckResultContent = useCallback(() => {
    if (!updateCheckResult) {
      return null;
    }

    if (updateCheckResult.error) {
      return updateCheckResult.error;
    }

    if (updateCheckResult.updateAvailable && updateCheckResult.latestVersion) {
      return (
        <>
          v{updateCheckResult.latestVersion} available ·{" "}
          <a
            href="https://runfusion.ai"
            target="_blank"
            rel="noreferrer"
            className="settings-update-result-link"
          >
            Learn more
          </a>
        </>
      );
    }

    return "You're up to date ✓";
  }, [updateCheckResult]);

  // Load auth status when the authentication section is active
  const loadAuthStatus = useCallback(async () => {
    try {
      const { providers } = await fetchAuthStatus();
      const visibleProviders = filterVisibleOnboardingAndSettingsProviders(providers);
      setAuthProviders(visibleProviders);
      setLoginInstructions((prev) => {
        const next: Record<string, string> = {};
        for (const [providerId, instructions] of Object.entries(prev)) {
          const provider = visibleProviders.find((candidate) => candidate.id === providerId);
          if (provider && !provider.authenticated) {
            next[providerId] = instructions;
          }
        }
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    } catch {
      // Silently fail — auth may not be configured
    }
  }, []);

  useEffect(() => {
    if (activeSection === "global-models" || activeSection === "project-models") {
      setModelsLoading(true);
      fetchModels()
        .then((response) => {
          setAvailableModels(response.models);
          setFavoriteProviders(response.favoriteProviders);
          setFavoriteModels(response.favoriteModels);
        })
        .catch(() => setAvailableModels([]))
        .finally(() => setModelsLoading(false));
    }
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === "backups") {
      setBackupLoading(true);
      fetchBackups(projectId)
        .then((info) => setBackupInfo(info))
        .catch(() => setBackupInfo(null))
        .finally(() => setBackupLoading(false));
    }
  }, [activeSection, projectId]);

  const loadRemoteData = useCallback(async () => {
    const [settingsResult, statusResult] = await Promise.allSettled([
      fetchRemoteSettings(projectId),
      fetchRemoteStatus(projectId),
    ]);

    if (settingsResult.status === "fulfilled") {
      setForm((prev) => ({ ...prev, ...(settingsResult.value.settings as unknown as Partial<SettingsFormState>) }));
    }

    if (statusResult.status === "fulfilled") {
      setRemoteStatus(statusResult.value);
      setExternalTunnel(statusResult.value.externalTunnel ?? null);
    }
  }, [projectId]);

  useEffect(() => {
    const state = remoteStatus?.state;
    if (state === "running" || state === "starting") {
      setExternalTunnel(null);
    }
  }, [remoteStatus?.state]);

  useEffect(() => {
    if (activeSection !== "remote") {
      return;
    }

    loadRemoteData().catch(() => {
      setRemoteStatus(null);
    });
  }, [activeSection, loadRemoteData]);

  // Poll remote status while the tunnel is starting so the UI flips to
  // "running" without the user closing/reopening the modal. Stops polling
  // once it reaches a terminal state.
  useEffect(() => {
    if (activeSection !== "remote") return;
    const state = remoteStatus?.state;
    if (state !== "starting" && state !== "stopping") return;
    const interval = setInterval(() => {
      fetchRemoteStatus(projectId)
        .then((status) => {
          setRemoteStatus(status);
          setExternalTunnel(status.externalTunnel ?? null);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(interval);
  }, [activeSection, projectId, remoteStatus?.state]);

  // When the tunnel is running, fetch a persistent-token authenticated URL +
  // QR so the user can share/scan it without digging into Advanced Settings.
  useEffect(() => {
    if (activeSection !== "remote") return;
    if (remoteStatus?.state !== "running") {
      setTunnelShareLink(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const qr = await fetchRemoteQr("image/svg", { projectId, tokenType: "persistent" });
        if (cancelled) return;
        setTunnelShareLink({ url: qr.url, qrSvg: qr.data ?? null });
      } catch {
        if (cancelled) return;
        try {
          const link = await fetchRemoteUrl({ projectId, tokenType: "persistent" });
          if (cancelled) return;
          setTunnelShareLink({ url: link.url, qrSvg: null });
        } catch {
          if (!cancelled) setTunnelShareLink(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSection, projectId, remoteStatus?.state, remoteStatus?.url]);

  useEffect(() => {
    if (activeSection !== "remote") return;
    const tunnelUrl = externalTunnel?.url;
    if (remoteStatus?.state !== "stopped" || !tunnelUrl) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const qr = await fetchRemoteQr("image/svg", { projectId, tokenType: "persistent" });
        if (cancelled) return;
        setTunnelShareLink({ url: tunnelUrl, qrSvg: qr.data ?? null });
      } catch {
        if (!cancelled) {
          setTunnelShareLink({ url: tunnelUrl, qrSvg: null });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSection, externalTunnel?.url, projectId, remoteStatus?.state]);

  // Lazy-load git remotes for the rebase-remote dropdown when the Worktrees
  // section becomes visible. Failure is non-fatal: the dropdown falls back
  // to just "Use git default".
  useEffect(() => {
    if (activeSection !== "worktrees") return;
    fetchGitRemotesDetailed(projectId)
      .then((remotes) => setGitRemotes(remotes))
      .catch(() => setGitRemotes([]));
  }, [activeSection, projectId]);

  // Load local branch list when the merge section becomes visible, so the
  // Integration branch dropdown shows actual options instead of forcing
  // free-text entry. Best-effort — falls back to empty list (custom-only).
  useEffect(() => {
    if (activeSection !== "merge") return;
    fetchGitBranches(projectId)
      .then((branches) => {
        const names = branches
          .map((b) => b.name)
          .filter((name): name is string => typeof name === "string" && name.length > 0);
        // Dedup + sort, with common integration names first.
        const seen = new Set<string>();
        const priority = ["main", "master", "trunk", "develop"];
        const ordered: string[] = [];
        for (const name of priority) {
          if (names.includes(name) && !seen.has(name)) {
            ordered.push(name);
            seen.add(name);
          }
        }
        for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
          if (seen.has(name)) continue;
          seen.add(name);
          ordered.push(name);
        }
        setIntegrationBranchOptions(ordered);
      })
      .catch(() => setIntegrationBranchOptions([]));
  }, [activeSection, projectId]);

  useEffect(() => {
    if (activeSection !== "general") {
      return;
    }

    let cancelled = false;
    setProjectTrackingRepoLoading(true);
    setProjectTrackingRepoError(null);

    fetchGitRemotes(projectId)
      .then((remotes) => {
        if (cancelled) {
          return;
        }
        setProjectTrackingRepoOptions(toTrackingRepoOptions(remotes));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setProjectTrackingRepoOptions([]);
        setProjectTrackingRepoError("Could not load detected remotes. Enter a custom owner/repo value.");
      })
      .finally(() => {
        if (!cancelled) {
          setProjectTrackingRepoLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, projectId]);

  useEffect(() => {
    if (activeSection !== "global-general" || globalTrackingRepoLoadedRef.current) {
      return;
    }

    let cancelled = false;
    setGlobalTrackingRepoLoading(true);
    setGlobalTrackingRepoError(null);

    fetchProjects()
      .then(async (projects) => {
        const results = await Promise.allSettled(
          projects.map(async (project: ProjectInfo) => {
            const remotes = await fetchGitRemotes(project.id);
            return remotes.map((remote) => ({
              value: `${remote.owner}/${remote.repo}`,
              label: `${remote.owner}/${remote.repo}`,
              source: project.name,
            }));
          }),
        );

        if (cancelled) {
          return;
        }

        const optionsByValue = new Map<string, TrackingRepoOption>();
        let successCount = 0;

        for (const result of results) {
          if (result.status !== "fulfilled") {
            continue;
          }
          successCount += 1;
          for (const option of result.value) {
            if (!optionsByValue.has(option.value)) {
              optionsByValue.set(option.value, option);
            }
          }
        }

        const flattenedOptions = [...optionsByValue.values()].sort((a, b) => a.value.localeCompare(b.value));
        setGlobalTrackingRepoOptions(flattenedOptions);

        if (projects.length > 0 && successCount === 0) {
          setGlobalTrackingRepoError("Could not load remotes from registered projects. Enter a custom owner/repo value.");
        }

        globalTrackingRepoLoadedRef.current = true;
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setGlobalTrackingRepoOptions([]);
        setGlobalTrackingRepoError("Could not load project list. Enter a custom owner/repo value.");
        globalTrackingRepoLoadedRef.current = true;
      })
      .finally(() => {
        if (!cancelled) {
          setGlobalTrackingRepoLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, projectId]);

  useEffect(() => {
    if (activeSection !== "memory" || memoryDirty) {
      return;
    }
    if (skipNextMemoryReloadRef.current) {
      skipNextMemoryReloadRef.current = false;
      return;
    }

    let cancelled = false;
    setMemoryLoading(true);
    fetchMemoryFiles(projectId)
      .then(async ({ files }) => {
        if (cancelled) return;
        setMemoryFiles(files);
        const nextPath = files.some((file) => file.path === selectedMemoryPath)
          ? selectedMemoryPath
          : files.find((file) => file.path === DEFAULT_MEMORY_EDITOR_PATH)?.path
            ?? files.find((file) => file.layer === "dreams")?.path
            ?? files[0]?.path
            ?? DEFAULT_MEMORY_EDITOR_PATH;
        setSelectedMemoryPath(nextPath);
        const { content } = await fetchMemoryFile(nextPath, projectId);
        if (cancelled) return;
        setMemoryContent(content);
        setMemoryDirty(false);
      })
      .catch((err) => {
        if (cancelled) return;
        addToast(getErrorMessage(err) || "Failed to load project memory", "error");
        setMemoryContent("");
      })
      .finally(() => {
        if (!cancelled) {
          setMemoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, memoryDirty, selectedMemoryPath, projectId, addToast]);

  useEffect(() => {
    if (activeSection === "authentication" || activeSection === "research-global") {
      setAuthLoading(true);
      loadAuthStatus().finally(() => setAuthLoading(false));
    }
    // Clean up polling when leaving auth section
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [activeSection, loadAuthStatus]);

  useEffect(() => {
    if (activeSection !== "authentication") {
      return;
    }

    const hasPendingServerLogin = authProviders.some((provider) => provider.type !== "api_key" && provider.loginInProgress);
    if (!hasPendingServerLogin) {
      return;
    }

    const interval = setInterval(() => {
      void loadAuthStatus();
    }, 2000);

    return () => clearInterval(interval);
  }, [activeSection, authProviders, loadAuthStatus]);

  const scrollSettingsToTop = useCallback(() => {
    settingsContentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const clearAuthLoginUiState = useCallback((providerId: string) => {
    if (providerId in lastAutoCopiedDeviceCodesRef.current) {
      const next = { ...lastAutoCopiedDeviceCodesRef.current };
      delete next[providerId];
      lastAutoCopiedDeviceCodesRef.current = next;
    }
    setLoginInstructions((prev) => {
      if (!(providerId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    setManualCodeConfigs((prev) => {
      if (!(providerId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    setManualCodeInputs((prev) => {
      if (!(providerId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    setDeviceCodes((prev) => {
      if (!(providerId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
  }, []);

  useEffect(() => {
    const copilotDeviceCode = deviceCodes["github-copilot"];
    if (!copilotDeviceCode?.userCode) {
      return;
    }

    if (lastAutoCopiedDeviceCodesRef.current["github-copilot"] === copilotDeviceCode.userCode) {
      return;
    }

    lastAutoCopiedDeviceCodesRef.current["github-copilot"] = copilotDeviceCode.userCode;
    void copyTextToClipboard(copilotDeviceCode.userCode);
  }, [deviceCodes]);

  const handleLogin = useCallback(async (providerId: string) => {
    const provider = authProviders.find((entry) => entry.id === providerId);
    if (provider?.requiresManualCode === true) {
      const shouldContinue = await confirm({
        title: "Heads up — manual paste-back required",
        message:
          `After you sign in with ${provider.name}, the browser will try to redirect to a localhost address that this dashboard can't reach. The redirect tab will look like it failed. Before that happens, copy the full URL from the browser address bar — you'll paste it back here to finish login. Continue?`,
        confirmLabel: "Continue to login",
        cancelLabel: "Cancel",
      });
      if (!shouldContinue) {
        return;
      }
    }

    setAuthActionInProgress(providerId);
    clearAuthLoginUiState(providerId);

    try {
      const { url, instructions, manualCode, deviceCode } = await loginProvider(providerId);
      if (instructions?.trim() && !(providerId === "github-copilot" && deviceCode)) {
        setLoginInstructions((prev) => ({ ...prev, [providerId]: instructions }));
      }
      if (manualCode) {
        setManualCodeConfigs((prev) => ({ ...prev, [providerId]: manualCode }));
      }
      if (deviceCode && providerId === "github-copilot") {
        setDeviceCodes((prev) => ({ ...prev, [providerId]: deviceCode }));
      }
      if (providerId !== "github-copilot" || !deviceCode) {
        window.open(appendTokenQuery(deviceCode?.verificationUri ?? url), "_blank");
      }

      // Poll for auth completion every 2 seconds
      pollIntervalRef.current = setInterval(async () => {
        try {
          const { providers } = await fetchAuthStatus();
          const visibleProviders = filterVisibleOnboardingAndSettingsProviders(providers);
          setAuthProviders(visibleProviders);
          const provider = visibleProviders.find((p) => p.id === providerId);
          if (provider?.authenticated) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setAuthActionInProgress(null);
            clearAuthLoginUiState(providerId);
            addToast("Login successful", "success");
            scrollSettingsToTop();
            return;
          }

          if (!provider?.loginInProgress) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setAuthActionInProgress(null);
            clearAuthLoginUiState(providerId);
            addToast("Login did not complete. Please try again.", "error");
          }
        } catch {
          // Continue polling on transient errors
        }
      }, 2000);
    } catch (err) {
      const message = getErrorMessage(err) || "Login failed";
      const isConflict = message.includes("already in progress") || (typeof err === "object" && err !== null && "status" in err && (err as { status?: number }).status === 409);
      if (isConflict) {
        addToast("Login already in progress. You can cancel it and retry.", "warning");
        await loadAuthStatus();
      } else {
        addToast(message, "error");
      }
      setAuthActionInProgress(null);
      clearAuthLoginUiState(providerId);
    }
  }, [addToast, authProviders, clearAuthLoginUiState, confirm, loadAuthStatus, scrollSettingsToTop]);

  const handleSubmitManualCode = useCallback(async (providerId: string) => {
    const code = manualCodeInputs[providerId]?.trim();
    if (!code) {
      addToast("Paste the full redirect URL or authorization code first.", "warning");
      return;
    }

    setManualCodeSubmitInProgress(providerId);
    try {
      const result = await submitProviderManualCode(providerId, code);
      if (result.submitted) {
        setManualCodeInputs((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        addToast("Authorization code received. Finishing login…", "success");
      } else {
        addToast("That authorization code was already submitted. Waiting for login…", "warning");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to submit authorization code", "error");
    } finally {
      setManualCodeSubmitInProgress(null);
    }
  }, [addToast, manualCodeInputs]);

  const handleCancelLogin = useCallback(async (providerId: string) => {
    setAuthActionInProgress(providerId);
    setAuthProviders((prev) => prev.map((provider) =>
      provider.id === providerId ? { ...provider, loginInProgress: false } : provider,
    ));
    try {
      await cancelProviderLogin(providerId);
      clearAuthLoginUiState(providerId);
      await loadAuthStatus().catch(() => {});
      addToast("Login cancelled", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to cancel login", "error");
    } finally {
      setAuthActionInProgress(null);
      setManualCodeSubmitInProgress((prev) => prev === providerId ? null : prev);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  }, [addToast, clearAuthLoginUiState, loadAuthStatus]);

  const handleLogout = useCallback(async (providerId: string) => {
    setAuthActionInProgress(providerId);
    try {
      await logoutProvider(providerId);
      await loadAuthStatus();
      addToast("Logged out", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Logout failed", "error");
    } finally {
      setAuthActionInProgress(null);
    }
  }, [addToast, loadAuthStatus]);

  const handleSaveApiKey = useCallback(async (providerId: string) => {
    const key = apiKeyInputs[providerId]?.trim();
    if (!key) {
      setApiKeyErrors((prev) => ({ ...prev, [providerId]: "API key is required" }));
      return;
    }
    setAuthActionInProgress(providerId);
    setApiKeyErrors((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    try {
      const saveResult = await saveApiKey(providerId, key);
      setApiKeyInputs((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      await loadAuthStatus();
      if (providerId === "opencode" || providerId === "opencode-go") {
        const modelsRefreshed = saveResult.modelsRefreshed;
        const refreshReason = saveResult.refreshReason;
        const refreshError = saveResult.refreshError;
        if (refreshError) {
          setOpencodeApiKeyRefreshStatus((prev) => ({
            ...prev,
            [providerId]: {
              tone: "error",
              message: `Saved, but model refresh failed: ${refreshError}. Make sure the \`opencode\` CLI is installed on PATH.`,
            },
          }));
        } else if (refreshReason === "no-models-from-cli") {
          setOpencodeApiKeyRefreshStatus((prev) => ({
            ...prev,
            [providerId]: {
              tone: "error",
              message: "Saved. The local `opencode` CLI returned no models — run `opencode auth login` and `opencode models opencode --refresh`, then click Save again.",
            },
          }));
        } else if (typeof modelsRefreshed === "number" && modelsRefreshed > 0) {
          setOpencodeApiKeyRefreshStatus((prev) => ({
            ...prev,
            [providerId]: {
              tone: "success",
              message: `Refreshed ${modelsRefreshed} opencode-go models.`,
            },
          }));
        } else {
          setOpencodeApiKeyRefreshStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
          });
        }
      }
      addToast("API key saved", "success");
      scrollSettingsToTop();
    } catch (err) {
      setApiKeyErrors((prev) => ({ ...prev, [providerId]: getErrorMessage(err) || "Failed to save API key" }));
      if (providerId === "opencode" || providerId === "opencode-go") {
        setOpencodeApiKeyRefreshStatus((prev) => {
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
      }
    } finally {
      setAuthActionInProgress(null);
    }
  }, [apiKeyInputs, addToast, loadAuthStatus, scrollSettingsToTop]);

  const handleClearApiKey = useCallback(async (providerId: string) => {
    setAuthActionInProgress(providerId);
    try {
      await clearApiKey(providerId);
      setApiKeyInputs((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setApiKeyErrors((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      await loadAuthStatus();
      addToast("API key cleared", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to clear API key", "error");
    } finally {
      setAuthActionInProgress(null);
    }
  }, [addToast, loadAuthStatus]);

  const handleTestProviderNotification = useCallback(async (providerId: "ntfy" | "webhook" | "ntfy-message" | "ntfy-room") => {
    if (providerId === "ntfy" || providerId === "ntfy-message" || providerId === "ntfy-room") {
      if (!form.ntfyEnabled || !form.ntfyTopic || !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)) {
        return;
      }
    }

    if (providerId === "webhook") {
      if (!form.webhookEnabled || !form.webhookUrl?.trim()) {
        return;
      }
      try {
        const parsed = new URL(form.webhookUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return;
        }
      } catch {
        return;
      }
    }

    setTestNotificationLoading((prev) => ({ ...prev, [providerId]: true }));
    setTestNotificationResult((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    try {
      const config = providerId === "ntfy"
        ? {
          ntfyEnabled: form.ntfyEnabled,
          ntfyTopic: form.ntfyTopic,
          ...(form.ntfyBaseUrl?.trim() ? { ntfyBaseUrl: form.ntfyBaseUrl.trim() } : {}),
          ...(form.ntfyAccessToken?.trim() ? { ntfyAccessToken: form.ntfyAccessToken.trim() } : {}),
        }
        : providerId === "ntfy-message"
          ? { messageEventType: "message:agent-to-user" }
          : providerId === "ntfy-room"
            ? { messageEventType: "message:room" }
            : {
              webhookUrl: form.webhookUrl,
              webhookFormat: form.webhookFormat || "generic",
            };
      const result = await testNotification(
        providerId === "ntfy-message" || providerId === "ntfy-room" ? "ntfy" : providerId,
        config,
        projectId,
      );
      if (result.success) {
        const successMessage = providerId === "ntfy"
          ? "Test notification sent — check your ntfy app!"
          : providerId === "ntfy-message"
            ? "Message inbox test sent — check your ntfy inbox for the agent-to-user message."
            : providerId === "ntfy-room"
              ? "Room reply test sent — check your ntfy inbox for the room reply."
              : "Test notification sent — check your webhook endpoint!";
        setTestNotificationResult((prev) => ({ ...prev, [providerId]: { status: "success", message: successMessage } }));
        addToast(successMessage, "success");
      } else {
        const failureMessage = providerId === "ntfy-message"
          ? "Failed to send message inbox test"
          : providerId === "ntfy-room"
            ? "Failed to send room reply test"
            : "Failed to send test notification";
        setTestNotificationResult((prev) => ({ ...prev, [providerId]: { status: "error", message: failureMessage } }));
        addToast(failureMessage, "error");
      }
    } catch (err) {
      const failureMessage = getErrorMessage(err) || "Failed to send test notification";
      setTestNotificationResult((prev) => ({ ...prev, [providerId]: { status: "error", message: failureMessage } }));
      addToast(failureMessage, "error");
    } finally {
      setTestNotificationLoading((prev) => ({ ...prev, [providerId]: false }));
    }
  }, [
    addToast,
    form.ntfyAccessToken,
    form.ntfyBaseUrl,
    form.ntfyEnabled,
    form.ntfyTopic,
    form.webhookEnabled,
    form.webhookFormat,
    form.webhookUrl,
    projectId,
  ]);

  const handleBackupNow = useCallback(async () => {
    setBackupLoading(true);
    try {
      const result = await createBackup(projectId);
      if (result.success) {
        addToast("Backup created successfully", "success");
        // Refresh backup list
        const info = await fetchBackups(projectId);
        setBackupInfo(info);
      } else {
        addToast(result.error || "Failed to create backup", "error");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to create backup", "error");
    } finally {
      setBackupLoading(false);
    }
  }, [addToast, projectId]);

  // Export/Import handlers
  const handleExport = useCallback(async () => {
    try {
      // Default scope based on active section
      const scope = activeSectionScope === "global" ? "global" : 
                    activeSectionScope === "project" ? "project" : "both";
      const data = await exportSettings(scope, projectId);
      
      // Create and download the JSON file
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const filename = `fusion-settings-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      const scopeLabel = scope === "global" ? "global" : scope === "project" ? "project" : "all";
      addToast(`Settings exported (${scopeLabel} scope)`, "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to export settings", "error");
    }
  }, [addToast, activeSectionScope, projectId]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setImportFile(file);
    setImportLoading(true);
    
    try {
      const text = await file.text();
      const data = JSON.parse(text) as SettingsExportData;
      setImportPreview(data);
      setImportDialogOpen(true);
    } catch (err) {
      addToast(`Invalid JSON file: ${getErrorMessage(err)}`, "error");
      setImportFile(null);
    } finally {
      setImportLoading(false);
    }
  }, [addToast]);

  const handleImport = useCallback(async () => {
    if (!importPreview) return;
    
    setImportLoading(true);
    try {
      const result = await importSettings(importPreview, { scope: importScope, merge: importMerge }, projectId);
      if (result.success) {
        const parts: string[] = [];
        if (result.globalCount > 0) parts.push(`${result.globalCount} global`);
        if (result.projectCount > 0) parts.push(`${result.projectCount} project`);
        addToast(`Imported ${parts.join(", ")} setting(s)`, "success");
        setImportDialogOpen(false);
        setImportPreview(null);
        setImportFile(null);
        // Refresh settings to show imported values
        const refreshed = await fetchSettings(projectId);
        setForm(refreshed);
      } else {
        addToast(result.error || "Import failed", "error");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to import settings", "error");
    } finally {
      setImportLoading(false);
    }
  }, [addToast, importPreview, importScope, importMerge, projectId]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((m) => m !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const overlayDismissProps = useOverlayDismiss(onClose);

  /**
   * Lane status types:
   * - "overridden": Both provider and model keys are explicitly set in project scope
   * - "inherited": Provider/model keys are not set in project scope (fallback to global)
   */
  type LaneStatus = "overridden" | "inherited";

  /**
   * Model lane keys that can be overridden at the project level.
   * Each lane has global baseline keys and project override keys.
   */
  interface ModelLane {
    laneId: string;
    label: string;
    globalProviderKey: keyof GlobalSettings;
    globalModelKey: keyof GlobalSettings;
    projectProviderKey: keyof Settings;
    projectModelKey: keyof Settings;
    helperText: string;
    fallbackOrder: string;
  }

  /** All five model lanes with their global and project override keys */
  const MODEL_LANES: ModelLane[] = [
    {
      laneId: "default",
      label: "Default Model",
      globalProviderKey: "defaultProvider",
      globalModelKey: "defaultModelId",
      projectProviderKey: "defaultProviderOverride",
      projectModelKey: "defaultModelIdOverride",
      helperText: "Default AI model used for task execution when no per-task override is set.",
      fallbackOrder: "Project override → Global default lane → Automatic resolution",
    },
    {
      laneId: "execution",
      label: "Execution Model",
      globalProviderKey: "executionGlobalProvider",
      globalModelKey: "executionGlobalModelId",
      projectProviderKey: "executionProvider",
      projectModelKey: "executionModelId",
      helperText: "AI model used for task implementation (executor agent).",
      fallbackOrder: "Project override → Global execution lane → Global default lane → Automatic resolution",
    },
    {
      laneId: "planning",
      label: "Planning Model",
      globalProviderKey: "planningGlobalProvider",
      globalModelKey: "planningGlobalModelId",
      projectProviderKey: "planningProvider",
      projectModelKey: "planningModelId",
      helperText: "AI model used for task planning.",
      fallbackOrder: "Project override → Global planning lane → Global default lane → Automatic resolution",
    },
    {
      laneId: "validator",
      label: "Reviewer Model",
      globalProviderKey: "validatorGlobalProvider",
      globalModelKey: "validatorGlobalModelId",
      projectProviderKey: "validatorProvider",
      projectModelKey: "validatorModelId",
      helperText: "AI model used for code and specification review.",
      fallbackOrder: "Project override → Global reviewer lane → Global default lane → Automatic resolution",
    },
    {
      laneId: "summarization",
      label: "Title and Git Commit Message Summarization Model",
      globalProviderKey: "titleSummarizerGlobalProvider",
      globalModelKey: "titleSummarizerGlobalModelId",
      projectProviderKey: "titleSummarizerProvider",
      projectModelKey: "titleSummarizerModelId",
      helperText: "AI model used for auto-generating task titles and merge commit summaries.",
        fallbackOrder: "Project override → Global summarization lane → Project planning lane → Project default lane → Global default lane → Automatic resolution",
    },
  ];

  /**
   * Compute the status of a model lane from scoped project data.
   * Returns "overridden" when both project lane keys are explicitly set,
   * "inherited" when they are absent (fallback to global lane).
   */
  function getLaneStatus(lane: ModelLane): LaneStatus {
    if (!scopedSettings?.project) return "inherited";
    const provider = scopedSettings.project[lane.projectProviderKey as keyof Settings];
    const model = scopedSettings.project[lane.projectModelKey as keyof Settings];
    return provider !== undefined || model !== undefined ? "overridden" : "inherited";
  }

  /**
   * Compute the display value for a model lane dropdown.
   * Returns the provider/model pair when explicitly set, or empty string for inherited.
   */
  function getLaneValue(lane: ModelLane): string {
    const provider = form[lane.projectProviderKey as keyof Settings] as string | undefined;
    const model = form[lane.projectModelKey as keyof Settings] as string | undefined;
    if (provider && model) {
      return `${provider}/${model}`;
    }
    return "";
  }

  /**
   * Update a model lane's provider and model values in the form.
   */
  function updateLaneValue(lane: ModelLane, value: string): void {
    if (!value) {
      // Clearing the dropdown - check if this is an inherited lane
      const status = getLaneStatus(lane);
      if (status === "inherited") {
        // Don't write anything to form for inherited lanes
        return;
      }
      // For overridden lanes, setting to undefined clears the override (null-as-delete)
      setForm((f) => ({
        ...f,
        [lane.projectProviderKey]: undefined,
        [lane.projectModelKey]: undefined,
      }));
    } else {
      const slashIdx = value.indexOf("/");
      setForm((f) => ({
        ...f,
        [lane.projectProviderKey]: value.slice(0, slashIdx),
        [lane.projectModelKey]: value.slice(slashIdx + 1),
      }));
    }
  }

  /**
   * Reset a model lane back to inherited state (null-as-delete for project override).
   */
  function resetLaneValue(lane: ModelLane): void {
    const status = getLaneStatus(lane);
    if (status === "inherited") return; // Nothing to reset

    // Set to undefined to trigger null-as-delete on save
    setForm((f) => ({
      ...f,
      [lane.projectProviderKey]: undefined,
      [lane.projectModelKey]: undefined,
    }));
  }

  const openOverlapPathPicker = useCallback((index: number) => {
    setOverlapPathPickerIndex(index);
    setOverlapPathPickerPath(".");
  }, [setOverlapPathPickerPath]);

  const closeOverlapPathPicker = useCallback(() => {
    setOverlapPathPickerIndex(null);
  }, []);

  const selectOverlapIgnorePath = useCallback((path: string) => {
    if (overlapPathPickerIndex === null) return;

    setForm((f) => {
      const currentPaths = f.overlapIgnorePaths && f.overlapIgnorePaths.length > 0
        ? [...f.overlapIgnorePaths]
        : [""];
      currentPaths[overlapPathPickerIndex] = path;
      return { ...f, overlapIgnorePaths: currentPaths };
    });

    closeOverlapPathPicker();
  }, [overlapPathPickerIndex, closeOverlapPathPicker]);

  const handleSelectCurrentDirectoryForOverlapIgnore = useCallback(() => {
    if (overlapPathPickerCurrentPath === ".") {
      return;
    }

    const directoryPath = overlapPathPickerCurrentPath.endsWith("/")
      ? overlapPathPickerCurrentPath
      : `${overlapPathPickerCurrentPath}/`;

    selectOverlapIgnorePath(directoryPath);
  }, [overlapPathPickerCurrentPath, selectOverlapIgnorePath]);

  const handleOverlapPathPickerOverlayClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeOverlapPathPicker();
    }
  }, [closeOverlapPathPicker]);

  const openWorktreesDirPicker = useCallback(() => {
    setWorktreesDirPickerPath(".");
    setWorktreesDirPickerOpen(true);
  }, [setWorktreesDirPickerPath]);

  const closeWorktreesDirPicker = useCallback(() => {
    setWorktreesDirPickerOpen(false);
  }, []);

  const selectWorktreesDirFromPicker = useCallback((path: string) => {
    const normalizedPath = path.endsWith("/") ? path : `${path}/`;
    setForm((f) => ({ ...f, worktreesDir: normalizedPath }));
    closeWorktreesDirPicker();
  }, [closeWorktreesDirPicker]);

  const selectCurrentWorktreesDir = useCallback(() => {
    const normalizedPath = worktreesDirPickerCurrentPath === "."
      ? "./"
      : (worktreesDirPickerCurrentPath.endsWith("/") ? worktreesDirPickerCurrentPath : `${worktreesDirPickerCurrentPath}/`);
    setForm((f) => ({ ...f, worktreesDir: normalizedPath }));
    closeWorktreesDirPicker();
  }, [worktreesDirPickerCurrentPath, closeWorktreesDirPicker]);

  const handleWorktreesDirPickerOverlayClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeWorktreesDirPicker();
    }
  }, [closeWorktreesDirPicker]);

  const handleOverlapIgnorePathChange = useCallback((index: number, value: string) => {
    setForm((f) => {
      const currentPaths = f.overlapIgnorePaths && f.overlapIgnorePaths.length > 0
        ? [...f.overlapIgnorePaths]
        : [""];
      currentPaths[index] = value;
      return { ...f, overlapIgnorePaths: currentPaths };
    });
  }, []);

  const handleRemoveOverlapIgnorePath = useCallback((index: number) => {
    setForm((f) => {
      const currentPaths = f.overlapIgnorePaths && f.overlapIgnorePaths.length > 0
        ? [...f.overlapIgnorePaths]
        : [""];
      const nextPaths = currentPaths.filter((_, i) => i !== index);
      return { ...f, overlapIgnorePaths: nextPaths.length > 0 ? nextPaths : [] };
    });

    if (overlapPathPickerIndex === index) {
      closeOverlapPathPicker();
      return;
    }

    if (overlapPathPickerIndex !== null && overlapPathPickerIndex > index) {
      setOverlapPathPickerIndex(overlapPathPickerIndex - 1);
    }
  }, [overlapPathPickerIndex, closeOverlapPathPicker]);

  const handleAddOverlapIgnorePath = useCallback(() => {
    setForm((f) => {
      const currentPaths = f.overlapIgnorePaths && f.overlapIgnorePaths.length > 0
        ? f.overlapIgnorePaths
        : [""];
      return { ...f, overlapIgnorePaths: [...currentPaths, ""] };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (prefixError || presetDraft) return;

    const limits = form.researchSettings?.limits;
    if (limits?.maxConcurrentRuns !== undefined && (!Number.isFinite(limits.maxConcurrentRuns) || limits.maxConcurrentRuns < 1)) {
      setResearchLimitError("Research max concurrent runs must be at least 1.");
      return;
    }
    if (limits?.maxSourcesPerRun !== undefined && (!Number.isFinite(limits.maxSourcesPerRun) || limits.maxSourcesPerRun < 1)) {
      setResearchLimitError("Research max sources per run must be at least 1.");
      return;
    }
    if (limits?.maxDurationMs !== undefined && (!Number.isFinite(limits.maxDurationMs) || limits.maxDurationMs < 1000)) {
      setResearchLimitError("Research max duration must be at least 1000 ms.");
      return;
    }
    if (limits?.requestTimeoutMs !== undefined && (!Number.isFinite(limits.requestTimeoutMs) || limits.requestTimeoutMs < 1000)) {
      setResearchLimitError("Research request timeout must be at least 1000 ms.");
      return;
    }
    setResearchLimitError(null);

    try {
      const payload = {
        ...form,
        worktreeInitCommand: form.worktreeInitCommand?.trim() || undefined,
        worktreesDir: form.worktreesDir?.trim() || undefined,
        worktrunk: {
          enabled: worktrunkInstallVerified && form.worktrunk?.enabled === true,
          binaryPath: form.worktrunk?.binaryPath?.trim() || undefined,
          onFailure: form.worktrunk?.onFailure ?? "fail",
        },
        taskPrefix: form.taskPrefix?.trim() || undefined,
        githubTrackingDefaultRepo: form.githubTrackingDefaultRepo?.trim() || undefined,
        githubAuthToken: form.githubAuthToken?.trim() || undefined,
        overlapIgnorePaths: (form.overlapIgnorePaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0),
        experimentalFeatures: normalizeExperimentalFeaturesForSave(form.experimentalFeatures),
      };

      // Always save both global and project settings with strict scope separation.
      //
      // SCOPE RULES:
      // - Global lane keys (executionGlobalProvider, planningGlobalProvider, etc.)
      //   go to updateGlobalSettings
      // - Project override lane keys (executionProvider, planningProvider, etc.)
      //   go to updateSettings ONLY when explicitly changed from initial state
      // - Inherited project lanes (unset in project scope) are NOT written to project payload
      // - Resetting a project lane sends null to delete it from project scope

      const globalPatch: Partial<GlobalSettings> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === "githubTrackingDefaultRepo" && activeSection !== "global-general") {
          continue;
        }
        if (key === "persistAgentThinkingLog") {
          continue;
        }
        if (isGlobalSettingsKey(key)) {
          // Implement null-as-delete semantics for global settings:
          // - undefined values are dropped during JSON serialization
          // - To explicitly clear a field, send null instead
          // - We detect explicit clears by comparing with initial values:
          //   if current value is undefined AND initial was defined, use null
          const initialValue = initialValues?.[key as keyof GlobalSettings];
          if (value === undefined && initialValue !== undefined) {
            (globalPatch as Record<string, unknown>)[key] = null; // null means "explicitly clear"
          } else {
            (globalPatch as Record<string, unknown>)[key] = value;
          }
        }
      }

      // Project settings: Only include keys that were explicitly changed.
      // This prevents inherited effective values from being persisted as explicit overrides.
      const projectPatch: Partial<Settings> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === "githubTokenConfigured" || key === "prAuthAvailable") continue; // server-only fields
        if (key === "githubTrackingDefaultRepo" && activeSection === "global-general") continue;
        if (!isProjectSettingsKey(key)) continue;

        // Get the initial project-scoped value (null if not set)
        const initialProjectValue = initialScopedValues?.project?.[key as keyof Settings];

        // Check if this value is a model lane key that tracks inheritance
        const isModelLaneKey = [
          "planningProvider", "planningModelId",
          "validatorProvider", "validatorModelId",
          "executionProvider", "executionModelId",
          "titleSummarizerProvider", "titleSummarizerModelId",
          "defaultProviderOverride", "defaultModelIdOverride",
          "planningFallbackProvider", "planningFallbackModelId",
          "validatorFallbackProvider", "validatorFallbackModelId",
          "titleSummarizerFallbackProvider", "titleSummarizerFallbackModelId",
        ].includes(key);

        if (isModelLaneKey) {
          // For model lanes: only write if explicitly changed from initial project state
          if (value !== initialProjectValue) {
            // Detect explicit reset: current is undefined/null but initial was set
            if ((value === undefined || value === null) && initialProjectValue !== undefined && initialProjectValue !== null) {
              (projectPatch as Record<string, unknown>)[key] = null; // null-as-delete
            } else if (value !== undefined) {
              (projectPatch as Record<string, unknown>)[key] = value;
            }
          }
        } else {
          // For non-model settings: only write keys the user actually
          // changed, matching the model-lane gate above. Without this,
          // every effective/inherited value in `payload` would be
          // serialized as an explicit project override, silently breaking
          // inheritance for every project setting on every save.
          // Within the changed-set, apply null-as-delete so an explicit
          // clear (e.g. unpinning `integrationBranch` back to auto-detect)
          // survives `JSON.stringify` instead of being silently dropped.
          if (value !== initialProjectValue) {
            if (value === undefined && initialProjectValue !== undefined && initialProjectValue !== null) {
              (projectPatch as Record<string, unknown>)[key] = null;
            } else if (value !== undefined) {
              (projectPatch as Record<string, unknown>)[key] = value;
            }
          }
        }
      }

      // Save both scopes in parallel if they have changes.
      // Note: themeMode/colorTheme may also be write-through via useTheme callbacks
      // in the Appearance section; duplicate global writes are intentional/idempotent,
      // while this save path persists the full settings form in one action.
      await Promise.all([
        Object.keys(globalPatch).length > 0 ? updateGlobalSettings(globalPatch) : Promise.resolve(),
        Object.keys(projectPatch).length > 0 ? updateSettings(projectPatch, projectId) : Promise.resolve(),
        globalMaxConcurrent !== initialGlobalMaxConcurrentRef.current
          ? updateGlobalConcurrency({ globalMaxConcurrent: globalMaxConcurrent ?? 4 })
          : Promise.resolve(),
      ]);

      addToast("Settings saved", "success");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [form, globalMaxConcurrent, prefixError, presetDraft, initialValues, initialScopedValues, onClose, addToast, projectId, activeSection]);

  const handleSaveMemory = useCallback(async () => {
    try {
      await saveMemoryFile(selectedMemoryPath, memoryContent, projectId);
      setMemoryDirty(false);
      addToast("Memory saved", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to save memory", "error");
    }
  }, [selectedMemoryPath, memoryContent, projectId, addToast]);

  const handleCompactMemory = useCallback(async () => {
    setMemoryCompactLoading(true);
    try {
      const { path, content } = await compactMemory(selectedMemoryPath, projectId);
      const nextPath = path ?? selectedMemoryPath;
      if (selectedMemoryPath !== nextPath) {
        skipNextMemoryReloadRef.current = true;
      }
      setSelectedMemoryPath(nextPath);
      setMemoryContent(content);
      setMemoryDirty(false);

      const { files } = await fetchMemoryFiles(projectId);
      setMemoryFiles(files);

      addToast("Memory file compacted", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to compact memory", "error");
    } finally {
      setMemoryCompactLoading(false);
    }
  }, [selectedMemoryPath, projectId, addToast]);

  const handleTestMemoryRetrieval = useCallback(async () => {
    setMemoryTestLoading(true);
    setMemoryTestResult(null);
    try {
      const result = await testMemoryRetrieval(memoryTestQuery, projectId);
      setMemoryTestResult(result);
      addToast(
        result.qmdAvailable ? "Memory retrieval test complete" : "qmd is not installed; local fallback was used",
        result.qmdAvailable ? "success" : "warning",
      );
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to test memory retrieval", "error");
    } finally {
      setMemoryTestLoading(false);
    }
  }, [memoryTestQuery, projectId, addToast]);

  const handleDreamNow = useCallback(async () => {
    setDreamRunning(true);
    try {
      await triggerMemoryDreams(projectId);
      addToast("Dream processing completed", "success");
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to run dream processing", "error");
    } finally {
      setDreamRunning(false);
    }
  }, [projectId, addToast]);

  const handleInstallQmd = useCallback(async () => {
    setQmdInstallLoading(true);
    try {
      const result = await installQmd(projectId);
      await refreshMemoryBackend();
      addToast(
        result.qmdAvailable ? "qmd installed successfully" : "qmd install finished, but qmd is still unavailable",
        result.qmdAvailable ? "success" : "warning",
      );
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to install qmd", "error");
    } finally {
      setQmdInstallLoading(false);
    }
  }, [projectId, refreshMemoryBackend, addToast]);

  const savePresetDraft = () => {
    if (!presetDraft) return;

    const nextName = presetDraft.name.trim();
    if (!nextName) {
      addToast("Preset name is required", "error");
      return;
    }

    const presets = form.modelPresets || [];

    // For new presets, generate unique ID from name; for edits, keep existing ID
    let nextId: string;
    if (editingPresetId) {
      nextId = editingPresetId;
    } else {
      nextId = generateUniquePresetId(nextName, presets);
    }

    const normalizedDraft: ModelPreset = {
      id: nextId,
      name: nextName,
      executorProvider: presetDraft.executorProvider,
      executorModelId: presetDraft.executorModelId,
      validatorProvider: presetDraft.validatorProvider,
      validatorModelId: presetDraft.validatorModelId,
    };

    setForm((current) => {
      const existing = current.modelPresets || [];
      const nextPresets = editingPresetId
        ? existing.map((preset) => (preset.id === editingPresetId ? normalizedDraft : preset))
        : [...existing, normalizedDraft];
      return { ...current, modelPresets: nextPresets };
    });

    setEditingPresetId(null);
    setPresetDraft(null);
  };

  const runRemoteAction = useCallback(async (label: string, action: () => Promise<void>) => {
    setRemoteBusyAction(label);
    try {
      await action();
      await loadRemoteData();
    } catch (err) {
      addToast(getErrorMessage(err) || `Failed to ${label}`, "error");
    } finally {
      setRemoteBusyAction(null);
    }
  }, [addToast, loadRemoteData]);

  const cloudflaredManualInstallCommand = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")) {
      return "winget install Cloudflare.cloudflared";
    }

    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isMac = /(Mac|iPhone|iPad|iPod)/i.test(platform);
    const isArm = /(arm64|aarch64)/i.test(`${platform} ${userAgent}`);

    if (isMac) {
      return "brew install cloudflared";
    }

    const linuxArch = isArm ? "arm64" : "amd64";
    return `curl -L --output /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${linuxArch} && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared # If sudo is unavailable, use: mkdir -p ~/.local/bin && mv /tmp/cloudflared ~/.local/bin/cloudflared`;
  }, []);

  const cloudflaredMacFallbackCommand = useCallback(() => {
    if (typeof navigator === "undefined") {
      return null;
    }
    if (!/(Mac|iPhone|iPad|iPod)/i.test(navigator.platform)) {
      return null;
    }

    const arch = /(arm64|aarch64)/i.test(`${navigator.platform} ${navigator.userAgent}`) ? "arm64" : "amd64";
    return `curl -L --output /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch} && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared`;
  }, []);

  const handleInstallCloudflared = useCallback(async () => {
    setCloudflaredInstalling(true);
    setCloudflaredInstallError(null);
    try {
      const result = await installCloudflared(projectId);
      if (!result.success) {
        setCloudflaredInstallError(result.error ?? "Installation failed");
        return;
      }
      const status = await fetchRemoteStatus(projectId);
      setRemoteStatus(status);
      addToast("cloudflared installed successfully", "success");
    } catch (err) {
      setCloudflaredInstallError(err instanceof Error ? err.message : "Installation failed");
    } finally {
      setCloudflaredInstalling(false);
    }
  }, [addToast, projectId]);

  /** Render a scope indicator banner for the current section with theme-aware Lucide icons */
  const renderScopeBanner = () => {
    if (activeSectionScope === "global") {
      return (
        <div className="settings-scope-banner settings-scope-global">
          <span className="settings-scope-icon"><Globe size={14} /></span>
          <span>These settings are shared across all your Fusion projects.</span>
        </div>
      );
    }
    if (activeSectionScope === "project") {
      return (
        <div className="settings-scope-banner settings-scope-project">
          <span className="settings-scope-icon"><Folder size={14} /></span>
          <span>These settings only affect this project.</span>
        </div>
      );
    }
    return null;
  };

  const renderSectionFields = () => {
    switch (activeSection) {
      case "general":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">General</h4>
            <div className="form-group">
              <label htmlFor="taskPrefix">Task Prefix</label>
              <input
                id="taskPrefix"
                type="text"
                placeholder="FN"
                value={form.taskPrefix || ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, taskPrefix: val || undefined }));
                  if (val && !/^[A-Z]{1,10}$/.test(val)) {
                    setPrefixError("Prefix must be 1–10 uppercase letters");
                  } else {
                    setPrefixError(null);
                  }
                }}
              />
              {prefixError && <small className="field-error">{prefixError}</small>}
              {!prefixError && <small>Prefix for new task IDs (e.g. KB, PROJ)</small>}
            </div>
            <div className="form-group">
              <label htmlFor="requirePlanApproval" className="checkbox-label">
                <input
                  id="requirePlanApproval"
                  type="checkbox"
                  checked={form.requirePlanApproval || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, requirePlanApproval: e.target.checked }))
                  }
                />
                Require plan approval
              </label>
              <small>When enabled, AI-generated task specifications require manual approval before moving to Todo</small>
            </div>
            <div className="form-group">
              <label htmlFor="ephemeralAgentsEnabled" className="checkbox-label">
                <input
                  id="ephemeralAgentsEnabled"
                  type="checkbox"
                  checked={form.ephemeralAgentsEnabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, ephemeralAgentsEnabled: e.target.checked }))
                  }
                />
                Use ephemeral task-worker agents
              </label>
              <small>
                When enabled (default), Fusion spawns short-lived <code>executor-FN-XXXX</code> agents to run each task. When disabled, only permanent agents execute tasks and the scheduler auto-assigns work using the agent reporting chain. Tasks with no eligible permanent agent stay queued.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="completionDocumentationMode">Completion Documentation Automation</label>
              <select
                id="completionDocumentationMode"
                value={form.completionDocumentationMode || "off"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    completionDocumentationMode: e.target.value as "off" | "changeset" | "changelog",
                  }))
                }
              >
                <option value="off">Off</option>
                <option value="changeset">Require changeset (.changeset/*.md)</option>
                <option value="changelog">Require changelog update (existing changelog)</option>
              </select>
              <small>
                Controls how future task specs handle release-note artifacts at completion. Use changeset mode for repositories that follow
                <code>.changeset</code> workflows, or changelog mode when contributors should update an existing changelog file.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="showQuickChatFAB" className="checkbox-label">
                <input
                  id="showQuickChatFAB"
                  type="checkbox"
                  checked={form.showQuickChatFAB === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, showQuickChatFAB: e.target.checked }))
                  }
                />
                Show quick chat button
              </label>
              <small>Show the floating chat button in the dashboard. Chat is still accessible from the Chat tab in the mobile navigation.</small>
            </div>
            <h4 className="settings-section-heading settings-section-heading--spaced">Chat history</h4>
            <div className="form-group">
              <label htmlFor="chatAutoCleanupDays">Auto-cleanup old chats</label>
              <select
                id="chatAutoCleanupDays"
                className="select"
                value={form.chatAutoCleanupDays ?? 0}
                onChange={(e) =>
                  setForm((f) => ({ ...f, chatAutoCleanupDays: Number(e.target.value) || 0 }))
                }
              >
                <option value={0}>Off</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
              <small>Delete chat sessions and rooms that have been idle for this many days. Default: Off.</small>
            </div>
            <div className="form-group">
              <label htmlFor="mailAutoCleanupDays">Auto-prune old mail</label>
              <select
                id="mailAutoCleanupDays"
                className="select"
                value={form.mailAutoCleanupDays ?? 0}
                onChange={(e) =>
                  setForm((f) => ({ ...f, mailAutoCleanupDays: Number(e.target.value) || 0 }))
                }
              >
                <option value={0}>Off</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
              <small>Delete inbox/outbox messages older than this many days. Default: Off. 7 days is the suggested setting.</small>
            </div>
            <h4 className="settings-section-heading settings-section-heading--spaced">Chat Rooms</h4>
            <div className="form-group">
              <label htmlFor="chatRoomRecentVerbatimMessages">Recent verbatim room messages</label>
              <input
                id="chatRoomRecentVerbatimMessages"
                type="number"
                min="1"
                className="input"
                placeholder="25"
                value={form.chatRoomRecentVerbatimMessages ?? ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, chatRoomRecentVerbatimMessages: Number(e.target.value) || undefined }))
                }
              />
              <small>Number of most-recent chat-room messages kept verbatim in the responder transcript. Older messages are compacted into a summary block. Default: 25.</small>
            </div>
            <div className="form-group">
              <label htmlFor="chatRoomCompactionFetchLimit">Room compaction fetch limit</label>
              <input
                id="chatRoomCompactionFetchLimit"
                type="number"
                min="1"
                className="input"
                placeholder="200"
                value={form.chatRoomCompactionFetchLimit ?? ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, chatRoomCompactionFetchLimit: Number(e.target.value) || undefined }))
                }
              />
              <small>Upper bound on messages fetched from the room store for compaction consideration. Default: 200.</small>
            </div>
            <div className="form-group">
              <label htmlFor="chatRoomSummaryMaxChars">Room summary max characters</label>
              <input
                id="chatRoomSummaryMaxChars"
                type="number"
                min="200"
                className="input"
                placeholder="3000"
                value={form.chatRoomSummaryMaxChars ?? ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, chatRoomSummaryMaxChars: Number(e.target.value) || undefined }))
                }
              />
              <small>Hard cap on the synthesized "Earlier room context" summary block. Default: 3000.</small>
            </div>
            <h4 className="settings-section-heading settings-section-heading--spaced">Capacity Risk Banner</h4>
            <div className="form-group">
              <label htmlFor="capacityRiskBannerEnabled" className="checkbox-label">
                <input
                  id="capacityRiskBannerEnabled"
                  type="checkbox"
                  checked={form.capacityRiskBannerEnabled === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, capacityRiskBannerEnabled: e.target.checked }))
                  }
                />
                Show capacity risk banner
              </label>
              <small>Warn on the board when todo work exceeds the threshold and no idle agents are available.</small>
            </div>
            <div className="form-group">
              <label htmlFor="capacityRiskTodoThresholdGeneral">Todo threshold</label>
              <input
                id="capacityRiskTodoThresholdGeneral"
                type="number"
                min={0}
                className="input"
                value={form.capacityRiskTodoThreshold ?? 20}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    capacityRiskTodoThreshold:
                      e.target.value === ""
                        ? 0
                        : Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                  }))
                }
              />
              <small>Banner fires when todo count is strictly greater than this value (default 20). Applies when the banner is enabled.</small>
            </div>
            <h4 className="settings-section-heading settings-section-heading--spaced">GitHub Tracking</h4>
            <div className="form-group">
              <label htmlFor="githubTrackingMode">Default tracking mode for new tasks</label>
              <select
                id="githubTrackingMode"
                className="select"
                value={form.githubTrackingEnabledByDefault ? "new-tasks" : "off"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    githubTrackingEnabledByDefault: e.target.value === "new-tasks",
                  }))
                }
              >
                <option value="off">Off (default)</option>
                <option value="new-tasks">On for new tasks</option>
              </select>
              <small>
                Controls whether newly created tasks have GitHub issue tracking enabled by default. Individual tasks can still override this from the task detail modal.
              </small>
              <small>
                Tracking issues use this task&apos;s title. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models.
                {!form.autoSummarizeTitles && !form.useAiMergeCommitSummary && !form.githubTrackingEnabledByDefault
                  ? " Enable summarization in Project Models to configure that model."
                  : ""}
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="projectGithubTrackingDefaultRepoGeneral">Project default tracking repo</label>
              <TrackingRepoSelect
                id="projectGithubTrackingDefaultRepoGeneral"
                ariaLabel="Project default tracking repo"
                value={form.githubTrackingDefaultRepo ?? ""}
                options={projectTrackingRepoOptions}
                loading={projectTrackingRepoLoading}
                error={projectTrackingRepoError ?? undefined}
                placeholder="owner/repo"
                onChange={(nextValue) =>
                  setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))
                }
              />
              <small>Default repo used when creating GitHub issues for tracked tasks. Falls back to the global default if blank.</small>
            </div>
            <div className="form-group">
              <label htmlFor="githubTrackingDedupEnabled" className="checkbox-label">
                <input
                  id="githubTrackingDedupEnabled"
                  type="checkbox"
                  checked={form.githubTrackingDedupEnabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, githubTrackingDedupEnabled: e.target.checked }))
                  }
                />
                Search the tracking repo for likely duplicates before opening a new issue
              </label>
              <small>
                When enabled, Fusion checks open and closed issues in the target repo for likely duplicates (using File Scope paths and key symptoms) before creating a new tracking issue. Uncheck to always create a new issue.
              </small>
            </div>
          </>
        );
      case "global-general":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">General</h4>
            <div className="form-group">
              <label htmlFor="showGitHubStarButton" className="checkbox-label">
                <input
                  id="showGitHubStarButton"
                  type="checkbox"
                  checked={form.showGitHubStarButton !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, showGitHubStarButton: e.target.checked }))
                  }
                />
                Show &quot;Star on GitHub&quot; button in Settings header
              </label>
              <small>
                Once you click the Star button it&apos;s hidden automatically. Uncheck this to keep
                it hidden even before clicking.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="globalGithubTrackingDefaultRepo">Global default tracking repo</label>
              <TrackingRepoSelect
                id="globalGithubTrackingDefaultRepo"
                ariaLabel="Global default tracking repo"
                value={form.githubTrackingDefaultRepo ?? ""}
                options={globalTrackingRepoOptions}
                loading={globalTrackingRepoLoading}
                error={globalTrackingRepoError ?? undefined}
                placeholder="owner/repo"
                onChange={(nextValue) =>
                  setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))
                }
              />
              <small>Projects inherit this value when they do not set a project default tracking repo.</small>
            </div>
            <CliBinaryPanel />
            <div className="form-group">
              <label htmlFor="persistAgentToolOutput" className="checkbox-label">
                <input
                  id="persistAgentToolOutput"
                  type="checkbox"
                  checked={form.persistAgentToolOutput !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, persistAgentToolOutput: e.target.checked }))
                  }
                />
                Save tool output in agent logs
              </label>
              <small>
                When disabled, tool rows are still logged but detailed tool payloads are omitted.
                Very large tool payloads may still be clipped even when this stays enabled.
              </small>
            </div>
            <div className="form-group">
              <h5 className="settings-section-heading">Save AI thinking logs</h5>
              <label htmlFor="persistAgentThinkingLogPermanent" className="checkbox-label">
                <input
                  id="persistAgentThinkingLogPermanent"
                  type="checkbox"
                  checked={resolvePersistAgentThinkingLog(form, { ephemeral: false })}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, persistAgentThinkingLogPermanent: e.target.checked }))
                  }
                />
                Save AI thinking for permanent agents
              </label>
              <label htmlFor="persistAgentThinkingLogEphemeral" className="checkbox-label">
                <input
                  id="persistAgentThinkingLogEphemeral"
                  type="checkbox"
                  checked={resolvePersistAgentThinkingLog(form, { ephemeral: true })}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, persistAgentThinkingLogEphemeral: e.target.checked }))
                  }
                />
                Save AI thinking for ephemeral / task-worker agents
              </label>
              <small>
                Leave both thinking toggles off to keep the original default behavior.
                This only controls persisted <code>thinking</code> rows and does not affect assistant text or tool rows.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="fnBinaryCheckEnabled" className="checkbox-label">
                <input
                  id="fnBinaryCheckEnabled"
                  type="checkbox"
                  checked={form.fnBinaryCheckEnabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, fnBinaryCheckEnabled: e.target.checked }))
                  }
                />
                Check for the <code>fn</code> CLI binary on PATH
              </label>
              <small>
                When enabled, the dashboard probes for a globally-installed{" "}
                <code>fn</code> / <code>fusion</code> CLI by spawning{" "}
                <code>&lt;bin&gt; --version</code>. Disable this if your local
                dev process is the source of truth and you don&apos;t want any
                outdated globally-installed binary executed during the probe.
              </small>
            </div>
            <h4 className="settings-section-heading settings-section-heading--spaced">Updates</h4>
            <div className="form-group">
              <label htmlFor="updateCheckEnabled" className="checkbox-label">
                <input
                  id="updateCheckEnabled"
                  type="checkbox"
                  checked={form.updateCheckEnabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, updateCheckEnabled: e.target.checked }))
                  }
                />
                Check for updates automatically
              </label>
              <small>
                When enabled, Fusion checks npm for new versions of{" "}
                <code>@runfusion/fusion</code> and shows update notices in the CLI and dashboard.
                Cadence is governed by the frequency below.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="updateCheckFrequency">Frequency</label>
              <select
                id="updateCheckFrequency"
                value={form.updateCheckFrequency ?? "daily"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    updateCheckFrequency: e.target.value as
                      | "manual"
                      | "on-startup"
                      | "daily"
                      | "weekly",
                  }))
                }
                disabled={form.updateCheckEnabled === false}
              >
                <option value="manual">Manual only — never auto-check</option>
                <option value="on-startup">On startup — once per server launch</option>
                <option value="daily">Daily (recommended)</option>
                <option value="weekly">Weekly</option>
              </select>
              <small>
                Controls how often the dashboard re-fetches the npm registry.
                Use the version + refresh control in the header to trigger an
                immediate check at any time.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="autoReloadOnVersionChange" className="checkbox-label">
                <input
                  id="autoReloadOnVersionChange"
                  type="checkbox"
                  checked={form.autoReloadOnVersionChange !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, autoReloadOnVersionChange: e.target.checked }))
                  }
                />
                Auto-reload dashboard on version change
              </label>
              <small>
                When enabled (default), the dashboard automatically reloads when it
                detects a new build version — either from server rebuilds or service
                worker updates. Disable this to stay on the current version until you
                manually refresh.
              </small>
            </div>
          </>
        );
      case "global-models": {
        const selectedValue = form.defaultProvider && form.defaultModelId
          ? `${form.defaultProvider}/${form.defaultModelId}`
          : "";
        const globalModelLanes = MODEL_LANES.filter(
          (lane) => lane.laneId !== "default",
        );

        return (
          <>
            {renderScopeBanner()}

            {/* --- Default Model --- */}
            <h4 className="settings-section-heading">Default Model</h4>
            {modelsLoading ? (
              <div className="settings-empty-state">Loading available models…</div>
            ) : availableModels.length === 0 ? (
              <div className="settings-empty-state settings-muted">
                No models available. Configure authentication first.
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="defaultModel">Default Model</label>
                  <CustomModelDropdown
                    id="defaultModel"
                    label="Default Model"
                    models={availableModels}
                    value={selectedValue}
                    onChange={(val) => {
                      if (!val) {
                        setForm((f) => ({ ...f, defaultProvider: undefined, defaultModelId: undefined }));
                      } else {
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          defaultProvider: val.slice(0, slashIdx),
                          defaultModelId: val.slice(slashIdx + 1),
                        }));
                      }
                    }}
                    placeholder="Use default"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  <small>Default AI model used for task execution when no per-task override is set. &quot;Use default&quot; lets the engine choose automatically.</small>
                </div>

                <div className="form-group">
                  <label htmlFor="fallbackModel">Fallback Model</label>
                  <CustomModelDropdown
                    id="fallbackModel"
                    label="Fallback Model"
                    models={availableModels}
                    value={form.fallbackProvider && form.fallbackModelId ? `${form.fallbackProvider}/${form.fallbackModelId}` : ""}
                    onChange={(val) => {
                      if (!val) {
                        setForm((f) => ({ ...f, fallbackProvider: undefined, fallbackModelId: undefined }));
                      } else {
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          fallbackProvider: val.slice(0, slashIdx),
                          fallbackModelId: val.slice(slashIdx + 1),
                        }));
                      }
                    }}
                    placeholder="No fallback"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  <small>Used automatically if the primary default model hits a retryable provider error like rate limiting or overload.</small>
                </div>
              </>
            )}
            {(() => {
              const selectedModel = availableModels.find(
                (m) => m.provider === form.defaultProvider && m.id === form.defaultModelId,
              );
              if (selectedModel && !selectedModel.reasoning) return null;
              return (
                <div className="form-group">
                  <label htmlFor="defaultThinkingLevel">Thinking Effort</label>
                  <select
                    id="defaultThinkingLevel"
                    value={form.defaultThinkingLevel || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((f) => ({ ...f, defaultThinkingLevel: (val as ThinkingLevel) || undefined }));
                    }}
                  >
                    <option value="">Default</option>
                    {THINKING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </option>
                    ))}
                  </select>
                  <small>Controls how much reasoning effort the AI model uses. Higher levels produce better results but cost more.</small>
                </div>
              );
            })()}

            {availableModels.length > 0 && (
              <>
                <h4 className="settings-section-heading settings-section-heading--spaced">Model Lanes</h4>
                <p className="settings-description">
                  Global baseline models for each AI role. Project settings can override these per-project.
                </p>
                {globalModelLanes.map((lane) => {
                  const provider = form[lane.globalProviderKey as keyof Settings] as string | undefined;
                  const model = form[lane.globalModelKey as keyof Settings] as string | undefined;
                  const value = provider && model ? `${provider}/${model}` : "";

                  return (
                    <div className="form-group" key={`global-${lane.laneId}`}>
                      <label htmlFor={`global-${lane.laneId}-model`}>{lane.label}</label>
                      <CustomModelDropdown
                        id={`global-${lane.laneId}-model`}
                        label={lane.label}
                        models={availableModels}
                        value={value}
                        onChange={(selected) => {
                          if (!selected) {
                            setForm((f) => ({
                              ...f,
                              [lane.globalProviderKey]: undefined,
                              [lane.globalModelKey]: undefined,
                            }));
                            return;
                          }

                          const slashIdx = selected.indexOf("/");
                          setForm((f) => ({
                            ...f,
                            [lane.globalProviderKey]: selected.slice(0, slashIdx),
                            [lane.globalModelKey]: selected.slice(slashIdx + 1),
                          }));
                        }}
                        placeholder="Use default"
                        favoriteProviders={favoriteProviders}
                        onToggleFavorite={handleToggleFavorite}
                        favoriteModels={favoriteModels}
                        onToggleModelFavorite={handleToggleModelFavorite}
                      />
                      <small>{lane.helperText}</small>
                    </div>
                  );
                })}
              </>
            )}

            {/* --- Startup Model Sync --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">Startup Model Sync</h4>
            <div className="form-group">
              <label htmlFor="openrouterModelSync" className="checkbox-label">
                <input
                  id="openrouterModelSync"
                  type="checkbox"
                  checked={form.openrouterModelSync !== false}
                  onChange={(e) => setForm((f) => ({ ...f, openrouterModelSync: e.target.checked }))}
                />
                Sync OpenRouter model list at startup
              </label>
              <small>
                When enabled, startup fetches the latest available models from the OpenRouter API so
                model pickers always include the newest catalog.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="opencodeGoModelSync" className="checkbox-label">
                <input
                  id="opencodeGoModelSync"
                  type="checkbox"
                  checked={form.opencodeGoModelSync !== false}
                  onChange={(e) => setForm((f) => ({ ...f, opencodeGoModelSync: e.target.checked }))}
                />
                Sync opencode-go model list at startup
              </label>
              <small>
                When enabled, startup refreshes models through the local <code>opencode models opencode --refresh</code>
                flow and publishes them under the opencode-go provider in model pickers.
              </small>
            </div>
            <details>
              <summary>OpenRouter advanced</summary>
              <div className="form-group">
                <label htmlFor="openrouterAppAttributionReferer">OpenRouter HTTP-Referer</label>
                <input
                  id="openrouterAppAttributionReferer"
                  className="input"
                  placeholder="https://runfusion.ai"
                  value={form.openrouterAppAttribution?.referer ?? ""}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    openrouterAppAttribution: {
                      ...(f.openrouterAppAttribution || {}),
                      referer: e.target.value,
                    },
                  }))}
                />
                <small>Leave empty to omit this header. Default: https://runfusion.ai.</small>
              </div>
              <div className="form-group">
                <label htmlFor="openrouterAppAttributionTitle">OpenRouter X-Title</label>
                <input
                  id="openrouterAppAttributionTitle"
                  className="input"
                  placeholder="Fusion"
                  value={form.openrouterAppAttribution?.title ?? ""}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    openrouterAppAttribution: {
                      ...(f.openrouterAppAttribution || {}),
                      title: e.target.value,
                    },
                  }))}
                />
                <small>Leave empty to omit this header. Default: Fusion.</small>
              </div>
              <div className="form-group">
                <label htmlFor="openrouterModelFiltersSupportedParameters">OpenRouter supported_parameters filter</label>
                <input
                  id="openrouterModelFiltersSupportedParameters"
                  className="input"
                  placeholder="tools, structured_outputs"
                  value={toCommaSeparatedInput(form.openrouterModelFilters?.supported_parameters)}
                  onChange={(e) => {
                    const parsed = fromCommaSeparatedInput(e.target.value);
                    setForm((f) => ({
                      ...f,
                      openrouterModelFilters: {
                        ...(f.openrouterModelFilters || {}),
                        supported_parameters: parsed.length > 0 ? parsed : undefined,
                      },
                    }));
                  }}
                />
                <small>Comma-separated values sent to OpenRouter model sync.</small>
              </div>
              <div className="form-group">
                <label htmlFor="openrouterModelFiltersOutputModalities">OpenRouter output_modalities filter</label>
                <input
                  id="openrouterModelFiltersOutputModalities"
                  className="input"
                  placeholder="text"
                  value={toCommaSeparatedInput(form.openrouterModelFilters?.output_modalities)}
                  onChange={(e) => {
                    const parsed = fromCommaSeparatedInput(e.target.value);
                    setForm((f) => ({
                      ...f,
                      openrouterModelFilters: {
                        ...(f.openrouterModelFilters || {}),
                        output_modalities: parsed.length > 0 ? parsed : undefined,
                      },
                    }));
                  }}
                />
                <small>Comma-separated values sent to OpenRouter model sync.</small>
              </div>
              <div className="form-group">
                <label htmlFor="openrouterProviderPreferencesOrder">OpenRouter routing order</label>
                <input
                  id="openrouterProviderPreferencesOrder"
                  className="input"
                  placeholder="openai, anthropic"
                  value={toCommaSeparatedInput(form.openrouterProviderPreferences?.order)}
                  onChange={(e) => {
                    const parsed = fromCommaSeparatedInput(e.target.value);
                    setForm((f) => ({
                      ...f,
                      openrouterProviderPreferences: {
                        ...(f.openrouterProviderPreferences || {}),
                        order: parsed.length > 0 ? parsed : undefined,
                      },
                    }));
                  }}
                />
              </div>
              <div className="form-group">
                <label htmlFor="openrouterProviderPreferencesIgnore">OpenRouter routing ignore</label>
                <input
                  id="openrouterProviderPreferencesIgnore"
                  className="input"
                  placeholder="provider-name"
                  value={toCommaSeparatedInput(form.openrouterProviderPreferences?.ignore)}
                  onChange={(e) => {
                    const parsed = fromCommaSeparatedInput(e.target.value);
                    setForm((f) => ({
                      ...f,
                      openrouterProviderPreferences: {
                        ...(f.openrouterProviderPreferences || {}),
                        ignore: parsed.length > 0 ? parsed : undefined,
                      },
                    }));
                  }}
                />
              </div>
              <div className="form-group">
                <label htmlFor="openrouterProviderPreferencesOnly">OpenRouter routing only</label>
                <input
                  id="openrouterProviderPreferencesOnly"
                  className="input"
                  placeholder="provider-name"
                  value={toCommaSeparatedInput(form.openrouterProviderPreferences?.only)}
                  onChange={(e) => {
                    const parsed = fromCommaSeparatedInput(e.target.value);
                    setForm((f) => ({
                      ...f,
                      openrouterProviderPreferences: {
                        ...(f.openrouterProviderPreferences || {}),
                        only: parsed.length > 0 ? parsed : undefined,
                      },
                    }));
                  }}
                />
              </div>
              <div className="form-group">
                <label htmlFor="openrouterProviderPreferencesAllowFallbacks">OpenRouter allow fallbacks</label>
                <select
                  id="openrouterProviderPreferencesAllowFallbacks"
                  className="select"
                  value={form.openrouterProviderPreferences?.allow_fallbacks === undefined ? "default" : form.openrouterProviderPreferences.allow_fallbacks ? "allow" : "deny"}
                  onChange={(e) => {
                    const value = e.target.value;
                    setForm((f) => ({
                      ...f,
                      openrouterProviderPreferences: {
                        ...(f.openrouterProviderPreferences || {}),
                        allow_fallbacks: value === "default" ? undefined : value === "allow",
                      },
                    }));
                  }}
                >
                  <option value="default">default</option>
                  <option value="allow">allow</option>
                  <option value="deny">deny</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="openrouterProviderPreferencesSort">OpenRouter routing sort</label>
                <select
                  id="openrouterProviderPreferencesSort"
                  className="select"
                  value={form.openrouterProviderPreferences?.sort ?? "default"}
                  onChange={(e) => {
                    const value = e.target.value;
                    setForm((f) => ({
                      ...f,
                      openrouterProviderPreferences: {
                        ...(f.openrouterProviderPreferences || {}),
                        sort: value === "default" ? undefined : value as "price" | "throughput" | "latency",
                      },
                    }));
                  }}
                >
                  <option value="default">default</option>
                  <option value="price">price</option>
                  <option value="throughput">throughput</option>
                  <option value="latency">latency</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="openrouterProviderPreferencesRequireParameters" className="checkbox-label">
                  <input
                    id="openrouterProviderPreferencesRequireParameters"
                    type="checkbox"
                    checked={form.openrouterProviderPreferences?.require_parameters === true}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      openrouterProviderPreferences: {
                        ...(f.openrouterProviderPreferences || {}),
                        require_parameters: e.target.checked,
                      },
                    }))}
                  />
                  Require parameters
                </label>
              </div>
            </details>

          </>
        );
      }

      case "project-models": {
        const presets = form.modelPresets || [];
        const presetOptions = presets.map((preset) => ({ id: preset.id, name: preset.name }));
        const inUsePresetIds = new Set(Object.values(form.defaultPresetBySize || {}).filter(Boolean));

        // Filter model lanes to show in project scope.
        // The "summarization" lane is intentionally excluded here — it has a
        // dedicated picker further down ("AI Title and Git Commit Message
        // Summarization") so the project tab doesn't surface the same model
        // setting twice.
        const projectModelLanes = MODEL_LANES.filter(
          (lane) =>
            lane.laneId === "default"
            || lane.laneId === "execution"
            || lane.laneId === "planning"
            || lane.laneId === "validator",
        );
        const resolvedPlanningModel = resolvePlanningSettingsModel(form);
        const resolvedDefaultModel = resolveProjectDefaultModel(form);
        const resolvedTitleSummarizerModel = resolveTitleSummarizerSettingsModel(form);
        const getProjectLaneLabel = (lane: ModelLane) => lane.laneId === "default" ? "Project Default Model" : lane.label;
        const getProjectLaneHelperText = (lane: ModelLane) =>
          lane.laneId === "default"
            ? "Project-wide default AI model used when no more specific task or project lane override is set."
            : lane.helperText;

        return (
          <>
            {renderScopeBanner()}

            {/* --- Token Cap --- */}
            <h4 className="settings-section-heading">Token Cap</h4>
            <div className="form-group">
              <label htmlFor="tokenCap">Token Cap</label>
              <div className="settings-token-cap-row">
                <input
                  id="tokenCap"
                  type="number"
                  placeholder="No cap"
                  value={form.tokenCap ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setForm((f) => ({ ...f, tokenCap: val ? parseInt(val, 10) : null } as SettingsFormState));
                  }}
                />
                {form.tokenCap != null && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title="Reset to default (no cap)"
                    onClick={() => setForm((f) => ({ ...f, tokenCap: null } as unknown as SettingsFormState))}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Reset
                  </button>
                )}
              </div>
              <small>Automatically compact context when approaching this token count. Leave empty for no cap (compact only on overflow errors). Set a number to proactively compact when reaching this token count.</small>
            </div>

            {/* --- Project Model Lanes --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">Model Lanes</h4>
            <p className="settings-description">
              Override global model settings at the project level. Each lane controls a specific AI usage context.
              Unset lanes inherit from the corresponding global lane.
              The Project Default Model is the fallback for this project when a more specific lane is unset.
            </p>
            {modelsLoading ? (
              <div className="settings-empty-state">Loading available models…</div>
            ) : availableModels.length === 0 ? (
              <div className="settings-empty-state settings-muted">
                No models available. Configure authentication first.
              </div>
            ) : (
              <>
                {projectModelLanes.map((lane) => {
                  const status = getLaneStatus(lane);
                  const value = getLaneValue(lane);
                  const isOverridden = status === "overridden";
                  const laneLabel = getProjectLaneLabel(lane);

                  return (
                    <div className="form-group" key={lane.laneId}>
                      <div className="settings-model-lane-label-row">
                        <label htmlFor={`${lane.laneId}Model`}>{laneLabel}</label>
                        <span
                          className={`settings-lane-badge ${isOverridden ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`}
                          title={isOverridden ? "Explicitly set for this project" : "Inherited from global settings"}
                        >
                          {isOverridden ? "Override (Project)" : "Inherited (Global)"}
                        </span>
                      </div>
                      <div className="settings-model-lane-control-row">
                        <div className="settings-model-lane-control-main">
                          <CustomModelDropdown
                            id={`${lane.laneId}Model`}
                            label={laneLabel}
                            models={availableModels}
                            value={value}
                            onChange={(val) => updateLaneValue(lane, val)}
                            placeholder={lane.laneId === "default" ? "Use global default" : "Use global"}
                            favoriteProviders={favoriteProviders}
                            onToggleFavorite={handleToggleFavorite}
                            favoriteModels={favoriteModels}
                            onToggleModelFavorite={handleToggleModelFavorite}
                          />
                        </div>
                        {isOverridden && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            title="Reset to inherit from global"
                            onClick={() => resetLaneValue(lane)}
                            style={{ whiteSpace: "nowrap" }}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <small>
                        {getProjectLaneHelperText(lane)} Falls back to: {lane.fallbackOrder}.
                      </small>
                    </div>
                  );
                })}
              </>
            )}

            {/* --- Fallback Models --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">Fallback Models</h4>
            {modelsLoading ? (
              <div className="settings-empty-state">Loading available models…</div>
            ) : availableModels.length === 0 ? (
              <div className="settings-empty-state settings-muted">
                No models available.
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="planningFallbackModel">Planning Fallback Model</label>
                  <CustomModelDropdown
                    id="planningFallbackModel"
                    label="Planning Fallback Model"
                    models={availableModels}
                    value={form.planningFallbackProvider && form.planningFallbackModelId ? `${form.planningFallbackProvider}/${form.planningFallbackModelId}` : ""}
                    onChange={(val) => {
                      if (!val) {
                        setForm((f) => ({ ...f, planningFallbackProvider: undefined, planningFallbackModelId: undefined }));
                      } else {
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          planningFallbackProvider: val.slice(0, slashIdx),
                          planningFallbackModelId: val.slice(slashIdx + 1),
                        }));
                      }
                    }}
                    placeholder="Use global fallback"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  <small>Used if the planning model fails due to rate limits or provider overload. Defaults to the global fallback model.</small>
                </div>
                <div className="form-group">
                  <label htmlFor="validatorFallbackModel">Reviewer Fallback Model</label>
                  <CustomModelDropdown
                    id="validatorFallbackModel"
                    label="Reviewer Fallback Model"
                    models={availableModels}
                    value={form.validatorFallbackProvider && form.validatorFallbackModelId ? `${form.validatorFallbackProvider}/${form.validatorFallbackModelId}` : ""}
                    onChange={(val) => {
                      if (!val) {
                        setForm((f) => ({ ...f, validatorFallbackProvider: undefined, validatorFallbackModelId: undefined }));
                      } else {
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          validatorFallbackProvider: val.slice(0, slashIdx),
                          validatorFallbackModelId: val.slice(slashIdx + 1),
                        }));
                      }
                    }}
                    placeholder="Use global fallback"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  <small>Used if the reviewer model fails due to rate limits or provider overload. Defaults to the global fallback model.</small>
                </div>
              </>
            )}

            {/* --- Model Presets --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">Model Presets</h4>
            <div className="form-group settings-model-presets">
              <label>Configured presets</label>
              {presets.length === 0 ? (
                <div className="settings-empty-state settings-muted">No presets configured yet.</div>
              ) : (
                <div className="settings-preset-list">
                  {presets.map((preset) => {
                    const selection = applyPresetToSelection(preset);
                    const summary = `${selection.executorValue || "default"} / ${selection.validatorValue || "default"}`;
                    return (
                      <div key={preset.id} className="settings-preset-item">
                        <div className="settings-preset-item-meta">
                          <strong>{preset.name}</strong>
                          <span className="settings-muted settings-preset-summary">{summary}</span>
                        </div>
                        <div className="settings-preset-item-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              setEditingPresetId(preset.id);
                              setPresetDraft({ ...preset });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              if (inUsePresetIds.has(preset.id)) {
                                const shouldDelete = await confirm({
                                  title: "Delete Preset",
                                  message: `Preset "${preset.name}" is used in auto-selection. Delete it anyway?`,
                                  danger: true,
                                });
                                if (!shouldDelete) {
                                  return;
                                }
                              }
                              setForm((current) => ({
                                ...current,
                                modelPresets: (current.modelPresets || []).filter((entry) => entry.id !== preset.id),
                                defaultPresetBySize: Object.fromEntries(
                                  Object.entries(current.defaultPresetBySize || {}).filter(([, value]) => value !== preset.id),
                                ) as Settings["defaultPresetBySize"],
                              }));
                              if (editingPresetId === preset.id) {
                                setEditingPresetId(null);
                                setPresetDraft(null);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!presetDraft ? (
                <div className="settings-preset-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setEditingPresetId(null);
                      setPresetDraft({ id: "", name: "", executorProvider: undefined, executorModelId: undefined, validatorProvider: undefined, validatorModelId: undefined });
                    }}
                  >
                    Add Preset
                  </button>
                </div>
              ) : null}
            </div>

            {presetDraft ? (
              <div className="form-group settings-preset-editor">
                <label>Preset editor</label>
                <div className="settings-preset-editor-fields">
                  <div className="form-group">
                    <label htmlFor="preset-name">Name</label>
                    <input
                      id="preset-name"
                      type="text"
                      value={presetDraft.name}
                      onChange={(e) => {
                        const name = e.target.value;
                        setPresetDraft((current) => current ? { ...current, name } : current);
                      }}
                    />
                  </div>
                  {availableModels.length === 0 ? (
                    <small>No models available. Configure authentication first.</small>
                  ) : (
                    <>
                      <div className="form-group">
                        <label htmlFor="preset-executor-model">Executor model</label>
                        <CustomModelDropdown
                          id="preset-executor-model"
                          label="Preset executor model"
                          models={availableModels}
                          value={presetDraft.executorProvider && presetDraft.executorModelId ? `${presetDraft.executorProvider}/${presetDraft.executorModelId}` : ""}
                          onChange={(val) => {
                            if (!val) {
                              setPresetDraft((current) => current ? { ...current, executorProvider: undefined, executorModelId: undefined } : current);
                              return;
                            }
                            const slashIdx = val.indexOf("/");
                            setPresetDraft((current) => current ? {
                              ...current,
                              executorProvider: val.slice(0, slashIdx),
                              executorModelId: val.slice(slashIdx + 1),
                            } : current);
                          }}
                          placeholder="Use default"
                          favoriteProviders={favoriteProviders}
                          onToggleFavorite={handleToggleFavorite}
                          favoriteModels={favoriteModels}
                          onToggleModelFavorite={handleToggleModelFavorite}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="preset-validator-model">Reviewer model</label>
                        <CustomModelDropdown
                          id="preset-validator-model"
                          label="Preset reviewer model"
                          models={availableModels}
                          value={presetDraft.validatorProvider && presetDraft.validatorModelId ? `${presetDraft.validatorProvider}/${presetDraft.validatorModelId}` : ""}
                          onChange={(val) => {
                            if (!val) {
                              setPresetDraft((current) => current ? { ...current, validatorProvider: undefined, validatorModelId: undefined } : current);
                              return;
                            }
                            const slashIdx = val.indexOf("/");
                            setPresetDraft((current) => current ? {
                              ...current,
                              validatorProvider: val.slice(0, slashIdx),
                              validatorModelId: val.slice(slashIdx + 1),
                            } : current);
                          }}
                          placeholder="Use default"
                          favoriteProviders={favoriteProviders}
                          onToggleFavorite={handleToggleFavorite}
                          favoriteModels={favoriteModels}
                          onToggleModelFavorite={handleToggleModelFavorite}
                        />
                      </div>
                    </>
                  )}
                </div>
                <div className="modal-actions settings-preset-editor-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={savePresetDraft}>Save preset</button>
                  <button type="button" className="btn btn-sm" onClick={() => { setEditingPresetId(null); setPresetDraft(null); }}>Cancel</button>
                </div>
              </div>
            ) : null}

            <div className="form-group settings-preset-auto-select">
              <label htmlFor="autoSelectModelPreset" className="checkbox-label">
                <input
                  id="autoSelectModelPreset"
                  type="checkbox"
                  checked={form.autoSelectModelPreset || false}
                  onChange={(e) => setForm((current) => ({ ...current, autoSelectModelPreset: e.target.checked }))}
                />
                Auto-select preset based on task size
              </label>
            </div>

            {form.autoSelectModelPreset ? (
              <div className="settings-preset-size-grid">
                {(["S", "M", "L"] as const).map((sizeKey) => (
                  <div className="form-group settings-preset-size-row" key={sizeKey}>
                    <label htmlFor={`preset-size-${sizeKey}`}>
                      {sizeKey === "S" ? "Small tasks (S):" : sizeKey === "M" ? "Medium tasks (M):" : "Large tasks (L):"}
                    </label>
                    <select
                      id={`preset-size-${sizeKey}`}
                      value={form.defaultPresetBySize?.[sizeKey] || ""}
                      onChange={(e) => {
                        const value = e.target.value || undefined;
                        setForm((current) => ({
                          ...current,
                          defaultPresetBySize: {
                            ...(current.defaultPresetBySize || {}),
                            [sizeKey]: value,
                          },
                        }));
                      }}
                    >
                      <option value="">No preset</option>
                      {presetOptions.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ) : null}

            {/* --- AI Title and Git Commit Message Summarization --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">
              AI Title and Git Commit Message Summarization
            </h4>
            <p className="settings-description">
              Configures the model used for two short-summary jobs:
              auto-generating task titles from long descriptions, and
              generating merge commit summaries from step commits and diff stats.
            </p>
            <div className="form-group">
              <label htmlFor="autoSummarizeTitles" className="checkbox-label">
                <input
                  id="autoSummarizeTitles"
                  type="checkbox"
                  checked={form.autoSummarizeTitles || false}
                  onChange={(e) => setForm((f) => ({ ...f, autoSummarizeTitles: e.target.checked }))}
                />
                Auto-summarize long descriptions as titles
              </label>
              <small>
                When enabled, tasks created without a title but with descriptions over 200 characters
                will automatically get an AI-generated title (max 60 characters). The same model is
                also used to generate fallback merge commit message bodies when the branch's commit
                log is empty (e.g. squash merges with no unique commits), and GitHub tracking issue
                titles when a tracked task has no title yet.
              </small>
            </div>

            <div className="form-group">
              <label htmlFor="useAiMergeCommitSummary" className="checkbox-label">
                <input
                  id="useAiMergeCommitSummary"
                  type="checkbox"
                  checked={form.useAiMergeCommitSummary || false}
                  onChange={(e) => setForm((f) => ({ ...f, useAiMergeCommitSummary: e.target.checked }))}
                />
                AI merge commit summaries
              </label>
              <small>
                When enabled, merge commit messages will include an AI-generated summary of the changes instead of just listing step commit subjects. Uses the title summarization model.
              </small>
            </div>

            {(form.autoSummarizeTitles || form.useAiMergeCommitSummary || form.githubTrackingEnabledByDefault || false) && (
              <>
                <div className="form-group">
                  <label>Title, commit message, and GitHub tracking issue summarization model</label>
                  {modelsLoading ? (
                    <small>Loading available models...</small>
                  ) : availableModels.length === 0 ? (
                    <small>No models available. Configure authentication first.</small>
                  ) : (
                    <CustomModelDropdown
                      id="titleSummarizerModel"
                      label="Title, commit message, and GitHub tracking issue summarization model"
                      models={availableModels}
                      value={
                        form.titleSummarizerProvider && form.titleSummarizerModelId
                          ? `${form.titleSummarizerProvider}/${form.titleSummarizerModelId}`
                          : ""
                      }
                      onChange={(val) => {
                        if (!val) {
                          setForm((f) => ({
                            ...f,
                            titleSummarizerProvider: undefined,
                            titleSummarizerModelId: undefined,
                          }));
                          return;
                        }
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          titleSummarizerProvider: val.slice(0, slashIdx),
                          titleSummarizerModelId: val.slice(slashIdx + 1),
                        }));
                      }}
                      placeholder="Use fallback model"
                      favoriteProviders={favoriteProviders}
                      onToggleFavorite={handleToggleFavorite}
                      favoriteModels={favoriteModels}
                      onToggleModelFavorite={handleToggleModelFavorite}
                    />
                  )}
                  <small>
                    Also used to summarize task descriptions into GitHub tracking issue titles when a task has no title yet.
                  </small>
                  <small>
                    {form.titleSummarizerProvider && form.titleSummarizerModelId
                      ? "Using explicitly configured model"
                      : resolvedTitleSummarizerModel.provider && resolvedTitleSummarizerModel.modelId
                        ? resolvedTitleSummarizerModel.provider === resolvedPlanningModel.provider
                          && resolvedTitleSummarizerModel.modelId === resolvedPlanningModel.modelId
                          ? "(using planning model)"
                          : resolvedTitleSummarizerModel.provider === resolvedDefaultModel.provider
                            && resolvedTitleSummarizerModel.modelId === resolvedDefaultModel.modelId
                            ? form.defaultProviderOverride && form.defaultModelIdOverride
                              ? "(using project default model)"
                              : "(using global default model)"
                            : "(using global summarization model)"
                        : "(using automatic model selection)"}
                  </small>
                </div>

                <div className="form-group">
                  <div className="modal-actions settings-summarization-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          titleSummarizerProvider: resolvedPlanningModel.provider,
                          titleSummarizerModelId: resolvedPlanningModel.modelId,
                        }))
                      }
                      disabled={!resolvedPlanningModel.provider || !resolvedPlanningModel.modelId}
                    >
                      Use planning model
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          titleSummarizerProvider: resolvedDefaultModel.provider,
                          titleSummarizerModelId: resolvedDefaultModel.modelId,
                        }))
                      }
                      disabled={!resolvedDefaultModel.provider || !resolvedDefaultModel.modelId}
                    >
                      Use default model
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        );
      }

      case "appearance":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Appearance</h4>
            <ThemeSelector
              themeMode={themeMode}
              colorTheme={colorTheme}
              dashboardFontScalePct={dashboardFontScalePct}
              onThemeModeChange={(mode) => {
                setForm((f) => ({ ...f, themeMode: mode }));
                onThemeModeChange?.(mode);
              }}
              onColorThemeChange={(theme) => {
                setForm((f) => ({ ...f, colorTheme: theme }));
                onColorThemeChange?.(theme);
              }}
              onDashboardFontScaleChange={(scalePct) => {
                setForm((f) => ({ ...f, dashboardFontScalePct: scalePct }));
                onDashboardFontScaleChange?.(scalePct);
              }}
            />
            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={sessionBannersHidden}
                  onChange={(e) => setSessionBannersHidden(e.target.checked)}
                />
                <span>Hide AI session notification banners</span>
              </label>
              <small className="form-text text-muted">
                Suppress the &ldquo;needs your input&rdquo; banner that appears when AI sessions are awaiting input or have failed.
              </small>
            </div>
          </>
        );
      case "scheduling":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Scheduling</h4>
            <div className="form-group">
              <label htmlFor="globalMaxConcurrent">Global Max Concurrent</label>
              <input
                id="globalMaxConcurrent"
                type="number"
                min={0}
                max={10000}
                value={globalMaxConcurrent ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  globalConcurrencyDirtyRef.current = true;
                  setGlobalMaxConcurrent(val === "" ? undefined : Number(val));
                }}
              />
              <small className="form-text text-muted">Maximum concurrent agents across all projects</small>
            </div>
            <div className="form-group">
              <label htmlFor="maxConcurrent">Max Concurrent Tasks</label>
              <input
                id="maxConcurrent"
                type="number"
                min={1}
                max={10}
                value={form.maxConcurrent ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, maxConcurrent: val === "" ? undefined : Number(val) } as SettingsFormState));
                }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="maxTriageConcurrent">Max Triage Concurrent</label>
              <input
                id="maxTriageConcurrent"
                type="number"
                min={1}
                max={10}
                value={form.maxTriageConcurrent ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, maxTriageConcurrent: val === "" ? undefined : Number(val) } as SettingsFormState));
                }}
              />
              <small>Maximum concurrent planning agents</small>
            </div>
            <div className="form-group">
              <label htmlFor="pollIntervalMs">Poll Interval (ms)</label>
              <input
                id="pollIntervalMs"
                type="number"
                min={5000}
                step={1000}
                value={form.pollIntervalMs ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, pollIntervalMs: val === "" ? undefined : Number(val) } as SettingsFormState));
                }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="heartbeatScopeDiscipline">Heartbeat Scope Discipline</label>
              <select
                id="heartbeatScopeDiscipline"
                className="select"
                value={form.heartbeatScopeDiscipline ?? "strict"}
                onChange={(e) => {
                  setForm((f) => ({
                    ...f,
                    heartbeatScopeDiscipline: e.target.value as "strict" | "lite" | "off",
                  }));
                }}
              >
                <option value="strict">Strict (default)</option>
                <option value="lite">Lite</option>
                <option value="off">Off</option>
              </select>
              <small>Strict — coordination-focused; higher per-tick tokens. Lite — pre-2026-05-11 behavior. Off — minimal procedure.</small>
            </div>
            <div className="form-group">
              <label htmlFor="taskStuckTimeoutMs">Stuck Task Timeout (minutes)</label>
              <input
                id="taskStuckTimeoutMs"
                type="number"
                min={1}
                step={1}
                value={form.taskStuckTimeoutMs ? Math.round(form.taskStuckTimeoutMs / 60000) : ""}
                onChange={(e) => {
                  const val = e.target.value;
                  const num = Number(val);
                  setForm((f) => ({ ...f, taskStuckTimeoutMs: val && num > 0 ? num * 60000 : undefined }));
                }}
              />
              <small>Timeout in minutes for detecting stuck tasks. When a task&apos;s agent session shows no activity for longer than this duration, the task is terminated and retried. Leave empty to disable. Suggested: 10.</small>
            </div>
            <div className="form-group">
              <label htmlFor="staleHighFanoutBlockerAgeThresholdMs">Stale High Fan-out Escalation (hours)</label>
              <input
                id="staleHighFanoutBlockerAgeThresholdMs"
                type="number"
                min={1}
                step={1}
                value={form.staleHighFanoutBlockerAgeThresholdMs ? Math.round(form.staleHighFanoutBlockerAgeThresholdMs / 3600000) : ""}
                onChange={(e) => {
                  const val = e.target.value;
                  const num = Number(val);
                  setForm((f) => ({
                    ...f,
                    staleHighFanoutBlockerAgeThresholdMs: val && num > 0 ? num * 3600000 : undefined,
                  }));
                }}
              />
              <small>Escalate high fan-out blockers only after they remain in in-progress or in-review for this many hours (age source: columnMovedAt, fallback updatedAt). Default: 2 hours.</small>
            </div>
            <div className="form-group">
              <label htmlFor="preserveProgressOnStuckRequeue" className="checkbox-label">
                <input
                  id="preserveProgressOnStuckRequeue"
                  type="checkbox"
                  checked={form.preserveProgressOnStuckRequeue !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, preserveProgressOnStuckRequeue: e.target.checked }))
                  }
                />
                Preserve step progress on stuck-task requeue
              </label>
              <small>When the stuck detector kills and re-queues a task, keep completed step statuses so the agent can resume from where it left off. Disable to reset every step to pending on each stuck retry. Default: enabled.</small>
            </div>
            <div className="form-group">
              <label htmlFor="specStalenessEnabled" className="checkbox-label">
                <input
                  id="specStalenessEnabled"
                  type="checkbox"
                  checked={form.specStalenessEnabled || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, specStalenessEnabled: e.target.checked }))
                  }
                />
                Enable plan staleness enforcement
              </label>
              <small>When enabled, tasks with stale plans (PROMPT.md older than the threshold) are automatically sent back to planning for replanning</small>
            </div>
            <div className="form-group">
              <label htmlFor="specStalenessMaxAgeMs">Stale Spec Threshold (hours)</label>
              <input
                id="specStalenessMaxAgeMs"
                type="number"
                min={0}
                step={1}
                value={form.specStalenessMaxAgeMs !== undefined ? Math.round(form.specStalenessMaxAgeMs / 3600000) : ""}
                onChange={(e) => {
                  const val = e.target.value;
                  const num = Number(val);
                  setForm((f) => ({ ...f, specStalenessMaxAgeMs: val !== "" ? num * 3600000 : undefined }));
                }}
                disabled={!form.specStalenessEnabled}
              />
              <small>Maximum age in hours before a plan is considered stale. Default: 6 hours.</small>
            </div>
            <div className="form-group">
              <label htmlFor="autoArchiveDoneTasksEnabled" className="checkbox-label">
                <input
                  id="autoArchiveDoneTasksEnabled"
                  type="checkbox"
                  checked={form.autoArchiveDoneTasksEnabled ?? true}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      autoArchiveDoneTasksEnabled: e.target.checked,
                    }))
                  }
                />
                Enable automatic task archiving
              </label>
              <small>Completed tasks older than the threshold are moved out of the active task database.</small>
            </div>
            <div className="form-group">
              <label htmlFor="autoArchiveDoneAfterMs">Archive Completed Tasks After (days)</label>
              <input
                id="autoArchiveDoneAfterMs"
                type="number"
                min={1}
                step={1}
                value={form.autoArchiveDoneAfterMs !== undefined ? Math.round(form.autoArchiveDoneAfterMs / MS_PER_DAY) : AUTO_ARCHIVE_DEFAULT_AFTER_DAYS}
                onChange={(e) => {
                  const val = e.target.value;
                  const num = Number(val);
                  setForm((f) => ({
                    ...f,
                    autoArchiveDoneAfterMs: val === "" ? undefined : num * MS_PER_DAY,
                  }));
                }}
                disabled={form.autoArchiveDoneTasksEnabled === false}
              />
              <small>Number of days a task can stay in Done before it is archived. Default: 2 days (48 hours).</small>
            </div>
            <div className="form-group">
              <label htmlFor="archiveAgentLogMode">Archive Agent Log</label>
              <select
                id="archiveAgentLogMode"
                value={form.archiveAgentLogMode ?? "compact"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    archiveAgentLogMode: e.target.value as "none" | "compact" | "full",
                  }))
                }
                disabled={form.autoArchiveDoneTasksEnabled === false}
              >
                <option value="compact">Compact summary and recent entries</option>
                <option value="none">Do not archive agent logs</option>
                <option value="full">Full agent log</option>
              </select>
              <small>Compact mode keeps archive size low while preserving recent agent activity for context.</small>
            </div>
            <div className="form-group">
              <label htmlFor="maxStuckKills">Max Stuck Retries</label>
              <input
                id="maxStuckKills"
                type="number"
                min={1}
                step={1}
                value={form.maxStuckKills ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  const num = Number(val);
                  setForm((f) => ({ ...f, maxStuckKills: val && num > 0 ? num : undefined }));
                }}
              />
              <small>Maximum stuck-detector retries before a task is marked failed. Default: 6.</small>
            </div>
            <div className="form-group">
              <label htmlFor="groupOverlappingFiles" className="checkbox-label">
                <input
                  id="groupOverlappingFiles"
                  type="checkbox"
                  checked={form.groupOverlappingFiles}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, groupOverlappingFiles: e.target.checked }))
                  }
                />
                Serialize tasks with overlapping files
              </label>
              <small>When enabled, tasks that modify the same files are queued serially to avoid merge conflicts</small>
            </div>

            <div className="form-group settings-overlap-ignore-group">
              <label>Ignored overlap paths</label>
              <small>
                Optional file or directory paths to ignore when overlap serialization is enabled.
                Paths are project-relative (for example <code>docs/</code> or <code>generated/*</code>).
              </small>
              <div className="settings-overlap-ignore-list">
                {(form.overlapIgnorePaths && form.overlapIgnorePaths.length > 0 ? form.overlapIgnorePaths : [""]).map((path, index) => (
                  <div key={`overlap-ignore-${index}`} className="settings-overlap-ignore-row">
                    <div className="settings-overlap-ignore-path-controls">
                      <input
                        type="text"
                        value={path}
                        placeholder="docs/"
                        onChange={(e) => handleOverlapIgnorePathChange(index, e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => openOverlapPathPicker(index)}
                        aria-label={`Browse path for ignored overlap entry ${index + 1}`}
                      >
                        Browse
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleRemoveOverlapIgnorePath(index)}
                      disabled={(form.overlapIgnorePaths ?? []).length === 0 && index === 0}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleAddOverlapIgnorePath}
              >
                Add ignored path
              </button>
            </div>

            <div className="settings-section-divider" />

            <h5 className="settings-section-heading">Step Execution</h5>
            <div className="form-group">
              <label htmlFor="runStepsInNewSessions" className="checkbox-label">
                <input
                  id="runStepsInNewSessions"
                  type="checkbox"
                  checked={form.runStepsInNewSessions || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, runStepsInNewSessions: e.target.checked }))
                  }
                />
                Run each step in a new session
              </label>
              <small>Run each task step in its own fresh agent session for better isolation and error recovery. Failed steps can be retried individually.</small>
            </div>
            <div className="form-group">
              <label htmlFor="maxParallelSteps">Maximum parallel steps</label>
              <input
                id="maxParallelSteps"
                type="number"
                min={1}
                max={4}
                value={form.maxParallelSteps ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, maxParallelSteps: val === "" ? undefined : Number(val) }));
                }}
                disabled={!form.runStepsInNewSessions}
              />
              <small>Maximum number of steps to run in parallel when file scopes don&apos;t overlap (1-4)</small>
            </div>
          </>
        );
      case "scheduled-evals": {
        const evalSettings = form.evalSettings ?? {};
        const isScheduledEvalEnabled = evalSettings.enabled ?? false;

        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Scheduled Evals</h4>
            <div className="form-group">
              <label htmlFor="scheduled-evals-enabled" className="checkbox-label">
                <input
                  id="scheduled-evals-enabled"
                  type="checkbox"
                  checked={isScheduledEvalEnabled}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      evalSettings: {
                        ...(current.evalSettings ?? {}),
                        enabled: event.target.checked,
                      },
                    }))
                  }
                />
                Enable scheduled eval runs for this project
              </label>
            </div>
            <div className="form-group">
              <label htmlFor="scheduled-evals-interval">Interval (ms)</label>
              <input
                id="scheduled-evals-interval"
                className="input"
                type="number"
                min={60000}
                max={604800000}
                step={1000}
                disabled={!isScheduledEvalEnabled}
                value={evalSettings.intervalMs ?? 86_400_000}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    evalSettings: {
                      ...(current.evalSettings ?? {}),
                      intervalMs: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  }))
                }
              />
            </div>
            <div className="form-group">
              <label htmlFor="scheduled-evals-provider">Evaluator Provider</label>
              <input
                id="scheduled-evals-provider"
                className="input"
                value={evalSettings.evaluatorProvider ?? ""}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    evalSettings: {
                      ...(current.evalSettings ?? {}),
                      evaluatorProvider: event.target.value.trim() === "" ? undefined : event.target.value,
                    },
                  }))
                }
                placeholder="openai"
              />
            </div>
            <div className="form-group">
              <label htmlFor="scheduled-evals-model">Evaluator Model</label>
              <input
                id="scheduled-evals-model"
                className="input"
                value={evalSettings.evaluatorModelId ?? ""}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    evalSettings: {
                      ...(current.evalSettings ?? {}),
                      evaluatorModelId: event.target.value.trim() === "" ? undefined : event.target.value,
                    },
                  }))
                }
                placeholder="gpt-5"
              />
              <small className="form-text text-muted">
                Leave provider and model blank to inherit the project validator lane model settings.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="scheduled-evals-follow-up-policy">Follow-up Policy</label>
              <select
                id="scheduled-evals-follow-up-policy"
                className="select"
                disabled={!isScheduledEvalEnabled}
                value={evalSettings.followUpPolicy ?? "suggest-only"}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    evalSettings: {
                      ...(current.evalSettings ?? {}),
                      followUpPolicy: event.target.value as "disabled" | "suggest-only" | "auto-create",
                    },
                  }))
                }
              >
                <option value="disabled">Disabled</option>
                <option value="suggest-only">Suggest only</option>
                <option value="auto-create">Auto-create tasks</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="scheduled-evals-retention-days">Retention (days)</label>
              <input
                id="scheduled-evals-retention-days"
                className="input"
                type="number"
                min={1}
                max={365}
                step={1}
                disabled={!isScheduledEvalEnabled}
                value={evalSettings.retentionDays ?? 30}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    evalSettings: {
                      ...(current.evalSettings ?? {}),
                      retentionDays: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  }))
                }
              />
            </div>
          </>
        );
      }
      case "node-routing":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Node Routing</h4>
            <p className="settings-section-description">Configure how tasks are routed to execution nodes.</p>
            <p className="settings-node-routing-note">These settings apply at the project level.</p>
            <div className="form-group">
              <label htmlFor="defaultNodeId">Default Execution Node</label>
              <select
                id="defaultNodeId"
                className="select"
                value={typeof form.defaultNodeId === "string" ? form.defaultNodeId : ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, defaultNodeId: val || undefined } as SettingsFormState));
                }}
              >
                <option value="">Local execution (no default node)</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} ({getNodeStatusLabel(node.status)})
                  </option>
                ))}
              </select>
              {(() => {
                const selectedNode = nodes.find((node) => node.id === form.defaultNodeId);
                if (!selectedNode) return null;
                return (
                  <div className="settings-node-status">
                    <span>Selected node:</span>
                    <NodeHealthDot status={selectedNode.status} showLabel />
                  </div>
                );
              })()}
              <small>Used when a task has no node override. Node status is shown for safer routing selection.</small>
            </div>
            <div className="form-group">
              <label htmlFor="unavailableNodePolicy">Unavailable Node Policy</label>
              <select
                id="unavailableNodePolicy"
                className="select"
                value={
                  form.unavailableNodePolicy === "fallback-local" ? "fallback-local" : "block"
                }
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    unavailableNodePolicy: e.target.value as "block" | "fallback-local",
                  } as SettingsFormState))
                }
              >
                <option value="block">Block execution</option>
                <option value="fallback-local">Fall back to local</option>
              </select>
            </div>
          </>
        );

      case "worktrees":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Worktrees</h4>
            <div className="form-group">
              <label htmlFor="maxWorktrees">Max Worktrees</label>
              <input
                id="maxWorktrees"
                type="number"
                min={1}
                max={20}
                value={form.maxWorktrees ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, maxWorktrees: val === "" ? undefined : Number(val) } as SettingsFormState));
                }}
              />
              <small>Limits total git worktrees including in-review tasks</small>
            </div>
            <div className="form-group">
              <label htmlFor="worktreeInitCommand">Worktree Init Command</label>
              <input
                id="worktreeInitCommand"
                type="text"
                placeholder="pnpm install --frozen-lockfile"
                value={form.worktreeInitCommand || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, worktreeInitCommand: e.target.value }))
                }
              />
              <small>Shell command to run in each new worktree after creation</small>
            </div>
            <div className="form-group">
              <label htmlFor="recycleWorktrees" className="checkbox-label">
                <input
                  id="recycleWorktrees"
                  type="checkbox"
                  checked={form.recycleWorktrees}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, recycleWorktrees: e.target.checked }))
                  }
                />
                Recycle worktrees
              </label>
              <small>Off by default (opt-in). When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup</small>
            </div>
            <div className="form-group">
              <label htmlFor="executorAllowSiblingBranchRename" className="checkbox-label">
                <input
                  id="executorAllowSiblingBranchRename"
                  type="checkbox"
                  checked={form.executorAllowSiblingBranchRename === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, executorAllowSiblingBranchRename: e.target.checked }))
                  }
                />
                Allow silent sibling branch rename during executor conflicts
              </label>
              <small>
                Discouraged. This restores the legacy behavior where a live <code>fusion/&lt;task-id&gt;</code> branch collision silently forks work onto sibling branches like <code>-2</code> and can hide prior commits from the default recovery flow.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="worktreeNaming">Worktree Naming Style</label>
              <select
                id="worktreeNaming"
                value={form.worktreeNaming || "random"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, worktreeNaming: e.target.value as "random" | "task-id" | "task-title" }))
                }
                disabled={form.recycleWorktrees}
              >
                <option value="random">Random names (e.g., swift-falcon)</option>
                <option value="task-id">Task ID (e.g., FN-042)</option>
                <option value="task-title">Task title (e.g., fix-login-bug)</option>
              </select>
              <small>
                {form.recycleWorktrees
                  ? "Naming style is not applicable when recycling worktrees — pooled worktrees retain their existing names"
                  : "How to name fresh worktree directories. Only applies when recycling is off."}
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="worktreesDir">Worktrees Directory</label>
              <div className="settings-overlap-ignore-path-controls">
                <input
                  id="worktreesDir"
                  type="text"
                  placeholder="Defaults to .worktrees — leave empty unless overriding"
                  value={form.worktreesDir || ""}
                  disabled={form.worktrunk?.enabled === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, worktreesDir: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={openWorktreesDirPicker}
                  aria-label="Browse worktrees directory"
                  disabled={form.worktrunk?.enabled === true}
                >
                  Browse
                </button>
              </div>
              <small>
                {form.worktrunk?.enabled === true
                  ? "Disabled because Worktrunk integration is enabled — worktrunk manages the worktree directory layout. Disable worktrunk integration to use a custom directory."
                  : <>
                      Optional. Supports <code>~</code> and <code>{"{repo}"}</code>. Defaults to <code>&lt;projectRoot&gt;/.worktrees</code> when unset. Only affects newly-created worktrees.
                    </>}
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="worktreeRebaseBeforeMerge" className="checkbox-label">
                <input
                  id="worktreeRebaseBeforeMerge"
                  type="checkbox"
                  checked={form.worktreeRebaseBeforeMerge !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, worktreeRebaseBeforeMerge: e.target.checked }))
                  }
                />
                Rebase from remote before merge
              </label>
              <small>When enabled, the merger fetches from the configured remote and rebases the task branch onto the latest default-branch tip before merging — catching concurrent pushes from other collaborators or fusion workers. Any conflicts the rebase surfaces flow into the existing smart/AI resolve pipeline.</small>
            </div>
            {form.worktreeRebaseBeforeMerge !== false && (
              <div className="form-group">
                <label htmlFor="worktreeRebaseRemote">Rebase Remote</label>
                <select
                  id="worktreeRebaseRemote"
                  value={form.worktreeRebaseRemote ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, worktreeRebaseRemote: e.target.value || undefined }))
                  }
                >
                  <option value="">Use git default</option>
                  {gitRemotes.map((remote) => (
                    <option key={remote.name} value={remote.name}>
                      {remote.name} ({remote.fetchUrl})
                    </option>
                  ))}
                </select>
                <small>
                  Which remote to fetch for the pre-merge rebase. "Use git default" falls back to the remote configured for the default branch (typically <code>origin</code>).
                </small>
              </div>
            )}
            <div className="form-group">
              <label htmlFor="worktreeRebaseLocalBase" className="checkbox-label">
                <input
                  id="worktreeRebaseLocalBase"
                  type="checkbox"
                  checked={form.worktreeRebaseLocalBase !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, worktreeRebaseLocalBase: e.target.checked }))
                  }
                />
                Also rebase onto local default-branch HEAD
              </label>
              <small>
                In addition to the remote rebase above, also rebase the task branch onto the local default-branch HEAD (rootDir). This catches sibling tasks that merged locally but haven't been pushed yet — without it, two concurrent tasks where one deletes code can have the other silently re-introduce it via the fallback strategy. Enabled by default; only disable if it causes issues with your workflow.
              </small>
            </div>

            <h4 className="settings-section-heading settings-section-heading--spaced">Worktrunk integration</h4>
            <div className="form-group">
              <label htmlFor="worktrunkEnabled" className="checkbox-label">
                <input
                  id="worktrunkEnabled"
                  type="checkbox"
                  checked={form.worktrunk?.enabled === true}
                  disabled={!worktrunkInstallVerified && form.worktrunk?.enabled !== true}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      worktrunk: {
                        enabled: e.target.checked,
                        binaryPath: f.worktrunk?.binaryPath ?? "",
                        onFailure: f.worktrunk?.onFailure ?? "fail",
                      },
                    }))
                  }
                />
                Enable worktrunk integration
              </label>
              <small>
                Disabled by default (opt-in). When enabled, Fusion shells out to <code>worktrunk</code> for worktree create, sync, prune, and remove operations and follows worktrunk&apos;s directory layout.
              </small>
              {!worktrunkInstallVerified && form.worktrunk?.enabled !== true && (
                <small className="settings-muted">Install the worktrunk binary below to enable this integration.</small>
              )}
            </div>
            <div className="form-group" data-testid="worktrunk-install-affordance">
              {worktrunkInstall.status === "installed" && (
                <small className="settings-muted">
                  worktrunk {worktrunkInstall.version ?? ""} installed at {worktrunkInstall.installPath ?? "~/.fusion/bin/worktrunk"}
                </small>
              )}
              {(worktrunkInstall.status === "missing" || worktrunkInstall.status === "installing") && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void worktrunkInstall.requestInstall()}
                    disabled={worktrunkInstall.requesting || worktrunkInstall.status === "installing"}
                  >
                    Install worktrunk binary
                  </button>
                  <small className="settings-muted">Enable worktrunk and request approval to install the pinned release.</small>
                </>
              )}
              {worktrunkInstall.status === "pending-approval" && (
                <>
                  <small className="settings-muted">Awaiting approval — open Approvals to continue.</small>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onOpenApprovals?.(worktrunkInstall.pendingApprovalId)}
                  >
                    Open Approvals
                  </button>
                </>
              )}
              {(worktrunkInstall.status === "denied" || worktrunkInstall.status === "failed") && (
                <>
                  <small style={{ color: "var(--color-error)" }}>{worktrunkInstall.error ?? "Worktrunk install failed."}</small>
                  <button type="button" className="btn btn-secondary" onClick={() => void worktrunkInstall.requestInstall()}>
                    Try again
                  </button>
                </>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="worktrunkBinaryPath">Worktrunk binary path</label>
              <input
                id="worktrunkBinaryPath"
                type="text"
                className="input"
                placeholder="auto-detect (~/.fusion/bin/worktrunk or $PATH)"
                value={form.worktrunk?.binaryPath ?? ""}
                disabled={form.worktrunk?.enabled !== true}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    worktrunk: {
                      enabled: f.worktrunk?.enabled === true,
                      binaryPath: e.target.value,
                      onFailure: f.worktrunk?.onFailure ?? "fail",
                    },
                  }))
                }
              />
              <small>Optional. Leave blank to auto-resolve; Fusion will offer to install on first use.</small>
            </div>
            <div className="form-group">
              <label htmlFor="worktrunkOnFailure">Worktrunk failure behavior</label>
              <select
                id="worktrunkOnFailure"
                className="select"
                value={form.worktrunk?.onFailure ?? "fail"}
                disabled={form.worktrunk?.enabled !== true}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    worktrunk: {
                      enabled: f.worktrunk?.enabled === true,
                      binaryPath: f.worktrunk?.binaryPath ?? "",
                      onFailure: e.target.value as "fail" | "fallback-native",
                    },
                  }))
                }
              >
                <option value="fail">Fail and pause the task (default)</option>
                <option value="fallback-native">Fall back to Fusion's native worktree backend</option>
              </select>
              <small>
                <code>fail</code> stops on worktrunk errors for explicit operator recovery; <code>fallback-native</code> keeps progress moving by switching to Fusion&apos;s built-in worktree backend.
              </small>
            </div>
          </>
        );
      case "commands":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Commands</h4>
            <div className="form-group">
              <label htmlFor="testCommand">Test Command</label>
              <input
                id="testCommand"
                type="text"
                placeholder="e.g. pnpm test"
                value={form.testCommand || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, testCommand: e.target.value || undefined }))
                }
              />
              <small>Command used to run tests — injected into generated task specs</small>
            </div>
            <div className="form-group">
              <label htmlFor="buildCommand">Build Command</label>
              <input
                id="buildCommand"
                type="text"
                placeholder="e.g. pnpm build"
                value={form.buildCommand || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, buildCommand: e.target.value || undefined }))
                }
              />
              <small>Command used to build the project — injected into generated task specs</small>
            </div>
          </>
        );
      case "merge":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Merge</h4>
            <div className="form-group">
              <label htmlFor="autoMerge" className="checkbox-label">
                <input
                  id="autoMerge"
                  type="checkbox"
                  checked={form.autoMerge}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, autoMerge: e.target.checked }))
                  }
                />
                Auto-merge completed tasks
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>When enabled, tasks that pass review are automatically merged into the main branch</small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="testMode" className="checkbox-label">
                <input
                  id="testMode"
                  type="checkbox"
                  checked={form.testMode === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, testMode: e.target.checked }))
                  }
                />
                Enable test mode
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>Forces all AI lanes to use the deterministic mock provider. No network calls, zero token cost.</small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="workflowRevisionForkOnScopeMismatch" className="checkbox-label">
                <input
                  id="workflowRevisionForkOnScopeMismatch"
                  type="checkbox"
                  checked={form.workflowRevisionForkOnScopeMismatch !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, workflowRevisionForkOnScopeMismatch: e.target.checked }))
                  }
                />
                Fork scope-mismatched workflow revisions into follow-up tasks
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>
                  When enabled, workflow revision feedback that explicitly names files outside the original task&apos;s declared File Scope is split into a dependent follow-up task instead of being appended to the current task&apos;s PROMPT.md.
                </small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="verificationFixRetries">Verification auto-fix retries</label>
              <input
                id="verificationFixRetries"
                className="input"
                type="number"
                min={0}
                max={3}
                step={1}
                value={form.verificationFixRetries ?? 3}
                onChange={(e) => {
                  const rawValue = e.target.value;
                  if (rawValue === "") {
                    setForm((f) => ({ ...f, verificationFixRetries: undefined } as SettingsFormState));
                    return;
                  }

                  const parsedValue = Number.parseInt(rawValue, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setForm((f) => ({ ...f, verificationFixRetries: undefined } as SettingsFormState));
                    return;
                  }

                  const clampedValue = Math.max(0, Math.min(3, parsedValue));
                  setForm((f) => ({ ...f, verificationFixRetries: clampedValue } as SettingsFormState));
                }}
              />
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>
                  Controls auto-fix retry attempts after deterministic test/build verification failures — applies to both executor-time and in-merge verification (0-3).
                </small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="mergeStrategy">Auto-completion mode</label>
              <select
                id="mergeStrategy"
                value={form.mergeStrategy || "direct"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, mergeStrategy: e.target.value as Settings["mergeStrategy"] }))
                }
              >
                <option value="direct">Direct merge into the current branch</option>
                <option value="pull-request">Create, monitor, and merge a GitHub pull request</option>
              </select>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>
                  Controls what happens after a task reaches In Review. Direct mode merges into the current branch locally. Pull request mode keeps the task in In Review while Fusion waits for GitHub reviews and required checks before merging the PR.
                </small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="integrationBranch">Integration branch</label>
              {(() => {
                const currentValue = form.integrationBranch ?? "";
                const valueIsKnown = currentValue.length > 0 && integrationBranchOptions.includes(currentValue);
                const isCustomMode = integrationBranchCustomMode || (currentValue.length > 0 && !valueIsKnown);
                if (isCustomMode) {
                  return (
                    <div className="form-inline-group">
                      <input
                        id="integrationBranch"
                        type="text"
                        className="input"
                        placeholder="branch name"
                        value={currentValue}
                        onChange={(e) => {
                          const trimmed = e.target.value.trim();
                          setForm((f) => ({
                            ...f,
                            integrationBranch: trimmed.length === 0 ? undefined : trimmed,
                          }));
                        }}
                        data-testid="integration-branch-custom-input"
                      />
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          setIntegrationBranchCustomMode(false);
                          setForm((f) => ({ ...f, integrationBranch: undefined }));
                        }}
                        data-testid="integration-branch-use-dropdown"
                      >
                        Use dropdown
                      </button>
                    </div>
                  );
                }
                const CUSTOM = "__fusion-custom__";
                const AUTO = "";
                return (
                  <select
                    id="integrationBranch"
                    className="select"
                    value={currentValue}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === CUSTOM) {
                        setIntegrationBranchCustomMode(true);
                        return;
                      }
                      setForm((f) => ({
                        ...f,
                        integrationBranch: next === AUTO ? undefined : next,
                      }));
                    }}
                    data-testid="integration-branch-select"
                  >
                    <option value={AUTO}>(auto-detect — origin/HEAD → main)</option>
                    {integrationBranchOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    <option value={CUSTOM}>Custom…</option>
                  </select>
                );
              })()}
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>
                  The canonical branch Fusion merges tasks into and uses as the reference for all
                  ahead/behind / overlap / pre-rebase computations. Leave on <em>auto-detect</em>
                  to resolve via the standard cascade
                  (<code>integrationBranch</code> → legacy <code>baseBranch</code> →
                  <code>origin/HEAD</code> symbolic ref → fallback <code>main</code>). Pick a
                  local branch from the dropdown — common integration names like <code>main</code>,
                  <code>master</code>, <code>trunk</code>, and <code>develop</code> are listed
                  first — or choose <em>Custom…</em> to type a branch that doesn&apos;t exist
                  locally yet. Applies to both direct merges and pull-request mode; individual
                  tasks can still override via task metadata.
                </small>
              </details>
            </div>
            {form.mergeStrategy !== "pull-request" && (
              <>
                <div className="form-group">
                  <label htmlFor="directMergeCommitStrategy">Direct merge commit routing</label>
                  <select
                    id="directMergeCommitStrategy"
                    className="select"
                    value={form.directMergeCommitStrategy ?? "auto"}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        directMergeCommitStrategy: e.target.value as "auto" | "always-squash" | "always-rebase",
                      }))
                    }
                  >
                    <option value="auto">Auto — squash single-substantive branches, preserve multi-substantive history</option>
                    <option value="always-squash">Always squash direct merges</option>
                    <option value="always-rebase">Always preserve direct-merge commit history</option>
                  </select>
                  <details className="settings-option-details">
                    <summary>More details</summary>
                    <small>
                      Auto keeps today&apos;s squash behavior for branches with zero or one substantive commit, but switches multi-substantive branches to a history-preserving rebase-and-merge path. Individual tasks can override this in PROMPT.md with <code>**Direct Merge Commit Strategy:** auto|always-squash|always-rebase</code>.
                    </small>
                  </details>
                </div>
                <div className="form-group">
                  <label htmlFor="mergeIntegrationWorktree">Integration worktree</label>
                  <select
                    id="mergeIntegrationWorktree"
                    className="select"
                    value={form.mergeIntegrationWorktree ?? "reuse-task-worktree"}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        mergeIntegrationWorktree: e.target.value as Settings["mergeIntegrationWorktree"],
                      }))
                    }
                  >
                    <option value="reuse-task-worktree">Reuse task worktree (default)</option>
                    <option value="cwd-main">Use project root (legacy)</option>
                  </select>
                  <small>
                    Auto-merge runs in the task worktree by default. Switch to the legacy project-root path only if you need the pre-FN-5279 fallback; worktrunk-managed projects still defer to worktrunk.
                  </small>
                  {(form.mergeIntegrationWorktree ?? "reuse-task-worktree") !== "reuse-task-worktree" && (
                    <div
                      className="settings-warning-banner"
                      role="alert"
                      aria-live="polite"
                      data-testid="merge-integration-worktree-warning"
                    >
                      <strong>Legacy integration-branch mode.</strong>{" "}
                      Auto-merge will run rebase, conflict resolution, and squash commits inside the
                      project root (the user&apos;s checked-out integration-branch worktree) instead of
                      the task worktree. Fusion assumes that directory is already on the integration
                      branch and clean; if it isn&apos;t, merges may fail or touch the user&apos;s working
                      tree. Reuse-task-worktree is the recommended default (FN-5279). Switch back unless
                      you have a specific reason to opt in (FN-5348).
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="mergeAdvanceAutoSync">Auto-sync project checkout after merge</label>
                  <select
                    id="mergeAdvanceAutoSync"
                    className="select"
                    value={form.mergeAdvanceAutoSync ?? "stash-and-ff"}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        mergeAdvanceAutoSync: e.target.value as "off" | "ff-only" | "stash-and-ff",
                      }))
                    }
                    data-testid="merge-advance-auto-sync-select"
                  >
                    <option value="stash-and-ff">Stash + fast-forward (default) — preserve local edits</option>
                    <option value="ff-only">Fast-forward only — skip dirty worktrees</option>
                    <option value="off">Off — leave the project root stale (legacy behavior)</option>
                  </select>
                  <details className="settings-option-details">
                    <summary>More details</summary>
                    <small>
                      After Fusion advances the integration branch ref, the merger can auto-sync other
                      worktrees still checked out on that branch (typically your project-root
                      checkout). <code>Stash + fast-forward</code> snapshots real local edits as a patch
                      against the previous tip, snaps the worktree to the new tip, then reapplies the
                      patch — untracked files that collide with newly-tracked paths are left in a temp
                      dir for manual recovery. <code>Fast-forward only</code> snaps cleanly when the
                      worktree has no edits and skips otherwise. <code>Off</code> is the legacy
                      behavior: <code>git status</code> in your project root will show the new commits
                      inverted as &quot;staged changes&quot; until you pull manually. Only applies to direct
                      merges.
                    </small>
                  </details>
                </div>
              </>
            )}
            {form.mergeStrategy === "pull-request" && (
              <div className="form-group">
                <label htmlFor="requirePrApproval" className="checkbox-label">
                  <input
                    id="requirePrApproval"
                    type="checkbox"
                    checked={form.requirePrApproval ?? false}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, requirePrApproval: e.target.checked }))
                    }
                  />
                  Wait for an approving review before merging the PR
                </label>
                <details className="settings-option-details">
                  <summary>More details</summary>
                  <small>
                    When enabled, Fusion holds the PR in In Review until at least one approving GitHub review has been submitted. Useful on free private repos where GitHub&apos;s required-reviewer enforcement isn&apos;t available — without this, a fresh PR with no required checks is treated as immediately mergeable.
                  </small>
                </details>
              </div>
            )}
            <h4 className="settings-section-heading settings-section-heading--spaced">GitHub Authentication</h4>
            <div className="form-group">
              <label htmlFor="githubAuthMode">GitHub auth mode</label>
              <select
                id="githubAuthMode"
                className="select"
                value={form.githubAuthMode ?? "gh-cli"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, githubAuthMode: e.target.value as "gh-cli" | "token" }))
                }
              >
                <option value="gh-cli">GitHub CLI (gh auth)</option>
                <option value="token">Personal access token</option>
              </select>
            </div>
            {(form.githubAuthMode ?? "gh-cli") === "token" && (
              <div className="form-group">
                <label htmlFor="githubAuthToken">GitHub personal access token</label>
                <input
                  id="githubAuthToken"
                  type="password"
                  className="input"
                  value={form.githubAuthToken ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, githubAuthToken: e.target.value || undefined }))
                  }
                />
              </div>
            )}
            <div className="form-group">
              <label htmlFor="includeTaskIdInCommit" className="checkbox-label">
                <input
                  id="includeTaskIdInCommit"
                  type="checkbox"
                  checked={form.includeTaskIdInCommit !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, includeTaskIdInCommit: e.target.checked }))
                  }
                />
                Include task ID in commit scope
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>When disabled, merge commit messages omit the task ID from the scope (e.g. <code>feat: ...</code> instead of <code>feat(KB-001): ...</code>)</small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="commitAuthorEnabled" className="checkbox-label">
                <input
                  id="commitAuthorEnabled"
                  type="checkbox"
                  checked={form.commitAuthorEnabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, commitAuthorEnabled: e.target.checked }))
                  }
                />
                Add Fusion as co-author on commits
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>
                  When enabled, commits made by Fusion keep your git identity as the
                  primary author and append a <code>Co-authored-by</code> trailer crediting
                  Fusion (recognized by GitHub for shared attribution).
                </small>
              </details>
            </div>

            {form.commitAuthorEnabled !== false && (
              <>
                <div className="form-group">
                  <label htmlFor="commitAuthorName">Co-author Name</label>
                  <input
                    id="commitAuthorName"
                    type="text"
                    value={form.commitAuthorName ?? ""}
                    placeholder="Fusion"
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        commitAuthorName: e.target.value || undefined,
                      }))
                    }
                  />
                  <small>Name used in the <code>Co-authored-by</code> trailer</small>
                </div>
                <div className="form-group">
                  <label htmlFor="commitAuthorEmail">Co-author Email</label>
                  <input
                    id="commitAuthorEmail"
                    type="email"
                    value={form.commitAuthorEmail ?? ""}
                    placeholder="noreply@runfusion.ai"
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        commitAuthorEmail: e.target.value || undefined,
                      }))
                    }
                  />
                  <small>Email used in the <code>Co-authored-by</code> trailer</small>
                </div>
              </>
            )}

            <div className="form-group">
              <label htmlFor="autoResolveConflicts" className="checkbox-label">
                <input
                  id="autoResolveConflicts"
                  type="checkbox"
                  checked={form.autoResolveConflicts !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, autoResolveConflicts: e.target.checked }))
                  }
                />
                Auto-resolve conflicts in lock files and generated files
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.), generated files (dist/*, *.gen.ts), and trivial whitespace conflicts are resolved automatically without AI intervention. Complex code conflicts still require AI review.</small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="smartConflictResolution" className="checkbox-label">
                <input
                  id="smartConflictResolution"
                  type="checkbox"
                  checked={form.smartConflictResolution !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, smartConflictResolution: e.target.checked }))
                  }
                />
                Smart conflict resolution
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.) are resolved using 'ours' strategy, generated files (dist/*, *.gen.ts) using 'theirs' strategy, and trivial whitespace conflicts are auto-resolved without spawning an AI agent. Complex code conflicts still require AI review.</small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="mergeConflictStrategy">Conflict Fallback Strategy</label>
              <select
                id="mergeConflictStrategy"
                value={form.mergeConflictStrategy ?? "smart-prefer-main"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, mergeConflictStrategy: e.target.value as "smart-prefer-main" | "smart-prefer-branch" | "ai-only" | "abort" }))
                }
              >
                <option value="smart-prefer-main">Smart, prefer main on fallback — fetch+ff origin → AI → auto-resolve → -X ours (default; protects just-merged sibling work)</option>
                <option value="smart-prefer-branch">Smart, prefer task on fallback — fetch+ff origin → AI → auto-resolve → -X theirs (legacy "smart" behavior; task branch wins)</option>
                <option value="ai-only">AI only — AI → auto-resolve → AI retry; never silently pick a side</option>
                <option value="abort">Abort — one AI attempt; require manual resolution if it fails</option>
              </select>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>
                  Both <strong>Smart</strong> options start with a best-effort <code>git fetch</code> + fast-forward of local main from <code>origin</code> (so a freshly-pushed sibling commit doesn't get clobbered), then run an AI agent, then auto-resolve handles lock/generated/trivial files. They differ only in the <em>final fallback</em>:
                  {" "}
                  <strong>Smart, prefer main</strong> uses <code>-X ours</code> so main wins — protects just-merged sibling work and is the new default.
                  {" "}
                  <strong>Smart, prefer task</strong> uses <code>-X theirs</code> so the task branch wins — fast, but can resurrect code an earlier sibling task deleted (the FN-2887 class of regression).
                  {" "}
                  <strong>AI only</strong> retries the AI agent rather than auto-picking a side.
                  {" "}
                  <strong>Abort</strong> stops after the first AI attempt and waits for a human.
                  {" "}
                  <em>Legacy <code>"smart"</code> and <code>"prefer-main"</code> values from older settings are migrated automatically.</em>
                </small>
              </details>
            </div>
            <div className="form-group">
              <label htmlFor="mergeStrategyOverlapBehavior">Smart Prefer Main Overlap Guard</label>
              <select
                id="mergeStrategyOverlapBehavior"
                value={form.mergeStrategyOverlapBehavior ?? "flip-to-prefer-branch"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    mergeStrategyOverlapBehavior: e.target.value as "flip-to-prefer-branch" | "warn-only" | "ignore",
                  }))
                }
              >
                <option value="flip-to-prefer-branch">Flip overlapping files to prefer the task branch (default)</option>
                <option value="warn-only">Warn only — keep legacy main-wins fallback</option>
                <option value="ignore">Ignore overlap detection — preserve legacy behavior</option>
              </select>
              <small>
                When using smart-prefer-main, automatically prefer the branch side for files that main has recently modified to avoid silently discarding branch work.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="postMergeAuditMode">Post-merge audit mode</label>
              <select
                className="select"
                id="postMergeAuditMode"
                value={form.postMergeAuditMode ?? "warn"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    postMergeAuditMode: e.target.value as "block" | "warn" | "off",
                  }))
                }
              >
                <option value="block">Block (strict)</option>
                <option value="warn">Warn (default; log findings, continue)</option>
                <option value="off">Off (skip audit)</option>
              </select>
              <small>
                Controls the post-merge audit gate. <strong>Warn</strong> (default) logs findings but auto-completes the merge. <strong>Block</strong> is the stricter opt-in mode that refuses to auto-complete merges with duplicate-subject or touched-file overlap risks. <strong>Off</strong> skips the audit entirely. Switching to Off is recommended only if you trust your branches don&apos;t silently drop edits.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="pushAfterMerge" className="checkbox-label">
                <input
                  id="pushAfterMerge"
                  type="checkbox"
                  checked={form.pushAfterMerge === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, pushAfterMerge: e.target.checked }))
                  }
                />
                Push to remote after merge
              </label>
              <details className="settings-option-details">
                <summary>More details</summary>
                <small>When enabled, the merged result is automatically pushed to the configured git remote. This includes pulling the latest from the remote first (rebase) and resolving any conflicts with AI if needed.</small>
              </details>
            </div>

            {form.pushAfterMerge && (
              <div className="form-group">
                <label htmlFor="pushRemote">Push Remote</label>
                <input
                  id="pushRemote"
                  type="text"
                  placeholder="origin"
                  value={form.pushRemote || ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, pushRemote: e.target.value || undefined }))
                  }
                />
                <details className="settings-option-details">
                  <summary>More details</summary>
                  <small>Git remote to push to (e.g. "origin"). Can include branch name (e.g. "origin main"). Default: "origin".</small>
                </details>
              </div>
            )}
          </>
        );
      case "agent-permissions":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Agent Permissions</h4>
            <div className="form-group">
              <small className="settings-muted">Per-agent settings override project defaults. Each category controls a separate approval gate.</small>
            </div>
            <AgentPermissionPolicyEditor
              mode="project-default"
              value={form.defaultAgentPermissionPolicy ? { presetId: "custom", rules: toCompleteAgentPermissionRules(form.defaultAgentPermissionPolicy.rules) } : { presetId: "custom", rules: toCompleteAgentPermissionRules() }}
              onChange={(next) =>
                setForm((f) => ({
                  ...f,
                  defaultAgentPermissionPolicy: { rules: toCompleteAgentPermissionRules(next?.rules) },
                }))
              }
            />

            <h4 className="settings-section-heading">Agent Provisioning Approvals</h4>
            <div className="form-group">
              <small className="settings-muted">
                Configure project-level approval behavior for durable provisioning tools (fn_agent_create/fn_agent_delete).
              </small>
            </div>
            <AgentProvisioningPolicyEditor
              value={form.agentProvisioning}
              onChange={(next) => setForm((f) => ({ ...f, agentProvisioning: next }))}
            />
          </>
        );
      case "memory": {
        // Use memory backend status from top-level hook call
        const {
          capabilities,
          status: backendStatus,
          loading: backendLoading,
          error: backendError,
        } = {
          capabilities: memoryCapabilities,
          status: memoryBackendStatus,
          loading: memoryBackendLoading,
          error: memoryBackendError,
        };

        // Determine if editing is allowed
        const isMemoryEnabled = form.memoryEnabled !== false;
        const backendStatusResolved = !backendLoading && backendStatus !== null;
        const isBackendWritable = backendStatusResolved ? (capabilities?.writable ?? true) : true;
        const isEditingAllowed = isMemoryEnabled && isBackendWritable;

        const selectedMemoryFile = memoryFiles.find((file) => file.path === selectedMemoryPath);
        const memoryLayerNames: Record<MemoryFileInfo["layer"], string> = {
          "long-term": "Long-term",
          daily: "Daily",
          dreams: "Dreams",
        };

        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Memory</h4>
            <div className="form-group">
              <small className="settings-muted">
                Memory lives in <code>.fusion/memory/</code>. Agents search with qmd first, fall back to local files when qmd is missing, and open exact line windows only when needed.
              </small>
            </div>

            <div className="form-group">
              <label htmlFor="memoryEnabled" className="checkbox-label">
                <input
                  id="memoryEnabled"
                  type="checkbox"
                  checked={form.memoryEnabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, memoryEnabled: e.target.checked }))
                  }
                />
                Enable memory tools
              </label>
              <small>Agents get memory_search, memory_get, and memory_append tools. Search defaults to qmd with a local file fallback.</small>
            </div>

            {backendLoading ? (
              <div className="form-group">
                <small className="settings-muted">Checking memory write access...</small>
              </div>
            ) : backendError ? (
              <div className="form-group">
                <small className="field-error">Failed to load backend status: {backendError}</small>
              </div>
            ) : null}

            {backendStatusResolved && backendStatus.qmdAvailable === false && (
              <div className="settings-empty-state memory-status-message">
                <span>
                  qmd is not installed. Search will use local files.
                  Install indexed retrieval: <code>{backendStatus.qmdInstallCommand || "bun install -g @tobilu/qmd"}</code>
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleInstallQmd}
                  disabled={qmdInstallLoading}
                >
                  {qmdInstallLoading ? "Installing…" : "Install qmd"}
                </button>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="memoryAutoSummarizeEnabled" className="checkbox-label">
                <input
                  id="memoryAutoSummarizeEnabled"
                  type="checkbox"
                  checked={form.memoryAutoSummarizeEnabled || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, memoryAutoSummarizeEnabled: e.target.checked }))
                  }
                />
                Auto-Summarize Memory
              </label>
              <small>Automatically compact memory when it exceeds the threshold on a schedule</small>
            </div>

            {(form.memoryAutoSummarizeEnabled || false) && (
              <>
                <div className="form-group">
                  <label htmlFor="memoryAutoSummarizeThresholdChars">Compaction Threshold (chars)</label>
                  <input
                    id="memoryAutoSummarizeThresholdChars"
                    type="number"
                    className="input"
                    value={form.memoryAutoSummarizeThresholdChars ?? 50000}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        memoryAutoSummarizeThresholdChars: parseInt(e.target.value, 10) || 50000,
                      }))
                    }
                    min={1000}
                  />
                  <small>Memory will be compacted when it exceeds this character count</small>
                </div>
                <div className="form-group">
                  <label htmlFor="memoryAutoSummarizeSchedule">Schedule (cron)</label>
                  <input
                    id="memoryAutoSummarizeSchedule"
                    type="text"
                    className="input"
                    value={form.memoryAutoSummarizeSchedule ?? "0 3 * * *"}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, memoryAutoSummarizeSchedule: e.target.value }))
                    }
                    placeholder="0 3 * * *"
                  />
                  <small>Cron expression for auto-summarize schedule (default: daily at 3 AM)</small>
                </div>
              </>
            )}

            <div style={{ borderTop: "1px solid var(--border)", margin: "var(--space-lg) 0" }} />

            <div className="form-group">
              <label htmlFor="memoryDreamsEnabled" className="checkbox-label">
                <input
                  id="memoryDreamsEnabled"
                  type="checkbox"
                  checked={form.memoryDreamsEnabled === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, memoryDreamsEnabled: e.target.checked }))
                  }
                  disabled={!isMemoryEnabled}
                />
                Process dreams from daily memory
              </label>
              <small>Turns daily notes into DREAMS.md and promotes reusable lessons into MEMORY.md.</small>
            </div>

            {isMemoryEnabled && form.memoryDreamsEnabled === true && (
              <>
                <div className="form-group">
                  <label htmlFor="memoryDreamsSchedule">Dream Schedule</label>
                  <input
                    id="memoryDreamsSchedule"
                    type="text"
                    value={form.memoryDreamsSchedule ?? "0 4 * * *"}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, memoryDreamsSchedule: e.target.value }))
                    }
                  />
                  <small>Cron expression for dream processing.</small>
                </div>
                <div className="form-group">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleDreamNow}
                    disabled={dreamRunning || form.memoryDreamsEnabled !== true}
                  >
                    {dreamRunning ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Dreaming…
                      </>
                    ) : (
                      "Dream Now"
                    )}
                  </button>
                  <small>Manually trigger dream processing now.</small>
                </div>
              </>
            )}

            <div className="memory-retrieval-test">
              <div className="form-group">
                <label htmlFor="memoryRetrievalQuery">Test Retrieval</label>
                <input
                  id="memoryRetrievalQuery"
                  type="text"
                  value={memoryTestQuery}
                  onChange={(e) => setMemoryTestQuery(e.target.value)}
                  placeholder="Search memory with qmd"
                />
                <small>Runs the same qmd-backed memory_search path agents use.</small>
              </div>
              <div className="form-group">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleTestMemoryRetrieval}
                  disabled={memoryTestLoading}
                >
                  {memoryTestLoading ? "Testing…" : "Test Retrieval"}
                </button>
              </div>
              {memoryTestResult && (
                <div className="memory-test-result">
                  <strong>
                    {memoryTestResult.results.length} result{memoryTestResult.results.length === 1 ? "" : "s"}
                    {" "}for "{memoryTestResult.query}"
                  </strong>
                  <small>
                    qmd {memoryTestResult.qmdAvailable ? "available" : "missing"} · {memoryTestResult.usedFallback ? "local fallback used" : "qmd path used"}
                  </small>
                  {memoryTestResult.results.length > 0 ? (
                    <ul>
                      {memoryTestResult.results.map((result, index) => (
                        <li key={`${result.path}-${result.lineStart}-${index}`}>
                          <span>{result.path}:{result.lineStart}</span>
                          <p>{result.snippet}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <small>No matching memory found.</small>
                  )}
                </div>
              )}
            </div>

            {!isMemoryEnabled && (
              <div className="settings-empty-state memory-status-message">
                Memory is currently disabled. You can view the file, but editing is read-only until memory is re-enabled.
              </div>
            )}
            {isMemoryEnabled && backendStatusResolved && !isBackendWritable && (
              <div className="settings-empty-state memory-status-message">
                Memory is configured with a read-only backend. You can view the file, but saving is disabled.
              </div>
            )}

            {memoryLoading ? (
              <div className="settings-empty-state">Loading memory…</div>
            ) : (
              <div className="memory-editor-section">
                <div className="form-group">
                  <label htmlFor="memoryFilePath">Memory File</label>
                  <select
                    id="memoryFilePath"
                    value={selectedMemoryPath}
                    onChange={(e) => {
                      setSelectedMemoryPath(e.target.value);
                      setMemoryDirty(false);
                    }}
                    disabled={memoryDirty}
                  >
                    {memoryFiles.map((file) => (
                      <option key={file.path} value={file.path} title={`${file.label} — ${file.path}`}>
                        {formatMemoryFileOptionLabel(file)}
                      </option>
                    ))}
                  </select>
                  <small>
                    {memoryDirty
                      ? "Save or discard the current edits before switching files."
                      : "Choose any project memory file to view or edit. Dreams is selected by default."}
                  </small>
                </div>
                {selectedMemoryFile && (
                  <div className="memory-file-summary">
                    <span>{memoryLayerNames[selectedMemoryFile.layer]}</span>
                    <strong>{selectedMemoryFile.path}</strong>
                    <small>
                      {selectedMemoryFile.size.toLocaleString()} bytes · updated {new Date(selectedMemoryFile.updatedAt).toLocaleString()}
                    </small>
                  </div>
                )}
                <div className="form-group memory-editor-form-group">
                  <label>{selectedMemoryFile?.label || "Memory Editor"}</label>
                  <small>
                    {selectedMemoryFile?.layer === "long-term" && "Curated durable decisions, conventions, constraints, and pitfalls promoted from dreams."}
                    {selectedMemoryFile?.layer === "daily" && "Raw daily observations, open loops, and running context for dream processing."}
                    {selectedMemoryFile?.layer === "dreams" && "Synthesized patterns and open loops promoted from daily memory."}
                    {!selectedMemoryFile && "Edits the selected memory file."}
                  </small>
                  <div className="memory-editor-frame">
                    <FileEditor
                      content={memoryContent}
                      onChange={(content) => {
                        setMemoryContent(content);
                        setMemoryDirty(true);
                      }}
                      readOnly={!isEditingAllowed}
                      filePath={selectedMemoryPath}
                    />
                  </div>
                </div>
              </div>
            )}

            {!memoryLoading && (
              <div className="form-group">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleCompactMemory}
                  disabled={!isEditingAllowed || memoryDirty || memoryCompactLoading}
                >
                  {memoryCompactLoading ? "Compacting…" : "Compact Selected File"}
                </button>
                <small>
                  {memoryDirty
                    ? "Save or discard edits before compacting this file."
                    : `Compacts ${selectedMemoryPath} and writes the result back to the same file.`}
                </small>
              </div>
            )}

            {memoryDirty && isEditingAllowed && (
              <div className="form-group">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleSaveMemory}
                >
                  Save Memory
                </button>
              </div>
            )}
            {memoryDirty && !isEditingAllowed && (
              <div className="form-group">
                <small className="field-error">Cannot save: {isMemoryEnabled ? "Backend is read-only" : "Memory is disabled"}</small>
              </div>
            )}
          </>
        );
      }
      case "research-global": {
        const resolvedProvider =
          form.researchGlobalWebSearchProvider ??
          form.researchGlobalDefaults?.searchProvider ??
          "builtin";
        const externalProvider =
          resolvedProvider === "searxng" ||
          resolvedProvider === "brave" ||
          resolvedProvider === "google" ||
          resolvedProvider === "tavily";
        const selectedCredentialProvider =
          resolvedProvider === "brave" || resolvedProvider === "tavily" ? resolvedProvider : null;
        const hasMissingResearchCredential = selectedCredentialProvider
          ? authProviders.some((provider) => provider.id === selectedCredentialProvider && !provider.authenticated)
          : false;

        const setSearchProvider = (provider: Settings["researchGlobalWebSearchProvider"]) => {
          setForm((current) => ({
            ...current,
            researchGlobalWebSearchProvider: provider,
            researchGlobalDefaults: {
              ...(current.researchGlobalDefaults ?? {}),
              searchProvider: provider,
            },
          }));
        };

        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Research Defaults</h4>
            <div className="form-group settings-research-provider-group">
              <label htmlFor="research-global-provider-builtin" className="checkbox-label">
                <input
                  id="research-global-provider-builtin"
                  type="radio"
                  name="research-global-search-provider"
                  checked={!externalProvider}
                  onChange={() => setSearchProvider("builtin")}
                />
                Built-in (uses agent web tools)
              </label>
              <small>
                Searches and fetches use the agent's native WebSearch/WebFetch tools. No API key required.
              </small>
              <details className="settings-option-details settings-research-provider-advanced-details">
                <summary>Advanced — external search providers</summary>
                <div className="form-group">
                  <label htmlFor="research-global-search-provider-advanced">Search Provider</label>
                  <select
                    id="research-global-search-provider-advanced"
                    className="input"
                    value={externalProvider ? resolvedProvider : "searxng"}
                    onChange={(event) =>
                      setSearchProvider(event.target.value as Settings["researchGlobalWebSearchProvider"])
                    }
                  >
                    <option value="searxng">SearXNG</option>
                    <option value="brave">Brave</option>
                    <option value="google">Google Custom Search</option>
                    <option value="tavily">Tavily</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="research-global-searxng-url">SearXNG URL</label>
                  <input
                    id="research-global-searxng-url"
                    className="input"
                    value={form.researchGlobalSearxngUrl ?? ""}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalSearxngUrl: event.target.value || undefined,
                      }))
                    }
                    placeholder="https://searx.example.com"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="research-global-google-cx">Google Search CX</label>
                  <input
                    id="research-global-google-cx"
                    className="input"
                    value={form.researchGlobalGoogleSearchCx ?? ""}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalGoogleSearchCx: event.target.value || undefined,
                      }))
                    }
                    placeholder="custom-search-engine-id"
                  />
                </div>
                <div className="settings-empty-state settings-research-empty-state" role="note">
                  Configure Brave, Tavily, and Google API keys in Authentication.
                  <button type="button" className="btn btn-sm" onClick={() => setActiveSection("authentication")}>
                    Open Authentication Settings
                  </button>
                </div>
              </details>
            </div>
            <div className="form-group">
              <div className="settings-research-limits-grid">
                <div className="settings-research-limit-field">
                  <label htmlFor="research-global-max-concurrent">Default Max Concurrent Runs</label>
                  <input
                    id="research-global-max-concurrent"
                    className="input"
                    type="number"
                    min={1}
                    value={form.researchGlobalMaxConcurrentRuns ?? 3}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalMaxConcurrentRuns: event.target.value === "" ? undefined : Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-global-max-sources">Default Max Sources Per Run</label>
                  <input
                    id="research-global-max-sources"
                    className="input"
                    type="number"
                    min={1}
                    value={form.researchGlobalMaxSourcesPerRun ?? 20}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalMaxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
                        researchGlobalDefaults: {
                          ...(current.researchGlobalDefaults ?? {}),
                          maxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
                        },
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-global-default-timeout">Default Max Duration (ms)</label>
                  <input
                    id="research-global-default-timeout"
                    className="input"
                    type="number"
                    min={1000}
                    value={form.researchGlobalDefaultTimeout ?? 300000}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalDefaultTimeout: event.target.value === "" ? undefined : Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-global-fetch-timeout">Request Timeout (ms)</label>
                  <input
                    id="research-global-fetch-timeout"
                    className="input"
                    type="number"
                    min={1000}
                    value={form.researchGlobalFetchTimeoutMs ?? 30000}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalFetchTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-global-max-synthesis-rounds">Max Synthesis Rounds</label>
                  <input
                    id="research-global-max-synthesis-rounds"
                    className="input"
                    type="number"
                    min={1}
                    value={form.researchGlobalMaxSynthesisRounds ?? 2}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalMaxSynthesisRounds: event.target.value === "" ? undefined : Number(event.target.value),
                      }))
                    }
                  />
                </div>
              </div>
            </div>
            <div className="form-group">
              <label>Enabled Sources</label>
              <label htmlFor="research-global-source-webSearch" className="checkbox-label settings-research-source-locked">
                <input id="research-global-source-webSearch" type="checkbox" checked disabled readOnly />
                Web Search <span className="settings-muted">Always on</span>
              </label>
              <div className="settings-research-source-grid">
                <label htmlFor="research-global-source-github" className="checkbox-label">
                  <input
                    id="research-global-source-github"
                    type="checkbox"
                    checked={form.researchGlobalGitHubEnabled ?? false}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalGitHubEnabled: event.target.checked,
                      }))
                    }
                  />
                  GitHub
                </label>
                <label htmlFor="research-global-source-local-docs" className="checkbox-label">
                  <input
                    id="research-global-source-local-docs"
                    type="checkbox"
                    checked={form.researchGlobalLocalDocsEnabled ?? true}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchGlobalLocalDocsEnabled: event.target.checked,
                      }))
                    }
                  />
                  Local Docs
                </label>
              </div>
            </div>
            {hasMissingResearchCredential && (
              <div className="settings-empty-state" role="alert">
                Missing credentials for the selected research provider.
                <button type="button" className="btn btn-sm" onClick={() => setActiveSection("authentication")}>
                  Open Authentication
                </button>
              </div>
            )}
          </>
        );
      }
      case "research-project": {
        const limits = form.researchSettings?.limits;
        const sources = form.researchSettings?.enabledSources;
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Project Research Settings</h4>
            <div className="form-group">
              <label htmlFor="research-project-enabled" className="checkbox-label">
                <input
                  id="research-project-enabled"
                  type="checkbox"
                  checked={form.researchSettings?.enabled ?? true}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      researchSettings: {
                        ...(current.researchSettings ?? {}),
                        enabled: event.target.checked,
                      },
                    }))
                  }
                />
                Enable research in this project
              </label>
            </div>
            <div className="form-group">
              <label>Enabled Sources</label>
              <label
                htmlFor="research-project-source-webSearch"
                className="checkbox-label settings-research-source-locked"
              >
                <input id="research-project-source-webSearch" type="checkbox" checked disabled readOnly />
                Web Search <span className="settings-muted">Always on</span>
              </label>
              <small className="settings-muted">
                Web search is always enabled. Configure the search provider under Research Defaults.
              </small>
              <div className="settings-research-source-grid">
                {[
                  ["pageFetch", "Page Fetch"],
                  ["github", "GitHub"],
                  ["localDocs", "Local Docs"],
                  ["llmSynthesis", "LLM Synthesis"],
                ].map(([key, label]) => (
                  <label key={key} htmlFor={`research-project-source-${key}`} className="checkbox-label">
                    <input
                      id={`research-project-source-${key}`}
                      type="checkbox"
                      checked={sources?.[key as keyof NonNullable<typeof sources>] ?? false}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          researchSettings: {
                            ...(current.researchSettings ?? {}),
                            enabledSources: {
                              ...(current.researchSettings?.enabledSources ?? {}),
                              [key]: event.target.checked,
                            },
                          },
                        }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group">
              <div className="settings-research-limits-grid">
                <div className="settings-research-limit-field">
                  <label htmlFor="research-project-max-concurrent">Max Concurrent Runs</label>
                  <input
                    id="research-project-max-concurrent"
                    className="input"
                    type="number"
                    min={1}
                    value={limits?.maxConcurrentRuns ?? 3}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchSettings: {
                          ...(current.researchSettings ?? {}),
                          limits: {
                            ...(current.researchSettings?.limits ?? {}),
                            maxConcurrentRuns: event.target.value === "" ? undefined : Number(event.target.value),
                          },
                        },
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-project-max-sources">Max Sources Per Run</label>
                  <input
                    id="research-project-max-sources"
                    className="input"
                    type="number"
                    min={1}
                    value={limits?.maxSourcesPerRun ?? 20}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchSettings: {
                          ...(current.researchSettings ?? {}),
                          limits: {
                            ...(current.researchSettings?.limits ?? {}),
                            maxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
                          },
                        },
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-project-max-duration">Max Duration (ms)</label>
                  <input
                    id="research-project-max-duration"
                    className="input"
                    type="number"
                    min={1000}
                    value={limits?.maxDurationMs ?? 300000}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchSettings: {
                          ...(current.researchSettings ?? {}),
                          limits: {
                            ...(current.researchSettings?.limits ?? {}),
                            maxDurationMs: event.target.value === "" ? undefined : Number(event.target.value),
                          },
                        },
                      }))
                    }
                  />
                </div>
                <div className="settings-research-limit-field">
                  <label htmlFor="research-project-request-timeout">Request Timeout (ms)</label>
                  <input
                    id="research-project-request-timeout"
                    className="input"
                    type="number"
                    min={1000}
                    value={limits?.requestTimeoutMs ?? 30000}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        researchSettings: {
                          ...(current.researchSettings ?? {}),
                          limits: {
                            ...(current.researchSettings?.limits ?? {}),
                            requestTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value),
                          },
                        },
                      }))
                    }
                  />
                </div>
                {researchLimitError && <small className="field-error settings-research-limits-error">{researchLimitError}</small>}
              </div>
            </div>
          </>
        );
      }
      case "experimental": {
        const experimentalFeatures = form.experimentalFeatures ?? {};
        // Merge known features (always shown) with custom features from settings,
        // while canonicalizing legacy aliases (e.g. devServer → devServerView)
        // so only one user-visible row is rendered per feature.
        const allFeatureKeys = Array.from(
          new Set([
            ...Object.keys(KNOWN_EXPERIMENTAL_FEATURES),
            ...Object.keys(experimentalFeatures).map(getCanonicalExperimentalFeatureKey),
          ])
        ).sort((a, b) => a.localeCompare(b));
        const featureFlags = allFeatureKeys.map((key) => [key, isExperimentalFeatureEnabled(experimentalFeatures, key)] as const);

        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Experimental Features</h4>
            <div className="form-group">
              <small>
                Experimental features are early capabilities that are not yet fully stable.
                Enable them to test new functionality, but be aware they may change or be removed.
              </small>
            </div>

            <div className="form-group">
              <label>Feature Flags</label>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                {featureFlags.map(([key, enabled]) => (
                  <label key={key} htmlFor={`experimental-${key}`} className="checkbox-label">
                    <input
                      id={`experimental-${key}`}
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        setForm((f) => {
                          const nextExperimentalFeatures = {
                            ...(f.experimentalFeatures ?? {}),
                            [key]: e.target.checked,
                          };

                          for (const [legacyKey, canonicalKey] of Object.entries(EXPERIMENTAL_FEATURE_LEGACY_ALIASES)) {
                            if (canonicalKey === key) {
                              delete nextExperimentalFeatures[legacyKey];
                            }
                          }

                          return {
                            ...f,
                            experimentalFeatures: nextExperimentalFeatures,
                          };
                        });
                      }}
                    />
                    <span>{KNOWN_EXPERIMENTAL_FEATURES[key] ?? key}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        );
      }
      case "backups":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Database Backups</h4>
            <div className="form-group">
              <label htmlFor="autoBackupEnabled" className="checkbox-label">
                <input
                  id="autoBackupEnabled"
                  type="checkbox"
                  checked={form.autoBackupEnabled || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, autoBackupEnabled: e.target.checked }))
                  }
                />
                Enable automatic database backups
              </label>
              <small>When enabled, the database is backed up automatically on a schedule</small>
            </div>
            <div className="form-group">
              <label htmlFor="autoBackupSchedule">Backup Schedule (Cron)</label>
              <input
                id="autoBackupSchedule"
                type="text"
                placeholder="0 2 * * *"
                value={form.autoBackupSchedule || "0 2 * * *"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, autoBackupSchedule: e.target.value }))
                }
                disabled={!form.autoBackupEnabled}
              />
              <small>
                Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM).
                Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min)
              </small>
              {form.autoBackupSchedule && !/^[\s\d*,/-]+$/.test(form.autoBackupSchedule) && (
                <small className="field-error">Invalid cron expression format</small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="autoBackupRetention">Retention Count</label>
              <input
                id="autoBackupRetention"
                type="number"
                min={1}
                max={100}
                value={form.autoBackupRetention ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, autoBackupRetention: val === "" ? undefined : Number(val) }));
                }}
                disabled={!form.autoBackupEnabled}
              />
              <small>Number of backup files to keep (oldest are deleted first). Range: 1-100.</small>
              {form.autoBackupRetention !== undefined && (form.autoBackupRetention < 1 || form.autoBackupRetention > 100) && (
                <small className="field-error">Must be between 1 and 100</small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="autoBackupDir">Backup Directory</label>
              <input
                id="autoBackupDir"
                type="text"
                placeholder=".fusion/backups"
                value={form.autoBackupDir || ".fusion/backups"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, autoBackupDir: e.target.value }))
                }
                disabled={!form.autoBackupEnabled}
              />
              <small>Directory for backup files, relative to project root</small>
              {form.autoBackupDir && form.autoBackupDir.includes("..") && (
                <small className="field-error">Path cannot contain parent directory traversal (..)</small>
              )}
            </div>

            <h4 className="settings-section-heading">Memory Backups</h4>
            <div className="form-group">
              <label htmlFor="memoryBackupEnabled" className="checkbox-label">
                <input
                  id="memoryBackupEnabled"
                  type="checkbox"
                  checked={form.memoryBackupEnabled || false}
                  onChange={(e) => setForm((f) => ({ ...f, memoryBackupEnabled: e.target.checked }))}
                />
                Enable automatic memory backups
              </label>
              <small>When enabled, project and agent memory files are backed up automatically on a schedule.</small>
            </div>
            <div className="form-group">
              <label htmlFor="memoryBackupSchedule">Memory Backup Schedule (Cron)</label>
              <input
                id="memoryBackupSchedule"
                type="text"
                placeholder="0 3 * * *"
                value={form.memoryBackupSchedule || "0 3 * * *"}
                onChange={(e) => setForm((f) => ({ ...f, memoryBackupSchedule: e.target.value }))}
                disabled={!form.memoryBackupEnabled}
              />
              <small>Cron expression for memory backup timing. Default: 0 3 * * * (daily at 3 AM).</small>
              {form.memoryBackupSchedule && !/^[\s\d*,/-]+$/.test(form.memoryBackupSchedule) && (
                <small className="field-error">Invalid cron expression format</small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="memoryBackupRetention">Memory Retention Count</label>
              <input
                id="memoryBackupRetention"
                type="number"
                min={1}
                max={100}
                value={form.memoryBackupRetention ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((f) => ({ ...f, memoryBackupRetention: val === "" ? undefined : Number(val) }));
                }}
                disabled={!form.memoryBackupEnabled}
              />
              <small>Number of memory backups to keep (oldest are deleted first). Range: 1-100.</small>
              {form.memoryBackupRetention !== undefined && (form.memoryBackupRetention < 1 || form.memoryBackupRetention > 100) && (
                <small className="field-error">Must be between 1 and 100</small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="memoryBackupDir">Memory Backup Directory</label>
              <input
                id="memoryBackupDir"
                type="text"
                placeholder=".fusion/backups/memory"
                value={form.memoryBackupDir || ".fusion/backups/memory"}
                onChange={(e) => setForm((f) => ({ ...f, memoryBackupDir: e.target.value }))}
                disabled={!form.memoryBackupEnabled}
              />
              <small>Directory for memory backups, relative to project root.</small>
              {form.memoryBackupDir && form.memoryBackupDir.includes("..") && (
                <small className="field-error">Path cannot contain parent directory traversal (..)</small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="memoryBackupScope">Memory Backup Scope</label>
              <select
                id="memoryBackupScope"
                value={form.memoryBackupScope || "all"}
                onChange={(e) => setForm((f) => ({ ...f, memoryBackupScope: e.target.value as "project" | "agents" | "all" }))}
                disabled={!form.memoryBackupEnabled}
              >
                <option value="all">All (project + agents)</option>
                <option value="project">Project only (.fusion/memory)</option>
                <option value="agents">Agents only (.fusion/agent-memory)</option>
              </select>
            </div>
            {backupLoading ? (
              <div className="settings-empty-state">Loading backup info…</div>
            ) : backupInfo ? (
              <div className="form-group">
                <label>Current Backups</label>
                <div className="backup-stats">
                  <div className="backup-stat">
                    <span className="backup-stat-value">{backupInfo.count}</span>
                    <span className="backup-stat-label">backups</span>
                  </div>
                  <div className="backup-stat">
                    <span className="backup-stat-value">
                      {backupInfo.totalSize > 1024 * 1024
                        ? `${(backupInfo.totalSize / (1024 * 1024)).toFixed(1)} MB`
                        : `${(backupInfo.totalSize / 1024).toFixed(1)} KB`}
                    </span>
                    <span className="backup-stat-label">total size</span>
                  </div>
                </div>
                {backupInfo.backups.length > 0 && (
                  <details className="backup-list">
                    <summary>View {backupInfo.backups.length} backup(s)</summary>
                    <ul>
                      {backupInfo.backups.slice(0, 10).map((backup) => (
                        <li key={backup.filename}>
                          <code>{backup.filename}</code>
                          <span className="backup-size">
                            {backup.size > 1024 * 1024
                              ? `${(backup.size / (1024 * 1024)).toFixed(1)} MB`
                              : `${(backup.size / 1024).toFixed(1)} KB`}
                          </span>
                        </li>
                      ))}
                      {backupInfo.backups.length > 10 && (
                        <li><em>...and {backupInfo.backups.length - 10} more</em></li>
                      )}
                    </ul>
                  </details>
                )}
              </div>
            ) : null}
            <div className="form-group">
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleBackupNow}
                disabled={backupLoading}
              >
                {backupLoading ? "Creating…" : "Backup Now"}
              </button>
            </div>
          </>
        );
      case "notifications":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Notifications</h4>

            <div className="notification-provider-card">
              <div className="form-group">
                <label htmlFor="failureNotificationMode">Failure notification mode</label>
                <select
                  id="failureNotificationMode"
                  value={form.failureNotificationMode ?? "sticky-only"}
                  onChange={(e) => {
                    const value = e.target.value as "sticky-only" | "all" | "terminal-only";
                    setForm((f) => ({ ...f, failureNotificationMode: value }));
                  }}
                >
                  <option value="sticky-only">Sticky failures only (default)</option>
                  <option value="terminal-only">Terminal failures only (suppress auto-retried)</option>
                  <option value="all">All failures (legacy)</option>
                </select>
                <small>Sticky-only suppresses recovered failures; terminal-only waits for paused/in-review failed tasks; all restores legacy alerts.</small>
              </div>
              <div className="form-group">
                <label htmlFor="failureNotificationDelayMs">Failure notification delay (ms)</label>
                <input
                  id="failureNotificationDelayMs"
                  type="number"
                  min={0}
                  step={1000}
                  disabled={(form.failureNotificationMode ?? "sticky-only") === "all"}
                  value={form.failureNotificationDelayMs ?? 30000}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    setForm((f) => ({
                      ...f,
                      failureNotificationDelayMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
                    }));
                  }}
                />
                <small>
                  How long a failure must persist before a push notification is sent. 0 = notify immediately.
                </small>
              </div>
            </div>

            <div className="notification-provider-card">
              <div className="notification-provider-header">
                <strong>ntfy</strong>
                <label htmlFor="ntfyEnabled" className="checkbox-label">
                  <input
                    id="ntfyEnabled"
                    type="checkbox"
                    checked={form.ntfyEnabled || false}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, ntfyEnabled: e.target.checked }))
                    }
                  />
                  Enable
                </label>
              </div>
              {form.ntfyEnabled && (
                <div className="notification-provider-body">
                  <div className="form-group">
                    <label htmlFor="ntfyTopic">ntfy Topic</label>
                    <input
                      id="ntfyTopic"
                      type="text"
                      placeholder="my-topic-name"
                      value={form.ntfyTopic || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setForm((f) => ({ ...f, ntfyTopic: val || undefined }));
                      }}
                    />
                    <small>
                      Your ntfy.sh topic name (1–64 alphanumeric/hyphen/underscore characters).{" "}
                      <a
                        href="https://ntfy.sh"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settings-inline-link"
                      >
                        Learn more about ntfy.sh
                      </a>
                    </small>
                    {form.ntfyTopic && !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic) && (
                      <small className="field-error">
                        Topic must be 1–64 alphanumeric, hyphen, or underscore characters
                      </small>
                    )}
                    <details className="ntfy-advanced-disclosure">
                      <summary>Advanced</summary>
                      <div className="ntfy-advanced-content">
                        <label htmlFor="ntfyBaseUrl">Custom ntfy server URL (optional)</label>
                        <input
                          id="ntfyBaseUrl"
                          type="url"
                          placeholder="https://ntfy.sh"
                          value={form.ntfyBaseUrl || ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setForm((f) => ({ ...f, ntfyBaseUrl: value || undefined }));
                          }}
                        />
                        <small>
                          Leave blank to keep the default server: https://ntfy.sh. Custom servers must use http:// or https://.
                        </small>
                        <label htmlFor="ntfyAccessToken">Access token (optional)</label>
                        <input
                          id="ntfyAccessToken"
                          type="password"
                          autoComplete="off"
                          placeholder="tk_..."
                          value={form.ntfyAccessToken || ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setForm((f) => ({ ...f, ntfyAccessToken: value || undefined }));
                          }}
                        />
                        <small>
                          Leave blank to publish without authentication. When set, Fusion sends an Authorization Bearer header with ntfy requests.
                        </small>
                      </div>
                    </details>
                  </div>
                  <div className="form-group">
                    <label>Notify on events</label>
                    <div className="ntfy-events-list">
                      {NOTIFICATION_EVENT_OPTIONS.map(({ event, label, description }) => {
                        const checked = form.ntfyEvents?.includes(event) ?? true;
                        return (
                          <div key={`ntfy-${event}`}>
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                                  const newEvents = e.target.checked
                                    ? (current.includes(event) ? current : [...current, event])
                                    : current.filter((ev): ev is NtfyNotificationEvent => ev !== event);
                                  setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                                }}
                              />
                              {label}
                            </label>
                            <small>{description}</small>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="ntfyDashboardHost">Dashboard Hostname</label>
                    <input
                      id="ntfyDashboardHost"
                      type="text"
                      placeholder="http://localhost:3000"
                      value={form.ntfyDashboardHost || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setForm((f) => ({ ...f, ntfyDashboardHost: val || undefined }));
                      }}
                    />
                    <small>
                      Base URL for deep links in notifications. When set, clicking a notification
                      opens the dashboard directly to the task.
                    </small>
                    {form.ntfyDashboardHost && !/^https?:\/\/.+/.test(form.ntfyDashboardHost) && (
                      <small className="field-error">
                        Must be a valid URL starting with http:// or https://
                      </small>
                    )}
                  </div>
                  <div className="notification-provider-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleTestProviderNotification("ntfy")}
                      disabled={
                        testNotificationLoading["ntfy"] ||
                        testNotificationLoading["ntfy-message"] ||
                        testNotificationLoading["ntfy-room"] ||
                        !form.ntfyEnabled ||
                        !form.ntfyTopic ||
                        !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)
                      }
                    >
                      {testNotificationLoading["ntfy"] ? "Sending…" : "Test notification"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleTestProviderNotification("ntfy-message")}
                      disabled={
                        testNotificationLoading["ntfy"] ||
                        testNotificationLoading["ntfy-message"] ||
                        testNotificationLoading["ntfy-room"] ||
                        !form.ntfyEnabled ||
                        !form.ntfyTopic ||
                        !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)
                      }
                    >
                      {testNotificationLoading["ntfy-message"] ? "Sending…" : "Test message inbox"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleTestProviderNotification("ntfy-room")}
                      disabled={
                        testNotificationLoading["ntfy"] ||
                        testNotificationLoading["ntfy-message"] ||
                        testNotificationLoading["ntfy-room"] ||
                        !form.ntfyEnabled ||
                        !form.ntfyTopic ||
                        !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)
                      }
                    >
                      {testNotificationLoading["ntfy-room"] ? "Sending…" : "Test room reply"}
                    </button>
                  </div>
                  {(testNotificationResult["ntfy"] || testNotificationResult["ntfy-message"] || testNotificationResult["ntfy-room"]) && (
                    <div className="notification-test-feedback" aria-live="polite">
                      {testNotificationResult["ntfy"] && (
                        <small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["ntfy"].status}`}>
                          General: {testNotificationResult["ntfy"].message}
                        </small>
                      )}
                      {testNotificationResult["ntfy-message"] && (
                        <small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["ntfy-message"].status}`}>
                          Message inbox: {testNotificationResult["ntfy-message"].message}
                        </small>
                      )}
                      {testNotificationResult["ntfy-room"] && (
                        <small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["ntfy-room"].status}`}>
                          Room reply: {testNotificationResult["ntfy-room"].message}
                        </small>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="notification-provider-card">
              <div className="notification-provider-header">
                <strong>Webhook</strong>
                <label htmlFor="webhookEnabled" className="checkbox-label">
                  <input
                    id="webhookEnabled"
                    type="checkbox"
                    checked={form.webhookEnabled || false}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, webhookEnabled: e.target.checked }))
                    }
                  />
                  Webhook notifications
                </label>
              </div>
              {form.webhookEnabled && (
                <div className="notification-provider-body">
                  <div className="form-group">
                    <label htmlFor="webhookUrl">Webhook URL</label>
                    <input
                      id="webhookUrl"
                      type="text"
                      placeholder="https://hooks.example.com/..."
                      value={form.webhookUrl || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setForm((f) => ({ ...f, webhookUrl: val || undefined }));
                      }}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="webhookFormat">Format</label>
                    <select
                      id="webhookFormat"
                      value={form.webhookFormat || "generic"}
                      onChange={(e) => {
                        const val = e.target.value as "slack" | "discord" | "generic";
                        setForm((f) => ({ ...f, webhookFormat: val }));
                      }}
                    >
                      <option value="slack">Slack</option>
                      <option value="discord">Discord</option>
                      <option value="generic">Generic</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Notify on events</label>
                    <div className="ntfy-events-list">
                      {NOTIFICATION_EVENT_OPTIONS.map(({ event, label, description }) => {
                        const currentEvents = form.webhookEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const checked = currentEvents.includes(event);
                        return (
                          <div key={`webhook-${event}`}>
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const current = form.webhookEvents ?? [...DEFAULT_NTFY_EVENTS];
                                  const newEvents = e.target.checked
                                    ? (current.includes(event) ? current : [...current, event])
                                    : current.filter((ev) => ev !== event);
                                  setForm((f) => ({ ...f, webhookEvents: newEvents.length > 0 ? newEvents : undefined }));
                                }}
                              />
                              {label}
                            </label>
                            <small>{description}</small>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="notification-provider-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleTestProviderNotification("webhook")}
                      disabled={testNotificationLoading["webhook"] || !form.webhookUrl}
                    >
                      {testNotificationLoading["webhook"] ? "Sending…" : "Test notification"}
                    </button>
                  </div>
                  {testNotificationResult["webhook"] && (
                    <div className="notification-test-feedback" aria-live="polite">
                      <small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["webhook"].status}`}>
                        {testNotificationResult["webhook"].message}
                      </small>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        );
      case "node-sync":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Node Sync</h4>
            <div className="form-group">
              <label htmlFor="settingsSyncEnabled" className="checkbox-label">
                <input
                  id="settingsSyncEnabled"
                  type="checkbox"
                  checked={form.settingsSyncEnabled || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, settingsSyncEnabled: e.target.checked }))
                  }
                />
                Enable automatic settings sync
              </label>
              <small>Automatically synchronize settings between this node and connected remote nodes</small>
            </div>
            {form.settingsSyncEnabled && (
              <>
                <div className="form-group">
                  <label htmlFor="settingsSyncAuth" className="checkbox-label">
                    <input
                      id="settingsSyncAuth"
                      type="checkbox"
                      checked={form.settingsSyncAuth || false}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, settingsSyncAuth: e.target.checked }))
                      }
                    />
                    Sync model auth credentials
                  </label>
                  <small>Include API keys and OAuth tokens in sync operations</small>
                </div>
                <div className="form-group">
                  <label htmlFor="settingsSyncInterval">Sync interval</label>
                  <select
                    id="settingsSyncInterval"
                    className="select"
                    value={form.settingsSyncInterval || 900000}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, settingsSyncInterval: parseInt(e.target.value, 10) }))
                    }
                  >
                    <option value={300000}>Every 5 minutes</option>
                    <option value={900000}>Every 15 minutes</option>
                    <option value={1800000}>Every 30 minutes</option>
                    <option value={3600000}>Every 1 hour</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="settingsSyncConflictResolution">Conflict resolution</label>
                  <select
                    id="settingsSyncConflictResolution"
                    className="select"
                    value={form.settingsSyncConflictResolution || "last-write-wins"}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, settingsSyncConflictResolution: e.target.value as "last-write-wins" | "always-ask" | "keep-local" | "keep-remote" }))
                    }
                  >
                    <option value="last-write-wins">Last write wins</option>
                    <option value="always-ask">Always ask</option>
                    <option value="keep-local">Keep local</option>
                    <option value="keep-remote">Keep remote</option>
                  </select>
                </div>
              </>
            )}
          </>
        );
      case "remote": {
        const remoteForm = form as Record<string, unknown>;
        const activeProvider = (remoteForm.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null;
        const tunnelState = (remoteStatus?.state as RemoteStatus["state"] | "error" | undefined) ?? "stopped";
        const statusColor = tunnelState === "running"
          ? "running"
          : tunnelState === "starting"
            ? "starting"
            : tunnelState === "failed" || tunnelState === "error"
              ? "error"
              : "stopped";

        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Remote Access</h4>
            <div className={`remote-status-bar remote-status-bar--${statusColor}`}>
              <span className={`remote-status-dot remote-status-dot--${statusColor}`} />
              <strong>{tunnelState}</strong>
              {remoteStatus?.provider && <span> · {remoteStatus.provider}</span>}
              {remoteStatus?.url && <code className="remote-status-url">{remoteStatus.url}</code>}
              {remoteStatus?.lastError && <span className="field-error">{remoteStatus.lastError}</span>}
            </div>
            {tunnelState === "stopped" && externalTunnel && (
              <div className="remote-external-tunnel-panel" role="status">
                <div className="remote-external-tunnel-header">
                  <Globe aria-hidden="true" />
                  <strong>External {externalTunnel.provider} tunnel detected</strong>
                </div>
                {externalTunnel.url && <code className="settings-url-output">{externalTunnel.url}</code>}
                {tunnelShareLink?.qrSvg && (
                  <div className="remote-external-tunnel-qr">
                    <small>Scan to open:</small>
                    <img
                      src={`data:image/svg+xml;utf8,${encodeURIComponent(tunnelShareLink.qrSvg)}`}
                      alt="External tunnel QR code"
                      className="settings-qr-preview-image"
                    />
                  </div>
                )}
              </div>
            )}
            {tunnelState === "running" && (remoteStatus?.url || tunnelShareLink) && (() => {
              let accessCode: string | null = null;
              let tailnetUrl: string | null = remoteStatus?.url ?? null;
              if (tunnelShareLink?.url) {
                try {
                  const parsed = new URL(tunnelShareLink.url);
                  accessCode = parsed.searchParams.get("rt");
                  if (!tailnetUrl) tailnetUrl = `${parsed.origin}/`;
                } catch {
                  // fall through
                }
              }
              return (
                <div className="remote-share-block">
                  {tailnetUrl && (
                    <div className="remote-share-row">
                      <small>Tailnet URL:</small>
                      <code className="settings-url-output">{tailnetUrl}</code>
                    </div>
                  )}
                  {accessCode && (
                    <div className="remote-share-row">
                      <small>Remote access code:</small>
                      <code className="settings-url-output">{accessCode}</code>
                    </div>
                  )}
                  {tunnelShareLink?.qrSvg && (
                    <div className="remote-share-row">
                      <small>Scan to connect:</small>
                      <img
                        src={`data:image/svg+xml;utf8,${encodeURIComponent(tunnelShareLink.qrSvg)}`}
                        alt="Remote access QR code"
                        className="settings-qr-preview-image"
                      />
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="form-group">
              <div className="remote-provider-selector" role="radiogroup" aria-label="Remote provider">
                <label className="remote-provider-option">
                  <input type="radio" name="remoteProvider" value="tailscale" checked={activeProvider === "tailscale"} onChange={() => setForm((f) => ({ ...f, remoteActiveProvider: "tailscale" } as SettingsFormState))} />
                  <span>
                    <span className="remote-provider-option-content">
                      <span data-testid="remote-provider-icon-tailscale" aria-hidden="true"><Globe size={16} /></span>
                      <span>Tailscale</span>
                    </span>
                  </span>
                </label>
                <label className="remote-provider-option">
                  <input type="radio" name="remoteProvider" value="cloudflare" checked={activeProvider === "cloudflare"} onChange={() => setForm((f) => ({ ...f, remoteActiveProvider: "cloudflare" } as SettingsFormState))} />
                  <span>
                    <span className="remote-provider-option-content">
                      <span data-testid="remote-provider-icon-cloudflare" aria-hidden="true" className="remote-provider-option-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" data-testid="remote-cloudflare-option-icon">
                          <path d="M7 16.5h10.8a2.9 2.9 0 0 0 .3-5.8 4.9 4.9 0 0 0-9.3-1.6A3.6 3.6 0 0 0 7 16.5m-1.9 0h3.2a2.5 2.5 0 0 0 .2-5 3.4 3.4 0 0 0-3.4 3.4c0 .6 0 1 .2 1.6" fill="var(--provider-cloudflare)" />
                        </svg>
                      </span>
                      <span>Cloudflare</span>
                    </span>
                  </span>
                </label>
              </div>
              {!activeProvider && <small>Select a provider above to configure remote access.</small>}
            </div>

            {activeProvider === "cloudflare" && remoteStatus?.cloudflaredAvailable === true && (
              <div className="remote-cli-detection remote-cli-detection--available" role="status">
                <CheckCircle aria-hidden="true" />
                <span>cloudflared is installed</span>
              </div>
            )}

            {activeProvider === "cloudflare" && remoteStatus?.cloudflaredAvailable === false && (
              <div className="remote-cli-detection remote-cli-detection--missing" role="status">
                <AlertTriangle aria-hidden="true" />
                <div className="remote-cli-detection-content">
                  <span>cloudflared is not installed</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={cloudflaredInstalling || remoteBusyAction !== null}
                    onClick={() => void handleInstallCloudflared()}
                  >
                    {cloudflaredInstalling ? "Installing…" : "Install cloudflared"}
                  </button>
                  {cloudflaredInstallError && <small className="remote-cli-install-error">{cloudflaredInstallError}</small>}
                  <small className="remote-cli-manual">Manual install: <code>{cloudflaredManualInstallCommand()}</code></small>
                  {cloudflaredMacFallbackCommand()
                    ? <small className="remote-cli-manual">If Homebrew is unavailable: <code>{cloudflaredMacFallbackCommand()}</code></small>
                    : null}
                </div>
              </div>
            )}

            {activeProvider && (
              <div className="form-group remote-provider-settings">
                {activeProvider === "tailscale" ? (
                  <>
                    <small>Tailscale Funnel will expose this dashboard on your tailnet's public {`https://<machine>.<tailnet>.ts.net/`} URL — no hostname or port configuration needed.</small>
                    <label htmlFor="remoteTailscaleAcceptRoutes" className="checkbox-label">
                      <input id="remoteTailscaleAcceptRoutes" type="checkbox" checked={Boolean(remoteForm.remoteTailscaleAcceptRoutes)} onChange={(e) => setForm((f) => ({ ...f, remoteTailscaleAcceptRoutes: e.target.checked } as SettingsFormState))} />
                      Accept routes
                    </label>
                  </>
                ) : (
                  <>
                    <small>
                      {(remoteForm.remoteCloudflareQuickTunnel ?? true)
                        ? "Using Quick Tunnel — automatically creates a random trycloudflare.com URL, no account needed."
                        : "Named Tunnel mode enabled — configure tunnel name, token, and ingress URL below."}
                    </small>
                    <details
                      className="remote-cf-advanced-details"
                      open={!(remoteForm.remoteCloudflareQuickTunnel ?? true)}
                      onToggle={(event) => {
                        const detailsOpen = event.currentTarget.open;
                        setForm((f) => {
                          const currentQuickTunnel = Boolean((f as Record<string, unknown>).remoteCloudflareQuickTunnel ?? true);
                          const nextQuickTunnel = !detailsOpen;
                          if (currentQuickTunnel === nextQuickTunnel) {
                            return f;
                          }
                          return { ...f, remoteCloudflareQuickTunnel: nextQuickTunnel } as SettingsFormState;
                        });
                      }}
                    >
                      <summary>Advanced (Named Tunnel)</summary>
                      {!(remoteForm.remoteCloudflareQuickTunnel ?? true) ? (
                        <div className="remote-cf-advanced-fields">
                          <label htmlFor="remoteCloudflareTunnelName">Tunnel name</label>
                          <input id="remoteCloudflareTunnelName" type="text" placeholder="Tunnel name" value={String(remoteForm.remoteCloudflareTunnelName ?? "")} onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareTunnelName: e.target.value } as SettingsFormState))} />
                          <label htmlFor="remoteCloudflareTunnelToken">Tunnel token</label>
                          <input id="remoteCloudflareTunnelToken" type="password" placeholder="Tunnel token" value={String(remoteForm.remoteCloudflareTunnelToken ?? "")} onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareTunnelToken: e.target.value } as SettingsFormState))} />
                          <label htmlFor="remoteCloudflareIngressUrl">Ingress URL</label>
                          <input id="remoteCloudflareIngressUrl" type="text" placeholder="https://your-domain.example" value={String(remoteForm.remoteCloudflareIngressUrl ?? "")} onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareIngressUrl: e.target.value } as SettingsFormState))} />
                        </div>
                      ) : null}
                    </details>
                  </>
                )}
              </div>
            )}

            <div className="form-group remote-tunnel-actions">
              {tunnelState === "running" || tunnelState === "starting" ? (
                <button type="button" className="btn btn-danger" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("stop", async () => {
                  await stopRemoteTunnel(projectId);
                  addToast("Remote tunnel stopped", "success");
                })}>
                  {remoteBusyAction === "stop" ? "Stopping…" : "Stop Tunnel"}
                </button>
              ) : (
                <>
                  {externalTunnel ? (
                    <div className="remote-external-tunnel-actions">
                      <button type="button" className="btn" disabled={!activeProvider || remoteBusyAction !== null} onClick={() => void runRemoteAction("start fresh", async () => {
                        const formState = form as Record<string, unknown>;
                        const savePayload: Partial<RemoteSettings> = {
                          remoteActiveProvider: activeProvider,
                          remoteTailscaleEnabled: activeProvider === "tailscale",
                          remoteTailscaleHostname: String(formState.remoteTailscaleHostname ?? ""),
                          remoteTailscaleTargetPort: Number(formState.remoteTailscaleTargetPort ?? 4040),
                          remoteTailscaleAcceptRoutes: Boolean(formState.remoteTailscaleAcceptRoutes),
                          remoteCloudflareEnabled: activeProvider === "cloudflare",
                          remoteCloudflareQuickTunnel: Boolean(formState.remoteCloudflareQuickTunnel ?? true),
                          remoteCloudflareTunnelName: String(formState.remoteCloudflareTunnelName ?? ""),
                          remoteCloudflareTunnelToken: (formState.remoteCloudflareTunnelToken as string | null) || null,
                          remoteCloudflareIngressUrl: String(formState.remoteCloudflareIngressUrl ?? ""),
                          remoteShortLivedEnabled: Boolean(formState.remoteShortLivedEnabled),
                          remoteShortLivedTtlMs: Number(formState.remoteShortLivedTtlMs ?? 900000),
                          remoteRememberLastRunning: Boolean(formState.remoteRememberLastRunning),
                        };
                        await updateRemoteSettings(savePayload, projectId);
                        await killExternalTunnel(projectId);
                        await startRemoteTunnel(projectId);
                        addToast("Remote tunnel restarted", "success");
                      })}>
                        {remoteBusyAction === "start fresh" ? "Restarting…" : "Start Fresh"}
                      </button>
                      <button type="button" className="btn btn-primary" disabled={!activeProvider || remoteBusyAction !== null} onClick={() => void runRemoteAction("use existing", async () => {
                        const formState = form as Record<string, unknown>;
                        const savePayload: Partial<RemoteSettings> = {
                          remoteActiveProvider: activeProvider,
                          remoteTailscaleEnabled: activeProvider === "tailscale",
                          remoteTailscaleHostname: String(formState.remoteTailscaleHostname ?? ""),
                          remoteTailscaleTargetPort: Number(formState.remoteTailscaleTargetPort ?? 4040),
                          remoteTailscaleAcceptRoutes: Boolean(formState.remoteTailscaleAcceptRoutes),
                          remoteCloudflareEnabled: activeProvider === "cloudflare",
                          remoteCloudflareQuickTunnel: Boolean(formState.remoteCloudflareQuickTunnel ?? true),
                          remoteCloudflareTunnelName: String(formState.remoteCloudflareTunnelName ?? ""),
                          remoteCloudflareTunnelToken: (formState.remoteCloudflareTunnelToken as string | null) || null,
                          remoteCloudflareIngressUrl: String(formState.remoteCloudflareIngressUrl ?? ""),
                          remoteShortLivedEnabled: Boolean(formState.remoteShortLivedEnabled),
                          remoteShortLivedTtlMs: Number(formState.remoteShortLivedTtlMs ?? 900000),
                          remoteRememberLastRunning: Boolean(formState.remoteRememberLastRunning),
                        };
                        await updateRemoteSettings(savePayload, projectId);
                        await startRemoteTunnel(projectId);
                        addToast("Remote tunnel started", "success");
                      })}>
                        {remoteBusyAction === "use existing" ? "Starting…" : "Use Existing"}
                      </button>
                    </div>
                  ) : (
                  <button type="button" className="btn btn-primary" disabled={!activeProvider || remoteBusyAction !== null} onClick={() => void runRemoteAction("start", async () => {
                    const formState = form as Record<string, unknown>;
                    const savePayload: Partial<RemoteSettings> = {
                      remoteActiveProvider: activeProvider,
                      remoteTailscaleEnabled: activeProvider === "tailscale",
                      remoteTailscaleHostname: String(formState.remoteTailscaleHostname ?? ""),
                      // Server overrides this with req.socket.localPort
                      // when starting the tunnel; the value sent here is
                      // only a fallback if that override doesn't fire.
                      remoteTailscaleTargetPort: Number(formState.remoteTailscaleTargetPort ?? 4040),
                      remoteTailscaleAcceptRoutes: Boolean(formState.remoteTailscaleAcceptRoutes),
                      remoteCloudflareEnabled: activeProvider === "cloudflare",
                      remoteCloudflareQuickTunnel: Boolean(formState.remoteCloudflareQuickTunnel ?? true),
                      remoteCloudflareTunnelName: String(formState.remoteCloudflareTunnelName ?? ""),
                      remoteCloudflareTunnelToken: (formState.remoteCloudflareTunnelToken as string | null) || null,
                      remoteCloudflareIngressUrl: String(formState.remoteCloudflareIngressUrl ?? ""),
                      remoteShortLivedEnabled: Boolean(formState.remoteShortLivedEnabled),
                      remoteShortLivedTtlMs: Number(formState.remoteShortLivedTtlMs ?? 900000),
                      remoteRememberLastRunning: Boolean(formState.remoteRememberLastRunning),
                    };
                    await updateRemoteSettings(savePayload, projectId);
                    await startRemoteTunnel(projectId);
                    addToast("Remote tunnel started", "success");
                  })}>
                    {remoteBusyAction === "start" ? "Starting…" : "Start Tunnel"}
                  </button>
                  )}
                  {activeProvider === "cloudflare" && remoteStatus?.cloudflaredAvailable === false ? (
                    <small className="field-error">cloudflared must be installed to start the tunnel</small>
                  ) : null}
                </>
              )}
            </div>

            <details className="remote-advanced-details">
              <summary>Advanced Settings</summary>
              <div className="form-group">
                <label htmlFor="remoteShortLivedEnabled" className="checkbox-label">
                  <input id="remoteShortLivedEnabled" type="checkbox" checked={Boolean(remoteForm.remoteShortLivedEnabled)} onChange={(e) => setForm((f) => ({ ...f, remoteShortLivedEnabled: e.target.checked } as SettingsFormState))} />
                  Enable short-lived tokens
                </label>
                <label htmlFor="remoteShortLivedTtlMs">Short-lived TTL (ms)</label>
                <input id="remoteShortLivedTtlMs" type="number" min={60000} max={86400000} value={Number(remoteForm.remoteShortLivedTtlMs ?? 900000)} onChange={(e) => setForm((f) => ({ ...f, remoteShortLivedTtlMs: Number(e.target.value || 900000) } as SettingsFormState))} />
                {remoteShortLivedToken && <small>Last short-lived token expires at {new Date(remoteShortLivedToken.expiresAt).toLocaleString()} ({remoteShortLivedToken.ttlMs}ms)</small>}
              </div>
              <div className="form-group">
                <label htmlFor="remoteRememberLastRunning" className="checkbox-label">
                  <input id="remoteRememberLastRunning" type="checkbox" checked={Boolean(remoteForm.remoteRememberLastRunning)} onChange={(e) => setForm((f) => ({ ...f, remoteRememberLastRunning: e.target.checked } as SettingsFormState))} />
                  Remember last running state
                </label>
                <small>Automatically restore tunnel on startup if it was running when last stopped.</small>
              </div>
              <div className="form-group">
                <label>Auth Links</label>
                <div className="settings-button-row">
                  <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("regenerate persistent token", async () => {
                    await regenerateRemotePersistentToken(projectId);
                    addToast("Persistent token regenerated", "success");
                  })}>Regenerate persistent token</button>
                  <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("generate short-lived token", async () => {
                    const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
                    const generated = await generateShortLivedRemoteToken(ttlMs, projectId);
                    setRemoteShortLivedToken(generated);
                    addToast("Short-lived token generated", "success");
                  })}>Generate short-lived token</button>
                  <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("fetch remote url", async () => {
                    const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
                    const nextUrl = await fetchRemoteUrl({ projectId, tokenType: remoteAuthLinkTokenType, ttlMs: remoteAuthLinkTokenType === "short-lived" ? ttlMs : undefined });
                    setRemoteUrlPreview(nextUrl);
                    setRemoteQrSvg(null);
                  })}>Show URL</button>
                  <button type="button" className="btn btn-sm" disabled={remoteBusyAction !== null} onClick={() => void runRemoteAction("generate QR", async () => {
                    const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
                    const qr = await fetchRemoteQr("image/svg", { projectId, tokenType: remoteAuthLinkTokenType, ttlMs: remoteAuthLinkTokenType === "short-lived" ? ttlMs : undefined });
                    setRemoteUrlPreview({ url: qr.url, expiresAt: qr.expiresAt, tokenType: qr.tokenType });
                    setRemoteQrSvg(qr.data ?? null);
                  })}>Generate QR</button>
                </div>
                <label htmlFor="remoteAuthLinkTokenType">Auth link token type</label>
                <select id="remoteAuthLinkTokenType" value={remoteAuthLinkTokenType} onChange={(e) => setRemoteAuthLinkTokenType(e.target.value as "persistent" | "short-lived")}>
                  <option value="persistent">Persistent token</option>
                  <option value="short-lived">Short-lived token</option>
                </select>
                <small>
                  URL and QR generation use the selected token type.
                  {remoteAuthLinkTokenType === "short-lived" ? ` TTL: ${Number(remoteForm.remoteShortLivedTtlMs ?? 900000)}ms.` : ""}
                </small>
                {remoteUrlPreview?.url && (
                  <>
                    <small>Authenticated URL:<code className="settings-url-output">{remoteUrlPreview.url}</code></small>
                    <small>
                      Token type: <strong>{remoteUrlPreview.tokenType}</strong>
                      {remoteUrlPreview.expiresAt ? ` · Expires at ${new Date(remoteUrlPreview.expiresAt).toLocaleString()}` : " · No expiry"}
                    </small>
                  </>
                )}
                {remoteQrSvg && (
                  <div className="settings-qr-preview" aria-live="polite">
                    <p className="settings-qr-preview-label">Scan this QR code on your phone</p>
                    <div className="settings-qr-preview-image-wrap">
                      <img src={`data:image/svg+xml;utf8,${encodeURIComponent(remoteQrSvg)}`} alt="Remote access QR code" className="settings-qr-preview-image" />
                    </div>
                    <details>
                      <summary>QR SVG markup</summary>
                      <pre className="settings-raw-output">{remoteQrSvg}</pre>
                    </details>
                  </div>
                )}
              </div>
            </details>
          </>
        );
      }
      case "prompts":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Prompts</h4>
            <AgentPromptsManager
              value={form.agentPrompts}
              onChange={(agentPrompts: AgentPromptsConfig) => {
                setForm((f) => ({
                  ...f,
                  agentPrompts,
                }));
              }}
              promptOverrides={form.promptOverrides}
              onPromptOverridesChange={(overrides) => {
                setForm((f) => ({
                  ...f,
                  promptOverrides: overrides,
                }));
              }}
            />
          </>
        );
      case "plugins":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Plugins</h4>
            <div className="settings-plugins-subsection-toggle" role="tablist" aria-label="Plugin manager type">
              <button
                type="button"
                id="plugins-tab-fusion-plugins"
                role="tab"
                aria-controls="plugins-panel-fusion-plugins"
                aria-selected={activePluginsSubsection === "fusion-plugins"}
                tabIndex={activePluginsSubsection === "fusion-plugins" ? 0 : -1}
                className={`settings-plugins-subsection-btn${activePluginsSubsection === "fusion-plugins" ? " active" : ""}`}
                onClick={() => setActivePluginsSubsection("fusion-plugins")}
              >
                Fusion Plugins
              </button>
              <button
                type="button"
                id="plugins-tab-pi-extensions"
                role="tab"
                aria-controls="plugins-panel-pi-extensions"
                aria-selected={activePluginsSubsection === "pi-extensions"}
                tabIndex={activePluginsSubsection === "pi-extensions" ? 0 : -1}
                className={`settings-plugins-subsection-btn${activePluginsSubsection === "pi-extensions" ? " active" : ""}`}
                onClick={() => setActivePluginsSubsection("pi-extensions")}
              >
                Pi Extensions
              </button>
            </div>
            <div
              id="plugins-panel-fusion-plugins"
              role="tabpanel"
              aria-labelledby="plugins-tab-fusion-plugins"
              className="settings-plugins-subsection-panel"
              hidden={activePluginsSubsection !== "fusion-plugins"}
            >
              {activePluginsSubsection === "fusion-plugins" && (
                <>
                  <Suspense fallback={null}>
                    <PluginManager addToast={addToast} projectId={projectId} />
                  </Suspense>
                  <PluginSlot slotId="settings-section" projectId={projectId} />
                </>
              )}
            </div>
            <div
              id="plugins-panel-pi-extensions"
              role="tabpanel"
              aria-labelledby="plugins-tab-pi-extensions"
              className="settings-plugins-subsection-panel"
              hidden={activePluginsSubsection !== "pi-extensions"}
            >
              {activePluginsSubsection === "pi-extensions" && (
                <Suspense fallback={null}>
                  <PiExtensionsManager addToast={addToast} projectId={projectId} />
                </Suspense>
              )}
            </div>
          </>
        );
      case "authentication": {
        // CLI-backed providers (currently just claude-cli) render their own
        // compact card with Enable/Disable + Test actions — bypassing the
        // OAuth/API-key rendering below. Filter them out of the standard
        // sort and render alongside.
        const cliAuthProviders = authProviders.filter((p) => p.type === "cli");
        const nonCliProviders = authProviders.filter((p) => p.type !== "cli");
        // Sort providers: authenticated first, then unauthenticated. Within each bucket, sort alphabetically by name.
        const sortedProviders = [...nonCliProviders].sort((a, b) => {
          if (a.authenticated !== b.authenticated) {
            return a.authenticated ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
        const authenticatedProviders = sortedProviders.filter(p => p.authenticated);
        const unauthenticatedProviders = sortedProviders.filter(p => !p.authenticated);

        // CLI-backed providers live in whichever bucket matches their current
        // auth state (Authenticated when signed in, Available otherwise).
        const claudeCliProvider = cliAuthProviders.find((p) => p.id === "claude-cli");
        const cursorCliProvider = cliAuthProviders.find((p) => p.id === "cursor-cli");
        const llamaCppProvider = cliAuthProviders.find((p) => p.id === "llama-cpp");
        const claudeCliCard = claudeCliProvider ? (
          <ClaudeCliProviderCard
            compact
            authenticated={claudeCliProvider.authenticated}
            onToggled={() => {
              void loadAuthStatus();
            }}
          />
        ) : null;
        const cursorCliCard = cursorCliProvider ? (
          <CursorCliProviderCard
            compact
            authenticated={cursorCliProvider.authenticated}
            onToggled={() => {
              void loadAuthStatus();
            }}
          />
        ) : null;
        const llamaCppCard = llamaCppProvider ? (
          <LlamaCppProviderCard
            compact
            authenticated={llamaCppProvider.authenticated}
            onToggled={() => {
              void loadAuthStatus();
            }}
          />
        ) : null;
        const showAuthenticatedGroup =
          authenticatedProviders.length > 0
          || (claudeCliProvider?.authenticated ?? false)
          || (cursorCliProvider?.authenticated ?? false)
          || (llamaCppProvider?.authenticated ?? false);
        const showAvailableGroup =
          unauthenticatedProviders.length > 0
          || (claudeCliProvider && !claudeCliProvider.authenticated)
          || (cursorCliProvider && !cursorCliProvider.authenticated)
          || (llamaCppProvider && !llamaCppProvider.authenticated);
        return (
          <>
            <h4 className="settings-section-heading">Authentication</h4>
            {authLoading ? (
              <div className="settings-empty-state">Loading authentication status…</div>
            ) : authProviders.length === 0 ? (
              <div className="settings-empty-state settings-muted">
                No providers available
              </div>
            ) : (
              <div className="auth-panel-body">
              <PluginSlot
                slotId="settings-provider-card"
                projectId={projectId}
                renderPlaceholder={false}
                actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}
              />
              <PluginSlot
                slotId="settings-integration-card"
                projectId={projectId}
                renderPlaceholder={false}
                actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}
              />
              {!showAuthenticatedGroup && (
                <div className="auth-section-hint">
                  Sign in to at least one provider to get started with AI models.
                </div>
              )}
              {showAuthenticatedGroup && (
                <div className="auth-provider-group">
                  <div className="auth-group-label">Authenticated</div>
                  {claudeCliProvider?.authenticated && claudeCliCard}
                  {cursorCliProvider?.authenticated && cursorCliCard}
                  {llamaCppProvider?.authenticated && llamaCppCard}
                  {authenticatedProviders.map((provider) => (
                    <div key={provider.id} className="auth-provider-card auth-provider-card--authenticated">
                      <div className="auth-provider-header">
                        <div className="auth-provider-info">
                          {/* Stable icon wrapper contract for auth card tests: auth-provider-icon-<providerId> */}
                          <span
                            className="auth-provider-icon-slot"
                            data-testid={`auth-provider-icon-${provider.id}`}
                            aria-hidden="true"
                          >
                            <ProviderIcon provider={provider.id} size="md" />
                          </span>
                          <strong>{provider.name}</strong>
                          <span
                            data-testid={`auth-status-${provider.id}`}
                            className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}
                          >
                            ✓ Active
                          </span>
                          {provider.authenticated && provider.keyHint && (
                            <span className="auth-key-hint">Key: {provider.keyHint}</span>
                          )}
                        </div>
                        {provider.type === "api_key" ? (
                          <div className="auth-apikey-section">
                            <div className="auth-apikey-input-row">
                              <input
                                type="password"
                                className="auth-apikey-input"
                                placeholder="Enter API key"
                                value={apiKeyInputs[provider.id] ?? ""}
                                onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                                disabled={authActionInProgress === provider.id}
                              />
                              {provider.authenticated && !apiKeyInputs[provider.id] ? (
                                <button
                                  className="btn btn-sm"
                                  onClick={() => handleClearApiKey(provider.id)}
                                  disabled={authActionInProgress === provider.id}
                                >
                                  Clear
                                </button>
                              ) : (
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => handleSaveApiKey(provider.id)}
                                  disabled={authActionInProgress === provider.id}
                                >
                                  Save
                                </button>
                              )}
                            </div>
                            {authActionInProgress === provider.id && (
                              <small className="auth-apikey-progress">Saving…</small>
                            )}
                            {apiKeyErrors[provider.id] && (
                              <small className="auth-apikey-error">{apiKeyErrors[provider.id]}</small>
                            )}
                            {(provider.id === "opencode" || provider.id === "opencode-go") && opencodeApiKeyRefreshStatus[provider.id] && (
                              <small className={opencodeApiKeyRefreshStatus[provider.id].tone === "error" ? "form-error" : "text-muted"}>
                                {opencodeApiKeyRefreshStatus[provider.id].message}
                              </small>
                            )}
                          </div>
                        ) : (
                          <div>
                            {authActionInProgress === provider.id ? (
                              <button className="btn btn-sm" disabled>
                                Logging out…
                              </button>
                            ) : provider.loginInProgress ? (
                              <div className="auth-provider-actions-row">
                                <button className="btn btn-sm" disabled>
                                  Waiting for login…
                                </button>
                                <button className="btn btn-sm" onClick={() => handleCancelLogin(provider.id)}>
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                className="btn btn-sm"
                                onClick={() => handleLogout(provider.id)}
                              >
                                Logout
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {showAvailableGroup && (
                <div className="auth-provider-group">
                  <div className="auth-group-label">Available</div>
                  {claudeCliProvider && !claudeCliProvider.authenticated && claudeCliCard}
                  {cursorCliProvider && !cursorCliProvider.authenticated && cursorCliCard}
                  {llamaCppProvider && !llamaCppProvider.authenticated && llamaCppCard}
                  {unauthenticatedProviders.map((provider) => (
                    <div key={provider.id} className="auth-provider-card">
                      <div className="auth-provider-header">
                        <div className="auth-provider-info">
                          {/* Stable icon wrapper contract for auth card tests: auth-provider-icon-<providerId> */}
                          <span
                            className="auth-provider-icon-slot"
                            data-testid={`auth-provider-icon-${provider.id}`}
                            aria-hidden="true"
                          >
                            <ProviderIcon provider={provider.id} size="md" />
                          </span>
                          <strong>{provider.name}</strong>
                          <span
                            data-testid={`auth-status-${provider.id}`}
                            className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}
                          >
                            ✗ Not connected
                          </span>
                        </div>
                        {provider.type === "api_key" ? (
                          <div className="auth-apikey-section">
                            <div className="auth-apikey-input-row">
                              <input
                                type="password"
                                className="auth-apikey-input"
                                placeholder="Enter API key"
                                value={apiKeyInputs[provider.id] ?? ""}
                                onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                                disabled={authActionInProgress === provider.id}
                              />
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleSaveApiKey(provider.id)}
                                disabled={authActionInProgress === provider.id}
                              >
                                Save
                              </button>
                            </div>
                            {authActionInProgress === provider.id && (
                              <small className="auth-apikey-progress">Saving…</small>
                            )}
                            {apiKeyErrors[provider.id] && (
                              <small className="auth-apikey-error">{apiKeyErrors[provider.id]}</small>
                            )}
                            {(provider.id === "opencode" || provider.id === "opencode-go") && opencodeApiKeyRefreshStatus[provider.id] && (
                              <small className={opencodeApiKeyRefreshStatus[provider.id].tone === "error" ? "form-error" : "text-muted"}>
                                {opencodeApiKeyRefreshStatus[provider.id].message}
                              </small>
                            )}
                          </div>
                        ) : (
                          <div>
                            {authActionInProgress === provider.id ? (
                              <button className="btn btn-sm" disabled>
                                Waiting for login…
                              </button>
                            ) : provider.loginInProgress ? (
                              <div className="auth-provider-actions-row">
                                <button className="btn btn-sm" disabled>
                                  Waiting for login…
                                </button>
                                <button className="btn btn-sm" onClick={() => handleCancelLogin(provider.id)}>
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleLogin(provider.id)}
                              >
                                Login
                              </button>
                            )}
                            {provider.id === "github-copilot" && deviceCodes[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (
                              <div className="auth-device-code-panel" data-testid={`auth-device-code-${provider.id}`}>
                                <strong>Enter this code on GitHub</strong>
                                <div className="auth-device-code-pill">{deviceCodes[provider.id].userCode}</div>
                                <div className="auth-provider-actions-row">
                                  <button
                                    className="btn btn-sm"
                                    onClick={() => {
                                      void (async () => {
                                        const copied = await copyTextToClipboard(deviceCodes[provider.id].userCode);
                                        if (copied) {
                                          addToast("Copied code to clipboard", "success");
                                          return;
                                        }
                                        addToast("Failed to copy code — copy it manually from the box above", "error");
                                      })();
                                    }}
                                  >
                                    Copy code
                                  </button>
                                  <button
                                    className="btn btn-sm"
                                    onClick={() => window.open(appendTokenQuery(deviceCodes[provider.id].verificationUri), "_blank")}
                                  >
                                    Open GitHub
                                  </button>
                                </div>
                              </div>
                            )}
                            {loginInstructions[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (
                              <LoginInstructions
                                instructions={loginInstructions[provider.id]}
                                data-testid={`auth-login-instructions-${provider.id}`}
                              />
                            )}
                            {manualCodeConfigs[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (
                              <OAuthManualCodeForm
                                value={manualCodeInputs[provider.id] ?? ""}
                                onChange={(value) => setManualCodeInputs((prev) => ({ ...prev, [provider.id]: value }))}
                                onSubmit={() => void handleSubmitManualCode(provider.id)}
                                prompt={manualCodeConfigs[provider.id].prompt}
                                placeholder={manualCodeConfigs[provider.id].placeholder}
                                helpText={manualCodeConfigs[provider.id].helpText}
                                disabled={manualCodeSubmitInProgress === provider.id}
                                submitLabel={manualCodeSubmitInProgress === provider.id ? "Submitting…" : "Submit code"}
                                data-testid={`auth-manual-code-${provider.id}`}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>
            )}
            <small className="auth-hint">
              Authentication changes take effect immediately — no need to save.
            </small>
            {onReopenOnboarding && (
              <div className="form-group" style={{ marginTop: "var(--space-md)" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onReopenOnboarding}
                >
                  Reopen onboarding guide
                </button>
                <small className="settings-muted">
                  Re-run the setup wizard to review or update your AI provider and model configuration.
                </small>
              </div>
            )}

            <CustomProvidersSection />

          </>
        );
      }
      case "hermes-runtime":
        return (
          <>
            <h4 className="settings-section-heading">Hermes Runtime</h4>
            <HermesRuntimeCard />
          </>
        );
      case "openclaw-runtime":
        return (
          <>
            <h4 className="settings-section-heading">OpenClaw Runtime</h4>
            <OpenClawRuntimeCard />
          </>
        );
      case "paperclip-runtime":
        return (
          <>
            <h4 className="settings-section-heading">Paperclip Runtime</h4>
            <PaperclipRuntimeCard />
          </>
        );
    }
  };

  return (
    <div className="modal-overlay open settings-modal-overlay" {...overlayDismissProps} role="dialog" aria-modal="true">
      <div className="modal modal-lg settings-modal" ref={modalRef} style={keyboardStyle}>
        <div className="modal-header">
          <div className="settings-modal-heading">
            <h3>Settings</h3>
            <div className="settings-update-check">
              {appVersion && (
                <button
                  type="button"
                  className="settings-version-check-btn"
                  onClick={() => {
                    void handleCheckForUpdates();
                  }}
                  disabled={updateCheckLoading}
                  aria-label="Check for updates"
                  title="Check for updates"
                >
                  <span className="settings-modal-version">Version {appVersion}</span>
                  <RefreshCw size={12} className={updateCheckLoading ? "spinning" : undefined} />
                </button>
              )}
              {updateCheckResult && (
                <span
                  aria-live="polite"
                  className={`settings-update-result ${
                    updateCheckResult.error
                      ? "settings-update-result--error"
                      : updateCheckResult.updateAvailable
                        ? "settings-update-result--available"
                        : "settings-update-result--up-to-date"
                  }`}
                >
                  {renderUpdateCheckResultContent()}
                </span>
              )}
            </div>
          </div>
          <div className="settings-header-actions">
            {form.showGitHubStarButton !== false && (
              <a
                href="https://github.com/Runfusion/Fusion"
                target="_blank"
                rel="noopener noreferrer"
                className="settings-github-star-btn"
                aria-label="Star Fusion on GitHub"
                title="Star Fusion on GitHub"
                onClick={markStarClicked}
                data-clicked={starClicked ? "true" : "false"}
              >
                <span className="settings-github-star-btn__action">
                  <ProviderIcon provider="github" size="sm" />
                  <Star size={11} aria-hidden="true" />
                  Star
                </span>
                {gitHubStarCount !== null && (
                  <span className="settings-github-star-btn__count" aria-label={`${gitHubStarCount.toLocaleString()} stars`}>
                    {gitHubStarCount >= 1000
                      ? `${(gitHubStarCount / 1000).toFixed(1)}k`
                      : gitHubStarCount.toLocaleString()}
                  </span>
                )}
              </a>
            )}
            <a
              href="https://github.com/Runfusion/Fusion/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm settings-header-help-btn"
              aria-label="Help and discussions"
              title="Help and discussions"
            >
              <HelpCircle size={13} aria-hidden="true" />
              Help
            </a>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {loading ? (
          <div className="settings-empty-state settings-loading">Loading…</div>
        ) : (
          <div className="settings-layout">
            {showMobileSectionPicker && (
              <div className="settings-mobile-section-picker">
                <label htmlFor="settings-mobile-section">Settings Section</label>
                <select
                  id="settings-mobile-section"
                  className="select touch-target"
                  value={activeSection}
                  onChange={(event) => setActiveSection(event.target.value as SectionId)}
                >
                  {visibleSections.filter((section) => !section.isGroupHeader).map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <nav className="settings-sidebar">
              {visibleSections.map((section) => {
                // Render group headers as non-clickable styled divs
                if (section.isGroupHeader) {
                  return (
                    <div key={section.id} className="settings-group-header">
                      {section.label}
                    </div>
                  );
                }
                return (
                  <button
                    key={section.id}
                    className={`settings-nav-item${activeSection === section.id ? " active" : ""}`}
                    onClick={() => setActiveSection(section.id)}
                    title={
                      section.scope === "global"
                        ? "Shared across all projects"
                        : section.scope === "project"
                          ? "Specific to this project"
                          : undefined
                    }
                  >
                    {section.scope === "global" && <Globe className="settings-scope-icon" aria-label="Global setting" size={16} />}
                    {section.scope === "project" && <Folder className="settings-scope-icon" aria-label="Project setting" size={16} />}
                    {section.icon && !section.scope && (
                      <section.icon className="settings-scope-icon" aria-label="Global setting" size={16} />
                    )}
                    {section.label}
                  </button>
                );
              })}
            </nav>
            <div className="settings-content" ref={settingsContentRef}>
              {renderSectionFields()}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <div className="modal-actions-left">
            <a
              href="?view=secrets"
              className="settings-inline-link"
              onClick={(event) => {
                event.preventDefault();
                onNavigateToSecrets?.();
              }}
            >
              Manage secrets
            </a>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleExport}
              title="Export settings to JSON file"
            >
              Export
            </button>
            <input
              type="file"
              ref={fileInputRef}
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importLoading}
              title="Import settings from JSON file"
            >
              {importLoading ? "Loading…" : "Import"}
            </button>
          </div>
          <div className="modal-actions-right">
            <button className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={loading}>
              Save
            </button>
          </div>
        </div>
      </div>

      {overlapPathPickerIndex !== null && (
        <div
          className="modal-overlay open"
          onClick={handleOverlapPathPickerOverlayClick}
          role="dialog"
          aria-modal="true"
          aria-label="Browse workspace path"
        >
          <div className="modal modal-lg settings-overlap-path-picker-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Select ignored overlap path</h3>
              <button className="modal-close" onClick={closeOverlapPathPicker} aria-label="Close">
                &times;
              </button>
            </div>
            <div className="modal-body settings-overlap-path-picker-body">
              <p className="settings-overlap-path-picker-note">
                Choose a file to ignore directly, or navigate into a folder and select the current directory.
              </p>
              <FileBrowser
                entries={overlapPathPickerEntries}
                currentPath={overlapPathPickerCurrentPath}
                onSelectFile={selectOverlapIgnorePath}
                onNavigate={setOverlapPathPickerPath}
                loading={overlapPathPickerLoading}
                error={overlapPathPickerError}
                onRetry={refreshOverlapPathPicker}
                workspace="project"
                projectId={projectId}
              />
            </div>
            <div className="modal-actions">
              <div className="modal-actions-left">
                <small>
                  Current directory: <code>{overlapPathPickerCurrentPath === "." ? "(project root)" : overlapPathPickerCurrentPath}</code>
                </small>
              </div>
              <div className="modal-actions-right">
                <button className="btn btn-sm" onClick={closeOverlapPathPicker}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSelectCurrentDirectoryForOverlapIgnore}
                  disabled={overlapPathPickerCurrentPath === "."}
                >
                  Select current directory
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {worktreesDirPickerOpen && (
        <div
          className="modal-overlay open"
          onClick={handleWorktreesDirPickerOverlayClick}
          role="dialog"
          aria-modal="true"
          aria-label="Browse worktrees directory"
        >
          <div className="modal modal-lg settings-overlap-path-picker-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Select worktrees directory</h3>
              <button className="modal-close" onClick={closeWorktreesDirPicker} aria-label="Close">
                &times;
              </button>
            </div>
            <div className="modal-body settings-overlap-path-picker-body">
              <p className="settings-overlap-path-picker-note">
                Navigate to the folder where Fusion should create task worktrees, then select the current directory.
              </p>
              <FileBrowser
                entries={worktreesDirPickerEntries}
                currentPath={worktreesDirPickerCurrentPath}
                onSelectFile={selectWorktreesDirFromPicker}
                onNavigate={setWorktreesDirPickerPath}
                loading={worktreesDirPickerLoading}
                error={worktreesDirPickerError}
                onRetry={refreshWorktreesDirPicker}
                workspace="project"
                projectId={projectId}
              />
            </div>
            <div className="modal-actions">
              <div className="modal-actions-left">
                <small>
                  Current directory: <code>{worktreesDirPickerCurrentPath === "." ? "(project root)" : worktreesDirPickerCurrentPath}</code>
                </small>
              </div>
              <div className="modal-actions-right">
                <button className="btn btn-sm" onClick={closeWorktreesDirPicker}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-sm" onClick={selectCurrentWorktreesDir}>
                  Select current directory
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Import Confirmation Dialog */}
      {importDialogOpen && importPreview && (
        <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && setImportDialogOpen(false)} role="dialog" aria-modal="true">
          <div className="modal modal-md">
            <div className="modal-header">
              <h3>Import Settings</h3>
              <button className="modal-close" onClick={() => setImportDialogOpen(false)} aria-label="Close">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p>Review the settings to be imported:</p>
              
              {importPreview.global && Object.keys(importPreview.global).length > 0 && (
                <div className="form-group">
                  <strong>Global Settings:</strong>
                  <ul className="import-preview-list">
                    {Object.entries(importPreview.global)
                      .filter(([, v]) => v !== undefined)
                      .map(([key]) => (
                        <li key={key}>{key}</li>
                      ))}
                  </ul>
                </div>
              )}
              
              {importPreview.project && Object.keys(importPreview.project).length > 0 && (
                <div className="form-group">
                  <strong>Project Settings:</strong>
                  <ul className="import-preview-list">
                    {Object.entries(importPreview.project)
                      .filter(([, v]) => v !== undefined)
                      .map(([key]) => (
                        <li key={key}>{key}</li>
                      ))}
                  </ul>
                </div>
              )}
              
              <div className="form-group">
                <label htmlFor="import-scope">Import Scope:</label>
                <select
                  id="import-scope"
                  value={importScope}
                  onChange={(e) => setImportScope(e.target.value as 'global' | 'project' | 'both')}
                >
                  <option value="both">Both global and project settings</option>
                  <option value="global">Global settings only</option>
                  <option value="project">Project settings only</option>
                </select>
              </div>
              
              <div className="form-group">
                <label htmlFor="import-merge" className="checkbox-label">
                  <input
                    id="import-merge"
                    type="checkbox"
                    checked={importMerge}
                    onChange={(e) => setImportMerge(e.target.checked)}
                  />
                  Merge with existing settings (recommended)
                </label>
                <small>If unchecked, existing settings will be replaced with imported values.</small>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setImportDialogOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleImport}
                disabled={importLoading}
              >
                {importLoading ? "Importing…" : "Confirm Import"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
