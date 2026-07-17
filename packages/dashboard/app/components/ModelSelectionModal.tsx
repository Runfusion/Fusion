import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ModelPreset, ThinkingLevel } from "@fusion/core";
import type { ModelInfo } from "../api";
import { applyPresetToSelection } from "../utils/modelPresets";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { Brain, X } from "lucide-react";
import { LoadingSpinner } from "./LoadingSpinner";

const PRESET_OPTION_SEPARATOR = "──────────";

interface ModelSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  models: ModelInfo[];
  executorValue: string;
  validatorValue: string;
  planningValue?: string;
  mergerValue?: string;
  onExecutorChange: (value: string) => void;
  onValidatorChange: (value: string) => void;
  onPlanningChange?: (value: string) => void;
  onMergerChange?: (value: string) => void;
  mergerThinkingLevel?: string;
  onMergerThinkingLevelChange?: (value: string) => void;
  validatorThinkingLevel?: string;
  onValidatorThinkingLevelChange?: (value: string) => void;
  planningThinkingLevel?: string;
  onPlanningThinkingLevelChange?: (value: string) => void;
  /** Current thinking-level override, or "" for the effective default. Optional so pre-existing callers keep compiling unchanged. */
  thinkingLevel?: string;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-09-00:00:
   * The quick-create "Select Models" dialog must expose the same thinking (reasoning-effort) levels — including `xhigh` —
   * as the full task pickers (TaskForm, ModelSelectorTab), so a task created from the board carries the same override
   * surface as one created from the New Task modal. The selector is rendered only when this handler is provided,
   * mirroring the existing optional `onPlanningChange` pattern.
   */
  onThinkingLevelChange?: (value: string) => void;
  /** Effective default thinking level shown in the Default option, e.g. project/global `defaultThinkingLevel` (falls back to "off"). */
  defaultThinkingLevel?: ThinkingLevel;
  modelsLoading: boolean;
  modelsError: string | null;
  onRetry: () => void;
  favoriteProviders?: string[];
  onToggleFavorite?: (provider: string) => void;
  favoriteModels?: string[];
  onToggleModelFavorite?: (modelId: string) => void;
  /** Available model presets for quick selection. When provided, a preset selector is shown. */
  presets?: ModelPreset[];
  /** Currently selected preset ID, or undefined if no preset is active. */
  selectedPresetId?: string;
  /** Called when the user selects a preset or reverts to default/custom mode. */
  onPresetChange?: (presetId: string | undefined) => void;
}

function getModelBadgeLabel(models: ModelInfo[], value: string, t: TFunction<"app">): string {
  if (!value) return t("modelSelection.usingDefault", "Using default");
  const slashIdx = value.indexOf("/");
  if (slashIdx === -1) return value;
  const provider = value.slice(0, slashIdx);
  const modelId = value.slice(slashIdx + 1);
  const matched = models.find((m) => m.provider === provider && m.id === modelId);
  return matched ? `${matched.provider}/${matched.id}` : `${provider}/${modelId}`;
}

