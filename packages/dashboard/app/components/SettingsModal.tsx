import { useState, useEffect, useCallback, useRef, type CSSProperties, type MouseEvent } from "react";
import { Globe, Folder, RefreshCw, Star, HelpCircle } from "lucide-react";
import {
  getErrorMessage,
  normalizeMergeIntegrationWorktreeMode,
  normalizeMergeAdvanceAutoSyncMode,
} from "@fusion/core";
import type { Settings, GlobalSettings, ThemeMode, ColorTheme, ModelPreset } from "@fusion/core";
import { fetchSettings, fetchSettingsByScope, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, cancelProviderLogin, saveApiKey, clearApiKey, fetchModels, testNotification, fetchBackups, createBackup, exportSettings, importSettings, fetchMemoryFile, fetchMemoryFiles, saveMemoryFile, compactMemory, fetchGlobalConcurrency, updateGlobalConcurrency, installQmd, testMemoryRetrieval, triggerMemoryDreams, fetchGitRemotes, fetchGitRemotesDetailed, fetchGitBranches, fetchProjects, fetchDashboardHealth, checkForUpdates, fetchRemoteSettings, fetchRemoteStatus, installCloudflared, fetchRemoteQr, fetchRemoteUrl, submitProviderManualCode } from "../api";
import type { AuthProvider, ManualOAuthCodeInfo, ModelInfo, BackupListResponse, SettingsExportData, MemoryFileInfo, MemoryRetrievalTestResult, GitRemote, GitRemoteDetailed, ProjectInfo, RemoteStatus, UpdateCheckResponse, OAuthDeviceCodeInfo } from "../api";
import { splitSettingsSave } from "./settings/save-split";
import { AppearanceSection } from "./settings/sections/AppearanceSection";
import { ExperimentalSection } from "./settings/sections/ExperimentalSection";
import { NodeSyncSection } from "./settings/sections/NodeSyncSection";
import { NotificationsSection } from "./settings/sections/NotificationsSection";
import { GlobalGeneralSection } from "./settings/sections/GlobalGeneralSection";
import { ResearchGlobalSection } from "./settings/sections/ResearchGlobalSection";
import { RemoteSection } from "./settings/sections/RemoteSection";
import { GlobalModelsSection } from "./settings/sections/GlobalModelsSection";
import { AuthenticationSection } from "./settings/sections/AuthenticationSection";
import {
  HermesRuntimeSection,
  OpenClawRuntimeSection,
  PaperclipRuntimeSection,
} from "./settings/sections/RuntimesSections";
import { SecretsSection } from "./settings/sections/SecretsSection";
import { PromptsSection } from "./settings/sections/PromptsSection";
import { GeneralSection } from "./settings/sections/GeneralSection";
import { ProjectModelsSection } from "./settings/sections/ProjectModelsSection";
import { SchedulingSection } from "./settings/sections/SchedulingSection";
import { ScheduledEvalsSection } from "./settings/sections/ScheduledEvalsSection";
import { NodeRoutingSection } from "./settings/sections/NodeRoutingSection";
import { WorktreesSection } from "./settings/sections/WorktreesSection";
import { CommandsSection } from "./settings/sections/CommandsSection";
import { MergeSection } from "./settings/sections/MergeSection";
import { AgentPermissionsSection } from "./settings/sections/AgentPermissionsSection";
import { MemorySection } from "./settings/sections/MemorySection";
import { ResearchProjectSection } from "./settings/sections/ResearchProjectSection";
import { BackupsSection } from "./settings/sections/BackupsSection";
import { PluginsSection } from "./settings/sections/PluginsSection";
import { useMemoryBackendStatus } from "../hooks/useMemoryBackendStatus";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import type { ToastType } from "../hooks/useToast";
import { useTranslation } from "react-i18next";
import { useSessionBannersHidden, setSessionBannersHidden } from "../hooks/useSessionBannerPref";
import "./SettingsModal.css";
import { FileBrowser } from "./FileBrowser";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { ProviderIcon } from "./ProviderIcon";
import { generateUniquePresetId } from "../utils/modelPresets";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import { appendTokenQuery, OAUTH_RELOGIN_SUCCESS_EVENT } from "../auth";
import { useConfirm } from "../hooks/useConfirm";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useNodes } from "../hooks/useNodes";
import { useViewportMode } from "../hooks/useViewportMode";
import { useWorktrunkInstallStatus } from "../hooks/useWorktrunkInstallStatus";
import { type TrackingRepoOption } from "./TrackingRepoSelect";
import { filterVisibleOnboardingAndSettingsProviders } from "./providerVisibility";

