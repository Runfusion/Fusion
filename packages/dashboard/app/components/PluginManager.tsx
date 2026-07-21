/**
 * Plugin Manager Component
 *
 * Provides UI for managing installed plugins:
 * - List installed plugins with state indicators
 * - Install plugins from local paths
 * - Enable/disable plugins
 * - Configure plugin settings
 * - Uninstall plugins
 * - Live updates via SSE (plugin:lifecycle events)
 */

import "./PluginManager.css";
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Package, Settings, Trash2, Plus, X, RefreshCw, RotateCcw, ExternalLink, Shield } from "lucide-react";
import { fetchPlugins, fetchPluginRegistry, installPlugin, enablePlugin, disablePlugin, uninstallPlugin, fetchPluginSettings, updatePluginSettings, reloadPlugin, fetchPluginSetupStatus, installPluginSetup, updatePlugin, rescanPlugin } from "../api";
import { DirectoryPicker } from "./DirectoryPicker";
import { LoadingSpinner } from "./LoadingSpinner";
import { WhatsAppChatPairingPanel } from "./WhatsAppChatPairingPanel";
import type { PluginInstallation, PluginState, PluginSettingSchema } from "@fusion/core";
import type { PluginSetupStatusResponse, RegistryPluginEntry } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { subscribeSse } from "../sse-bus";

/** Normalized plugin lifecycle payload from SSE plugin:lifecycle events */
interface PluginLifecyclePayload {
  scope: "global" | "project";
  pluginId: string;
  transition: "installing" | "enabled" | "disabled" | "error" | "state-changed" | "uninstalled" | "settings-updated";
  sourceEvent: string;
  timestamp: string;
  projectId?: string;
  enabled: boolean;
  state: PluginState;
  version: string;
  settings: Record<string, unknown>;
  error?: string;
}

interface PluginManagerProps {
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

interface BuiltinPlugin {
  id: string;
  name: string;
  description: string;
  category: "runtime" | "integration";
  path?: string;
  experimental?: boolean;
  hasSetup?: boolean;
}

export const BUILTIN_AGENT_BROWSER_PLUGIN_ID = "fusion-plugin-agent-browser";

export const AGENT_BROWSER_SETTINGS_SCHEMA: Record<string, PluginSettingSchema> = {
  enabled: { type: "boolean", label: "Enable Agent Browser", group: "General" },
  installChannel: {
    type: "enum",
    label: "Install Channel",
    enumValues: ["stable", "beta", "nightly"],
    defaultValue: "stable",
    group: "General",
  },
  commandTimeoutMs: {
    type: "number",
    label: "Command Timeout (ms)",
    defaultValue: 120000,
    group: "General",
  },
  headlessMode: { type: "boolean", label: "Headless Mode", defaultValue: true, group: "Browser" },
  allowedDomains: { type: "array", label: "Allowed Domains", itemType: "string", group: "Browser" },
  promptExecutorSystem: { type: "string", label: "Executor System Prompt", multiline: true, group: "Prompt Contributions" },
  promptExecutorTask: { type: "string", label: "Executor Task Prompt", multiline: true, group: "Prompt Contributions" },
  promptTriage: { type: "string", label: "Triage Prompt", multiline: true, group: "Prompt Contributions" },
  promptReviewer: { type: "string", label: "Reviewer Prompt", multiline: true, group: "Prompt Contributions" },
  promptHeartbeat: { type: "string", label: "Heartbeat Prompt", multiline: true, group: "Prompt Contributions" },
  skillExposure: {
    type: "enum",
    label: "Skill Exposure",
    enumValues: ["none", "selected", "all"],
    defaultValue: "selected",
    group: "Skills",
  },
};

/** Maps known agent-browser schema group names to their i18n keys */
const AGENT_BROWSER_GROUP_KEYS: Record<string, string> = {
  "General": "plugins.agentBrowser.groupGeneral",
  "Browser": "plugins.agentBrowser.groupBrowser",
  "Prompt Contributions": "plugins.agentBrowser.groupPromptContributions",
  "Skills": "plugins.agentBrowser.groupSkills",
};

/** Maps known agent-browser schema label strings to their i18n keys */
const AGENT_BROWSER_LABEL_KEYS: Record<string, string> = {
  "Enable Agent Browser": "plugins.agentBrowser.labelEnabled",
  "Install Channel": "plugins.agentBrowser.labelInstallChannel",
  "Command Timeout (ms)": "plugins.agentBrowser.labelCommandTimeoutMs",
  "Headless Mode": "plugins.agentBrowser.labelHeadlessMode",
  "Allowed Domains": "plugins.agentBrowser.labelAllowedDomains",
  "Executor System Prompt": "plugins.agentBrowser.labelPromptExecutorSystem",
  "Executor Task Prompt": "plugins.agentBrowser.labelPromptExecutorTask",
  "Triage Prompt": "plugins.agentBrowser.labelPromptTriage",
  "Reviewer Prompt": "plugins.agentBrowser.labelPromptReviewer",
  "Heartbeat Prompt": "plugins.agentBrowser.labelPromptHeartbeat",
  "Skill Exposure": "plugins.agentBrowser.labelSkillExposure",
};

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "fusion-plugin-hermes-runtime",
    name: "Hermes Runtime",
    description: "Runtime provider for Hermes CLI-backed execution.",
    category: "runtime",
    path: "./plugins/fusion-plugin-hermes-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-paperclip-runtime",
    name: "Paperclip Runtime",
    description: "Runtime provider for Paperclip agent connections.",
    category: "runtime",
    path: "./plugins/fusion-plugin-paperclip-runtime",
  },
  {
    id: "fusion-plugin-openclaw-runtime",
    name: "OpenClaw Runtime",
    description: "Runtime provider for OpenClaw execution.",
    category: "runtime",
    path: "./plugins/fusion-plugin-openclaw-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-droid-runtime",
    name: "Droid Runtime",
    description: "Runtime provider for Droid CLI execution.",
    category: "runtime",
    path: "./plugins/fusion-plugin-droid-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-dependency-graph",
    name: "Dependency Graph",
    description: "Dashboard plugin for task dependency graph visualization.",
    category: "integration",
    path: "./plugins/fusion-plugin-dependency-graph",
  },
  {
    id: "fusion-plugin-reports",
    name: "Reports",
    description: "View report history, compare runs side-by-side, and export standalone HTML summaries.",
    category: "integration",
    path: "./plugins/fusion-plugin-reports",
  },
  {
    id: "fusion-plugin-whatsapp-chat",
    name: "WhatsApp Chat",
    description: "Pairs to WhatsApp Web (multi-device) with QR or pairing code, then bridges direct chats to a Fusion agent.",
    category: "integration",
    path: "./plugins/fusion-plugin-whatsapp-chat",
  },
  {
    id: "fusion-plugin-cli-printing-press",
    name: "CLI Printing Press",
    description: "Guided wizard for drafting external service CLI definitions.",
    category: "integration",
    path: "./plugins/fusion-plugin-cli-printing-press",
  },
  {
    id: "fusion-plugin-compound-engineering",
    name: "Compound Engineering",
    description: "A dedicated dashboard surface for compound-engineering artifacts and interactive ce-* sessions.",
    category: "integration",
    path: "./plugins/fusion-plugin-compound-engineering",
  },
  /*
  FNXC:Quality 2026-07-14-21:50:
  Quality is a bundled first-party plugin (Task QA tab + Quality hub). Register in Plugin Manager
  so operators can enable/manage it like other built-in integrations.
  */
  {
    id: "fusion-plugin-quality",
    name: "Quality",
    description: "Task QA tab and Quality hub: preview servers, test runs, reports, screenshots, and suggested cases.",
    category: "integration",
    path: "./plugins/fusion-plugin-quality",
  },
  /*
   * FNXC:PluginManager 2026-07-02-17:56:
   * FN-7454 keeps Linear Import in the built-in catalog because FN-7443 shipped the plugin package, registry entry, and dashboard view, but users still could not install or manage it from Plugin Manager without this bundled-plugin registration.
   */
  {
    id: "fusion-plugin-linear-import",
    name: "Linear Import",
    description: "Browse Linear issues and import selected issues as Fusion triage tasks through plugin-owned settings.",
    category: "integration",
    path: "./plugins/fusion-plugin-linear-import",
  },
  {
    id: BUILTIN_AGENT_BROWSER_PLUGIN_ID,
    name: "Agent Browser",
    description: "Built-in integration metadata. Package install support lands in FN-3101.",
    category: "integration",
    hasSetup: true,
  },
];

