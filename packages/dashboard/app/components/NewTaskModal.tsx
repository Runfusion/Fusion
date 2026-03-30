import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, TaskCreateInput } from "@kb/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment, fetchModels, updateTask } from "../api";
import type { ModelInfo } from "../api";
import { filterModels } from "../utils/modelFilter";

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
}

/**
 * Simplified ModelCombobox for the New Task modal.
 * Reuses the same interaction pattern as ModelSelectorTab.
 */
function ModelCombobox({
  value,
  onChange,
  models,
  disabled = false,
  placeholder = "Select a model…",
  label,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  models: ModelInfo[];
  disabled?: boolean;
  placeholder?: string;
  label: string;
  id: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilter, setLocalFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredModels = filterModels(models, localFilter);

  const modelsByProvider = filteredModels.reduce<Record<string, ModelInfo[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  const optionsList = [
    { type: "default" as const, value: "", label: "Use default" },
    ...Object.entries(modelsByProvider).flatMap(([provider, providerModels]) => [
      { type: "provider" as const, value: `__group_${provider}`, label: provider, provider },
      ...providerModels.map((m) => ({ 
        type: "model" as const, 
        value: `${m.provider}/${m.id}`, 
        label: m.name,
        provider: m.provider 
      })),
    ]),
  ];

  const selectedDisplayText = !value 
    ? "Use default" 
    : (() => {
        const slashIdx = value.indexOf("/");
        if (slashIdx === -1) return value;
        const provider = value.slice(0, slashIdx);
        const modelId = value.slice(slashIdx + 1);
        const model = models.find((m) => m.provider === provider && m.id === modelId);
        return model?.name || value;
      })();

  const currentValueIndex = optionsList.findIndex((opt) => opt.value === value);

  useEffect(() => {
    if (isOpen) {
      const selectableIndex = optionsList.findIndex((opt, idx) => 
        idx >= (currentValueIndex >= 0 ? currentValueIndex : 0) && opt.type !== "provider"
      );
      setHighlightedIndex(selectableIndex >= 0 ? selectableIndex : 0);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isOpen, optionsList, currentValueIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setLocalFilter("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          let nextIndex = highlightedIndex;
          for (let i = 1; i <= optionsList.length; i++) {
            const idx = (highlightedIndex + i) % optionsList.length;
            if (optionsList[idx]?.type !== "provider") {
              nextIndex = idx;
              break;
            }
          }
          setHighlightedIndex(nextIndex);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (isOpen) {
          let prevIndex = highlightedIndex;
          for (let i = 1; i <= optionsList.length; i++) {
            const idx = (highlightedIndex - i + optionsList.length) % optionsList.length;
            if (optionsList[idx]?.type !== "provider") {
              prevIndex = idx;
              break;
            }
          }
          setHighlightedIndex(prevIndex);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (isOpen) {
          const option = optionsList[highlightedIndex];
          if (option && option.type !== "provider") {
            onChange(option.value);
            setIsOpen(false);
            setLocalFilter("");
          }
        } else {
          setIsOpen(true);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setLocalFilter("");
        break;
      case "Tab":
        if (isOpen) {
          setIsOpen(false);
          setLocalFilter("");
        }
        break;
    }
  }, [isOpen, highlightedIndex, optionsList, onChange]);

  const handleSelect = useCallback((optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setLocalFilter("");
  }, [onChange]);

  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl && typeof highlightedEl.scrollIntoView === "function") {
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, isOpen]);

  return (
    <div ref={containerRef} className="model-combobox" onKeyDown={handleKeyDown}>
      <button
        type="button"
        id={id}
        className="model-combobox-trigger"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
      >
        <span className="model-combobox-trigger-text">{selectedDisplayText}</span>
        <span className="model-combobox-trigger-arrow">▼</span>
      </button>

      {isOpen && (
        <div className="model-combobox-dropdown" role="listbox">
          <div className="model-combobox-search-wrapper">
            <input
              ref={searchInputRef}
              type="text"
              className="model-combobox-search"
              placeholder="Filter models…"
              value={localFilter}
              onChange={(e) => setLocalFilter(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            {localFilter && (
              <button
                type="button"
                className="model-combobox-clear"
                onClick={() => {
                  setLocalFilter("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear filter"
              >
                ×
              </button>
            )}
          </div>

          <div className="model-combobox-results-count">
            {filteredModels.length} model{filteredModels.length !== 1 ? "s" : ""}
          </div>

          <div ref={listRef} className="model-combobox-list">
            <div
              data-index={0}
              className={`model-combobox-option ${highlightedIndex === 0 ? "model-combobox-option--highlighted" : ""} ${value === "" ? "model-combobox-option--selected" : ""}`}
              onClick={() => handleSelect("")}
              onMouseEnter={() => setHighlightedIndex(0)}
              role="option"
              aria-selected={value === ""}
            >
              <span className="model-combobox-option-text model-combobox-option-text--default">Use default</span>
            </div>

            {Object.entries(modelsByProvider).map(([provider, providerModels]) => {
              const groupStartIndex = optionsList.findIndex((opt) => opt.value === `__group_${provider}`);
              
              return (
                <div key={provider} className="model-combobox-group">
                  <div 
                    className="model-combobox-optgroup"
                    data-index={groupStartIndex}
                  >
                    {provider}
                  </div>
                  {providerModels.map((m) => {
                    const optionValue = `${m.provider}/${m.id}`;
                    const optionIndex = optionsList.findIndex((opt) => opt.value === optionValue);
                    const isHighlighted = highlightedIndex === optionIndex;
                    const isSelected = value === optionValue;
                    
                    return (
                      <div
                        key={optionValue}
                        data-index={optionIndex}
                        className={`model-combobox-option ${isHighlighted ? "model-combobox-option--highlighted" : ""} ${isSelected ? "model-combobox-option--selected" : ""}`}
                        onClick={() => handleSelect(optionValue)}
                        onMouseEnter={() => setHighlightedIndex(optionIndex)}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span className="model-combobox-option-text">{m.name}</span>
                        <span className="model-combobox-option-id">{m.id}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {filteredModels.length === 0 && localFilter && (
              <div className="model-combobox-no-results">
                No models match &apos;{localFilter}&apos;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function NewTaskModal({ isOpen, onClose, tasks, onCreateTask, addToast }: NewTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [executorModel, setExecutorModel] = useState("");
  const [validatorModel, setValidatorModel] = useState("");
  const [enablePlanningMode, setEnablePlanningMode] = useState(false);
  const [hasDirtyState, setHasDirtyState] = useState(false);

  const depDropdownRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load available models when modal opens
  useEffect(() => {
    if (isOpen) {
      setModelsLoading(true);
      fetchModels()
        .then((models) => setAvailableModels(models))
        .catch(() => {/* silently fail - models just won't be available */})
        .finally(() => setModelsLoading(false));
    }
  }, [isOpen]);

  // Track dirty state
  useEffect(() => {
    const isDirty = 
      title.trim() !== "" ||
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      executorModel !== "" ||
      validatorModel !== "" ||
      enablePlanningMode;
    setHasDirtyState(isDirty);
  }, [title, description, dependencies, pendingImages, executorModel, validatorModel, enablePlanningMode]);

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
    setTitle("");
    setDescription("");
    setDependencies([]);
    setExecutorModel("");
    setValidatorModel("");
    setEnablePlanningMode(false);
    setHasDirtyState(false);
    onClose();
  }, [hasDirtyState, onClose, pendingImages]);

  const handleSubmit = useCallback(async () => {
    const trimmedDesc = description.trim();
    if (!trimmedDesc || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // Create the base task
      const task = await onCreateTask({
        title: title.trim() || undefined,
        description: trimmedDesc,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
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

      // Update task with model settings if specified
      const executorSlashIdx = executorModel.indexOf("/");
      const validatorSlashIdx = validatorModel.indexOf("/");
      
      if (executorModel || validatorModel || enablePlanningMode) {
        const updates: Parameters<typeof updateTask>[1] = {};
        
        if (executorModel && executorSlashIdx !== -1) {
          updates.modelProvider = executorModel.slice(0, executorSlashIdx);
          updates.modelId = executorModel.slice(executorSlashIdx + 1);
        }
        
        if (validatorModel && validatorSlashIdx !== -1) {
          updates.validatorModelProvider = validatorModel.slice(0, validatorSlashIdx);
          updates.validatorModelId = validatorModel.slice(validatorSlashIdx + 1);
        }
        
        // Note: enablePlanningMode would need backend support
        // TODO: Add backend support for per-task planning mode
        
        if (Object.keys(updates).length > 0) {
          await updateTask(task.id, updates);
        }
      }

      // Clean up
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);
      setTitle("");
      setDescription("");
      setDependencies([]);
      setExecutorModel("");
      setValidatorModel("");
      setEnablePlanningMode(false);

      addToast(`Created ${task.id}`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, title, dependencies, pendingImages, executorModel, validatorModel, enablePlanningMode, isSubmitting, onCreateTask, addToast, onClose]);

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
          {/* Title field */}
          <div className="form-group">
            <label htmlFor="new-task-title">
              Title <span className="optional">(optional)</span>
            </label>
            <input
              id="new-task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief title for the task"
              disabled={isSubmitting}
            />
          </div>

          {/* Description field */}
          <div className="form-group">
            <label htmlFor="new-task-description">Description</label>
            <textarea
              ref={descTextareaRef}
              id="new-task-description"
              value={description}
              onChange={handleDescriptionChange}
              placeholder="What needs to be done?"
              rows={3}
              disabled={isSubmitting}
            />
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
                  <label htmlFor="executor-model" className="model-select-label">Executor</label>
                  <ModelCombobox
                    id="executor-model"
                    label="Executor Model"
                    value={executorModel}
                    onChange={setExecutorModel}
                    models={availableModels}
                    disabled={isSubmitting}
                  />
                </div>
                <div className="model-select-row">
                  <label htmlFor="validator-model" className="model-select-label">Validator</label>
                  <ModelCombobox
                    id="validator-model"
                    label="Validator Model"
                    value={validatorModel}
                    onChange={setValidatorModel}
                    models={availableModels}
                    disabled={isSubmitting}
                  />
                </div>
              </>
            )}
          </div>

          {/* Planning Mode Toggle */}
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={enablePlanningMode}
                onChange={(e) => setEnablePlanningMode(e.target.checked)}
                disabled={isSubmitting}
              />
              Enable planning mode
            </label>
            <small>AI will ask clarifying questions before creating the task specification</small>
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