// ---------------------------------------------------------------------------
// GitHub star count — fetched once per session, cached in localStorage (1 h).
// ---------------------------------------------------------------------------
const GITHUB_STAR_CACHE_KEY = "fusion_github_star_count";
const GITHUB_STAR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_STAR_CLICKED_KEY = "fusion:github-star-clicked";

function DiscordIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      data-testid="discord-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M20.317 4.369A19.791 19.791 0 0 0 15.885 3a13.66 13.66 0 0 0-.696 1.412 18.27 18.27 0 0 0-6.378 0A13.627 13.627 0 0 0 8.115 3a19.736 19.736 0 0 0-4.432 1.369C.878 8.604.111 12.734.494 16.803a19.916 19.916 0 0 0 5.993 3.048 14.43 14.43 0 0 0 1.286-2.106 12.94 12.94 0 0 1-2.024-.977c.17-.122.337-.249.499-.381 3.908 1.838 8.149 1.838 12.01 0 .163.132.329.259.5.381a12.936 12.936 0 0 1-2.028.978 14.344 14.344 0 0 0 1.287 2.105 19.85 19.85 0 0 0 5.996-3.049c.449-4.713-.766-8.806-3.696-12.433zM8.02 14.335c-1.184 0-2.157-1.085-2.157-2.419 0-1.334.95-2.418 2.157-2.418 1.217 0 2.167 1.095 2.157 2.418 0 1.334-.95 2.419-2.157 2.419zm7.975 0c-1.184 0-2.157-1.085-2.157-2.419 0-1.334.95-2.418 2.157-2.418 1.217 0 2.167 1.095 2.157 2.418 0 1.334-.94 2.419-2.157 2.419z" />
    </svg>
  );
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
  labelKey: string;
  scope: "global" | "project" | undefined;
  icon?: typeof Globe;
  isGroupHeader?: boolean;
};

const MOBILE_SETTINGS_MEDIA_QUERY = "(max-width: 768px)";
const DEFAULT_MEMORY_EDITOR_PATH = ".fusion/memory/DREAMS.md";

