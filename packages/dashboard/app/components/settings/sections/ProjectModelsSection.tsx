import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelPreset, Settings } from "@fusion/core";
import { ApiRequestError, fetchWorkflow, fetchWorkflowSettingValues, updateWorkflowSettingValues, type ModelInfo, type WorkflowSettingDefinition, type WorkflowSettingRejection, type WorkflowSettingValuesPayload, } from "../../../api";
import { CustomModelDropdown } from "../../CustomModelDropdown";
import { applyPresetToSelection } from "../../../utils/modelPresets";
import type { ToastType } from "../../../hooks/useToast";
import type { ModelLane, SectionBaseProps, SectionSaveHandler, SettingsFormState } from "./context";
type LaneStatus = "inherited" | "overridden";
type WorkflowModelPair = {
    id: "planning" | "execution" | "validator" | "planning-fallback" | "validator-fallback" | "title-summarizer-fallback";
    providerId: string;
    modelId: string;
    label: string;
    help: string;
};
const DEFAULT_WORKFLOW_ID = "builtin:coding";
/*
FNXC:SettingsModels 2026-06-16-19:58:
Fallback model lanes must be configurable in all Settings surfaces: General uses the global Fallback Model, Workflow Values uses declared workflow settings, and Project Models exposes only fallback pairs declared by the active default workflow so saves never PATCH undeclared keys.
*/
const WORKFLOW_MODEL_PAIRS: WorkflowModelPair[] = [
    {
        id: "planning",
        providerId: "planningProvider",
        modelId: "planningModelId",
        label: "Plan/Triage Model",
        help: "Provider and model used when planning or triaging tasks. Leave unset to inherit from the workflow default.",
    },
    {
        id: "execution",
        providerId: "executionProvider",
        modelId: "executionModelId",
        label: "Executor Model",
        help: "Provider and model used while executing workflow steps. Leave unset to inherit from the workflow default.",
    },
    {
        id: "validator",
        providerId: "validatorProvider",
        modelId: "validatorModelId",
        label: "Reviewer Model",
        help: "Provider and model used for workflow review or validation lanes. Leave unset to inherit from the workflow default.",
    },
    {
        id: "planning-fallback",
        providerId: "planningFallbackProvider",
        modelId: "planningFallbackModelId",
        label: "Planning Fallback Model",
        help: "Fallback provider and model used when the primary Plan/Triage model cannot be used.",
    },
    {
        id: "validator-fallback",
        providerId: "validatorFallbackProvider",
        modelId: "validatorFallbackModelId",
        label: "Reviewer Fallback Model",
        help: "Fallback provider and model used when the primary Reviewer model cannot be used.",
    },
    {
        id: "title-summarizer-fallback",
        providerId: "titleSummarizerFallbackProvider",
        modelId: "titleSummarizerFallbackModelId",
        label: "Title Summarizer Fallback Model",
        help: "Fallback provider and model used when the primary Title Summarizer model cannot be used.",
    },
];
function declaredWorkflowModelPairs(settings?: WorkflowSettingDefinition[]): WorkflowModelPair[] {
    const settingsById = new Map((settings ?? []).map((setting) => [setting.id, setting]));
    return WORKFLOW_MODEL_PAIRS.filter((pair) => {
        const provider = settingsById.get(pair.providerId);
        const model = settingsById.get(pair.modelId);
        return provider?.type === "string" && model?.type === "string";
    });
}
function modelPairValue(values: Record<string, unknown>, pair: WorkflowModelPair): string {
    const provider = values[pair.providerId];
    const modelId = values[pair.modelId];
    return typeof provider === "string" && typeof modelId === "string" && provider && modelId
        ? `${provider}/${modelId}`
        : "";
}
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
    confirmDelete: (options: {
        title: string;
        message: string;
        danger?: boolean;
    }) => Promise<boolean>;
}
export class WorkflowLaneFlushRejection extends Error {
    readonly rejections: WorkflowSettingRejection[];
    constructor(rejections: WorkflowSettingRejection[]) {
        super("Workflow model lane settings were rejected");
        this.name = "WorkflowLaneFlushRejection";
        this.rejections = rejections;
    }
}
export interface ProjectModelsSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    models: ProjectModelsSectionModelProps;
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    onOpenWorkflowSettings?: () => void;
    registerWorkflowLaneSaver?: (saver: SectionSaveHandler | null) => void;
}
export function ProjectModelsSection({ scopeBanner, form, setForm, models, projectId, onOpenWorkflowSettings, registerWorkflowLaneSaver, }: ProjectModelsSectionProps) {
    const { t } = useTranslation("app");
    const { modelLanes, getLaneStatus, getLaneValue, updateLaneValue, resetLaneValue, availableModels, modelsLoading, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, editingPresetId, setEditingPresetId, presetDraft, setPresetDraft, onSavePresetDraft, confirmDelete, } = models;
    const presets = form.modelPresets || [];
    const presetOptions = presets.map((preset) => ({ id: preset.id, name: preset.name }));
    const inUsePresetIds = new Set(Object.values(form.defaultPresetBySize || {}).filter(Boolean));
    const configuredWorkflowId = typeof form.defaultWorkflowId === "string" && form.defaultWorkflowId.trim()
        ? form.defaultWorkflowId
        : DEFAULT_WORKFLOW_ID;
    const [workflowId, setWorkflowId] = useState(configuredWorkflowId);
    const [workflowPayload, setWorkflowPayload] = useState<WorkflowSettingValuesPayload | null>(null);
    const [workflowLoading, setWorkflowLoading] = useState(false);
    const [workflowPending, setWorkflowPending] = useState<Record<string, unknown>>({});
    const [workflowRejections, setWorkflowRejections] = useState<Record<string, WorkflowSettingRejection>>({});
    const [workflowModelPairs, setWorkflowModelPairs] = useState<WorkflowModelPair[]>([]);
    const workflowReqSeq = useRef(0);
    const workflowDirty = Object.keys(workflowPending).length > 0;
    useEffect(() => {
        setWorkflowId(configuredWorkflowId);
    }, [configuredWorkflowId]);
    useEffect(() => {
        if (!projectId) {
            setWorkflowPayload(null);
            setWorkflowPending({});
            setWorkflowRejections({});
            setWorkflowModelPairs([]);
            return;
        }
        const seq = ++workflowReqSeq.current;
        setWorkflowLoading(true);
        Promise.all([
            fetchWorkflow(workflowId, projectId),
            fetchWorkflowSettingValues(workflowId, projectId),
        ])
            .then(([definition, payload]) => {
            if (workflowReqSeq.current !== seq)
                return;
            setWorkflowPayload(payload);
            setWorkflowPending({});
            setWorkflowRejections({});
            const declarations = "settings" in definition.ir ? definition.ir.settings : undefined;
            setWorkflowModelPairs(declaredWorkflowModelPairs(declarations));
        })
            .catch((err) => {
            if (workflowReqSeq.current !== seq)
                return;
            if (err instanceof ApiRequestError && err.status === 404 && workflowId !== DEFAULT_WORKFLOW_ID) {
                setWorkflowId(DEFAULT_WORKFLOW_ID);
                return;
            }
            setWorkflowPayload({ stored: {}, effective: {}, orphaned: [] });
            setWorkflowModelPairs([]);
        })
            .finally(() => {
            if (workflowReqSeq.current === seq)
                setWorkflowLoading(false);
        });
    }, [projectId, workflowId]);
    const effectiveWorkflowValues = useMemo(() => ({
        ...(workflowPayload?.effective ?? {}),
        ...Object.fromEntries(Object.entries(workflowPending).filter(([, value]) => value !== null)),
    }), [workflowPayload, workflowPending]);
    const setWorkflowPairValue = useCallback((pair: WorkflowModelPair, value: string) => {
        setWorkflowRejections((current) => {
            const next = { ...current };
            delete next[pair.providerId];
            delete next[pair.modelId];
            return next;
        });
        setWorkflowPending((current) => {
            if (!value) {
                return { ...current, [pair.providerId]: null, [pair.modelId]: null };
            }
            const slashIdx = value.indexOf("/");
            if (slashIdx <= 0)
                return current;
            return {
                ...current,
                [pair.providerId]: value.slice(0, slashIdx),
                [pair.modelId]: value.slice(slashIdx + 1),
            };
        });
    }, []);
    const resetWorkflowPairValue = useCallback((pair: WorkflowModelPair) => {
        setWorkflowPairValue(pair, "");
    }, [setWorkflowPairValue]);
    const saveWorkflowLanes = useCallback(async () => {
        if (!projectId || !workflowDirty)
            return;
        try {
            const payload = await updateWorkflowSettingValues(workflowId, workflowPending, projectId);
            setWorkflowPayload(payload);
            setWorkflowPending({});
            setWorkflowRejections({});
        }
        catch (err) {
            if (err instanceof ApiRequestError && err.status === 400 && err.details) {
                const rejections = (err.details.rejections as WorkflowSettingRejection[] | undefined) ?? [];
                if (rejections.length > 0) {
                    setWorkflowRejections(Object.fromEntries(rejections.map((rejection) => [rejection.settingId, rejection])));
                    throw new WorkflowLaneFlushRejection(rejections);
                }
            }
            throw err;
        }
    }, [projectId, workflowDirty, workflowId, workflowPending]);
    useEffect(() => {
        registerWorkflowLaneSaver?.(saveWorkflowLanes);
        return () => registerWorkflowLaneSaver?.(null);
    }, [registerWorkflowLaneSaver, saveWorkflowLanes]);
    // The project DEFAULT lane and restored title-summarizer lane remain editable
    // here. Execution/planning/validator workflow-specific lanes still redirect to
    // workflow settings below.
    const projectModelLanes = modelLanes.filter((lane) => ["default", "summarization"].includes(lane.laneId));
    const getProjectLaneLabel = (lane: ModelLane) => {
        if (lane.laneId === "default") {
            return "Project Default Model";
        }
        if (lane.laneId === "summarization") {
            return "Project Summarization Model";
        }
        return lane.label;
    };
    const getProjectLaneHelperText = (lane: ModelLane) => {
        if (lane.laneId === "default") {
            return "Project-wide default AI model used when no more specific task or project lane override is set.";
        }
        if (lane.laneId === "summarization") {
            return "Model used for title auto-summarization, merge commit summaries, GitHub tracking issue titles, and PR title/body generation.";
        }
        return lane.helperText;
    };
    return (<>
      {scopeBanner}

      {/* --- Token Cap --- */}
      <h4 className="settings-section-heading">{t("settings.projectModels.tokenCap", "Token Cap")}</h4>
      <div className="form-group">
        <label htmlFor="tokenCap">{t("settings.projectModels.tokenCap", "Token Cap")}</label>
        <div className="settings-token-cap-row">
          <input id="tokenCap" type="number" placeholder={t("settings.projectModels.noCap", "No cap")} value={form.tokenCap ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, tokenCap: val ? parseInt(val, 10) : null } as SettingsFormState));
        }}/>
          {form.tokenCap != null && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToDefaultNoCap", "Reset to default (no cap)")} onClick={() => setForm((f) => ({ ...f, tokenCap: null } as unknown as SettingsFormState))} style={{ whiteSpace: "nowrap" }}>{t("settings.projectModels.reset", " Reset ")}</button>)}
        </div>
        <small>{t("settings.projectModels.automaticallyCompactContextWhenApproachingThisTokenCount", "Automatically compact context when approaching this token count. Leave empty for no cap (compact only on overflow errors). Set a number to proactively compact when reaching this token count.")}</small>
      </div>

      {/* --- Project Model Lanes --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.modelLanes", "Model Lanes")}</h4>
      <p className="settings-description">{t("settings.projectModels.overrideGlobalModelSettingsAtTheProjectLevel", " Override global model settings at the project level. Each lane controls a specific AI usage context. Unset lanes inherit from the corresponding global lane. The Project Default Model is the fallback for this project when a more specific lane is unset. ")}</p>
      {modelsLoading ? (<div className="settings-empty-state">{t("settings.projectModels.loadingAvailableModels", "Loading available models\u2026")}</div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.noModelsAvailableConfigureAuthenticationFirst", " No models available. Configure authentication first. ")}</div>) : (<>
          {projectModelLanes.map((lane) => {
                const status = getLaneStatus(lane);
                const value = getLaneValue(lane);
                const isOverridden = status === "overridden";
                const laneLabel = getProjectLaneLabel(lane);
                return (<div className="form-group" key={lane.laneId}>
                <div className="settings-model-lane-label-row">
                  <label htmlFor={`${lane.laneId}Model`}>{laneLabel}</label>
                  <span className={`settings-lane-badge ${isOverridden ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`} title={isOverridden ? "Explicitly set for this project" : "Inherited from global settings"}>
                    {isOverridden ? "Override (Project)" : "Inherited (Global)"}
                  </span>
                </div>
                <div className="settings-model-lane-control-row">
                  <div className="settings-model-lane-control-main">
                    <CustomModelDropdown id={`${lane.laneId}Model`} label={laneLabel} models={availableModels} value={value} onChange={(val) => updateLaneValue(lane, val)} placeholder={lane.laneId === "default" ? "Use global default" : "Use global"} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
                  </div>
                  {isOverridden && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToInheritFromGlobal", "Reset to inherit from global")} onClick={() => resetLaneValue(lane)} style={{ whiteSpace: "nowrap" }}>{t("settings.projectModels.reset", " Reset ")}</button>)}
                </div>
                <small>
                  {getProjectLaneHelperText(lane)}{t("settings.projectModels.fallsBackTo", " Falls back to: ")}{lane.fallbackOrder}.
                </small>
              </div>);
            })}
        </>)}

      {/* --- Default workflow model lanes --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.defaultWorkflowModelLanes", "Default workflow model lanes")}</h4>
      <p className="settings-description">
        {t("settings.movedStub.modelLanes", "Per-phase model lanes (execution, planning, reviewer, and their fallbacks) now live on the workflow.")}{t("settings.projectModels.theseProjectOverridesApplyToTheActiveDefault", " These project overrides apply to the active default workflow. ")}</p>
      {!projectId ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.openAProjectToEditWorkflowModelLanes", "Open a project to edit workflow model lanes.")}</div>) : workflowLoading ? (<div className="settings-empty-state">{t("settings.projectModels.loadingWorkflowModelLanes", "Loading workflow model lanes\u2026")}</div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.noModelsAvailableConfigureAuthenticationBeforeSelectingWorkflow", " No models available. Configure authentication before selecting workflow model lanes. ")}</div>) : (<>
          {workflowModelPairs.map((pair) => {
                const value = modelPairValue(effectiveWorkflowValues, pair);
                const customized = Object.prototype.hasOwnProperty.call(workflowPending, pair.providerId)
                    ? workflowPending[pair.providerId] !== null
                    : Boolean(workflowPayload?.stored && (Object.prototype.hasOwnProperty.call(workflowPayload.stored, pair.providerId)
                        || Object.prototype.hasOwnProperty.call(workflowPayload.stored, pair.modelId)));
                const error = workflowRejections[pair.providerId]?.message ?? workflowRejections[pair.modelId]?.message;
                return (<div className="form-group" key={pair.id} data-testid={`workflow-model-lane-${pair.id}`}>
                <div className="settings-model-lane-label-row">
                  <label htmlFor={`workflow-${pair.id}-model`}>{pair.label}</label>
                  <span className={`settings-lane-badge ${customized ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`} title={customized ? "Explicitly set for this project workflow" : "Inherited from workflow defaults"}>
                    {customized ? "Override (Project)" : "Inherited (Workflow)"}
                  </span>
                </div>
                <div className="settings-model-lane-control-row">
                  <div className="settings-model-lane-control-main">
                    <CustomModelDropdown id={`workflow-${pair.id}-model`} label={pair.label} models={availableModels} value={value} onChange={(next) => setWorkflowPairValue(pair, next)} placeholder={t("settings.projectModels.useWorkflowDefault", "Use workflow default")} defaultOptionLabel="Use workflow default" favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
                  </div>
                  {customized && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToInheritFromWorkflow", "Reset to inherit from workflow")} onClick={() => resetWorkflowPairValue(pair)} style={{ whiteSpace: "nowrap" }}>{t("settings.projectModels.reset", " Reset ")}</button>)}
                </div>
                <small>{pair.help}</small>
                {error ? <small className="settings-error" data-testid={`workflow-model-lane-error-${pair.id}`}>{error}</small> : null}
              </div>);
            })}
          {onOpenWorkflowSettings ? (<div className="settings-model-lane-actions" aria-label={t("settings.projectModels.defaultWorkflowModelLaneActions", "Default workflow model lane actions")}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenWorkflowSettings}>{t("settings.projectModels.advancedWorkflowPolicy", " Advanced workflow policy ")}</button>
            </div>) : null}
        </>)}

      {/* --- Model Presets --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.modelPresets", "Model Presets")}</h4>
      <div className="form-group settings-model-presets">
        <label>{t("settings.projectModels.configuredPresets", "Configured presets")}</label>
        {presets.length === 0 ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.noPresetsConfiguredYet", "No presets configured yet.")}</div>) : (<div className="settings-preset-list">
            {presets.map((preset) => {
                const selection = applyPresetToSelection(preset);
                const summary = `${selection.executorValue || "default"} / ${selection.validatorValue || "default"}`;
                return (<div key={preset.id} className="settings-preset-item">
                  <div className="settings-preset-item-meta">
                    <strong>{preset.name}</strong>
                    <span className="settings-muted settings-preset-summary">{summary}</span>
                  </div>
                  <div className="settings-preset-item-actions">
                    <button type="button" className="btn btn-sm" onClick={() => {
                        setEditingPresetId(preset.id);
                        setPresetDraft({ ...preset });
                    }}>{t("settings.projectModels.edit", " Edit ")}</button>
                    <button type="button" className="btn btn-sm" onClick={async () => {
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
                            defaultPresetBySize: Object.fromEntries(Object.entries(current.defaultPresetBySize || {}).filter(([, value]) => value !== preset.id)) as Settings["defaultPresetBySize"],
                        }));
                        if (editingPresetId === preset.id) {
                            setEditingPresetId(null);
                            setPresetDraft(null);
                        }
                    }}>{t("settings.projectModels.delete", " Delete ")}</button>
                  </div>
                </div>);
            })}
          </div>)}
        {!presetDraft ? (<div className="settings-preset-actions">
            <button type="button" className="btn btn-sm" onClick={() => {
                setEditingPresetId(null);
                setPresetDraft({ id: "", name: "", executorProvider: undefined, executorModelId: undefined, validatorProvider: undefined, validatorModelId: undefined });
            }}>{t("settings.projectModels.addPreset", " Add Preset ")}</button>
          </div>) : null}
      </div>

      {presetDraft ? (<div className="form-group settings-preset-editor">
          <label>{t("settings.projectModels.presetEditor", "Preset editor")}</label>
          <div className="settings-preset-editor-fields">
            <div className="form-group">
              <label htmlFor="preset-name">{t("settings.projectModels.name", "Name")}</label>
              <input id="preset-name" type="text" value={presetDraft.name} onChange={(e) => {
                const name = e.target.value;
                setPresetDraft((current) => current ? { ...current, name } : current);
            }}/>
            </div>
            {availableModels.length === 0 ? (<small>{t("settings.projectModels.noModelsAvailableConfigureAuthenticationFirst2", "No models available. Configure authentication first.")}</small>) : (<>
                <div className="form-group">
                  <label htmlFor="preset-executor-model">{t("settings.projectModels.executorModel", "Executor model")}</label>
                  <CustomModelDropdown id="preset-executor-model" label="Preset executor model" models={availableModels} value={presetDraft.executorProvider && presetDraft.executorModelId ? `${presetDraft.executorProvider}/${presetDraft.executorModelId}` : ""} onChange={(val) => {
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
                }} placeholder={t("settings.projectModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
                </div>
                <div className="form-group">
                  <label htmlFor="preset-validator-model">{t("settings.projectModels.reviewerModel", "Reviewer model")}</label>
                  <CustomModelDropdown id="preset-validator-model" label="Preset reviewer model" models={availableModels} value={presetDraft.validatorProvider && presetDraft.validatorModelId ? `${presetDraft.validatorProvider}/${presetDraft.validatorModelId}` : ""} onChange={(val) => {
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
                }} placeholder={t("settings.projectModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
                </div>
              </>)}
          </div>
          <div className="modal-actions settings-preset-editor-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={onSavePresetDraft}>{t("settings.models.savePreset", "Save preset")}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setEditingPresetId(null); setPresetDraft(null); }}>{t("settings.actions.cancel", "Cancel")}</button>
          </div>
        </div>) : null}

      <div className="form-group settings-preset-auto-select">
        <label htmlFor="autoSelectModelPreset" className="checkbox-label">
          <input id="autoSelectModelPreset" type="checkbox" checked={form.autoSelectModelPreset || false} onChange={(e) => setForm((current) => ({ ...current, autoSelectModelPreset: e.target.checked }))}/>{t("settings.projectModels.autoSelectPresetBasedOnTaskSize", " Auto-select preset based on task size ")}</label>
      </div>

      {form.autoSelectModelPreset ? (<div className="settings-preset-size-grid">
          {(["S", "M", "L"] as const).map((sizeKey) => (<div className="form-group settings-preset-size-row" key={sizeKey}>
              <label htmlFor={`preset-size-${sizeKey}`}>
                {sizeKey === "S" ? "Small tasks (S):" : sizeKey === "M" ? "Medium tasks (M):" : "Large tasks (L):"}
              </label>
              <select id={`preset-size-${sizeKey}`} value={form.defaultPresetBySize?.[sizeKey] || ""} onChange={(e) => {
                    const value = e.target.value || undefined;
                    setForm((current) => ({
                        ...current,
                        defaultPresetBySize: {
                            ...(current.defaultPresetBySize || {}),
                            [sizeKey]: value,
                        },
                    }));
                }}>
                <option value="">{t("settings.projectModels.noPreset", "No preset")}</option>
                {presetOptions.map((preset) => (<option key={preset.id} value={preset.id}>{preset.name}</option>))}
              </select>
            </div>))}
        </div>) : null}

      {/* --- AI Title and Git Commit Message Summarization --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.aITitleAndGitCommitMessageSummarization", " AI Title and Git Commit Message Summarization ")}</h4>
      <p className="settings-description">{t("settings.projectModels.configuresTheModelUsedForTwoShortSummary", " Configures the model used for two short-summary jobs: auto-generating task titles from long descriptions, and generating merge commit summaries from step commits and diff stats. ")}</p>
      <div className="form-group">
        <label htmlFor="autoSummarizeTitles" className="checkbox-label">
          <input id="autoSummarizeTitles" type="checkbox" checked={form.autoSummarizeTitles || false} onChange={(e) => setForm((f) => ({ ...f, autoSummarizeTitles: e.target.checked }))}/>{t("settings.projectModels.autoSummarizeLongDescriptionsAsTitles", " Auto-summarize long descriptions as titles ")}</label>
        <small>{t("settings.projectModels.whenEnabledTasksCreatedWithoutATitleBut", " When enabled, tasks created without a title but with descriptions over 200 characters will automatically get an AI-generated title (max 60 characters). The same model is also used to generate fallback merge commit message bodies when the branch's commit log is empty (e.g. squash merges with no unique commits), and GitHub tracking issue titles when a tracked task has no title yet. ")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="useAiMergeCommitSummary" className="checkbox-label">
          <input id="useAiMergeCommitSummary" type="checkbox" checked={form.useAiMergeCommitSummary || false} onChange={(e) => setForm((f) => ({ ...f, useAiMergeCommitSummary: e.target.checked }))}/>{t("settings.projectModels.aIMergeCommitSummaries", " AI merge commit summaries ")}</label>
        <small>{t("settings.projectModels.whenEnabledMergeCommitMessagesIncludeAnAI", " When enabled, merge commit messages include an AI-generated subject plus body summary (narrative + bullets + diff-stat) instead of just listing step commit subjects. Uses the title summarization model. ")}</small>
      </div>

      {(form.autoSummarizeTitles || form.useAiMergeCommitSummary || form.githubTrackingEnabledByDefault || false) && (<p className="settings-description">
          {t("settings.movedStub.summarizerModelInline", "The summarization model lane above controls title auto-summarization, merge commit summaries, GitHub tracking titles, and PR metadata generation.")}
        </p>)}
    </>);
}
export default ProjectModelsSection;
