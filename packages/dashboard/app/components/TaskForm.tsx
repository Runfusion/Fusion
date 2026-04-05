import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, ModelPreset, Settings, WorkflowStep } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchModels, fetchSettings, fetchWorkflowSteps, refineText, getRefineErrorMessage, updateGlobalSettings, type RefinementType, type ModelInfo } from "../api";
import { applyPresetToSelection, getRecommendedPresetForSize } from "../utils/modelPresets";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { Sparkles, Globe, ChevronUp, ChevronDown, X } from "lucide-react";

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
  presetMode: "default" | "preset" | "custom";
  onPresetModeChange: (mode: "default" | "preset" | "custom") => void;
  selectedPresetId: string;
  onSelectedPresetIdChange: (id: string) => void;

  // Workflow steps
  selectedWorkflowSteps: string[];
  onWorkflowStepsChange: (steps: string[]) => void;

  // Attachments
  pendingImages: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;

  // Context
  tasks: Task[];
  projectId?: string;
  disabled?: boolean;
  addToast: (message: string, type?: ToastType) => void;
  isActive?: boolean;

  // AI-assisted creation callbacks (create mode only)
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
  onClose?: () => void;
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
  presetMode,
  onPresetModeChange,
  selectedPresetId,
  onSelectedPresetIdChange,
  selectedWorkflowSteps,
  onWorkflowStepsChange,
  pendingImages,
  onImagesChange,
  tasks,
  projectId,
  disabled = false,
  addToast,
  isActive = true,
  onPlanningMode,
  onSubtaskBreakdown,
  onClose,
}: TaskFormProps) {
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);

  const depDropdownRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Auto-focus description (create) or title (edit) when active
  useEffect(() => {
    if (!isActive) return;
    const timeoutId = setTimeout(() => {
      if (mode === "edit" && titleInputRef.current) {
        titleInputRef.current.focus();
        titleInputRef.current.select();
      } else if (mode === "create" && descTextareaRef.current) {
        descTextareaRef.current.focus();
      }
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [isActive, mode]);

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

  // AI Refinement handler
  const handleRefine = useCallback(async (type: RefinementType) => {
    const trimmed = description.trim();
    if (!trimmed || isRefining) return;

    setIsRefining(true);
    try {
      const refined = await refineText(trimmed, type);
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
  }, [description, isRefining, addToast, onDescriptionChange]);

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

  // Build a lookup for step names (includes both fetched steps and built-in browser-verification)
  const workflowStepLookup = new Map<string, { name: string; description: string }>();
  for (const step of workflowSteps) {
    workflowStepLookup.set(step.id, { name: step.name, description: step.description });
  }
  workflowStepLookup.set("browser-verification", {
    name: "Browser Verification",
    description: "Verify web application functionality using browser automation (agent-browser)",
  });

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
      {/* Title field (edit mode only) */}
      {mode === "edit" && onTitleChange && (
        <div className="form-group">
          <label htmlFor="task-form-title">Title</label>
          <input
            ref={titleInputRef}
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
        <label htmlFor="task-form-description">Description</label>
        <div className="description-with-refine" ref={refineMenuRef}>
          <textarea
            ref={descTextareaRef}
            id="task-form-description"
            value={description}
            onChange={handleDescriptionInput}
            placeholder="What needs to be done?"
            rows={3}
            disabled={disabled || isRefining}
          />
          {description.trim() && !disabled && (
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
          <label
            key="browser-verification"
            className="checkbox-label"
            style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
            data-testid="browser-verification-checkbox"
          >
            <input
              type="checkbox"
              checked={selectedWorkflowSteps.includes("browser-verification")}
              onChange={(e) => {
                onWorkflowStepsChange(
                  e.target.checked
                    ? [...selectedWorkflowSteps, "browser-verification"]
                    : selectedWorkflowSteps.filter((id) => id !== "browser-verification")
                );
              }}
              disabled={disabled}
              style={{ marginTop: "2px" }}
            />
            <div>
              <span style={{ fontWeight: 500, fontSize: "13px" }}>
                <Globe size={14} style={{ verticalAlign: "middle", marginRight: "4px" }} />
                Browser Verification
              </span>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                Verify web application functionality using browser automation (agent-browser)
              </div>
            </div>
          </label>
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
    </div>
  );
}
