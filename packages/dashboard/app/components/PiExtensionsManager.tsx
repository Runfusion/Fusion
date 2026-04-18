/**
 * Pi Extensions Manager Component
 *
 * Provides UI for managing Pi extensions:
 * - List extensions with source badges and toggle switches
 * - Enable/disable extensions
 * - Refresh extension list
 * - Loading and empty states
 */

import { useState, useEffect, useCallback } from "react";
import { Package, RefreshCw } from "lucide-react";
import { fetchPiExtensions, updatePiExtensions } from "../api";
import type { PiExtensionSettings } from "../api";
import type { ToastType } from "../hooks/useToast";

interface PiExtensionsManagerProps {
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

/** Source to label mapping */
const SOURCE_LABELS: Record<PiExtensionSettings["extensions"][number]["source"], string> = {
  "fusion-global": "Fusion Global",
  "pi-global": "Pi Global",
  "fusion-project": "Fusion Project",
  "pi-project": "Pi Project",
};

export function PiExtensionsManager({ addToast, projectId }: PiExtensionsManagerProps) {
  const [extensions, setExtensions] = useState<PiExtensionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadExtensions = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchPiExtensions(projectId);
      setExtensions(data);
    } catch (err) {
      addToast(`Failed to load Pi extensions: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [projectId, addToast]);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  const toggleExtension = async (extensionId: string, enabled: boolean) => {
    if (!extensions) return;

    const nextDisabledIds = enabled
      ? extensions.disabledIds.filter((id) => id !== extensionId)
      : Array.from(new Set([...extensions.disabledIds, extensionId]));

    setSaving(true);
    try {
      const nextSettings = await updatePiExtensions(nextDisabledIds, projectId);
      setExtensions(nextSettings);
      addToast("Pi extension settings saved", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save Pi extension settings", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pi-ext-manager">
      <div className="pi-ext-manager-header">
        <h3>Pi Extensions</h3>
        <div className="pi-ext-manager-actions">
          <button className="btn-icon" onClick={loadExtensions} title="Refresh" disabled={loading}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      <p className="pi-ext-description">
        Choose which project and global Pi extensions Fusion loads. Changes are saved to your Fusion agent
        settings and apply after restarting the dashboard or headless node.
      </p>

      {loading ? (
        <div className="loading-state">Loading Pi extensions…</div>
      ) : !extensions || extensions.extensions.length === 0 ? (
        <div className="empty-state">
          <Package size={32} className="text-muted" />
          <p>No Pi extensions found.</p>
          <p className="text-muted">
            Extensions are discovered from ~/.fusion/agent, ~/.pi/agent, and your project&apos;s .fusion/ directory.
          </p>
        </div>
      ) : (
        <div className="pi-ext-list">
          {extensions.extensions.map((extension) => {
            const isGlobal = extension.source === "fusion-global" || extension.source === "pi-global";

            return (
              <div key={extension.id} className="pi-ext-item">
                <div className="pi-ext-item-content">
                  <div className="pi-ext-info">
                    <span className="pi-ext-name">{extension.name}</span>
                    <span
                      className={`pi-ext-source-badge ${isGlobal ? "pi-ext-source-badge--global" : "pi-ext-source-badge--project"}`}
                    >
                      {SOURCE_LABELS[extension.source]}
                    </span>
                  </div>
                  <span className="pi-ext-path">{extension.path}</span>
                </div>
                <div className="pi-ext-actions">
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={extension.enabled}
                      disabled={saving}
                      onChange={(e) => toggleExtension(extension.id, e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
