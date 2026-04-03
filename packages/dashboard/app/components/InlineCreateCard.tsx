import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Brain, Link, Lightbulb, ListTree, Zap, ChevronDown, ChevronUp, Globe } from "lucide-react";
import type { Task, TaskCreateInput, Settings } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchModels, uploadAttachment, fetchSettings, updateGlobalSettings } from "../api";
import type { ModelInfo } from "../api";
import { ModelSelectionModal } from "./ModelSelectionModal";
import { applyPresetToSelection } from "../utils/modelPresets";

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const STORAGE_KEY = "kb-inline-create-text";

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface InlineCreateCardProps {
  tasks: Task[];
  onSubmit: (input: TaskCreateInput) => Promise<Task>;
  onCancel: () => void;
  addToast: (msg: string, type?: ToastType) => void;
  projectId?: string;
  /**
   * Optional model list from a parent surface. When omitted, InlineCreateCard
   * fetches models itself so it can stay reusable in both list and board flows
   * without forcing model data to be threaded through every caller.
   */
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

export function InlineCreateCard({
  tasks,
  onSubmit,
  onCancel,
  addToast,
  projectId,
  availableModels,
  onPlanningMode,
  onSubtaskBreakdown,
}: InlineCreateCardProps) {
  const [description, setDescription] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) || "";
    }
    return "";
  });
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>(undefined);
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(undefined);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(undefined);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(undefined);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(undefined);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [browserVerification, setBrowserVerification] = useState(false);
  const justResetRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Persist description to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, description);
    }
  }, [description]);

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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!showDeps) setDepSearch("");
  }, [showDeps]);

  useEffect(() => {
    let cancelled = false;

    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

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

    fetchSettings(projectId)
      .then((nextSettings) => {
        if (!cancelled) {
          setSettings(nextSettings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [availableModels, projectId]);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);
  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);

  const hasExecutorOverride = Boolean(executorProvider && executorModelId);
  const hasValidatorOverride = Boolean(validatorProvider && validatorModelId);
  const selectedModelCount = Number(hasExecutorOverride) + Number(hasValidatorOverride);

  // Track focus-out for conditional cancel behavior and justResetRef cleanup.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const handleFocusOut = (e: FocusEvent) => {
      // relatedTarget is the element receiving focus — if it's inside the card, ignore
      if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return;

      if (justResetRef.current) {
        justResetRef.current = false;
        return;
      }

      const hasOpenOverlay = showDeps || isModelModalOpen || showPresets;
      const hasDescription = description.trim().length > 0;
      const shouldCancelWhenCollapsed = !isExpanded && !hasDescription && !hasOpenOverlay;
      const shouldCancelWhenExpanded = isExpanded && !hasDescription && !hasOpenOverlay;

      if (shouldCancelWhenCollapsed || shouldCancelWhenExpanded) {
        onCancel();
      }
    };

    card.addEventListener("focusout", handleFocusOut);
    return () => card.removeEventListener("focusout", handleFocusOut);
  }, [description, isExpanded, onCancel, showDeps, isModelModalOpen, showPresets]);

  // Clean up object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));

      // Clear localStorage on unmount if there's no description (user abandoned)
      if (typeof window !== "undefined") {
        const current = localStorage.getItem(STORAGE_KEY);
        if (current && current.trim() === "") {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, []);

  /**
   * Handles paste events on the textarea. Extracts image files from the
   * clipboard data, creates object URL previews, and appends them to
   * the pendingImages state. Non-image files are silently ignored.
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (submitting) return;
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;

      const newImages: PendingImage[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
          newImages.push({ file, previewUrl: URL.createObjectURL(file) });
        }
      }
      if (newImages.length > 0) {
        setPendingImages((prev) => [...prev, ...newImages]);
      }
    },
    [submitting],
  );

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!description.trim() || submitting) return;
    setSubmitting(true);
    try {
      const task = await onSubmit({
        description: description.trim(),
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        modelPresetId: selectedPresetId,
        modelProvider: hasExecutorOverride ? executorProvider : undefined,
        modelId: hasExecutorOverride ? executorModelId : undefined,
        validatorModelProvider: hasValidatorOverride ? validatorProvider : undefined,
        validatorModelId: hasValidatorOverride ? validatorModelId : undefined,
        enabledWorkflowSteps: browserVerification ? ["browser-verification"] : undefined,
      });

      // Upload pending images as attachments
      if (pendingImages.length > 0) {
        const failures: string[] = [];
        for (const img of pendingImages) {
          try {
            await uploadAttachment(task.id, img.file, projectId);
          } catch {
            failures.push(img.file.name);
          }
        }
        if (failures.length > 0) {
          addToast(`Failed to upload: ${failures.join(", ")}`, "error");
        }
      }

      // Clean up preview URLs
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);

      setDescription("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      setSelectedPresetId(undefined);
      setExecutorProvider(undefined);
      setExecutorModelId(undefined);
      setValidatorProvider(undefined);
      setValidatorModelId(undefined);
      setDependencies([]);
      setShowDeps(false);
      setIsModelModalOpen(false);
      setShowPresets(false);
      setBrowserVerification(false);
      addToast(`Created ${task.id}`, "success");

      // Collapse and clear localStorage after successful task creation
      setIsExpanded(false);
      justResetRef.current = true;
      if (typeof window !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err: any) {
      addToast(err.message, "error");
    } finally {
      setSubmitting(false);
    }
  }, [
    description,
    dependencies,
    hasExecutorOverride,
    executorProvider,
    executorModelId,
    hasValidatorOverride,
    validatorProvider,
    validatorModelId,
    submitting,
    pendingImages,
    onSubmit,
    addToast,
    selectedPresetId,
    browserVerification,
  ]);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Close dropdowns first if open
        if (showDeps || isModelModalOpen || showPresets) {
          setShowDeps(false);
          setIsModelModalOpen(false);
          setShowPresets(false);
          return;
        }
        // Clear non-empty input on Escape and clear localStorage
        if (description.trim()) {
          setDescription("");
          // Reset height
          if (inputRef.current) {
            inputRef.current.style.height = "auto";
          }
          // Clear localStorage when user explicitly clears input
          if (typeof window !== "undefined") {
            localStorage.removeItem(STORAGE_KEY);
          }
        }
        // Collapse and cancel on escape
        setIsExpanded(false);
        onCancel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, onCancel, description, showDeps, isModelModalOpen, showPresets],
  );

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

  const toggleModelsDropdown = useCallback(() => {
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
    // Clear the input after triggering planning mode
    setDescription("");
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setSelectedPresetId(undefined);
    setShowDeps(false);
    setIsModelModalOpen(false);
    setShowPresets(false);
    setBrowserVerification(false);
    setIsExpanded(false);
  }, [description, onPlanningMode, addToast]);

  const handleSubtaskClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast("Enter a description first", "error");
      return;
    }
    onSubtaskBreakdown?.(trimmed);
    // Clear the input after triggering subtask breakdown
    setDescription("");
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setSelectedPresetId(undefined);
    setShowDeps(false);
    setIsModelModalOpen(false);
    setShowPresets(false);
    setBrowserVerification(false);
    setIsExpanded(false);
  }, [description, onSubtaskBreakdown, addToast]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <div className={`inline-create-card ${isExpanded ? "inline-create-card--expanded" : "inline-create-card--collapsed"}`} ref={cardRef}>
      <div className="inline-create-main-row">
        <textarea
          ref={inputRef}
          rows={1}
          className="inline-create-input"
          placeholder="What needs to be done?"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = el.scrollHeight + "px";
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={submitting}
          aria-controls={isExpanded ? "inline-create-controls" : undefined}
        />
        <button
          type="button"
          className="btn btn-sm inline-create-toggle"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? "inline-create-controls" : undefined}
          aria-label={isExpanded ? "Collapse advanced task options" : "Expand advanced task options"}
          data-testid="inline-create-toggle"
          title={isExpanded ? "Collapse" : "Expand"}
        >
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {pendingImages.length > 0 && (
        <div className="inline-create-previews">
          {pendingImages.map((img, i) => (
            <div key={img.previewUrl} className="inline-create-preview">
              <img src={img.previewUrl} alt={img.file.name} />
              <button
                type="button"
                className="inline-create-preview-remove"
                onClick={() => removeImage(i)}
                disabled={submitting}
                title="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {isExpanded && (
        <div id="inline-create-controls" className="inline-create-footer">
          <div className="inline-create-controls">
            <div className="dep-trigger-wrap">
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={toggleDepsDropdown}
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

            <div className="inline-create-model-wrap">
              <button
                type="button"
                className="btn btn-sm inline-create-model-trigger"
                onClick={() => {
                  setShowPresets((prev) => {
                    const next = !prev;
                    if (next) {
                      setShowDeps(false);
                      setIsModelModalOpen(false);
                    }
                    return next;
                  });
                }}
                aria-expanded={showPresets}
                aria-haspopup="listbox"
              >
                <Zap size={12} style={{ verticalAlign: "middle" }} />
                {selectedPreset ? ` ${selectedPreset.name}` : " Preset"}
              </button>
              {showPresets && (
                <div className="inline-create-model-dropdown" onMouseDown={handleModelDropdownMouseDown}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setSelectedPresetId(undefined);
                      setExecutorProvider(undefined);
                      setExecutorModelId(undefined);
                      setValidatorProvider(undefined);
                      setValidatorModelId(undefined);
                      setShowPresets(false);
                    }}
                  >
                    Use default
                  </button>
                  {availablePresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const selection = applyPresetToSelection(preset);
                        const executor = parseModelSelection(selection.executorValue);
                        const validator = parseModelSelection(selection.validatorValue);
                        setSelectedPresetId(preset.id);
                        setExecutorProvider(executor.provider);
                        setExecutorModelId(executor.modelId);
                        setValidatorProvider(validator.provider);
                        setValidatorModelId(validator.modelId);
                        setShowPresets(false);
                      }}
                    >
                      {preset.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowPresets(false)}
                  >
                    Custom
                  </button>
                </div>
              )}
              <button
                type="button"
                className="btn btn-sm inline-create-model-trigger"
                onClick={toggleModelsDropdown}
                aria-expanded={isModelModalOpen}
                aria-haspopup="dialog"
              >
                <Brain size={12} style={{ verticalAlign: "middle" }} />
                {selectedPreset
                  ? ` ${selectedPreset.name} · ${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
                  : selectedModelCount > 0
                    ? ` ${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
                    : " Models"}
              </button>

            </div>

            {!submitting && (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handlePlanClick}
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
                  disabled={!description.trim()}
                  data-testid="subtask-button"
                  title="Break down into AI-generated subtasks"
                >
                  <ListTree size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                  Subtask
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${browserVerification ? "btn-active" : ""}`}
                  onClick={() => setBrowserVerification((v) => !v)}
                  disabled={submitting}
                  data-testid="browser-verification-toggle"
                  title="Verify with agent-browser"
                >
                  <Globe size={12} style={{ verticalAlign: "middle" }} />
                  Browser
                </button>
              </>
            )}
          </div>
          <div className="inline-create-actions">
            <span className="inline-create-hint">Enter to create · Esc to cancel</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSubmit}
              disabled={!description.trim() || submitting}
              data-testid="save-button"
            >
              {submitting ? "Creating..." : "Save"}
            </button>
          </div>
        </div>
      )}

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
