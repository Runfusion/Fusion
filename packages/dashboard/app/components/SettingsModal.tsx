import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import { Globe, Folder, RefreshCw, Star, HelpCircle, Settings as SettingsIcon, Search, X as SearchToggleCloseIcon } from "lucide-react";
import {
  getErrorMessage,
  resolveGitlabConfig,
  normalizeMergeIntegrationWorktreeMode,
  normalizeMergeAdvanceAutoSyncMode,
} from "@fusion/core";
import type { Settings, GlobalSettings, ThemeMode, ColorTheme, ModelPreset } from "@fusion/core";
import { DEFAULT_GLOBAL_SETTINGS } from "@fusion/core";
import { fetchSettings, fetchSettingsByScope, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, cancelProviderLogin, saveApiKey, clearApiKey, fetchModels, testNotification, fetchBackups, createBackup, exportSettings, importSettings, fetchMemoryFile, fetchMemoryFiles, saveMemoryFile, compactMemory, fetchGlobalConcurrency, updateGlobalConcurrency, installQmd, testMemoryRetrieval, triggerMemoryDreams, fetchGitRemotes, fetchGitRemotesDetailed, fetchGitBranches, fetchProjects, fetchDashboardHealth, checkForUpdates, installUpdate, fetchRemoteSettings, fetchRemoteStatus, installCloudflared, fetchRemoteQr, fetchRemoteUrl, submitProviderManualCode } from "../api";
import type { AuthProvider, ManualOAuthCodeInfo, ModelInfo, BackupListResponse, SettingsExportData, MemoryFileInfo, MemoryRetrievalTestResult, GitRemote, GitRemoteDetailed, ProjectInfo, RemoteStatus, UpdateCheckResponse, UpdateInstallResponse, OAuthDeviceCodeInfo } from "../api";
import { splitSettingsSave } from "./settings/save-split";
import {
  ALL_PROJECT_RESET_KEYS,
  getResetIneligibleReason,
  getSectionKeyEntry,
} from "./settings/section-keys";
import {
  describeShortcutValidation,
  normalizeKeyboardShortcut,
  resolveDashboardKeyboardShortcuts,
  type DashboardShortcutAction,
} from "../utils/keyboardShortcuts";
import type { DashboardKeyboardShortcutMap } from "../utils/keyboardShortcuts";
import type { SectionSaveHandler } from "./settings/sections/context";
import { AppearanceSection } from "./settings/sections/AppearanceSection";
import { ExperimentalSection } from "./settings/sections/ExperimentalSection";
import { NodeSyncSection } from "./settings/sections/NodeSyncSection";
import { NotificationsSection } from "./settings/sections/NotificationsSection";
import { GlobalGeneralSection } from "./settings/sections/GlobalGeneralSection";
import { KeyboardShortcutsSection } from "./settings/sections/KeyboardShortcutsSection";
import { ResearchGlobalSection } from "./settings/sections/ResearchGlobalSection";
import { RemoteSection } from "./settings/sections/RemoteSection";
import { GlobalMcpSection } from "./settings/sections/GlobalMcpSection";
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
import { ProjectModelsSection, WorkflowLaneFlushRejection } from "./settings/sections/ProjectModelsSection";
import { SchedulingSection } from "./settings/sections/SchedulingSection";
import { ScheduledEvalsSection } from "./settings/sections/ScheduledEvalsSection";
import { NodeRoutingSection } from "./settings/sections/NodeRoutingSection";
import { WorktreesSection } from "./settings/sections/WorktreesSection";
import { CommandsSection } from "./settings/sections/CommandsSection";
import { MergeSection } from "./settings/sections/MergeSection";
import { AgentPermissionsSection } from "./settings/sections/AgentPermissionsSection";
import { MemorySection } from "./settings/sections/MemorySection";
import { ResearchProjectSection } from "./settings/sections/ResearchProjectSection";
import { ProjectMcpSection } from "./settings/sections/ProjectMcpSection";
import { BackupsSection } from "./settings/sections/BackupsSection";
import { LoadingSpinner } from "./LoadingSpinner";
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
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
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

function isSlashPrefixedAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

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
 *   - Global: User-level/shared sections (global-general, authentication, appearance,
 *     notifications, node-sync, global-models)
 *   - Runtimes: Global-scoped plugin runtime sections (hermes-runtime, openclaw-runtime,
 *     paperclip-runtime)
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
  searchableText?: string[];
  searchableKeys?: string[];
};

const MOBILE_SETTINGS_MEDIA_QUERY = "(max-width: 768px)";
const DEFAULT_MEMORY_EDITOR_PATH = ".fusion/memory/DREAMS.md";
const ADVANCED_SETTINGS_STORAGE_KEY = "fusion:settings:show-advanced";

/*
FNXC:SettingsSimplification 2026-07-10-23:24:
Settings opens in a focused mode that omits specialist integration, runtime, diagnostics, and infrastructure sections. The Advanced settings switch restores every section, applies consistently to desktop navigation, mobile navigation, and search, and persists only as a browser-local display preference so it never changes or exports project settings.
*/
const ADVANCED_SETTINGS_SECTION_IDS = new Set([
  "node-sync",
  "global-mcp",
  "cli-agents",
  "research-global",
  "remote",
  "experimental",
  "hermes-runtime",
  "openclaw-runtime",
  "paperclip-runtime",
  "scheduled-evals",
  "node-routing",
  "agent-permissions",
  "memory",
  "backups",
  "research-project",
  "secrets",
  "mcp",
  "prompts",
  "plugins",
]);