const SETTINGS_SECTIONS: SettingsSection[] = [
  // Account group (scope-less items — independent of settings storage)
  { id: "__account_header", label: "Account", labelKey: "settings.nav.accountHeader", scope: undefined, isGroupHeader: true },
  { id: "authentication", label: "Authentication", labelKey: "settings.nav.authentication", scope: undefined, icon: Globe },

  // Global group (shared across all Fusion projects)
  { id: "__global_header", label: "Global", labelKey: "settings.nav.globalHeader", scope: undefined, isGroupHeader: true },
  { id: "global-general", label: "General", labelKey: "settings.nav.globalGeneral", scope: "global" },
  { id: "appearance", label: "Appearance", labelKey: "settings.nav.appearance", scope: "global" },
  { id: "notifications", label: "Notifications", labelKey: "settings.nav.notifications", scope: "global" },
  { id: "node-sync", label: "Node Sync", labelKey: "settings.nav.nodeSync", scope: "global" },
  { id: "global-models", label: "Models", labelKey: "settings.nav.globalModels", scope: "global" },
  { id: "cli-agents", label: "CLI Agents", labelKey: "settings.nav.cliAgents", scope: "global" },
  { id: "research-global", label: "Research Defaults", labelKey: "settings.nav.researchGlobal", scope: "global" },
  { id: "remote", label: "Remote Access & Node Sync", labelKey: "settings.nav.remote", scope: "global" },
  { id: "experimental", label: "Experimental Features", labelKey: "settings.nav.experimental", scope: "global" },

  // Runtimes group (plugin runtimes with their own settings)
  { id: "__runtimes_header", label: "Runtimes", labelKey: "settings.nav.runtimesHeader", scope: undefined, isGroupHeader: true },
  { id: "hermes-runtime", label: "Hermes", labelKey: "settings.nav.hermesRuntime", scope: "global" },
  { id: "openclaw-runtime", label: "OpenClaw", labelKey: "settings.nav.openclawRuntime", scope: "global" },
  { id: "paperclip-runtime", label: "Paperclip", labelKey: "settings.nav.paperclipRuntime", scope: "global" },

  // Project group (specific to this project)
  { id: "__project_header", label: "Project", labelKey: "settings.nav.projectHeader", scope: undefined, isGroupHeader: true },
  { id: "general", label: "Project General", labelKey: "settings.nav.projectGeneral", scope: "project" },
  { id: "commands", label: "Commands & Scripts", labelKey: "settings.nav.commands", scope: "project" },
  { id: "worktrees", label: "Worktrees", labelKey: "settings.nav.worktrees", scope: "project" },
  { id: "scheduling", label: "Scheduling & Capacity", labelKey: "settings.nav.scheduling", scope: "project" },
  { id: "scheduled-evals", label: "Scheduled Evals", labelKey: "settings.nav.scheduledEvals", scope: "project" },
  { id: "node-routing", label: "Node Routing", labelKey: "settings.nav.nodeRouting", scope: "project" },
  { id: "merge", label: "Merge", labelKey: "settings.nav.merge", scope: "project" },
  { id: "agent-permissions", label: "Agents & Permissions", labelKey: "settings.nav.agentPermissions", scope: "project" },
  { id: "memory", label: "Memory", labelKey: "settings.nav.memory", scope: "project" },
  { id: "backups", label: "Backups", labelKey: "settings.nav.backups", scope: "project" },
  { id: "research-project", label: "Research", labelKey: "settings.nav.researchProject", scope: "project" },
  { id: "project-models", label: "Project Models", labelKey: "settings.nav.projectModels", scope: "project" },
  { id: "secrets", label: "Secrets", labelKey: "settings.nav.secrets", scope: "project" },
  { id: "prompts", label: "Prompts", labelKey: "settings.nav.prompts", scope: "project" },
  { id: "plugins", label: "Plugins", labelKey: "settings.nav.plugins", scope: "project" },
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
  workflowGraphExecutor: "Workflow Graph Engine (run custom workflows)",
  workflowInterpreterDualObserve: "Workflow Graph Engine — dual-observe parity (diagnostic)",
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
  /**
   * Closes this modal and opens the workflow node editor with its Settings panel
   * pre-selected for the project's default workflow. Used by the moved-settings
   * redirect stubs (U9 / KTD-5, R10). Optional so the modal renders standalone.
   */
  onOpenWorkflowSettings?: () => void;
}

/** Adapter descriptor served by GET /api/cli-agents (U15). */
interface CliAdapterDescriptorView {
  id: string;
  name: string;
  tier: "native" | "hybrid" | "generic";
  defaultCommand: string | null;
}

interface CliAgentSettingsEntry {
  commandOverride?: string;
  extraArgs?: string[];
  autonomyMode?: "default" | "elevated";
  envAdditions?: string[];
}

/**
 * Per-adapter CLI-agent launch settings section (U15). Reads the adapter catalog
 * + persisted settings + per-project autonomy approval state, and lets the
 * operator edit command override / extra args / env additions / autonomy mode.
 * Switching an adapter to elevated autonomy goes through an explicit
 * confirmation flow before the per-project approval is granted.
 */
