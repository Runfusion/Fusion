import { useState, useEffect, useCallback, useRef, lazy, Suspense, type MouseEvent } from "react";
import { Globe, Folder } from "lucide-react";
import { THINKING_LEVELS, isGlobalSettingsKey, isProjectSettingsKey, getErrorMessage } from "@fusion/core";
import type { Settings, GlobalSettings, ThemeMode, ColorTheme, ModelPreset, NtfyNotificationEvent, AgentPromptsConfig, ThinkingLevel } from "@fusion/core";
import { fetchSettings, fetchSettingsByScope, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, saveApiKey, clearApiKey, fetchModels, testNtfyNotification, fetchBackups, createBackup, exportSettings, importSettings, fetchMemoryFile, fetchMemoryFiles, saveMemoryFile, compactMemory, fetchGlobalConcurrency, updateGlobalConcurrency, installQmd, testMemoryRetrieval, fetchGitRemotesDetailed, fetchDashboardHealth, fetchRemoteSettings, updateRemoteSettings, fetchRemoteStatus, activateRemoteProvider, startRemoteTunnel, stopRemoteTunnel, regenerateRemotePersistentToken, generateShortLivedRemoteToken, fetchRemoteQr, fetchRemoteUrl } from "../api";
import type { AuthProvider, ModelInfo, BackupListResponse, SettingsExportData, MemoryFileInfo, MemoryRetrievalTestResult, GitRemoteDetailed, RemoteSettings, RemoteStatus } from "../api";
import { useMemoryBackendStatus } from "../hooks/useMemoryBackendStatus";
import type { ToastType } from "../hooks/useToast";
import { ThemeSelector } from "./ThemeSelector";
import "./SettingsModal.css";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { FileEditor } from "./FileEditor";
import { FileBrowser } from "./FileBrowser";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
const PluginManager = lazy(() => import("./PluginManager").then((m) => ({ default: m.PluginManager })));
const PiExtensionsManager = lazy(() => import("./PiExtensionsManager").then((m) => ({ default: m.PiExtensionsManager })));
import { ClaudeCliProviderCard } from "./ClaudeCliProviderCard";
import { PluginSlot } from "./PluginSlot";
import { AgentPromptsManager } from "./AgentPromptsManager";
import { ProviderIcon } from "./ProviderIcon";
import { applyPresetToSelection, generateUniquePresetId } from "../utils/modelPresets";
import { appendTokenQuery } from "../auth";

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
 *   - Project: Project-scoped sections (project-models, general, scheduling, worktrees, commands,
 *     merge, memory, experimental, prompts, backups, plugins)
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

const SETTINGS_SECTIONS: SettingsSection[] = [
  // Account group (scope-less items — independent of settings storage)
  { id: "__account_header", label: "Account", scope: undefined, isGroupHeader: true },
  { id: "authentication", label: "Authentication", scope: undefined, icon: Globe },

  // Global group (shared across all Fusion projects)
  { id: "__global_header", label: "Global", scope: undefined, isGroupHeader: true },
  { id: "appearance", label: "Appearance", scope: "global" },
  { id: "notifications", label: "Notifications", scope: "global" },
  { id: "node-sync", label: "Node Sync", scope: "global" },
  { id: "global-models", label: "Models", scope: "global" },

  // Project group (specific to this project)
  { id: "__project_header", label: "Project", scope: undefined, isGroupHeader: true },
  { id: "project-models", label: "Project Models", scope: "project" },
  { id: "general", label: "General", scope: "project" },
  { id: "scheduling", label: "Scheduling", scope: "project" },
  { id: "worktrees", label: "Worktrees", scope: "project" },
  { id: "commands", label: "Commands", scope: "project" },
  { id: "merge", label: "Merge", scope: "project" },
  { id: "memory", label: "Memory", scope: "project" },
  { id: "experimental", label: "Experimental Features", scope: "project" },
  { id: "prompts", label: "Prompts", scope: "project" },
  { id: "backups", label: "Backups", scope: "project" },
  { id: "remote", label: "Remote Access", scope: "project" },
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

function normalizeExperimentalFeaturesForSave(features?: Record<string, boolean>): Record<string, boolean> {
  if (!features) {
    return {};
  }

  const normalized: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(features)) {
    normalized[getCanonicalExperimentalFeatureKey(key)] = enabled;
  }

  return normalized;
}

type LegacySectionId = "pi-extensions";
export type SectionId = SettingsSection["id"] | LegacySectionId;

type PluginsSubsectionId = "fusion-plugins" | "pi-extensions";

/** Local form state extends Settings with a worktreeInitCommand override and lets tokenCap carry null (delete semantic). */
type SettingsFormState = Settings & { worktreeInitCommand?: string; tokenCap?: number | null };

