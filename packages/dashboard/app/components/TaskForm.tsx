import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, ModelPreset, Settings, WorkflowStep } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchModels, fetchSettings, fetchWorkflowSteps, refineText, getRefineErrorMessage, updateGlobalSettings, type RefinementType, type ModelInfo } from "../api";
import { applyPresetToSelection, getRecommendedPresetForSize } from "../utils/modelPresets";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { Sparkles, ChevronUp, ChevronDown, X, Maximize2, Minimize2 } from "lucide-react";

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface PendingImage {
  file: File;
  previewUrl: string;
}

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

  // Model configuration
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

  // Workflow steps
  selectedWorkflowSteps: string[];
  onWorkflowStepsChange: (steps: string[]) => void;
  /** Callback fired when defaultOn steps have been preselected (create mode). Parent can use this to distinguish "no selection yet" from "user explicitly cleared". */
  onDefaultOnApplied?: (stepIds: string[]) => void;

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

  // AI-assisted creation callbacks (create mode only)
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
  onClose?: () => void;

  /** Optional content to render between the primary section and the "More options" toggle. */
  renderBelowPrimary?: React.ReactNode;
  /** When true, skip rendering the Dependencies form-group inside "More options". Use when the parent renders its own dependency UI via renderBelowPrimary. */
  hideDependencies?: boolean;
}

