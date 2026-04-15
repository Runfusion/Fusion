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

import { useState, useEffect, useCallback, useRef } from "react";
import { Package, Settings, Trash2, Plus, X, RefreshCw, RotateCcw, ExternalLink } from "lucide-react";
import { fetchPlugins, installPlugin, enablePlugin, disablePlugin, uninstallPlugin, fetchPluginSettings, updatePluginSettings, reloadPlugin } from "../api";
import { DirectoryPicker } from "./DirectoryPicker";
import type { PluginInstallation, PluginState } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";

/** SSE heartbeat watchdog timeout (matches useTasks hook) */
const SSE_HEARTBEAT_TIMEOUT_MS = 45_000;

/** Normalized plugin lifecycle payload from SSE plugin:lifecycle events */
interface PluginLifecyclePayload {
  pluginId: string;
  transition: "installing" | "enabled" | "disabled" | "error" | "uninstalled" | "settings-updated";
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

const STATE_COLORS: Record<string, string> = {
  started: "var(--color-success, #22c55e)",
  loaded: "var(--color-warning, #eab308)",
  error: "var(--color-error, #ef4444)",
  stopped: "var(--color-muted, #6b7280)",
  installed: "var(--color-info, #3b82f6)",
};

export function PluginManager({ addToast, projectId }: PluginManagerProps) {
  const [plugins, setPlugins] = useState<PluginInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInstall, setShowInstall] = useState(false);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [reloadingPluginId, setReloadingPluginId] = useState<string | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<PluginInstallation | null>(null);
  const [pluginSettings, setPluginSettings] = useState<Record<string, unknown>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);

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

  // SSE live updates for plugin lifecycle events
  const pluginsRef = useRef<PluginInstallation[]>([]);
  pluginsRef.current = plugins;

  useEffect(() => {
    let closedByCleanup = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const es = new EventSource(`/api/events${query}`);

    /** Reset the SSE heartbeat watchdog */
    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        if (!closedByCleanup) {
          // Connection appears dead — force reconnect
          es.close();
          if (!closedByCleanup) {
            reconnectTimer = setTimeout(() => {
              if (!closedByCleanup) {
                void loadPlugins(); // Fallback: refetch all plugins
              }
            }, 3000);
          }
        }
      }, SSE_HEARTBEAT_TIMEOUT_MS);
    };

    // Start the heartbeat watchdog immediately
    resetHeartbeat();

    const handlePluginLifecycle = (e: MessageEvent) => {
      resetHeartbeat();
      try {
        const payload: PluginLifecyclePayload = JSON.parse(e.data);
        
        // Filter by projectId if in project-scoped mode
        if (projectId && payload.projectId && payload.projectId !== projectId) {
          return;
        }

        const currentPlugins = pluginsRef.current;

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

    es.addEventListener("plugin:lifecycle", handlePluginLifecycle);

    // Also listen for the heartbeat to keep the connection alive
    es.addEventListener("heartbeat", () => {
      resetHeartbeat();
    });

    es.onerror = () => {
      if (closedByCleanup) return;
      // EventSource will automatically attempt reconnection
      // We just need to clear our heartbeat watchdog
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    };

    return () => {
      closedByCleanup = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es.removeEventListener("plugin:lifecycle", handlePluginLifecycle);
      es.close();
    };
  }, [projectId, loadPlugins]);

  const handleInstall = async () => {
    if (!installPath.trim()) {
      addToast("Please enter a plugin path", "error");
      return;
    }

    try {
      setInstalling(true);
      await installPlugin({ path: installPath }, projectId);
      addToast("Plugin installed successfully", "success");
      setShowInstall(false);
      setInstallPath("");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  const handleEnable = async (plugin: PluginInstallation) => {
    try {
      await enablePlugin(plugin.id, projectId);
      addToast(`${plugin.name} enabled`, "success");
      await loadPlugins();
    } catch (err) {
      addToast(`Failed to enable plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleDisable = async (plugin: PluginInstallation) => {
    try {
      await disablePlugin(plugin.id, projectId);
      addToast(`${plugin.name} disabled`, "success");
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
    if (!confirm(`Are you sure you want to uninstall "${plugin.name}"?`)) {
      return;
    }

    try {
      await uninstallPlugin(plugin.id, projectId);
      addToast(`${plugin.name} uninstalled`, "success");
      await loadPlugins();
      setSelectedPlugin(null);
    } catch (err) {
      addToast(`Failed to uninstall plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
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
      <div className="plugin-manager-detail">
        <div className="plugin-manager-detail-header">
          <button className="btn-icon" onClick={() => setSelectedPlugin(null)} aria-label="Back to plugin list">
            <X size={16} />
          </button>
          <div className="plugin-detail-title">
            <h3>{selectedPlugin.name}</h3>
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
            <h4 className="settings-section-heading">Settings</h4>
            {settingsLoading ? (
              <p className="text-muted">Loading...</p>
            ) : selectedPlugin.settingsSchema && Object.keys(selectedPlugin.settingsSchema).length > 0 ? (
              <div className="plugin-settings-form">
                {Object.entries(selectedPlugin.settingsSchema).map(([key, schema]) => {
                  const helpId = `setting-${key}-help`;
                  return (
                    <div key={key} className="form-group">
                      <label htmlFor={`setting-${key}`}>
                        {schema.label || key}
                        {schema.required && " *"}
                      </label>
                      {schema.type === "string" && !schema.multiline && (
                        <input
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
                            className="btn-secondary"
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
                <button className="btn-primary" onClick={handleSaveSettings}>
                  Save Settings
                </button>
              </div>
            ) : (
              <p className="text-muted">No configurable settings.</p>
            )}
          </div>

          <div className="plugin-detail-actions">
            {selectedPlugin.state === "started" && (
              <button
                className="btn-secondary"
                onClick={() => handleReload(selectedPlugin)}
                disabled={reloadingPluginId === selectedPlugin.id}
              >
                <RotateCcw size={14} className={reloadingPluginId === selectedPlugin.id ? "spin" : ""} />
                {reloadingPluginId === selectedPlugin.id ? "Reloading..." : "Reload"}
              </button>
            )}
            {selectedPlugin.enabled ? (
              <button className="btn-secondary" onClick={() => handleDisable(selectedPlugin)}>
                Disable
              </button>
            ) : (
              <button className="btn-primary" onClick={() => handleEnable(selectedPlugin)}>
                Enable
              </button>
            )}
            <button className="btn-danger" onClick={() => handleUninstall(selectedPlugin)}>
              <Trash2 size={14} /> Uninstall
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Plugin list view
  return (
    <div className="plugin-manager">
      <div className="plugin-manager-header">
        <h3>Plugins</h3>
        <div className="plugin-manager-actions">
          <button className="btn-icon" onClick={loadPlugins} title="Refresh">
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
          <button className="btn-primary" onClick={() => setShowInstall(true)}>
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
          <div className="plugin-install-actions">
            <button className="btn-primary" onClick={handleInstall} disabled={installing || !installPath.trim()}>
              {installing ? "Installing..." : "Install Plugin"}
            </button>
            <button className="btn-secondary" onClick={() => { setShowInstall(false); setInstallPath(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading plugins...</div>
      ) : plugins.length === 0 ? (
        <div className="empty-state">
          <Package size={32} className="text-muted" />
          <p>No plugins installed.</p>
          <p className="text-muted">Install a plugin to get started.</p>
        </div>
      ) : (
        <div className="plugin-list">
          {plugins.map((plugin) => (
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
                  title="Uninstall"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
