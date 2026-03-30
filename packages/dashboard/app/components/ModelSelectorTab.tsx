import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchModels, updateTask } from "../api";
import type { ModelInfo } from "../api";
import type { Task, TaskDetail } from "@kb/core";
import type { ToastType } from "../hooks/useToast";
import { filterModels } from "../utils/modelFilter";

interface ModelSelectorTabProps {
  task: Task | TaskDetail;
  addToast: (message: string, type?: ToastType) => void;
}

interface ModelComboboxProps {
  value: string; // provider/id combo like "anthropic/claude-sonnet-4-5" or "" for default
  onChange: (value: string) => void;
  models: ModelInfo[];
  disabled?: boolean;
  placeholder?: string;
  label: string;
  id: string;
}

/**
 * ModelCombobox - A combobox component combining dropdown and filter input.
 * 
 * Interaction pattern:
 * - Closed: Shows trigger button with current selection
 * - Open: Dropdown with search input at top, scrollable list of models grouped by provider
 * - Filtering: Real-time filtering using filterModels() utility
 * - Keyboard: Arrow keys navigate, Enter selects, Escape closes, Tab moves focus
 */
function ModelCombobox({
  value,
  onChange,
  models,
  disabled = false,
  placeholder = "Select a model…",
  label,
  id,
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilter, setLocalFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter models based on local filter text
  const filteredModels = useMemo(() => 
    filterModels(models, localFilter), 
    [models, localFilter]
  );

  // Group filtered models by provider
  const modelsByProvider = useMemo(() => {
    return filteredModels.reduce<Record<string, ModelInfo[]>>((acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    }, {});
  }, [filteredModels]);

  // Build list of all selectable options (for keyboard navigation)
  const optionsList = useMemo(() => {
    const options: Array<{ type: "default" | "provider" | "model"; value: string; label: string; provider?: string }> = [
      { type: "default", value: "", label: "Use default" },
    ];
    
    Object.entries(modelsByProvider).forEach(([provider, providerModels]) => {
      options.push({ type: "provider", value: `__group_${provider}`, label: provider, provider });
      providerModels.forEach((m) => {
        options.push({ 
          type: "model", 
          value: `${m.provider}/${m.id}`, 
          label: m.name,
          provider: m.provider 
        });
      });
    });
    
    return options;
  }, [modelsByProvider]);

  // Get current selection display text
  const selectedDisplayText = useMemo(() => {
    if (!value) return "Use default";
    const slashIdx = value.indexOf("/");
    if (slashIdx === -1) return value;
    const provider = value.slice(0, slashIdx);
    const modelId = value.slice(slashIdx + 1);
    const model = models.find((m) => m.provider === provider && m.id === modelId);
    return model?.name || value;
  }, [value, models]);

  // Find index of current value in options list
  const currentValueIndex = useMemo(() => {
    return optionsList.findIndex((opt) => opt.value === value);
  }, [optionsList, value]);

  // Reset highlighted index when opening
  useEffect(() => {
    if (isOpen) {
      // Start with current value highlighted, or first selectable option
      const selectableIndex = optionsList.findIndex((opt, idx) => 
        idx >= (currentValueIndex >= 0 ? currentValueIndex : 0) && opt.type !== "provider"
      );
      setHighlightedIndex(selectableIndex >= 0 ? selectableIndex : 0);
    }
  }, [isOpen, optionsList, currentValueIndex]);

  // Focus search input when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Click outside to close
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

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          // Find next selectable option (skip provider headers)
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
          // Find previous selectable option (skip provider headers)
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
        // Close dropdown on tab (focus moves to next field)
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

  const handleClearFilter = useCallback(() => {
    setLocalFilter("");
    searchInputRef.current?.focus();
  }, []);

  const handleTriggerClick = useCallback(() => {
    if (!disabled) {
      setIsOpen((prev) => !prev);
    }
  }, [disabled]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl && typeof highlightedEl.scrollIntoView === "function") {
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, isOpen]);

  const hasFilter = localFilter.length > 0;

  return (
    <div ref={containerRef} className="model-combobox" onKeyDown={handleKeyDown}>
      {/* Trigger Button */}
      <button
        type="button"
        id={id}
        className="model-combobox-trigger"
        onClick={handleTriggerClick}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
      >
        <span className="model-combobox-trigger-text">{selectedDisplayText}</span>
        <span className="model-combobox-trigger-arrow">▼</span>
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="model-combobox-dropdown" role="listbox">
          {/* Search Input */}
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
            {hasFilter && (
              <button
                type="button"
                className="model-combobox-clear"
                onClick={handleClearFilter}
                aria-label="Clear filter"
              >
                ×
              </button>
            )}
          </div>

          {/* Results Count */}
          <div className="model-combobox-results-count">
            {filteredModels.length} model{filteredModels.length !== 1 ? "s" : ""}
          </div>

          {/* Options List */}
          <div ref={listRef} className="model-combobox-list">
            {/* Use default option */}
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

            {/* Provider groups */}
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

            {/* No results message */}
            {filteredModels.length === 0 && hasFilter && (
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

export function ModelSelectorTab({ task, addToast }: ModelSelectorTabProps) {
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Local state for selections (not saved until user clicks Save)
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(task.modelProvider);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(task.modelId);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(task.validatorModelProvider);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(task.validatorModelId);

  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Load available models on mount
  useEffect(() => {
    setModelsLoading(true);
    setModelsError(null);
    fetchModels()
      .then((models) => {
        setAvailableModels(models);
      })
      .catch((err) => {
        setModelsError(err.message || "Failed to load models");
      })
      .finally(() => {
        setModelsLoading(false);
      });
  }, []);

  // Track if selections differ from task's saved values
  useEffect(() => {
    const executorChanged =
      executorProvider !== task.modelProvider ||
      executorModelId !== task.modelId;
    const validatorChanged =
      validatorProvider !== task.validatorModelProvider ||
      validatorModelId !== task.validatorModelId;
    setHasChanges(executorChanged || validatorChanged);
  }, [executorProvider, executorModelId, validatorProvider, validatorModelId, task]);

  // Build combobox values (provider/id combination or empty for default)
  const executorValue = executorProvider && executorModelId
    ? `${executorProvider}/${executorModelId}`
    : "";
  const validatorValue = validatorProvider && validatorModelId
    ? `${validatorProvider}/${validatorModelId}`
    : "";

  const handleExecutorChange = useCallback((value: string) => {
    if (!value) {
      setExecutorProvider(undefined);
      setExecutorModelId(undefined);
    } else {
      const slashIdx = value.indexOf("/");
      setExecutorProvider(value.slice(0, slashIdx));
      setExecutorModelId(value.slice(slashIdx + 1));
    }
  }, []);

  const handleValidatorChange = useCallback((value: string) => {
    if (!value) {
      setValidatorProvider(undefined);
      setValidatorModelId(undefined);
    } else {
      const slashIdx = value.indexOf("/");
      setValidatorProvider(value.slice(0, slashIdx));
      setValidatorModelId(value.slice(slashIdx + 1));
    }
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateTask(task.id, {
        modelProvider: executorProvider,
        modelId: executorModelId,
        validatorModelProvider: validatorProvider,
        validatorModelId: validatorModelId,
      });
      addToast("Model settings saved", "success");
      setHasChanges(false);
    } catch (err: any) {
      addToast(err.message || "Failed to save model settings", "error");
    } finally {
      setIsSaving(false);
    }
  }, [task.id, executorProvider, executorModelId, validatorProvider, validatorModelId, addToast]);

  const handleReset = useCallback(() => {
    setExecutorProvider(task.modelProvider);
    setExecutorModelId(task.modelId);
    setValidatorProvider(task.validatorModelProvider);
    setValidatorModelId(task.validatorModelId);
  }, [task]);

  // Check if using defaults (both provider and modelId are undefined)
  const executorUsingDefault = !task.modelProvider && !task.modelId;
  const validatorUsingDefault = !task.validatorModelProvider && !task.validatorModelId;

  return (
    <div className="model-selector-tab">
      <h4>Model Configuration</h4>
      <p className="model-selector-intro">
        Override the AI models used for this task. When not specified, global default settings are used.
      </p>

      {modelsLoading ? (
        <div className="model-selector-loading">Loading available models…</div>
      ) : modelsError ? (
        <div className="model-selector-error">
          Error loading models: {modelsError}
          <button
            className="btn btn-sm"
            onClick={() => {
              setModelsLoading(true);
              setModelsError(null);
              fetchModels()
                .then(setAvailableModels)
                .catch((err) => setModelsError(err.message))
                .finally(() => setModelsLoading(false));
            }}
            style={{ marginLeft: "8px" }}
          >
            Retry
          </button>
        </div>
      ) : availableModels.length === 0 ? (
        <div className="model-selector-empty">
          No models available. Configure authentication in Settings to enable model selection.
        </div>
      ) : (
        <>
          {/* Executor Model Selector */}
          <div className="form-group">
            <label htmlFor="executorModel">Executor Model</label>
            <div className="model-selector-current">
              {executorUsingDefault ? (
                <span className="model-badge model-badge-default">Using default</span>
              ) : (
                <span className="model-badge model-badge-custom">
                  {task.modelProvider}/{task.modelId}
                </span>
              )}
            </div>
            <ModelCombobox
              id="executorModel"
              label="Executor Model"
              value={executorValue}
              onChange={handleExecutorChange}
              models={availableModels}
              disabled={isSaving}
              placeholder="Select executor model…"
            />
            <small>The AI model used to implement this task.</small>
          </div>

          {/* Validator Model Selector */}
          <div className="form-group">
            <label htmlFor="validatorModel">Validator Model</label>
            <div className="model-selector-current">
              {validatorUsingDefault ? (
                <span className="model-badge model-badge-default">Using default</span>
              ) : (
                <span className="model-badge model-badge-custom">
                  {task.validatorModelProvider}/{task.validatorModelId}
                </span>
              )}
            </div>
            <ModelCombobox
              id="validatorModel"
              label="Validator Model"
              value={validatorValue}
              onChange={handleValidatorChange}
              models={availableModels}
              disabled={isSaving}
              placeholder="Select validator model…"
            />
            <small>The AI model used to review code and plans for this task.</small>
          </div>

          {/* Action buttons */}
          <div className="model-selector-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              className="btn btn-sm"
              onClick={handleReset}
              disabled={!hasChanges || isSaving}
            >
              Reset
            </button>
          </div>

          {!hasChanges && (
            <div className="model-selector-status">
              {executorUsingDefault && validatorUsingDefault
                ? "Using global default models."
                : "Model settings are up to date."}
            </div>
          )}
        </>
      )}
    </div>
  );
}