function CliAgentsSettingsSection({
  projectId: _projectId,
  addToast,
}: {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
}) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const [adapters, setAdapters] = useState<CliAdapterDescriptorView[]>([]);
  const [settings, setSettings] = useState<Record<string, CliAgentSettingsEntry>>({});
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catRes, setRes] = await Promise.all([
          fetch("/api/cli-agents"),
          fetch("/api/cli-agents/settings"),
        ]);
        const cat = catRes.ok ? await catRes.json() : { adapters: [] };
        const set = setRes.ok ? await setRes.json() : { cliAgents: {} };
        if (cancelled) return;
        const list = (cat.adapters ?? []) as CliAdapterDescriptorView[];
        setAdapters(list);
        setSettings((set.cliAgents ?? {}) as Record<string, CliAgentSettingsEntry>);
        if (list.length > 0) setSelectedId((prev) => prev || list[0].id);
        // Approval state is per-adapter; fetch lazily per selection below.
      } catch {
        // Non-fatal: render the static fallback list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/cli-agents/${selectedId}/autonomy`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setApproved((prev) => ({ ...prev, [selectedId]: Boolean(data.approved) }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const current = settings[selectedId] ?? {};

  const persist = useCallback(
    async (adapterId: string, config: CliAgentSettingsEntry) => {
      try {
        const res = await fetch("/api/cli-agents/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapterId, config }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSettings((data.cliAgents ?? {}) as Record<string, CliAgentSettingsEntry>);
      } catch (err) {
        addToast(getErrorMessage(err) || t("settings.cliAgents.saveFailed"), "error");
      }
    },
    [addToast, t],
  );

  const updateCurrent = useCallback(
    (patch: Partial<CliAgentSettingsEntry>) => {
      if (!selectedId) return;
      const next = { ...current, ...patch };
      setSettings((prev) => ({ ...prev, [selectedId]: next }));
      void persist(selectedId, next);
    },
    [selectedId, current, persist],
  );

  const onAutonomyChange = useCallback(
    async (mode: "default" | "elevated") => {
      if (!selectedId) return;
      if (mode === "elevated") {
        const ok = await confirm({
          title: t("settings.cliAgents.elevatedConfirmTitle"),
          message: t("settings.cliAgents.elevatedConfirmBody"),
          confirmLabel: t("settings.cliAgents.elevatedConfirmAction"),
          danger: true,
        });
        if (!ok) return;
        // Record the per-project approval first, then persist the mode.
        try {
          const res = await fetch(`/api/cli-agents/${selectedId}/approve-autonomy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirm: true }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setApproved((prev) => ({ ...prev, [selectedId]: true }));
        } catch (err) {
          addToast(getErrorMessage(err) || t("settings.cliAgents.approveFailed"), "error");
          return;
        }
      }
      updateCurrent({ autonomyMode: mode });
    },
    [selectedId, confirm, t, addToast, updateCurrent],
  );

  return (
    <div data-testid="cli-agents-settings">
      <h4 className="settings-section-heading">{t("settings.cliAgents.heading")}</h4>
      <p className="settings-section-description">{t("settings.cliAgents.description")}</p>

      <div className="form-group">
        <label htmlFor="cliAgentAdapter">{t("settings.cliAgents.adapterLabel")}</label>
        <select
          id="cliAgentAdapter"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({t(`settings.cliAgents.tier.${a.tier}`)})
            </option>
          ))}
        </select>
      </div>

      {selectedId && (
        <>
          <div className="form-group">
            <label htmlFor="cliAgentCommand">{t("settings.cliAgents.commandLabel")}</label>
            <input
              id="cliAgentCommand"
              type="text"
              placeholder={
                adapters.find((a) => a.id === selectedId)?.defaultCommand ?? ""
              }
              value={current.commandOverride ?? ""}
              onChange={(e) => updateCurrent({ commandOverride: e.target.value || undefined })}
            />
            <p className="settings-field-help">{t("settings.cliAgents.commandHelp")}</p>
          </div>

          <div className="form-group">
            <label htmlFor="cliAgentExtraArgs">{t("settings.cliAgents.extraArgsLabel")}</label>
            <input
              id="cliAgentExtraArgs"
              type="text"
              value={(current.extraArgs ?? []).join(" ")}
              onChange={(e) =>
                updateCurrent({
                  extraArgs: e.target.value.split(/\s+/).filter((s) => s.length > 0),
                })
              }
            />
            <p className="settings-field-help">{t("settings.cliAgents.extraArgsHelp")}</p>
          </div>

          <div className="form-group">
            <label htmlFor="cliAgentEnv">{t("settings.cliAgents.envLabel")}</label>
            <input
              id="cliAgentEnv"
              type="text"
              value={(current.envAdditions ?? []).join(", ")}
              onChange={(e) =>
                updateCurrent({
                  envAdditions: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
            />
            <p className="settings-field-help">{t("settings.cliAgents.envHelp")}</p>
          </div>

          <div className="form-group">
            <label htmlFor="cliAgentAutonomy">{t("settings.cliAgents.autonomyLabel")}</label>
            <select
              id="cliAgentAutonomy"
              value={current.autonomyMode ?? "default"}
              onChange={(e) => void onAutonomyChange(e.target.value as "default" | "elevated")}
            >
              <option value="default">{t("settings.cliAgents.autonomy.default")}</option>
              <option value="elevated">{t("settings.cliAgents.autonomy.elevated")}</option>
            </select>
            <p className="settings-field-help">
              {approved[selectedId]
                ? t("settings.cliAgents.approvedNote")
                : t("settings.cliAgents.autonomyHelp")}
            </p>
          </div>
        </>
      )}
    </div>
  );
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
  onOpenWorkflowSettings,
}: SettingsModalProps) {
  const { t } = useTranslation("app");
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
    merger: { mode: "ai", maxReviewPasses: 3, allowDirtyLocalCheckoutSync: false },
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
  // Guards the Save action against double-submit (rapid clicks / Enter) while the
  // parallel global+project writes are in flight.
  const [isSaving, setIsSaving] = useState(false);
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
          {t("settings.general.updateAvailablePrefix", "v{{version}} available", { version: updateCheckResult.latestVersion })} ·{" "}
          <a
            href="https://runfusion.ai"
            target="_blank"
            rel="noreferrer"
            className="settings-update-result-link"
          >
            {t("settings.general.learnMore", "Learn more")}
          </a>
        </>
      );
    }

    return t("settings.general.upToDate", "You're up to date ✓");
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
        title: t("settings.auth.manualPasteTitle", "Heads up — manual paste-back required"),
        message: t("settings.auth.manualPasteMessage", "After you sign in with {{name}}, the browser will try to redirect to a localhost address that this dashboard can't reach. The redirect tab will look like it failed. Before that happens, copy the full URL from the browser address bar — you'll paste it back here to finish login. Continue?", { name: provider.name }),
        confirmLabel: t("settings.auth.continueToLogin", "Continue to login"),
        cancelLabel: t("settings.actions.cancel", "Cancel"),
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
            addToast(t("settings.auth.loginSuccessful", "Login successful"), "success");
            window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT, { detail: { providerId } }));
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
            addToast(t("settings.auth.loginDidNotComplete", "Login did not complete. Please try again."), "error");
          }
        } catch {
          // Continue polling on transient errors
        }
      }, 2000);
    } catch (err) {
      const message = getErrorMessage(err) || "Login failed";
      const isConflict = message.includes("already in progress") || (typeof err === "object" && err !== null && "status" in err && (err as { status?: number }).status === 409);
      if (isConflict) {
        addToast(t("settings.auth.loginAlreadyInProgress", "Login already in progress. You can cancel it and retry."), "warning");
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
      addToast(t("settings.auth.pasteRedirectUrlFirst", "Paste the full redirect URL or authorization code first."), "warning");
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
        addToast(t("settings.auth.authCodeReceived", "Authorization code received. Finishing login…"), "success");
      } else {
        addToast(t("settings.auth.authCodeAlreadySubmitted", "That authorization code was already submitted. Waiting for login…"), "warning");
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
      addToast(t("settings.auth.loginCancelled", "Login cancelled"), "success");
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
      addToast(t("settings.auth.loggedOut", "Logged out"), "success");
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
      addToast(t("settings.auth.apiKeySaved", "API key saved"), "success");
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
      addToast(t("settings.auth.apiKeyCleared", "API key cleared"), "success");
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
        addToast(t("settings.backups.backupCreated", "Backup created successfully"), "success");
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
        if (result.workflowSettingsCount > 0) parts.push(`${result.workflowSettingsCount} workflow setting value(s)`);
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
    if (isSaving) return;
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

    setIsSaving(true);
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

      // Always save both global and project settings with strict scope
      // separation. The split (global vs project routing, null-as-delete, and
      // changed-only project writes) lives in the pure `splitSettingsSave`
      // helper so the regression-critical behavior is characterized in
      // isolation; see settings/save-split.ts.
      const { globalPatch, projectPatch } = splitSettingsSave({
        payload,
        initialValues,
        initialScopedValues,
        activeSection,
      });

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

      addToast(t("settings.general.settingsSaved", "Settings saved"), "success");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsSaving(false);
    }
  }, [form, globalMaxConcurrent, prefixError, presetDraft, initialValues, initialScopedValues, onClose, addToast, projectId, activeSection, isSaving, t]);

  const handleSaveMemory = useCallback(async () => {
    try {
      await saveMemoryFile(selectedMemoryPath, memoryContent, projectId);
      setMemoryDirty(false);
      addToast(t("settings.memory.memorySaved", "Memory saved"), "success");
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

      addToast(t("settings.memory.memoryCompacted", "Memory file compacted"), "success");
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
      addToast(t("settings.memory.dreamCompleted", "Dream processing completed"), "success");
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
      addToast(t("settings.models.presetNameRequired", "Preset name is required"), "error");
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
      addToast(t("settings.remote.cloudflaredInstalled", "cloudflared installed successfully"), "success");
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
          <span>{t("settings.scope.globalBanner", "These settings are shared across all your Fusion projects.")}</span>
        </div>
      );
    }
    if (activeSectionScope === "project") {
      return (
        <div className="settings-scope-banner settings-scope-project">
          <span className="settings-scope-icon"><Folder size={14} /></span>
          <span>{t("settings.scope.projectBanner", "These settings only affect this project.")}</span>
        </div>
      );
    }
    return null;
  };

  const renderSectionFields = () => {
    switch (activeSection) {
      case "cli-agents":
        return (
          <>
            {renderScopeBanner()}
            <CliAgentsSettingsSection projectId={projectId} addToast={addToast} />
          </>
        );
      case "general":
        return (
          <GeneralSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            projectId={projectId}
            addToast={addToast}
            prefixError={prefixError}
            setPrefixError={setPrefixError}
            projectTrackingRepoOptions={projectTrackingRepoOptions}
            projectTrackingRepoLoading={projectTrackingRepoLoading}
            projectTrackingRepoError={projectTrackingRepoError}
          />
        );
      case "global-general":
        return (
          <GlobalGeneralSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            globalTrackingRepoOptions={globalTrackingRepoOptions}
            globalTrackingRepoLoading={globalTrackingRepoLoading}
            globalTrackingRepoError={globalTrackingRepoError}
          />
        );
      case "global-models":
        return (
          <GlobalModelsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            availableModels={availableModels}
            modelsLoading={modelsLoading}
            globalModelLanes={MODEL_LANES.filter((lane) => lane.laneId !== "default")}
            favoriteProviders={favoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={handleToggleFavorite}
            onToggleModelFavorite={handleToggleModelFavorite}
          />
        );

      case "secrets":
        return <SecretsSection scopeBanner={renderScopeBanner()} addToast={addToast} />;

      case "project-models":
        return (
          <ProjectModelsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            projectId={projectId}
            addToast={addToast}
            onOpenWorkflowSettings={onOpenWorkflowSettings}
            models={{
              modelLanes: MODEL_LANES,
              getLaneStatus,
              getLaneValue,
              updateLaneValue,
              resetLaneValue,
              availableModels,
              modelsLoading,
              favoriteProviders,
              favoriteModels,
              onToggleFavorite: handleToggleFavorite,
              onToggleModelFavorite: handleToggleModelFavorite,
              editingPresetId,
              setEditingPresetId,
              presetDraft,
              setPresetDraft,
              onSavePresetDraft: savePresetDraft,
              confirmDelete: confirm,
            }}
          />
        );
      case "appearance":
        return (
          <AppearanceSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            themeMode={themeMode}
            colorTheme={colorTheme}
            dashboardFontScalePct={dashboardFontScalePct}
            onThemeModeChange={onThemeModeChange}
            onColorThemeChange={onColorThemeChange}
            onDashboardFontScaleChange={onDashboardFontScaleChange}
            sessionBannersHidden={sessionBannersHidden}
            setSessionBannersHidden={setSessionBannersHidden}
          />
        );
      case "scheduling":
        return (
          <SchedulingSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            globalMaxConcurrent={globalMaxConcurrent}
            onGlobalMaxConcurrentChange={(value) => {
              globalConcurrencyDirtyRef.current = true;
              setGlobalMaxConcurrent(value);
            }}
            onOverlapIgnorePathChange={handleOverlapIgnorePathChange}
            onOpenOverlapPathPicker={openOverlapPathPicker}
            onRemoveOverlapIgnorePath={handleRemoveOverlapIgnorePath}
            onAddOverlapIgnorePath={handleAddOverlapIgnorePath}
            onOpenWorkflowSettings={onOpenWorkflowSettings}
          />
        );
      case "scheduled-evals":
        return (
          <ScheduledEvalsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
          />
        );
      case "node-routing":
        return (
          <NodeRoutingSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            nodes={nodes}
          />
        );
      case "worktrees":
        return (
          <WorktreesSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            gitRemotes={gitRemotes}
            worktrunkInstall={worktrunkInstall}
            worktrunkInstallVerified={worktrunkInstallVerified}
            onOpenWorktreesDirPicker={openWorktreesDirPicker}
            onOpenApprovals={onOpenApprovals}
          />
        );
      case "commands":
        return (
          <CommandsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
          />
        );
      case "merge":
        return (
          <MergeSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            integrationBranchOptions={integrationBranchOptions}
            integrationBranchCustomMode={integrationBranchCustomMode}
            setIntegrationBranchCustomMode={setIntegrationBranchCustomMode}
            onOpenWorkflowSettings={onOpenWorkflowSettings}
          />
        );
      case "agent-permissions":
        return (
          <AgentPermissionsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
          />
        );
      case "memory":
        return (
          <MemorySection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            memory={{
              memoryCapabilities,
              memoryBackendStatus,
              memoryBackendLoading,
              memoryBackendError,
              memoryFiles,
              selectedMemoryPath,
              setSelectedMemoryPath,
              memoryContent,
              setMemoryContent,
              memoryLoading,
              memoryDirty,
              setMemoryDirty,
              memoryTestQuery,
              setMemoryTestQuery,
              memoryTestLoading,
              memoryTestResult,
              qmdInstallLoading,
              dreamRunning,
              memoryCompactLoading,
              onInstallQmd: handleInstallQmd,
              onTestMemoryRetrieval: handleTestMemoryRetrieval,
              onDreamNow: handleDreamNow,
              onCompactMemory: handleCompactMemory,
              onSaveMemory: handleSaveMemory,
            }}
          />
        );
      case "research-global":
        return (
          <ResearchGlobalSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            authProviders={authProviders}
            onNavigateToSection={setActiveSection}
          />
        );
      case "research-project":
        return (
          <ResearchProjectSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            researchLimitError={researchLimitError}
          />
        );
      case "experimental":
        return (
          <ExperimentalSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            knownFeatures={KNOWN_EXPERIMENTAL_FEATURES}
            legacyAliases={EXPERIMENTAL_FEATURE_LEGACY_ALIASES}
            getCanonicalKey={getCanonicalExperimentalFeatureKey}
            isFeatureEnabled={isExperimentalFeatureEnabled}
          />
        );
      case "backups":
        return (
          <BackupsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            backupInfo={backupInfo}
            backupLoading={backupLoading}
            onBackupNow={handleBackupNow}
          />
        );
      case "notifications":
        return (
          <NotificationsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            testNotificationLoading={testNotificationLoading}
            testNotificationResult={testNotificationResult}
            onTestProviderNotification={handleTestProviderNotification}
          />
        );
      case "node-sync":
        return (
          <NodeSyncSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
          />
        );
      case "remote":
        return (
          <RemoteSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            remote={{
              projectId,
              addToast,
              remoteStatus,
              externalTunnel,
              tunnelShareLink,
              remoteBusyAction,
              cloudflaredInstalling,
              cloudflaredInstallError,
              cloudflaredManualInstallCommand,
              cloudflaredMacFallbackCommand,
              handleInstallCloudflared,
              runRemoteAction,
              remoteShortLivedToken,
              setRemoteShortLivedToken,
              remoteAuthLinkTokenType,
              setRemoteAuthLinkTokenType,
              remoteUrlPreview,
              setRemoteUrlPreview,
              remoteQrSvg,
              setRemoteQrSvg,
            }}
          />
        );
      case "prompts":
        return <PromptsSection scopeBanner={renderScopeBanner()} form={form} setForm={setForm} />;
      case "plugins":
        return (
          <PluginsSection
            scopeBanner={renderScopeBanner()}
            projectId={projectId}
            addToast={addToast}
            activePluginsSubsection={activePluginsSubsection}
            setActivePluginsSubsection={setActivePluginsSubsection}
          />
        );
      case "authentication":
        return (
          <AuthenticationSection
            auth={{
              projectId,
              addToast,
              authProviders,
              authLoading,
              authActionInProgress,
              apiKeyInputs,
              setApiKeyInputs,
              apiKeyErrors,
              opencodeApiKeyRefreshStatus,
              deviceCodes,
              loginInstructions,
              manualCodeConfigs,
              manualCodeInputs,
              setManualCodeInputs,
              manualCodeSubmitInProgress,
              loadAuthStatus,
              handleLogin,
              handleLogout,
              handleCancelLogin,
              handleSaveApiKey,
              handleClearApiKey,
              handleSubmitManualCode,
              onReopenOnboarding,
            }}
          />
        );
      case "hermes-runtime":
        return <HermesRuntimeSection />;
      case "openclaw-runtime":
        return <OpenClawRuntimeSection />;
      case "paperclip-runtime":
        return <PaperclipRuntimeSection />;
    }
  };

  return (
    <div className="modal-overlay open settings-modal-overlay" {...overlayDismissProps} role="dialog" aria-modal="true">
      <div className="modal modal-lg settings-modal" ref={modalRef} style={keyboardStyle}>
        <div className="modal-header">
          <div className="settings-modal-heading">
            <h3>{t("settings.title", "Settings")}</h3>
          </div>
          <div className="settings-header-actions">
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
            <a
              href="https://discord.gg/ksrfuy7WYR"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm settings-header-discord-btn"
              aria-label="Join our Discord"
              title="Join our Discord"
            >
              <DiscordIcon size={13} />
              {t("settings.header.discord", "Discord")}
            </a>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {loading ? (
          <div className="settings-empty-state settings-loading">{t("settings.loading", "Loading…")}</div>
        ) : (
          <div className="settings-layout">
            {showMobileSectionPicker && (
              <div className="settings-mobile-section-picker">
                <label htmlFor="settings-mobile-section">{t("settings.mobileNav.label", "Settings Section")}</label>
                <select
                  id="settings-mobile-section"
                  className="select touch-target"
                  value={activeSection}
                  onChange={(event) => setActiveSection(event.target.value as SectionId)}
                >
                  {visibleSections.filter((section) => !section.isGroupHeader).map((section) => (
                    <option key={section.id} value={section.id}>
                      {t(section.labelKey, section.label)}
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
                      {t(section.labelKey, section.label)}
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
                        ? t("settings.nav.tooltip.global", "Shared across all projects")
                        : section.scope === "project"
                          ? t("settings.nav.tooltip.project", "Specific to this project")
                          : undefined
                    }
                  >
                    {section.scope === "global" && <Globe className="settings-scope-icon" aria-label={t("settings.nav.aria.global", "Global setting")} size={16} />}
                    {section.scope === "project" && <Folder className="settings-scope-icon" aria-label={t("settings.nav.aria.project", "Project setting")} size={16} />}
                    {section.icon && !section.scope && (
                      <section.icon className="settings-scope-icon" aria-label={t("settings.nav.aria.global", "Global setting")} size={16} />
                    )}
                    {t(section.labelKey, section.label)}
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
          <div className="settings-modal-footer-version">
            <a
              href="https://github.com/Runfusion/Fusion/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm settings-footer-help-btn"
              aria-label="Help and discussions"
              title="Help and discussions"
            >
              <HelpCircle size={13} aria-hidden="true" />
              {t("settings.footer.help", "Help")}
            </a>
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
                  <span className="settings-modal-version">{t("settings.footer.version", "Version {{version}}", { version: appVersion })}</span>
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
          <div className="modal-actions-left">
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleExport}
              title={t("settings.importExport.exportTitle", "Export settings to JSON file")}
            >
              {t("settings.importExport.exportBtn", "Export")}
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
              {importLoading ? t("settings.importExport.loadingFile", "Loading…") : t("settings.importExport.importBtn", "Import")}
            </button>
          </div>
          <div className="modal-actions-right">
            <button className="btn btn-sm" onClick={onClose}>
              {t("settings.actions.cancel", "Cancel")}
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={loading || isSaving}>
              {t("settings.actions.save", "Save")}
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
              <h3>{t("settings.scheduling.selectIgnoredOverlapPath", "Select ignored overlap path")}</h3>
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
                  {t("settings.actions.cancel", "Cancel")}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSelectCurrentDirectoryForOverlapIgnore}
                  disabled={overlapPathPickerCurrentPath === "."}
                >
                  {t("settings.scheduling.selectCurrentDir", "Select current directory")}
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
              <h3>{t("settings.worktrees.selectWorktreesDir", "Select worktrees directory")}</h3>
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
                  {t("settings.actions.cancel", "Cancel")}
                </button>
                <button className="btn btn-primary btn-sm" onClick={selectCurrentWorktreesDir}>
                  {t("settings.scheduling.selectCurrentDir", "Select current directory")}
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
              <h3>{t("settings.importExport.importTitle", "Import Settings")}</h3>
              <button className="modal-close" onClick={() => setImportDialogOpen(false)} aria-label="Close">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p>{t("settings.importExport.reviewPrompt", "Review the settings to be imported:")}</p>
              
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
                {t("settings.actions.cancel", "Cancel")}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleImport}
                disabled={importLoading}
              >
                {importLoading ? t("settings.importExport.importing", "Importing…") : t("settings.importExport.confirmImport", "Confirm Import")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