export function TaskForm({
  mode,
  description,
  onDescriptionChange,
  title,
  onTitleChange,
  dependencies,
  onDependenciesChange,
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
  selectedWorkflowSteps,
  onWorkflowStepsChange,
  onDefaultOnApplied,
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
  hideDependencies,
}: TaskFormProps) {
  const hasInitialMoreOptions =
    (hideDependencies ? false : dependencies.length > 0) ||
    pendingImages.length > 0 ||
    selectedWorkflowSteps.length > 0 ||
    presetMode !== "default" ||
    executorModel !== "" ||
    validatorModel !== "" ||
    (planningModel || "") !== "" ||
    (thinkingLevel || "") !== "";

  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(hasInitialMoreOptions);
  const [depSearch, setDepSearch] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

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
    fetchWorkflowSteps(projectId)
      .then((steps) => setWorkflowSteps(steps.filter((s) => s.enabled)))
      .catch(() => setWorkflowSteps([]));
  }, [isActive, projectId]);

  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);
  const hasMoreOptionSelections =
    (hideDependencies ? false : dependencies.length > 0) ||
    pendingImages.length > 0 ||
    selectedWorkflowSteps.length > 0 ||
    presetMode !== "default" ||
    executorModel !== "" ||
    validatorModel !== "" ||
    (planningModel || "") !== "" ||
    (thinkingLevel || "") !== "";

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

  // Auto-select defaultOn workflow steps (create mode, once per activation)
  const defaultOnAppliedRef = useRef(false);
  useEffect(() => {
    if (mode !== "create" || !isActive) return;
    if (defaultOnAppliedRef.current) return;
    if (workflowSteps.length === 0) return;

    const defaultOnSteps = workflowSteps.filter((s) => s.defaultOn);
    if (defaultOnSteps.length === 0) return;

    defaultOnAppliedRef.current = true;
    const stepIds = defaultOnSteps.map((s) => s.id);
    onWorkflowStepsChange(stepIds);
    onDefaultOnApplied?.(stepIds);
  }, [mode, isActive, workflowSteps]);

  // Reset defaultOn tracking when form deactivates
  useEffect(() => {
    if (!isActive) {
      defaultOnAppliedRef.current = false;
    }
  }, [isActive]);

  // Auto-expand advanced options when non-default values are present.
  useEffect(() => {
    if (hasMoreOptionSelections && !hadMoreOptionSelectionsRef.current) {
      setShowMoreOptions(true);
    }
    hadMoreOptionSelectionsRef.current = hasMoreOptionSelections;
  }, [hasMoreOptionSelections]);

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
      addToast("Description refined with AI", "success");
      if (descTextareaRef.current) {
        descTextareaRef.current.style.height = "auto";
        descTextareaRef.current.style.height = descTextareaRef.current.scrollHeight + "px";
      }
    } catch (err: any) {
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

  // Workflow step reorder helpers
  const moveWorkflowStepUp = useCallback((index: number) => {
    if (index <= 0) return;
    const updated = [...selectedWorkflowSteps];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    onWorkflowStepsChange(updated);
  }, [selectedWorkflowSteps, onWorkflowStepsChange]);

  const moveWorkflowStepDown = useCallback((index: number) => {
    if (index >= selectedWorkflowSteps.length - 1) return;
    const updated = [...selectedWorkflowSteps];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    onWorkflowStepsChange(updated);
  }, [selectedWorkflowSteps, onWorkflowStepsChange]);

  const removeWorkflowStep = useCallback((stepId: string) => {
    onWorkflowStepsChange(selectedWorkflowSteps.filter((id) => id !== stepId));
  }, [selectedWorkflowSteps, onWorkflowStepsChange]);

  // Build a lookup for step names.
  const workflowStepLookup = new Map<string, { name: string; description: string }>();
  for (const step of workflowSteps) {
    workflowStepLookup.set(step.id, { name: step.name, description: step.description });
  }

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
          <label htmlFor="task-form-title">Title</label>
          <input
            ref={titleInputRef}
            autoFocus
            id="task-form-title"
            type="text"
            className="modal-edit-input"
            placeholder="Task title"
            value={title || ""}
            onChange={(e) => onTitleChange(e.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {/* Description field */}
      <div className="form-group">
        <label htmlFor="task-form-description" className="description-label-row">
          <span>Description</span>
          <span
            className={`description-auto-save-status${autoSaveStatus === "idle" ? "" : " is-visible"}`}
            aria-live="polite"
          >
            {autoSaveStatus === "saving" ? "Saving..." : autoSaveStatus === "saved" ? "Saved" : ""}
          </span>
        </label>
        <div
          className={`description-with-refine${isDescriptionExpanded ? " description--fullscreen" : ""}`}
          ref={refineMenuRef}
          onKeyDown={handleDescriptionFullscreenKeyDown}
        >
          {isDescriptionExpanded && (
            <div className="description-fullscreen-header">
              <span>Editing Description</span>
              <button
                type="button"
                className="btn btn-sm description-expand-btn"
                onClick={handleToggleDescriptionExpand}
                aria-label="Collapse description"
                title="Collapse description"
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
            placeholder="What needs to be done?"
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
                    aria-label="Expand description"
                    title="Expand description"
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
              title="Refine description with AI"
            >
              <Sparkles size={12} style={{ verticalAlign: "middle" }} />
              {isRefining ? "Refining..." : "Refine"}
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
                <div className="refine-menu-item-title">Clarify</div>
                <div className="refine-menu-item-desc">Make the description clearer and more specific</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("add-details")} data-testid="refine-add-details">
                <div className="refine-menu-item-title">Add details</div>
                <div className="refine-menu-item-desc">Add implementation details and context</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("expand")} data-testid="refine-expand">
                <div className="refine-menu-item-title">Expand</div>
                <div className="refine-menu-item-desc">Expand into a more comprehensive description</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("simplify")} data-testid="refine-simplify">
                <div className="refine-menu-item-title">Simplify</div>
                <div className="refine-menu-item-desc">Simplify and make more concise</div>
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
                  addToast("Enter a description first", "error");
                  return;
                }
                onClose?.();
                onPlanningMode(trimmed);
              }}
              disabled={disabled || !description.trim()}
              data-testid="task-form-plan-button"
            >
              Plan
            </button>
          )}
          {onSubtaskBreakdown && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const trimmed = description.trim();
                if (!trimmed) {
                  addToast("Enter a description first", "error");
                  return;
                }
                onClose?.();
                onSubtaskBreakdown(trimmed);
              }}
              disabled={disabled || !description.trim()}
              data-testid="task-form-subtask-button"
            >
              Subtask
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
        <span>More options</span>
        {showMoreOptions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      <div
        id="task-form-more-options"
        className={`task-form-more-options${showMoreOptions ? "" : " collapsed"}`}
        aria-hidden={!showMoreOptions}
        data-testid="task-form-more-options"
      >
      {/* Attachments */}
      <div className="form-group">
        <label>Attachments</label>
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
                  title="Remove image"
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
          Attach Screenshot
        </button>
        <small>You can also paste images or drag & drop</small>
      </div>

      {!hideDependencies && (
        <>
      {/* Dependencies */}
      <div className="form-group">
        <label>Dependencies</label>
        <div className="dep-trigger-wrap" ref={depDropdownRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDepDropdown((v) => !v)}
            disabled={disabled}
          >
            {dependencies.length > 0 ? `${dependencies.length} selected` : "Add dependencies"}
          </button>
          {showDepDropdown && (
            <div className="dep-dropdown">
              <input
                className="dep-dropdown-search"
                placeholder="Search tasks…"
                autoFocus
                value={depSearch}
                onChange={(e) => setDepSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              {filteredDeps.length === 0 ? (
                <div className="dep-dropdown-empty">No available tasks</div>
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

      {/* Model Selection */}
      <div className="form-group">
        <label>Model Configuration</label>
        {modelsLoading ? (
          <div className="model-selector-loading">Loading models…</div>
        ) : availableModels.length === 0 ? (
          <small>No models available. Configure authentication in Settings.</small>
        ) : (
          <>
            <div className="model-select-row">
              <label htmlFor="model-preset" className="model-select-label">Preset</label>
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
                <option value="default">Use default</option>
                {availablePresets.length > 0 ? <option disabled>──────────</option> : null}
                {availablePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.name}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </div>
            {presetMode === "preset" && selectedPreset ? (
              <small>Using preset: {selectedPreset.name}</small>
            ) : null}
            {presetMode === "preset" ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onPresetModeChange("custom")}
                disabled={disabled}
              >
                Override
              </button>
            ) : null}
            <div className="model-select-row">
              <label htmlFor="executor-model" className="model-select-label">Executor</label>
              <CustomModelDropdown
                id="executor-model"
                label="Executor Model"
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
              <label htmlFor="validator-model" className="model-select-label">Validator</label>
              <CustomModelDropdown
                id="validator-model"
                label="Validator Model"
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
                <label htmlFor="planning-model" className="model-select-label">Planning</label>
                <CustomModelDropdown
                  id="planning-model"
                  label="Planning Model"
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
                <label htmlFor="thinking-level" className="model-select-label">Thinking</label>
                <select
                  id="thinking-level"
                  value={thinkingLevel || ""}
                  onChange={(e) => onThinkingLevelChange(e.target.value)}
                  disabled={disabled || presetMode === "preset"}
                >
                  <option value="">Default ({settings?.defaultThinkingLevel ?? "off"})</option>
                  <option value="off">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            )}
          </>
        )}
      </div>

      {/* Workflow Steps */}
      <div className="form-group" data-testid="workflow-steps-section">
        <label>Workflow Steps</label>
        <small style={{ marginBottom: "8px", display: "block" }}>
          Select steps to run after task implementation completes
        </small>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {workflowSteps.length > 0 && workflowSteps.map((step) => (
            <label
              key={step.id}
              className="checkbox-label"
              style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              data-testid={`workflow-step-checkbox-${step.id}`}
            >
              <input
                type="checkbox"
                checked={selectedWorkflowSteps.includes(step.id)}
                onChange={(e) => {
                  onWorkflowStepsChange(
                    e.target.checked
                      ? [...selectedWorkflowSteps, step.id]
                      : selectedWorkflowSteps.filter((id) => id !== step.id)
                  );
                }}
                disabled={disabled}
                style={{ marginTop: "2px" }}
              />
              <div>
                <span style={{ fontWeight: 500, fontSize: "13px" }}>
                  {step.name}
                  <span
                    style={{
                      marginLeft: "6px",
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "4px",
                      background: (step.phase || "pre-merge") === "post-merge"
                        ? "rgba(139, 92, 246, 0.15)"
                        : "rgba(59, 130, 246, 0.15)",
                      color: (step.phase || "pre-merge") === "post-merge"
                        ? "#8b5cf6"
                        : "#3b82f6",
                    }}
                    data-testid={`workflow-step-phase-${step.id}`}
                  >
                    {(step.phase || "pre-merge") === "post-merge" ? "Post-merge" : "Pre-merge"}
                  </span>
                </span>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                  {step.description}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Selected steps — execution order with reorder controls */}
        {selectedWorkflowSteps.length > 1 && (
          <div className="workflow-step-order" data-testid="workflow-step-order">
            <small className="workflow-step-order-label">Execution order:</small>
            {selectedWorkflowSteps.map((stepId, index) => {
              const stepInfo = workflowStepLookup.get(stepId);
              return (
                <div key={stepId} className="workflow-step-order-item" data-testid={`workflow-step-order-item-${stepId}`}>
                  <span className="workflow-step-order-number">{index + 1}</span>
                  <span className="workflow-step-order-name">{stepInfo?.name || stepId}</span>
                  <div className="workflow-step-order-actions">
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveWorkflowStepUp(index)}
                      disabled={disabled || index === 0}
                      data-testid={`workflow-step-move-up-${stepId}`}
                      title="Move up"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveWorkflowStepDown(index)}
                      disabled={disabled || index === selectedWorkflowSteps.length - 1}
                      data-testid={`workflow-step-move-down-${stepId}`}
                      title="Move down"
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => removeWorkflowStep(stepId)}
                      disabled={disabled}
                      data-testid={`workflow-step-remove-${stepId}`}
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
