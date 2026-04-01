import { useState, useCallback, useEffect, useRef } from "react";
import { Brain, Link, Lightbulb, ListTree, Zap } from "lucide-react";
import type { Task, TaskCreateInput, Settings } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchModels, uploadAttachment, fetchSettings } from "../api";
import type { ModelInfo } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
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
  const [showModels, setShowModels] = useState(false);
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
  const [submitting, setSubmitting] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
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
      setLoadedModels(await fetchModels());
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

    fetchSettings()
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
  }, [availableModels]);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);
  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);

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

  // Cancel when focus leaves the card entirely and there's no content
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const handleFocusOut = (e: FocusEvent) => {
      // relatedTarget is the element receiving focus — if it's inside the card, ignore
      if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return;
      // Only cancel if empty and dropdowns are not open
      if (
        description.trim() === "" &&
        pendingImages.length === 0 &&
        dependencies.length === 0 &&
        !hasExecutorOverride &&
        !hasValidatorOverride &&
        !showDeps &&
        !showModels &&
        !showPresets
      ) {
        onCancel();
      }
    };
    card.addEventListener("focusout", handleFocusOut);
    return () => card.removeEventListener("focusout", handleFocusOut);
  }, [
    description,
    pendingImages,
    dependencies,
    hasExecutorOverride,
    hasValidatorOverride,
    showDeps,
    showModels,
    showPresets,
    onCancel,
  ]);

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

      // Clean up preview URLs
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);

      setSelectedPresetId(undefined);
      addToast(`Created ${task.id}`, "success");

      // Clear localStorage after successful task creation
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
  ]);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Clear localStorage when user explicitly cancels
        if (typeof window !== "undefined") {
          localStorage.removeItem(STORAGE_KEY);
        }
        onCancel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, onCancel],
  );

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
    // Clear the input after triggering planning mode
    setDescription("");
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setSelectedPresetId(undefined);
    setShowDeps(false);
    setShowModels(false);
    setShowPresets(false);
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
    setShowModels(false);
    setShowPresets(false);
  }, [description, onSubtaskBreakdown, addToast]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  return (
    <div className="inline-create-card" ref={cardRef}>
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
      />
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
      <div className="inline-create-footer">
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
                    setShowModels(false);
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
              aria-expanded={showModels}
              aria-haspopup="dialog"
            >
              <Brain size={12} style={{ verticalAlign: "middle" }} />
              {selectedPreset
                ? ` ${selectedPreset.name} · ${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
                : selectedModelCount > 0
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
                      <label htmlFor="inline-create-executor-model" className="inline-create-model-label">
                        Executor Model
                      </label>
                      <span className={`model-badge ${hasExecutorOverride ? "model-badge-custom" : "model-badge-default"}`}>
                        {getModelBadgeLabel(executorProvider, executorModelId)}
                      </span>
                      <CustomModelDropdown
                        id="inline-create-executor-model"
                        label="Executor Model"
                        value={executorSelectionValue}
                        onChange={handleExecutorChange}
                        models={loadedModels}
                        disabled={submitting}
                        placeholder="Select executor model…"
                      />
                    </div>

                    <div className="inline-create-model-row">
                      <label htmlFor="inline-create-validator-model" className="inline-create-model-label">
                        Validator Model
                      </label>
                      <span className={`model-badge ${hasValidatorOverride ? "model-badge-custom" : "model-badge-default"}`}>
                        {getModelBadgeLabel(validatorProvider, validatorModelId)}
                      </span>
                      <CustomModelDropdown
                        id="inline-create-validator-model"
                        label="Validator Model"
                        value={validatorSelectionValue}
                        onChange={handleValidatorChange}
                        models={loadedModels}
                        disabled={submitting}
                        placeholder="Select validator model…"
                      />
                    </div>
                  </>
                )}
              </div>
            )}
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
                <Lightbulb size={12} style={{ verticalAlign: "middle" }} />
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
                <ListTree size={12} style={{ verticalAlign: "middle" }} />
                Subtask
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
          >
            {submitting ? "Creating..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