interface SettingsModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  /** Optional section to show when the modal first opens. Defaults to first non-group-header section. */
  initialSection?: SectionId;
  /** Current theme mode */
  themeMode?: ThemeMode;
  /** Current color theme */
  colorTheme?: ColorTheme;
  /** Called when theme mode changes */
  onThemeModeChange?: (mode: ThemeMode) => void;
  /** Called when color theme changes */
  onColorThemeChange?: (theme: ColorTheme) => void;
  /** Optional callback when user wants to reopen the onboarding guide */
  onReopenOnboarding?: () => void;
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
  onReopenOnboarding,
}: SettingsModalProps) {
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
    recycleWorktrees: false,
    worktreeNaming: "random",
    includeTaskIdInCommit: true,
    worktreeInitCommand: "",
    ntfyEnabled: false,
    ntfyTopic: undefined,
  });
  const [loading, setLoading] = useState(true);
  // Track initial values to detect explicit clears for null-as-delete semantics
  const [initialValues, setInitialValues] = useState<Settings | null>(null);
  // Track scoped settings for inheritance detection (fetched alongside merged settings)
  // This stores the raw { global, project } structure from the API
  const [scopedSettings, setScopedSettings] = useState<{ global: GlobalSettings; project: Partial<Settings> } | null>(null);
  // Track initial scoped values for null-as-delete semantics on project overrides
  const [initialScopedValues, setInitialScopedValues] = useState<{ global: GlobalSettings; project: Partial<Settings> } | null>(null);
  // Find the first non-group-header section for default active section
  const firstNonHeaderSection = SETTINGS_SECTIONS.find((s) => !s.isGroupHeader);
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    if (initialSection === "pi-extensions") {
      return "plugins";
    }
    return initialSection ?? firstNonHeaderSection?.id ?? "authentication";
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
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [overlapPathPickerIndex, setOverlapPathPickerIndex] = useState<number | null>(null);

  const {
    entries: overlapPathPickerEntries,
    currentPath: overlapPathPickerCurrentPath,
    setPath: setOverlapPathPickerPath,
    loading: overlapPathPickerLoading,
    error: overlapPathPickerError,
    refresh: refreshOverlapPathPicker,
  } = useWorkspaceFileBrowser("project", overlapPathPickerIndex !== null, projectId);

  const remoteAccessEnabled = isExperimentalFeatureEnabled(form.experimentalFeatures ?? {}, "remoteAccess");
  const visibleSections = SETTINGS_SECTIONS.filter((section) => section.id !== "remote" || remoteAccessEnabled);
  const firstVisibleSectionId = visibleSections.find((section) => !section.isGroupHeader)?.id ?? "general";

  /** Get the scope of the currently active section */
  const activeSectionScope = visibleSections.find((s) => s.id === activeSection)?.scope;

  useEffect(() => {
    if (activeSection === "remote" && !remoteAccessEnabled) {
      setActiveSection(firstVisibleSectionId);
    }
  }, [activeSection, remoteAccessEnabled, firstVisibleSectionId]);

  // Auth state (independent of the settings save flow)
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
  const [loginInstructions, setLoginInstructions] = useState<Record<string, string>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyErrors, setApiKeyErrors] = useState<Record<string, string>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Model state
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);

  // Test notification state
  const [testNotificationLoading, setTestNotificationLoading] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetDraft, setPresetDraft] = useState<ModelPreset | null>(null);

  // Backup state
  const [backupInfo, setBackupInfo] = useState<BackupListResponse | null>(null);
  const [backupLoading, setBackupLoading] = useState(false);

  // Remote access state
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [remoteBusyAction, setRemoteBusyAction] = useState<string | null>(null);
  const [remoteAuthLinkTokenType, setRemoteAuthLinkTokenType] = useState<"persistent" | "short-lived">("persistent");
  const [remoteUrlPreview, setRemoteUrlPreview] = useState<{ url: string; expiresAt: string | null; tokenType: "persistent" | "short-lived" } | null>(null);
  const [remoteQrSvg, setRemoteQrSvg] = useState<string | null>(null);
  const [remoteShortLivedToken, setRemoteShortLivedToken] = useState<{ token: string; expiresAt: string; ttlMs: number } | null>(null);

  // Project memory state
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  // Git remotes for the worktree rebase dropdown. Loaded lazily; empty list
  // is a valid state (fresh repo, no remotes configured yet).
  const [gitRemotes, setGitRemotes] = useState<GitRemoteDetailed[]>([]);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [selectedMemoryPath, setSelectedMemoryPath] = useState(DEFAULT_MEMORY_EDITOR_PATH);
  const [memoryTestQuery, setMemoryTestQuery] = useState("");
  const [memoryTestLoading, setMemoryTestLoading] = useState(false);
  const [memoryTestResult, setMemoryTestResult] = useState<MemoryRetrievalTestResult | null>(null);
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
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateMobilePicker);
      return () => mediaQuery.removeEventListener("change", updateMobilePicker);
    }

    mediaQuery.addListener(updateMobilePicker);
    return () => mediaQuery.removeListener(updateMobilePicker);
  }, []);

  useEffect(() => {
    // Load both merged and scoped settings to enable inheritance detection
    Promise.all([fetchSettings(projectId), fetchSettingsByScope(projectId)])
      .then(([s, scoped]) => {
        setForm(s);
        setInitialValues(s); // Store initial values to detect explicit clears
        setScopedSettings(scoped);
        setInitialScopedValues(scoped); // Store initial scoped values for null-as-delete
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

  // Load auth status when the authentication section is active
  const loadAuthStatus = useCallback(async () => {
    try {
      const { providers } = await fetchAuthStatus();
      setAuthProviders(providers);
      setLoginInstructions((prev) => {
        const next: Record<string, string> = {};
        for (const [providerId, instructions] of Object.entries(prev)) {
          const provider = providers.find((candidate) => candidate.id === providerId);
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
    }
  }, [projectId]);

  useEffect(() => {
    if (activeSection !== "remote") {
      return;
    }

    loadRemoteData().catch(() => {
      setRemoteStatus(null);
    });
  }, [activeSection, loadRemoteData]);

  // Lazy-load git remotes for the rebase-remote dropdown when the Worktrees
  // section becomes visible. Failure is non-fatal: the dropdown falls back
  // to just "Use git default".
  useEffect(() => {
    if (activeSection !== "worktrees") return;
    fetchGitRemotesDetailed(projectId)
      .then((remotes) => setGitRemotes(remotes))
      .catch(() => setGitRemotes([]));
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
    if (activeSection === "authentication") {
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

  const handleLogin = useCallback(async (providerId: string) => {
    setAuthActionInProgress(providerId);
    setLoginInstructions((prev) => {
      if (!(providerId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });

    try {
      const { url, instructions } = await loginProvider(providerId);
      if (instructions?.trim()) {
        setLoginInstructions((prev) => ({ ...prev, [providerId]: instructions }));
      }
      window.open(appendTokenQuery(url), "_blank");

      // Poll for auth completion every 2 seconds
      pollIntervalRef.current = setInterval(async () => {
        try {
          const { providers } = await fetchAuthStatus();
          setAuthProviders(providers);
          const provider = providers.find((p) => p.id === providerId);
          if (provider?.authenticated) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setAuthActionInProgress(null);
            setLoginInstructions((prev) => {
              if (!(providerId in prev)) {
                return prev;
              }
              const next = { ...prev };
              delete next[providerId];
              return next;
            });
            addToast("Login successful", "success");
          }
        } catch {
          // Continue polling on transient errors
        }
      }, 2000);
    } catch (err) {
      addToast(getErrorMessage(err) || "Login failed", "error");
      setAuthActionInProgress(null);
      setLoginInstructions((prev) => {
        if (!(providerId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
    }
  }, [addToast]);

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
      await saveApiKey(providerId, key);
      setApiKeyInputs((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      await loadAuthStatus();
      addToast("API key saved", "success");
    } catch (err) {
      setApiKeyErrors((prev) => ({ ...prev, [providerId]: getErrorMessage(err) || "Failed to save API key" }));
    } finally {
      setAuthActionInProgress(null);
    }
  }, [apiKeyInputs, addToast, loadAuthStatus]);

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

  const handleTestNotification = useCallback(async () => {
    // Validate ntfy is enabled and topic is valid
    if (!form.ntfyEnabled || !form.ntfyTopic || !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)) {
      return;
    }

    setTestNotificationLoading(true);
    try {
      const ntfyBaseUrl = form.ntfyBaseUrl?.trim();
      const result = await testNtfyNotification({
        ntfyEnabled: form.ntfyEnabled,
        ntfyTopic: form.ntfyTopic,
        ...(ntfyBaseUrl ? { ntfyBaseUrl } : {}),
      }, projectId);
      if (result.success) {
        addToast("Test notification sent — check your ntfy app!", "success");
      } else {
        addToast("Failed to send test notification", "error");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to send test notification", "error");
    } finally {
      setTestNotificationLoading(false);
    }
  }, [addToast, form.ntfyBaseUrl, form.ntfyEnabled, form.ntfyTopic, projectId]);

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

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

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
      helperText: "AI model used for task specification (triage).",
      fallbackOrder: "Project override → Global planning lane → Global default lane → Automatic resolution",
    },
    {
      laneId: "validator",
      label: "Validator Model",
      globalProviderKey: "validatorGlobalProvider",
      globalModelKey: "validatorGlobalModelId",
      projectProviderKey: "validatorProvider",
      projectModelKey: "validatorModelId",
      helperText: "AI model used for code and specification review.",
      fallbackOrder: "Project override → Global validator lane → Global default lane → Automatic resolution",
    },
    {
      laneId: "summarization",
      label: "Title Summarization Model",
      globalProviderKey: "titleSummarizerGlobalProvider",
      globalModelKey: "titleSummarizerGlobalModelId",
      projectProviderKey: "titleSummarizerProvider",
      projectModelKey: "titleSummarizerModelId",
      helperText: "AI model used for auto-generating task titles from descriptions.",
      fallbackOrder: "Project override → Global summarization lane → Global planning lane → Global default lane → Automatic resolution",
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
    try {
      const payload = {
        ...form,
        worktreeInitCommand: form.worktreeInitCommand?.trim() || undefined,
        taskPrefix: form.taskPrefix?.trim() || undefined,
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
          // For non-model settings: existing behavior
          (projectPatch as Record<string, unknown>)[key] = value;
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
  }, [form, globalMaxConcurrent, prefixError, presetDraft, initialValues, initialScopedValues, onClose, addToast, projectId]);

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

  const handleSaveRemoteSettings = useCallback(async () => {
    const nextSettings: Partial<RemoteSettings> = {
      remoteActiveProvider: ((form as Record<string, unknown>).remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
      remoteTailscaleEnabled: Boolean((form as Record<string, unknown>).remoteTailscaleEnabled),
      remoteTailscaleHostname: String((form as Record<string, unknown>).remoteTailscaleHostname ?? ""),
      remoteTailscaleTargetPort: Number((form as Record<string, unknown>).remoteTailscaleTargetPort ?? 4040),
      remoteTailscaleAcceptRoutes: Boolean((form as Record<string, unknown>).remoteTailscaleAcceptRoutes),
      remoteCloudflareEnabled: Boolean((form as Record<string, unknown>).remoteCloudflareEnabled),
      remoteCloudflareTunnelName: String((form as Record<string, unknown>).remoteCloudflareTunnelName ?? ""),
      remoteCloudflareTunnelToken: (((form as Record<string, unknown>).remoteCloudflareTunnelToken as string | null) || null),
      remoteCloudflareIngressUrl: String((form as Record<string, unknown>).remoteCloudflareIngressUrl ?? ""),
      remoteShortLivedEnabled: Boolean((form as Record<string, unknown>).remoteShortLivedEnabled),
      remoteShortLivedTtlMs: Number((form as Record<string, unknown>).remoteShortLivedTtlMs ?? 900000),
      remoteRememberLastRunning: Boolean((form as Record<string, unknown>).remoteRememberLastRunning),
    };

    setRemoteBusyAction("save");
    try {
      await updateRemoteSettings(nextSettings, projectId);
      addToast("Remote settings saved", "success");
      await loadRemoteData();
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to save remote settings", "error");
    } finally {
      setRemoteBusyAction(null);
    }
  }, [form, projectId, loadRemoteData, addToast]);

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

            {/* --- OpenRouter Model Sync --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">OpenRouter Models</h4>
            <div className="form-group">
              <label htmlFor="openrouterModelSync" className="checkbox-label">
                <input
                  id="openrouterModelSync"
                  type="checkbox"
                  checked={form.openrouterModelSync !== false}
                  onChange={(e) => setForm((f) => ({ ...f, openrouterModelSync: e.target.checked }))}
                />
                Sync OpenRouter model list at dashboard startup
              </label>
              <small>
                When enabled, the dashboard fetches the latest available models from the OpenRouter
                API on startup, so the model picker always shows the most up-to-date catalog. Disable
                to skip the initial API call and use only the built-in model list.
              </small>
            </div>

          </>
        );
      }

      case "project-models": {
        const presets = form.modelPresets || [];
        const presetOptions = presets.map((preset) => ({ id: preset.id, name: preset.name }));
        const inUsePresetIds = new Set(Object.values(form.defaultPresetBySize || {}).filter(Boolean));

        // Filter model lanes to show in project scope (execution, planning, validator, summarization)
        // Default lane is global-only
        const projectModelLanes = MODEL_LANES.filter(
          (lane) => lane.laneId === "execution" || lane.laneId === "planning" || lane.laneId === "validator" || lane.laneId === "summarization",
        );

        return (
          <>
            {renderScopeBanner()}

            {/* --- Token Cap --- */}
            <h4 className="settings-section-heading">Token Cap</h4>
            <div className="form-group">
              <label htmlFor="tokenCap">Token Cap</label>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
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

                  return (
                    <div className="form-group" key={lane.laneId}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                        <label htmlFor={`${lane.laneId}Model`}>{lane.label}</label>
                        <span
                          className={`settings-lane-badge ${isOverridden ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`}
                          title={isOverridden ? "Explicitly set for this project" : "Inherited from global settings"}
                        >
                          {isOverridden ? "Override (Project)" : "Inherited (Global)"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <div style={{ flex: 1 }}>
                          <CustomModelDropdown
                            id={`${lane.laneId}Model`}
                            label={lane.label}
                            models={availableModels}
                            value={value}
                            onChange={(val) => updateLaneValue(lane, val)}
                            placeholder="Use global"
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
                        {lane.helperText} Falls back to: {lane.fallbackOrder}.
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
                  <label htmlFor="validatorFallbackModel">Validator Fallback Model</label>
                  <CustomModelDropdown
                    id="validatorFallbackModel"
                    label="Validator Fallback Model"
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
                  <small>Used if the validator model fails due to rate limits or provider overload. Defaults to the global fallback model.</small>
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
                            onClick={() => {
                              if (inUsePresetIds.has(preset.id) && !confirm(`Preset "${preset.name}" is used in auto-selection. Delete it anyway?`)) {
                                return;
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
                        <label htmlFor="preset-validator-model">Validator model</label>
                        <CustomModelDropdown
                          id="preset-validator-model"
                          label="Preset validator model"
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

            {/* --- AI Summarization --- */}
            <h4 className="settings-section-heading settings-section-heading--spaced">AI Summarization</h4>
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
                will automatically get an AI-generated title (max 60 characters).
              </small>
            </div>

            {(form.autoSummarizeTitles || false) && (
              <>
                <div className="form-group">
                  <label>Title summarization model</label>
                  {modelsLoading ? (
                    <small>Loading available models...</small>
                  ) : availableModels.length === 0 ? (
                    <small>No models available. Configure authentication first.</small>
                  ) : (
                    <CustomModelDropdown
                      id="titleSummarizerModel"
                      label="Title summarization model"
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
                    {form.titleSummarizerProvider && form.titleSummarizerModelId
                      ? "Using explicitly configured model"
                      : form.planningProvider && form.planningModelId
                        ? "(using planning model)"
                        : form.defaultProvider && form.defaultModelId
                          ? "(using default model)"
                          : "(using automatic model selection)"}
                  </small>
                </div>

                <div className="form-group">
                  <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          titleSummarizerProvider: f.planningProvider,
                          titleSummarizerModelId: f.planningModelId,
                        }))
                      }
                      disabled={!form.planningProvider || !form.planningModelId}
                    >
                      Use planning model
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          titleSummarizerProvider: f.defaultProvider,
                          titleSummarizerModelId: f.defaultModelId,
                        }))
                      }
                      disabled={!form.defaultProvider || !form.defaultModelId}
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
              onThemeModeChange={(mode) => {
                setForm((f) => ({ ...f, themeMode: mode }));
                onThemeModeChange?.(mode);
              }}
              onColorThemeChange={(theme) => {
                setForm((f) => ({ ...f, colorTheme: theme }));
                onColorThemeChange?.(theme);
              }}
            />
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
              <small>Maximum concurrent triage/specification agents</small>
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
              <label htmlFor="specStalenessEnabled" className="checkbox-label">
                <input
                  id="specStalenessEnabled"
                  type="checkbox"
                  checked={form.specStalenessEnabled || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, specStalenessEnabled: e.target.checked }))
                  }
                />
                Enable specification staleness enforcement
              </label>
              <small>When enabled, tasks with stale specifications (PROMPT.md older than the threshold) are automatically sent back to triage for re-specification</small>
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
              <small>Maximum age in hours before a specification is considered stale. Default: 6 hours.</small>
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
              <small>When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup</small>
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
              <small>When enabled, tasks that pass review are automatically merged into the main branch</small>
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
              <small>
                Controls what happens after a task reaches In Review. Direct mode preserves Fusion&apos;s current local squash-merge behavior. Pull request mode keeps the task in In Review while Fusion waits for GitHub reviews and required checks before merging the PR.
              </small>
            </div>
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
              <small>When disabled, merge commit messages omit the task ID from the scope (e.g. <code>feat: ...</code> instead of <code>feat(KB-001): ...</code>)</small>
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
                Add author attribution to commits
              </label>
              <small>
                When enabled, all commits made by Fusion include <code>--author</code>{" "}
                attribution identifying them as AI-generated
              </small>
            </div>

            {form.commitAuthorEnabled !== false && (
              <>
                <div className="form-group">
                  <label htmlFor="commitAuthorName">Author Name</label>
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
                  <small>Name used in commit author attribution</small>
                </div>
                <div className="form-group">
                  <label htmlFor="commitAuthorEmail">Author Email</label>
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
                  <small>Email used in commit author attribution</small>
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
              <small>When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.), generated files (dist/*, *.gen.ts), and trivial whitespace conflicts are resolved automatically without AI intervention. Complex code conflicts still require AI review.</small>
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
              <small>When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.) are resolved using 'ours' strategy, generated files (dist/*, *.gen.ts) using 'theirs' strategy, and trivial whitespace conflicts are auto-resolved without spawning an AI agent. Complex code conflicts still require AI review.</small>
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
              <small>When enabled, the merged result is automatically pushed to the configured git remote. This includes pulling the latest from the remote first (rebase) and resolving any conflicts with AI if needed.</small>
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
                <small>Git remote to push to (e.g. "origin"). Can include branch name (e.g. "origin main"). Default: "origin".</small>
              </div>
            )}
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
                      <option key={file.path} value={file.path}>
                        {file.label} - {file.path}
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
                <div className="form-group">
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
            <div className="form-group">
              <label htmlFor="ntfyEnabled" className="checkbox-label">
                <input
                  id="ntfyEnabled"
                  type="checkbox"
                  checked={form.ntfyEnabled || false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, ntfyEnabled: e.target.checked }))
                  }
                />
                Enable ntfy.sh notifications
              </label>
              <small>Receive push notifications when tasks complete or fail via ntfy.sh</small>
            </div>
            {form.ntfyEnabled && (
              <>
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
                  <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">
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
                  </div>
                </details>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleTestNotification}
                  disabled={
                    testNotificationLoading ||
                    !form.ntfyTopic ||
                    !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)
                  }
                >
                  {testNotificationLoading ? "Sending…" : "Test notification"}
                </button>
              </div>
              <div className="form-group">
                <label>Notify on events</label>
                <div className="ntfy-events-list">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.ntfyEvents?.includes("in-review") ?? true}
                      onChange={(e) => {
                        const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const newEvents = e.target.checked
                          ? (current.includes("in-review") ? current : [...current, "in-review" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "in-review");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    Task completed (in-review)
                  </label>
                  <small>When a task moves to In Review (ready for review)</small>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.ntfyEvents?.includes("merged") ?? true}
                      onChange={(e) => {
                        const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const newEvents = e.target.checked
                          ? (current.includes("merged") ? current : [...current, "merged" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "merged");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    Task merged
                  </label>
                  <small>When a task is successfully merged to main</small>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.ntfyEvents?.includes("failed") ?? true}
                      onChange={(e) => {
                        const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const newEvents = e.target.checked
                          ? (current.includes("failed") ? current : [...current, "failed" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "failed");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    Task failed
                  </label>
                  <small>When a task fails during execution (high priority)</small>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.ntfyEvents?.includes("awaiting-approval") ?? true}
                      onChange={(e) => {
                        const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const newEvents = e.target.checked
                          ? (current.includes("awaiting-approval") ? current : [...current, "awaiting-approval" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "awaiting-approval");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    Plan needs approval
                  </label>
                  <small>When a task specification needs manual approval before execution</small>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.ntfyEvents?.includes("awaiting-user-review") ?? true}
                      onChange={(e) => {
                        const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const newEvents = e.target.checked
                          ? (current.includes("awaiting-user-review") ? current : [...current, "awaiting-user-review" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "awaiting-user-review");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    User review needed
                  </label>
                  <small>When an agent hands off a task for human review (high priority)</small>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.ntfyEvents?.includes("planning-awaiting-input") ?? true}
                      onChange={(e) => {
                        const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                        const newEvents = e.target.checked
                          ? (current.includes("planning-awaiting-input") ? current : [...current, "planning-awaiting-input" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "planning-awaiting-input");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    Planning needs input
                  </label>
                  <small>When planning mode is waiting for your response to continue</small>
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
              </>
            )}
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
        const tunnelState = remoteStatus?.state ?? "stopped";

        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Remote Access</h4>

            <div className="form-group">
              <label htmlFor="remoteActiveProvider">Active provider</label>
              <select
                id="remoteActiveProvider"
                className="select"
                value={activeProvider ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, remoteActiveProvider: (e.target.value || null) as "tailscale" | "cloudflare" | null } as SettingsFormState))}
              >
                <option value="">Not selected</option>
                <option value="tailscale">Tailscale Serve</option>
                <option value="cloudflare">Cloudflare Tunnel</option>
              </select>
              <div className="settings-button-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!activeProvider || remoteBusyAction !== null}
                  onClick={() => {
                    if (!activeProvider) return;
                    void runRemoteAction("activate provider", async () => {
                      await activateRemoteProvider(activeProvider, projectId);
                      addToast(`Activated ${activeProvider}`, "success");
                    });
                  }}
                >
                  Activate Provider
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void handleSaveRemoteSettings()}
                >
                  {remoteBusyAction === "save" ? "Saving…" : "Save Remote Settings"}
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Tailscale</label>
              <label htmlFor="remoteTailscaleEnabled" className="checkbox-label">
                <input
                  id="remoteTailscaleEnabled"
                  type="checkbox"
                  checked={Boolean(remoteForm.remoteTailscaleEnabled)}
                  onChange={(e) => setForm((f) => ({ ...f, remoteTailscaleEnabled: e.target.checked } as SettingsFormState))}
                />
                Enable Tailscale provider config
              </label>
              <label htmlFor="remoteTailscaleHostname">Hostname label</label>
              <input
                id="remoteTailscaleHostname"
                type="text"
                placeholder="tailnet label (optional)"
                value={String(remoteForm.remoteTailscaleHostname ?? "")}
                onChange={(e) => setForm((f) => ({ ...f, remoteTailscaleHostname: e.target.value } as SettingsFormState))}
              />
              <label htmlFor="remoteTailscaleTargetPort">Target port</label>
              <input
                id="remoteTailscaleTargetPort"
                type="number"
                min={1}
                max={65535}
                value={Number(remoteForm.remoteTailscaleTargetPort ?? 4040)}
                onChange={(e) => setForm((f) => ({ ...f, remoteTailscaleTargetPort: Number(e.target.value || 4040) } as SettingsFormState))}
              />
            </div>

            <div className="form-group">
              <label>Cloudflare</label>
              <label htmlFor="remoteCloudflareEnabled" className="checkbox-label">
                <input
                  id="remoteCloudflareEnabled"
                  type="checkbox"
                  checked={Boolean(remoteForm.remoteCloudflareEnabled)}
                  onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareEnabled: e.target.checked } as SettingsFormState))}
                />
                Enable Cloudflare provider config
              </label>
              <label htmlFor="remoteCloudflareTunnelName">Tunnel name</label>
              <input
                id="remoteCloudflareTunnelName"
                type="text"
                placeholder="Tunnel name"
                value={String(remoteForm.remoteCloudflareTunnelName ?? "")}
                onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareTunnelName: e.target.value } as SettingsFormState))}
              />
              <label htmlFor="remoteCloudflareTunnelToken">Tunnel token</label>
              <input
                id="remoteCloudflareTunnelToken"
                type="password"
                placeholder="Tunnel token"
                value={String(remoteForm.remoteCloudflareTunnelToken ?? "")}
                onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareTunnelToken: e.target.value } as SettingsFormState))}
              />
              <label htmlFor="remoteCloudflareIngressUrl">Ingress URL</label>
              <input
                id="remoteCloudflareIngressUrl"
                type="text"
                placeholder="https://your-domain.example"
                value={String(remoteForm.remoteCloudflareIngressUrl ?? "")}
                onChange={(e) => setForm((f) => ({ ...f, remoteCloudflareIngressUrl: e.target.value } as SettingsFormState))}
              />
            </div>

            <div className="form-group">
              <label>Tunnel lifecycle</label>
              <small>State: <strong>{tunnelState}</strong>{remoteStatus?.provider ? ` · Provider: ${remoteStatus.provider}` : ""}</small>
              {remoteStatus?.url && (
                <small>
                  URL:
                  <code className="settings-url-output">{remoteStatus.url}</code>
                </small>
              )}
              {remoteStatus?.lastError && <small className="field-error">{remoteStatus.lastError}</small>}
              <div className="settings-button-row">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void runRemoteAction("start tunnel", async () => {
                    await startRemoteTunnel(projectId);
                    addToast("Remote tunnel start requested", "success");
                  })}
                >
                  Start tunnel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void runRemoteAction("stop tunnel", async () => {
                    await stopRemoteTunnel(projectId);
                    addToast("Remote tunnel stopped", "success");
                  })}
                >
                  Stop tunnel
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Auth links</label>
              <div className="settings-button-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void runRemoteAction("regenerate persistent token", async () => {
                    await regenerateRemotePersistentToken(projectId);
                    addToast("Persistent token regenerated", "success");
                  })}
                >
                  Regenerate persistent token
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void runRemoteAction("generate short-lived token", async () => {
                    const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
                    const generated = await generateShortLivedRemoteToken(ttlMs, projectId);
                    setRemoteShortLivedToken(generated);
                    addToast("Short-lived token generated", "success");
                  })}
                >
                  Generate short-lived token
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void runRemoteAction("fetch remote url", async () => {
                    const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
                    const nextUrl = await fetchRemoteUrl({
                      projectId,
                      tokenType: remoteAuthLinkTokenType,
                      ttlMs: remoteAuthLinkTokenType === "short-lived" ? ttlMs : undefined,
                    });
                    setRemoteUrlPreview(nextUrl);
                    setRemoteQrSvg(null);
                  })}
                >
                  Show URL
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={remoteBusyAction !== null}
                  onClick={() => void runRemoteAction("generate QR", async () => {
                    const ttlMs = Number(remoteForm.remoteShortLivedTtlMs ?? 900000);
                    const qr = await fetchRemoteQr("image/svg", {
                      projectId,
                      tokenType: remoteAuthLinkTokenType,
                      ttlMs: remoteAuthLinkTokenType === "short-lived" ? ttlMs : undefined,
                    });
                    setRemoteUrlPreview({ url: qr.url, expiresAt: qr.expiresAt, tokenType: qr.tokenType });
                    setRemoteQrSvg(qr.data ?? null);
                  })}
                >
                  Generate QR
                </button>
              </div>
              <label htmlFor="remoteAuthLinkTokenType">Auth link token type</label>
              <select
                id="remoteAuthLinkTokenType"
                value={remoteAuthLinkTokenType}
                onChange={(e) => setRemoteAuthLinkTokenType(e.target.value as "persistent" | "short-lived")}
              >
                <option value="persistent">Persistent token</option>
                <option value="short-lived">Short-lived token</option>
              </select>
              <small>
                URL and QR generation use the selected token type.
                {remoteAuthLinkTokenType === "short-lived" ? ` TTL: ${Number(remoteForm.remoteShortLivedTtlMs ?? 900000)}ms.` : ""}
              </small>
              <label htmlFor="remoteShortLivedEnabled" className="checkbox-label">
                <input
                  id="remoteShortLivedEnabled"
                  type="checkbox"
                  checked={Boolean(remoteForm.remoteShortLivedEnabled)}
                  onChange={(e) => setForm((f) => ({ ...f, remoteShortLivedEnabled: e.target.checked } as SettingsFormState))}
                />
                Enable short-lived tokens
              </label>
              <label htmlFor="remoteShortLivedTtlMs">Short-lived TTL (ms)</label>
              <input
                id="remoteShortLivedTtlMs"
                type="number"
                min={60000}
                max={86400000}
                value={Number(remoteForm.remoteShortLivedTtlMs ?? 900000)}
                onChange={(e) => setForm((f) => ({ ...f, remoteShortLivedTtlMs: Number(e.target.value || 900000) } as SettingsFormState))}
              />
              {remoteShortLivedToken && (
                <small>
                  Last short-lived token expires at {new Date(remoteShortLivedToken.expiresAt).toLocaleString()} ({remoteShortLivedToken.ttlMs}ms)
                </small>
              )}
              {remoteUrlPreview?.url && (
                <>
                  <small>
                    Authenticated URL:
                    <code className="settings-url-output">{remoteUrlPreview.url}</code>
                  </small>
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
                    <img
                      src={`data:image/svg+xml;utf8,${encodeURIComponent(remoteQrSvg)}`}
                      alt="Remote access QR code"
                      className="settings-qr-preview-image"
                    />
                  </div>
                  <details>
                    <summary>QR SVG markup</summary>
                    <pre className="settings-raw-output">{remoteQrSvg}</pre>
                  </details>
                </div>
              )}
            </div>
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
              <>
              {cliAuthProviders.some((p) => p.id === "claude-cli") && (
                <ClaudeCliProviderCard
                  compact
                  authenticated={
                    cliAuthProviders.find((p) => p.id === "claude-cli")
                      ?.authenticated ?? false
                  }
                  onToggled={() => {
                    void loadAuthStatus();
                  }}
                />
              )}
              {authenticatedProviders.length === 0 && (
                <div className="auth-section-hint">
                  Sign in to at least one provider to get started with AI models.
                </div>
              )}
              {authenticatedProviders.length > 0 && (
                <div className="auth-provider-group">
                  <div className="auth-group-label">Authenticated</div>
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
                          </div>
                        ) : (
                          <div>
                            {authActionInProgress === provider.id ? (
                              <button className="btn btn-sm" disabled>
                                Logging out…
                              </button>
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
              {unauthenticatedProviders.length > 0 && (
                <div className="auth-provider-group">
                  <div className="auth-group-label">Available</div>
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
                          </div>
                        ) : (
                          <div>
                            {authActionInProgress === provider.id ? (
                              <button className="btn btn-sm" disabled>
                                Waiting for login…
                              </button>
                            ) : (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleLogin(provider.id)}
                              >
                                Login
                              </button>
                            )}
                            {loginInstructions[provider.id] && (
                              <p
                                className="auth-login-instructions"
                                data-testid={`auth-login-instructions-${provider.id}`}
                              >
                                {loginInstructions[provider.id]}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </>
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

          </>
        );
      }
    }
  };

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} role="dialog" aria-modal="true">
      <div className="modal modal-lg">
        <div className="modal-header">
          <div className="settings-modal-heading">
            <h3>Settings</h3>
            {appVersion && <p className="settings-modal-version">Version {appVersion}</p>}
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
            <div className="settings-content">
              {renderSectionFields()}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <div className="modal-actions-left">
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
