import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ToastType } from "../hooks/useToast";
import type { Task, TaskCreateInput, Settings } from "@fusion/core";
import type { ModelInfo, RefinementType } from "../api";
import { fetchModels, fetchSettings, refineText, getRefineErrorMessage, updateGlobalSettings } from "../api";
import { Link, Brain, Lightbulb, ListTree, Sparkles, Save, ChevronDown, ChevronUp, ChevronRight } from "lucide-react";
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
  /**
   * When true, the component automatically expands when focused.
   * Set to false to keep the view collapsed until manually toggled.
   * Defaults to true for backward compatibility.
   */
  autoExpand?: boolean;
  /**
   * Favorited provider IDs from shared app-level state.
   * When provided (alongside availableModels), the component uses these
   * instead of its own internal favorite state.
   */
  favoriteProviders?: string[];
  /**
   * Favorited model IDs from shared app-level state.
   * When provided (alongside availableModels), the component uses these
   * instead of its own internal favorite state.
   */
  favoriteModels?: string[];
  /**
   * Toggle favorite provider callback from shared app-level state.
   */
  onToggleFavorite?: (provider: string) => void;
  /**
   * Toggle favorite model callback from shared app-level state.
   */
  onToggleModelFavorite?: (modelId: string) => void;
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

export function QuickEntryBox({ onCreate, addToast, tasks = [], availableModels, onPlanningMode, onSubtaskBreakdown, autoExpand = true, favoriteProviders: parentFavoriteProviders, favoriteModels: parentFavoriteModels, onToggleFavorite: parentToggleFavorite, onToggleModelFavorite: parentToggleModelFavorite }: QuickEntryBoxProps) {
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
  // Always starts collapsed — user must explicitly toggle each session
  const [isDisclosureExpanded, setIsDisclosureExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const justResetRef = useRef(false);

  // Rich creation state (mirrors InlineCreateCard)
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeModelSubmenu, setActiveModelSubmenu] = useState<"plan" | "executor" | "validator" | null>(null);
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(undefined);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(undefined);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(undefined);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(undefined);
  const [planningProvider, setPlanningProvider] = useState<string | undefined>(undefined);
  const [planningModelId, setPlanningModelId] = useState<string | undefined>(undefined);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuPortalRef = useRef<HTMLDivElement>(null);
  const [modelMenuPosition, setModelMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>(undefined);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);

  // Use parent-provided favorites when available, otherwise internal state
  const effectiveFavoriteProviders = parentFavoriteProviders ?? favoriteProviders;
  const effectiveFavoriteModels = parentFavoriteModels ?? favoriteModels;

  // If onCreate is not provided, the component is disabled
  const isDisabled = !onCreate;

  // Fetch models and settings if not provided by parent
  useEffect(() => {
    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsLoading(false);
      setModelsError(null);
    } else {
      let cancelled = false;
      setModelsLoading(true);
      setModelsError(null);
      fetchModels()
        .then((response) => {
          if (!cancelled) {
            setLoadedModels(response.models);
            // Only set internal favorites when parent doesn't manage them
            if (!parentFavoriteProviders) {
              setFavoriteProviders(response.favoriteProviders);
            }
            if (!parentFavoriteModels) {
              setFavoriteModels(response.favoriteModels);
            }
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

      // Also fetch settings for presets
      fetchSettings()
        .then((nextSettings) => {
          if (!cancelled) {
            setSettings(nextSettings);
          }
        })
        .catch(() => {
          // Silently ignore settings fetch failure
        });

      return () => {
        cancelled = true;
      };
    }
  }, [availableModels, parentFavoriteProviders, parentFavoriteModels]);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);
  const planningSelectionValue = getModelSelectionValue(planningProvider, planningModelId);

  const hasExecutorOverride = Boolean(executorProvider && executorModelId);
  const hasValidatorOverride = Boolean(validatorProvider && validatorModelId);
  const hasPlanningOverride = Boolean(planningProvider && planningModelId);
  const selectedModelCount = Number(hasExecutorOverride) + Number(hasValidatorOverride) + Number(hasPlanningOverride);

  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((p) => p.id === selectedPresetId);

  const handlePresetChange = useCallback((presetId: string | undefined) => {
    setSelectedPresetId(presetId);
  }, []);

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

  // Clean up legacy disclosure persistence key from previous versions
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("kb-quick-entry-expanded");
    }
  }, []);

  // Set portal root for model menu rendering
  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

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

  // Close model menu when clicking outside
  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInsideTrigger = modelMenuRef.current?.contains(target);
      const clickedInsidePortal = modelMenuPortalRef.current?.contains(target);
      // Also check for clicks inside CustomModelDropdown's portaled dropdown
      const clickedInsideCombobox = (target instanceof Element) && (target.closest?.(".model-combobox-dropdown--portal") != null);

      if (!clickedInsideTrigger && !clickedInsidePortal && !clickedInsideCombobox) {
        setIsModelMenuOpen(false);
        setActiveModelSubmenu(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isModelMenuOpen]);

  const resetForm = useCallback(() => {
    setDescription("");
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setPlanningProvider(undefined);
    setPlanningModelId(undefined);
    setSelectedPresetId(undefined);
    setShowDeps(false);
    setIsModelMenuOpen(false);
    setActiveModelSubmenu(null);
    setIsRefineMenuOpen(false);
    setIsRefining(false);
    setIsExpanded(false); // Collapse textarea height on reset
    setIsDisclosureExpanded(false); // Always reset controls to collapsed after creation
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
        modelPresetId: selectedPresetId,
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
        // Close model submenu first if open
        if (activeModelSubmenu) {
          setActiveModelSubmenu(null);
          return;
        }
        // Close model menu if open
        if (isModelMenuOpen) {
          setIsModelMenuOpen(false);
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
      isModelMenuOpen,
      activeModelSubmenu,
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
      if (next) {
        setIsModelMenuOpen(false);
        setActiveModelSubmenu(null);
      }
      return next;
    });
  }, []);

  const updateModelMenuPosition = useCallback(() => {
    const trigger = modelMenuRef.current?.querySelector(".quick-entry-model-trigger") as HTMLElement | null;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    setModelMenuPosition({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 240),
    });
  }, []);

  const toggleModelMenu = useCallback(() => {
    setIsModelMenuOpen((prev) => {
      const next = !prev;
      if (next) {
        setShowDeps(false);
        // Compute position synchronously so the portal renders on first paint
        updateModelMenuPosition();
      } else {
        setActiveModelSubmenu(null);
        setModelMenuPosition(null);
      }
      return next;
    });
  }, [updateModelMenuPosition]);

  // Keep model menu portal anchored during scroll/resize
  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleReposition = () => updateModelMenuPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [isModelMenuOpen, updateModelMenuPosition]);

  const handlePlanningModelChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setPlanningProvider(next.provider);
    setPlanningModelId(next.modelId);
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
    // Delegate to parent callback when available
    if (parentToggleFavorite) {
      parentToggleFavorite(provider);
      return;
    }

    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      // Revert on error
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels, parentToggleFavorite]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    // Delegate to parent callback when available
    if (parentToggleModelFavorite) {
      parentToggleModelFavorite(modelId);
      return;
    }

    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((m) => m !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      // Revert on error
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders, parentToggleModelFavorite]);

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

    setIsRefineMenuOpen(false);
    setIsRefining(true);
    try {
      const refined = await refineText(trimmed, type);
      setDescription(refined);
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
      // Only set internal favorites when parent doesn't manage them
      if (!parentFavoriteProviders) {
        setFavoriteProviders(response.favoriteProviders);
      }
      if (!parentFavoriteModels) {
        setFavoriteModels(response.favoriteModels);
      }
    } catch (err: any) {
      setModelsError(err?.message || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, [availableModels, parentFavoriteProviders, parentFavoriteModels]);

  // Show expanded controls based on disclosure state (user preference), not textarea focus
  const showExpandedControls = isDisclosureExpanded;

  const toggleExpanded = useCallback(() => {
    setIsDisclosureExpanded((prev) => {
      const next = !prev;
      setIsExpanded(next);
      return next;
    });
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
          aria-expanded={isDisclosureExpanded}
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
      {/* AI-assisted refinement actions — always visible when expanded */}
      {isExpanded && !isSubmitting && (
        <div className="quick-entry-description-actions" data-testid="quick-entry-description-actions">
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
        </div>
      )}
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

          <div className="quick-entry-model-wrap" ref={modelMenuRef}>
            <button
              type="button"
              className="btn btn-sm quick-entry-model-trigger"
              onClick={toggleModelMenu}
              aria-expanded={isModelMenuOpen}
              aria-haspopup="menu"
              data-testid="quick-entry-models-button"
            >
              <Brain size={12} style={{ verticalAlign: "middle" }} />
              {selectedPreset
                ? ` ${selectedPreset.name}`
                : selectedModelCount > 0
                  ? ` ${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
                  : " Models"}
            </button>
            {isModelMenuOpen && portalRoot && modelMenuPosition && createPortal(
              <div
                ref={modelMenuPortalRef}
                className="model-nested-menu model-nested-menu--portal"
                onMouseDown={(e) => e.preventDefault()}
                data-testid="model-nested-menu"
                style={{
                  position: "fixed",
                  top: `${modelMenuPosition.top}px`,
                  left: `${modelMenuPosition.left}px`,
                  width: `${modelMenuPosition.width}px`,
                }}
              >
                {activeModelSubmenu === null ? (
                  // Top-level menu with Plan/Executor/Validator choices
                  <div className="model-menu-items">
                    <button
                      type="button"
                      className={`model-menu-item ${hasPlanningOverride ? "model-menu-item--active" : ""}`}
                      onClick={() => setActiveModelSubmenu("plan")}
                      data-testid="model-menu-plan"
                    >
                      <span className="model-menu-item-label">
                        <Lightbulb size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                        Plan
                      </span>
                      <span className="model-menu-item-value">
                        {hasPlanningOverride
                          ? getModelBadgeLabel(planningProvider, planningModelId)
                          : "Using default"}
                      </span>
                      <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-dim)" }} />
                    </button>
                    <button
                      type="button"
                      className={`model-menu-item ${hasExecutorOverride ? "model-menu-item--active" : ""}`}
                      onClick={() => setActiveModelSubmenu("executor")}
                      data-testid="model-menu-executor"
                    >
                      <span className="model-menu-item-label">
                        <Sparkles size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                        Executor
                      </span>
                      <span className="model-menu-item-value">
                        {hasExecutorOverride
                          ? getModelBadgeLabel(executorProvider, executorModelId)
                          : "Using default"}
                      </span>
                      <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-dim)" }} />
                    </button>
                    <button
                      type="button"
                      className={`model-menu-item ${hasValidatorOverride ? "model-menu-item--active" : ""}`}
                      onClick={() => setActiveModelSubmenu("validator")}
                      data-testid="model-menu-validator"
                    >
                      <span className="model-menu-item-label">
                        <Brain size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                        Validator
                      </span>
                      <span className="model-menu-item-value">
                        {hasValidatorOverride
                          ? getModelBadgeLabel(validatorProvider, validatorModelId)
                          : "Using default"}
                      </span>
                      <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-dim)" }} />
                    </button>
                  </div>
                ) : (
                  // Submenu with CustomModelDropdown for the selected target
                  <div className="model-submenu">
                    <button
                      type="button"
                      className="model-submenu-back"
                      onClick={() => setActiveModelSubmenu(null)}
                      data-testid="model-submenu-back"
                    >
                      <ChevronDown size={12} style={{ transform: "rotate(90deg)", marginRight: 4 }} />
                      Back
                    </button>
                    <div className="model-submenu-header">
                      {activeModelSubmenu === "plan" && "Plan Model"}
                      {activeModelSubmenu === "executor" && "Executor Model"}
                      {activeModelSubmenu === "validator" && "Validator Model"}
                    </div>
                    <CustomModelDropdown
                      models={loadedModels}
                      value={
                        activeModelSubmenu === "plan"
                          ? planningSelectionValue
                          : activeModelSubmenu === "executor"
                            ? executorSelectionValue
                            : validatorSelectionValue
                      }
                      onChange={
                        activeModelSubmenu === "plan"
                          ? handlePlanningModelChange
                          : activeModelSubmenu === "executor"
                            ? handleExecutorChange
                            : handleValidatorChange
                      }
                      placeholder="Using default"
                      disabled={modelsLoading}
                      id={`model-${activeModelSubmenu}-select`}
                      label={`${activeModelSubmenu} model`}
                      favoriteProviders={effectiveFavoriteProviders}
                      onToggleFavorite={handleToggleFavorite}
                      favoriteModels={effectiveFavoriteModels}
                      onToggleModelFavorite={handleToggleModelFavorite}
                    />
                    {modelsError && (
                      <div className="model-submenu-error">
                        <span>{modelsError}</span>
                        <button type="button" className="btn btn-sm" onClick={loadModels}>
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>,
              portalRoot,
            )}
          </div>

          {!isSubmitting && (
            <button
              type="button"
              className="btn btn-task-create btn-sm"
              onClick={handleSaveClick}
              onMouseDown={(e) => e.preventDefault()}
              disabled={!description.trim() || isSubmitting}
              data-testid="save-button"
              title="Create task"
            >
              <Save size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              Save
            </button>
          )}
        </div>
        <div className="quick-entry-hint">
          Enter to create · Esc to cancel
        </div>
      </div>

    </div>
  );
}
