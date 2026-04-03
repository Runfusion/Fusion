import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ToastType } from "../hooks/useToast";
import type { Task, TaskCreateInput } from "@fusion/core";
import type { ModelInfo, RefinementType } from "../api";
import { fetchModels, refineText, getRefineErrorMessage, updateGlobalSettings } from "../api";
import { Link, Brain, Lightbulb, ListTree, Sparkles, Save, ChevronDown, ChevronUp } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ModelSelectionModal } from "./ModelSelectionModal";

const STORAGE_KEY = "kb-quick-entry-text";
const DISCLOSURE_STORAGE_KEY = "kb-quick-entry-expanded";

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
  /**
   * When true, the component automatically expands when focused.
   * Set to false to keep the view collapsed until manually toggled.
   * Defaults to true for backward compatibility.
   */
  autoExpand?: boolean;
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

export function QuickEntryBox({ onCreate, addToast, tasks = [], availableModels, onPlanningMode, onSubtaskBreakdown, autoExpand = true }: QuickEntryBoxProps) {
  const [description, setDescription] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) || "";
    }
    return "";
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  // isExpanded controls textarea height styling (auto-resize)
  const [isExpanded, setIsExpanded] = useState(false);
  // isDisclosureExpanded controls visibility of the controls panel (Deps, Models, etc.)
  const [isDisclosureExpanded, setIsDisclosureExpanded] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(DISCLOSURE_STORAGE_KEY);
      // Default to collapsed — only expand if user explicitly saved "true"
      return saved === "true";
    }
    return false;
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const justResetRef = useRef(false);

  // Rich creation state (mirrors InlineCreateCard)
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(undefined);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(undefined);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(undefined);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(undefined);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);

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
      .then((response) => {
        if (!cancelled) {
          setLoadedModels(response.models);
          setFavoriteProviders(response.favoriteProviders);
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

  // Persist disclosure state to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(DISCLOSURE_STORAGE_KEY, isDisclosureExpanded.toString());
    }
  }, [isDisclosureExpanded]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // No blur timeout to clean up
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

  const resetForm = useCallback(() => {
    setDescription("");
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setShowDeps(false);
    setIsModelModalOpen(false);
    setIsRefineMenuOpen(false);
    setIsRefining(false);
    setIsExpanded(false); // Collapse textarea height on reset
    // Note: isDisclosureExpanded is NOT reset - user preference persists
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
        // Close modal first if open
        if (isModelModalOpen) {
          setIsModelModalOpen(false);
          return;
        }
        // Close dropdowns first if open
        if (showDeps || isRefineMenuOpen) {
          setShowDeps(false);
          setIsRefineMenuOpen(false);
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
        // Collapse textarea and disclosure on escape
        setIsExpanded(false);
        setIsDisclosureExpanded(false);
        textareaRef.current?.blur();
      }
    },
    [
      handleSubmit,
      description,
      isExpanded,
      showDeps,
      isModelModalOpen,
      isRefineMenuOpen,
      setIsDisclosureExpanded,
    ],
  );

  const handleBlur = useCallback(() => {
    // No auto-collapse on blur — state persists until manually toggled or task is submitted/cancelled
    // Only clear the justResetRef flag if needed
    if (justResetRef.current) {
      justResetRef.current = false;
    }
  }, []);

  const handleFocus = useCallback(() => {
    // Auto-expand on focus when autoExpand prop is true (default)
    if (autoExpand) {
      setIsExpanded(true);
    }
  }, [autoExpand]);

  const toggleDep = useCallback((id: string) => {
    setDependencies((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const toggleDepsDropdown = useCallback(() => {
    setShowDeps((prev) => {
      const next = !prev;
      if (next) setIsModelModalOpen(false);
      return next;
    });
  }, []);

  const openModelModal = useCallback(() => {
    setIsModelModalOpen(true);
    setShowDeps(false);
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

  const handleSaveClick = useCallback(() => {
    // Save button now creates the task (same as Enter key)
    handleSubmit();
  }, [handleSubmit]);

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
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
      }
    } catch (err: any) {
      const errorMessage = getRefineErrorMessage(err);
      addToast(errorMessage, "error");
    } finally {
      setIsRefining(false);
    }
  }, [description, isRefining, addToast]);

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
      const response = await fetchModels();
      setLoadedModels(response.models);
      setFavoriteProviders(response.favoriteProviders);
    } catch (err: any) {
      setModelsError(err?.message || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, [availableModels]);

  // Show expanded controls based on disclosure state (user preference), not textarea focus
  const showExpandedControls = isDisclosureExpanded;

  const toggleExpanded = useCallback(() => {
    setIsDisclosureExpanded((prev) => !prev);
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <div className={`quick-entry-box ${isDisclosureExpanded ? "quick-entry-box--expanded" : "quick-entry-box--collapsed"}`} data-testid="quick-entry-box">
      <div className="quick-entry-main-row">
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
          aria-controls="quick-entry-controls"
          aria-expanded={isExpanded}
        />
        <button
          type="button"
          className="btn btn-sm quick-entry-toggle"
          onClick={toggleExpanded}
          aria-expanded={isDisclosureExpanded}
          aria-controls="quick-entry-controls"
          data-testid="quick-entry-toggle"
          title={isDisclosureExpanded ? "Collapse" : "Expand"}
        >
          {isDisclosureExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      <div
        id="quick-entry-controls"
        className="quick-entry-controls"
        hidden={!showExpandedControls}
        aria-hidden={!showExpandedControls}
      >
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
              onClick={openModelModal}
              aria-expanded={isModelModalOpen}
              aria-haspopup="dialog"
              data-testid="quick-entry-models-button"
            >
              <Brain size={12} style={{ verticalAlign: "middle" }} />
              {selectedModelCount > 0
                ? ` ${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
                : " Models"}
            </button>
          </div>

          {!isSubmitting && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handlePlanClick}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!description.trim()}
                data-testid="plan-button"
                title="Open planning mode with current description"
              >
                <Lightbulb size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                Plan
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleSubtaskClick}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!description.trim()}
                data-testid="subtask-button"
                title="Break down into AI-generated subtasks"
              >
                <ListTree size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                Subtask
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleSaveClick}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!description.trim() || isSubmitting}
                data-testid="save-button"
                title="Create task"
              >
                <Save size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                Save
              </button>
              <div className="refine-trigger-wrap" ref={refineMenuRef}>
                <button
                  type="button"
                  className={`btn btn-sm refine-button ${isRefining ? "refine-button--loading" : ""}`}
                  onClick={() => setIsRefineMenuOpen((prev) => !prev)}
                  disabled={!description.trim() || isRefining}
                  data-testid="refine-button"
                  title="Refine description with AI"
                >
                  <Sparkles size={12} style={{ verticalAlign: "middle" }} />
                  {isRefining ? "Refining..." : "Refine"}
                </button>
                {isRefineMenuOpen && (
                  <div
                    className="refine-menu"
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
            </>
          )}
        </div>
        <div className="quick-entry-hint">
          Enter to create · Esc to cancel
        </div>
      </div>

      {typeof document !== "undefined"
        ? createPortal(
            <ModelSelectionModal
              isOpen={isModelModalOpen}
              onClose={() => setIsModelModalOpen(false)}
              models={loadedModels}
              executorValue={executorSelectionValue}
              validatorValue={validatorSelectionValue}
              onExecutorChange={handleExecutorChange}
              onValidatorChange={handleValidatorChange}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
              onRetry={loadModels}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