function readAdvancedSettingsPreference(): boolean {
  try {
    return localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function removeEmptySettingsGroups(sections: SettingsSection[]): SettingsSection[] {
  return sections.filter((section, index) => {
    if (!section.isGroupHeader) return true;
    for (const candidate of sections.slice(index + 1)) {
      if (candidate.isGroupHeader) return false;
      return true;
    }
    return false;
  });
}

function normalizeSettingsSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sectionMatchesSettingsSearch(
  section: SettingsSection,
  query: string,
  label: string,
  translateSearchKey: (key: string) => string,
): boolean {
  if (!query || section.isGroupHeader) {
    return true;
  }

  return [
    label,
    ...(section.searchableText ?? []),
    ...(section.searchableKeys ?? []).map((key) => translateSearchKey(key)),
  ]
    .map(normalizeSettingsSearchText)
    .some((candidate) => candidate.includes(query));
}

function filterSettingsSectionsForSearch(
  sections: SettingsSection[],
  query: string,
  translateLabel: (section: SettingsSection) => string,
  translateSearchKey: (key: string) => string,
): SettingsSection[] {
  if (!query) {
    return sections;
  }

  const matchedIds = new Set(
    sections
      .filter((section) => !section.isGroupHeader && sectionMatchesSettingsSearch(section, query, translateLabel(section), translateSearchKey))
      .map((section) => section.id),
  );

  return sections.filter((section, index) => {
    if (!section.isGroupHeader) {
      return matchedIds.has(section.id);
    }

    for (const candidate of sections.slice(index + 1)) {
      if (candidate.isGroupHeader) {
        return false;
      }
      if (matchedIds.has(candidate.id)) {
        return true;
      }
    }
    return false;
  });
}

function resolveFirstSelectableSettingsSection(sections: SettingsSection[], fallback: string): string {
  return sections.find((section) => !section.isGroupHeader)?.id ?? fallback;
}

/*
FNXC:SettingsNavigation 2026-07-04-00:00:
The mobile Settings section picker (`<select>` on narrow viewports) prefixes every
section option with its owning group (`Global — `/`Project — `) so entries are
unambiguous when labels collide across scopes (e.g. "MCP Servers" exists in both
Global and Project). The Authentication section is intentionally `scope: undefined`
(it is not backed by settings storage — see SETTINGS_SECTIONS), but it still lives
under the Global group header in SETTINGS_SECTIONS, so its mobile option rendered as
bare "Authentication" instead of "Global — Authentication", inconsistent with its
Global-group siblings (FN-7552). SETTINGS_SECTION_GROUP_LABEL_BY_ID maps every
non-header section id to the label of the most recent group-header row preceding it
in SETTINGS_SECTIONS, so resolveSettingsSectionOptionLabel can fall back to a
group-derived "Global — " prefix for storage-less sections that belong to the Global
group — without changing behavior for any section that already declares a scope
(Runtimes entries keep their existing scope:"global" path) or for undefined-scope
group-header rows themselves (which are never rendered as selectable options).
*/
function buildSettingsSectionGroupLabelMap(sections: SettingsSection[]): Map<string, string> {
  const map = new Map<string, string>();
  let currentGroupLabel: string | undefined;
  for (const section of sections) {
    if (section.isGroupHeader) {
      currentGroupLabel = section.label;
      continue;
    }
    if (currentGroupLabel !== undefined) {
      map.set(section.id, currentGroupLabel);
    }
  }
  return map;
}

function resolveSettingsSectionOptionLabel(section: SettingsSection, label: string): string {
  if (section.scope === "global") {
    return `Global — ${label}`;
  }
  if (section.scope === "project") {
    return `Project — ${label}`;
  }
  if (SETTINGS_SECTION_GROUP_LABEL_BY_ID.get(section.id) === "Global") {
    return `Global — ${label}`;
  }
  return label;
}

function resolveMaxAutoMergeRetriesForSettingsForm(settings?: { maxAutoMergeRetries?: unknown } | null): number {
  const configured = Number(settings?.maxAutoMergeRetries);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  // Global group (shared across all Fusion projects)
  { id: "__global_header", label: "Global", labelKey: "settings.nav.globalHeader", scope: undefined, isGroupHeader: true },
  { id: "global-general", label: "General", labelKey: "settings.nav.globalGeneral", scope: "global", searchableText: ["global defaults", "modal outside dismiss", "agent logs", "persist tool output", "thinking logs", "GitLab instance URL", "global tracking repo"] },
  { id: "keyboard-shortcuts", label: "Keyboard Shortcuts", labelKey: "settings.nav.keyboardShortcuts", scope: "global", searchableText: ["keyboard shortcuts", "hotkeys", "quick chat shortcut", "terminal shortcut", "open files", "open settings", "command center", "new task shortcut", "record shortcut"] },
  { id: "authentication", label: "Authentication", labelKey: "settings.nav.authentication", scope: undefined, icon: Globe, searchableText: ["login", "OAuth", "API key", "custom providers", "Anthropic", "OpenAI", "provider credentials"] },
  { id: "appearance", label: "Appearance", labelKey: "settings.nav.appearance", scope: "global", searchableText: ["theme", "color", "sidebar", "dock", "task popup", "open tasks as popups", "quick chat"] },
  { id: "notifications", label: "Notifications", labelKey: "settings.nav.notifications", scope: "global", searchableText: ["ntfy", "webhook", "events", "failure notifications", "sticky", "toast"] },
  { id: "node-sync", label: "Node Sync", labelKey: "settings.nav.nodeSync", scope: "global", searchableText: ["sync", "node", "distributed", "heartbeat", "coordination"] },
  { id: "global-models", label: "Models", labelKey: "settings.nav.globalModels", scope: "global", searchableText: ["global models", "model presets", "favorite providers", "model pricing overrides", "LiteLLM pricing", "token pricing"] },
  { id: "global-mcp", label: "MCP Servers", labelKey: "settings.nav.globalMcp", scope: "global", searchableText: ["global MCP servers", "shared MCP", "user MCP", "tool servers"] },
  {
    id: "cli-agents",
    label: "CLI Agents",
    labelKey: "settings.nav.cliAgents",
    scope: "global",
    searchableText: [
      "Droid CLI",
      "Cursor CLI",
      "agent runtime",
      "command line agents",
      "Adapter",
      "Command override",
      "Path or name of the binary to launch",
      "Extra arguments",
      "Appended after the adapter's computed arguments",
      "Environment variable additions",
      "Comma-separated variable names forwarded",
      "Autonomy mode",
      "Elevated autonomy requires a per-project approval",
    ],
    searchableKeys: [
      "settings.cliAgents.adapterLabel",
      "settings.cliAgents.commandLabel",
      "settings.cliAgents.commandHelp",
      "settings.cliAgents.extraArgsLabel",
      "settings.cliAgents.extraArgsHelp",
      "settings.cliAgents.envLabel",
      "settings.cliAgents.envHelp",
      "settings.cliAgents.autonomyLabel",
      "settings.cliAgents.autonomyHelp",
      "settings.cliAgents.approvedNote",
    ],
  },
  { id: "research-global", label: "Research Defaults", labelKey: "settings.nav.researchGlobal", scope: "global", searchableText: ["research providers", "external search providers", "fetch limits", "global research defaults", "citations"] },
  /*
  FNXC:SettingsNavigation 2026-06-26-09:20:
  FN-7062 requires the remote settings nav entry to read "Remote Access" only. The stale "& Node Sync" suffix belongs to the separate Node Sync settings section, while this section body already uses the Remote Access heading.
  */
  { id: "remote", label: "Remote Access", labelKey: "settings.nav.remote", scope: "global", searchableText: ["cloudflared", "tunnel", "QR", "persistent token", "remote URL"] },
  { id: "experimental", label: "Experimental Features", labelKey: "settings.nav.experimental", scope: "global", searchableText: ["feature flags", "experiments", "research view", "evals view", "sandbox", "subtask breakdown"] },

  // Runtimes group (plugin runtimes with their own settings)
  { id: "__runtimes_header", label: "Runtimes", labelKey: "settings.nav.runtimesHeader", scope: undefined, isGroupHeader: true },
  { id: "hermes-runtime", label: "Hermes", labelKey: "settings.nav.hermesRuntime", scope: "global", searchableText: ["Hermes runtime", "plugin runtime", "printer runtime"] },
  { id: "openclaw-runtime", label: "OpenClaw", labelKey: "settings.nav.openclawRuntime", scope: "global", searchableText: ["OpenClaw runtime", "plugin runtime", "open claw"] },
  { id: "paperclip-runtime", label: "Paperclip", labelKey: "settings.nav.paperclipRuntime", scope: "global", searchableText: ["Paperclip runtime", "plugin runtime"] },

  // Project group (specific to this project)
  { id: "__project_header", label: "Project", labelKey: "settings.nav.projectHeader", scope: undefined, isGroupHeader: true },
  { id: "general", label: "Project General", labelKey: "settings.nav.projectGeneral", scope: "project", searchableText: ["project general", "Completion Documentation Automation", "Quick Chat launcher", "ephemeral task-worker agents", "GitHub tracking", "GitLab integration", "chat rooms", "auto-cleanup old chats"] },
  { id: "commands", label: "Commands & Scripts", labelKey: "settings.nav.commands", scope: "project", searchableText: ["test command", "build command", "verification command", "workflow scripts", "commands"] },
  { id: "worktrees", label: "Worktrees", labelKey: "settings.nav.worktrees", scope: "project", searchableText: ["worktree directory", "copy files", "recycle worktrees", "branch naming", "sibling branch rename"] },
  { id: "scheduling", label: "Scheduling & Capacity", labelKey: "settings.nav.scheduling", scope: "project", searchableText: ["max concurrent", "capacity", "stuck tasks", "poll interval", "parallel steps", "scheduler"] },
  { id: "scheduled-evals", label: "Scheduled Evals", labelKey: "settings.nav.scheduledEvals", scope: "project", searchableText: ["scheduled evals", "evaluation schedule", "eval runs", "quality jobs"] },
  { id: "node-routing", label: "Node Routing", labelKey: "settings.nav.nodeRouting", scope: "project", searchableText: ["node routing", "routing rules", "node selection", "execution nodes"] },
  { id: "merge", label: "Merge", labelKey: "settings.nav.merge", scope: "project", searchableText: ["auto merge", "AI merge", "merge strategy", "plan approval", "direct merge", "integration branch", "push after merge"] },
  { id: "agent-permissions", label: "Agents & Permissions", labelKey: "settings.nav.agentPermissions", scope: "project", searchableText: ["agent provisioning", "approval", "permissions", "policy", "agent creation"] },
  { id: "memory", label: "Memory", labelKey: "settings.nav.memory", scope: "project", searchableText: ["memory backend", "Dreams", "long-term memory", "qmd", "memory file", "retrieval"] },
  { id: "backups", label: "Backups", labelKey: "settings.nav.backups", scope: "project", searchableText: ["backup", "restore", "settings export", "settings import"] },
  { id: "research-project", label: "Research", labelKey: "settings.nav.researchProject", scope: "project", searchableText: ["project research", "research runs", "citations", "search limits", "fetch synthesis"] },
  { id: "project-models", label: "Project Models", labelKey: "settings.nav.projectModels", scope: "project", searchableText: ["default provider", "default model", "workflow model lanes", "Plan/Triage", "Executor", "Reviewer", "summarization model"] },
  { id: "secrets", label: "Secrets", labelKey: "settings.nav.secrets", scope: "project", searchableText: ["secrets", "secret storage", "environment", "credentials"] },
  { id: "mcp", label: "MCP Servers", labelKey: "settings.nav.mcp", scope: "project", searchableText: ["project MCP servers", "workspace MCP", "project tool servers", "mcp config"] },
  { id: "prompts", label: "Prompts", labelKey: "settings.nav.prompts", scope: "project", searchableText: ["prompt instructions", "PR title prompt", "PR description prompt", "custom prompts"] },
  { id: "plugins", label: "Plugins", labelKey: "settings.nav.plugins", scope: "project", searchableText: ["Fusion plugins", "Pi extensions", "plugin manager", "extension marketplace"] },
];

// FNXC:SettingsNavigation 2026-07-04-00:00: sectionId -> owning group label ("Global"/"Runtimes"/"Project"),
// derived once from SETTINGS_SECTIONS order. Used by resolveSettingsSectionOptionLabel to prefix
// storage-less (scope: undefined) sections like "authentication" that belong to the Global group (FN-7552).
const SETTINGS_SECTION_GROUP_LABEL_BY_ID = buildSettingsSectionGroupLabelMap(SETTINGS_SECTIONS);

/** Well-known experimental feature flags with display labels.
 *  These always appear in the Experimental Features settings tab,
 *  regardless of whether they exist in the project's settings blob.
 *  IMPORTANT: Dev Server is canonically keyed by `devServerView`; `devServer`
 *  is treated as a legacy alias and must never render as a second row. */
const KNOWN_EXPERIMENTAL_FEATURES: Record<string, string> = {
  insights: "Insights",
  memoryView: "Memory Editor",
  skillsView: "Skills View",
  nodesView: "Nodes View",
  devServerView: "Dev Server",
  todoView: "Todo List",
  researchView: "Research View",
  evalsView: "Evals View",
  goalsView: "Goals View",
  /* FNXC:QuickAddSubtaskFlag 2026-06-21-00:00: The AI subtask-breakdown quick-add affordance is exposed only through this default-off experimental flag so missing settings keep every quick-add Subtask button hidden. */
  subtaskBreakdown: "Subtask Breakdown",
  leftSidebarNav: "Left Sidebar Navigation",
  sandbox: "Sandbox (command isolation)",
  chatRooms: "Chat Rooms",
  agentOnboarding: "Planning-style Agent Onboarding",
  workflowInterpreterDualObserve: "Workflow Graph Engine — dual-observe parity (diagnostic)",
};

/*
FNXC:SettingsExperimental 2026-06-22-17:55:
Workflow rollout diagnostics remain supported in persisted settings and engine code, but they are no longer normal user-facing Experimental toggles. Hide dual-observe from the settings list so operators do not accidentally flip runtime diagnostic switches from the product UI.

FNXC:SettingsExperimental 2026-06-22-18:00:
workflowGraphExecutor and workflowColumns graduated from Experimental. They are intentionally absent from the known-label registry, but remain in the hidden registry so stale persisted values never render as resurrected unknown settings while runtime code ignores them.

FNXC:SettingsExperimental 2026-06-22-18:50:
The Roadmaps dashboard view and experiment were removed from the product surface. Hide stale persisted `roadmap` values so Settings does not expose a dead toggle.

FNXC:SettingsExperimental 2026-06-22-18:00:
Right Dock Panel is no longer experimental: keep honoring the dock as always-on in App, but hide any stale persisted `rightDock` setting from the Experimental list.

FNXC:SettingsExperimental 2026-06-23-01:31:
Chat Rooms, Goals, Memory, Insights, Skills, and Todo graduated from Experimental. Hide stale persisted flags so users cannot accidentally disable now-default dashboard surfaces during upgrades.

FNXC:SettingsExperimental 2026-06-26-00:00:
Remote Access graduated from Experimental — section is always available; stale persisted `remoteAccess` flags are hidden so upgrades cannot disable it.
*/
const HIDDEN_EXPERIMENTAL_FEATURE_KEYS = new Set<string>([
  "chatRooms",
  "goalsView",
  "insights",
  "memoryView",
  "remoteAccess",
  "roadmap",
  "rightDock",
  "skillsView",
  "todoView",
  "workflowColumns",
  "workflowGraphExecutor",
  "workflowInterpreterDualObserve",
]);

/*
FNXC:Navigation 2026-06-21-00:00:
The dashboard owns the left sidebar default-on rollout because the shared experimental-feature helper must keep default-off semantics for unrelated experiments. Keep this set local to Settings so toggle checked-state matches App's `leftSidebarNav !== false` derivation without changing core behavior.

FNXC:Navigation 2026-06-22-18:00:
Only Left Sidebar Navigation remains a default-on experimental toggle; right dock was promoted to always-on app chrome and is hidden from this settings surface.
*/
const DEFAULT_ON_EXPERIMENTAL_FEATURES = new Set<string>(["leftSidebarNav"]);

const EXPERIMENTAL_FEATURE_LEGACY_ALIASES: Record<string, string> = {
  devServer: "devServerView",
};

function getCanonicalExperimentalFeatureKey(key: string): string {
  return EXPERIMENTAL_FEATURE_LEGACY_ALIASES[key] ?? key;
}
function isExperimentalFeatureEnabled(features: Record<string, boolean>, key: string): boolean {
  if (features[key] === true) return true;
  if (features[key] === false) return false;
  if (Object.entries(EXPERIMENTAL_FEATURE_LEGACY_ALIASES).some(([legacyKey, canonicalKey]) => canonicalKey === key && features[legacyKey] === true)) return true;
  return DEFAULT_ON_EXPERIMENTAL_FEATURES.has(key);
}

function isDashboardExperimentalFeatureEnabled(features: Record<string, boolean>, key: string): boolean {
  const canonicalKey = getCanonicalExperimentalFeatureKey(key);
  if (DEFAULT_ON_EXPERIMENTAL_FEATURES.has(canonicalKey) && features[canonicalKey] === undefined) {
    return true;
  }
  return isExperimentalFeatureEnabled(features, canonicalKey);
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

function normalizeWorktreeCopyFilesForSave(paths?: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawPath of paths ?? []) {
    const path = rawPath.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

type LegacySectionId = "pi-extensions";
export type SectionId = SettingsSection["id"] | LegacySectionId;

const DEFAULT_SETTINGS_SECTION: SectionId = "global-general";

type PluginsSubsectionId = "fusion-plugins" | "pi-extensions";

/** Local form state extends Settings with a worktreeInitCommand override and lets tokenCap carry null (delete semantic). */
type SettingsFormState = Settings & { worktreeInitCommand?: string; tokenCap?: number | null };
type GlobalGitlabSettings = Pick<GlobalSettings, "gitlabEnabled" | "gitlabInstanceUrl" | "gitlabApiBaseUrl" | "gitlabAuthToken" | "gitlabAuthTokenType">;

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
  /** Current shadcn-custom color overrides */
  shadcnCustomColors?: Record<string, string>;
  /** Resolved theme mode for shadcn-custom defaults */
  resolvedThemeMode?: "dark" | "light";
  /** Called when dashboard font scale changes */
  onDashboardFontScaleChange?: (scalePct: number) => void;
  /** Called when shadcn-custom color overrides change */
  onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
  /** Mirrors pending Quick Chat launcher changes into the app shell immediately. */
  onQuickChatButtonModeChange?: (mode: "floating" | "footer" | "off") => void;
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
  /*
  FNXC:Settings 2026-06-22-00:00:
  Settings renders both as a dialog overlay (presentation="modal", default) and as an embedded main-content view (presentation="embedded"). Embedded mode drops the fixed overlay backdrop and modal close button, fills the host pane, and disables modal-only behaviors (scroll lock, escape-to-close, resize-persist, overlay click-dismiss). The modal path is kept byte-identical for non-navigation callers (e.g. mobile/right-dock).
  */
  presentation?: ModalPresentation;
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
  /*
  FNXC:DashboardTheming 2026-07-03-00:00:
  Settings/onboarding surfaces that render before App threads persisted appearance settings should mirror fresh startup defaults: System mode with Shadcn Ember.
  */
  themeMode = "system",
  colorTheme = "shadcn-ember",
  onThemeModeChange,
  onColorThemeChange,
  dashboardFontScalePct = 100,
  shadcnCustomColors = {},
  resolvedThemeMode,
  onDashboardFontScaleChange,
  onShadcnCustomColorsChange,
  onQuickChatButtonModeChange,
  onReopenOnboarding,
  onOpenApprovals,
  onOpenWorkflowSettings,
  presentation = "modal",
}: SettingsModalProps) {
  const { isEmbedded, scrollLockEnabled, resizePersistEnabled, escapeEnabled, overlayDismissEnabled } = useEmbeddedPresentation(presentation);
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const viewportMode = useViewportMode();
  // Modal-only: lock background scroll on mobile. Embedded view owns its own scroll region.
  useMobileScrollLock(scrollLockEnabled);
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
  const workflowLaneSaverRef = useRef<SectionSaveHandler | null>(null);
  const registerWorkflowLaneSaver = useCallback((saver: SectionSaveHandler | null) => {
    workflowLaneSaverRef.current = saver;
  }, []);
  // Modal-only: persist user-resized dialog dimensions. Embedded view fills its host and is not resizable.
  useModalResizePersist(modalRef, resizePersistEnabled, "fusion:settings-modal-size");
  const sessionBannersHidden = useSessionBannersHidden();
  const [form, setForm] = useState<SettingsFormState>({
    maxConcurrent: 2,
    maxTriageConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    heartbeatMultiplier: 1,
    groupOverlappingFiles: true,
    ignoreHiddenOverlapPaths: true,
    overlapIgnorePaths: [],
    allowAbsoluteFileBrowserPaths: false,
    autoMerge: true,
    // FNXC:PlanApproval 2026-07-04-00:00: FN-7557: local fallback mirrors DEFAULT_PROJECT_SETTINGS — auto-approve-all is now the default project posture.
    planApprovalMode: "auto-approve-all",
    mergeStrategy: "direct",
    maxAutoMergeRetries: 3,
    mergeIntegrationWorktree: "reuse-task-worktree",
    mergeAdvanceAutoSync: "stash-and-ff",
    merger: { mode: "ai", maxReviewPasses: 3, allowDirtyLocalCheckoutSync: true },
    recycleWorktrees: false,
    showWorktreeGrouping: false,
    openTasksInRightSidebar: false,
    openMobileTasksInPopup: false,
    taskDetailChatFirst: false,
    executorAllowSiblingBranchRename: false,
    worktreeNaming: "random",
    worktreeCopyFiles: [],
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
    githubLinkImportedIssuesToTracking: false,
    prTitlePromptInstructions: "",
    prDescriptionPromptInstructions: "",
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
  const [globalGitlabSettings, setGlobalGitlabSettings] = useState<GlobalGitlabSettings | null>(null);
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
  /*
  FNXC:WindowsTerminalStartup 2026-07-04-06:30:
  Do NOT auto-probe worktrunk status on a plain Settings/dashboard mount — on Windows the
  status route resolves `wt`, which is Windows Terminal, and would pop its version dialog
  (field report Issue 4; the engine probeWorktrunk guard is the backstop). Probe only when
  the user is actually viewing the Worktrees section (a deliberate navigation) or worktrunk
  is already enabled. Gating on `enabled` alone would deadlock: the enable toggle is disabled
  until status === "installed", but status would never be fetched until enabled.
  */
  const worktrunkInstall = useWorktrunkInstallStatus(projectId, {
    enabled: activeSection === "worktrees" || form.worktrunk?.enabled === true,
  });
  const worktrunkInstallVerified = worktrunkInstall.status === "installed";
  // Deterministic default: opening Plugins starts on Fusion Plugins unless legacy
  // `initialSection="pi-extensions"` is explicitly provided.
  const [activePluginsSubsection, setActivePluginsSubsection] = useState<PluginsSubsectionId>(() =>
    initialSection === "pi-extensions" ? "pi-extensions" : "fusion-plugins",
  );
  /*
  FNXC:Settings 2026-07-09-00:00:
  Mobile Settings navigation is controlled by both the viewport hook and the CSS media query because tests and embedded shells can mock one surface independently. Treat either mobile signal as sufficient so the compact picker/search-toggle path stays available whenever Settings is in mobile mode.
  */
  const [showMobileSectionPicker, setShowMobileSectionPicker] = useState(() =>
    viewportMode === "mobile" ||
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_SETTINGS_MEDIA_QUERY)?.matches === true
      : false),
  );
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(() => {
    const requestedSection = initialSection === "pi-extensions" ? "plugins" : initialSection;
    /*
    FNXC:SettingsSimplification 2026-07-10-23:24:
    Product links that intentionally open a specific advanced section must remain usable. Reveal advanced navigation for that Settings session, but do not persist the implicit reveal; only a direct user toggle changes the local-storage preference.
    */
    return readAdvancedSettingsPreference() || (requestedSection !== undefined && ADVANCED_SETTINGS_SECTION_IDS.has(requestedSection));
  });
  const handleAdvancedSettingsChange = useCallback((enabled: boolean) => {
    setShowAdvancedSettings(enabled);
    try {
      localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, String(enabled));
    } catch {
      // Storage can be unavailable in private/locked-down browser contexts; the in-session preference still works.
    }
  }, []);
  /*
   * FNXC:Settings 2026-07-09-00:00:
   * Mobile Settings previously always rendered the `.settings-search` row (label + input + result
   * count) above the section picker, eating vertical space even when the user was not searching.
   * On mobile only, the row now starts COLLAPSED behind a compact icon toggle; tapping it reveals
   * the input, tapping again hides it. Desktop/tablet is untouched — the row is always visible
   * there and the toggle never renders (see `isMobileSettingsSearch` below). Decision on the
   * active-query edge case: `settingsSearchQuery` state is never cleared by collapsing, so
   * re-expanding always restores the exact query and result count the user had before collapsing
   * (no forced auto-expand — the toggle stays user-controlled).
   */
  const [mobileSearchRowExpanded, setMobileSearchRowExpanded] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateCheckLoading, setUpdateCheckLoading] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResponse | null>(null);
  const [updateInstallLoading, setUpdateInstallLoading] = useState(false);
  const [updateInstallResult, setUpdateInstallResult] = useState<UpdateInstallResponse | null>(null);
  const gitHubStarCount = useGitHubStarCount();
  const [starClicked, markStarClicked] = useStarClickedFlag();
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [researchLimitError, setResearchLimitError] = useState<string | null>(null);
  const [overlapPathPickerIndex, setOverlapPathPickerIndex] = useState<number | null>(null);
  const [worktreesDirPickerOpen, setWorktreesDirPickerOpen] = useState(false);
  const [worktreeCopyFilePickerIndex, setWorktreeCopyFilePickerIndex] = useState<number | null>(null);
  /*
  FNXC:SettingsReset 2026-07-04-00:20:
  Reset Settings confirmation dialog state (FN-7506). `resetInFlight` guards both
  destructive actions against double-submit while the reset write + form refresh
  are in progress, mirroring the `isSaving` guard on the Save action.
  */
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetInFlight, setResetInFlight] = useState(false);

  const {
    entries: overlapPathPickerEntries,
    currentPath: overlapPathPickerCurrentPath,
    setPath: setOverlapPathPickerPath,
    loading: overlapPathPickerLoading,
    error: overlapPathPickerError,
    refresh: refreshOverlapPathPicker,
  } = useWorkspaceFileBrowser("project", overlapPathPickerIndex !== null, projectId, { allowAbsolutePaths: false });

  const {
    entries: worktreesDirPickerEntries,
    currentPath: worktreesDirPickerCurrentPath,
    setPath: setWorktreesDirPickerPath,
    loading: worktreesDirPickerLoading,
    error: worktreesDirPickerError,
    refresh: refreshWorktreesDirPicker,
  } = useWorkspaceFileBrowser("project", worktreesDirPickerOpen, projectId, { allowAbsolutePaths: false });

  const {
    entries: worktreeCopyFilePickerEntries,
    currentPath: worktreeCopyFilePickerCurrentPath,
    setPath: setWorktreeCopyFilePickerPath,
    loading: worktreeCopyFilePickerLoading,
    error: worktreeCopyFilePickerError,
    refresh: refreshWorktreeCopyFilePicker,
  } = useWorkspaceFileBrowser("project", worktreeCopyFilePickerIndex !== null, projectId, { allowAbsolutePaths: false });

  const { nodes } = useNodes();
  const experimentalFeatures = form.experimentalFeatures ?? {};
  const researchViewEnabled = isExperimentalFeatureEnabled(experimentalFeatures, "researchView");
  const evalsViewEnabled = isExperimentalFeatureEnabled(experimentalFeatures, "evalsView");
  const visibleSections = useMemo(() => removeEmptySettingsGroups(SETTINGS_SECTIONS.filter((section) => {
    if (!showAdvancedSettings && ADVANCED_SETTINGS_SECTION_IDS.has(section.id)) {
      return false;
    }

    if (section.id === "research-global" || section.id === "research-project") {
      return researchViewEnabled;
    }

    if (section.id === "scheduled-evals") {
      return evalsViewEnabled;
    }

    return true;
  })), [researchViewEnabled, evalsViewEnabled, showAdvancedSettings]);
  const firstVisibleSectionId = visibleSections.some((section) => section.id === DEFAULT_SETTINGS_SECTION)
    ? DEFAULT_SETTINGS_SECTION
    : resolveFirstSelectableSettingsSection(visibleSections, firstNonHeaderSection?.id ?? "general");
  const normalizedSettingsSearchQuery = normalizeSettingsSearchText(settingsSearchQuery);
  /*
  FNXC:SettingsSearch 2026-07-04-00:00:
  Operators need Settings search to find the section containing a setting without bypassing feature gates. Search filters only the already-visible section list, matches section labels plus real setting-label/help i18n keys and curated keywords, suppresses empty group headers, and keeps duplicate global/project labels distinguishable in the mobile picker.
  */
  const searchMatchedSections = useMemo(() => filterSettingsSectionsForSearch(
    visibleSections,
    normalizedSettingsSearchQuery,
    (section) => t(section.labelKey, section.label),
    (key) => t(key),
  ), [normalizedSettingsSearchQuery, t, visibleSections]);
  const searchableSectionOptions = searchMatchedSections.filter((section) => !section.isGroupHeader);
  const hasSettingsSearchQuery = normalizedSettingsSearchQuery.length > 0;
  const hasSettingsSearchResults = searchableSectionOptions.length > 0;
  // FNXC:Settings 2026-07-09-00:00: desktop/tablet always show the search row and never render the
  // toggle; mobile starts collapsed (`mobileSearchRowExpanded === false`) until the user taps it.
  const isMobileSettingsSearch = viewportMode === "mobile";
  const settingsSearchRowVisible = !isMobileSettingsSearch || mobileSearchRowExpanded;
  const firstSearchMatchedSectionId = resolveFirstSelectableSettingsSection(searchMatchedSections, firstVisibleSectionId);

  /** Get the scope of the currently active section */
  const activeSectionScope = visibleSections.find((s) => s.id === activeSection)?.scope;

  useEffect(() => {
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
      return;
    }

    if (hasSettingsSearchQuery && hasSettingsSearchResults && !searchMatchedSections.some((section) => section.id === activeSection)) {
      setActiveSection(firstSearchMatchedSectionId);
    }
  }, [activeSection, researchViewEnabled, evalsViewEnabled, firstVisibleSectionId, firstSearchMatchedSectionId, hasSettingsSearchQuery, hasSettingsSearchResults, searchMatchedSections, visibleSections]);

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
  const [globalConcurrencyLoaded, setGlobalConcurrencyLoaded] = useState(false);

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
      setShowMobileSectionPicker(viewportMode === "mobile" || (event ? event.matches : mediaQuery.matches));
    };

    updateMobilePicker();
    mediaQuery.addEventListener("change", updateMobilePicker);
    return () => mediaQuery.removeEventListener("change", updateMobilePicker);
  }, [viewportMode]);

  /*
  FNXC:SettingsReset 2026-07-04-00:15:
  Factored out of the initial-load effect so the FN-7506 reset handlers can
  re-fetch and re-normalize the merged + scoped settings after a reset write,
  refreshing the form to the just-reset values without duplicating the
  normalization logic. `showLoadingState` is false for post-reset refreshes so
  the whole modal doesn't flash back to the loading spinner.
  */
  const refreshSettingsForm = useCallback((showLoadingState: boolean) => {
    // Load both merged and scoped settings to enable inheritance detection
    return Promise.all([fetchSettings(projectId), fetchSettingsByScope(projectId)])
      .then(([s, scoped]) => {
        const normalizedSettings = {
          ...s,
          ignoreHiddenOverlapPaths: s.ignoreHiddenOverlapPaths ?? true,
          allowAbsoluteFileBrowserPaths: s.allowAbsoluteFileBrowserPaths === true,
          /*
          FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
          The Settings form normalizes missing taskDetailChatFirst to false so new and upgraded projects show the Activity-first default until an operator explicitly opts into Chat-first.
          */
          taskDetailChatFirst: s.taskDetailChatFirst === true,
          /*
          FNXC:GithubImportTracking 2026-07-01-00:00:
          Missing githubLinkImportedIssuesToTracking must render as unchecked and save as project-scoped false only after operator interaction; this keeps upgraded projects on legacy import behavior by default.
          */
          githubLinkImportedIssuesToTracking: s.githubLinkImportedIssuesToTracking === true,
          mergeIntegrationWorktree: normalizeMergeIntegrationWorktreeMode(s.mergeIntegrationWorktree),
          mergeAdvanceAutoSync: normalizeMergeAdvanceAutoSyncMode(s.mergeAdvanceAutoSync),
          maxAutoMergeRetries: resolveMaxAutoMergeRetriesForSettingsForm(s),
          worktreeCopyFiles: Array.isArray(s.worktreeCopyFiles) ? s.worktreeCopyFiles : [],
        };
        setForm(normalizedSettings);
        setInitialValues(normalizedSettings); // Store initial values to detect explicit clears
        setScopedSettings(scoped);
        setGlobalGitlabSettings({
          gitlabEnabled: scoped.global.gitlabEnabled,
          gitlabInstanceUrl: scoped.global.gitlabInstanceUrl,
          gitlabApiBaseUrl: scoped.global.gitlabApiBaseUrl,
          gitlabAuthToken: scoped.global.gitlabAuthToken,
          gitlabAuthTokenType: scoped.global.gitlabAuthTokenType,
        });
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
        if (showLoadingState) {
          setLoading(false);
        }
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
        if (showLoadingState) {
          setLoading(false);
        }
      });
  }, [addToast, projectId]);

  useEffect(() => {
    void refreshSettingsForm(true);
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
        setGlobalConcurrencyLoaded(true);
      })
      .catch(() => {
        // Silently fail — global concurrency may not be available
        setGlobalConcurrencyLoaded(true);
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
    setUpdateInstallResult(null);

    try {
      const result = await checkForUpdates();
      setUpdateCheckResult(result);

      if (result.error) {
        addToast(result.error, "error");
      }
    } catch (error) {
      const message = getErrorMessage(error) || t("settings.general.updateCheckFailed", "Failed to check for updates");
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
  }, [addToast, appVersion, t]);

  const handleInstallUpdate = useCallback(async () => {
    setUpdateInstallLoading(true);
    setUpdateInstallResult(null);

    try {
      const result = await installUpdate(projectId);
      setUpdateInstallResult(result);

      if (result.error) {
        addToast(result.error, "error");
        return;
      }

      if (result.updated) {
        addToast(t("settings.general.updateSuccessToast", "Update installed. Restart Fusion to apply it."), "success");
      }
    } catch (error) {
      const message = getErrorMessage(error) || t("settings.general.updateFailed", "Update failed");
      setUpdateInstallResult({
        currentVersion: updateCheckResult?.currentVersion ?? appVersion ?? "unknown",
        latestVersion: updateCheckResult?.latestVersion ?? null,
        updated: false,
        error: message,
      });
      addToast(message, "error");
    } finally {
      setUpdateInstallLoading(false);
    }
  }, [addToast, appVersion, projectId, t, updateCheckResult]);

  const renderUpdateCheckResultContent = useCallback(() => {
    if (!updateCheckResult) {
      return null;
    }

    if (updateCheckResult.error) {
      return updateCheckResult.error;
    }

    if (updateCheckResult.updateAvailable && updateCheckResult.latestVersion) {
      const installSucceeded = updateInstallResult?.updated === true;
      const installError = updateInstallResult?.error;

      return (
        <>
          <span>
            {t("settings.general.updateAvailablePrefix", "v{{version}} available", { version: updateCheckResult.latestVersion })} ·{" "}
            <a
              href="https://runfusion.ai"
              target="_blank"
              rel="noreferrer"
              className="settings-update-result-link"
            >
              {t("settings.general.learnMore", "Learn more")}
            </a>
          </span>
          {installSucceeded ? (
            <span className="settings-update-install-status settings-update-install-status--success" aria-live="polite">
              {t("settings.general.updateSuccess", "Updated to v{{version}} — restart Fusion to apply", {
                version: updateInstallResult.latestVersion ?? updateCheckResult.latestVersion,
              })}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-sm settings-update-now-btn"
              onClick={() => {
                void handleInstallUpdate();
              }}
              disabled={updateInstallLoading}
            >
              {updateInstallLoading ? (
                <>
                  <RefreshCw size={12} className="spinning" aria-hidden="true" />
                  {t("settings.general.updating", "Updating…")}
                </>
              ) : (
                t("settings.general.updateNow", "Update now")
              )}
            </button>
          )}
          {installError && (
            <span className="settings-update-install-status settings-update-install-status--error" aria-live="polite">
              {t("settings.general.updateFailedWithMessage", "Update failed: {{message}}", { message: installError })}
            </span>
          )}
        </>
      );
    }

    return t("settings.general.upToDate", "You're up to date ✓");
  }, [handleInstallUpdate, t, updateCheckResult, updateInstallLoading, updateInstallResult]);

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

  /*
  FNXC:ProviderAuth 2026-07-05-00:00:
  Interactive OAuth login finishes in the background after the auth URL/paste box is shown, so a failure (bad/expired pasted code, token-exchange rejection) only appears in the polled `/auth/status` as `loginError`. Surface that cause to the user once per distinct error instead of leaving login silently stuck, so paste-callback failures are diagnosable from the UI rather than only "it fails".
  */
  const shownLoginErrorsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const provider of authProviders) {
      const error = provider.loginError;
      if (!error) {
        if (provider.id in shownLoginErrorsRef.current) {
          delete shownLoginErrorsRef.current[provider.id];
        }
        continue;
      }
      if (shownLoginErrorsRef.current[provider.id] === error) {
        continue;
      }
      shownLoginErrorsRef.current[provider.id] = error;
      addToast(`${provider.name} login failed: ${error}`, "error");
    }
  }, [authProviders, addToast]);

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
      /*
      FNXC:Notifications 2026-06-23-08:49:
      Settings notification tests must send the current unsaved ntfy form values for every ntfy test affordance. Users validate the exact topic/server/token they just typed before saving, so message/room test requests carry the same request-scoped config as the general ntfy test.
      */
      const currentNtfyConfig = {
        ntfyEnabled: form.ntfyEnabled,
        ntfyTopic: form.ntfyTopic,
        ...(form.ntfyBaseUrl?.trim() ? { ntfyBaseUrl: form.ntfyBaseUrl.trim() } : {}),
        ...(form.ntfyAccessToken?.trim() ? { ntfyAccessToken: form.ntfyAccessToken.trim() } : {}),
      };
      const config = providerId === "ntfy"
        ? currentNtfyConfig
        : providerId === "ntfy-message"
          ? { ...currentNtfyConfig, messageEventType: "message:agent-to-user" }
          : providerId === "ntfy-room"
            ? { ...currentNtfyConfig, messageEventType: "message:room" }
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
        addToast(result.error || t("settings.backups.createFailed", "Failed to create backup"), "error");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || t("settings.backups.createFailed", "Failed to create backup"), "error");
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
      
      const scopeLabel = scope === "global"
        ? t("settings.importExport.scopeLabel.global", "global")
        : scope === "project"
          ? t("settings.importExport.scopeLabel.project", "project")
          : t("settings.importExport.scopeLabel.all", "all");
      addToast(t("settings.importExport.exported", "Settings exported ({{scope}} scope)", { scope: scopeLabel }), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("settings.importExport.exportFailed", "Failed to export settings"), "error");
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
      addToast(t("settings.importExport.invalidJson", "Invalid JSON file: {{error}}", { error: getErrorMessage(err) }), "error");
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
        if (result.globalCount > 0) parts.push(t("settings.importExport.counts.global", "{{count}} global", { count: result.globalCount }));
        if (result.projectCount > 0) parts.push(t("settings.importExport.counts.project", "{{count}} project", { count: result.projectCount }));
        if (result.workflowSettingsCount > 0) parts.push(t("settings.importExport.counts.workflowSettings", "{{count}} workflow setting value", { count: result.workflowSettingsCount }));
        addToast(t("settings.importExport.imported", "Imported {{counts}} setting(s)", { counts: parts.join(", ") }), "success");
        setImportDialogOpen(false);
        setImportPreview(null);
        setImportFile(null);
        // Refresh settings to show imported values
        const refreshed = await fetchSettings(projectId);
        setForm({
          ...refreshed,
          ignoreHiddenOverlapPaths: refreshed.ignoreHiddenOverlapPaths ?? true,
          allowAbsoluteFileBrowserPaths: refreshed.allowAbsoluteFileBrowserPaths === true,
        });
      } else {
        addToast(result.error || t("settings.importExport.importFailed", "Import failed"), "error");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || t("settings.importExport.importFailedDetailed", "Failed to import settings"), "error");
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

  // Modal-only: Escape dismisses the dialog. Embedded view is navigated away via the left sidebar, not Escape.
  // FNXC:SettingsReset 2026-07-04-00:30: Skipped while the Reset Settings confirmation dialog is
  // open so Escape closes only that dialog (its own listener below), not the whole Settings modal.
  useEffect(() => {
    if (!escapeEnabled) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !resetDialogOpen) onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, escapeEnabled, resetDialogOpen]);

  // Modal-only: backdrop click dismisses. Embedded view has no overlay backdrop.
  const modalOverlayDismissProps = useOverlayDismiss(onClose);
  const overlayDismissProps = overlayDismissEnabled ? modalOverlayDismissProps : {};

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
    globalThinkingKey?: keyof GlobalSettings;
    projectProviderKey: keyof Settings;
    projectModelKey: keyof Settings;
    projectThinkingKey?: keyof Settings;
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
      projectThinkingKey: "defaultThinkingLevelOverride",
      helperText: "Default AI model used for task execution when no per-task override is set.",
      fallbackOrder: "Project override → Global default lane → Automatic resolution",
    },
    {
      laneId: "execution",
      label: "Execution Model",
      globalProviderKey: "executionGlobalProvider",
      globalModelKey: "executionGlobalModelId",
      globalThinkingKey: "executionGlobalThinkingLevel",
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
      globalThinkingKey: "planningGlobalThinkingLevel",
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
      globalThinkingKey: "validatorGlobalThinkingLevel",
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
      globalThinkingKey: "titleSummarizerGlobalThinkingLevel",
      projectProviderKey: "titleSummarizerProvider",
      projectModelKey: "titleSummarizerModelId",
      projectThinkingKey: "titleSummarizerThinkingLevel",
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


  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * SettingsModal owns lane thinking persistence just like lane model persistence. Empty values clear the override so the engine falls back through task > lane > global default without sections writing settings directly.
   */
  function getLaneThinkingValue(lane: ModelLane, scope: "project" | "global" = "project"): string {
    const key = scope === "project" ? lane.projectThinkingKey : lane.globalThinkingKey;
    return key ? ((form[key as keyof Settings] as string | undefined) ?? "") : "";
  }

  function updateLaneThinkingValue(lane: ModelLane, level: string, scope: "project" | "global" = "project"): void {
    const key = scope === "project" ? lane.projectThinkingKey : lane.globalThinkingKey;
    if (!key) return;
    setForm((f) => ({
      ...f,
      [key]: level || undefined,
    }));
  }

  function resetLaneThinkingValue(lane: ModelLane, scope: "project" | "global" = "project"): void {
    updateLaneThinkingValue(lane, "", scope);
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

    /*
    FNXC:FileBrowserAbsolutePaths 2026-06-29-00:00:
    The project-level absolute file-browser setting must not widen settings fields whose saved values are consumed as project-relative patterns. Reject slash-prefixed picker selections at the form boundary so overlapIgnorePaths cannot persist filesystem-absolute paths.
    */
    if (isSlashPrefixedAbsolutePath(path)) return;

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
    if (isSlashPrefixedAbsolutePath(path)) return;

    const normalizedPath = path.endsWith("/") ? path : `${path}/`;
    setForm((f) => ({ ...f, worktreesDir: normalizedPath }));
    closeWorktreesDirPicker();
  }, [closeWorktreesDirPicker]);

  const selectCurrentWorktreesDir = useCallback(() => {
    if (isSlashPrefixedAbsolutePath(worktreesDirPickerCurrentPath)) return;

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

  const openWorktreeCopyFilePicker = useCallback((index: number) => {
    setWorktreeCopyFilePickerIndex(index);
    setWorktreeCopyFilePickerPath(".");
  }, [setWorktreeCopyFilePickerPath]);

  const closeWorktreeCopyFilePicker = useCallback(() => {
    setWorktreeCopyFilePickerIndex(null);
  }, []);

  const selectWorktreeCopyFile = useCallback((path: string) => {
    if (worktreeCopyFilePickerIndex === null) return;

    /*
    FNXC:FileBrowserAbsolutePaths 2026-06-29-00:00:
    worktreeCopyFiles are copied from the project workspace into task worktrees. Keep this picker project-relative even when the standalone Files browser can browse slash-prefixed absolute paths.
    */
    if (isSlashPrefixedAbsolutePath(path)) return;

    setForm((f) => {
      const currentPaths = f.worktreeCopyFiles && f.worktreeCopyFiles.length > 0
        ? [...f.worktreeCopyFiles]
        : [""];
      currentPaths[worktreeCopyFilePickerIndex] = path;
      return { ...f, worktreeCopyFiles: currentPaths };
    });

    closeWorktreeCopyFilePicker();
  }, [worktreeCopyFilePickerIndex, closeWorktreeCopyFilePicker]);

  const handleWorktreeCopyFilePickerOverlayClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeWorktreeCopyFilePicker();
    }
  }, [closeWorktreeCopyFilePicker]);

  const handleWorktreeCopyFileChange = useCallback((index: number, value: string) => {
    setForm((f) => {
      const currentPaths = f.worktreeCopyFiles && f.worktreeCopyFiles.length > 0
        ? [...f.worktreeCopyFiles]
        : [""];
      currentPaths[index] = value;
      return { ...f, worktreeCopyFiles: currentPaths };
    });
  }, []);

  const handleRemoveWorktreeCopyFile = useCallback((index: number) => {
    setForm((f) => {
      const currentPaths = f.worktreeCopyFiles && f.worktreeCopyFiles.length > 0
        ? [...f.worktreeCopyFiles]
        : [""];
      const nextPaths = currentPaths.filter((_, i) => i !== index);
      return { ...f, worktreeCopyFiles: nextPaths.length > 0 ? nextPaths : [] };
    });

    if (worktreeCopyFilePickerIndex === index) {
      closeWorktreeCopyFilePicker();
      return;
    }

    if (worktreeCopyFilePickerIndex !== null && worktreeCopyFilePickerIndex > index) {
      setWorktreeCopyFilePickerIndex(worktreeCopyFilePickerIndex - 1);
    }
  }, [worktreeCopyFilePickerIndex, closeWorktreeCopyFilePicker]);

  const handleAddWorktreeCopyFile = useCallback(() => {
    setForm((f) => {
      const currentPaths = f.worktreeCopyFiles && f.worktreeCopyFiles.length > 0
        ? f.worktreeCopyFiles
        : [""];
      return { ...f, worktreeCopyFiles: [...currentPaths, ""] };
    });
  }, []);

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

    const shortcutValidationError = describeShortcutValidation(form.dashboardKeyboardShortcuts ?? {});
    if (shortcutValidationError) {
      addToast(shortcutValidationError, "error");
      return;
    }

    setIsSaving(true);
    try {
      const normalizedWorktreeCopyFiles = normalizeWorktreeCopyFilesForSave(form.worktreeCopyFiles);
      /*
      FNXC:WindowsTerminalStartup 2026-07-04-06:30:
      Worktrunk status is now only auto-probed once the integration is enabled, so a
      user who toggles worktrunk on and hits Save before the probe returns would read a
      stale `worktrunkInstallVerified === false` and silently persist `enabled: false`,
      discarding their opt-in. When enabling but not yet verified, await one definitive
      probe (safe: the engine guard refuses to launch Windows Terminal) and clamp on
      that fresh result instead.
      */
      let worktrunkVerifiedForSave = worktrunkInstallVerified;
      if (form.worktrunk?.enabled === true && !worktrunkVerifiedForSave) {
        const freshWorktrunkStatus = await worktrunkInstall.refresh();
        worktrunkVerifiedForSave = freshWorktrunkStatus.status === "installed";
      }
      /*
      FNXC:GitLabEnablement 2026-07-02-00:00:
      The Global General section must edit raw global GitLab settings, not the merged project-effective form. Otherwise a project override can silently overwrite the global GitLab default on a no-op save.
      */
      const gitlabFormForSave = activeSection === "global-general" && globalGitlabSettings ? globalGitlabSettings : form;
      const payload = {
        ...form,
        worktreeInitCommand: form.worktreeInitCommand?.trim() || undefined,
        worktreesDir: form.worktreesDir?.trim() || undefined,
        worktrunk: {
          enabled: worktrunkVerifiedForSave && form.worktrunk?.enabled === true,
          binaryPath: form.worktrunk?.binaryPath?.trim() || undefined,
          onFailure: form.worktrunk?.onFailure ?? "fail",
        },
        maxAutoMergeRetries: resolveMaxAutoMergeRetriesForSettingsForm(form),
        taskPrefix: form.taskPrefix?.trim() || undefined,
        githubTrackingDefaultRepo: form.githubTrackingDefaultRepo?.trim() || undefined,
        /*
        FNXC:DashboardShortcuts 2026-07-04-00:00:
        FN-7553 normalizes every declared shortcut action (derived from resolveDashboardKeyboardShortcuts' key set) on save, not just quickChat/terminal, so newly-added actions get the same trim/normalize-before-persist treatment.
        */
        dashboardKeyboardShortcuts: Object.fromEntries(
          (Object.entries(resolveDashboardKeyboardShortcuts(form.dashboardKeyboardShortcuts)) as [DashboardShortcutAction, string][])
            .map(([action, shortcut]) => [action, normalizeKeyboardShortcut(shortcut).normalized]),
        ) as DashboardKeyboardShortcutMap,
        gitlabEnabled: gitlabFormForSave.gitlabEnabled,
        gitlabInstanceUrl: gitlabFormForSave.gitlabInstanceUrl?.trim() || undefined,
        gitlabApiBaseUrl: gitlabFormForSave.gitlabApiBaseUrl?.trim() || undefined,
        gitlabAuthToken: gitlabFormForSave.gitlabAuthToken?.trim() || undefined,
        gitlabAuthTokenType: gitlabFormForSave.gitlabAuthTokenType ?? "personal",
        githubAuthToken: form.githubAuthToken?.trim() || undefined,
        prTitlePromptInstructions: form.prTitlePromptInstructions?.trim() || undefined,
        prDescriptionPromptInstructions: form.prDescriptionPromptInstructions?.trim() || undefined,
        /*
        FNXC:MergeSettings 2026-07-04-09:18:
        Push target text is meaningful only when direct post-merge pushing is enabled. Hiding the input must not keep submitting a stale remote/branch from the form state; clearing it lets project settings fall back to the default origin target when the toggle is disabled.
        */
        pushRemote: form.pushAfterMerge ? form.pushRemote?.trim() || undefined : undefined,
        overlapIgnorePaths: (form.overlapIgnorePaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0),
        worktreeCopyFiles: normalizedWorktreeCopyFiles.length > 0 || initialScopedValues?.project?.worktreeCopyFiles !== undefined
          ? normalizedWorktreeCopyFiles
          : undefined,
        experimentalFeatures: normalizeExperimentalFeaturesForSave(form.experimentalFeatures),
      };

      if (activeSection === "general") {
        resolveGitlabConfig({
          project: {
            gitlabInstanceUrl: payload.gitlabInstanceUrl,
            gitlabApiBaseUrl: payload.gitlabApiBaseUrl,
          },
        });
      }
      if (activeSection === "global-general") {
        resolveGitlabConfig({
          global: {
            gitlabInstanceUrl: payload.gitlabInstanceUrl,
            gitlabApiBaseUrl: payload.gitlabApiBaseUrl,
          },
        });
      }

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

      await workflowLaneSaverRef.current?.();

      addToast(t("settings.general.settingsSaved", "Settings saved"), "success");
      onClose();
    } catch (err) {
      if (err instanceof WorkflowLaneFlushRejection) return;
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsSaving(false);
    }
  }, [form, globalGitlabSettings, globalMaxConcurrent, prefixError, presetDraft, initialValues, initialScopedValues, onClose, addToast, projectId, activeSection, isSaving, t]);

  /*
  FNXC:SettingsReset 2026-07-04-00:25:
  "Reset this menu" resolves the active section's { scope, keys } from the
  shared section-keys registry (packages/dashboard/app/components/settings/section-keys.ts)
  and writes ONLY those keys, at the correct scope, through the SAME
  updateGlobalSettings/updateSettings plumbing (and null-as-delete convention)
  used by handleSave/splitSettingsSave. GLOBAL keys reset to the canonical
  DEFAULT_GLOBAL_SETTINGS value; PROJECT keys reset via null-as-delete so an
  overridable project setting reverts to its inherited/default value. The form
  is refreshed afterward via refreshSettingsForm so fields immediately show the
  reset values.
  */
  const activeSectionResetEntry = useMemo(() => getSectionKeyEntry(activeSection), [activeSection]);
  const activeSectionResetIneligibleReason = useMemo(() => getResetIneligibleReason(activeSection), [activeSection]);
  const activeSectionLabel = useMemo(() => {
    const section = SETTINGS_SECTIONS.find((s) => s.id === activeSection);
    return section ? t(section.labelKey, section.label) : activeSection;
  }, [activeSection, t]);

  const handleResetActiveSection = useCallback(async () => {
    if (resetInFlight || !activeSectionResetEntry) return;
    setResetInFlight(true);
    try {
      if (activeSectionResetEntry.scope === "global") {
        const patch: Record<string, unknown> = {};
        for (const key of activeSectionResetEntry.keys) {
          patch[key] = (DEFAULT_GLOBAL_SETTINGS as Record<string, unknown>)[key];
        }
        await updateGlobalSettings(patch);
      } else {
        const patch: Record<string, unknown> = {};
        for (const key of activeSectionResetEntry.keys) {
          patch[key] = null; // null-as-delete: revert to inherited/default project value
        }
        await updateSettings(patch, projectId);
      }
      await refreshSettingsForm(false);
      addToast(t("settings.reset.menuResetSuccess", "{{section}} settings reset to defaults", { section: activeSectionLabel }), "success");
      setResetDialogOpen(false);
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setResetInFlight(false);
    }
  }, [resetInFlight, activeSectionResetEntry, projectId, refreshSettingsForm, addToast, t, activeSectionLabel]);

  const handleResetAllProjectSettings = useCallback(async () => {
    if (resetInFlight) return;
    setResetInFlight(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of ALL_PROJECT_RESET_KEYS) {
        patch[key] = null; // null-as-delete: never touches global keys
      }
      await updateSettings(patch, projectId);
      await refreshSettingsForm(false);
      addToast(t("settings.reset.allProjectResetSuccess", "All project settings reset to defaults"), "success");
      setResetDialogOpen(false);
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setResetInFlight(false);
    }
  }, [resetInFlight, projectId, refreshSettingsForm, addToast, t]);

  const closeResetDialog = useCallback(() => {
    if (resetInFlight) return;
    setResetDialogOpen(false);
  }, [resetInFlight]);

  const handleResetDialogOverlayClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeResetDialog();
    }
  }, [closeResetDialog]);

  // Reset dialog gets its own Escape handler (takes precedence over the modal-level
  // Escape-to-close so Escape closes only the confirmation dialog, not the whole modal).
  useEffect(() => {
    if (!resetDialogOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeResetDialog();
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [resetDialogOpen, closeResetDialog]);

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
        result.qmdAvailable ? t("settings.memory.qmdInstalled", "qmd installed successfully") : t("settings.memory.qmdInstallUnavailable", "qmd install finished, but qmd is still unavailable"),
        result.qmdAvailable ? "success" : "warning",
      );
    } catch (err) {
      addToast(getErrorMessage(err) || t("settings.memory.qmdInstallFailed", "Failed to install qmd"), "error");
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
        setCloudflaredInstallError(result.error ?? t("settings.remote.installationFailed", "Installation failed"));
        return;
      }
      const status = await fetchRemoteStatus(projectId);
      setRemoteStatus(status);
      addToast(t("settings.remote.cloudflaredInstalled", "cloudflared installed successfully"), "success");
    } catch (err) {
      setCloudflaredInstallError(err instanceof Error ? err.message : t("settings.remote.installationFailed", "Installation failed"));
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
            onQuickChatButtonModeChange={onQuickChatButtonModeChange}
          />
        );
      case "global-general":
        return (
          <GlobalGeneralSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            globalSettings={globalGitlabSettings}
            onGlobalGitlabSettingsChange={(patch) => setGlobalGitlabSettings((current) => ({
              gitlabEnabled: current?.gitlabEnabled,
              gitlabInstanceUrl: current?.gitlabInstanceUrl,
              gitlabApiBaseUrl: current?.gitlabApiBaseUrl,
              gitlabAuthToken: current?.gitlabAuthToken,
              gitlabAuthTokenType: current?.gitlabAuthTokenType,
              ...patch,
            }))}
            globalTrackingRepoOptions={globalTrackingRepoOptions}
            globalTrackingRepoLoading={globalTrackingRepoLoading}
            globalTrackingRepoError={globalTrackingRepoError}
          />
        );
      case "keyboard-shortcuts":
        return (
          <KeyboardShortcutsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
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
            getLaneThinkingValue={(lane) => getLaneThinkingValue(lane, "global")}
            updateLaneThinkingValue={(lane, level) => updateLaneThinkingValue(lane, level, "global")}
            resetLaneThinkingValue={(lane) => resetLaneThinkingValue(lane, "global")}
            favoriteProviders={favoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={handleToggleFavorite}
            onToggleModelFavorite={handleToggleModelFavorite}
            addToast={addToast}
            projectId={projectId}
          />
        );

      case "secrets":
        return <SecretsSection scopeBanner={renderScopeBanner()} addToast={addToast} />;
      case "global-mcp":
        return (
          <GlobalMcpSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            projectId={projectId}
            addToast={addToast}
          />
        );
      case "mcp":
        return (
          <ProjectMcpSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            globalSettings={scopedSettings?.global ?? null}
            projectId={projectId}
            addToast={addToast}
          />
        );

      case "project-models":
        return (
          <ProjectModelsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            projectId={projectId}
            addToast={addToast}
            onOpenWorkflowSettings={onOpenWorkflowSettings}
            registerWorkflowLaneSaver={registerWorkflowLaneSaver}
            models={{
              modelLanes: MODEL_LANES,
              getLaneStatus,
              getLaneValue,
              updateLaneValue,
              resetLaneValue,
              getLaneThinkingValue,
              updateLaneThinkingValue,
              resetLaneThinkingValue,
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
            shadcnCustomColors={shadcnCustomColors}
            resolvedThemeMode={resolvedThemeMode}
            onThemeModeChange={onThemeModeChange}
            onColorThemeChange={onColorThemeChange}
            onDashboardFontScaleChange={onDashboardFontScaleChange}
            onShadcnCustomColorsChange={onShadcnCustomColorsChange}
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
            concurrencyLoading={activeSection === "scheduling" && !globalConcurrencyLoaded && !globalConcurrencyDirtyRef.current}
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
            onWorktreeCopyFileChange={handleWorktreeCopyFileChange}
            onRemoveWorktreeCopyFile={handleRemoveWorktreeCopyFile}
            onAddWorktreeCopyFile={handleAddWorktreeCopyFile}
            onOpenWorktreeCopyFilePicker={openWorktreeCopyFilePicker}
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
            isFeatureEnabled={isDashboardExperimentalFeatureEnabled}
            hiddenFeatureKeys={HIDDEN_EXPERIMENTAL_FEATURE_KEYS}
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
        return (
          <PromptsSection
            scopeBanner={renderScopeBanner()}
            form={form}
            setForm={setForm}
            onOpenWorkflowSettings={onOpenWorkflowSettings}
          />
        );
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

  /*
  FNXC:Settings 2026-06-22-00:00:
  Embedded settings is a main-content destination, not a dialog. It drops the fixed `.modal-overlay` backdrop and the inner card chrome (modal-overlay/modal/settings-modal classes), and instead uses `settings-embedded right-dock-embedded-view` (host) + `settings-modal--embedded` (panel) to fill the pane flush like other embedded views (Planning, Command Center). The modal path stays byte-identical.
  */
  return (
    <div
      className={isEmbedded ? "settings-embedded right-dock-embedded-view" : "modal-overlay open settings-modal-overlay"}
      {...overlayDismissProps}
      data-testid={isEmbedded ? "settings-view" : undefined}
      role={isEmbedded ? "region" : "dialog"}
      aria-label={isEmbedded ? t("settings.title", "Settings") : undefined}
      aria-modal={isEmbedded ? undefined : "true"}
    >
      <div
        className={isEmbedded ? "modal modal-lg settings-modal settings-modal--embedded" : "modal modal-lg settings-modal"}
        ref={modalRef}
        style={isEmbedded ? undefined : keyboardStyle}
      >
        <div className={isEmbedded ? "modal-header modal-header--embedded" : "modal-header"}>
          {/* FNXC:Settings 2026-06-22-01:00: Embedded title gains a Settings icon (size 20, matching the sidebar nav and shared ViewHeader) so the embedded settings panel reads consistently with other main-content destinations; title is already 1.125rem. */}
          <div className="settings-modal-heading">
            <h3>
              {isEmbedded && <SettingsIcon size={20} aria-hidden="true" />}
              <span>{t("settings.title", "Settings")}</span>
            </h3>
          </div>
          <div className="settings-header-actions">
            <a
              href="https://github.com/Runfusion/Fusion"
              target="_blank"
              rel="noopener noreferrer"
              className="settings-github-star-btn"
              aria-label={t("settings.header.starFusion", "Star Fusion on GitHub")}
              title={t("settings.header.starFusion", "Star Fusion on GitHub")}
              onClick={markStarClicked}
              data-clicked={starClicked ? "true" : "false"}
            >
              <span className="settings-github-star-btn__action">
                <ProviderIcon provider="github" size="sm" />
                <Star size={11} aria-hidden="true" />
                {t("settings.header.star", "Star")}
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
              aria-label={t("settings.header.joinDiscord", "Join our Discord")}
              title={t("settings.header.joinDiscord", "Join our Discord")}
            >
              <DiscordIcon size={13} />
              {t("settings.header.discord", "Discord")}
            </a>
          </div>
          {!isEmbedded && (
            <button className="modal-close" onClick={onClose} aria-label={t("actions.close", "Close")}>
              &times;
            </button>
          )}
          {/*
            FNXC:Settings 2026-07-07-00:00:
            Mobile embedded Settings (taskView === "settings", presentation="embedded") has no left sidebar to exit
            through — only the bottom MobileNavBar — so the header needs an explicit close affordance calling the
            existing onClose prop (wired to closeSettingsView: modalManager.closeSettings() + back to board + refresh
            app settings). Desktop/tablet embedded still exit via the sidebar (no button here), and the standalone
            modal presentation keeps its own `!isEmbedded` `modal-close` button above, untouched and byte-identical.
          */}
          {isEmbedded && viewportMode === "mobile" && (
            <button
              className="modal-close settings-embedded-mobile-close"
              onClick={onClose}
              aria-label={t("actions.close", "Close")}
            >
              &times;
            </button>
          )}
        </div>
        {loading ? (
          <div className="settings-empty-state settings-loading"><LoadingSpinner label={t("settings.loading", "Loading…")} /></div>
        ) : (
          <div className="settings-layout">
            <aside className="settings-navigation" aria-label={t("settings.search.navigationLabel", "Settings navigation")}> 
              {showMobileSectionPicker && (
                <div className="settings-mobile-section-picker">
                  {/**
                   * FNXC:Settings 2026-07-09-00:00:
                   * FN-7752 removes the visible mobile section-picker label to reclaim vertical space on narrow Settings screens. The select keeps "Settings Section" as its aria-label so screen readers and getByLabelText tests keep the same accessible name without an empty label shell.
                   */}
                  <div className="settings-mobile-section-picker-control-row">
                    {hasSettingsSearchResults ? (
                      <select
                        id="settings-mobile-section"
                        aria-label={t("settings.mobileNav.label", "Settings Section")}
                        className="select touch-target"
                        value={activeSection}
                        onChange={(event) => setActiveSection(event.target.value as SectionId)}
                      >
                        {searchableSectionOptions.map((section) => {
                          const label = t(section.labelKey, section.label);
                          return (
                            <option key={section.id} value={section.id}>
                              {resolveSettingsSectionOptionLabel(section, label)}
                            </option>
                          );
                        })}
                      </select>
                    ) : (
                      <p className="settings-search-empty-hint">{t("settings.search.noMobileOptions", "No sections match this search.")}</p>
                    )}
                    {isMobileSettingsSearch && (
                      // FNXC:Settings 2026-07-09-12:00: mobile-only search toggle now lives inline beside the section picker control so section navigation and search read as one compact row; FN-7713 expand/hide behavior and active-query preservation remain unchanged.
                      <button
                        type="button"
                        className="btn btn-sm btn-icon settings-search-toggle"
                        onClick={() => setMobileSearchRowExpanded((expanded) => !expanded)}
                        aria-expanded={settingsSearchRowVisible}
                        aria-controls="settings-search-row-region"
                        aria-label={
                          settingsSearchRowVisible
                            ? t("settings.search.toggleHide", "Hide search")
                            : t("settings.search.toggleShow", "Show search")
                        }
                      >
                        {settingsSearchRowVisible ? <SearchToggleCloseIcon size={16} /> : <Search size={16} />}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <label className="settings-advanced-toggle">
                <input
                  type="checkbox"
                  checked={showAdvancedSettings}
                  onChange={(event) => handleAdvancedSettingsChange(event.target.checked)}
                />
                <span>{t("settings.advanced.toggle", "Advanced settings")}</span>
              </label>
              {settingsSearchRowVisible && (
                <div className="settings-search" data-testid="settings-search">
                  <div id="settings-search-row-region" className="settings-search-row">
                    <label className="settings-search-label" htmlFor="settings-search-input">
                      {t("settings.search.label", "Search settings")}
                    </label>
                    <div className="settings-search-input-wrap">
                      <input
                        id="settings-search-input"
                        data-testid="settings-search-input"
                        className="input settings-search-input"
                        type="search"
                        value={settingsSearchQuery}
                        onChange={(event) => setSettingsSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && hasSettingsSearchQuery) {
                            event.stopPropagation();
                            setSettingsSearchQuery("");
                          }
                        }}
                        placeholder={t("settings.search.placeholder", "Search by setting or section")}
                        aria-describedby="settings-search-results"
                      />
                      {hasSettingsSearchQuery && (
                        <button
                          type="button"
                          className="btn btn-sm settings-search-clear"
                          onClick={() => setSettingsSearchQuery("")}
                          aria-label={t("settings.search.clear", "Clear settings search")}
                        >
                          {t("actions.clear", "Clear")}
                        </button>
                      )}
                    </div>
                    <div id="settings-search-results" className="settings-search-results" aria-live="polite">
                      {hasSettingsSearchQuery
                        ? t("settings.search.resultCount", "{{count}} matching sections", { count: searchableSectionOptions.length })
                        : t("settings.search.allSections", "Showing all settings sections")}
                    </div>
                  </div>
                </div>
              )}
              <nav className="settings-sidebar">
                {hasSettingsSearchResults ? searchMatchedSections.map((section) => {
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
                }) : (
                  <div className="settings-search-empty" role="status">
                    <p>{t("settings.search.noResults", "No settings sections match \"{{query}}\".", { query: settingsSearchQuery.trim() })}</p>
                    <button type="button" className="btn btn-sm" onClick={() => setSettingsSearchQuery("")}>{t("settings.search.clear", "Clear settings search")}</button>
                  </div>
                )}
              </nav>
            </aside>
            <div className="settings-content" ref={settingsContentRef}>
              {hasSettingsSearchResults ? renderSectionFields() : (
                <div className="settings-empty-state settings-search-content-empty" role="status">
                  <p>{t("settings.search.noResults", "No settings sections match \"{{query}}\".", { query: settingsSearchQuery.trim() })}</p>
                  <button type="button" className="btn" onClick={() => setSettingsSearchQuery("")}>{t("settings.search.clear", "Clear settings search")}</button>
                </div>
              )}
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
              aria-label={t("settings.footer.helpDiscussions", "Help and discussions")}
              title={t("settings.footer.helpDiscussions", "Help and discussions")}
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
                  aria-label={t("settings.footer.checkUpdates", "Check for updates")}
                  title={t("settings.footer.checkUpdates", "Check for updates")}
                >
                  {/*
                  FNXC:Settings 2026-07-10-21:33:
                  Mobile Settings footer needs the compact v{{version}} label to preserve horizontal space; desktop and tablet keep the full Version {{version}} word.
                  */}
                  <span className="settings-modal-version">
                    {viewportMode === "mobile"
                      ? t("settings.footer.versionShort", "v{{version}}", { version: appVersion })
                      : t("settings.footer.version", "Version {{version}}", { version: appVersion })}
                  </span>
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
              title={t("settings.importExport.importTitleAttr", "Import settings from JSON file")}
            >
              {importLoading ? t("settings.importExport.loadingFile", "Loading…") : t("settings.importExport.importBtn", "Import")}
            </button>
            {/*
            FNXC:SettingsReset 2026-07-04-00:35:
            Reset Settings lives in the footer next to Import/Export in BOTH the modal and
            embedded (SettingsView) presentations — the footer is not gated by isEmbedded
            (only Cancel is), so this button renders in both automatically (FN-7506
            Surface Enumeration: modal + embedded).
            */}
            <button
              type="button"
              className="btn btn-sm"
              data-testid="settings-reset"
              onClick={() => setResetDialogOpen(true)}
              disabled={loading}
              title={t("settings.reset.buttonTitle", "Reset settings to their defaults")}
            >
              {t("settings.reset.button", "Reset Settings")}
            </button>
          </div>
          <div className="modal-actions-right">
            {/* FNXC:Settings 2026-06-22-00:00: Cancel/close is a dialog affordance; the embedded main view is left via the sidebar, so it shows only Save. */}
            {!isEmbedded && (
              <button className="btn btn-sm" onClick={onClose}>
                {t("settings.actions.cancel", "Cancel")}
              </button>
            )}
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
          aria-label={t("settings.scheduling.browseWorkspacePath", "Browse workspace path")}
        >
          <div className="modal modal-lg settings-overlap-path-picker-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settings.scheduling.selectIgnoredOverlapPath", "Select ignored overlap path")}</h3>
              <button className="modal-close" onClick={closeOverlapPathPicker} aria-label={t("actions.close", "Close")}>
                &times;
              </button>
            </div>
            <div className="modal-body settings-overlap-path-picker-body">
              <p className="settings-overlap-path-picker-note">
                {t("settings.scheduling.overlapPickerNote", "Choose a file to ignore directly, or navigate into a folder and select the current directory.")}
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
                  {t("settings.fileBrowser.currentDirectory", "Current directory:")} <code>{overlapPathPickerCurrentPath === "." ? t("settings.fileBrowser.projectRoot", "(project root)") : overlapPathPickerCurrentPath}</code>
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
          aria-label={t("settings.worktrees.browseWorktreesDirectory", "Browse worktrees directory")}
        >
          <div className="modal modal-lg settings-overlap-path-picker-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settings.worktrees.selectWorktreesDir", "Select worktrees directory")}</h3>
              <button className="modal-close" onClick={closeWorktreesDirPicker} aria-label={t("actions.close", "Close")}>
                &times;
              </button>
            </div>
            <div className="modal-body settings-overlap-path-picker-body">
              <p className="settings-overlap-path-picker-note">
                {t("settings.worktrees.worktreesPickerNote", "Navigate to the folder where Fusion should create task worktrees, then select the current directory.")}
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
                  {t("settings.fileBrowser.currentDirectory", "Current directory:")} <code>{worktreesDirPickerCurrentPath === "." ? t("settings.fileBrowser.projectRoot", "(project root)") : worktreesDirPickerCurrentPath}</code>
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

      {worktreeCopyFilePickerIndex !== null && (
        <div
          className="modal-overlay open"
          onClick={handleWorktreeCopyFilePickerOverlayClick}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.worktrees.browseCopyFile", "Browse file to copy into new worktrees")}
        >
          <div className="modal modal-lg settings-overlap-path-picker-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settings.worktrees.selectCopyFile", "Select file to copy")}</h3>
              <button className="modal-close" onClick={closeWorktreeCopyFilePicker} aria-label={t("actions.close", "Close")}>
                &times;
              </button>
            </div>
            <div className="modal-body settings-overlap-path-picker-body">
              <p className="settings-overlap-path-picker-note">
                {t("settings.worktrees.copyFilePickerNote", "Choose a repository file to copy into each newly assigned task worktree. Directories are not selected from this picker.")}
              </p>
              <FileBrowser
                entries={worktreeCopyFilePickerEntries}
                currentPath={worktreeCopyFilePickerCurrentPath}
                onSelectFile={selectWorktreeCopyFile}
                onNavigate={setWorktreeCopyFilePickerPath}
                loading={worktreeCopyFilePickerLoading}
                error={worktreeCopyFilePickerError}
                onRetry={refreshWorktreeCopyFilePicker}
                workspace="project"
                projectId={projectId}
              />
            </div>
            <div className="modal-actions">
              <div className="modal-actions-left">
                <small>
                  {t("settings.fileBrowser.currentDirectory", "Current directory:")} <code>{worktreeCopyFilePickerCurrentPath === "." ? t("settings.fileBrowser.projectRoot", "(project root)") : worktreeCopyFilePickerCurrentPath}</code>
                </small>
              </div>
              <div className="modal-actions-right">
                <button className="btn btn-sm" onClick={closeWorktreeCopyFilePicker}>
                  {t("settings.actions.cancel", "Cancel")}
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
              <button className="modal-close" onClick={() => setImportDialogOpen(false)} aria-label={t("actions.close", "Close")}>
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p>{t("settings.importExport.reviewPrompt", "Review the settings to be imported:")}</p>
              
              {importPreview.global && Object.keys(importPreview.global).length > 0 && (
                <div className="form-group">
                  <strong>{t("settings.importExport.globalSettings", "Global Settings:")}</strong>
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
                  <strong>{t("settings.importExport.projectSettings", "Project Settings:")}</strong>
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
                <label htmlFor="import-scope">{t("settings.importExport.importScope", "Import Scope:")}</label>
                <select
                  id="import-scope"
                  value={importScope}
                  onChange={(e) => setImportScope(e.target.value as 'global' | 'project' | 'both')}
                >
                  <option value="both">{t("settings.importExport.scopeBoth", "Both global and project settings")}</option>
                  <option value="global">{t("settings.importExport.scopeGlobal", "Global settings only")}</option>
                  <option value="project">{t("settings.importExport.scopeProject", "Project settings only")}</option>
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
                  {t("settings.importExport.mergeExisting", "Merge with existing settings (recommended)")}
                </label>
                <small>{t("settings.importExport.replaceWarning", "If unchecked, existing settings will be replaced with imported values.")}</small>
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

      {/*
      FNXC:SettingsReset 2026-07-04-00:40:
      Reset Settings confirmation dialog (FN-7506). Mirrors the overlap-path-picker
      modal-overlay dialog pattern in this file: role="dialog", aria-modal, aria-label,
      overlay-click-to-cancel, and its own Escape handler (registered above). Offers two
      destructive choices — reset the active section only (disabled/explained when the
      section is excluded/non-key) and reset all project settings — plus Cancel.
      */}
      {resetDialogOpen && (
        <div
          className="modal-overlay open"
          onClick={handleResetDialogOverlayClick}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.reset.dialogAriaLabel", "Reset settings")}
          data-testid="settings-reset-dialog"
        >
          <div className="modal modal-md settings-reset-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settings.reset.dialogTitle", "Reset Settings")}</h3>
              <button className="modal-close" onClick={closeResetDialog} aria-label={t("actions.close", "Close")}>
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p>{t("settings.reset.dialogBody", "Choose what to reset to its defaults. This cannot be undone.")}</p>
              <div className="settings-reset-dialog__choice">
                <button
                  type="button"
                  className="btn btn-danger settings-reset-dialog__choice-btn"
                  data-testid="settings-reset-menu"
                  onClick={() => void handleResetActiveSection()}
                  disabled={resetInFlight || !activeSectionResetEntry}
                  title={activeSectionResetIneligibleReason}
                >
                  {t("settings.reset.resetMenuAction", "Reset this menu ({{section}})", { section: activeSectionLabel })}
                </button>
                {activeSectionResetIneligibleReason && (
                  <small className="settings-reset-dialog__ineligible-reason">{activeSectionResetIneligibleReason}</small>
                )}
              </div>
              <div className="settings-reset-dialog__choice">
                <button
                  type="button"
                  className="btn btn-danger settings-reset-dialog__choice-btn"
                  data-testid="settings-reset-all-project"
                  onClick={() => void handleResetAllProjectSettings()}
                  disabled={resetInFlight}
                >
                  {t("settings.reset.resetAllProjectAction", "Reset all project settings")}
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <div className="modal-actions-right">
                <button className="btn btn-sm" onClick={closeResetDialog} disabled={resetInFlight}>
                  {t("settings.actions.cancel", "Cancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/*
FNXC:Settings 2026-06-22-00:00:
SettingsView is the embedded main-content presentation of SettingsModal. App.tsx lazy-imports this alias and renders it in renderMainContent() for taskView === "settings" with presentation defaulting to "embedded". It is a thin wrapper so the heavy SettingsModal body stays a single chunk and the modal path is unaffected.
*/
export function SettingsView(props: SettingsModalProps) {
  return <SettingsModal presentation="embedded" {...props} />;
}
