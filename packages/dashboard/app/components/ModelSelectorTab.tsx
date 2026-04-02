import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchModels, updateTask, updateGlobalSettings } from "../api";
import type { ModelInfo } from "../api";
import type { Task, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";

interface ModelSelectorTabProps {
  task: Task | TaskDetail;
  addToast: (message: string, type?: ToastType) => void;
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

function getSuccessToastMessage(target: "executor" | "validator", selection: ModelSelection): string {
  const label = target === "executor" ? "Executor" : "Validator";

  if (!selection.provider || !selection.modelId) {
    return `${label} model set to default`;
  }

  return `${label} model set to ${selection.provider}/${selection.modelId}`;
}

export function ModelSelectorTab({ task, addToast }: ModelSelectorTabProps) {
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [selectedExecutor, setSelectedExecutor] = useState<ModelSelection>(() => getExecutorSelection(task));
  const [savedExecutor, setSavedExecutor] = useState<ModelSelection>(() => getExecutorSelection(task));
  const [selectedValidator, setSelectedValidator] = useState<ModelSelection>(() => getValidatorSelection(task));
  const [savedValidator, setSavedValidator] = useState<ModelSelection>(() => getValidatorSelection(task));
  const [savingTarget, setSavingTarget] = useState<"executor" | "validator" | null>(null);

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
    } catch (err) {
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
    } catch (err) {
      // Revert on error
      setFavoriteModels(currentFavorites);
      addToast("Failed to update model favorites", "error");
    }
  }, [favoriteModels, favoriteProviders, addToast]);

  useEffect(() => {
    activeTaskIdRef.current = task.id;

    const nextExecutor = getExecutorSelection(task);
    const nextValidator = getValidatorSelection(task);

    setSelectedExecutor(nextExecutor);
    setSavedExecutor(nextExecutor);
    setSelectedValidator(nextValidator);
    setSavedValidator(nextValidator);
    setSavingTarget(null);
  }, [task.id, task.modelProvider, task.modelId, task.validatorModelProvider, task.validatorModelId]);

  const executorValue = useMemo(() => getDropdownValue(selectedExecutor), [selectedExecutor]);
  const validatorValue = useMemo(() => getDropdownValue(selectedValidator), [selectedValidator]);
  const isSaving = savingTarget !== null;

  const saveSelection = useCallback(
    async (target: "executor" | "validator", nextSelection: ModelSelection) => {
      const requestTaskId = task.id;
      const previousSavedExecutor = savedExecutor;
      const previousSavedValidator = savedValidator;

      setSavingTarget(target);

      try {
        const updatedTask = await updateTask(requestTaskId, {
          modelProvider: target === "executor"
            ? nextSelection.provider ?? null
            : previousSavedExecutor.provider ?? null,
          modelId: target === "executor"
            ? nextSelection.modelId ?? null
            : previousSavedExecutor.modelId ?? null,
          validatorModelProvider: target === "validator"
            ? nextSelection.provider ?? null
            : previousSavedValidator.provider ?? null,
          validatorModelId: target === "validator"
            ? nextSelection.modelId ?? null
            : previousSavedValidator.modelId ?? null,
        });

        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        const nextSavedExecutor = getExecutorSelection(updatedTask);
        const nextSavedValidator = getValidatorSelection(updatedTask);

        setSavedExecutor(nextSavedExecutor);
        setSelectedExecutor(nextSavedExecutor);
        setSavedValidator(nextSavedValidator);
        setSelectedValidator(nextSavedValidator);

        addToast(
          getSuccessToastMessage(
            target,
            target === "executor" ? nextSavedExecutor : nextSavedValidator,
          ),
          "success",
        );
      } catch (err: any) {
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        if (target === "executor") {
          setSelectedExecutor(previousSavedExecutor);
        } else {
          setSelectedValidator(previousSavedValidator);
        }

        addToast(err.message || "Failed to save model settings", "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedExecutor, savedValidator, addToast],
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

  const executorUsingDefault = !savedExecutor.provider && !savedExecutor.modelId;
  const validatorUsingDefault = !savedValidator.provider && !savedValidator.modelId;

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
            className="btn btn-sm"
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
                <span className="model-badge model-badge-default">Using default</span>
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
                <span className="model-badge model-badge-default">Using default</span>
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

          <div className="model-selector-status">
            {executorUsingDefault && validatorUsingDefault
              ? "Using global default models."
              : "Model settings are up to date."}
          </div>
        </>
      )}
    </div>
  );
}