export function ModelSelectionModal({
  isOpen,
  onClose,
  models,
  executorValue,
  validatorValue,
  planningValue = "",
  mergerValue = "",
  onExecutorChange,
  onValidatorChange,
  onPlanningChange,
  onMergerChange,
  mergerThinkingLevel = "",
  onMergerThinkingLevelChange,
  validatorThinkingLevel = "",
  onValidatorThinkingLevelChange,
  planningThinkingLevel = "",
  onPlanningThinkingLevelChange,
  thinkingLevel = "",
  onThinkingLevelChange,
  defaultThinkingLevel,
  modelsLoading,
  modelsError,
  onRetry,
  favoriteProviders = [],
  onToggleFavorite,
  favoriteModels = [],
  onToggleModelFavorite,
  presets,
  selectedPresetId,
  onPresetChange,
}: ModelSelectionModalProps) {
  const { t } = useTranslation("app");
  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Handle overlay click
  const handleOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const showPresets = !!(presets && presets.length > 0 && onPresetChange);
  const selectedPreset = presets?.find((p) => p.id === selectedPresetId);

  const handlePresetSelect = useCallback(
    (value: string) => {
      if (!onPresetChange) return;
      if (value === "default") {
        onPresetChange(undefined);
        onExecutorChange("");
        onValidatorChange("");
        onPlanningChange?.("");
        return;
      }
      if (value === "custom") {
        onPresetChange(undefined);
        return;
      }
      const preset = presets?.find((p) => p.id === value);
      if (preset) {
        const selection = applyPresetToSelection(preset);
        onExecutorChange(selection.executorValue);
        onValidatorChange(selection.validatorValue);
        onPresetChange(preset.id);
      }
    },
    [onPresetChange, presets, onExecutorChange, onValidatorChange],
  );

  const handleExecutorChange = useCallback(
    (value: string) => {
      // Manual model selection clears preset mode
      if (onPresetChange && selectedPresetId) {
        onPresetChange(undefined);
      }
      onExecutorChange(value);
    },
    [onPresetChange, selectedPresetId, onExecutorChange],
  );

  const handleValidatorChange = useCallback(
    (value: string) => {
      // Manual model selection clears preset mode
      if (onPresetChange && selectedPresetId) {
        onPresetChange(undefined);
      }
      onValidatorChange(value);
    },
    [onPresetChange, selectedPresetId, onValidatorChange],
  );

  const handlePlanningChange = useCallback(
    (value: string) => {
      // Manual model selection clears preset mode
      if (onPresetChange && selectedPresetId) {
        onPresetChange(undefined);
      }
      onPlanningChange?.(value);
    },
    [onPresetChange, selectedPresetId, onPlanningChange],
  );

  if (!isOpen) return null;

  const hasExecutorOverride = Boolean(executorValue);
  const hasValidatorOverride = Boolean(validatorValue);
  const hasPlanningOverride = Boolean(planningValue);
  const hasMergerOverride = Boolean(mergerValue);

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} role="dialog" aria-modal="true" data-testid="model-selection-modal">
      <div className="modal modal-lg">
        <div className="modal-header">
          <div className="detail-title-row">
            <Brain size={20} style={{ color: "var(--todo)" }} />
            <h3>{t("modelSelection.title", "Select Models")}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label={t("actions.close", "Close")} data-testid="model-selection-close">
            <X size={20} />
          </button>
        </div>

        <div className="planning-modal-body">
          {modelsLoading ? (
            <div className="planning-loading">
              <div className="detail-section">
                <p className="text-muted"><LoadingSpinner label={t("modelSelection.loading", "Loading models…")} /></p>
              </div>
            </div>
          ) : modelsError ? (
            <div className="detail-section">
              <div className="form-error planning-error">
                <span>{modelsError}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={onRetry} data-testid="model-selection-retry">
                {t("actions.retry", "Retry")}
              </button>
            </div>
          ) : models.length === 0 ? (
            <div className="detail-section">
              <div className="inline-create-model-empty">
                {t("modelSelection.noModels", "No models available. Configure authentication in Settings to enable model selection.")}
              </div>
            </div>
          ) : (
            <div className="planning-summary">
              <div className="planning-view-scroll planning-summary-scroll">
                <div className="planning-summary-header">
                  <p className="text-muted">{t("modelSelection.choose", "Choose models for this task. If not selected, default models will be used.")}</p>
                </div>

                <div className="planning-summary-form">
                  {showPresets && (
                    <div className="task-detail-section">
                      <div className="inline-create-model-row">
                        <label htmlFor="model-selection-preset" className="inline-create-model-label">
                          {t("modelSelection.preset", "Preset")}
                        </label>
                        <span
                          className={`model-badge ${selectedPresetId ? "model-badge-custom" : "model-badge-default"}`}
                          data-testid="preset-badge"
                        >
                          {selectedPreset ? selectedPreset.name : t("modelSelection.useDefault", "Use default")}
                        </span>
                        <select
                          id="model-selection-preset"
                          value={selectedPresetId || "default"}
                          onChange={(e) => handlePresetSelect(e.target.value)}
                          data-testid="model-selection-preset"
                        >
                          <option value="default">{t("modelSelection.useDefault", "Use default")}</option>
                          {presets!.length > 0 && <option disabled>{PRESET_OPTION_SEPARATOR}</option>}
                          {presets!.map((preset) => (
                            <option key={preset.id} value={preset.id}>{preset.name}</option>
                          ))}
                          <option value="custom">{t("modelSelection.custom", "Custom")}</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {onPlanningChange ? (
                    <div className="task-detail-section">
                      <div className="inline-create-model-row">
                        <label htmlFor="model-selection-planning" className="inline-create-model-label">
                          {t("modelSelection.planningModel", "Planning Model")}
                        </label>
                        <span
                          className={`model-badge ${hasPlanningOverride ? "model-badge-custom" : "model-badge-default"}`}
                          data-testid="planning-badge"
                        >
                          {getModelBadgeLabel(models, planningValue, t)}
                        </span>
                        <CustomModelDropdown
                          id="model-selection-planning"
                          label={t("modelSelection.planningModel", "Planning Model")}
                          value={planningValue}
                          onChange={handlePlanningChange}
                          models={models}
                          placeholder={t("modelSelection.planningPlaceholder", "Select planning model…")}
                          favoriteProviders={favoriteProviders}
                          onToggleFavorite={onToggleFavorite}
                          favoriteModels={favoriteModels}
                          onToggleModelFavorite={onToggleModelFavorite}
                          thinkingLevel={planningThinkingLevel}
                          onThinkingLevelChange={onPlanningThinkingLevelChange}
                          defaultThinkingLevel={defaultThinkingLevel ?? "off"}
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className="task-detail-section">
                    <div className="inline-create-model-row">
                      <label htmlFor="model-selection-executor" className="inline-create-model-label">
                        {t("modelSelection.executorModel", "Executor Model")}
                      </label>
                      <span
                        className={`model-badge ${hasExecutorOverride ? "model-badge-custom" : "model-badge-default"}`}
                        data-testid="executor-badge"
                      >
                        {getModelBadgeLabel(models, executorValue, t)}
                      </span>
                      <CustomModelDropdown
                        id="model-selection-executor"
                        label={t("modelSelection.executorModel", "Executor Model")}
                        value={executorValue}
                        onChange={handleExecutorChange}
                        models={models}
                        placeholder={t("modelSelection.executorPlaceholder", "Select executor model…")}
                        favoriteProviders={favoriteProviders}
                        onToggleFavorite={onToggleFavorite}
                        favoriteModels={favoriteModels}
                        onToggleModelFavorite={onToggleModelFavorite}
                        thinkingLevel={thinkingLevel}
                        onThinkingLevelChange={onThinkingLevelChange}
                        defaultThinkingLevel={defaultThinkingLevel ?? "off"}
                      />
                    </div>
                  </div>

                  {onMergerChange ? <div className="task-detail-section"><div className="inline-create-model-row">
                    <label htmlFor="model-selection-merger" className="inline-create-model-label">{t("tasks.mergerModel", "Merger Model")}</label>
                    <span className={`model-badge ${hasMergerOverride ? "model-badge-custom" : "model-badge-default"}`}>{getModelBadgeLabel(models, mergerValue, t)}</span>
                    <CustomModelDropdown id="model-selection-merger" label={t("tasks.mergerModel", "Merger Model")} value={mergerValue} onChange={onMergerChange} models={models} placeholder={t("tasks.usingDefault", "Using default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} thinkingLevel={mergerThinkingLevel} onThinkingLevelChange={onMergerThinkingLevelChange} defaultThinkingLevel={defaultThinkingLevel ?? "off"} />
                  </div></div> : null}

                  <div className="task-detail-section">
                    <div className="inline-create-model-row">
                      <label htmlFor="model-selection-validator" className="inline-create-model-label">
                        {t("modelSelection.reviewerModel", "Reviewer Model")}
                      </label>
                      <span
                        className={`model-badge ${hasValidatorOverride ? "model-badge-custom" : "model-badge-default"}`}
                        data-testid="validator-badge"
                      >
                        {getModelBadgeLabel(models, validatorValue, t)}
                      </span>
                      <CustomModelDropdown
                        id="model-selection-validator"
                        label={t("modelSelection.reviewerModel", "Reviewer Model")}
                        value={validatorValue}
                        onChange={handleValidatorChange}
                        models={models}
                        placeholder={t("modelSelection.reviewerPlaceholder", "Select reviewer model…")}
                        favoriteProviders={favoriteProviders}
                        onToggleFavorite={onToggleFavorite}
                        favoriteModels={favoriteModels}
                        onToggleModelFavorite={onToggleModelFavorite}
                        thinkingLevel={validatorThinkingLevel}
                        onThinkingLevelChange={onValidatorThinkingLevelChange}
                        defaultThinkingLevel={defaultThinkingLevel ?? "off"}
                      />
                    </div>
                  </div>

                </div>
              </div>

              <div className="planning-actions planning-summary-actions">
                <button className="btn" onClick={onClose} data-testid="model-selection-done">
                  {t("actions.done", "Done")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
