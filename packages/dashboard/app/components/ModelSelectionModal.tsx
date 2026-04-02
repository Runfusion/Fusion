import { useCallback, useEffect } from "react";
import type { ModelInfo } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { Brain, X } from "lucide-react";

interface ModelSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  models: ModelInfo[];
  executorValue: string;
  validatorValue: string;
  onExecutorChange: (value: string) => void;
  onValidatorChange: (value: string) => void;
  modelsLoading: boolean;
  modelsError: string | null;
  onRetry: () => void;
  favoriteProviders?: string[];
  onToggleFavorite?: (provider: string) => void;
  favoriteModels?: string[];
  onToggleModelFavorite?: (modelId: string) => void;
}

function getModelBadgeLabel(models: ModelInfo[], value: string): string {
  if (!value) return "Using default";
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
  onExecutorChange,
  onValidatorChange,
  modelsLoading,
  modelsError,
  onRetry,
  favoriteProviders = [],
  onToggleFavorite,
  favoriteModels = [],
  onToggleModelFavorite,
}: ModelSelectionModalProps) {
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

  if (!isOpen) return null;

  const hasExecutorOverride = Boolean(executorValue);
  const hasValidatorOverride = Boolean(validatorValue);

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} data-testid="model-selection-modal">
      <div className="modal modal-lg">
        <div className="modal-header">
          <div className="detail-title-row">
            <Brain size={20} style={{ color: "var(--todo)" }} />
            <h3>Select Models</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close" data-testid="model-selection-close">
            <X size={20} />
          </button>
        </div>

        <div className="planning-modal-body">
          {modelsLoading ? (
            <div className="planning-loading">
              <div className="detail-section">
                <p className="text-muted">Loading models…</p>
              </div>
            </div>
          ) : modelsError ? (
            <div className="detail-section">
              <div className="form-error planning-error">
                <span>{modelsError}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={onRetry} data-testid="model-selection-retry">
                Retry
              </button>
            </div>
          ) : models.length === 0 ? (
            <div className="detail-section">
              <div className="inline-create-model-empty">
                No models available. Configure authentication in Settings to enable model selection.
              </div>
            </div>
          ) : (
            <div className="planning-summary">
              <div className="planning-view-scroll planning-summary-scroll">
                <div className="planning-summary-header">
                  <p className="text-muted">Choose models for this task. If not selected, default models will be used.</p>
                </div>

                <div className="planning-summary-form">
                  <div className="task-detail-section">
                    <div className="inline-create-model-row">
                      <label htmlFor="model-selection-executor" className="inline-create-model-label">
                        Executor Model
                      </label>
                      <span
                        className={`model-badge ${hasExecutorOverride ? "model-badge-custom" : "model-badge-default"}`}
                        data-testid="executor-badge"
                      >
                        {getModelBadgeLabel(models, executorValue)}
                      </span>
                      <CustomModelDropdown
                        id="model-selection-executor"
                        label="Executor Model"
                        value={executorValue}
                        onChange={onExecutorChange}
                        models={models}
                        placeholder="Select executor model…"
                        favoriteProviders={favoriteProviders}
                        onToggleFavorite={onToggleFavorite}
                        favoriteModels={favoriteModels}
                        onToggleModelFavorite={onToggleModelFavorite}
                      />
                    </div>
                  </div>

                  <div className="task-detail-section">
                    <div className="inline-create-model-row">
                      <label htmlFor="model-selection-validator" className="inline-create-model-label">
                        Validator Model
                      </label>
                      <span
                        className={`model-badge ${hasValidatorOverride ? "model-badge-custom" : "model-badge-default"}`}
                        data-testid="validator-badge"
                      >
                        {getModelBadgeLabel(models, validatorValue)}
                      </span>
                      <CustomModelDropdown
                        id="model-selection-validator"
                        label="Validator Model"
                        value={validatorValue}
                        onChange={onValidatorChange}
                        models={models}
                        placeholder="Select validator model…"
                        favoriteProviders={favoriteProviders}
                        onToggleFavorite={onToggleFavorite}
                        favoriteModels={favoriteModels}
                        onToggleModelFavorite={onToggleModelFavorite}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="planning-actions planning-summary-actions">
                <button className="btn" onClick={onClose} data-testid="model-selection-done">
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
