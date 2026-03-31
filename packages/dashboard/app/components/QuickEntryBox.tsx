import { useState, useCallback, useRef, useEffect } from "react";
import type { ToastType } from "../hooks/useToast";
import type { Task, TaskCreateInput } from "@kb/core";
import type { ModelInfo } from "../api";
import { fetchModels } from "../api";
import { Link, Brain, Lightbulb, ListTree } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";

const STORAGE_KEY = "kb-quick-entry-text";

interface QuickEntryBoxProps {
  onCreate?: (input: TaskCreateInput) => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
  tasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button to open planning mode.
   */
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button to trigger subtask breakdown.
   */
  onSubtaskBreakdown?: (description: string) => void;
}

function getModelSelectionValue(provider?: string, modelId?: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelSelection(value: string): { provider?: string; modelId?: string } {
  if (!value) {
    return { provider: undefined, modelId: undefined };
  }

  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) {
    return { provider: undefined, modelId: undefined };
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

export function QuickEntryBox({ onCreate, addToast, tasks = [], availableModels, onPlanningMode, onSubtaskBreakdown }: QuickEntryBoxProps) {
  const [description, setDescription] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) || "";
    }
    return "";
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const justResetRef = useRef(false);

  // Rich creation state (mirrors InlineCreateCard)
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [showModels, setShowModels] = useState(false);
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(undefined);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(undefined);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(undefined);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(undefined);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);

  // If onCreate is not provided, the component is disabled
  const isDisabled = !onCreate;

  // Fetch models if not provided by parent
  useEffect(() => {
    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    fetchModels()
      .then((models) => {
        if (!cancelled) {
          setLoadedModels(models);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setModelsError(err?.message || "Failed to load models");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [availableModels]);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);

  const hasExecutorOverride = Boolean(executorProvider && executorModelId);
  const hasValidatorOverride = Boolean(validatorProvider && validatorModelId);
  const selectedModelCount = Number(hasExecutorOverride) + Number(hasValidatorOverride);

  const getModelBadgeLabel = useCallback(
    (provider?: string, modelId?: string) => {
      if (!provider || !modelId) return "Using default";
      const matched = loadedModels.find((model) => model.provider === provider && model.id === modelId);
      return matched ? `${matched.provider}/${matched.id}` : `${provider}/${modelId}`;
    },
    [loadedModels],
  );

  // Persist description to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, description);
    }
  }, [description]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
      }
    };
  }, []);

  // Auto-resize textarea based on content
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = "auto";
    // Set to scrollHeight (capped at max-height via CSS)
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Resize when description changes
  useEffect(() => {
    if (isExpanded) {
      autoResize();
    }
  }, [description, isExpanded, autoResize]);

  // Restore focus after submission completes (when textarea is re-enabled)
  useEffect(() => {
    if (!isSubmitting && description === "" && textareaRef.current) {
      // Use setTimeout to ensure focus happens after React re-enables the textarea
      const focusTimeout = setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
      return () => clearTimeout(focusTimeout);
    }
  }, [isSubmitting, description]);

  // Clear dep search when dropdown closes
  useEffect(() => {
    if (!showDeps) setDepSearch("");
  }, [showDeps]);

  const resetForm = useCallback(() => {
    setDescription("");
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setShowDeps(false);
    setShowModels(false);
    setIsExpanded(false);
    justResetRef.current = true;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear localStorage when form is reset (after successful creation)
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = description.trim();
    if (!trimmed || isSubmitting || !onCreate) return;

    setIsSubmitting(true);
    try {
      await onCreate({
        description: trimmed,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        modelProvider: hasExecutorOverride ? executorProvider : undefined,
        modelId: hasExecutorOverride ? executorModelId : undefined,
        validatorModelProvider: hasValidatorOverride ? validatorProvider : undefined,
        validatorModelId: hasValidatorOverride ? validatorModelId : undefined,
      });
      // Clear input for rapid entry
      resetForm();
      // Note: Focus restoration is handled by useEffect when isSubmitting becomes false
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
      // Keep input content on failure so user can retry
    } finally {
      setIsSubmitting(false);
    }
  }, [
    description,
    isSubmitting,
    onCreate,
    dependencies,
    hasExecutorOverride,
    executorProvider,
    executorModelId,
    hasValidatorOverride,
    validatorProvider,
    validatorModelId,
    addToast,
    resetForm,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        if (e.shiftKey && isExpanded) {
          // Allow Shift+Enter to insert newline when expanded
          // Don't prevent default - let the newline be inserted
          return;
        }
        // Enter without Shift submits
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Close dropdowns first if open
        if (showDeps || showModels) {
          setShowDeps(false);
          setShowModels(false);
          return;
        }
        // Clear non-empty input on Escape and clear localStorage
        if (description.trim()) {
          setDescription("");
          // Reset height
          if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
          }
          // Clear localStorage when user explicitly clears input
          if (typeof window !== "undefined") {
            localStorage.removeItem(STORAGE_KEY);
          }
        }
        // Collapse on escape
        resetForm();
        // Clear any pending blur timeout
        if (blurTimeoutRef.current) {
          clearTimeout(blurTimeoutRef.current);
          blurTimeoutRef.current = null;
        }
        textareaRef.current?.blur();
      }
    },
    [handleSubmit, description, isExpanded, showDeps, showModels, resetForm],
  );

  const handleFocus = useCallback(() => {
    // Skip expanding if we just reset the form (prevents controls showing after successful creation)
    if (justResetRef.current) {
      justResetRef.current = false;
      return;
    }
    setIsExpanded(true);
  }, []);

  const handleBlur = useCallback(() => {
    // Clear any existing timeout
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }

    // Collapse after a short delay to allow click events on dropdowns
    // Collapse regardless of content - only check if dropdowns are open
    blurTimeoutRef.current = setTimeout(() => {
      if (!showDeps && !showModels) {
        setIsExpanded(false);
        // Reset height when collapsing
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
      blurTimeoutRef.current = null;
    }, 200);
  }, [showDeps, showModels]);

  const toggleDep = useCallback((id: string) => {
    setDependencies((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const toggleDepsDropdown = useCallback(() => {
    setShowDeps((prev) => {
      const next = !prev;
      if (next) setShowModels(false);
      return next;
    });
  }, []);

  const toggleModelsDropdown = useCallback(() => {
    setShowModels((prev) => {
      const next = !prev;
      if (next) setShowDeps(false);
      return next;
    });
  }, []);

  const handleExecutorChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setExecutorProvider(next.provider);
    setExecutorModelId(next.modelId);
  }, []);

  const handleValidatorChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setValidatorProvider(next.provider);
    setValidatorModelId(next.modelId);
  }, []);

  const handleModelDropdownMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.closest("button") || target.closest("input"))
    ) {
      return;
    }
    e.preventDefault();
  }, []);

  const handlePlanClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast("Enter a description first", "error");
      return;
    }
    onPlanningMode?.(trimmed);
    // Clear the form after triggering planning mode
    resetForm();
  }, [description, onPlanningMode, addToast, resetForm]);

  const handleSubtaskClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast("Enter a description first", "error");
      return;
    }
    onSubtaskBreakdown?.(trimmed);
    // Clear the form after triggering subtask breakdown
    resetForm();
  }, [description, onSubtaskBreakdown, addToast, resetForm]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const loadModels = useCallback(async () => {
    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }

    setModelsLoading(true);
    setModelsError(null);
    try {
      setLoadedModels(await fetchModels());
    } catch (err: any) {
      setModelsError(err?.message || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, [availableModels]);

  // Show expanded controls only when focused/interacted (isExpanded)
  const showExpandedControls = isExpanded;

  return (
    <div className="quick-entry-box" data-testid="quick-entry-box">
      <textarea
        ref={textareaRef}
        className={`quick-entry-input ${isExpanded ? "quick-entry-input--expanded" : ""}`}
        placeholder={isSubmitting ? "Creating..." : "Add a task..."}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        disabled={isSubmitting || isDisabled}
        data-testid="quick-entry-input"
        rows={1}
      />
      {showExpandedControls && (
        <div className="quick-entry-controls">
          <div className="quick-entry-controls-left">
            <div className="dep-trigger-wrap">
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={toggleDepsDropdown}
                data-testid="quick-entry-deps-button"
              >
                <Link size={12} style={{ verticalAlign: "middle" }} />
                {dependencies.length > 0 ? ` ${dependencies.length} deps` : " Deps"}
              </button>
              {showDeps && (() => {
                const term = depSearch.toLowerCase();
                const filtered = (term
                  ? tasks.filter((t) =>
                      t.id.toLowerCase().includes(term) ||
                      (t.title && t.title.toLowerCase().includes(term)) ||
                      (t.description && t.description.toLowerCase().includes(term))
                    )
                  : [...tasks]
                ).sort((a, b) => {
                  const cmp = b.createdAt.localeCompare(a.createdAt);
                  if (cmp !== 0) return cmp;
                  const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
                  const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
                  return bNum - aNum;
                });
                return (
                  <div className="dep-dropdown" onMouseDown={(e) => e.preventDefault()}>
                    <input
                      className="dep-dropdown-search"
                      placeholder="Search tasks…"
                      autoFocus
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {filtered.length === 0 ? (
                      <div className="dep-dropdown-empty">No existing tasks</div>
                    ) : (
                      filtered.map((t) => (
                        <div
                          key={t.id}
                          className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => toggleDep(t.id)}
                        >
                          <span className="dep-dropdown-id">{t.id}</span>
                          <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="quick-entry-model-wrap">
              <button
                type="button"
                className="btn btn-sm quick-entry-model-trigger"
                onClick={toggleModelsDropdown}
                aria-expanded={showModels}
                aria-haspopup="dialog"
                data-testid="quick-entry-models-button"
              >
                <Brain size={12} style={{ verticalAlign: "middle" }} />
                {selectedModelCount > 0
                  ? ` ${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
                  : " Models"}
              </button>
              {showModels && (
                <div
                  className="inline-create-model-dropdown"
                  onMouseDown={handleModelDropdownMouseDown}
                >
                  {modelsLoading ? (
                    <div className="inline-create-model-empty">Loading models…</div>
                  ) : modelsError ? (
                    <div className="inline-create-model-empty">
                      <span>Failed to load models.</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void loadModels()}
                      >
                        Retry
                      </button>
                    </div>
                  ) : loadedModels.length === 0 ? (
                    <div className="inline-create-model-empty">
                      No models available. Configure authentication in Settings to enable model selection.
                    </div>
                  ) : (
                    <>
                      <div className="inline-create-model-row">
                        <label htmlFor="quick-entry-executor-model" className="inline-create-model-label">
                          Executor Model
                        </label>
                        <span className={`model-badge ${hasExecutorOverride ? "model-badge-custom" : "model-badge-default"}`}>
                          {getModelBadgeLabel(executorProvider, executorModelId)}
                        </span>
                        <CustomModelDropdown
                          id="quick-entry-executor-model"
                          label="Executor Model"
                          value={executorSelectionValue}
                          onChange={handleExecutorChange}
                          models={loadedModels}
                          disabled={isSubmitting}
                          placeholder="Select executor model…"
                        />
                      </div>

                      <div className="inline-create-model-row">
                        <label htmlFor="quick-entry-validator-model" className="inline-create-model-label">
                          Validator Model
                        </label>
                        <span className={`model-badge ${hasValidatorOverride ? "model-badge-custom" : "model-badge-default"}`}>
                          {getModelBadgeLabel(validatorProvider, validatorModelId)}
                        </span>
                        <CustomModelDropdown
                          id="quick-entry-validator-model"
                          label="Validator Model"
                          value={validatorSelectionValue}
                          onChange={handleValidatorChange}
                          models={loadedModels}
                          disabled={isSubmitting}
                          placeholder="Select validator model…"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {!isSubmitting && (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handlePlanClick}
                  disabled={!description.trim()}
                  data-testid="plan-button"
                  title="Open planning mode with current description"
                >
                  <Lightbulb size={12} style={{ verticalAlign: "middle" }} />
                  Plan
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleSubtaskClick}
                  disabled={!description.trim()}
                  data-testid="subtask-button"
                  title="Break down into subtasks (coming soon)"
                >
                  <ListTree size={12} style={{ verticalAlign: "middle" }} />
                  Subtask
                </button>
              </>
            )}
          </div>
          <div className="quick-entry-hint">
            Enter to create · Esc to cancel
          </div>
        </div>
      )}
    </div>
  );
}
