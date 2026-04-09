import { useState, useEffect, useCallback, useRef } from "react";
import { Globe, Folder } from "lucide-react";
import { THINKING_LEVELS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS } from "@fusion/core";
import type { Settings, GlobalSettings, ThemeMode, ColorTheme, ModelPreset, NtfyNotificationEvent } from "@fusion/core";
import { fetchSettings, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, saveApiKey, clearApiKey, fetchModels, testNtfyNotification, fetchBackups, createBackup, exportSettings, importSettings, fetchMemory, saveMemory } from "../api";
import type { AuthProvider, ModelInfo, BackupListResponse, SettingsExportData } from "../api";
import type { ToastType } from "../hooks/useToast";
import { ThemeSelector } from "./ThemeSelector";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { FileEditor } from "./FileEditor";
import { applyPresetToSelection, generateUniquePresetId } from "../utils/modelPresets";

/**
 * Settings sections configuration.
 *
 * Each section groups related settings fields under a sidebar nav item.
 * Sections have a `scope` to indicate where their settings are stored:
 *   - "global": User-level settings stored in ~/.pi/fusion/settings.json (shared across projects)
 *   - "project": Project-specific settings stored in .fusion/config.json
 *   - undefined: Section operates independently of settings storage (e.g. authentication)
 *
 * To add a new section:
 *   1. Add an entry to SETTINGS_SECTIONS with a unique id, label, and scope
 *   2. Add a corresponding case in renderSectionFields()
 *
 * Sections:
 *   - general: Task prefix configuration (project)
 *   - models: All model settings — default model (global), planning & validator models,
 *     model presets, and AI summarization (project). Rendered as sub-sections on one screen.
 *   - appearance: Theme and color settings (global)
 *   - scheduling: Concurrency, poll interval, file overlap serialization, and step execution
 *     settings (runStepsInNewSessions, maxParallelSteps) (project)
 *   - worktrees: Worktree limits, init commands, recycling (project)
 *   - commands: Test and build command configuration (project)
 *   - merge: Auto-merge settings (project)
 *   - notifications: ntfy.sh notification settings (global)
 *   - authentication: OAuth provider status, login/logout (independent)
 */
const SETTINGS_SECTIONS = [
  { id: "general", label: "General", scope: "project" as const },
  { id: "models", label: "Models", scope: "project" as const },
  { id: "appearance", label: "Appearance", scope: "global" as const },
  { id: "scheduling", label: "Scheduling", scope: "project" as const },
  { id: "worktrees", label: "Worktrees", scope: "project" as const },
  { id: "commands", label: "Commands", scope: "project" as const },
  { id: "merge", label: "Merge", scope: "project" as const },
  { id: "memory", label: "Memory", scope: "project" as const },
  { id: "backups", label: "Backups", scope: "project" as const },
  { id: "notifications", label: "Notifications", scope: "global" as const },
  { id: "authentication", label: "Authentication", scope: undefined },
] as const;

export type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

