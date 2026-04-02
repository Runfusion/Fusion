import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, TaskCreateInput, ModelPreset, Settings, WorkflowStep } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment, fetchModels, fetchSettings, fetchWorkflowSteps, refineText, getRefineErrorMessage, updateGlobalSettings, type RefinementType } from "../api";
import type { ModelInfo } from "../api";
import { applyPresetToSelection, getRecommendedPresetForSize } from "../utils/modelPresets";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { Sparkles, Globe } from "lucide-react";

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[]; // for dependency selection
  onCreateTask: (input: TaskCreateInput) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
}

export function NewTaskModal({ isOpen, onClose, tasks, onCreateTask, addToast, onPlanningMode, onSubtaskBreakdown }: NewTaskModalProps) {
  const [description, setDescription] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [executorModel, setExecutorModel] = useState("");
  const [validatorModel, setValidatorModel] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetMode, setPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [hasDirtyState, setHasDirtyState] = useState(false);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [selectedWorkflowSteps, setSelectedWorkflowSteps] = useState<string[]>([]);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);

  const depDropdownRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load available models when modal opens
  useEffect(() => {
    if (isOpen) {
      setModelsLoading(true);
      fetchModels()
        .then((response) => {
          setAvailableModels(response.models);
          setFavoriteProviders(response.favoriteProviders);
        })
        .catch(() => {/* silently fail - models just won't be available */})
        .finally(() => setModelsLoading(false));
      fetchSettings()
        .then((nextSettings) => setSettings(nextSettings))
        .catch(() => setSettings(null));
      fetchWorkflowSteps()
        .then((steps) => setWorkflowSteps(steps.filter((s) => s.enabled)))
        .catch(() => setWorkflowSteps([]));
    }
  }, [isOpen]);

  // Track dirty state
  useEffect(() => {
    const isDirty = 
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      executorModel !== "" ||
      validatorModel !== "" ||
      selectedWorkflowSteps.length > 0;
    setHasDirtyState(isDirty);
  }, [description, dependencies, pendingImages, executorModel, validatorModel, selectedWorkflowSteps]);

  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);

  useEffect(() => {
    if (!isOpen || !settings?.autoSelectModelPreset) return;
    const recommended = getRecommendedPresetForSize(undefined, settings.defaultPresetBySize || {}, availablePresets);
    if (recommended) {
      const selection = applyPresetToSelection(recommended);
      setSelectedPresetId(recommended.id);
      setPresetMode("preset");
      setExecutorModel(selection.executorValue);
      setValidatorModel(selection.validatorValue);
    }
  }, [isOpen, settings, availablePresets]);

  // Auto-focus description textarea when modal opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure modal is fully rendered
      const timeoutId = setTimeout(() => {
        descTextareaRef.current?.focus();
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [isOpen]);

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
          setPendingImages((prev) => [
            ...prev,
            { file, previewUrl: URL.createObjectURL(file) },
          ]);
          return;
        }
      }
    }
  }, []);

  // Handle file drop for images
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setPendingImages((prev) => [
          ...prev,
          { file, previewUrl: URL.createObjectURL(file) },
        ]);
        return;
      }
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const toggleDep = useCallback((id: string) => {
    setDependencies((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const handleClose = useCallback(() => {
    if (hasDirtyState) {
      if (!confirm("You have unsaved changes. Discard them?")) return;
    }
    // Clean up object URLs
    pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setPendingImages([]);
    // Reset form
    setPendingImages([]);
    setDescription("");
    setDependencies([]);
    setExecutorModel("");
    setValidatorModel("");
    setSelectedPresetId("");
    setPresetMode("default");
    setSelectedWorkflowSteps([]);
    setIsRefineMenuOpen(false);
    setIsRefining(false);
    setHasDirtyState(false);
    onClose();
  }, [hasDirtyState, onClose, pendingImages]);

  const handleSubmit = useCallback(async () => {
    const trimmedDesc = description.trim();
    if (!trimmedDesc || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // Create the base task
      const executorSlashIdx = executorModel.indexOf("/");
      const validatorSlashIdx = validatorModel.indexOf("/");

      const task = await onCreateTask({
        title: undefined,
        description: trimmedDesc,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        enabledWorkflowSteps: selectedWorkflowSteps.length > 0 ? selectedWorkflowSteps : undefined,
        modelPresetId: presetMode === "preset" ? selectedPresetId || undefined : undefined,
        modelProvider: executorModel && executorSlashIdx !== -1 ? executorModel.slice(0, executorSlashIdx) : undefined,
        modelId: executorModel && executorSlashIdx !== -1 ? executorModel.slice(executorSlashIdx + 1) : undefined,
        validatorModelProvider: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(0, validatorSlashIdx) : undefined,
        validatorModelId: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(validatorSlashIdx + 1) : undefined,
      });

      // Upload pending images as attachments
      if (pendingImages.length > 0) {
        const failures: string[] = [];
        for (const img of pendingImages) {
          try {
            await uploadAttachment(task.id, img.file);
          } catch {
            failures.push(img.file.name);
          }
        }
        if (failures.length > 0) {
          addToast(`Failed to upload: ${failures.join(", ")}`, "error");
        }
      }

      // Clean up
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);
      setDescription("");
      setDependencies([]);
      setExecutorModel("");
      setValidatorModel("");
      setSelectedPresetId("");
      setPresetMode("default");
      setSelectedWorkflowSteps([]);

      addToast(`Created ${task.id}`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, dependencies, pendingImages, executorModel, validatorModel, isSubmitting, onCreateTask, addToast, onClose]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !showDepDropdown) {
      e.preventDefault();
      handleClose();
    }
  }, [handleClose, showDepDropdown]);

  // Auto-resize textarea
  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // AI Refinement handler
  const handleRefine = useCallback(async (type: RefinementType) => {
    const trimmed = description.trim();
    if (!trimmed || isRefining) return;

    setIsRefining(true);
    try {
      const refined = await refineText(trimmed, type);
      setDescription(refined);
      setIsRefineMenuOpen(false);
      addToast("Description refined with AI", "success");
      // Auto-resize textarea after content update
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
  }, [description, isRefining, addToast]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites });
    } catch {
      // Revert on error
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders]);

  if (!isOpen) return null;

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
    <div className="modal-overlay open" onClick={handleClose} onKeyDown={handleKeyDown}>
      <div 
        className="modal modal-lg new-task-modal" 
        onClick={(e) => e.stopPropagation()}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onPaste={handlePaste}
      >
        <div className="modal-header">
          <h3>New Task</h3>
          <button className="modal-close" onClick={handleClose} disabled={isSubmitting}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          {/* Description field */}
          <div className="form-group">
            <label htmlFor="new-task-description">Description</label>
            <div className="description-with-refine" ref={refineMenuRef}>
              <textarea
                ref={descTextareaRef}
                id="new-task-description"
                value={description}
                onChange={handleDescriptionChange}
                placeholder="What needs to be done?"
                rows={3}
                disabled={isSubmitting || isRefining}
              />
              {description.trim() && !isSubmitting && (
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
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("clarify")}
                    data-testid="refine-clarify"
                  >
                    <div className="refine-menu-item-title">Clarify</div>
                    <div className="refine-menu-item-desc">Make the description clearer and more specific</div>
                  </div>
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("add-details")}
                    data-testid="refine-add-details"
                  >
                    <div className="refine-menu-item-title">Add details</div>
                    <div className="refine-menu-item-desc">Add implementation details and context</div>
                  </div>
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("expand")}
                    data-testid="refine-expand"
                  >
                    <div className="refine-menu-item-title">Expand</div>
                    <div className="refine-menu-item-desc">Expand into a more comprehensive description</div>
                  </div>
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("simplify")}
                    data-testid="refine-simplify"
                  >
                    <div className="refine-menu-item-title">Simplify</div>
                    <div className="refine-menu-item-desc">Simplify and make more concise</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Dependencies */}
          <div className="form-group">
            <label>Dependencies</label>
            <div className="dep-trigger-wrap" ref={depDropdownRef}>
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={() => setShowDepDropdown((v) => !v)}
                disabled={isSubmitting}
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
                      disabled={isSubmitting}
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
                        setPresetMode("default");
                        setSelectedPresetId("");
                        setExecutorModel("");
                        setValidatorModel("");
                        return;
                      }
                      if (value === "custom") {
                        setPresetMode("custom");
                        setSelectedPresetId("");
                        return;
                      }
                      const preset = availablePresets.find((entry) => entry.id === value);
                      const selection = applyPresetToSelection(preset);
                      setPresetMode("preset");
                      setSelectedPresetId(value);
                      setExecutorModel(selection.executorValue);
                      setValidatorModel(selection.validatorValue);
                    }}
                    disabled={isSubmitting}
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
                    onClick={() => setPresetMode("custom")}
                    disabled={isSubmitting}
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
                      setPresetMode("custom");
                      setSelectedPresetId("");
                      setExecutorModel(value);
                    }}
                    models={availableModels}
                    disabled={isSubmitting || presetMode === "preset"}
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                  />
                </div>
                <div className="model-select-row">
                  <label htmlFor="validator-model" className="model-select-label">Validator</label>
                  <CustomModelDropdown
                    id="validator-model"
                    label="Validator Model"
                    value={validatorModel}
                    onChange={(value) => {
                      setPresetMode("custom");
                      setSelectedPresetId("");
                      setValidatorModel(value);
                    }}
                    models={availableModels}
                    disabled={isSubmitting || presetMode === "preset"}
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
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
                      setSelectedWorkflowSteps((prev) =>
                        e.target.checked
                          ? [...prev, step.id]
                          : prev.filter((id) => id !== step.id)
                      );
                    }}
                    disabled={isSubmitting}
                    style={{ marginTop: "2px" }}
                  />
                  <div>
                    <span style={{ fontWeight: 500, fontSize: "13px" }}>{step.name}</span>
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
                    setSelectedWorkflowSteps((prev) =>
                      e.target.checked
                        ? [...prev, "browser-verification"]
                        : prev.filter((id) => id !== "browser-verification")
                    );
                  }}
                  disabled={isSubmitting}
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
          </div>

          <div className="form-group">
            <label>AI-assisted creation</label>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const trimmed = description.trim();
                  if (!trimmed) {
                    addToast("Enter a description first", "error");
                    return;
                  }
                  handleClose();
                  onPlanningMode?.(trimmed);
                }}
                disabled={isSubmitting || !description.trim()}
              >
                Plan
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const trimmed = description.trim();
                  if (!trimmed) {
                    addToast("Enter a description first", "error");
                    return;
                  }
                  handleClose();
                  onSubtaskBreakdown?.(trimmed);
                }}
                disabled={isSubmitting || !description.trim()}
              >
                Subtask
              </button>
            </div>
            <small>Use Plan for clarifying questions or Subtask to split the work into editable child tasks.</small>
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
                      disabled={isSubmitting}
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
                  setPendingImages((prev) => [
                    ...prev,
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
              disabled={isSubmitting}
            >
              Attach Screenshot
            </button>
            <small>You can also paste images or drag & drop</small>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!description.trim() || isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
