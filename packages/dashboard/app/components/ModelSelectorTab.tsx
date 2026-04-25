import "./ModelSelectorTab.css";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchModels, updateTask, updateGlobalSettings } from "../api";
import type { ModelInfo } from "../api";
import type { Settings, Task, TaskDetail } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";

interface ModelSelectorTabProps {
  task: Task | TaskDetail;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
  settings?: Settings;
}

interface ModelSelection {
  provider?: string;
  modelId?: string;
}

function normalizeModelField(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function getExecutorSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.modelProvider),
    modelId: normalizeModelField(task.modelId),
  };
}

function getValidatorSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.validatorModelProvider),
    modelId: normalizeModelField(task.validatorModelId),
  };
}

function getPlanningSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.planningModelProvider),
    modelId: normalizeModelField(task.planningModelId),
  };
}

function resolveEffectiveExecutor(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  if (task.modelProvider && task.modelId) {
    return { provider: task.modelProvider, modelId: task.modelId };
  }
  if (settings?.defaultProvider && settings.defaultModelId) {
    return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
  }
  return {};
}

function resolveEffectiveValidator(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  if (task.validatorModelProvider && task.validatorModelId) {
    return { provider: task.validatorModelProvider, modelId: task.validatorModelId };
  }
  if (settings?.validatorProvider && settings.validatorModelId) {
    return { provider: settings.validatorProvider, modelId: settings.validatorModelId };
  }
  if (settings?.defaultProvider && settings.defaultModelId) {
    return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
  }
  return {};
}

function resolveEffectivePlanning(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  if (task.planningModelProvider && task.planningModelId) {
    return { provider: task.planningModelProvider, modelId: task.planningModelId };
  }
  if (settings?.planningProvider && settings.planningModelId) {
    return { provider: settings.planningProvider, modelId: settings.planningModelId };
  }
  if (settings?.defaultProvider && settings.defaultModelId) {
    return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
  }
  return {};
}

function parseModelValue(value: string): ModelSelection {
  if (!value) {
    return { provider: undefined, modelId: undefined };
  }

  const slashIdx = value.indexOf("/");
  return {
    provider: value.slice(0, slashIdx),
    modelId: value.slice(slashIdx + 1),
  };
}

function getDropdownValue(selection: ModelSelection): string {
  return selection.provider && selection.modelId
    ? `${selection.provider}/${selection.modelId}`
    : "";
}

function selectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

function getSuccessToastMessage(target: "executor" | "validator" | "planning", selection: ModelSelection): string {
  const labels: Record<string, string> = {
    executor: "Executor",
    validator: "Validator",
    planning: "Planning",
  };
  const label = labels[target] || target;

  if (!selection.provider || !selection.modelId) {
    return `${label} model set to default`;
  }

  return `${label} model set to ${selection.provider}/${selection.modelId}`;
}