export const STATE_COLORS: Record<string, string> = {
  started: "var(--color-success)",
  loaded: "var(--color-warning)",
  error: "var(--color-error)",
  stopped: "var(--color-muted)",
  installed: "var(--color-info)",
};

function resolveSettingsSchema(plugin: PluginInstallation): Record<string, PluginSettingSchema> | undefined {
  const pluginSchema = plugin.settingsSchema;
  const hasPluginSchema = pluginSchema && Object.keys(pluginSchema).length > 0;

  if (plugin.id !== BUILTIN_AGENT_BROWSER_PLUGIN_ID) {
    return hasPluginSchema ? pluginSchema : undefined;
  }

  if (!hasPluginSchema) {
    return AGENT_BROWSER_SETTINGS_SCHEMA;
  }

  return {
    ...AGENT_BROWSER_SETTINGS_SCHEMA,
    ...pluginSchema,
  };
}

function groupSettingsSchema(settingsSchema: Record<string, PluginSettingSchema>) {
  const grouped = new Map<string, Array<[string, PluginSettingSchema]>>();
  const ungrouped: Array<[string, PluginSettingSchema]> = [];

  for (const [key, schema] of Object.entries(settingsSchema)) {
    if (schema.group) {
      const groupItems = grouped.get(schema.group) ?? [];
      groupItems.push([key, schema]);
      grouped.set(schema.group, groupItems);
    } else {
      ungrouped.push([key, schema]);
    }
  }

  return { grouped, ungrouped };
}

function renderPluginError(plugin: PluginInstallation, className = "plugin-error-text") {
  if (plugin.state !== "error" || !plugin.error) {
    return null;
  }

  return (
    <p className={className} title={plugin.error}>
      {plugin.error}
    </p>
  );
}

