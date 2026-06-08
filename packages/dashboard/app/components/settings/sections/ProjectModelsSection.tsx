/**
 * Project Models section (U9 / KTD-10).
 *
 * Project-scoped model configuration. The project DEFAULT model lane still saves
 * as project settings. The common workflow model lanes (Plan/Triage, Executor,
 * Reviewer) are now proxy-edited here for the active default workflow while
 * persisting through workflow setting values, not tombstoned project keys.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ModelPreset, Settings } from "@fusion/core";
import {
  ApiRequestError,
  fetchWorkflowSettingValues,
  updateWorkflowSettingValues,
  type ModelInfo,
  type WorkflowSettingRejection,
  type WorkflowSettingValuesPayload,
} from "../../../api";
import { CustomModelDropdown } from "../../CustomModelDropdown";
import { applyPresetToSelection } from "../../../utils/modelPresets";
import type { ToastType } from "../../../hooks/useToast";
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
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onOpenWorkflowSettings?: () => void;
}

interface WorkflowModelLane {
  id: "planning" | "execution" | "validator";
  label: string;
  providerKey: string;
  modelKey: string;
  help: string;
}

const WORKFLOW_MODEL_LANES: WorkflowModelLane[] = [
  {
    id: "planning",
    label: "Plan/Triage Model",
    providerKey: "planningProvider",
    modelKey: "planningModelId",
    help: "Used when Fusion plans, breaks down, or triages tasks for this workflow.",
  },
  {
    id: "execution",
    label: "Executor Model",
    providerKey: "executionProvider",
    modelKey: "executionModelId",
    help: "Used by implementation agents running this workflow.",
  },
  {
    id: "validator",
    label: "Reviewer Model",
    providerKey: "validatorProvider",
    modelKey: "validatorModelId",
    help: "Used by review and validation agents for this workflow.",
  },
];

function splitModelValue(value: string): { provider: string | null; modelId: string | null } {
  if (!value) return { provider: null, modelId: null };
  const slashIdx = value.indexOf("/");
  if (slashIdx <= 0) return { provider: null, modelId: null };
  return { provider: value.slice(0, slashIdx), modelId: value.slice(slashIdx + 1) };
}

export function ProjectModelsSection({
  scopeBanner,
  form,
  setForm,
  models,
  projectId,
  addToast,
  onOpenWorkflowSettings,
}: ProjectModelsSectionProps) {
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
  const defaultWorkflowId = useMemo(() => {
    const raw = typeof form.defaultWorkflowId === "string" ? form.defaultWorkflowId.trim() : "";
    return raw || "builtin:coding";
  }, [form.defaultWorkflowId]);
  const [workflowPayload, setWorkflowPayload] = useState<WorkflowSettingValuesPayload | null>(null);
  const [workflowPending, setWorkflowPending] = useState<Record<string, unknown>>({});
  const [workflowRejections, setWorkflowRejections] = useState<Record<string, WorkflowSettingRejection>>({});
  const [resolvedWorkflowId, setResolvedWorkflowId] = useState(defaultWorkflowId);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const reqSeq = useRef(0);

  const loadWorkflowValues = useCallback(async () => {
    const seq = ++reqSeq.current;
    if (!projectId) {
      setWorkflowPayload(null);
      setWorkflowPending({});
      setWorkflowRejections({});
      setResolvedWorkflowId(defaultWorkflowId);
      return;
    }
    setWorkflowLoading(true);
    try {
      let targetWorkflowId = defaultWorkflowId;
      let payload: WorkflowSettingValuesPayload;
      try {
        payload = await fetchWorkflowSettingValues(targetWorkflowId, projectId);
      } catch (err) {
        if (targetWorkflowId === "builtin:coding" || !(err instanceof ApiRequestError) || err.status !== 404) {
          throw err;
        }
        targetWorkflowId = "builtin:coding";
        payload = await fetchWorkflowSettingValues(targetWorkflowId, projectId);
      }
      if (reqSeq.current === seq) {
        setWorkflowPayload(payload);
        setWorkflowPending({});
        setWorkflowRejections({});
        setResolvedWorkflowId(targetWorkflowId);
      }
    } catch {
      if (reqSeq.current === seq) {
        setWorkflowPayload(null);
        setWorkflowPending({});
        setWorkflowRejections({});
        setResolvedWorkflowId(defaultWorkflowId);
        addToast(t("settings.models.workflowLanesLoadFailed", "Failed to load workflow model settings"), "error");
      }
    } finally {
      if (reqSeq.current === seq) setWorkflowLoading(false);
    }
  }, [addToast, defaultWorkflowId, projectId, t]);

  useEffect(() => {
    void loadWorkflowValues();
  }, [loadWorkflowValues]);

  const workflowValueFor = useCallback(
    (key: string): unknown => {
      if (Object.prototype.hasOwnProperty.call(workflowPending, key)) {
        return workflowPending[key];
      }
      return workflowPayload?.effective?.[key];
    },
    [workflowPayload, workflowPending],
  );

  const workflowLaneValue = useCallback(
    (lane: WorkflowModelLane): string => {
      const provider = workflowValueFor(lane.providerKey);
      const modelId = workflowValueFor(lane.modelKey);
      return typeof provider === "string" && provider && typeof modelId === "string" && modelId
        ? `${provider}/${modelId}`
        : "";
    },
    [workflowValueFor],
  );

  const workflowLaneCustomized = useCallback(
    (lane: WorkflowModelLane): boolean => {
      const pendingProvider = workflowPending[lane.providerKey];
      const pendingModel = workflowPending[lane.modelKey];
      if (pendingProvider === null && pendingModel === null) return false;
      if (pendingProvider !== undefined || pendingModel !== undefined) return true;
      return Boolean(
        workflowPayload?.stored &&
          (Object.prototype.hasOwnProperty.call(workflowPayload.stored, lane.providerKey) ||
            Object.prototype.hasOwnProperty.call(workflowPayload.stored, lane.modelKey)),
      );
    },
    [workflowPayload, workflowPending],
  );

  const updateWorkflowLane = useCallback((lane: WorkflowModelLane, value: string) => {
    const { provider, modelId } = splitModelValue(value);
    setWorkflowPending((current) => ({
      ...current,
      [lane.providerKey]: provider,
      [lane.modelKey]: modelId,
    }));
    setWorkflowRejections((current) => {
      if (!current[lane.providerKey] && !current[lane.modelKey]) return current;
      const next = { ...current };
      delete next[lane.providerKey];
      delete next[lane.modelKey];
      return next;
    });
  }, []);

  const saveWorkflowModelLanes = useCallback(async () => {
    if (!projectId || Object.keys(workflowPending).length === 0) return;
    setWorkflowSaving(true);
    try {
      const payload = await updateWorkflowSettingValues(resolvedWorkflowId, workflowPending, projectId);
      setWorkflowPayload(payload);
      setWorkflowPending({});
      setWorkflowRejections({});
      addToast(t("settings.models.workflowLanesSaved", "Workflow model settings saved"), "success");
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 400 && err.details) {
        const rejList = (err.details.rejections as WorkflowSettingRejection[] | undefined) ?? [];
        if (rejList.length > 0) {
          const byId: Record<string, WorkflowSettingRejection> = {};
          for (const r of rejList) byId[r.settingId] = r;
          setWorkflowRejections(byId);
          addToast(t("settings.models.workflowLanesRejected", "Some workflow model settings were rejected"), "error");
          return;
        }
      }
      addToast(t("settings.models.workflowLanesSaveFailed", "Failed to save workflow model settings"), "error");
    } finally {
      setWorkflowSaving(false);
    }
  }, [addToast, projectId, resolvedWorkflowId, t, workflowPending]);

  const workflowDirty = Object.keys(workflowPending).length > 0;

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

      {/* --- Default workflow model lanes (workflow setting values) --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">Default workflow model lanes</h4>
      <p className="settings-description">
        These controls edit model values on this project's default workflow ({resolvedWorkflowId}).
        They use workflow settings as the source of truth.
      </p>
      {!projectId ? (
        <div className="settings-empty-state settings-muted">
          Open a project to edit workflow model lanes.
        </div>
      ) : modelsLoading || workflowLoading ? (
        <div className="settings-empty-state">Loading workflow model settings…</div>
      ) : availableModels.length === 0 ? (
        <div className="settings-empty-state settings-muted">
          No models available. Configure authentication first.
        </div>
      ) : (
        <>
          {WORKFLOW_MODEL_LANES.map((lane) => {
            const value = workflowLaneValue(lane);
            const customized = workflowLaneCustomized(lane);
            const rejection = workflowRejections[lane.providerKey] ?? workflowRejections[lane.modelKey];
            return (
              <div className="form-group" key={lane.id} data-testid={`workflow-model-lane-${lane.id}`}>
                <div className="settings-model-lane-label-row">
                  <label htmlFor={`workflow-${lane.id}-model`}>{lane.label}</label>
                  <span
                    className={`settings-lane-badge ${customized ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`}
                    title={customized ? "Explicitly set on the default workflow" : "Inherited through workflow/global defaults"}
                  >
                    {customized ? "Override (Workflow)" : "Inherited"}
                  </span>
                </div>
                <div className="settings-model-lane-control-row">
                  <div className="settings-model-lane-control-main">
                    <CustomModelDropdown
                      id={`workflow-${lane.id}-model`}
                      label={lane.label}
                      models={availableModels}
                      value={value}
                      onChange={(val) => updateWorkflowLane(lane, val)}
                      placeholder="Use workflow/global default"
                      defaultOptionLabel="Use workflow/global default"
                      favoriteProviders={favoriteProviders}
                      onToggleFavorite={onToggleFavorite}
                      favoriteModels={favoriteModels}
                      onToggleModelFavorite={onToggleModelFavorite}
                    />
                  </div>
                  {customized && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title="Reset to inherit"
                      onClick={() => updateWorkflowLane(lane, "")}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      Reset
                    </button>
                  )}
                </div>
                {rejection ? (
                  <small className="field-error" role="alert" data-testid={`workflow-model-lane-error-${lane.id}`}>
                    {rejection.message}
                  </small>
                ) : null}
                <small>{lane.help}</small>
              </div>
            );
          })}
          <div className="settings-model-lane-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="save-workflow-model-lanes"
              disabled={!workflowDirty || workflowSaving}
              onClick={() => void saveWorkflowModelLanes()}
            >
              Save workflow models
            </button>
            {onOpenWorkflowSettings && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenWorkflowSettings}>
                Advanced workflow policy
              </button>
            )}
          </div>
        </>
      )}

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
