import { useState, useEffect, useCallback } from "react";
import { fetchModels, updateTask } from "../api";
import type { ModelInfo } from "../api";
import type { Task, TaskDetail } from "@kb/core";
import type { ToastType } from "../hooks/useToast";

interface ModelSelectorTabProps {
  task: Task | TaskDetail;
  addToast: (message: string, type?: ToastType) => void;
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

  // Group models by provider
  const modelsByProvider = availableModels.reduce<Record<string, ModelInfo[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  // Build select values (provider/id combination or empty for default)
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
            <select
              id="executorModel"
              value={executorValue}
              onChange={(e) => handleExecutorChange(e.target.value)}
              disabled={isSaving}
            >
              <option value="">Use default</option>
              {Object.entries(modelsByProvider).map(([provider, models]) => (
                <optgroup key={provider} label={provider}>
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
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
            <select
              id="validatorModel"
              value={validatorValue}
              onChange={(e) => handleValidatorChange(e.target.value)}
              disabled={isSaving}
            >
              <option value="">Use default</option>
              {Object.entries(modelsByProvider).map(([provider, models]) => (
                <optgroup key={provider} label={provider}>
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
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
