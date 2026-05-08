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
import { Package, Settings, Trash2, Plus, X, RefreshCw, RotateCcw, ExternalLink, Shield } from "lucide-react";
import { fetchPlugins, installPlugin, enablePlugin, disablePlugin, uninstallPlugin, fetchPluginSettings, updatePluginSettings, reloadPlugin, fetchPluginSetupStatus, installPluginSetup, updatePlugin, rescanPlugin } from "../api";
import { DirectoryPicker } from "./DirectoryPicker";
import type { PluginInstallation, PluginState, PluginSettingSchema } from "@fusion/core";
import type { PluginSetupStatusResponse } from "../api";
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

const BUILTIN_PLUGINS: BuiltinPlugin[] = [
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
    id: "fusion-plugin-whatsapp-chat",
    name: "WhatsApp Chat",
    description: "Pairs to WhatsApp Web (multi-device) with QR or pairing code, then bridges direct chats to a Fusion agent.",
    category: "integration",
    path: "./plugins/fusion-plugin-whatsapp-chat",
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



export function PluginManager({ addToast, projectId }: PluginManagerProps) {
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
  const [builtinSetupStatusById, setBuiltinSetupStatusById] = useState<Record<string, PluginSetupStatusResponse>>({});
  const [loadingBuiltinSetupId, setLoadingBuiltinSetupId] = useState<string | null>(null);
  const [installingBuiltinSetupId, setInstallingBuiltinSetupId] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchPlugins(projectId);
      setPlugins(data);
    } catch (err) {
      addToast(`Failed to load plugins: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, addToast]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

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
      },
    });
  }, [projectId, loadPlugins]);

  const handleInstall = async () => {
    if (!installPath.trim()) {
      addToast("Please enter a plugin path", "error");
      return;
    }

    try {
      setInstalling(true);
      await installPlugin({ path: installPath, ...(installAiScanOnLoad ? { aiScanOnLoad: true } : {}) }, projectId);
      addToast("Plugin installed globally", "success");
      setShowInstall(false);
      setInstallPath("");
      setInstallAiScanOnLoad(false);
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallBuiltinPlugin = async (plugin: BuiltinPlugin) => {
    if (!plugin.path) {
      addToast(`${plugin.name} is built in and does not have an installable package yet`, "warning");
      return;
    }

    try {
      setInstallingBuiltinPluginId(plugin.id);
      await installPlugin({ path: plugin.path }, projectId);
      addToast(`${plugin.name} installed globally`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to install ${plugin.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setInstallingBuiltinPluginId(null);
    }
  };

  const handleInstallBuiltinSetup = async (plugin: BuiltinPlugin) => {
    try {
      setInstallingBuiltinSetupId(plugin.id);
      const result = await installPluginSetup(plugin.id, projectId);
      if (!result.success) {
        addToast(`Failed to install ${plugin.name} setup: ${result.error ?? "unknown error"}`, "error");
        return;
      }
      addToast(`${plugin.name} setup installed`, "success");
      setLoadingBuiltinSetupId(plugin.id);
      const setupStatus = await fetchPluginSetupStatus(plugin.id, projectId);
      setBuiltinSetupStatusById((prev) => ({ ...prev, [plugin.id]: setupStatus }));
    } catch (err) {
      addToast(`Failed to install ${plugin.name} setup: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setInstallingBuiltinSetupId(null);
      setLoadingBuiltinSetupId(null);
    }
  };

  const handleEnable = async (plugin: PluginInstallation) => {
    try {
      await enablePlugin(plugin.id, projectId);
      addToast(`${plugin.name} enabled for this project`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to enable plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleDisable = async (plugin: PluginInstallation) => {
    try {
      await disablePlugin(plugin.id, projectId);
      addToast(`${plugin.name} disabled for this project`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to disable plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleReload = async (plugin: PluginInstallation) => {
    try {
      setReloadingPluginId(plugin.id);
      await reloadPlugin(plugin.id, projectId);
      addToast(`${plugin.name} reloaded`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to reload plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setReloadingPluginId(null);
    }
  };

  const handleUninstall = async (plugin: PluginInstallation) => {
    const shouldUninstall = await confirm({
      title: "Uninstall Plugin Globally",
      message: `Are you sure you want to uninstall "${plugin.name}" globally (all projects)?`,
      danger: true,
    });
    if (!shouldUninstall) {
      return;
    }

    try {
      await uninstallPlugin(plugin.id, projectId);
      addToast(`${plugin.name} uninstalled globally`, "success");
      await loadPlugins();
      setSelectedPlugin(null);
    } catch (err) {
      addToast(`Failed to uninstall plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleToggleAiScanOnLoad = async (plugin: PluginInstallation, aiScanOnLoad: boolean) => {
    try {
      await updatePlugin(plugin.id, { aiScanOnLoad }, projectId);
      addToast(`AI scan on load ${aiScanOnLoad ? "enabled" : "disabled"}`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to update plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleRescan = async (plugin: PluginInstallation) => {
    try {
      await rescanPlugin(plugin.id, projectId);
      addToast(`${plugin.name} rescanned`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to rescan plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
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
      addToast("Settings saved", "success");
    } catch (err) {
      addToast(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  // Plugin detail view
  if (selectedPlugin) {
    return (
      <div className="plugin-manager-detail" data-testid="plugin-manager-detail">
        <div className="plugin-manager-detail-header">
          <button className="btn-icon" onClick={() => setSelectedPlugin(null)} aria-label="Back to plugin list">
            <X size={16} />
          </button>
          <div className="plugin-detail-title">
            <h4 className="plugin-detail-name">{selectedPlugin.name}</h4>
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
                <span className="text-muted">Author:</span>
                {selectedPlugin.author}
              </p>
            )}
            {selectedPlugin.homepage && (
              <p className="plugin-detail-meta-row plugin-homepage">
                <span className="text-muted">Homepage:</span>
                <a href={selectedPlugin.homepage} target="_blank" rel="noopener noreferrer">
                  {selectedPlugin.homepage}
                  <ExternalLink size={12} />
                </a>
              </p>
            )}
            <p className="plugin-detail-meta-row">
              <span className="text-muted">Version:</span>
              {selectedPlugin.version}
            </p>
          </div>

          <div className="plugin-detail-card">
            <h5 className="plugin-detail-section-heading">Security Scan</h5>
            <div className="plugin-security-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={Boolean(selectedPlugin.aiScanOnLoad)}
                  onChange={(e) => void handleToggleAiScanOnLoad(selectedPlugin, e.target.checked)}
                />
                Enable AI scan before load/reload
              </label>
              <button className="btn btn-secondary btn-sm" onClick={() => void handleRescan(selectedPlugin)}>
                <Shield size={14} /> Rescan and Reload
              </button>
            </div>
            <p className="text-muted">Turning this on only updates configuration. Use Rescan and Reload to run it now.</p>
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
                  <summary>Findings ({selectedPlugin.lastSecurityScan.findings.length})</summary>
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
              <p className="text-muted">No security scan has been run yet.</p>
            )}
          </div>

          <div className="plugin-detail-card">
            <h5 className="plugin-detail-section-heading">Settings</h5>
            {settingsLoading ? (
              <p className="text-muted">Loading...</p>
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
                        <h6 className="plugin-settings-group-heading">{section.title}</h6>
                      )}
                      {section.entries.map(([key, schema]) => {
                        const helpId = `setting-${key}-help`;
                        return (
                    <div key={key} className="form-group">
                      <label htmlFor={`setting-${key}`}>
                        {schema.label || key}
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
                          <option value="">Select...</option>
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
                                aria-label="Remove item"
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
                            <Plus size={14} /> Add Item
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
                  Save Settings
                </button>
              </div>
              ) : (
                <p className="text-muted">No configurable settings.</p>
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
                {reloadingPluginId === selectedPlugin.id ? "Reloading..." : "Reload"}
              </button>
            )}
            {selectedPlugin.enabled ? (
              <button className="btn btn-secondary" onClick={() => handleDisable(selectedPlugin)}>
                Disable in Project
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => handleEnable(selectedPlugin)}>
                Enable in Project
              </button>
            )}
            <button className="btn btn-danger" onClick={() => handleUninstall(selectedPlugin)}>
              <Trash2 size={14} /> Uninstall Globally
            </button>
          </div>
        </div>
      </div>
    );
  }

  const installedPluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const installedPlugins = plugins;

  const renderBuiltinPluginSection = () => (
    <section className="plugin-builtins-section" aria-label="Built-in Plugins">
      <div className="plugin-builtins-header">
        <h4 className="plugin-builtins-heading">Built-in Plugins</h4>
        <p className="plugin-builtins-description">
          Built-in plugin catalog for runtimes and integrations.
        </p>
      </div>
      <div className="plugin-builtins-list" aria-label="Built-in plugin recommendations">
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

          return (
            <div key={builtinPlugin.id} className="plugin-builtins-item">
              <div className="plugin-builtins-meta">
                <span className="plugin-builtins-name">{builtinPlugin.name}</span>
                {builtinPlugin.experimental && <span className="plugin-builtins-runtime-badge">Experimental</span>}
                <span className="plugin-builtins-runtime-badge">{builtinPlugin.category}</span>
                <span className={`plugin-builtins-status ${isInstalled ? "plugin-builtins-status--installed" : "plugin-builtins-status--available"}`}>
                  {isInstalled ? "Installed" : metadataOnly ? "Built in" : "Not installed"}
                </span>
                {requiresSetupAction && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--warning">Setup required</span>
                )}
                {setupReady && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--ready">Setup ready</span>
                )}
                {setupCheckInFlight && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--pending">Checking setup...</span>
                )}
                {setupStatusDeferred && (
                  <span className="plugin-builtins-setup-status plugin-builtins-setup-status--deferred">Start plugin to check setup</span>
                )}
                <span className="plugin-builtins-description-text">{builtinPlugin.description}</span>
              </div>
              {metadataOnly ? (
                isInstalled && requiresSetupAction ? (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleInstallBuiltinSetup(builtinPlugin)}
                    disabled={installingBuiltinSetupId === builtinPlugin.id || setupCheckInFlight}
                  >
                    {installingBuiltinSetupId === builtinPlugin.id ? "Setting up..." : "Install Setup"}
                  </button>
                ) : isInstalled && installedPlugin ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => void handleSelectPlugin(installedPlugin)}>
                    Manage
                  </button>
                ) : (
                  <span className="plugin-builtins-metadata-only">Built-in metadata only</span>
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
                    ? (installingBuiltinPluginId === builtinPlugin.id ? "Installing..." : `Install ${builtinPlugin.name}`)
                    : requiresSetupAction
                      ? (installingBuiltinSetupId === builtinPlugin.id ? "Setting up..." : "Install Setup")
                      : "Manage"}
                </button>
              )}
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
        <span className="plugin-manager-header-title">Installed Plugins</span>
        <div className="plugin-manager-actions">
          <button className="btn btn-sm" onClick={loadPlugins} title="Refresh" aria-label="Refresh plugin list">
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowInstall(true)}>
            <Plus size={14} /> Install
          </button>
        </div>
      </div>

      {showInstall && (
        <div className="plugin-install-form">
          <p className="plugin-install-hint">
            Browse to a plugin package root (contains <code>manifest.json</code>) or a built <code>dist</code> directory.
          </p>
          <DirectoryPicker
            value={installPath}
            onChange={setInstallPath}
            placeholder="Absolute path to plugin directory or dist folder"
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
            Enable AI security scan on load
          </label>
          <div className="plugin-install-actions">
            <button className="btn btn-primary" onClick={handleInstall} disabled={installing || !installPath.trim()}>
              {installing ? "Installing..." : "Install Plugin Globally"}
            </button>
            <button className="btn btn-secondary" onClick={() => { setShowInstall(false); setInstallPath(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="settings-empty-state">Loading plugins...</div>
      ) : (
        <>
          {installedPlugins.length === 0 ? (
            <div className="settings-empty-state">
              <Package size={32} className="text-muted" />
              <p>No plugins installed.</p>
              <p className="text-muted">Install a plugin to get started, or use the built-in catalog below.</p>
            </div>
          ) : (
            <div className="plugin-list">
              {installedPlugins.map((plugin) => (
                <div key={plugin.id} className="plugin-item">
                  <div className="plugin-info">
                    <span className="plugin-name">{plugin.name}</span>
                    <span className="plugin-version text-muted">v{plugin.version}</span>
                    <span className="plugin-state-badge" style={{ color: STATE_COLORS[plugin.state] || STATE_COLORS.installed }}>
                      {plugin.state}
                    </span>
                  </div>
                  <div className="plugin-actions">
                    {plugin.state === "started" && (
                      <button
                        className="btn-icon"
                        onClick={() => handleReload(plugin)}
                        disabled={reloadingPluginId === plugin.id}
                        title="Reload"
                      >
                        <RotateCcw size={14} className={reloadingPluginId === plugin.id ? "spin" : ""} />
                      </button>
                    )}
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={plugin.enabled}
                        onChange={() => plugin.enabled ? handleDisable(plugin) : handleEnable(plugin)}
                        aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <button
                      className="btn-icon"
                      onClick={() => handleSelectPlugin(plugin)}
                      title="Settings"
                    >
                      <Settings size={14} />
                    </button>
                    <button
                      className="btn-icon"
                      onClick={() => handleUninstall(plugin)}
                      title="Uninstall globally"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {renderBuiltinPluginSection()}
        </>
      )}
    </div>
  );
}
