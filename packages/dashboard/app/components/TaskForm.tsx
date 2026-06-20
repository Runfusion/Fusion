import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, type GlobalSettings, type Task, type TaskPriority, type Settings, type WorkflowDefinition } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchModels, fetchSettings, fetchWorkflows, refineText, getRefineErrorMessage, updateGlobalSettings, fetchGlobalSettings, fetchGitBranches, type RefinementType, type ModelInfo, type NodeInfo } from "../api";
import { applyPresetToSelection, getRecommendedPresetForSize } from "../utils/modelPresets";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { NodeHealthDot } from "./NodeHealthDot";
import { Sparkles, ChevronUp, ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { REPO_OVERRIDE_RE, resolveEffectiveGithubRepoDefault } from "./githubTracking";

function getNodeStatusLabel(status: NodeInfo["status"], t: (key: string, defaultValue: string) => string): string {
  if (status === "online") return t("taskForm.nodeStatusOnline", "Online");
  if (status === "connecting") return t("taskForm.nodeStatusConnecting", "Connecting");
  if (status === "error") return t("taskForm.nodeStatusError", "Error");
  return t("taskForm.nodeStatusOffline", "Offline");
}

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const COMMON_INTEGRATION_BRANCHES = ["main", "master", "trunk", "develop"];
const CUSTOM_BRANCH_OPTION = "__fusion-custom__";
const DEFAULT_BRANCH_OPTION = "";

function sortBranchNames(branches: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of COMMON_INTEGRATION_BRANCHES) {
    if (branches.includes(name) && !seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  for (const name of [...branches].sort((a, b) => a.localeCompare(b))) {
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}

/** Renders a phase badge using shared .phase-badge classes for consistency */

export interface PendingImage {
  file: File;
  previewUrl: string;
}

type TaskExecutionModeSelection = "standard" | "fast";
export type BranchSelectionMode = "project-default" | "auto-new" | "existing" | "custom-new" | "shared-group";

const PRESET_OPTION_SEPARATOR = "──────────";

export interface TaskFormProps {
  mode: "create" | "edit";

  // Core fields
  description: string;
  onDescriptionChange: (value: string) => void;
  title?: string;
  onTitleChange?: (value: string) => void;

  // Dependencies
  dependencies: string[];
  onDependenciesChange: (deps: string[]) => void;
  branch?: string;
  onBranchChange?: (value: string) => void;
  branchMode?: BranchSelectionMode;
  onBranchModeChange?: (value: BranchSelectionMode) => void;
  baseBranch?: string;
  onBaseBranchChange?: (value: string) => void;
  nodeId?: string;
  onNodeIdChange?: (nodeId: string | undefined) => void;
  nodeOptions?: NodeInfo[];
  nodeOverrideDisabled?: boolean;
  nodeOverrideDisabledReason?: string;

  // Model configuration
  priority?: TaskPriority;
  onPriorityChange?: (value: TaskPriority) => void;
  executorModel: string;
  onExecutorModelChange: (value: string) => void;
  validatorModel: string;
  onValidatorModelChange: (value: string) => void;
  planningModel?: string;
  onPlanningModelChange?: (value: string) => void;
  thinkingLevel?: string;
  onThinkingLevelChange?: (value: string) => void;
  presetMode: "default" | "preset" | "custom";
  onPresetModeChange: (mode: "default" | "preset" | "custom") => void;
  selectedPresetId: string;
  onSelectedPresetIdChange: (id: string) => void;

  // Workflow selection (U6/R3). The form picks a whole workflow (not individual
  // steps), applied atomically at task creation via the create-time `workflowId`.
  //  - `undefined` → inherit the project default (preselected + "(default)" badge).
  //  - `null`      → "No workflow" (listed first).
  //  - `string`    → a specific workflow id.
  // The dropdown only renders when `onWorkflowIdChange` is provided (create mode);
  // edit-mode workflow management lives in the task detail Workflow tab.
  selectedWorkflowId?: string | null;
  onWorkflowIdChange?: (workflowId: string | null) => void;

  // Attachments
  pendingImages: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;

  // Context
  tasks: Task[];
  projectId?: string;
  disabled?: boolean;
  addToast: (message: string, type?: ToastType) => void;
  isActive?: boolean;

  // Auto-save callback (edit mode)
  onAutoSaveDescription?: (description: string) => Promise<void>;

  // Review level (0=None, 1=Plan Only, 2=Plan and Code, 3=Full)
  reviewLevel?: number;
  onReviewLevelChange?: (value: number | undefined) => void;
  autoMerge?: boolean | undefined;
  onAutoMergeChange?: (value: boolean | undefined) => void;
  executionMode?: TaskExecutionModeSelection;
  onExecutionModeChange?: (value: TaskExecutionModeSelection) => void;
  githubTrackingEnabled?: boolean;
  onGithubTrackingEnabledChange?: (value: boolean) => void;
  githubRepoOverride?: string;
  onGithubRepoOverrideChange?: (value: string) => void;

  // AI-assisted creation callbacks (create mode only)
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
  onClose?: () => void;

  /** Optional content to render between the primary section and the "More options" toggle. */
  renderBelowPrimary?: React.ReactNode;
  /** Optional content to render inside "More options" below Model Configuration. */
  renderBelowModelConfiguration?: React.ReactNode;
  /** When true, skip rendering the Dependencies form-group inside "More options". Use when the parent renders its own dependency UI via renderBelowPrimary. */
  hideDependencies?: boolean;
  /** When true (default), More options auto-expands when non-default advanced selections are present. */
  autoExpandMoreOptionsOnSelection?: boolean;
}

export function TaskForm({
  mode,
  description,
  onDescriptionChange,
  title,
  onTitleChange,
  dependencies,
  onDependenciesChange,
  branch,
  onBranchChange,
  branchMode,
  onBranchModeChange,
  baseBranch,
  onBaseBranchChange,
  nodeId,
  onNodeIdChange,
  nodeOptions,
  nodeOverrideDisabled = false,
  nodeOverrideDisabledReason,
  priority,
  onPriorityChange,
  executorModel,
  onExecutorModelChange,
  validatorModel,
  onValidatorModelChange,
  planningModel,
  onPlanningModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  presetMode,
  onPresetModeChange,
  selectedPresetId,
  onSelectedPresetIdChange,
  selectedWorkflowId,
  onWorkflowIdChange,
  pendingImages,
  onImagesChange,
  tasks,
  projectId,
  disabled = false,
  addToast,
  isActive = true,
  onAutoSaveDescription,
  onPlanningMode,
  onSubtaskBreakdown,
  onClose,
  renderBelowPrimary,
  renderBelowModelConfiguration,
  hideDependencies,
  autoExpandMoreOptionsOnSelection = true,
  reviewLevel,
  onReviewLevelChange,
  autoMerge,
  onAutoMergeChange,
  executionMode,
  onExecutionModeChange,
  githubTrackingEnabled,
  onGithubTrackingEnabledChange,
  githubRepoOverride,
  onGithubRepoOverrideChange,
}: TaskFormProps) {
  const { t } = useTranslation("app");
  const hasInitialMoreOptions =
    (hideDependencies ? false : dependencies.length > 0) ||
    pendingImages.length > 0 ||
    presetMode !== "default" ||
    (priority ?? DEFAULT_TASK_PRIORITY) !== DEFAULT_TASK_PRIORITY ||
    executorModel !== "" ||
    validatorModel !== "" ||
    (planningModel || "") !== "" ||
    (thinkingLevel || "") !== "" ||
    reviewLevel !== undefined ||
    autoMerge !== undefined ||
    executionMode === "fast" ||
    (branch || "") !== "" ||
    (baseBranch || "") !== "" ||
    (nodeId || "") !== "" ||
    githubTrackingEnabled === true ||
    (githubRepoOverride || "") !== "";

  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(
    autoExpandMoreOptionsOnSelection ? hasInitialMoreOptions : false,
  );
  const [depSearch, setDepSearch] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  // U6/R3: full workflow definitions for the picker (fragments excluded below).
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [baseBranchOptions, setBaseBranchOptions] = useState<string[]>([]);
  const [baseBranchCustomMode, setBaseBranchCustomMode] = useState(false);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);

  const depDropdownRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAutoSavingRef = useRef(false);
  const hadMoreOptionSelectionsRef = useRef(hasInitialMoreOptions);
  const initialDescriptionRef = useRef(description.trim());
  const lastAutoSavedDescriptionRef = useRef(description.trim());

  // Load available models, settings, workflow steps when active
  useEffect(() => {
    if (!isActive) return;
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
      })
      .catch(() => {/* silently fail */})
      .finally(() => setModelsLoading(false));
    fetchSettings(projectId)
      .then((nextSettings) => setSettings(nextSettings))
      .catch(() => setSettings(null));
    // U6/R3: load selectable workflows for the picker. Fragments are excluded
    // (KTD-1) so they never appear as selectable task workflows.
    if (onWorkflowIdChange) {
      setWorkflowsLoading(true);
      fetchWorkflows(projectId)
        .then((defs) => setWorkflows(defs.filter((d) => d.kind !== "fragment")))
        .catch(() => setWorkflows([]))
        .finally(() => setWorkflowsLoading(false));
    }
    fetchGlobalSettings()
      .then((nextGlobalSettings) => setGlobalSettings(nextGlobalSettings))
      .catch(() => setGlobalSettings(null));
  }, [isActive, projectId, onWorkflowIdChange]);

  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);
  const effectiveGithubRepoDefault = resolveEffectiveGithubRepoDefault(settings, globalSettings);
  const githubRepoOverrideTrimmed = (githubRepoOverride || "").trim();
  const githubRepoOverrideInvalid = githubRepoOverrideTrimmed.length > 0 && !REPO_OVERRIDE_RE.test(githubRepoOverrideTrimmed);
  const hasMoreOptionSelections =
    (hideDependencies ? false : dependencies.length > 0) ||
    pendingImages.length > 0 ||
    presetMode !== "default" ||
    (priority ?? DEFAULT_TASK_PRIORITY) !== DEFAULT_TASK_PRIORITY ||
    executorModel !== "" ||
    validatorModel !== "" ||
    (planningModel || "") !== "" ||
    (thinkingLevel || "") !== "" ||
    reviewLevel !== undefined ||
    autoMerge !== undefined ||
    executionMode === "fast" ||
    (branch || "") !== "" ||
    (baseBranch || "") !== "" ||
    (nodeId || "") !== "" ||
    githubTrackingEnabled === true ||
    (githubRepoOverride || "") !== "";

  // Auto-select preset by size (create mode only)
  useEffect(() => {
    if (mode !== "create" || !isActive || !settings?.autoSelectModelPreset) return;
    const recommended = getRecommendedPresetForSize(undefined, settings.defaultPresetBySize || {}, availablePresets);
    if (recommended) {
      const selection = applyPresetToSelection(recommended);
      onSelectedPresetIdChange(recommended.id);
      onPresetModeChange("preset");
      onExecutorModelChange(selection.executorValue);
      onValidatorModelChange(selection.validatorValue);
    }
  }, [isActive, settings, availablePresets, mode]);

  // U6/R3: the workflow picker preselects the project default (undefined →
  // "(default)"); there is no longer a per-step defaultOn auto-select effect.
  const githubTrackingDefaultAppliedRef = useRef(false);
  useEffect(() => {
    if (mode !== "create" || !isActive) return;
    if (!onGithubTrackingEnabledChange) return;
    if (githubTrackingDefaultAppliedRef.current) return;
    if (!settings) return;

    onGithubTrackingEnabledChange(settings.githubTrackingEnabledByDefault ?? false);
    githubTrackingDefaultAppliedRef.current = true;
  }, [mode, isActive, settings, onGithubTrackingEnabledChange]);

  useEffect(() => {
    if (!isActive || !onBaseBranchChange) return;
    fetchGitBranches(projectId)
      .then((branches) => {
        const names = branches
          .map((branchInfo) => branchInfo.name)
          .filter((name): name is string => typeof name === "string" && name.length > 0);
        setBaseBranchOptions(sortBranchNames(names));
      })
      .catch(() => setBaseBranchOptions([]));
  }, [isActive, onBaseBranchChange, projectId]);

  useEffect(() => {
    if (!isActive) {
      githubTrackingDefaultAppliedRef.current = false;
    }
  }, [isActive]);

  // Auto-expand advanced options when non-default values are present.
  useEffect(() => {
    if (!autoExpandMoreOptionsOnSelection) {
      hadMoreOptionSelectionsRef.current = hasMoreOptionSelections;
      return;
    }

    if (hasMoreOptionSelections && !hadMoreOptionSelectionsRef.current) {
      setShowMoreOptions(true);
    }
    hadMoreOptionSelectionsRef.current = hasMoreOptionSelections;
  }, [hasMoreOptionSelections, autoExpandMoreOptionsOnSelection]);

  // Keep dependency dropdown state clean when advanced options are collapsed.
  useEffect(() => {
    if (showMoreOptions) return;
    setShowDepDropdown(false);
    setDepSearch("");
  }, [showMoreOptions]);

  // Auto-select title input text in edit mode (focus is handled by autoFocus)
  useEffect(() => {
    if (mode !== "edit" || !isActive) return;
    if (titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [mode, isActive]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showDepDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (depDropdownRef.current && !depDropdownRef.current.contains(e.target as Node)) {
        setShowDepDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDepDropdown]);

  // Exit description fullscreen mode when edit controls are unavailable
  useEffect(() => {
    if (mode !== "edit" || disabled) {
      setIsDescriptionExpanded(false);
    }
  }, [mode, disabled]);

  // Reset auto-save tracking when entering edit mode
  useEffect(() => {
    if (mode !== "edit") {
      setAutoSaveStatus("idle");
      return;
    }
    const trimmed = description.trim();
    initialDescriptionRef.current = trimmed;
    lastAutoSavedDescriptionRef.current = trimmed;
    setAutoSaveStatus("idle");
  }, [mode]);

  // Debounced auto-save for edit mode description changes
  useEffect(() => {
    if (mode !== "edit" || !onAutoSaveDescription || !isActive) return;

    const trimmedDescription = description.trim();
    const initialDescription = initialDescriptionRef.current;

    if (trimmedDescription === initialDescription || trimmedDescription === lastAutoSavedDescriptionRef.current) {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
      if (!isAutoSavingRef.current) {
        setAutoSaveStatus("idle");
      }
      return;
    }

    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (isAutoSavingRef.current) return;

      isAutoSavingRef.current = true;
      setAutoSaveStatus("saving");

      try {
        await onAutoSaveDescription(trimmedDescription);
        lastAutoSavedDescriptionRef.current = trimmedDescription;
        setAutoSaveStatus("saved");

        if (autoSaveStatusTimeoutRef.current) {
          clearTimeout(autoSaveStatusTimeoutRef.current);
        }
        autoSaveStatusTimeoutRef.current = setTimeout(() => {
          setAutoSaveStatus("idle");
          autoSaveStatusTimeoutRef.current = null;
        }, 2000);
      } catch {
        setAutoSaveStatus("idle");
      } finally {
        isAutoSavingRef.current = false;
        autoSaveTimeoutRef.current = null;
      }
    }, 1500);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
    };
  }, [mode, description, onAutoSaveDescription, isActive]);

  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
      if (autoSaveStatusTimeoutRef.current) {
        clearTimeout(autoSaveStatusTimeoutRef.current);
      }
    };
  }, []);

  // Close refine menu when clicking outside
  useEffect(() => {
    if (!isRefineMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (refineMenuRef.current && !refineMenuRef.current.contains(e.target as Node)) {
        setIsRefineMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isRefineMenuOpen]);

  // Handle paste for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file && ALLOWED_IMAGE_TYPES.includes(file.type)) {
          e.preventDefault();
          onImagesChange([
            ...pendingImages,
            { file, previewUrl: URL.createObjectURL(file) },
          ]);
          return;
        }
      }
    }
  }, [pendingImages, onImagesChange]);

  // Handle file drop for images
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
        onImagesChange([
          ...pendingImages,
          { file, previewUrl: URL.createObjectURL(file) },
        ]);
        return;
      }
    }
  }, [pendingImages, onImagesChange]);

  const removeImage = useCallback((index: number) => {
    const removed = pendingImages[index];
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    onImagesChange(pendingImages.filter((_, i) => i !== index));
  }, [pendingImages, onImagesChange]);

  const toggleDep = useCallback((id: string) => {
    onDependenciesChange(
      dependencies.includes(id) ? dependencies.filter((d) => d !== id) : [...dependencies, id],
    );
  }, [dependencies, onDependenciesChange]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  // Auto-resize textarea
  const handleDescriptionInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onDescriptionChange(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [onDescriptionChange]);

  const handleToggleDescriptionExpand = useCallback(() => {
    setIsDescriptionExpanded((prev) => !prev);
  }, []);

  const handleDescriptionFullscreenKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isDescriptionExpanded || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setIsDescriptionExpanded(false);
  }, [isDescriptionExpanded]);

  // AI Refinement handler
  const handleRefine = useCallback(async (type: RefinementType) => {
    const trimmed = description.trim();
    if (!trimmed || isRefining) return;

    setIsRefining(true);
    try {
      const refined = await refineText(trimmed, type, projectId);
      onDescriptionChange(refined);
      setIsRefineMenuOpen(false);
      addToast(t("taskForm.descriptionRefinedToast", "Description refined with AI"), "success");
      if (descTextareaRef.current) {
        descTextareaRef.current.style.height = "auto";
        descTextareaRef.current.style.height = descTextareaRef.current.scrollHeight + "px";
      }
    } catch (err) {
      const errorMessage = getRefineErrorMessage(err);
      addToast(errorMessage, "error");
    } finally {
      setIsRefining(false);
    }
  }, [description, isRefining, addToast, onDescriptionChange, projectId]);

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

  // U6/R3: the project default workflow id (preselected + "(default)" badged).
  const defaultWorkflowId = settings?.defaultWorkflowId ?? null;

  const availableDeps = tasks
    .filter((t) => !dependencies.includes(t.id))
    .sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return bNum - aNum;
    });

  const filteredDeps = depSearch
    ? availableDeps.filter((t) =>
        t.id.toLowerCase().includes(depSearch.toLowerCase()) ||
        (t.title && t.title.toLowerCase().includes(depSearch.toLowerCase())) ||
        (t.description && t.description.toLowerCase().includes(depSearch.toLowerCase()))
      )
    : availableDeps;

  return (
    <div
      className="task-form"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onPaste={handlePaste}
    >
      <div className="task-form-primary-section">
        {/* Title field (edit mode only) */}
      {mode === "edit" && onTitleChange && (
        <div className="form-group">
          <label htmlFor="task-form-title">{t("taskForm.titleLabel", "Title")}</label>
          <input
            ref={titleInputRef}
            autoFocus
            id="task-form-title"
            type="text"
            className="modal-edit-input"
            placeholder={t("taskForm.titlePlaceholder", "Task title")}
            value={title || ""}
            onChange={(e) => onTitleChange(e.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {/* Description field */}
      <div className="form-group">
        <label htmlFor="task-form-description" className="description-label-row">
          <span>{t("taskForm.descriptionLabel", "Description")}</span>
          <span
            className={`description-auto-save-status${autoSaveStatus === "idle" ? "" : " is-visible"}`}
            aria-live="polite"
          >
            {autoSaveStatus === "saving" ? t("taskForm.autoSaveSaving", "Saving...") : autoSaveStatus === "saved" ? t("taskForm.autoSaveSaved", "Saved") : ""}
          </span>
        </label>
        <div
          className={`description-with-refine${isDescriptionExpanded ? " description--fullscreen" : ""}`}
          ref={refineMenuRef}
          onKeyDown={handleDescriptionFullscreenKeyDown}
        >
          {isDescriptionExpanded && (
            <div className="description-fullscreen-header">
              <span>{t("taskForm.editingDescription", "Editing Description")}</span>
              <button
                type="button"
                className="btn btn-sm description-expand-btn"
                onClick={handleToggleDescriptionExpand}
                aria-label={t("taskForm.collapseDescription", "Collapse description")}
                title={t("taskForm.collapseDescription", "Collapse description")}
              >
                <Minimize2 size={14} />
              </button>
            </div>
          )}
          <textarea
            ref={descTextareaRef}
            autoFocus={mode === "create"}
            id="task-form-description"
            value={description}
            onChange={handleDescriptionInput}
            placeholder={t("taskForm.descriptionPlaceholder", "What needs to be done?")}
            rows={mode === "edit" ? 8 : 5}
            disabled={disabled || isRefining}
          />
          {/* Determine if refine button will be shown — controls expand button placement */}
          {(() => {
            const showRefineButton = Boolean(description.trim()) && !disabled;
            return (
              <>
                {!isDescriptionExpanded && (
                  <button
                    type="button"
                    className={`btn btn-sm description-expand-btn${showRefineButton ? " description-expand-btn--offset" : " description-expand-btn--flush"}`}
                    onClick={handleToggleDescriptionExpand}
                    aria-label={t("taskForm.expandDescription", "Expand description")}
                    title={t("taskForm.expandDescription", "Expand description")}
                  >
                    <Maximize2 size={14} />
                  </button>
                )}
                {showRefineButton && (
            <button
              type="button"
              className={`btn btn-sm refine-button ${isRefining ? "refine-button--loading" : ""}`}
              onClick={() => setIsRefineMenuOpen((prev) => !prev)}
              disabled={isRefining}
              data-testid="refine-button"
              title={t("taskForm.refineTitle", "Refine description with AI")}
            >
              <Sparkles size={12} style={{ verticalAlign: "middle" }} />
              {isRefining ? t("taskForm.refineInProgress", "Refining...") : t("taskForm.refineButton", "Refine")}
            </button>
                )}
              </>
            );
          })()}
          {isRefineMenuOpen && (
            <div
              className="refine-menu refine-menu--modal"
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="refine-menu-item" onClick={() => handleRefine("clarify")} data-testid="refine-clarify">
                <div className="refine-menu-item-title">{t("taskForm.refineClarifyTitle", "Clarify")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineClarifyDesc", "Make the description clearer and more specific")}</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("add-details")} data-testid="refine-add-details">
                <div className="refine-menu-item-title">{t("taskForm.refineAddDetailsTitle", "Add details")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineAddDetailsDesc", "Add implementation details and context")}</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("expand")} data-testid="refine-expand">
                <div className="refine-menu-item-title">{t("taskForm.refineExpandTitle", "Expand")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineExpandDesc", "Expand into a more comprehensive description")}</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("simplify")} data-testid="refine-simplify">
                <div className="refine-menu-item-title">{t("taskForm.refineSimplifyTitle", "Simplify")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineSimplifyDesc", "Simplify and make more concise")}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* AI-assisted creation actions — adjacent to description (create mode only) */}
      {mode === "create" && (onPlanningMode || onSubtaskBreakdown) && (
        <div className="task-form-description-actions" data-testid="task-form-description-actions">
          {onPlanningMode && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const trimmed = description.trim();
                if (!trimmed) {
                  addToast(t("taskForm.enterDescriptionFirst", "Enter a description first"), "error");
                  return;
                }
                onClose?.();
                onPlanningMode(trimmed);
              }}
              disabled={disabled || !description.trim()}
              data-testid="task-form-plan-button"
            >
              {t("taskForm.planButton", "Plan")}
            </button>
          )}
          {onSubtaskBreakdown && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const trimmed = description.trim();
                if (!trimmed) {
                  addToast(t("taskForm.enterDescriptionFirst", "Enter a description first"), "error");
                  return;
                }
                onClose?.();
                onSubtaskBreakdown(trimmed);
              }}
              disabled={disabled || !description.trim()}
              data-testid="task-form-subtask-button"
            >
              {t("taskForm.subtaskButton", "Subtask")}
            </button>
          )}
        </div>
      )}
      </div>

      {renderBelowPrimary}

      <button
        type="button"
        className="task-form-more-options-toggle"
        onClick={() => setShowMoreOptions((prev) => !prev)}
        aria-expanded={showMoreOptions}
        aria-controls="task-form-more-options"
        disabled={disabled}
        data-testid="task-form-more-options-toggle"
      >
        <span>{t("taskForm.moreOptions", "More options")}</span>
        {showMoreOptions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      <div
        id="task-form-more-options"
        className={`task-form-more-options${showMoreOptions ? "" : " collapsed"}`}
        aria-hidden={!showMoreOptions}
        hidden={!showMoreOptions}
        data-testid="task-form-more-options"
      >
      {/* Attachments */}
      <div className="form-group">
        <label>{t("taskForm.attachmentsLabel", "Attachments")}</label>
        {pendingImages.length > 0 && (
          <div className="inline-create-previews">
            {pendingImages.map((img, i) => (
              <div key={img.previewUrl} className="inline-create-preview">
                <img src={img.previewUrl} alt={img.file.name} />
                <button
                  type="button"
                  className="inline-create-preview-remove"
                  onClick={() => removeImage(i)}
                  disabled={disabled}
                  title={t("taskForm.removeImage", "Remove image")}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onImagesChange([
                ...pendingImages,
                { file, previewUrl: URL.createObjectURL(file) },
              ]);
              e.target.value = "";
            }
          }}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
        >
          {t("taskForm.attachScreenshot", "Attach Screenshot")}
        </button>
        <small>{t("taskForm.attachHint", "You can also paste images or drag & drop")}</small>
      </div>

      {onNodeIdChange && (
        <div className="form-group">
          <label htmlFor="task-node-select">{t("taskForm.nodeOverrideLabel", "Execution Node Override")}</label>
          <select
            id="task-node-select"
            className="select"
            value={nodeId ?? ""}
            onChange={(e) => onNodeIdChange(e.target.value || undefined)}
            disabled={disabled || nodeOverrideDisabled}
          >
            <option value="">{t("taskForm.nodeDefaultOption", "Use project default / local")}</option>
            {(nodeOptions ?? []).map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} ({getNodeStatusLabel(node.status, t)})
              </option>
            ))}
          </select>
          {(() => {
            const selectedNode = (nodeOptions ?? []).find((node) => node.id === nodeId);
            if (!selectedNode) return null;
            return (
              <div className="task-form-node-status">
                <NodeHealthDot status={selectedNode.status} showLabel />
              </div>
            );
          })()}
          <small>
            {nodeOverrideDisabledReason ?? t("taskForm.nodeOverrideHint", "Task override takes priority over project default node routing.")}
          </small>
        </div>
      )}

      {!hideDependencies && (
        <>
      {/* Dependencies */}
      <div className="form-group">
        <label>{t("taskForm.dependenciesLabel", "Dependencies")}</label>
        <div className="dep-trigger-wrap" ref={depDropdownRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDepDropdown((v) => !v)}
            disabled={disabled}
          >
            {dependencies.length > 0 ? t("taskForm.dependenciesSelected", "{{count}} selected", { count: dependencies.length }) : t("taskForm.addDependencies", "Add dependencies")}
          </button>
          {showDepDropdown && (
            <div className="dep-dropdown">
              <input
                className="dep-dropdown-search"
                placeholder={t("taskForm.searchTasksPlaceholder", "Search tasks…")}
                autoFocus
                value={depSearch}
                onChange={(e) => setDepSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              {filteredDeps.length === 0 ? (
                <div className="dep-dropdown-empty">{t("taskForm.noAvailableTasks", "No available tasks")}</div>
              ) : (
                filteredDeps.map((t) => (
                  <div
                    key={t.id}
                    className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                    onClick={() => toggleDep(t.id)}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <span className="dep-dropdown-id">{t.id}</span>
                    <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {dependencies.length > 0 && (
          <div className="selected-deps">
            {dependencies.map((depId) => (
              <span key={depId} className="dep-chip">
                {depId}
                <button
                  type="button"
                  className="dep-chip-remove"
                  onClick={() => toggleDep(depId)}
                  disabled={disabled}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
        </>
      )}

      {(onBranchChange || onBaseBranchChange || onBranchModeChange) && (
        <div className="form-group">
          <label>{t("taskForm.branchSettingsLabel", "Branch Settings")}</label>
          {onBranchModeChange ? (
            <>
              <label htmlFor="task-branch-mode" className="model-select-label">{t("taskForm.branchStrategyLabel", "Branch strategy")}</label>
              <select
                id="task-branch-mode"
                className="input"
                value={branchMode ?? "project-default"}
                onChange={(event) => onBranchModeChange(event.target.value as BranchSelectionMode)}
                disabled={disabled}
              >
                <option value="project-default">{t("taskForm.branchModeProjectDefault", "Use project/default branch")}</option>
                <option value="auto-new">{t("taskForm.branchModeAutoNew", "Create auto-named branch per task")}</option>
                <option value="existing">{t("taskForm.branchModeExisting", "Use existing branch")}</option>
                <option value="custom-new">{t("taskForm.branchModeCustomNew", "Create custom new branch")}</option>
                <option value="shared-group">{t("taskForm.branchModeSharedGroup", "Merge into a shared feature branch")}</option>
              </select>
            </>
          ) : null}
          {onBranchChange && (!onBranchModeChange || branchMode === "existing" || branchMode === "custom-new" || branchMode === "shared-group") && (
            <>
              <label htmlFor="task-working-branch" className="model-select-label">
                {branchMode === "shared-group" ? t("taskForm.sharedFeatureBranchLabel", "Shared feature branch") : (onBranchModeChange ? t("taskForm.branchNameLabel", "Branch name") : t("taskForm.workingBranchLabel", "Working branch"))}
              </label>
              <input
                id="task-working-branch"
                className="input"
                value={branch || ""}
                onChange={(e) => onBranchChange(e.target.value)}
                placeholder={branchMode === "shared-group" ? t("taskForm.sharedBranchPlaceholder", "e.g. clionboarding") : t("taskForm.branchPlaceholder", "e.g. feature/my-task")}
                disabled={disabled}
              />
            </>
          )}
          {onBaseBranchChange && (
            <>
              <label htmlFor="task-base-branch" className="model-select-label">{t("taskForm.baseBranchLabel", "Merge target / base branch")}</label>
              {(() => {
                const currentValue = baseBranch || "";
                const valueIsKnown = currentValue.length > 0 && baseBranchOptions.includes(currentValue);
                const isCustomMode = baseBranchCustomMode || (currentValue.length > 0 && !valueIsKnown) || baseBranchOptions.length === 0;
                if (isCustomMode) {
                  return (
                    <div className="form-inline-group">
                      <input
                        id="task-base-branch"
                        className="input"
                        value={currentValue}
                        onChange={(e) => onBaseBranchChange(e.target.value)}
                        placeholder={t("taskForm.baseBranchPlaceholder", "e.g. main")}
                        disabled={disabled}
                        data-testid="task-base-branch-custom-input"
                      />
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          setBaseBranchCustomMode(false);
                          onBaseBranchChange("");
                        }}
                        disabled={disabled}
                        data-testid="task-base-branch-use-dropdown"
                      >
                        {t("taskForm.useDropdown", "Use dropdown")}
                      </button>
                    </div>
                  );
                }

                return (
                  <select
                    id="task-base-branch"
                    className="select"
                    value={currentValue}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === CUSTOM_BRANCH_OPTION) {
                        setBaseBranchCustomMode(true);
                        return;
                      }
                      onBaseBranchChange(next === DEFAULT_BRANCH_OPTION ? "" : next);
                    }}
                    disabled={disabled}
                    data-testid="task-base-branch-select"
                  >
                    <option value={DEFAULT_BRANCH_OPTION}>{t("taskForm.baseBranchDefault", "(default / project branch)")}</option>
                    {baseBranchOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    <option value={CUSTOM_BRANCH_OPTION}>{t("taskForm.baseBranchCustom", "Custom…")}</option>
                  </select>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Model Selection */}
      <div className="form-group">
        <label>{t("taskForm.modelConfigLabel", "Model Configuration")}</label>
        {onPriorityChange && (
          <div className="model-select-row">
            <label htmlFor="task-priority" className="model-select-label">{t("taskForm.priorityLabel", "Priority")}</label>
            <select
              id="task-priority"
              data-testid="task-priority-select"
              value={priority ?? DEFAULT_TASK_PRIORITY}
              onChange={(e) => onPriorityChange(e.target.value as TaskPriority)}
              disabled={disabled}
            >
              {TASK_PRIORITIES.map((taskPriority) => (
                <option key={taskPriority} value={taskPriority}>
                  {t(`taskForm.priority_${taskPriority}`, taskPriority[0].toUpperCase() + taskPriority.slice(1))}
                </option>
              ))}
            </select>
          </div>
        )}
        {onExecutionModeChange && executionMode !== undefined && (
          <div className="model-select-row">
            <label htmlFor="task-execution-mode" className="model-select-label">{t("taskForm.executionModeLabel", "Execution mode")}</label>
            <select
              id="task-execution-mode"
              data-testid="task-form-execution-mode-select"
              value={executionMode}
              onChange={(e) => onExecutionModeChange(e.target.value as TaskExecutionModeSelection)}
              disabled={disabled}
            >
              <option value="standard">{t("taskForm.executionModeStandard", "Standard")}</option>
              <option value="fast">{t("taskForm.executionModeFast", "Fast")}</option>
            </select>
          </div>
        )}
        {modelsLoading ? (
          <div className="model-selector-loading">{t("taskForm.loadingModels", "Loading models…")}</div>
        ) : availableModels.length === 0 ? (
          <small>{t("taskForm.noModelsAvailable", "No models available. Configure authentication in Settings.")}</small>
        ) : (
          <>
            <div className="model-select-row">
              <label htmlFor="model-preset" className="model-select-label">{t("taskForm.presetLabel", "Preset")}</label>
              <select
                id="model-preset"
                value={presetMode === "preset" ? selectedPresetId : presetMode}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "default") {
                    onPresetModeChange("default");
                    onSelectedPresetIdChange("");
                    onExecutorModelChange("");
                    onValidatorModelChange("");
                    return;
                  }
                  if (value === "custom") {
                    onPresetModeChange("custom");
                    onSelectedPresetIdChange("");
                    return;
                  }
                  const preset = availablePresets.find((entry) => entry.id === value);
                  const selection = applyPresetToSelection(preset);
                  onPresetModeChange("preset");
                  onSelectedPresetIdChange(value);
                  onExecutorModelChange(selection.executorValue);
                  onValidatorModelChange(selection.validatorValue);
                }}
                disabled={disabled}
              >
                <option value="default">{t("taskForm.presetUseDefault", "Use default")}</option>
                {availablePresets.length > 0 ? <option disabled>{PRESET_OPTION_SEPARATOR}</option> : null}
                {availablePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.name}</option>
                ))}
                <option value="custom">{t("taskForm.presetCustom", "Custom")}</option>
              </select>
            </div>
            {presetMode === "preset" && selectedPreset ? (
              <small>{t("taskForm.usingPreset", "Using preset: {{name}}", { name: selectedPreset.name })}</small>
            ) : null}
            {presetMode === "preset" ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onPresetModeChange("custom")}
                disabled={disabled}
              >
                {t("taskForm.overridePreset", "Override")}
              </button>
            ) : null}
            <div className="model-select-row">
              <label htmlFor="executor-model" className="model-select-label">{t("taskForm.executorLabel", "Executor")}</label>
              <CustomModelDropdown
                id="executor-model"
                label={t("taskForm.executorModelLabel", "Executor Model")}
                value={executorModel}
                onChange={(value) => {
                  onPresetModeChange("custom");
                  onSelectedPresetIdChange("");
                  onExecutorModelChange(value);
                }}
                models={availableModels}
                disabled={disabled || presetMode === "preset"}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={handleToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={handleToggleModelFavorite}
              />
            </div>
            <div className="model-select-row">
              <label htmlFor="validator-model" className="model-select-label">{t("taskForm.reviewerLabel", "Reviewer")}</label>
              <CustomModelDropdown
                id="validator-model"
                label={t("taskForm.reviewerModelLabel", "Reviewer Model")}
                value={validatorModel}
                onChange={(value) => {
                  onPresetModeChange("custom");
                  onSelectedPresetIdChange("");
                  onValidatorModelChange(value);
                }}
                models={availableModels}
                disabled={disabled || presetMode === "preset"}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={handleToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={handleToggleModelFavorite}
              />
            </div>
            {onPlanningModelChange && (
              <div className="model-select-row">
                <label htmlFor="planning-model" className="model-select-label">{t("taskForm.planningLabel", "Planning")}</label>
                <CustomModelDropdown
                  id="planning-model"
                  label={t("taskForm.planningModelLabel", "Planning Model")}
                  value={planningModel || ""}
                  onChange={(value) => {
                    onPresetModeChange("custom");
                    onSelectedPresetIdChange("");
                    onPlanningModelChange(value);
                  }}
                  models={availableModels}
                  disabled={disabled || presetMode === "preset"}
                  favoriteProviders={favoriteProviders}
                  onToggleFavorite={handleToggleFavorite}
                  favoriteModels={favoriteModels}
                  onToggleModelFavorite={handleToggleModelFavorite}
                />
              </div>
            )}
            {onThinkingLevelChange && (
              <div className="model-select-row">
                {/* FNXC:Settings-ThinkingLevel 2026-06-19-14:55: The shared task thinking selector must expose `xhigh` so new-task and task-detail edits can request maximum reasoning effort instead of being capped at `high`. */}
                <label htmlFor="thinking-level" className="model-select-label">{t("taskForm.thinkingLabel", "Thinking")}</label>
                <select
                  id="thinking-level"
                  value={thinkingLevel || ""}
                  onChange={(e) => onThinkingLevelChange(e.target.value)}
                  disabled={disabled || presetMode === "preset"}
                >
                  <option value="">{t("taskForm.thinkingDefault", "Default ({{level}})", { level: settings?.defaultThinkingLevel ?? "off" })}</option>
                  <option value="off">{t("taskForm.thinkingOff", "Off")}</option>
                  <option value="minimal">{t("taskForm.thinkingMinimal", "Minimal")}</option>
                  <option value="low">{t("taskForm.thinkingLow", "Low")}</option>
                  <option value="medium">{t("taskForm.thinkingMedium", "Medium")}</option>
                  <option value="high">{t("taskForm.thinkingHigh", "High")}</option>
                  <option value="xhigh">{t("taskForm.thinkingXhigh", "Very High")}</option>
                </select>
              </div>
            )}
            {onReviewLevelChange && (
              <div className="model-select-row">
                <label htmlFor="review-level" className="model-select-label">{t("taskForm.reviewLabel", "Review")}</label>
                <select
                  id="review-level"
                  value={reviewLevel ?? ""}
                  onChange={(e) => onReviewLevelChange(e.target.value === "" ? undefined : parseInt(e.target.value, 10))}
                  disabled={disabled}
                >
                  <option value="">{t("taskForm.reviewDefault", "Default (Auto — triage decides)")}</option>
                  <option value="0">{t("taskForm.reviewLevel0", "0 — None")}</option>
                  <option value="1">{t("taskForm.reviewLevel1", "1 — Plan Only")}</option>
                  <option value="2">{t("taskForm.reviewLevel2", "2 — Plan and Code")}</option>
                  <option value="3">{t("taskForm.reviewLevel3", "3 — Full")}</option>
                </select>
              </div>
            )}
            {onAutoMergeChange && (
              <div className="model-select-row">
                <label htmlFor="task-automerge-select" className="model-select-label">{t("taskForm.autoMergeLabel", "Auto-merge")}</label>
                <select
                  id="task-automerge-select"
                  data-testid="task-automerge-select"
                  value={autoMerge === undefined ? "" : autoMerge ? "on" : "off"}
                  onChange={(e) => {
                    if (e.target.value === "on") return onAutoMergeChange(true);
                    if (e.target.value === "off") return onAutoMergeChange(false);
                    return onAutoMergeChange(undefined);
                  }}
                  disabled={disabled}
                >
                  <option value="">{t("taskForm.autoMergeDefault", "Default (Follow project setting)")}</option>
                  <option value="on">{t("taskForm.autoMergeEnabled", "Enabled")}</option>
                  <option value="off">{t("taskForm.autoMergeDisabled", "Disabled")}</option>
                </select>
                <small>{t("taskForm.autoMergeHint", "Default follows the project auto-merge setting.")}</small>
              </div>
            )}
          </>
        )}
      </div>

      {renderBelowModelConfiguration}

      {/* Workflow picker (U6/R3). A task picks a whole workflow at creation; the
          selection is materialized atomically server-side via `workflowId`. */}
      {onWorkflowIdChange && (
        <div className="form-group" data-testid="workflow-steps-section">
          <label htmlFor="task-workflow-select">{t("taskForm.workflowLabel", "Workflow")}</label>
          {workflowsLoading ? (
            <div className="workflow-select-loading" data-testid="task-workflow-loading">
              {t("taskForm.workflowsLoading", "Loading workflows…")}
            </div>
          ) : workflows.length === 0 ? (
            // Built-ins are always present, so an empty list means the fetch
            // failed. No editor-open prop is plumbed through TaskForm, so we
            // surface a plain-text CTA rather than inventing new prop wiring.
            <div className="workflow-select-cta" data-testid="task-workflow-cta">
              {t("taskForm.workflowsCta", "Set up workflows in the editor")}
            </div>
          ) : (
            <select
              id="task-workflow-select"
              data-testid="task-workflow-select"
              value={
                selectedWorkflowId === null
                  ? "__none__"
                  : selectedWorkflowId === undefined
                    // Inherit project default: show the default option preselected,
                    // or "No workflow" when no project default is configured.
                    ? (defaultWorkflowId ?? "__none__")
                    : selectedWorkflowId
              }
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.value;
                onWorkflowIdChange(next === "__none__" ? null : next);
              }}
            >
              {/* "No workflow" listed FIRST (maps to null → explicit opt-out). */}
              <option value="__none__">{t("taskForm.workflowNone", "No workflow")}</option>
              {/* Project default preselected + badged when configured. */}
              {defaultWorkflowId && workflows.some((w) => w.id === defaultWorkflowId) && (
                <option value={defaultWorkflowId}>
                  {`${workflows.find((w) => w.id === defaultWorkflowId)?.name ?? defaultWorkflowId} ${t("taskForm.workflowDefaultBadge", "(default)")}`}
                </option>
              )}
              {workflows
                .filter((w) => w.id !== defaultWorkflowId)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          )}
          <small className="workflow-select-help" data-testid="task-workflow-help">
            {t("taskForm.workflowHelp", "The selected workflow's steps run automatically around this task's execution.")}
          </small>
        </div>
      )}

      {(onGithubTrackingEnabledChange || onGithubRepoOverrideChange) && (
        <div className="form-group" data-testid="task-form-github-tracking">
          <label>{t("taskForm.githubTrackingLabel", "GitHub Tracking")}</label>
          {onGithubTrackingEnabledChange && (
            <label className="checkbox-label" htmlFor="task-github-tracking-enabled">
              <input
                id="task-github-tracking-enabled"
                type="checkbox"
                checked={githubTrackingEnabled === true}
                onChange={(event) => {
                  githubTrackingDefaultAppliedRef.current = true;
                  onGithubTrackingEnabledChange(event.target.checked);
                }}
                disabled={disabled}
              />
              {t("taskForm.githubTrackingEnable", "Enable GitHub issue tracking for this task")}
            </label>
          )}
          {onGithubRepoOverrideChange && (
            <>
              <label htmlFor="task-github-repo-override" className="model-select-label">{t("taskForm.githubRepoLabel", "Repository (owner/repo)")}</label>
              <input
                id="task-github-repo-override"
                className="input"
                value={githubRepoOverride || ""}
                onChange={(event) => onGithubRepoOverrideChange(event.target.value)}
                placeholder={effectiveGithubRepoDefault || "owner/repo"}
                disabled={disabled}
              />
              {githubRepoOverrideInvalid ? (
                <div className="form-error">{t("taskForm.githubRepoFormatError", "Repository must be in owner/repo format.")}</div>
              ) : null}
            </>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
