/**
 * Plugin Manager Component
 *
 * Provides UI for managing installed plugins:
 * - List installed plugins with state indicators
 * - Install plugins from local paths
 * - Enable/disable plugins
 * - Configure plugin settings
 * - Uninstall plugins
 */

import { useState, useEffect, useCallback } from "react";
import { Package, Settings, Trash2, Plus, X, RefreshCw } from "lucide-react";
import { fetchPlugins, installPlugin, enablePlugin, disablePlugin, uninstallPlugin, fetchPluginSettings, updatePluginSettings } from "../api";
import type { PluginInstallation } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";

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
          <button className="btn-icon" onClick={() => setSelectedPlugin(null)} title="Back to list">
            <X size={16} />
          </button>
          <h3>{selectedPlugin.name}</h3>
          <span className="plugin-state-badge" style={{ color: STATE_COLORS[selectedPlugin.state] || STATE_COLORS.installed }}>
            {selectedPlugin.state}
          </span>
        </div>

        <div className="plugin-detail-content">
          <div className="plugin-detail-meta">
            {selectedPlugin.description && (
              <p className="plugin-description">{selectedPlugin.description}</p>
            )}
            {selectedPlugin.author && (
              <p className="plugin-author">By {selectedPlugin.author}</p>
            )}
            {selectedPlugin.homepage && (
              <p className="plugin-homepage">
                <a href={selectedPlugin.homepage} target="_blank" rel="noopener noreferrer">
                  {selectedPlugin.homepage}
                </a>
              </p>
            )}
            <p className="plugin-version">Version {selectedPlugin.version}</p>
          </div>

          <div className="plugin-detail-section">
            <h4>Settings</h4>
            {settingsLoading ? (
              <p>Loading...</p>
            ) : selectedPlugin.settingsSchema ? (
              <div className="plugin-settings-form">
                {Object.entries(selectedPlugin.settingsSchema).map(([key, schema]) => (
                  <div key={key} className="form-group">
                    <label htmlFor={`setting-${key}`}>
                      {schema.label || key}
                      {schema.required && " *"}
                    </label>
                    {schema.type === "string" && (
                      <input
                        type="text"
                        id={`setting-${key}`}
                        value={(pluginSettings[key] as string) ?? ""}
                        onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.value })}
                        placeholder={schema.description}
                      />
                    )}
                    {schema.type === "number" && (
                      <input
                        type="number"
                        id={`setting-${key}`}
                        value={(pluginSettings[key] as number) ?? ""}
                        onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: Number(e.target.value) })}
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
                        value={(pluginSettings[key] as string) ?? ""}
                        onChange={(e) => setPluginSettings({ ...pluginSettings, [key]: e.target.value })}
                      >
                        <option value="">Select...</option>
                        {schema.enumValues?.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    )}
                    {schema.description && !schema.required && (
                      <span className="form-help">{schema.description}</span>
                    )}
                  </div>
                ))}
                <button className="btn-primary" onClick={handleSaveSettings}>
                  Save Settings
                </button>
              </div>
            ) : (
              <p className="text-muted">No configurable settings.</p>
            )}
          </div>

          <div className="plugin-detail-actions">
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
          <input
            type="text"
            placeholder="Local path to plugin directory"
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInstall()}
          />
          <div className="plugin-install-actions">
            <button className="btn-primary" onClick={handleInstall} disabled={installing}>
              {installing ? "Installing..." : "Install"}
            </button>
            <button className="btn-secondary" onClick={() => setShowInstall(false)}>
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