interface SettingsModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  /** Optional section to show when the modal first opens. Defaults to "general". */
  initialSection?: SectionId;
  /** Current theme mode */
  themeMode?: ThemeMode;
  /** Current color theme */
  colorTheme?: ColorTheme;
  /** Called when theme mode changes */
  onThemeModeChange?: (mode: ThemeMode) => void;
  /** Called when color theme changes */
  onColorThemeChange?: (theme: ColorTheme) => void;
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
}: SettingsModalProps) {
  const [form, setForm] = useState<Settings & { worktreeInitCommand?: string }>({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15000, groupOverlappingFiles: true, autoMerge: true, mergeStrategy: "direct", recycleWorktrees: false, worktreeNaming: "random", includeTaskIdInCommit: true, worktreeInitCommand: "", ntfyEnabled: false, ntfyTopic: undefined });
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? SETTINGS_SECTIONS[0].id);
  const [prefixError, setPrefixError] = useState<string | null>(null);

  /** Get the scope of the currently active section */
  const activeSectionScope = SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.scope;

  // Auth state (independent of the settings save flow)
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
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

  // Project memory state
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);

  // Import/Export state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<SettingsExportData | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importScope, setImportScope] = useState<'global' | 'project' | 'both'>('both');
  const [importMerge, setImportMerge] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchSettings(projectId)
      .then((s) => {
        setForm(s);
        setLoading(false);
      })
      .catch((err) => {
        addToast(err.message, "error");
        setLoading(false);
      });
  }, [addToast, projectId]);

  // Load auth status when the authentication section is active
  const loadAuthStatus = useCallback(async () => {
    try {
      const { providers } = await fetchAuthStatus();
      setAuthProviders(providers);
    } catch {
      // Silently fail — auth may not be configured
    }
  }, []);

  useEffect(() => {
    if (activeSection === "models") {
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

  useEffect(() => {
    if (activeSection !== "memory" || memoryDirty) {
      return;
    }

    let cancelled = false;
    setMemoryLoading(true);
    fetchMemory(projectId)
      .then(({ content }) => {
        if (cancelled) return;
        setMemoryContent(content);
        setMemoryDirty(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        addToast(err?.message || "Failed to load project memory", "error");
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
  }, [activeSection, memoryDirty, projectId, addToast]);

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
    try {
      const { url } = await loginProvider(providerId);
      window.open(url, "_blank");

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
            addToast("Login successful", "success");
          }
        } catch {
          // Continue polling on transient errors
        }
      }, 2000);
    } catch (err: any) {
      addToast(err.message || "Login failed", "error");
      setAuthActionInProgress(null);
    }
  }, [addToast]);

  const handleLogout = useCallback(async (providerId: string) => {
    setAuthActionInProgress(providerId);
    try {
      await logoutProvider(providerId);
      await loadAuthStatus();
      addToast("Logged out", "success");
    } catch (err: any) {
      addToast(err.message || "Logout failed", "error");
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
    } catch (err: any) {
      setApiKeyErrors((prev) => ({ ...prev, [providerId]: err.message || "Failed to save API key" }));
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
    } catch (err: any) {
      addToast(err.message || "Failed to clear API key", "error");
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
      const result = await testNtfyNotification({
        ntfyEnabled: form.ntfyEnabled,
        ntfyTopic: form.ntfyTopic,
      }, projectId);
      if (result.success) {
        addToast("Test notification sent — check your ntfy app!", "success");
      } else {
        addToast("Failed to send test notification", "error");
      }
    } catch (err: any) {
      addToast(err.message || "Failed to send test notification", "error");
    } finally {
      setTestNotificationLoading(false);
    }
  }, [addToast, form.ntfyEnabled, form.ntfyTopic, projectId]);

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
    } catch (err: any) {
      addToast(err.message || "Failed to create backup", "error");
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
    } catch (err: any) {
      addToast(err.message || "Failed to export settings", "error");
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
    } catch (err: any) {
      addToast(`Invalid JSON file: ${err.message}`, "error");
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
    } catch (err: any) {
      addToast(err.message || "Failed to import settings", "error");
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

  const handleSave = useCallback(async () => {
    if (prefixError || presetDraft) return;
    try {
      const payload = {
        ...form,
        worktreeInitCommand: form.worktreeInitCommand?.trim() || undefined,
        taskPrefix: form.taskPrefix?.trim() || undefined,
      };

      // Always save both global and project settings.
      // The backend filters each appropriately (updateSettings ignores global keys,
      // updateGlobalSettings ignores project keys). This ensures fields in sections
      // are persisted correctly based on their scope.

      const globalKeySet = new Set<string>(GLOBAL_SETTINGS_KEYS);
      const globalPatch: Partial<GlobalSettings> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (globalKeySet.has(key)) {
          (globalPatch as any)[key] = value;
        }
      }

      const projectKeySet = new Set<string>(PROJECT_SETTINGS_KEYS as readonly string[]);
      const projectPatch: Partial<Settings> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === "githubTokenConfigured") continue; // server-only field
        if (projectKeySet.has(key)) {
          (projectPatch as any)[key] = value;
        }
      }

      // Save both scopes in parallel if they have changes.
      // Note: themeMode/colorTheme may also be write-through via useTheme callbacks
      // in the Appearance section; duplicate global writes are intentional/idempotent,
      // while this save path persists the full settings form in one action.
      await Promise.all([
        Object.keys(globalPatch).length > 0 ? updateGlobalSettings(globalPatch) : Promise.resolve(),
        Object.keys(projectPatch).length > 0 ? updateSettings(projectPatch, projectId) : Promise.resolve(),
      ]);

      addToast("Settings saved", "success");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [form, prefixError, presetDraft, onClose, addToast, projectId]);

  const handleSaveMemory = useCallback(async () => {
    try {
      await saveMemory(memoryContent, projectId);
      setMemoryDirty(false);
      addToast("Memory saved", "success");
    } catch (err: any) {
      addToast(err?.message || "Failed to save memory", "error");
    }
  }, [memoryContent, projectId, addToast]);

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

  /** Render a scope indicator banner for the current section */
  const renderScopeBanner = () => {
    if (activeSectionScope === "global") {
      return (
        <div className="settings-scope-banner settings-scope-global">
          <span>🌐</span>
          <span>These settings are shared across all your Fusion projects.</span>
        </div>
      );
    }
    if (activeSectionScope === "project") {
      return (
        <div className="settings-scope-banner settings-scope-project">
          <span>📁</span>
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
          </>
        );
      case "models": {
        const selectedValue = form.defaultProvider && form.defaultModelId
          ? `${form.defaultProvider}/${form.defaultModelId}`
          : "";
        const planningValue = form.planningProvider && form.planningModelId
          ? `${form.planningProvider}/${form.planningModelId}`
          : "";
        const validatorValue = form.validatorProvider && form.validatorModelId
          ? `${form.validatorProvider}/${form.validatorModelId}`
          : "";
        const presets = form.modelPresets || [];
        const presetOptions = presets.map((preset) => ({ id: preset.id, name: preset.name }));
        const inUsePresetIds = new Set(Object.values(form.defaultPresetBySize || {}).filter(Boolean));

        return (
          <>
            {renderScopeBanner()}

            {/* --- Default Model --- */}
            <h4 className="settings-section-heading">Default Model</h4>
            <small className="settings-muted" style={{ display: "block", marginBottom: "0.5rem" }}>🌐 Default model is shared across all projects.</small>
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
                      setForm((f) => ({ ...f, defaultThinkingLevel: val || undefined } as any));
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

            <div className="form-group">
              <label htmlFor="tokenCap">Token Cap</label>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  id="tokenCap"
                  type="number"
                  placeholder="No cap"
                  value={(form as any).tokenCap ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setForm((f) => ({ ...f, tokenCap: val ? parseInt(val, 10) : null } as any));
                  }}
                />
                {(form as any).tokenCap != null && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title="Reset to default (no cap)"
                    onClick={() => setForm((f) => ({ ...f, tokenCap: null } as any))}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Reset
                  </button>
                )}
              </div>
              <small>Automatically compact context when approaching this token count. Leave empty for no cap (compact only on overflow errors). Set a number to proactively compact when reaching this token count.</small>
            </div>

            {/* --- Planning & Validation --- */}
            <h4 className="settings-section-heading" style={{ marginTop: "1.5rem" }}>Planning &amp; Validation</h4>
            {modelsLoading ? (
              <div className="settings-empty-state">Loading available models…</div>
            ) : availableModels.length === 0 ? (
              <div className="settings-empty-state settings-muted">
                No models available. Configure authentication first.
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="planningModel">Planning Model</label>
                  <CustomModelDropdown
                    id="planningModel"
                    label="Planning Model"
                    models={availableModels}
                    value={planningValue}
                    onChange={(val) => {
                      if (!val) {
                        setForm((f) => ({ ...f, planningProvider: undefined, planningModelId: undefined }));
                      } else {
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          planningProvider: val.slice(0, slashIdx),
                          planningModelId: val.slice(slashIdx + 1),
                        }));
                      }
                    }}
                    placeholder="Use default"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  <small>AI model used for task planning and specification (triage). Falls back to Default Model when not set.</small>
                </div>
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
                  <label htmlFor="validatorModel">Validator Model</label>
                  <CustomModelDropdown
                    id="validatorModel"
                    label="Validator Model"
                    models={availableModels}
                    value={validatorValue}
                    onChange={(val) => {
                      if (!val) {
                        setForm((f) => ({ ...f, validatorProvider: undefined, validatorModelId: undefined }));
                      } else {
                        const slashIdx = val.indexOf("/");
                        setForm((f) => ({
                          ...f,
                          validatorProvider: val.slice(0, slashIdx),
                          validatorModelId: val.slice(slashIdx + 1),
                        }));
                      }
                    }}
                    placeholder="Use default"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  <small>AI model used for code and specification review. Falls back to Default Model when not set.</small>
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
            <h4 className="settings-section-heading" style={{ marginTop: "1.5rem" }}>Model Presets</h4>
            <div className="form-group">
              <label>Configured presets</label>
              {presets.length === 0 ? (
                <div className="settings-empty-state settings-muted">No presets configured yet.</div>
              ) : (
                <div className="settings-preset-list">
                  {presets.map((preset) => {
                    const selection = applyPresetToSelection(preset);
                    const summary = `${selection.executorValue || "default"} / ${selection.validatorValue || "default"}`;
                    return (
                      <div key={preset.id} className="auth-provider-row">
                        <div className="auth-provider-info">
                          <strong>{preset.name}</strong>
                          <span className="settings-muted">{summary}</span>
                        </div>
                        <div>
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
                              if (inUsePresetIds.has(preset.id) && !confirm(`Preset \"${preset.name}\" is used in auto-selection. Delete it anyway?`)) {
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
              ) : null}
            </div>

            {presetDraft ? (
              <div className="form-group">
                <label>Preset editor</label>
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
                <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={savePresetDraft}>Save preset</button>
                  <button type="button" className="btn btn-sm" onClick={() => { setEditingPresetId(null); setPresetDraft(null); }}>Cancel</button>
                </div>
              </div>
            ) : null}

            <div className="form-group">
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
              <>
                {(["S", "M", "L"] as const).map((sizeKey) => (
                  <div className="form-group" key={sizeKey}>
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
              </>
            ) : null}

            {/* --- OpenRouter Model Sync --- */}
            <h4 className="settings-section-heading" style={{ marginTop: "1.5rem" }}>OpenRouter Models</h4>
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

            {/* --- AI Summarization --- */}
            <h4 className="settings-section-heading" style={{ marginTop: "1.5rem" }}>AI Summarization</h4>
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
              <label htmlFor="maxConcurrent">Max Concurrent Tasks</label>
              <input
                id="maxConcurrent"
                type="number"
                min={1}
                max={10}
                value={form.maxConcurrent}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxConcurrent: Number(e.target.value) }))
                }
              />
            </div>
            <div className="form-group">
              <label htmlFor="pollIntervalMs">Poll Interval (ms)</label>
              <input
                id="pollIntervalMs"
                type="number"
                min={5000}
                step={1000}
                value={form.pollIntervalMs}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pollIntervalMs: Number(e.target.value) }))
                }
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

            <div style={{ borderTop: "1px solid var(--border)", margin: "var(--space-lg) 0" }} />

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
                value={form.maxParallelSteps ?? 2}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxParallelSteps: Number(e.target.value) }))
                }
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
                value={form.maxWorktrees}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxWorktrees: Number(e.target.value) }))
                }
              />
              <small>Limits total git worktrees including in-review tasks</small>
            </div>
            <div className="form-group">
              <label htmlFor="worktreeInitCommand">Worktree Init Command</label>
              <input
                id="worktreeInitCommand"
                type="text"
                placeholder="pnpm install"
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
          </>
        );
      case "memory":
        return (
          <>
            {renderScopeBanner()}
            <h4 className="settings-section-heading">Memory</h4>
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
                Enable project memory
              </label>
              <small>When enabled, agents will consult and update .fusion/memory.md with durable project learnings</small>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", margin: "var(--space-lg) 0" }} />

            <div className="form-group">
              <small>This file stores durable project learnings that agents consult during triage and execution.</small>
            </div>

            {form.memoryEnabled === false && (
              <div className="settings-empty-state" style={{ marginBottom: "var(--space-md)" }}>
                Memory is currently disabled. You can view the file, but editing is read-only until memory is re-enabled.
              </div>
            )}

            {memoryLoading ? (
              <div className="settings-empty-state">Loading memory…</div>
            ) : (
              <div className="form-group">
                <div
                  style={{
                    height: "400px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <FileEditor
                    content={memoryContent}
                    onChange={(content) => {
                      setMemoryContent(content);
                      setMemoryDirty(true);
                    }}
                    readOnly={form.memoryEnabled === false}
                    filePath=".fusion/memory.md"
                  />
                </div>
              </div>
            )}

            {memoryDirty && (
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
          </>
        );
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
                value={form.autoBackupRetention || 7}
                onChange={(e) =>
                  setForm((f) => ({ ...f, autoBackupRetention: Number(e.target.value) }))
                }
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
                        const current = form.ntfyEvents ?? (["in-review", "merged", "failed", "awaiting-approval"] as NtfyNotificationEvent[]);
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
                        const current = form.ntfyEvents ?? (["in-review", "merged", "failed", "awaiting-approval"] as NtfyNotificationEvent[]);
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
                        const current = form.ntfyEvents ?? (["in-review", "merged", "failed", "awaiting-approval"] as NtfyNotificationEvent[]);
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
                        const current = form.ntfyEvents ?? (["in-review", "merged", "failed", "awaiting-approval"] as NtfyNotificationEvent[]);
                        const newEvents = e.target.checked
                          ? (current.includes("awaiting-approval") ? current : [...current, "awaiting-approval" as NtfyNotificationEvent])
                          : current.filter((ev): ev is NtfyNotificationEvent => ev !== "awaiting-approval");
                        setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}
                    />
                    Plan needs approval
                  </label>
                  <small>When a task specification needs manual approval before execution</small>
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
      case "authentication":
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
              {!authProviders.some(p => p.authenticated) && (
                <div className="settings-empty-state settings-muted">
                  Sign in to at least one provider to get started.
                </div>
              )}
              {authProviders.map((provider) => (
                <div key={provider.id} className="auth-provider-row">
                  <div className="auth-provider-info">
                    <strong>{provider.name}</strong>
                    <span
                      data-testid={`auth-status-${provider.id}`}
                      className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}
                    >
                      {provider.authenticated ? "✓ Authenticated" : "✗ Not authenticated"}
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
                        {provider.authenticated ? (
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
                          {provider.authenticated ? "Logging out…" : "Waiting for login…"}
                        </button>
                      ) : provider.authenticated ? (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogout(provider.id)}
                        >
                          Logout
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleLogin(provider.id)}
                        >
                          Login
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              </>
            )}
            <small className="auth-hint">
              Authentication changes take effect immediately — no need to save.
            </small>
          </>
        );
    }
  };

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {loading ? (
          <div className="settings-empty-state settings-loading">Loading…</div>
        ) : (
          <div className="settings-layout">
            <nav className="settings-sidebar">
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  className={`settings-nav-item${activeSection === section.id ? " active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                  title={section.scope === "global" ? "Shared across all projects" : section.scope === "project" ? "Specific to this project" : undefined}
                >
                  {section.scope === "global" && <Globe className="settings-scope-icon" aria-label="Global setting" size={16} />}
                  {section.scope === "project" && <Folder className="settings-scope-icon" aria-label="Project setting" size={16} />}
                  {section.label}
                </button>
              ))}
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
      
      {/* Import Confirmation Dialog */}
      {importDialogOpen && importPreview && (
        <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && setImportDialogOpen(false)}>
          <div className="modal modal-md">
            <div className="modal-header">
              <h3>Import Settings</h3>
              <button className="modal-close" onClick={() => setImportDialogOpen(false)}>
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
