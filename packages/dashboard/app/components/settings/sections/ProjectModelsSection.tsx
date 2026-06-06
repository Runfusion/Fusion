/**
 * Project Models section (U9 / KTD-10).
 *
 * Project-scoped model configuration that survives the workflow hard-move: token
 * cap, the project DEFAULT model lane, model presets (with the inline editor and
 * size-based auto-selection), and the title/commit summarization toggles. The
 * per-phase execution/planning/validator lanes and the title-summarizer lane
 * moved to the workflow (U4) and render as a redirect stub. The model-lane
 * helpers, preset draft state/handlers, available-model list, favorites, and the
 * confirm dialog all live in the shell (they share state with the save flow and
 * the global model lanes) and are relayed through a `models` prop bag — mirroring
 * the Authentication/Remote section conventions. Keys, lane labels, and
 * conditional rendering are preserved verbatim from the original inline JSX.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ModelPreset, Settings } from "@fusion/core";
import type { ModelInfo } from "../../../api";
import { CustomModelDropdown } from "../../CustomModelDropdown";
import { applyPresetToSelection } from "../../../utils/modelPresets";
import { MovedSettingsStub } from "./MovedSettingsStub";
import type { ModelLane, SectionBaseProps, SettingsFormState } from "./context";

type LaneStatus = "inherited" | "overridden";

export interface ProjectModelsSectionModelProps {
  modelLanes: ModelLane[];
  getLaneStatus: (lane: ModelLane) => LaneStatus;
  getLaneValue: (lane: ModelLane) => string;
  updateLaneValue: (lane: ModelLane, value: string) => void;
  resetLaneValue: (lane: ModelLane) => void;
  availableModels: ModelInfo[];
  modelsLoading: boolean;
  favoriteProviders: string[];
  favoriteModels: string[];
  onToggleFavorite: (provider: string) => void;
  onToggleModelFavorite: (modelId: string) => void;
  editingPresetId: string | null;
  setEditingPresetId: (id: string | null) => void;
  presetDraft: ModelPreset | null;
  setPresetDraft: (updater: ModelPreset | null | ((prev: ModelPreset | null) => ModelPreset | null)) => void;
  onSavePresetDraft: () => void;
  confirmDelete: (options: { title: string; message: string; danger?: boolean }) => Promise<boolean>;
}

export interface ProjectModelsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  models: ProjectModelsSectionModelProps;
  onOpenWorkflowSettings?: () => void;
}

export function ProjectModelsSection({ scopeBanner, form, setForm, models, onOpenWorkflowSettings }: ProjectModelsSectionProps) {
  const { t } = useTranslation("app");
  const {
    modelLanes,
    getLaneStatus,
    getLaneValue,
    updateLaneValue,
    resetLaneValue,
    availableModels,
    modelsLoading,
    favoriteProviders,
    favoriteModels,
    onToggleFavorite,
    onToggleModelFavorite,
    editingPresetId,
    setEditingPresetId,
    presetDraft,
    setPresetDraft,
    onSavePresetDraft,
    confirmDelete,
  } = models;

  const presets = form.modelPresets || [];
  const presetOptions = presets.map((preset) => ({ id: preset.id, name: preset.name }));
  const inUsePresetIds = new Set(Object.values(form.defaultPresetBySize || {}).filter(Boolean));

  // Only the project DEFAULT model lane survives in this modal. The
  // per-phase execution/planning/validator lanes, their fallbacks, and the
  // title-summarizer lane were hard-moved (U4) onto the workflow settings
  // mechanism — they are no longer project settings keys and must never be
  // renderable or savable here (redirect stub below).
  const projectModelLanes = modelLanes.filter((lane) => lane.laneId === "default");
  const getProjectLaneLabel = (lane: ModelLane) => lane.laneId === "default" ? "Project Default Model" : lane.label;
  const getProjectLaneHelperText = (lane: ModelLane) =>
    lane.laneId === "default"
      ? "Project-wide default AI model used when no more specific task or project lane override is set."
      : lane.helperText;

  return (
    <>
      {scopeBanner}

      {/* --- Token Cap --- */}
      <h4 className="settings-section-heading">Token Cap</h4>
      <div className="form-group">
        <label htmlFor="tokenCap">Token Cap</label>
        <div className="settings-token-cap-row">
          <input
            id="tokenCap"
            type="number"
            placeholder="No cap"
            value={form.tokenCap ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              setForm((f) => ({ ...f, tokenCap: val ? parseInt(val, 10) : null } as SettingsFormState));
            }}
          />
          {form.tokenCap != null && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Reset to default (no cap)"
              onClick={() => setForm((f) => ({ ...f, tokenCap: null } as unknown as SettingsFormState))}
              style={{ whiteSpace: "nowrap" }}
            >
              Reset
            </button>
          )}
        </div>
        <small>Automatically compact context when approaching this token count. Leave empty for no cap (compact only on overflow errors). Set a number to proactively compact when reaching this token count.</small>
      </div>

      {/* --- Project Model Lanes --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">Model Lanes</h4>
      <p className="settings-description">
        Override global model settings at the project level. Each lane controls a specific AI usage context.
        Unset lanes inherit from the corresponding global lane.
        The Project Default Model is the fallback for this project when a more specific lane is unset.
      </p>
      {modelsLoading ? (
        <div className="settings-empty-state">Loading available models…</div>
      ) : availableModels.length === 0 ? (
        <div className="settings-empty-state settings-muted">
          No models available. Configure authentication first.
        </div>
      ) : (
        <>
          {projectModelLanes.map((lane) => {
            const status = getLaneStatus(lane);
            const value = getLaneValue(lane);
            const isOverridden = status === "overridden";
            const laneLabel = getProjectLaneLabel(lane);

            return (
              <div className="form-group" key={lane.laneId}>
                <div className="settings-model-lane-label-row">
                  <label htmlFor={`${lane.laneId}Model`}>{laneLabel}</label>
                  <span
                    className={`settings-lane-badge ${isOverridden ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`}
                    title={isOverridden ? "Explicitly set for this project" : "Inherited from global settings"}
                  >
                    {isOverridden ? "Override (Project)" : "Inherited (Global)"}
                  </span>
                </div>
                <div className="settings-model-lane-control-row">
                  <div className="settings-model-lane-control-main">
                    <CustomModelDropdown
                      id={`${lane.laneId}Model`}
                      label={laneLabel}
                      models={availableModels}
                      value={value}
                      onChange={(val) => updateLaneValue(lane, val)}
                      placeholder={lane.laneId === "default" ? "Use global default" : "Use global"}
                      favoriteProviders={favoriteProviders}
                      onToggleFavorite={onToggleFavorite}
                      favoriteModels={favoriteModels}
                      onToggleModelFavorite={onToggleModelFavorite}
                    />
                  </div>
                  {isOverridden && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title="Reset to inherit from global"
                      onClick={() => resetLaneValue(lane)}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <small>
                  {getProjectLaneHelperText(lane)} Falls back to: {lane.fallbackOrder}.
                </small>
              </div>
            );
          })}
        </>
      )}

      {/* --- Per-phase model lanes (MOVED to workflow settings) --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">Per-phase model lanes</h4>
      <MovedSettingsStub
        message={t(
          "settings.movedStub.modelLanes",
          "Per-phase model lanes (execution, planning, reviewer, their fallbacks, and the title summarizer) now live on the workflow.",
        )}
        onOpenWorkflowSettings={onOpenWorkflowSettings}
      />

      {/* --- Model Presets --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">Model Presets</h4>
      <div className="form-group settings-model-presets">
        <label>Configured presets</label>
        {presets.length === 0 ? (
          <div className="settings-empty-state settings-muted">No presets configured yet.</div>
        ) : (
          <div className="settings-preset-list">
            {presets.map((preset) => {
              const selection = applyPresetToSelection(preset);
              const summary = `${selection.executorValue || "default"} / ${selection.validatorValue || "default"}`;
              return (
                <div key={preset.id} className="settings-preset-item">
                  <div className="settings-preset-item-meta">
                    <strong>{preset.name}</strong>
                    <span className="settings-muted settings-preset-summary">{summary}</span>
                  </div>
                  <div className="settings-preset-item-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setEditingPresetId(preset.id);
                        setPresetDraft({ ...preset });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        if (inUsePresetIds.has(preset.id)) {
                          const shouldDelete = await confirmDelete({
                            title: t("settings.models.deletePresetTitle", "Delete Preset"),
                            message: t("settings.models.deletePresetMessage", "Preset \"{{name}}\" is used in auto-selection. Delete it anyway?", { name: preset.name }),
                            danger: true,
                          });
                          if (!shouldDelete) {
                            return;
                          }
                        }
                        setForm((current) => ({
                          ...current,
                          modelPresets: (current.modelPresets || []).filter((entry) => entry.id !== preset.id),
                          defaultPresetBySize: Object.fromEntries(
                            Object.entries(current.defaultPresetBySize || {}).filter(([, value]) => value !== preset.id),
                          ) as Settings["defaultPresetBySize"],
                        }));
                        if (editingPresetId === preset.id) {
                          setEditingPresetId(null);
                          setPresetDraft(null);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!presetDraft ? (
          <div className="settings-preset-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setEditingPresetId(null);
                setPresetDraft({ id: "", name: "", executorProvider: undefined, executorModelId: undefined, validatorProvider: undefined, validatorModelId: undefined });
              }}
            >
              Add Preset
            </button>
          </div>
        ) : null}
      </div>

      {presetDraft ? (
        <div className="form-group settings-preset-editor">
          <label>Preset editor</label>
          <div className="settings-preset-editor-fields">
            <div className="form-group">
              <label htmlFor="preset-name">Name</label>
              <input
                id="preset-name"
                type="text"
                value={presetDraft.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setPresetDraft((current) => current ? { ...current, name } : current);
                }}
              />
            </div>
            {availableModels.length === 0 ? (
              <small>No models available. Configure authentication first.</small>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="preset-executor-model">Executor model</label>
                  <CustomModelDropdown
                    id="preset-executor-model"
                    label="Preset executor model"
                    models={availableModels}
                    value={presetDraft.executorProvider && presetDraft.executorModelId ? `${presetDraft.executorProvider}/${presetDraft.executorModelId}` : ""}
                    onChange={(val) => {
                      if (!val) {
                        setPresetDraft((current) => current ? { ...current, executorProvider: undefined, executorModelId: undefined } : current);
                        return;
                      }
                      const slashIdx = val.indexOf("/");
                      setPresetDraft((current) => current ? {
                        ...current,
                        executorProvider: val.slice(0, slashIdx),
                        executorModelId: val.slice(slashIdx + 1),
                      } : current);
                    }}
                    placeholder="Use default"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={onToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={onToggleModelFavorite}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="preset-validator-model">Reviewer model</label>
                  <CustomModelDropdown
                    id="preset-validator-model"
                    label="Preset reviewer model"
                    models={availableModels}
                    value={presetDraft.validatorProvider && presetDraft.validatorModelId ? `${presetDraft.validatorProvider}/${presetDraft.validatorModelId}` : ""}
                    onChange={(val) => {
                      if (!val) {
                        setPresetDraft((current) => current ? { ...current, validatorProvider: undefined, validatorModelId: undefined } : current);
                        return;
                      }
                      const slashIdx = val.indexOf("/");
                      setPresetDraft((current) => current ? {
                        ...current,
                        validatorProvider: val.slice(0, slashIdx),
                        validatorModelId: val.slice(slashIdx + 1),
                      } : current);
                    }}
                    placeholder="Use default"
                    favoriteProviders={favoriteProviders}
                    onToggleFavorite={onToggleFavorite}
                    favoriteModels={favoriteModels}
                    onToggleModelFavorite={onToggleModelFavorite}
                  />
                </div>
              </>
            )}
          </div>
          <div className="modal-actions settings-preset-editor-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={onSavePresetDraft}>{t("settings.models.savePreset", "Save preset")}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setEditingPresetId(null); setPresetDraft(null); }}>{t("settings.actions.cancel", "Cancel")}</button>
          </div>
        </div>
      ) : null}

      <div className="form-group settings-preset-auto-select">
        <label htmlFor="autoSelectModelPreset" className="checkbox-label">
          <input
            id="autoSelectModelPreset"
            type="checkbox"
            checked={form.autoSelectModelPreset || false}
            onChange={(e) => setForm((current) => ({ ...current, autoSelectModelPreset: e.target.checked }))}
          />
          Auto-select preset based on task size
        </label>
      </div>

      {form.autoSelectModelPreset ? (
        <div className="settings-preset-size-grid">
          {(["S", "M", "L"] as const).map((sizeKey) => (
            <div className="form-group settings-preset-size-row" key={sizeKey}>
              <label htmlFor={`preset-size-${sizeKey}`}>
                {sizeKey === "S" ? "Small tasks (S):" : sizeKey === "M" ? "Medium tasks (M):" : "Large tasks (L):"}
              </label>
              <select
                id={`preset-size-${sizeKey}`}
                value={form.defaultPresetBySize?.[sizeKey] || ""}
                onChange={(e) => {
                  const value = e.target.value || undefined;
                  setForm((current) => ({
                    ...current,
                    defaultPresetBySize: {
                      ...(current.defaultPresetBySize || {}),
                      [sizeKey]: value,
                    },
                  }));
                }}
              >
                <option value="">No preset</option>
                {presetOptions.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}

      {/* --- AI Title and Git Commit Message Summarization --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">
        AI Title and Git Commit Message Summarization
      </h4>
      <p className="settings-description">
        Configures the model used for two short-summary jobs:
        auto-generating task titles from long descriptions, and
        generating merge commit summaries from step commits and diff stats.
      </p>
      <div className="form-group">
        <label htmlFor="autoSummarizeTitles" className="checkbox-label">
          <input
            id="autoSummarizeTitles"
            type="checkbox"
            checked={form.autoSummarizeTitles || false}
            onChange={(e) => setForm((f) => ({ ...f, autoSummarizeTitles: e.target.checked }))}
          />
          Auto-summarize long descriptions as titles
        </label>
        <small>
          When enabled, tasks created without a title but with descriptions over 200 characters
          will automatically get an AI-generated title (max 60 characters). The same model is
          also used to generate fallback merge commit message bodies when the branch's commit
          log is empty (e.g. squash merges with no unique commits), and GitHub tracking issue
          titles when a tracked task has no title yet.
        </small>
      </div>

      <div className="form-group">
        <label htmlFor="useAiMergeCommitSummary" className="checkbox-label">
          <input
            id="useAiMergeCommitSummary"
            type="checkbox"
            checked={form.useAiMergeCommitSummary || false}
            onChange={(e) => setForm((f) => ({ ...f, useAiMergeCommitSummary: e.target.checked }))}
          />
          AI merge commit summaries
        </label>
        <small>
          When enabled, merge commit messages include an AI-generated subject plus body summary (narrative + bullets + diff-stat) instead of just listing step commit subjects. Uses the title summarization model.
        </small>
      </div>

      {(form.autoSummarizeTitles || form.useAiMergeCommitSummary || form.githubTrackingEnabledByDefault || false) && (
        <p className="settings-description">
          {t(
            "settings.movedStub.summarizerModelInline",
            "The model used for summarization now lives on the workflow (title summarizer lane). Open workflow settings to choose it.",
          )}
        </p>
      )}
    </>
  );
}

export default ProjectModelsSection;
