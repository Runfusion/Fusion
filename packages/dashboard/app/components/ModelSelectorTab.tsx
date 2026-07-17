import "./ModelSelectorTab.css";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { updateTask } from "../api";
import type { Settings, Task, TaskDetail } from "@fusion/core";
import {
  getErrorMessage,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveTaskMergerModel,
} from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { useFavorites } from "../hooks/useFavorites";
import { useModelsCache } from "../hooks/useModelsCache";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";
import { LoadingSpinner } from "./LoadingSpinner";

interface ModelSelectorTabProps {
  task: Task | TaskDetail;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
  settings?: Settings;
  projectId?: string;
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

function getMergerSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.mergerModelProvider),
    modelId: normalizeModelField(task.mergerModelId),
  };
}

function resolveEffectiveExecutor(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  return resolveTaskExecutionModel(task, settings);
}

function resolveEffectiveValidator(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  return resolveTaskValidatorModel(task, settings);
}

function resolveEffectivePlanning(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  return resolveTaskPlanningModel(task, settings);
}

function resolveEffectiveMerger(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  return resolveTaskMergerModel(task, settings);
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

function getSuccessToastMessage(
  target: "executor" | "validator" | "planning" | "merger",
  selection: ModelSelection,
  t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string,
): string {
  const labelKeys: Record<string, { key: string; defaultValue: string }> = {
    executor: { key: "models.targetLabels.executor", defaultValue: "Executor" },
    validator: { key: "models.targetLabels.validator", defaultValue: "Reviewer" },
    planning: { key: "models.targetLabels.planning", defaultValue: "Planning" },
    merger: { key: "tasks.mergerModel", defaultValue: "Merger" },
  };
  const labelEntry = labelKeys[target] ?? { key: `models.targetLabels.${target}`, defaultValue: target };
  const label = t(labelEntry.key, labelEntry.defaultValue);

  if (!selection.provider || !selection.modelId) {
    return t("models.messages.modelSetToDefault", "{{label}} model set to default", { label });
  }

  return t("models.messages.modelSetTo", "{{label}} model set to {{provider}}/{{modelId}}", {
    label,
    provider: selection.provider,
    modelId: selection.modelId,
  });
}

export function ModelSelectorTab({ task, addToast, onTaskUpdated, settings, projectId }: ModelSelectorTabProps) {
  const { t } = useTranslation("app");
  const {
    availableModels,
    favoriteProviders,
    favoriteModels,
    toggleFavoriteProvider,
    toggleFavoriteModel,
  } = useFavorites();
  const { loading: modelsLoading } = useModelsCache();

  const [selectedExecutor, setSelectedExecutor] = useState<ModelSelection>(() => getExecutorSelection(task));
  const [savedExecutor, setSavedExecutor] = useState<ModelSelection>(() => getExecutorSelection(task));
  const [selectedValidator, setSelectedValidator] = useState<ModelSelection>(() => getValidatorSelection(task));
  const [savedValidator, setSavedValidator] = useState<ModelSelection>(() => getValidatorSelection(task));
  const [selectedPlanning, setSelectedPlanning] = useState<ModelSelection>(() => getPlanningSelection(task));
  const [savedPlanning, setSavedPlanning] = useState<ModelSelection>(() => getPlanningSelection(task));
  const [selectedMerger, setSelectedMerger] = useState<ModelSelection>(() => getMergerSelection(task));
  const [savedMerger, setSavedMerger] = useState<ModelSelection>(() => getMergerSelection(task));
  const [selectedThinking, setSelectedThinking] = useState<string | null>(() => task.thinkingLevel ?? null);
  const [savedThinking, setSavedThinking] = useState<string | null>(() => task.thinkingLevel ?? null);
  const [selectedValidatorThinking, setSelectedValidatorThinking] = useState<string | null>(() => task.validatorThinkingLevel ?? null);
  const [savedValidatorThinking, setSavedValidatorThinking] = useState<string | null>(() => task.validatorThinkingLevel ?? null);
  const [selectedPlanningThinking, setSelectedPlanningThinking] = useState<string | null>(() => task.planningThinkingLevel ?? null);
  const [savedPlanningThinking, setSavedPlanningThinking] = useState<string | null>(() => task.planningThinkingLevel ?? null);
  const [selectedMergerThinking, setSelectedMergerThinking] = useState<string | null>(() => task.mergerThinkingLevel ?? null);
  const [savedMergerThinking, setSavedMergerThinking] = useState<string | null>(() => task.mergerThinkingLevel ?? null);
  const [savingTarget, setSavingTarget] = useState<"executor" | "validator" | "planning" | "merger" | "thinking" | null>(null);

  const activeTaskIdRef = useRef(task.id);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    try {
      await toggleFavoriteProvider(provider);
    } catch {
      addToast(t("models.errors.failedUpdateFavorites", "Failed to update favorites"), "error");
    }
  }, [toggleFavoriteProvider, addToast, t]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    try {
      await toggleFavoriteModel(modelId);
    } catch {
      addToast(t("models.errors.failedUpdateModelFavorites", "Failed to update model favorites"), "error");
    }
  }, [toggleFavoriteModel, addToast, t]);

  useEffect(() => {
    activeTaskIdRef.current = task.id;

    const nextExecutor = getExecutorSelection(task);
    const nextValidator = getValidatorSelection(task);
    const nextPlanning = getPlanningSelection(task);
    const nextMerger = getMergerSelection(task);

    setSelectedExecutor(nextExecutor);
    setSavedExecutor(nextExecutor);
    setSelectedValidator(nextValidator);
    setSavedValidator(nextValidator);
    setSelectedPlanning(nextPlanning);
    setSavedPlanning(nextPlanning);
    setSelectedMerger(nextMerger);
    setSavedMerger(nextMerger);
    const nextThinking = task.thinkingLevel ?? null;
    const nextValidatorThinking = task.validatorThinkingLevel ?? null;
    const nextPlanningThinking = task.planningThinkingLevel ?? null;
    const nextMergerThinking = task.mergerThinkingLevel ?? null;
    setSelectedThinking(nextThinking);
    setSavedThinking(nextThinking);
    setSelectedValidatorThinking(nextValidatorThinking);
    setSavedValidatorThinking(nextValidatorThinking);
    setSelectedPlanningThinking(nextPlanningThinking);
    setSavedPlanningThinking(nextPlanningThinking);
    setSelectedMergerThinking(nextMergerThinking);
    setSavedMergerThinking(nextMergerThinking);
    setSavingTarget(null);
  }, [task.id, task.modelProvider, task.modelId, task.validatorModelProvider, task.validatorModelId, task.planningModelProvider, task.planningModelId, task.mergerModelProvider, task.mergerModelId, task.thinkingLevel, task.validatorThinkingLevel, task.planningThinkingLevel, task.mergerThinkingLevel]);

  const executorValue = useMemo(() => getDropdownValue(selectedExecutor), [selectedExecutor]);
  const validatorValue = useMemo(() => getDropdownValue(selectedValidator), [selectedValidator]);
  const planningValue = useMemo(() => getDropdownValue(selectedPlanning), [selectedPlanning]);
  const mergerValue = useMemo(() => getDropdownValue(selectedMerger), [selectedMerger]);
  const effectiveExecutor = useMemo(() => resolveEffectiveExecutor(task, settings), [task, settings]);
  const effectiveValidator = useMemo(() => resolveEffectiveValidator(task, settings), [task, settings]);
  const effectivePlanning = useMemo(() => resolveEffectivePlanning(task, settings), [task, settings]);
  const effectiveMerger = useMemo(() => resolveEffectiveMerger(task, settings), [task, settings]);
  const isSaving = savingTarget !== null;

  const saveSelection = useCallback(
    async (target: "executor" | "validator" | "planning" | "merger", nextSelection: ModelSelection) => {
      const requestTaskId = task.id;
      const previousSavedExecutor = savedExecutor;
      const previousSavedValidator = savedValidator;
      const previousSavedPlanning = savedPlanning;
      const previousSavedMerger = savedMerger;

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
              : target === "merger"
                ? {
                    mergerModelProvider: nextSelection.provider ?? null,
                    mergerModelId: nextSelection.modelId ?? null,
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
              mergerModelProvider: (target === "merger" ? nextSelection : savedMerger).provider ?? null,
              mergerModelId: (target === "merger" ? nextSelection : savedMerger).modelId ?? null,
            };

        /*
        FNXC:TaskDetailModels 2026-07-01-00:00:
        Task-detail model saves must carry the active project id through the shared update API. Multi-project task detail views can otherwise patch the default project route and surface a false "Task not found" toast for existing scoped tasks.
        */
        const updatedTask = await updateTask(requestTaskId, updates, projectId);

        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        const nextSavedExecutor = getExecutorSelection(updatedTask);
        const nextSavedValidator = getValidatorSelection(updatedTask);
        const nextSavedPlanning = getPlanningSelection(updatedTask);
        const nextSavedMerger = getMergerSelection(updatedTask);

        setSavedExecutor(nextSavedExecutor);
        setSelectedExecutor(nextSavedExecutor);
        setSavedValidator(nextSavedValidator);
        setSelectedValidator(nextSavedValidator);
        setSavedPlanning(nextSavedPlanning);
        setSelectedPlanning(nextSavedPlanning);
        setSavedMerger(nextSavedMerger);
        setSelectedMerger(nextSavedMerger);
        onTaskUpdated?.(updatedTask);

        const targetSelections: Record<string, ModelSelection> = {
          executor: nextSavedExecutor,
          validator: nextSavedValidator,
          planning: nextSavedPlanning,
          merger: nextSavedMerger,
        };

        addToast(
          getSuccessToastMessage(target, targetSelections[target], t),
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
        } else if (target === "planning") {
          setSelectedPlanning(previousSavedPlanning);
        } else {
          setSelectedMerger(previousSavedMerger);
        }

        addToast(getErrorMessage(err) || t("models.errors.failedSaveSettings", "Failed to save model settings"), "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedExecutor, savedValidator, savedPlanning, savedMerger, addToast, onTaskUpdated, projectId, t],
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

  const handleMergerChange = useCallback(
    (value: string) => {
      const nextSelection = parseModelValue(value);
      setSelectedMerger(nextSelection);
      if (!selectionsEqual(nextSelection, savedMerger)) void saveSelection("merger", nextSelection);
    },
    [savedMerger, saveSelection],
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
        }, projectId);

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
            t("models.messages.thinkingLevelSetDefault", "Thinking level set to default ({{level}})", { level: effectiveDefault }),
            "success",
          );
        } else {
          addToast(
            t("models.messages.thinkingLevelSet", "Thinking level set to {{level}}", { level: nextThinking }),
            "success",
          );
        }
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        setSelectedThinking(previousThinking);
        addToast(getErrorMessage(err) || t("models.errors.failedSaveThinking", "Failed to save thinking level"), "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedThinking, settings, addToast, onTaskUpdated, projectId, t],
  );

  const handleValidatorThinkingChange = useCallback(
    async (value: string) => {
      const requestTaskId = task.id;
      const previousThinking = savedValidatorThinking;
      const nextValue = value === "" ? null : value;

      setSelectedValidatorThinking(nextValue);
      setSavingTarget("thinking");

      try {
        const updatedTask = await updateTask(requestTaskId, {
          validatorThinkingLevel: nextValue,
        }, projectId);

        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        const nextThinking = updatedTask.validatorThinkingLevel ?? null;
        setSavedValidatorThinking(nextThinking);
        setSelectedValidatorThinking(nextThinking);
        onTaskUpdated?.(updatedTask);

        const effectiveDefault = settings?.defaultThinkingLevel ?? "off";
        if (nextThinking === null) {
          addToast(
            t("models.messages.thinkingLevelSetDefault", "Thinking level set to default ({{level}})", { level: effectiveDefault }),
            "success",
          );
        } else {
          addToast(
            t("models.messages.thinkingLevelSet", "Thinking level set to {{level}}", { level: nextThinking }),
            "success",
          );
        }
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        setSelectedValidatorThinking(previousThinking);
        addToast(getErrorMessage(err) || t("models.errors.failedSaveThinking", "Failed to save thinking level"), "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedValidatorThinking, settings, addToast, onTaskUpdated, projectId, t],
  );

  const handlePlanningThinkingChange = useCallback(
    async (value: string) => {
      const requestTaskId = task.id;
      const previousThinking = savedPlanningThinking;
      const nextValue = value === "" ? null : value;

      setSelectedPlanningThinking(nextValue);
      setSavingTarget("thinking");

      try {
        const updatedTask = await updateTask(requestTaskId, {
          planningThinkingLevel: nextValue,
        }, projectId);

        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        const nextThinking = updatedTask.planningThinkingLevel ?? null;
        setSavedPlanningThinking(nextThinking);
        setSelectedPlanningThinking(nextThinking);
        onTaskUpdated?.(updatedTask);

        const effectiveDefault = settings?.defaultThinkingLevel ?? "off";
        if (nextThinking === null) {
          addToast(
            t("models.messages.thinkingLevelSetDefault", "Thinking level set to default ({{level}})", { level: effectiveDefault }),
            "success",
          );
        } else {
          addToast(
            t("models.messages.thinkingLevelSet", "Thinking level set to {{level}}", { level: nextThinking }),
            "success",
          );
        }
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }

        setSelectedPlanningThinking(previousThinking);
        addToast(getErrorMessage(err) || t("models.errors.failedSaveThinking", "Failed to save thinking level"), "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingTarget(null);
        }
      }
    },
    [task.id, savedPlanningThinking, settings, addToast, onTaskUpdated, projectId, t],
  );

  const handleMergerThinkingChange = useCallback(async (value: string) => {
    const requestTaskId = task.id;
    const previousThinking = savedMergerThinking;
    const nextValue = value === "" ? null : value;
    setSelectedMergerThinking(nextValue);
    setSavingTarget("thinking");
    try {
      const updatedTask = await updateTask(requestTaskId, { mergerThinkingLevel: nextValue }, projectId);
      if (activeTaskIdRef.current !== requestTaskId) return;
      const nextThinking = updatedTask.mergerThinkingLevel ?? null;
      setSavedMergerThinking(nextThinking);
      setSelectedMergerThinking(nextThinking);
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      if (activeTaskIdRef.current !== requestTaskId) return;
      setSelectedMergerThinking(previousThinking);
      addToast(getErrorMessage(err) || t("models.errors.failedSaveThinking", "Failed to save thinking level"), "error");
    } finally {
      if (activeTaskIdRef.current === requestTaskId) setSavingTarget(null);
    }
  }, [task.id, savedMergerThinking, addToast, onTaskUpdated, projectId, t]);

  /*
   * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
   * Reviewer, Planning, and Merger task-detail model boxes carry independent per-lane reasoning-effort overrides. Merger selection reuses CustomModelDropdown and remains independent of its provider/model pair.
   */
  const executorUsingDefault = !savedExecutor.provider && !savedExecutor.modelId;
  const validatorUsingDefault = !savedValidator.provider && !savedValidator.modelId;
  const planningUsingDefault = !savedPlanning.provider && !savedPlanning.modelId;
  const mergerUsingDefault = !savedMerger.provider && !savedMerger.modelId;

  return (
    <div className="model-selector-tab">
      <h4>{t("models.titles.configuration", "Model Configuration")}</h4>
      <p className="model-selector-intro">
        {t("models.descriptions.override", "Override the AI models used for this task. When not specified, project or global defaults are used.")}
      </p>

      {modelsLoading ? (
        <div className="model-selector-loading"><LoadingSpinner label={t("models.states.loading", "Loading available models…")} /></div>
      ) : availableModels.length === 0 ? (
        <div className="model-selector-empty">
          {t("models.emptyStates.noModels", "No models available. Configure authentication in Settings to enable model selection.")}
        </div>
      ) : (
        <>
          <div className="form-group">
            <label htmlFor="executorModel">{t("models.labels.executorModel", "Executor Model")}</label>
            <div className="model-selector-current">
              {executorUsingDefault ? (
                <span className="model-badge model-badge-default">
                  {t("models.states.usingDefault", "Using default")}{effectiveExecutor.provider && effectiveExecutor.modelId ? ` (${effectiveExecutor.provider}/${effectiveExecutor.modelId})` : ""}
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
              label={t("models.labels.executorModel", "Executor Model")}
              value={executorValue}
              onChange={handleExecutorChange}
              models={availableModels}
              disabled={isSaving}
              placeholder={t("models.placeholders.selectExecutor", "Select executor model…")}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
              thinkingLevel={selectedThinking ?? ""}
              onThinkingLevelChange={handleThinkingChange}
              defaultThinkingLevel={settings?.defaultThinkingLevel ?? "off"}
            />
            <small>{t("models.descriptions.executor", "The AI model used to implement this task.")}</small>
          </div>

          <div className="form-group">
            <label htmlFor="validatorModel">{t("models.labels.reviewerModel", "Reviewer Model")}</label>
            <div className="model-selector-current">
              {validatorUsingDefault ? (
                <span className="model-badge model-badge-default">
                  {t("models.states.usingDefault", "Using default")}{effectiveValidator.provider && effectiveValidator.modelId ? ` (${effectiveValidator.provider}/${effectiveValidator.modelId})` : ""}
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
              label={t("models.labels.reviewerModel", "Reviewer Model")}
              value={validatorValue}
              onChange={handleValidatorChange}
              models={availableModels}
              disabled={isSaving}
              placeholder={t("models.placeholders.selectReviewer", "Select reviewer model…")}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
              thinkingLevel={selectedValidatorThinking ?? ""}
              onThinkingLevelChange={handleValidatorThinkingChange}
              defaultThinkingLevel={settings?.defaultThinkingLevel ?? "off"}
            />
            <small>{t("models.descriptions.reviewer", "The AI model used to review code and plans for this task.")}</small>
          </div>

          <div className="form-group">
            <label htmlFor="planningModel">{t("models.labels.planningModel", "Planning Model")}</label>
            <div className="model-selector-current">
              {planningUsingDefault ? (
                <span className="model-badge model-badge-default">
                  {t("models.states.usingDefault", "Using default")}{effectivePlanning.provider && effectivePlanning.modelId ? ` (${effectivePlanning.provider}/${effectivePlanning.modelId})` : ""}
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
              label={t("models.labels.planningModel", "Planning Model")}
              value={planningValue}
              onChange={handlePlanningChange}
              models={availableModels}
              disabled={isSaving}
              placeholder={t("models.placeholders.selectPlanning", "Select planning model…")}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
              thinkingLevel={selectedPlanningThinking ?? ""}
              onThinkingLevelChange={handlePlanningThinkingChange}
              defaultThinkingLevel={settings?.defaultThinkingLevel ?? "off"}
            />
            <small>{t("models.descriptions.planning", "The AI model used for task specification (triage phase).")}</small>
          </div>


          <div className="form-group">
            <label htmlFor="mergerModel">{t("tasks.mergerModel", "Merger Model")}</label>
            <div className="model-selector-current">
              {mergerUsingDefault ? <span className="model-badge model-badge-default">{t("models.states.usingDefault", "Using default")}{effectiveMerger.provider && effectiveMerger.modelId ? ` (${effectiveMerger.provider}/${effectiveMerger.modelId})` : ""}</span> : <span className="model-badge model-badge-custom">{savedMerger.provider && <ProviderIcon provider={savedMerger.provider} size="sm" />}{savedMerger.provider}/{savedMerger.modelId}</span>}
            </div>
            <CustomModelDropdown id="mergerModel" label={t("tasks.mergerModel", "Merger Model")} value={mergerValue} onChange={handleMergerChange} models={availableModels} disabled={isSaving} placeholder={t("tasks.usingDefault", "Using default")} favoriteProviders={favoriteProviders} onToggleFavorite={handleToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={handleToggleModelFavorite} thinkingLevel={selectedMergerThinking ?? ""} onThinkingLevelChange={handleMergerThinkingChange} defaultThinkingLevel={settings?.mergerThinkingLevel ?? "off"} />
            <small>{t("models.descriptions.merger", "The AI model used to merge this task.")}</small>
          </div>

          <div className="model-selector-status">
            {executorUsingDefault && validatorUsingDefault && planningUsingDefault && mergerUsingDefault && savedThinking === null && savedValidatorThinking === null && savedPlanningThinking === null && savedMergerThinking === null
              ? t("models.messages.usingDefaults", "Using project or global default models.")
              : t("models.messages.upToDate", "Model settings are up to date.")}
          </div>
        </>
      )}
    </div>
  );
}