export function PluginManager({ addToast, projectId }: PluginManagerProps) {
  const { t } = useTranslation("app");
  const [plugins, setPlugins] = useState<PluginInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInstall, setShowInstall] = useState(false);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installAiScanOnLoad, setInstallAiScanOnLoad] = useState(false);
  const [reloadingPluginId, setReloadingPluginId] = useState<string | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<PluginInstallation | null>(null);
  const [pluginSettings, setPluginSettings] = useState<Record<string, unknown>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [installingBuiltinPluginId, setInstallingBuiltinPluginId] = useState<string | null>(null);
  const [registryEntries, setRegistryEntries] = useState<RegistryPluginEntry[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [registrySearchQuery, setRegistrySearchQuery] = useState("");
  const [registryCategory, setRegistryCategory] = useState<string>("");
  const [installingRegistryId, setInstallingRegistryId] = useState<string | null>(null);
  const registrySearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [builtinSetupStatusById, setBuiltinSetupStatusById] = useState<Record<string, PluginSetupStatusResponse>>({});
  const [loadingBuiltinSetupId, setLoadingBuiltinSetupId] = useState<string | null>(null);
  const [installingBuiltinSetupId, setInstallingBuiltinSetupId] = useState<string | null>(null);
  /*
   * FNXC:PluginManager 2026-07-07-00:00:
   * FN-7629 — built-in runtime plugins (Hermes/Paperclip/OpenClaw/Droid) must expose a durable
   * enable/disable control even when no plugin_installs row exists yet ("activated-without-record").
   * Track in-flight toggles separately from install/setup so the toggle-switch can show a busy
   * state without blocking the Install/Manage button.
   */
  const [togglingBuiltinRuntimeId, setTogglingBuiltinRuntimeId] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchPlugins(projectId);
      setPlugins(data);
    } catch (err) {
      addToast(t("plugins.loadFailed", "Failed to load plugins: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, addToast]);

  const loadRegistry = useCallback(async (query = registrySearchQuery, category = registryCategory) => {
    try {
      setRegistryLoading(true);
      setRegistryError(null);
      const entries = await fetchPluginRegistry(query, category || undefined, projectId);
      setRegistryEntries(entries);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRegistryError(message);
    } finally {
      setRegistryLoading(false);
    }
  }, [projectId, registryCategory, registrySearchQuery]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    if (registrySearchTimerRef.current) {
      clearTimeout(registrySearchTimerRef.current);
    }

    registrySearchTimerRef.current = setTimeout(() => {
      void loadRegistry(registrySearchQuery, registryCategory);
    }, 300);

    return () => {
      if (registrySearchTimerRef.current) {
        clearTimeout(registrySearchTimerRef.current);
      }
    };
  }, [loadRegistry, registryCategory, registrySearchQuery]);

  useEffect(() => {
    const installedBuiltinsWithSetup = BUILTIN_PLUGINS.filter((builtinPlugin) => (
      builtinPlugin.hasSetup && plugins.some((plugin) => plugin.id === builtinPlugin.id)
    ));

    if (installedBuiltinsWithSetup.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(installedBuiltinsWithSetup.map(async (builtinPlugin) => {
      try {
        const response = await fetchPluginSetupStatus(builtinPlugin.id, projectId);
        if (cancelled) {
          return;
        }
        setBuiltinSetupStatusById((prev) => ({ ...prev, [builtinPlugin.id]: response }));
      } catch {
        if (cancelled) {
          return;
        }
        setBuiltinSetupStatusById((prev) => ({
          ...prev,
          [builtinPlugin.id]: {
            hasSetup: true,
            setupCheckDeferred: true,
            deferredReason: "plugin-not-started",
            pluginState: "installed",
          },
        }));
      }
    }));

    return () => {
      cancelled = true;
    };
  }, [plugins, projectId]);

  // SSE live updates for plugin lifecycle events
  const pluginsRef = useRef<PluginInstallation[]>([]);
  pluginsRef.current = plugins;

  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const handlePluginLifecycle = (e: MessageEvent) => {
      try {
        const payload: PluginLifecyclePayload = JSON.parse(e.data);
        
        if (payload.scope === "project") {
          if ((payload.projectId ?? projectId) !== projectId) {
            return;
          }
        }

        switch (payload.transition) {
          case "installing":
          case "enabled":
          case "disabled":
          case "settings-updated":
            void loadRegistry(registrySearchQuery, registryCategory);
            // Update existing plugin or add if new
            setPlugins((prev) => {
              const existingIndex = prev.findIndex((p) => p.id === payload.pluginId);
              if (existingIndex >= 0) {
                // Update existing plugin
                const updated = [...prev];
                updated[existingIndex] = {
                  ...updated[existingIndex],
                  enabled: payload.enabled,
                  state: payload.state,
                  settings: payload.settings,
                  error: payload.error,
                };
                return updated;
              } else {
                // New plugin added via another session — refetch to get full data
                void loadPlugins();
                return prev;
              }
            });
            break;

          case "state-changed":
            setPlugins((prev) => {
              const existingIndex = prev.findIndex((p) => p.id === payload.pluginId);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = {
                  ...updated[existingIndex],
                  state: payload.state,
                  error: payload.error,
                };
                return updated;
              }
              return prev;
            });
            break;

          case "uninstalled":
            // Remove plugin from list
            setPlugins((prev) => prev.filter((p) => p.id !== payload.pluginId));
            void loadRegistry(registrySearchQuery, registryCategory);
            break;

          case "error":
            // Update plugin state to error
            setPlugins((prev) => {
              const existingIndex = prev.findIndex((p) => p.id === payload.pluginId);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = {
                  ...updated[existingIndex],
                  state: payload.state,
                  error: payload.error,
                };
                return updated;
              }
              return prev;
            });
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    return subscribeSse(`/api/events${query}`, {
      events: { "plugin:lifecycle": handlePluginLifecycle },
      onReconnect: () => {
        // Re-sync plugin list after a forced reconnect — any events that
        // occurred while disconnected would otherwise be missed.
        void loadPlugins();
        void loadRegistry(registrySearchQuery, registryCategory);
      },
    });
  }, [projectId, loadPlugins, loadRegistry, registryCategory, registrySearchQuery]);

  const handleInstall = async () => {
    if (!installPath.trim()) {
      addToast(t("plugins.installPathRequired", "Please enter a plugin path"), "error");
      return;
    }

    try {
      setInstalling(true);
      await installPlugin({ path: installPath, ...(installAiScanOnLoad ? { aiScanOnLoad: true } : {}) }, projectId);
      addToast(t("plugins.installedGlobally", "Plugin installed globally"), "success");
      setShowInstall(false);
      setInstallPath("");
      setInstallAiScanOnLoad(false);
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.installFailed", "Failed to install plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallBuiltinPlugin = async (plugin: BuiltinPlugin) => {
    if (!plugin.path) {
      addToast(t("plugins.builtinNoPackage", "{{name}} is built in and does not have an installable package yet", { name: plugin.name }), "warning");
      return;
    }

    try {
      setInstallingBuiltinPluginId(plugin.id);
      await installPlugin({ path: plugin.path }, projectId);
      addToast(t("plugins.builtinInstalledGlobally", "{{name}} installed globally", { name: plugin.name }), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.builtinInstallFailed", "Failed to install {{name}}: {{error}}", { name: plugin.name, error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setInstallingBuiltinPluginId(null);
    }
  };

  const handleInstallRegistryPlugin = async (entry: RegistryPluginEntry) => {
    if (!entry.path) {
      addToast(t("plugins.registryNotInstallable", "{{name}} is not available for one-click install yet", { name: entry.name }), "warning");
      return;
    }

    try {
      setInstallingRegistryId(entry.id);
      await installPlugin({ path: entry.path }, projectId);
      addToast(t("plugins.registryInstalled", "{{name}} installed and enabled", { name: entry.name }), "success");
      await loadPlugins();
      await loadRegistry(registrySearchQuery, registryCategory);
    } catch (err) {
      addToast(t("plugins.registryInstallFailed", "Failed to install {{name}}: {{error}}", { name: entry.name, error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setInstallingRegistryId(null);
    }
  };

  const handleInstallBuiltinSetup = async (plugin: BuiltinPlugin) => {
    try {
      setInstallingBuiltinSetupId(plugin.id);
      const result = await installPluginSetup(plugin.id, projectId);
      if (!result.success) {
        addToast(t("plugins.setupInstallFailed", "Failed to install {{name}} setup: {{error}}", { name: plugin.name, error: result.error ?? t("plugins.unknownError", "unknown error") }), "error");
        return;
      }
      addToast(t("plugins.setupInstalled", "{{name}} setup installed", { name: plugin.name }), "success");
      setLoadingBuiltinSetupId(plugin.id);
      const setupStatus = await fetchPluginSetupStatus(plugin.id, projectId);
      setBuiltinSetupStatusById((prev) => ({ ...prev, [plugin.id]: setupStatus }));
    } catch (err) {
      addToast(t("plugins.setupInstallFailed", "Failed to install {{name}} setup: {{error}}", { name: plugin.name, error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setInstallingBuiltinSetupId(null);
      setLoadingBuiltinSetupId(null);
    }
  };

  const handleEnable = async (plugin: PluginInstallation) => {
    try {
      const enabledPlugin = await enablePlugin(plugin.id, projectId);
      if (enabledPlugin.state === "error") {
        addToast(t("plugins.enableFailed", "Failed to enable {{name}}: {{error}}", { name: plugin.name, error: enabledPlugin.error ?? t("plugins.unknownError", "unknown error") }), "error");
        await loadPlugins();
        return;
      }

      addToast(t("plugins.enabledForProject", "{{name}} enabled for this project", { name: plugin.name }), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.enablePluginFailed", "Failed to enable plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  const handleDisable = async (plugin: PluginInstallation) => {
    try {
      await disablePlugin(plugin.id, projectId);
      addToast(t("plugins.disabledForProject", "{{name}} disabled for this project", { name: plugin.name }), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.disablePluginFailed", "Failed to disable plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  /*
   * FNXC:PluginManager 2026-07-07-00:00:
   * FN-7629 — durable built-in runtime disable path. A built-in runtime
   * (Hermes/Paperclip/OpenClaw/Droid) that has never been explicitly installed
   * has no plugin_installs row, so enablePlugin/disablePlugin (which both call
   * getPlugin -> ENOENT) cannot persist a decision for it. When the user wants
   * to disable such a runtime, first register it via the existing install path
   * (mirrors the CLI's ensureBundledPluginInstalled lazy-install) so a
   * plugin_installs row + project state exists, then disable it immediately so
   * the decision is durable: loadAllPlugins() only loads plugins where
   * enabled=true, so a disabled runtime is never re-activated on restart.
   * Already-installed runtimes just toggle through the normal enable/disable
   * handlers, same as the installed-plugin list row.
   */
  const handleToggleBuiltinRuntime = async (builtinPlugin: BuiltinPlugin, installedPlugin?: PluginInstallation) => {
    if (installedPlugin) {
      if (installedPlugin.enabled) {
        await handleDisable(installedPlugin);
      } else {
        await handleEnable(installedPlugin);
      }
      return;
    }

    if (!builtinPlugin.path) {
      addToast(t("plugins.builtinNoPackage", "{{name}} is built in and does not have an installable package yet", { name: builtinPlugin.name }), "warning");
      return;
    }

    try {
      setTogglingBuiltinRuntimeId(builtinPlugin.id);
      const registered = await installPlugin({ path: builtinPlugin.path }, projectId);
      await disablePlugin(registered.id, projectId);
      addToast(t("plugins.disabledForProject", "{{name}} disabled for this project", { name: builtinPlugin.name }), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.disablePluginFailed", "Failed to disable plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setTogglingBuiltinRuntimeId(null);
    }
  };

  const handleReload = async (plugin: PluginInstallation) => {
    try {
      setReloadingPluginId(plugin.id);
      await reloadPlugin(plugin.id, projectId);
      addToast(t("plugins.reloaded", "{{name}} reloaded", { name: plugin.name }), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.reloadFailed", "Failed to reload plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setReloadingPluginId(null);
    }
  };

  const handleUninstall = async (plugin: PluginInstallation) => {
    const shouldUninstall = await confirm({
      title: t("plugins.uninstallTitle", "Uninstall Plugin Globally"),
      message: t("plugins.uninstallConfirm", "Are you sure you want to uninstall \"{{name}}\" globally (all projects)?", { name: plugin.name }),
      danger: true,
    });
    if (!shouldUninstall) {
      return;
    }

    try {
      await uninstallPlugin(plugin.id, projectId);
      addToast(t("plugins.uninstalledGlobally", "{{name}} uninstalled globally", { name: plugin.name }), "success");
      await loadPlugins();
      setSelectedPlugin(null);
    } catch (err) {
      addToast(t("plugins.uninstallFailed", "Failed to uninstall plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  const handleToggleAiScanOnLoad = async (plugin: PluginInstallation, aiScanOnLoad: boolean) => {
    try {
      await updatePlugin(plugin.id, { aiScanOnLoad }, projectId);
      addToast(aiScanOnLoad ? t("plugins.aiScanEnabled", "AI scan on load enabled") : t("plugins.aiScanDisabled", "AI scan on load disabled"), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.updateFailed", "Failed to update plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  const handleRescan = async (plugin: PluginInstallation) => {
    try {
      await rescanPlugin(plugin.id, projectId);
      addToast(t("plugins.rescanned", "{{name}} rescanned", { name: plugin.name }), "success");
      await loadPlugins();
    } catch (err) {
      addToast(t("plugins.rescanFailed", "Failed to rescan plugin: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  const handleSelectPlugin = async (plugin: PluginInstallation) => {
    setSelectedPlugin(plugin);
    try {
      setSettingsLoading(true);
      const settings = await fetchPluginSettings(plugin.id, projectId);
      setPluginSettings(settings);
    } catch {
      setPluginSettings({});
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!selectedPlugin) return;

    try {
      await updatePluginSettings(selectedPlugin.id, pluginSettings, projectId);
      addToast(t("plugins.settingsSaved", "Settings saved"), "success");
    } catch (err) {
      addToast(t("plugins.saveSettingsFailed", "Failed to save settings: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  // Plugin detail view
  if (selectedPlugin) {
    return (
      <div className="plugin-manager-detail" data-testid="plugin-manager-detail">
        <div className="plugin-manager-detail-header">
          <button className="btn-icon" onClick={() => setSelectedPlugin(null)} aria-label={t("plugins.backToList", "Back to plugin list")}>
            <X size={16} />
          </button>
          <div className="plugin-detail-title">
            <div className="plugin-detail-title-copy">
              <h4 className="plugin-detail-name">{selectedPlugin.name}</h4>
              {renderPluginError(selectedPlugin, "plugin-error-text plugin-error-text--detail")}
            </div>
            <span className="plugin-state-badge" style={{ color: STATE_COLORS[selectedPlugin.state] || STATE_COLORS.installed }}>
              {selectedPlugin.state}
            </span>
          </div>
        </div>

        <div className="plugin-detail-content">
          <div className="plugin-detail-card">
            {selectedPlugin.description && (
              <p className="plugin-description">{selectedPlugin.description}</p>
            )}
            {selectedPlugin.author && (
              <p className="plugin-detail-meta-row">
                <span className="text-muted">{t("plugins.author", "Author:")}</span>
                {selectedPlugin.author}
              </p>
            )}
            {selectedPlugin.homepage && (
              <p className="plugin-detail-meta-row plugin-homepage">
                <span className="text-muted">{t("plugins.homepage", "Homepage:")}</span>
                <a href={selectedPlugin.homepage} target="_blank" rel="noopener noreferrer">
                  {selectedPlugin.homepage}
                  <ExternalLink size={12} />
                </a>
              </p>
            )}
            <p className="plugin-detail-meta-row">
              <span className="text-muted">{t("plugins.version", "Version:")}</span>
              {selectedPlugin.version}
            </p>
          </div>

          <div className="plugin-detail-card">
            <h5 className="plugin-detail-section-heading">{t("plugins.securityScan", "Security Scan")}</h5>
            <div className="plugin-security-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={Boolean(selectedPlugin.aiScanOnLoad)}
                  onChange={(e) => void handleToggleAiScanOnLoad(selectedPlugin, e.target.checked)}
                />
                {t("plugins.enableAiScanBeforeLoad", "Enable AI scan before load/reload")}
              </label>
              <button className="btn btn-secondary btn-sm" onClick={() => void handleRescan(selectedPlugin)}>
                <Shield size={14} /> {t("plugins.rescanAndReload", "Rescan and Reload")}
              </button>
            </div>
            <p className="text-muted">{t("plugins.aiScanHint", "Turning this on only updates configuration. Use Rescan and Reload to run it now.")}</p>
            {selectedPlugin.lastSecurityScan ? (
              <div className="plugin-security-results">
                <div className="plugin-security-header">
                  <span className={`plugin-state-badge plugin-security-badge plugin-security-badge--${selectedPlugin.lastSecurityScan.verdict}`}>
                    {selectedPlugin.lastSecurityScan.verdict}
                  </span>
                  <span className="text-muted">{selectedPlugin.lastSecurityScan.scannedAt}</span>
                </div>
                <p className="plugin-security-summary">{selectedPlugin.lastSecurityScan.summary}</p>
                <details>
                  <summary>{t("plugins.findings", "Findings ({{count}})", { count: selectedPlugin.lastSecurityScan.findings.length })}</summary>
                  <ul className="plugin-security-findings">
                    {selectedPlugin.lastSecurityScan.findings.map((finding, index) => (
                      <li key={`${finding.file}-${index}`}>
                        <strong>{finding.severity}</strong> {finding.category} — {finding.file}: {finding.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            ) : (
              <p className="text-muted">{t("plugins.noSecurityScan", "No security scan has been run yet.")}</p>
            )}
          </div>

          <div className="plugin-detail-card">
            <h5 className="plugin-detail-section-heading">{t("plugins.settings", "Settings")}</h5>
            {selectedPlugin.id === "fusion-plugin-whatsapp-chat" && (
              <WhatsAppChatPairingPanel projectId={projectId} settings={pluginSettings} />
            )}
            {settingsLoading ? (
              <p className="text-muted"><LoadingSpinner label={t("plugins.loading", "Loading...")} /></p>
            ) : (() => {
              const effectiveSettingsSchema = resolveSettingsSchema(selectedPlugin);

              return effectiveSettingsSchema && Object.keys(effectiveSettingsSchema).length > 0 ? (
              <div className="plugin-settings-form">
                {(() => {
                  const { grouped, ungrouped } = groupSettingsSchema(effectiveSettingsSchema);
                  const sections: Array<{ title: string | null; entries: Array<[string, PluginSettingSchema]> }> = [];

                  if (ungrouped.length > 0) {
                    sections.push({ title: null, entries: ungrouped });
                  }

                  for (const [groupName, entries] of grouped.entries()) {
                    sections.push({ title: groupName, entries });
                  }

                  return sections.map((section) => (
                    <div
                      key={section.title ?? "ungrouped"}
                      className={section.title ? "plugin-settings-group" : undefined}
                    >
                      {section.title && (
                        <h6 className="plugin-settings-group-heading">
                          {AGENT_BROWSER_GROUP_KEYS[section.title]
                            ? t(AGENT_BROWSER_GROUP_KEYS[section.title] as string, section.title)
                            : section.title}
                        </h6>
                      )}
                      {section.entries.map(([key, schema]) => {
                        const helpId = `setting-${key}-help`;
                        const displayLabel = schema.label
                          ? (AGENT_BROWSER_LABEL_KEYS[schema.label]
                              ? t(AGENT_BROWSER_LABEL_KEYS[schema.label] as string, schema.label)
                              : schema.label)
                          : key;
                        return (
                    <div key={key} className="form-group">
                      <label htmlFor={`setting-${key}`}>
                        {displayLabel}
                        {schema.required && " *"}
                      </label>
                      {schema.type === "string" && !schema.multiline && (
                        <input
                          className="input"
                          type="text"
                          id={`setting-${key}`}
                          value={(pluginSettings[key] as string) ?? ""}
                          onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.value })}
                          placeholder={schema.description}
                          aria-describedby={schema.description && !schema.required ? helpId : undefined}
                        />
                      )}
                      {schema.type === "string" && schema.multiline && (
                        <textarea
                          className="input"
                          id={`setting-${key}`}
                          rows={4}
                          value={(pluginSettings[key] as string) ?? ""}
                          onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.value })}
                          placeholder={schema.description}
                          aria-describedby={schema.description && !schema.required ? helpId : undefined}
                        />
                      )}
                      {schema.type === "password" && (
                        <input
                          className="input"
                          type="password"
                          id={`setting-${key}`}
                          value={(pluginSettings[key] as string) ?? ""}
                          onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.value })}
                          placeholder={schema.description}
                          aria-describedby={schema.description && !schema.required ? helpId : undefined}
                        />
                      )}
                      {schema.type === "number" && (
                        <input
                          className="input"
                          type="number"
                          id={`setting-${key}`}
                          value={(pluginSettings[key] as number) ?? ""}
                          onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: Number(e.target.value) })}
                          aria-describedby={schema.description && !schema.required ? helpId : undefined}
                        />
                      )}
                      {schema.type === "boolean" && (
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={(pluginSettings[key] as boolean) ?? false}
                            onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.checked })}
                          />
                          {schema.description}
                        </label>
                      )}
                      {schema.type === "enum" && (
                        <select
                          className="select"
                          id={`setting-${key}`}
                          value={(pluginSettings[key] as string) ?? ""}
                          onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.value })}
                          aria-describedby={schema.description && !schema.required ? helpId : undefined}
                        >
                          <option value="">{t("plugins.selectOption", "Select...")}</option>
                          {schema.enumValues?.map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      )}
                      {schema.type === "array" && (
                        <div className="plugin-settings-array">
                          {(pluginSettings[key] as unknown[] | undefined)?.map((item, index) => (
                            <div key={index} className="plugin-settings-array-item">
                              <input
                                className="input"
                                type={schema.itemType === "number" ? "number" : "text"}
                                value={(item as string | number) ?? ""}
                                onChange={(e) => {
                                  const newValue = e.target.value;
                                  const current = (pluginSettings[key] as unknown[]) || [];
                                  const updated = [...current];
                                  updated[index] = schema.itemType === "number" ? Number(newValue) : newValue;
                                  setPluginSettings({ ...pluginSettings, [key]: updated });
                                }}
                              />
                              <button
                                className="btn-icon"
                                onClick={() => {
                                  const current = (pluginSettings[key] as unknown[]) || [];
                                  const updated = [...current];
                                  updated.splice(index, 1);
                                  setPluginSettings({ ...pluginSettings, [key]: updated });
                                }}
                                aria-label={t("plugins.removeItem", "Remove item")}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ))}
                          <button
                            className="btn btn-secondary"
                            onClick={() => {
                              const current = (pluginSettings[key] as unknown[]) || [];
                              const defaultItem = schema.itemType === "number" ? 0 : "";
                              setPluginSettings({ ...pluginSettings, [key]: [...current, defaultItem] });
                            }}
                          >
                            <Plus size={14} /> {t("plugins.addItem", "Add Item")}
                          </button>
                        </div>
                      )}
                      {schema.description && !schema.required && !schema.multiline && (
                        <span id={helpId} className="form-help">{schema.description}</span>
                      )}
                    </div>
                        );
                      })}
                    </div>
                  ));
                })()}
                <button className="btn btn-primary" onClick={handleSaveSettings}>
                  {t("plugins.saveSettings", "Save Settings")}
                </button>
              </div>
              ) : (
                <p className="text-muted">{t("plugins.noConfigurableSettings", "No configurable settings.")}</p>
              );
            })()}
          </div>

          <div className="plugin-detail-actions">
            {selectedPlugin.state === "started" && (
              <button
                className="btn btn-secondary"
                onClick={() => handleReload(selectedPlugin)}
                disabled={reloadingPluginId === selectedPlugin.id}
              >
                <RotateCcw size={14} className={reloadingPluginId === selectedPlugin.id ? "spin" : ""} />
                {reloadingPluginId === selectedPlugin.id ? t("plugins.reloading", "Reloading...") : t("plugins.reload", "Reload")}
              </button>
            )}
            {selectedPlugin.enabled ? (
              <button className="btn btn-secondary" onClick={() => handleDisable(selectedPlugin)}>
                {t("plugins.disableInProject", "Disable in Project")}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => handleEnable(selectedPlugin)}>
                {t("plugins.enableInProject", "Enable in Project")}
              </button>
            )}
            <button className="btn btn-danger" onClick={() => handleUninstall(selectedPlugin)}>
              <Trash2 size={14} /> {t("plugins.uninstallGlobally", "Uninstall Globally")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const installedPluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const installedPlugins = plugins;

  const renderRegistryPluginSection = () => (
    <section className="plugin-registry-section" aria-label={t("plugins.browseRegistry", "Browse Registry")}>
      <div className="plugin-registry-header">
        <div className="plugin-registry-heading-copy">
          <h4 className="plugin-registry-heading">{t("plugins.browseRegistry", "Browse Registry")}</h4>
          <p className="plugin-registry-description">
            {t("plugins.registryDescription", "Discover curated runtimes and integrations that can be added to this Fusion workspace.")}
          </p>
        </div>
        <div className="plugin-registry-controls">
          <label className="plugin-registry-category-label">
            <span className="sr-only">{t("plugins.registryCategory", "Registry category")}</span>
            <select
              className="select plugin-registry-category-select"
              value={registryCategory}
              onChange={(event) => setRegistryCategory(event.target.value)}
              aria-label={t("plugins.registryCategory", "Registry category")}
            >
              <option value="">{t("plugins.registryCategoryAll", "All Categories")}</option>
              <option value="runtime">{t("plugins.registryCategoryRuntime", "Runtime")}</option>
              <option value="integration">{t("plugins.registryCategoryIntegration", "Integration")}</option>
            </select>
          </label>
          <label className="plugin-registry-search-label">
            <span className="sr-only">{t("plugins.searchRegistry", "Search registry")}</span>
            <input
              className="input plugin-registry-search-input"
              type="search"
              value={registrySearchQuery}
              onChange={(event) => setRegistrySearchQuery(event.target.value)}
              placeholder={t("plugins.searchRegistryPlaceholder", "Search registry plugins")}
            />
          </label>
        </div>
      </div>

      {registryLoading ? (
        <div className="plugin-registry-state" role="status">
          <RefreshCw size={14} className="spin" />
          {t("plugins.registryLoading", "Loading registry...")}
        </div>
      ) : registryError ? (
        <div className="plugin-registry-state plugin-registry-state--error" role="alert">
          <span>{t("plugins.registryLoadFailed", "Failed to load registry: {{error}}", { error: registryError })}</span>
          <button className="btn btn-secondary btn-sm plugin-registry-retry" onClick={() => void loadRegistry(registrySearchQuery, registryCategory)}>
            {t("plugins.retry", "Retry")}
          </button>
        </div>
      ) : registryEntries.length === 0 ? (
        <div className="plugin-registry-state">
          {registrySearchQuery.trim()
            ? t("plugins.registryEmptySearch", "No registry plugins match your search.")
            : t("plugins.registryEmpty", "No registry plugins are available.")}
        </div>
      ) : (
        <div className="plugin-registry-list" aria-label={t("plugins.registryPluginResults", "Registry plugin results")}>
          {registryEntries.map((entry) => {
            const installedPlugin = installedPluginsById.get(entry.id);
            const isInstalling = installingRegistryId === entry.id;
            return (
              <div key={entry.id} className="plugin-registry-item">
                <div className="plugin-registry-meta">
                  <div className="plugin-registry-title-row">
                    <span className="plugin-registry-name">{entry.name}</span>
                    <span className="plugin-registry-version">v{entry.version}</span>
                    <span className="plugin-registry-badge">{entry.category}</span>
                    {entry.installed && (
                      <span className="plugin-registry-status plugin-registry-status--installed">
                        {t("plugins.statusInstalled", "Installed")}
                        {entry.installedVersion && entry.installedVersion !== entry.version ? ` · v${entry.installedVersion}` : ""}
                      </span>
                    )}
                  </div>
                  <span className="plugin-registry-description-text">{entry.description}</span>
                  <span className="plugin-registry-author">{t("plugins.registryByAuthor", "By {{author}}", { author: entry.author })}</span>
                </div>
                <div className="plugin-registry-actions">
                  {entry.installed ? (
                    <button
                      className="btn btn-secondary btn-sm plugin-registry-action"
                      onClick={() => {
                        if (installedPlugin) {
                          void handleSelectPlugin(installedPlugin);
                        } else {
                          void loadPlugins();
                        }
                      }}
                    >
                      {t("plugins.manage", "Manage")}
                    </button>
                  ) : entry.canInstall ? (
                    <button
                      className="btn btn-primary btn-sm plugin-registry-action"
                      onClick={() => void handleInstallRegistryPlugin(entry)}
                      disabled={isInstalling}
                    >
                      {isInstalling ? t("plugins.installing", "Installing...") : t("plugins.installFromRegistry", "Install")}
                    </button>
                  ) : (
                    <span className="plugin-registry-coming-soon">{t("plugins.registryComingSoon", "Coming Soon")}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );

  const renderBuiltinPluginSection = () => (
    <section className="plugin-builtins-section" aria-label={t("plugins.builtinPlugins", "Built-in Plugins")}>
      <div className="plugin-builtins-header">
        <h4 className="plugin-builtins-heading">{t("plugins.builtinPlugins", "Built-in Plugins")}</h4>
        <p className="plugin-builtins-description">
          {t("plugins.builtinPluginsCatalog", "Built-in plugin catalog for runtimes and integrations.")}
        </p>
      </div>
      <div className="plugin-builtins-list" aria-label={t("plugins.builtinPluginRecommendations", "Built-in plugin recommendations")}>
        {BUILTIN_PLUGINS.map((builtinPlugin) => {
          const installedPlugin = installedPluginsById.get(builtinPlugin.id);
          const isInstalled = Boolean(installedPlugin);
          const setupStatus = builtinSetupStatusById[builtinPlugin.id];
          const setupStatusDeferred = Boolean(
            setupStatus
            && "setupCheckDeferred" in setupStatus
            && setupStatus.setupCheckDeferred,
          );
          const pluginSetupState = setupStatus && "status" in setupStatus ? setupStatus.status : undefined;
          const requiresSetupAction =
            isInstalled
            && builtinPlugin.hasSetup
            && setupStatus?.hasSetup
            && !setupStatusDeferred
            && installedPlugin?.state === "started"
            && (pluginSetupState === "not-installed" || pluginSetupState === "error");
          const setupReady = isInstalled && setupStatus?.hasSetup && pluginSetupState === "installed";
          const setupCheckInFlight = loadingBuiltinSetupId === builtinPlugin.id;
          const metadataOnly = !builtinPlugin.path;
          /*
           * FNXC:PluginManager 2026-07-07-00:00:
           * FN-7629 — runtime built-ins (Hermes/Paperclip/OpenClaw/Droid) must always expose an
           * interactive enable/disable control, independent of install status, and must never
           * dead-end at the static "Built-in metadata only" label. Non-runtime built-ins (e.g.
           * Agent Browser) keep the existing metadata-only/install/manage affordances unchanged.
           */
          const isRuntimeBuiltin = builtinPlugin.category === "runtime";
          const runtimeEnabled = installedPlugin ? installedPlugin.enabled : true;
          const isTogglingRuntime = togglingBuiltinRuntimeId === builtinPlugin.id;

          return (
            <div key={builtinPlugin.id} className="plugin-builtins-item">
              <div className="plugin-builtins-meta">
                <span className="plugin-builtins-name">{builtinPlugin.name}</span>
                {builtinPlugin.experimental && <span className="plugin-builtins-runtime-badge">{t("plugins.experimental", "Experimental")}</span>}
                <span className="plugin-builtins-runtime-badge">{builtinPlugin.category}</span>
                <span className={`plugin-builtins-status ${isInstalled ? "plugin-builtins-status--installed" : "plugin-builtins-status--available"}`}>
                  {isInstalled ? t("plugins.statusInstalled", "Installed") : metadataOnly ? t("plugins.statusBuiltIn", "Built in") : t("plugins.statusNotInstalled", "Not installed")}
                </span>
                {isRuntimeBuiltin && !runtimeEnabled && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--warning">{t("plugins.builtinDisabled", "Disabled")}</span>
                )}
                {requiresSetupAction && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--warning">{t("plugins.setupRequired", "Setup required")}</span>
                )}
                {setupReady && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--ready">{t("plugins.setupReady", "Setup ready")}</span>
                )}
                {setupCheckInFlight && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--pending">{t("plugins.checkingSetup", "Checking setup...")}</span>
                )}
                {setupStatusDeferred && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--deferred">{t("plugins.startPluginToCheckSetup", "Start plugin to check setup")}</span>
                )}
                <span className="plugin-builtins-description-text">{builtinPlugin.description}</span>
              </div>
              <div className="plugin-builtins-actions">
                {isRuntimeBuiltin && (
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={runtimeEnabled}
                      onChange={() => void handleToggleBuiltinRuntime(builtinPlugin, installedPlugin)}
                      disabled={isTogglingRuntime}
                      aria-label={runtimeEnabled
                        ? t("plugins.disablePlugin", "Disable {{name}}", { name: builtinPlugin.name })
                        : t("plugins.enablePlugin", "Enable {{name}}", { name: builtinPlugin.name })}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                )}
                {metadataOnly ? (
                  isInstalled && requiresSetupAction ? (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleInstallBuiltinSetup(builtinPlugin)}
                      disabled={installingBuiltinSetupId === builtinPlugin.id || setupCheckInFlight}
                    >
                      {installingBuiltinSetupId === builtinPlugin.id ? t("plugins.settingUp", "Setting up...") : t("plugins.installSetup", "Install Setup")}
                    </button>
                  ) : isInstalled && installedPlugin ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => void handleSelectPlugin(installedPlugin)}>
                      {t("plugins.manage", "Manage")}
                    </button>
                  ) : isRuntimeBuiltin ? null : (
                    <span className="plugin-builtins-metadata-only">{t("plugins.builtinMetadataOnly", "Built-in metadata only")}</span>
                  )
                ) : (
                  <button
                    className={`btn ${(isInstalled && !requiresSetupAction) ? "btn-secondary" : "btn-primary"} btn-sm`}
                    onClick={() => {
                      if (!isInstalled) {
                        void handleInstallBuiltinPlugin(builtinPlugin);
                        return;
                      }

                      if (requiresSetupAction) {
                        void handleInstallBuiltinSetup(builtinPlugin);
                        return;
                      }

                      if (installedPlugin) {
                        void handleSelectPlugin(installedPlugin);
                      }
                    }}
                    disabled={
                      installingBuiltinPluginId === builtinPlugin.id
                      || installingBuiltinSetupId === builtinPlugin.id
                      || setupCheckInFlight
                    }
                  >
                    {!isInstalled
                      ? (installingBuiltinPluginId === builtinPlugin.id ? t("plugins.installing", "Installing...") : t("plugins.installNamed", "Install {{name}}", { name: builtinPlugin.name }))
                      : requiresSetupAction
                        ? (installingBuiltinSetupId === builtinPlugin.id ? t("plugins.settingUp", "Setting up...") : t("plugins.installSetup", "Install Setup"))
                        : t("plugins.manage", "Manage")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );

  // Plugin list view
  return (
    <div className="plugin-manager" data-testid="plugin-manager">
      <div className="plugin-manager-header">
        <span className="plugin-manager-header-title">{t("plugins.installedPlugins", "Installed Plugins")}</span>
        <div className="plugin-manager-actions">
          <button className="btn btn-sm" onClick={loadPlugins} title={t("plugins.refresh", "Refresh")} aria-label={t("plugins.refreshPluginList", "Refresh plugin list")}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            {t("plugins.refresh", "Refresh")}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowInstall(true)}>
            <Plus size={14} /> {t("plugins.install", "Install")}
          </button>
        </div>
      </div>

      {showInstall && (
        <div className="plugin-install-form">
          <p className="plugin-install-hint">
            {t("plugins.installHint", "Browse to a plugin package root (contains manifest.json) or a built dist directory.")}
          </p>
          <DirectoryPicker
            value={installPath}
            onChange={setInstallPath}
            placeholder={t("plugins.installPathPlaceholder", "Absolute path to plugin directory or dist folder")}
            onInputKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleInstall();
              }
            }}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={installAiScanOnLoad}
              onChange={(e) => setInstallAiScanOnLoad(e.target.checked)}
            />
            {t("plugins.enableAiSecurityScan", "Enable AI security scan on load")}
          </label>
          <div className="plugin-install-actions">
            <button className="btn btn-primary" onClick={handleInstall} disabled={installing || !installPath.trim()}>
              {installing ? t("plugins.installing", "Installing...") : t("plugins.installPluginGlobally", "Install Plugin Globally")}
            </button>
            <button className="btn btn-secondary" onClick={() => { setShowInstall(false); setInstallPath(""); }}>
              {t("plugins.cancel", "Cancel")}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="settings-empty-state"><LoadingSpinner label={t("plugins.loadingPlugins", "Loading plugins...")} /></div>
      ) : (
        <>
          {installedPlugins.length === 0 ? (
            <div className="settings-empty-state">
              <Package size={32} className="text-muted" />
              <p>{t("plugins.noPluginsInstalled", "No plugins installed.")}</p>
              <p className="text-muted">{t("plugins.noPluginsHint", "Install a plugin to get started, or use the built-in catalog below.")}</p>
            </div>
          ) : (
            <div className="plugin-list">
              {installedPlugins.map((plugin) => (
                <div key={plugin.id} className="plugin-item">
                  <div className="plugin-info">
                    <div className="plugin-copy">
                      <div className="plugin-copy-header">
                        <span className="plugin-name">{plugin.name}</span>
                        <span className="plugin-version text-muted">v{plugin.version}</span>
                        <span className="plugin-state-badge" style={{ color: STATE_COLORS[plugin.state] || STATE_COLORS.installed }}>
                          {plugin.state}
                        </span>
                      </div>
                      {renderPluginError(plugin)}
                    </div>
                  </div>
                  <div className="plugin-actions">
                    {plugin.state === "started" && (
                      <button
                        className="btn-icon"
                        onClick={() => handleReload(plugin)}
                        disabled={reloadingPluginId === plugin.id}
                        title={t("plugins.reload", "Reload")}
                      >
                        <RotateCcw size={14} className={reloadingPluginId === plugin.id ? "spin" : ""} />
                      </button>
                    )}
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={plugin.enabled}
                        onChange={() => plugin.enabled ? handleDisable(plugin) : handleEnable(plugin)}
                        aria-label={plugin.enabled ? t("plugins.disablePlugin", "Disable {{name}}", { name: plugin.name }) : t("plugins.enablePlugin", "Enable {{name}}", { name: plugin.name })}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <button
                      className="btn-icon"
                      onClick={() => handleSelectPlugin(plugin)}
                      title={t("plugins.settings", "Settings")}
                    >
                      <Settings size={14} />
                    </button>
                    <button
                      className="btn-icon"
                      onClick={() => handleUninstall(plugin)}
                      title={t("plugins.uninstallGloballyTitle", "Uninstall globally")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {renderBuiltinPluginSection()}
          {renderRegistryPluginSection()}
        </>
      )}
    </div>
  );
}