export function ModelSelectorTab({ task, addToast, onTaskUpdated, settings }: ModelSelectorTabProps) {
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [selectedExecutor, setSelectedExecutor] = useState<ModelSelection>(() => getExecutorSelection(task));
  const [savedExecutor, setSavedExecutor] = useState<ModelSelection>(() => getExecutorSelection(task));
  const [selectedValidator, setSelectedValidator] = useState<ModelSelection>(() => getValidatorSelection(task));
  const [savedValidator, setSavedValidator] = useState<ModelSelection>(() => getValidatorSelection(task));
  const [selectedPlanning, setSelectedPlanning] = useState<ModelSelection>(() => getPlanningSelection(task));
  const [savedPlanning, setSavedPlanning] = useState<ModelSelection>(() => getPlanningSelection(task));
  const [selectedThinking, setSelectedThinking] = useState<string | null>(() => task.thinkingLevel ?? null);
  const [savedThinking, setSavedThinking] = useState<string | null>(() => task.thinkingLevel ?? null);
  const [savingTarget, setSavingTarget] = useState<"executor" | "validator" | "planning" | "thinking" | null>(null);

  const activeTaskIdRef = useRef(task.id);

  // Load available models on mount
  useEffect(() => {
    setModelsLoading(true);
    setModelsError(null);
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
      })
      .catch((err) => {
        setModelsError(err.message || "Failed to load models");
      })
      .finally(() => {
        setModelsLoading(false);
      });
  }, []);

  // Handle toggle favorite
  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites]; // Add to front

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      // Revert on error
      setFavoriteProviders(currentFavorites);
      addToast("Failed to update favorites", "error");
    }
  }, [favoriteProviders, favoriteModels, addToast]);

  // Handle toggle model favorite
  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((m) => m !== modelId)
      : [modelId, ...currentFavorites]; // Add to front

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      // Revert on error
      setFavoriteModels(currentFavorites);
      addToast("Failed to update model favorites", "error");
    }
  }, [favoriteModels, favoriteProviders, addToast]);

  useEffect(() => {
    activeTaskIdRef.current = task.id;

    const nextExecutor = getExecutorSelection(task);
    const nextValidator = getValidatorSelection(task);
    const nextPlanning = getPlanningSelection(task);

    setSelectedExecutor(nextExecutor);
    setSavedExecutor(nextExecutor);
    setSelectedValidator(nextValidator);
    setSavedValidator(nextValidator);
    setSelectedPlanning(nextPlanning);
    setSavedPlanning(nextPlanning);
    const nextThinking = task.thinkingLevel ?? null;
    setSelectedThinking(nextThinking);
    setSavedThinking(nextThinking);
    setSavingTarget(null);
  }, [task.id, task.modelProvider, task.modelId, task.validatorModelProvider, task.validatorModelId, task.planningModelProvider, task.planningModelId, task.thinkingLevel]);

  const executorValue = useMemo(() => getDropdownValue(selectedExecutor), [selectedExecutor]);
  const validatorValue = useMemo(() => getDropdownValue(selectedValidator), [selectedValidator]);
  const planningValue = useMemo(() => getDropdownValue(selectedPlanning), [selectedPlanning]);
  const effectiveExecutor = useMemo(() => resolveEffectiveExecutor(task, settings), [task, settings]);
  const effectiveValidator = useMemo(() => resolveEffectiveValidator(task, settings), [task, settings]);
  const effectivePlanning = useMemo(() => resolveEffectivePlanning(task, settings), [task, settings]);
  const isSaving = savingTarget !== null;

  const saveSelection = useCallback(
    async (target: "executor" | "validator" | "planning", nextSelection: ModelSelection) => {
      const requestTaskId = task.id;
      const previousSavedExecutor = savedExecutor;
      const previousSavedValidator = savedValidator;
      const previousSavedPlanning = savedPlanning;

      setSavingTarget(target);

      try {
        const updates: Parameters<typeof updateTask>[1] = onTaskUpdated
          ? (target === "executor"
            ? {
                modelProvider: nextSelection.provider ?? null,
                modelId: nextSelection.modelId ?? null,
              }
            : target === "validator"
              ? {
                  validatorModelProvider: nextSelection.provider ?? null,
                  validatorModelId: nextSelection.modelId ?? null,
                }
              : {
                  planningModelProvider: nextSelection.provider ?? null,
                  planningModelId: nextSelection.modelId ?? null,
                })
          : {
              modelProvider: (target === "executor" ? nextSelection : savedExecutor).provider ?? null,
              modelId: (target === "executor" ? nextSelection : savedExecutor).modelId ?? null,
              validatorModelProvider: (target === "validator" ? nextSelection : savedValidator).provider ?? null,
              validatorModelId: (target === "validator" ? nextSelection : savedValidator).modelId ?? null,
              planningModelProvider: (target === "planning" ? nextSelection : savedPlanning).provider ?? null,
              planningModelId: (target === "planning" ? nextSelection : savedPlanning).modelId ?? null,
            };

        const updatedTask = await updateTask(requestTaskId, updates);

        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        const nextSavedExecutor = getExecutorSelection(updatedTask);
        const nextSavedValidator = getValidatorSelection(updatedTask);
        const nextSavedPlanning = getPlanningSelection(updatedTask);

        setSavedExecutor(nextSavedExecutor);
        setSelectedExecutor(nextSavedExecutor);
        setSavedValidator(nextSavedValidator);
        setSelectedValidator(nextSavedValidator);
        setSavedPlanning(nextSavedPlanning);
        setSelectedPlanning(nextSavedPlanning);
        onTaskUpdated?.(updatedTask);

        const targetSelections: Record<string, ModelSelection> = {
          executor: nextSavedExecutor,
          validator: nextSavedValidator,
          planning: nextSavedPlanning,
        };

        addToast(
          getSuccessToastMessage(target, targetSelections[target]),
          "success",
        );
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        if (target === "executor") {
          setSelectedExecutor(previousSavedExecutor);
        } else if (target === "validator") {
          setSelectedValidator(previousSavedValidator);
        } else {
          setSelectedPlanning(previousSavedPlanning);
        }

        addToast(getErrorMessage(err) || "Failed to save model settings", "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedExecutor, savedValidator, savedPlanning, addToast, onTaskUpdated],
  );

  const handleExecutorChange = useCallback(
    (value: string) => {
      const nextSelection = parseModelValue(value);
      setSelectedExecutor(nextSelection);

      if (selectionsEqual(nextSelection, savedExecutor)) {
        return;
      }

      void saveSelection("executor", nextSelection);
    },
    [savedExecutor, saveSelection],
  );

  const handleValidatorChange = useCallback(
    (value: string) => {
      const nextSelection = parseModelValue(value);
      setSelectedValidator(nextSelection);

      if (selectionsEqual(nextSelection, savedValidator)) {
        return;
      }

      void saveSelection("validator", nextSelection);
    },
    [savedValidator, saveSelection],
  );

  const handlePlanningChange = useCallback(
    (value: string) => {
      const nextSelection = parseModelValue(value);
      setSelectedPlanning(nextSelection);

      if (selectionsEqual(nextSelection, savedPlanning)) {
        return;
      }

      void saveSelection("planning", nextSelection);
    },
    [savedPlanning, saveSelection],
  );

  const handleThinkingChange = useCallback(
    async (value: string) => {
      const requestTaskId = task.id;
      const previousThinking = savedThinking;
      // Empty string means clear override (null)
      const nextValue = value === "" ? null : value;

      setSelectedThinking(nextValue);
      setSavingTarget("thinking");

      try {
        const updatedTask = await updateTask(requestTaskId, {
          thinkingLevel: nextValue,
        });

        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        const nextThinking = updatedTask.thinkingLevel ?? null;
        setSavedThinking(nextThinking);
        setSelectedThinking(nextThinking);
        onTaskUpdated?.(updatedTask);

        const effectiveDefault = settings?.defaultThinkingLevel ?? "off";
        if (nextThinking === null) {
          addToast(
            `Thinking level set to default (${effectiveDefault})`,
            "success",
          );
        } else {
          addToast(
            `Thinking level set to ${nextThinking}`,
            "success",
          );
        }
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        setSelectedThinking(previousThinking);
        addToast(getErrorMessage(err) || "Failed to save thinking level", "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedThinking, settings, addToast, onTaskUpdated],
  );

  const executorUsingDefault = !savedExecutor.provider && !savedExecutor.modelId;
  const validatorUsingDefault = !savedValidator.provider && !savedValidator.modelId;
  const planningUsingDefault = !savedPlanning.provider && !savedPlanning.modelId;

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
                .then((response) => {
                  setAvailableModels(response.models);
                  setFavoriteProviders(response.favoriteProviders);
                  setFavoriteModels(response.favoriteModels);
                })
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
          <div className="form-group">
            <label htmlFor="executorModel">Executor Model</label>
            <div className="model-selector-current">
              {executorUsingDefault ? (
                <span className="model-badge model-badge-default">
                  Using default{effectiveExecutor.provider && effectiveExecutor.modelId ? ` (${effectiveExecutor.provider}/${effectiveExecutor.modelId})` : ""}
                </span>
              ) : (
                <span className="model-badge model-badge-custom">
                  {savedExecutor.provider && <ProviderIcon provider={savedExecutor.provider} size="sm" />}
                  {savedExecutor.provider}/{savedExecutor.modelId}
                </span>
              )}
            </div>
            <CustomModelDropdown
              id="executorModel"
              label="Executor Model"
              value={executorValue}
              onChange={handleExecutorChange}
              models={availableModels}
              disabled={isSaving}
              placeholder="Select executor model…"
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
            />
            <small>The AI model used to implement this task.</small>
          </div>

          <div className="form-group">
            <label htmlFor="validatorModel">Validator Model</label>
            <div className="model-selector-current">
              {validatorUsingDefault ? (
                <span className="model-badge model-badge-default">
                  Using default{effectiveValidator.provider && effectiveValidator.modelId ? ` (${effectiveValidator.provider}/${effectiveValidator.modelId})` : ""}
                </span>
              ) : (
                <span className="model-badge model-badge-custom">
                  {savedValidator.provider && <ProviderIcon provider={savedValidator.provider} size="sm" />}
                  {savedValidator.provider}/{savedValidator.modelId}
                </span>
              )}
            </div>
            <CustomModelDropdown
              id="validatorModel"
              label="Validator Model"
              value={validatorValue}
              onChange={handleValidatorChange}
              models={availableModels}
              disabled={isSaving}
              placeholder="Select validator model…"
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
            />
            <small>The AI model used to review code and plans for this task.</small>
          </div>

          <div className="form-group">
            <label htmlFor="planningModel">Planning Model</label>
            <div className="model-selector-current">
              {planningUsingDefault ? (
                <span className="model-badge model-badge-default">
                  Using default{effectivePlanning.provider && effectivePlanning.modelId ? ` (${effectivePlanning.provider}/${effectivePlanning.modelId})` : ""}
                </span>
              ) : (
                <span className="model-badge model-badge-custom">
                  {savedPlanning.provider && <ProviderIcon provider={savedPlanning.provider} size="sm" />}
                  {savedPlanning.provider}/{savedPlanning.modelId}
                </span>
              )}
            </div>
            <CustomModelDropdown
              id="planningModel"
              label="Planning Model"
              value={planningValue}
              onChange={handlePlanningChange}
              models={availableModels}
              disabled={isSaving}
              placeholder="Select planning model…"
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
            />
            <small>The AI model used for task specification (triage phase).</small>
          </div>

          <div className="form-group">
            <label htmlFor="thinkingLevel">Thinking Level</label>
            <div className="model-selector-current">
              {savedThinking === null ? (
                <span className="model-badge model-badge-default">
                  Using default ({settings?.defaultThinkingLevel ?? "off"})
                </span>
              ) : (
                <span className="model-badge model-badge-custom">
                  {savedThinking}
                </span>
              )}
            </div>
            <select
              id="thinkingLevel"
              value={selectedThinking ?? ""}
              onChange={(e) => handleThinkingChange(e.target.value)}
              disabled={isSaving}
              className="thinking-level-select"
            >
              <option value="">Default ({settings?.defaultThinkingLevel ?? "off"})</option>
              <option value="off">Off</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <small>Controls the reasoning effort for the AI agent. Higher levels use more tokens.</small>
          </div>

          <div className="model-selector-status">
            {executorUsingDefault && validatorUsingDefault && planningUsingDefault && savedThinking === null
              ? "Using global default models."
              : "Model settings are up to date."}
          </div>
        </>
      )}
    </div>
  );
}
