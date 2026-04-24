/**
 * Pi Extensions Manager Component
 *
 * Provides UI for managing Pi extension packages, extensions, skills, prompts, and themes
 * stored in the global pi settings (~/.pi/agent/settings.json).
 *
 * Features:
 * - List configured package sources with type badges (npm/git/local)
 * - Add new package sources via install form
 * - Remove package sources from the list
 * - Manage top-level extension, skill, prompt, and theme path arrays
 * - Loading and empty states
 */

import { useState, useEffect, useCallback } from "react";
import {
  Package,
  Puzzle,
  BookOpen,
  FileText,
  Palette,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { fetchPiSettings, updatePiSettings, installPiPackage, reinstallFusionPiPackage, fetchPiExtensions, updatePiExtensions, type PiSettings, type PiExtensionEntry } from "../api";
import type { ToastType } from "../hooks/useToast";

interface PiExtensionsManagerProps {
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

/** Map source value to CSS class suffix */
function getSourceClass(source: PiExtensionEntry["source"]): string {
  return source.replace(/-/g, "-");
}

/** Get display label for extension source */
function getSourceLabel(source: PiExtensionEntry["source"]): string {
  const labels: Record<PiExtensionEntry["source"], string> = {
    "fusion-global": "Fusion Global",
    "pi-global": "Pi Global",
    "fusion-project": "Fusion Project",
    "pi-project": "Pi Project",
    package: "Package",
  };
  return labels[source] ?? source;
}

/** Determine package source type from the source string */
function getPackageType(source: string): "npm" | "git" | "local" {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:")) return "git";
  return "local";
}

/** Get display label for a package source (strip prefix) */
function getPackageLabel(source: string): string {
  return source.replace(/^(npm:|git:)/, "");
}

export function PiExtensionsManager({ addToast, projectId }: PiExtensionsManagerProps) {
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [reinstallingFusion, setReinstallingFusion] = useState(false);
  const [newSource, setNewSource] = useState("");
  const [expandedPackages, setExpandedPackages] = useState<Set<number>>(new Set());

  // Discovered extensions state
  const [extensions, setExtensions] = useState<PiExtensionEntry[]>([]);
  const [extensionsLoading, setExtensionsLoading] = useState(true);
  const [updatingExtensions, setUpdatingExtensions] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchPiSettings();
      setSettings(data);
    } catch (err) {
      addToast(`Failed to load Pi settings: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const loadExtensions = useCallback(async () => {
    try {
      setExtensionsLoading(true);
      const data = await fetchPiExtensions(projectId);
      setExtensions(data.extensions);
    } catch (err) {
      addToast(`Failed to load extensions: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setExtensionsLoading(false);
    }
  }, [addToast, projectId]);

  const handleToggleExtension = useCallback(async (ext: PiExtensionEntry) => {
    try {
      setUpdatingExtensions(true);
      const disabledIds = ext.enabled
        ? [...extensions.filter((e) => e.enabled && e.id !== ext.id).map((e) => e.id), ext.id]
        : extensions.filter((e) => e.enabled && e.id !== ext.id).map((e) => e.id);
      await updatePiExtensions(disabledIds, projectId);
      await loadExtensions();
      addToast(ext.enabled ? "Extension disabled" : "Extension enabled", "success");
    } catch (err) {
      addToast(`Failed to update extension: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setUpdatingExtensions(false);
    }
  }, [extensions, projectId, loadExtensions, addToast]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  const toggleExpanded = (index: number) => {
    setExpandedPackages((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleInstall = async () => {
    if (!newSource.trim()) {
      addToast("Please enter a package source", "error");
      return;
    }

    try {
      setInstalling(true);
      await installPiPackage(newSource.trim());
      addToast("Package installed successfully", "success");
      setNewSource("");
      await loadSettings();
    } catch (err) {
      addToast(`Failed to install package: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  const handleReinstallFusion = async () => {
    try {
      setReinstallingFusion(true);
      await reinstallFusionPiPackage(projectId);
      await Promise.all([loadSettings(), loadExtensions()]);
      addToast("Fusion skill reinstalled successfully", "success");
    } catch (err) {
      addToast(`Failed to reinstall Fusion skill: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setReinstallingFusion(false);
    }
  };

  const handleRemovePackage = async (sourceToRemove: string) => {
    if (!settings) return;

    const updatedPackages = settings.packages.filter((pkg) => {
      const pkgSource = typeof pkg === "string" ? pkg : pkg.source;
      return pkgSource !== sourceToRemove;
    });

    try {
      await updatePiSettings({ packages: updatedPackages });
      addToast("Package removed", "success");
      await loadSettings();
    } catch (err) {
      addToast(`Failed to remove package: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleRemoveResource = async (type: "extensions" | "skills" | "prompts" | "themes", pathToRemove: string) => {
    if (!settings) return;

    const updated = settings[type].filter((p) => p !== pathToRemove);

    try {
      await updatePiSettings({ [type]: updated });
      addToast(`${type.slice(0, -1)} removed`, "success");
      await loadSettings();
    } catch (err) {
      addToast(`Failed to update settings: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const renderResourceSection = (
    label: string,
    Icon: typeof Puzzle,
    type: "extensions" | "skills" | "prompts" | "themes"
  ) => {
    if (!settings || settings[type].length === 0) return null;

    return (
      <div className="pi-ext-section">
        <div className="pi-ext-section-header">
          <Icon size={14} />
          <span>{label}</span>
          <span className="pi-ext-count">{settings[type].length}</span>
        </div>
        <div className="pi-ext-resource-list">
          {settings[type].map((path, index) => (
            <span key={index} className="pi-ext-resource-tag">
              <span className="pi-ext-resource-path">{path}</span>
              <button
                className="pi-ext-resource-remove"
                onClick={() => handleRemoveResource(type, path)}
                title={`Remove ${path}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="pi-ext-manager">
      <div className="pi-ext-manager-header">
        <h4 className="settings-section-heading">Pi Extensions</h4>
        <div className="pi-ext-manager-actions">
          <button className="btn-icon" onClick={loadSettings} title="Refresh" disabled={loading}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading-state">Loading Pi settings…</div>
      ) : !settings ? (
        <div className="empty-state">
          <Package size={32} className="text-muted" />
          <p>Failed to load Pi settings.</p>
        </div>
      ) : (
        <>
          {/* Add package form */}
          <div className="pi-ext-add-form">
            <div className="pi-ext-add-form-row">
              <input
                type="text"
                className="input"
                placeholder="npm:pi-extension-name or git:https://github.com/..."
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleInstall();
                  }
                }}
                disabled={installing}
              />
              <button
                className="btn btn-primary"
                onClick={handleInstall}
                disabled={installing || !newSource.trim()}
              >
                <Plus size={14} />
                {installing ? "Installing…" : "Add"}
              </button>
            </div>
            <div className="pi-ext-add-form-row">
              <button
                className="btn"
                onClick={handleReinstallFusion}
                disabled={reinstallingFusion}
              >
                {reinstallingFusion ? "Reinstalling Fusion…" : "Reinstall Fusion skill"}
              </button>
            </div>
          </div>

          {/* Package list */}
          {settings.packages.length > 0 ? (
            <div className="pi-ext-package-list">
              {settings.packages.map((pkg, index) => {
                const source = typeof pkg === "string" ? pkg : pkg.source;
                const type = getPackageType(source);
                const label = getPackageLabel(source);
                const isObject = typeof pkg === "object" && pkg !== null;
                const hasFilters =
                  isObject &&
                  ((pkg as { extensions?: string[] }).extensions?.length ?? 0) > 0 ||
                  ((pkg as { skills?: string[] }).skills?.length ?? 0) > 0 ||
                  ((pkg as { prompts?: string[] }).prompts?.length ?? 0) > 0 ||
                  ((pkg as { themes?: string[] }).themes?.length ?? 0) > 0;
                const isExpanded = expandedPackages.has(index);

                return (
                  <div key={index} className="pi-ext-package-card">
                    <div className="pi-ext-package-header">
                      {isObject && hasFilters ? (
                        <button
                          className="pi-ext-expand-btn"
                          onClick={() => toggleExpanded(index)}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      ) : (
                        <span className="pi-ext-expand-placeholder" />
                      )}
                      <span className={`pi-ext-source-badge pi-ext-source-badge--${type}`}>{type}</span>
                      <span className="pi-ext-package-source">{label}</span>
                      <div className="pi-ext-package-actions">
                        {isObject && hasFilters && (
                          <span className="pi-ext-filter-hint">
                            {(pkg as { extensions?: string[] }).extensions?.length ?? 0} ext,{" "}
                            {(pkg as { skills?: string[] }).skills?.length ?? 0} skill,{" "}
                            {(pkg as { prompts?: string[] }).prompts?.length ?? 0} prompt,{" "}
                            {(pkg as { themes?: string[] }).themes?.length ?? 0} theme
                          </span>
                        )}
                        <button
                          className="pi-ext-remove-btn"
                          onClick={() => handleRemovePackage(source)}
                          title="Remove package"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    {isObject && hasFilters && isExpanded && (
                      <div className="pi-ext-filter-list">
                        {(pkg as { extensions?: string[] }).extensions?.length ? (
                          <div className="pi-ext-filter-section">
                            <Puzzle size={12} />
                            <span className="pi-ext-filter-label">Extensions:</span>
                            {(pkg as { extensions: string[] }).extensions!.map((ext, i) => (
                              <span key={i} className="pi-ext-filter-tag">
                                {ext}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {(pkg as { skills?: string[] }).skills?.length ? (
                          <div className="pi-ext-filter-section">
                            <BookOpen size={12} />
                            <span className="pi-ext-filter-label">Skills:</span>
                            {(pkg as { skills: string[] }).skills!.map((skill, i) => (
                              <span key={i} className="pi-ext-filter-tag">
                                {skill}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {(pkg as { prompts?: string[] }).prompts?.length ? (
                          <div className="pi-ext-filter-section">
                            <FileText size={12} />
                            <span className="pi-ext-filter-label">Prompts:</span>
                            {(pkg as { prompts: string[] }).prompts!.map((prompt, i) => (
                              <span key={i} className="pi-ext-filter-tag">
                                {prompt}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {(pkg as { themes?: string[] }).themes?.length ? (
                          <div className="pi-ext-filter-section">
                            <Palette size={12} />
                            <span className="pi-ext-filter-label">Themes:</span>
                            {(pkg as { themes: string[] }).themes!.map((theme, i) => (
                              <span key={i} className="pi-ext-filter-tag">
                                {theme}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <Package size={32} className="text-muted" />
              <p>No packages configured.</p>
              <p className="text-muted">Add a package source above to get started.</p>
            </div>
          )}

          {/* Top-level resource sections */}
          <div className="pi-ext-top-level">
            {renderResourceSection("Extensions", Puzzle, "extensions")}
            {renderResourceSection("Skills", BookOpen, "skills")}
            {renderResourceSection("Prompts", FileText, "prompts")}
            {renderResourceSection("Themes", Palette, "themes")}
          </div>
        </>
      )}

      {/* Discovered Extensions Section */}
      <div className="pi-ext-discovered-section">
        <div className="pi-ext-discovered-header">
          <h4>Discovered Extensions</h4>
          <button
            className="btn-icon"
            onClick={loadExtensions}
            disabled={extensionsLoading}
            title="Refresh extensions"
          >
            <RefreshCw size={14} className={extensionsLoading ? "spin" : ""} />
          </button>
        </div>
        <p className="pi-ext-description">
          Installed extensions resolved from packages and configured paths.
        </p>

        {extensionsLoading ? (
          <div className="loading-state">Loading extensions…</div>
        ) : extensions.length === 0 ? (
          <div className="empty-state">
            <Package size={32} className="text-muted" />
            <p>No extensions discovered.</p>
          </div>
        ) : (
          <div className="pi-ext-list">
            {extensions.map((ext) => (
              <div key={ext.id} className="pi-ext-item">
                <div className="pi-ext-item-content">
                  <div className="pi-ext-info">
                    <span className="pi-ext-name">{ext.name}</span>
                    <span className={`pi-ext-source-badge pi-ext-source-badge--${getSourceClass(ext.source)}`}>
                      {getSourceLabel(ext.source)}
                    </span>
                  </div>
                  <span className="pi-ext-path">{ext.path}</span>
                </div>
                <div className="pi-ext-actions">
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={ext.enabled}
                      onChange={() => void handleToggleExtension(ext)}
                      disabled={updatingExtensions}
                      aria-label={`Toggle ${ext.name}`}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}