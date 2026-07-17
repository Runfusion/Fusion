import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelPreset, Settings } from "@fusion/core";
import { ApiRequestError, fetchWorkflow, fetchWorkflowSettingValues, updateWorkflowSettingValues, type ModelInfo, type WorkflowSettingDefinition, type WorkflowSettingRejection, type WorkflowSettingValuesPayload, } from "../../../api";
import { CustomModelDropdown } from "../../CustomModelDropdown";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextareaRow } from "../SettingsTextareaRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
import { applyPresetToSelection } from "../../../utils/modelPresets";
import type { ToastType } from "../../../hooks/useToast";
import type { ModelLane, SectionBaseProps, SectionSaveHandler, SettingsFormState } from "./context";
import { LoadingSpinner } from "../../LoadingSpinner";
import { useAgentsMapCache } from "../../../hooks/useAgentsMapCache";
type LaneStatus = "inherited" | "overridden";
type WorkflowModelPair = {
    id: "planning" | "execution" | "validator" | "execution-fallback" | "planning-fallback" | "validator-fallback";
    providerId: string;
    modelId: string;
    thinkingId?: string;
    label: string;
    help: string;
};
const DEFAULT_WORKFLOW_ID = "builtin:coding";
/*
FNXC:SettingsModels 2026-06-16-19:58:
Fallback model lanes must be configurable in all Settings surfaces: General uses the global Fallback Model, Workflow Values uses declared workflow settings, and Project Models exposes workflow fallback pairs declared by the active default workflow plus project-scoped title-summarizer fallback keys so saves never PATCH undeclared keys.

FNXC:Settings-ThinkingLevel 2026-07-10-12:08:
Workflow fallback lanes may expose an inline thinking selector only when the active workflow declares the matching companion setting, while the title-summarizer fallback uses project-scoped keys below. Reset must clear both the model pair and the thinking companion; undeclared rows intentionally render no orphan thinking shell.

FNXC:SettingsModels 2026-07-16-00:00:
FN-8169 requires each workflow fallback lane to render directly under its primary lane so operators configure a model and its retry model together. Keep this catalog interleaved while preserving every lane key and declaration filter.
*/
const WORKFLOW_MODEL_PAIRS: WorkflowModelPair[] = [
    {
        id: "planning",
        providerId: "planningProvider",
        modelId: "planningModelId",
        thinkingId: "planningThinkingLevel",
        label: "Plan/Triage Model",
        help: "Provider and model used when planning or triaging tasks. Leave unset to inherit from the workflow default.",
    },
    {
        id: "planning-fallback",
        providerId: "planningFallbackProvider",
        modelId: "planningFallbackModelId",
        thinkingId: "planningFallbackThinkingLevel",
        label: "Planning Fallback Model",
        help: "Fallback provider and model used when the primary Plan/Triage model cannot be used.",
    },
    {
        id: "execution",
        providerId: "executionProvider",
        modelId: "executionModelId",
        thinkingId: "executionThinkingLevel",
        label: "Executor Model",
        help: "Provider and model used while executing workflow steps. Leave unset to inherit from the workflow default.",
    },
    {
        id: "execution-fallback",
        providerId: "executionFallbackProvider",
        modelId: "executionFallbackModelId",
        thinkingId: "executionFallbackThinkingLevel",
        label: "Executor Fallback Model",
        help: "Fallback provider and model used when the primary Executor model cannot be used.",
    },
    {
        id: "validator",
        providerId: "validatorProvider",
        modelId: "validatorModelId",
        thinkingId: "validatorThinkingLevel",
        label: "Reviewer Model",
        help: "Provider and model used for workflow review or validation lanes. Leave unset to inherit from the workflow default.",
    },
    {
        id: "validator-fallback",
        providerId: "validatorFallbackProvider",
        modelId: "validatorFallbackModelId",
        thinkingId: "validatorFallbackThinkingLevel",
        label: "Reviewer Fallback Model",
        help: "Fallback provider and model used when the primary Reviewer model cannot be used.",
    },
];
function declaredWorkflowModelPairs(settings?: WorkflowSettingDefinition[]): WorkflowModelPair[] {
    const settingsById = new Map((settings ?? []).map((setting) => [setting.id, setting]));
    return WORKFLOW_MODEL_PAIRS.filter((pair) => {
        const provider = settingsById.get(pair.providerId);
        const model = settingsById.get(pair.modelId);
        const thinking = pair.thinkingId ? settingsById.get(pair.thinkingId) : undefined;
        return provider?.type === "string" && model?.type === "string" && (!pair.thinkingId || thinking?.type === "enum" || thinking?.type === "string");
    });
}
function modelPairValue(values: Record<string, unknown>, pair: WorkflowModelPair): string {
    const provider = values[pair.providerId];
    const modelId = values[pair.modelId];
    return typeof provider === "string" && typeof modelId === "string" && provider && modelId
        ? `${provider}/${modelId}`
        : "";
}
function workflowPendingValueEquals(a: unknown, b: unknown): boolean {
    if (Object.is(a, b))
        return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    }
    return false;
}
export interface ProjectModelsSectionModelProps {
    modelLanes: ModelLane[];
    getLaneStatus: (lane: ModelLane) => LaneStatus;
    getLaneValue: (lane: ModelLane) => string;
    updateLaneValue: (lane: ModelLane, value: string) => void;
    resetLaneValue: (lane: ModelLane) => void;
    getLaneThinkingValue: (lane: ModelLane) => string;
    updateLaneThinkingValue: (lane: ModelLane, level: string) => void;
    resetLaneThinkingValue: (lane: ModelLane) => void;
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
    models: ProjectModelsSectionModelProps;
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    onOpenWorkflowSettings?: () => void;
    registerWorkflowLaneSaver?: (saver: SectionSaveHandler | null) => void;
}
export function ProjectModelsSection({ form, setForm, models, projectId, onOpenWorkflowSettings, registerWorkflowLaneSaver, }: ProjectModelsSectionProps) {
    const { t } = useTranslation("app");
    const { agents, loading: agentsLoading } = useAgentsMapCache(projectId);
    const { modelLanes, getLaneStatus, getLaneValue, updateLaneValue, resetLaneValue, getLaneThinkingValue, updateLaneThinkingValue, resetLaneThinkingValue, availableModels, modelsLoading, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, editingPresetId, setEditingPresetId, presetDraft, setPresetDraft, onSavePresetDraft, confirmDelete, } = models;
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
    const setWorkflowThinkingValue = useCallback((pair: WorkflowModelPair, value: string) => {
        if (!pair.thinkingId)
            return;
        setWorkflowRejections((current) => {
            if (!pair.thinkingId || !current[pair.thinkingId])
                return current;
            const next = { ...current };
            delete next[pair.thinkingId];
            return next;
        });
        setWorkflowPending((current) => ({ ...current, [pair.thinkingId as string]: value || null }));
    }, []);
    const resetWorkflowPairValue = useCallback((pair: WorkflowModelPair) => {
        setWorkflowPairValue(pair, "");
        setWorkflowThinkingValue(pair, "");
    }, [setWorkflowPairValue, setWorkflowThinkingValue]);
    const saveWorkflowLanes = useCallback(async () => {
        if (!projectId || !workflowDirty)
            return;
        const pendingSnapshot = { ...workflowPending };
        const savedKeys = Object.keys(pendingSnapshot);
        try {
            const payload = await updateWorkflowSettingValues(workflowId, pendingSnapshot, projectId);
            setWorkflowPayload(payload);
            setWorkflowPending((current) => {
                const next = { ...current };
                /*
                 * FNXC:ProjectModelsWorkflowLanes 2026-07-02-13:30:
                 * The registered Settings saver can resolve after workflow lane dropdowns changed again. Clear only snapshot-matching keys so Project Models follows the same no-lost-pending-edits invariant as Workflow Settings Values.
                 */
                for (const key of savedKeys) {
                    if (workflowPendingValueEquals(current[key], pendingSnapshot[key]))
                        delete next[key];
                }
                return next;
            });
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
    // The project DEFAULT, title-summarizer, and merger lanes remain editable
    // here. Execution/planning/validator workflow-specific lanes still redirect to
    // workflow settings below.
    // FNXC:Settings-MergerModel 2026-07-13-07:52: Merger is project-scoped (like summarization), not workflow-moved.
    // FNXC:GitHubImportTranslate 2026-07-15-09:30: The import-translate lane is project-scoped (like merger/summarization), so its project override must be editable here — otherwise the lane's projectProviderKey/projectModelKey would be unreachable and only the global lane could ever be set.
    // FNXC:SettingsModels 2026-07-15-12:00: Summarization is still project-scoped but is rendered with the AI summarization section below rather than the general Model Lanes list.
    const projectModelLanes = modelLanes.filter((lane) => ["default", "merger", "import-translate"].includes(lane.laneId));
    const summarizationLane = modelLanes.find((lane) => lane.laneId === "summarization");
    const getProjectLaneLabel = (lane: ModelLane) => {
        if (lane.laneId === "default") {
            return "Project Default Model";
        }
        if (lane.laneId === "merger") {
            return "Project Merger Model";
        }
        if (lane.laneId === "summarization") {
            return "Project Summarization Model";
        }
        if (lane.laneId === "import-translate") {
            return "Project Import Auto-Translation Model";
        }
        return lane.label;
    };
    const getProjectLaneHelperText = (lane: ModelLane) => {
        if (lane.laneId === "default") {
            return "Project-wide default AI model used when no more specific task or project lane override is set.";
        }
        if (lane.laneId === "merger") {
            return "Model used for merge conflict resolution, clean-room merge, stash-conflict recovery, and related merger agent sessions.";
        }
        if (lane.laneId === "summarization") {
            return "Model used for title auto-summarization, merge commit summaries, GitHub tracking issue titles, and PR title/body generation.";
        }
        if (lane.laneId === "import-translate") {
            return "Model used to translate foreign-language GitHub/GitLab issue titles and bodies in the Import Tasks panel. One short readonly call per issue — a cheap, fast model is usually the right pick.";
        }
        return lane.helperText;
    };
    /*
     * FNXC:SettingsModels 2026-07-16-00:00:
     * The merger fallback is project-scoped and must sit directly after Project Merger
     * in Model Lanes so operators configure the primary and retry models together.
     */
    const mergerFallbackValue = form.mergerFallbackProvider && form.mergerFallbackModelId
        ? `${form.mergerFallbackProvider}/${form.mergerFallbackModelId}`
        : "";
    const mergerFallbackThinkingValue = typeof form.mergerFallbackThinkingLevel === "string"
        ? form.mergerFallbackThinkingLevel
        : "";
    const mergerFallbackCustomized = Boolean(mergerFallbackValue || mergerFallbackThinkingValue);
    const setMergerFallbackValue = (value: string) => {
        if (!value) {
            setForm((f) => ({ ...f, mergerFallbackProvider: undefined, mergerFallbackModelId: undefined, mergerFallbackThinkingLevel: undefined } as SettingsFormState));
            return;
        }
        const slashIdx = value.indexOf("/");
        setForm((f) => ({
            ...f,
            mergerFallbackProvider: value.slice(0, slashIdx),
            mergerFallbackModelId: value.slice(slashIdx + 1),
        } as SettingsFormState));
    };
    const setMergerFallbackThinkingValue = (value: string) => {
        setForm((f) => ({ ...f, mergerFallbackThinkingLevel: value || undefined } as SettingsFormState));
    };
    const resetMergerFallbackValue = () => {
        setForm((f) => ({ ...f, mergerFallbackProvider: undefined, mergerFallbackModelId: undefined, mergerFallbackThinkingLevel: undefined } as SettingsFormState));
    };
    const renderMergerFallbackLane = () => (
      <div className="form-group" data-testid="project-model-lane-merger-fallback">
        <div className="settings-model-lane-label-row">
          <label htmlFor="mergerFallbackModel">{t("settings.projectModels.mergerFallbackModel", "Merger Fallback Model")}</label>
          <span className={`settings-lane-badge ${mergerFallbackCustomized ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`} title={mergerFallbackCustomized ? "Explicitly set for this project" : "Inherited from global settings"}>
            {mergerFallbackCustomized ? "Override (Project)" : "Inherited (Global)"}
          </span>
          <SettingsHelpTip settingKey="mergerFallbackModel">
            {t("settings.projectModels.mergerFallbackHelp", "Fallback provider and model used when a merger session retries. Leave unset to use the shared global fallback model pair.")}
          </SettingsHelpTip>
        </div>
        <div className="settings-model-lane-control-row">
          <div className="settings-model-lane-control-main">
            <CustomModelDropdown id="mergerFallbackModel" label="Merger Fallback Model" models={availableModels} value={mergerFallbackValue} onChange={setMergerFallbackValue} placeholder={t("settings.projectModels.useGlobal", "Use global")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable" showThinkingLevel={true} thinkingLevel={mergerFallbackThinkingValue} onThinkingLevelChange={setMergerFallbackThinkingValue} defaultThinkingLevel={form.defaultThinkingLevel}/>
          </div>
          {mergerFallbackCustomized && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToInheritFromGlobal", "Reset to inherit from global")} onClick={resetMergerFallbackValue}>{t("settings.projectModels.reset", " Reset ")}</button>)}
        </div>
      </div>
    );
    const titleSummarizerFallbackValue = form.titleSummarizerFallbackProvider && form.titleSummarizerFallbackModelId
        ? `${form.titleSummarizerFallbackProvider}/${form.titleSummarizerFallbackModelId}`
        : "";
    const titleSummarizerFallbackThinkingValue = typeof form.titleSummarizerFallbackThinkingLevel === "string"
        ? form.titleSummarizerFallbackThinkingLevel
        : "";
    const titleSummarizerFallbackCustomized = Boolean(titleSummarizerFallbackValue || titleSummarizerFallbackThinkingValue);
    const setTitleSummarizerFallbackValue = (value: string) => {
        if (!value) {
            setForm((f) => ({ ...f, titleSummarizerFallbackProvider: undefined, titleSummarizerFallbackModelId: undefined, titleSummarizerFallbackThinkingLevel: undefined } as SettingsFormState));
            return;
        }
        const slashIdx = value.indexOf("/");
        setForm((f) => ({
            ...f,
            titleSummarizerFallbackProvider: value.slice(0, slashIdx),
            titleSummarizerFallbackModelId: value.slice(slashIdx + 1),
        } as SettingsFormState));
    };
    const setTitleSummarizerFallbackThinkingValue = (value: string) => {
        setForm((f) => ({ ...f, titleSummarizerFallbackThinkingLevel: value || undefined } as SettingsFormState));
    };
    const resetTitleSummarizerFallbackValue = () => {
        setForm((f) => ({ ...f, titleSummarizerFallbackProvider: undefined, titleSummarizerFallbackModelId: undefined, titleSummarizerFallbackThinkingLevel: undefined } as SettingsFormState));
    };
    /*
     * FNXC:SettingsModels 2026-07-15-12:00:
     * Project Summarization and its title-summarizer fallback must be colocated
     * with AI title and commit summarization settings, while keeping their shared
     * lane UI, override behavior, and responsive layout identical to other project lanes.
     */
    const renderProjectLane = (lane: ModelLane) => {
        const status = getLaneStatus(lane);
        const value = getLaneValue(lane);
        const thinkingValue = getLaneThinkingValue(lane);
        const isOverridden = status === "overridden" || Boolean(thinkingValue);
        const laneLabel = getProjectLaneLabel(lane);
        return (<div className="form-group" key={lane.laneId}>
        {/*
        FNXC:SettingsHelp 2026-07-15-23:10:
        Lane help rides the same "?" as every other row. It reads as an exception — a lane is a label + inherited/override badge + dropdown + conditional Reset, and its copy ends in the resolved fallback CHAIN — but that argues for WHERE the tip hangs (the label row, beside the badge), not for keeping a paragraph. Left inline, Project Models was the one section still showing prose under every control while its neighbours showed an icon; the global lanes next door already use the tip.
        The badge stays in view precisely because it IS live state ("Override (Project)" vs "Inherited (Global)") — the fallback chain behind it explains that badge, and is what an operator opens deliberately.
        */}
        <div className="settings-model-lane-label-row">
          <label htmlFor={`${lane.laneId}Model`}>{laneLabel}</label>
          <span className={`settings-lane-badge ${isOverridden ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`} title={isOverridden ? "Explicitly set for this project" : "Inherited from global settings"}>
            {isOverridden ? "Override (Project)" : "Inherited (Global)"}
          </span>
          <SettingsHelpTip settingKey={`${lane.laneId}Model`}>
            {getProjectLaneHelperText(lane)}{t("settings.projectModels.fallsBackTo", " Falls back to: ")}{lane.fallbackOrder}.
          </SettingsHelpTip>
        </div>
        <div className="settings-model-lane-control-row">
          <div className="settings-model-lane-control-main">
            <CustomModelDropdown id={`${lane.laneId}Model`} label={laneLabel} models={availableModels} value={value} onChange={(val) => updateLaneValue(lane, val)} placeholder={lane.laneId === "default" ? "Use global default" : "Use global"} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable" showThinkingLevel={Boolean(lane.projectThinkingKey)} thinkingLevel={thinkingValue} onThinkingLevelChange={(level) => updateLaneThinkingValue(lane, level)} defaultThinkingLevel={form.defaultThinkingLevel}/>
          </div>
          {isOverridden && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToInheritFromGlobal", "Reset to inherit from global")} onClick={() => { resetLaneValue(lane); resetLaneThinkingValue(lane); }} style={{ whiteSpace: "nowrap" }}>{t("settings.projectModels.reset", " Reset ")}</button>)}
        </div>
      </div>);
    };
    const chatDefaultKind = form.chatDefaultKind ?? "model";
    const chatDefaultModelValue = form.chatDefaultModelProvider && form.chatDefaultModelId
        ? `${form.chatDefaultModelProvider}/${form.chatDefaultModelId}`
        : "";
    const chatDefaultThinkingValue = typeof form.chatDefaultThinkingLevel === "string"
        ? form.chatDefaultThinkingLevel
        : "";
    const chatDefaultCustomized = Boolean(form.chatNewSessionMode || form.chatDefaultKind || form.chatDefaultAgentId || chatDefaultModelValue || chatDefaultThinkingValue);
    const setChatDefaultModelValue = (value: string) => {
        if (!value) {
            setForm((f) => ({ ...f, chatDefaultKind: "model", chatDefaultAgentId: undefined, chatDefaultModelProvider: undefined, chatDefaultModelId: undefined, chatDefaultThinkingLevel: undefined } as SettingsFormState));
            return;
        }
        const slashIdx = value.indexOf("/");
        if (slashIdx <= 0)
            return;
        setForm((f) => ({
            ...f,
            chatDefaultKind: "model",
            chatDefaultAgentId: undefined,
            chatDefaultModelProvider: value.slice(0, slashIdx),
            chatDefaultModelId: value.slice(slashIdx + 1),
        } as SettingsFormState));
    };
    const setChatDefaultThinkingValue = (value: string) => {
        setForm((f) => ({ ...f, chatDefaultThinkingLevel: value || undefined } as SettingsFormState));
    };
    const resetChatDefaultValue = () => {
        setForm((f) => ({ ...f, chatNewSessionMode: undefined, chatDefaultKind: undefined, chatDefaultAgentId: undefined, chatDefaultModelProvider: undefined, chatDefaultModelId: undefined, chatDefaultThinkingLevel: undefined } as SettingsFormState));
    };
    return (<>

      {/* --- Token Cap --- */}
      <h4 className="settings-section-heading">{t("settings.projectModels.tokenCap", "Token Cap")}</h4>
      {/*
      FNXC:SettingsModels 2026-07-15-17:35:
      The reset affordance stays conditional on an actual cap being set: "no cap" is the unset state, so offering to reset a lane that is already unset would advertise an action with nothing to undo.
      `v ? Math.trunc(v) : null` reproduces the previous `val ? parseInt(val, 10) : null` contract exactly \u2014 a token cap is a whole number of tokens, and 0 means "no cap" (null), not a cap of zero.
      */}
      <SettingsNumberRow
        descriptor={{
          key: "tokenCap",
          label: t("settings.projectModels.tokenCap", "Token Cap"),
          help: t("settings.projectModels.automaticallyCompactContextWhenApproachingThisTokenCount", "Automatically compact context when approaching this token count. Leave empty for no cap (compact only on overflow errors). Set a number to proactively compact when reaching this token count. No default \u2014 unset (no cap)."),
          scope: "project",
          placeholder: t("settings.projectModels.noCap", "No cap"),
        }}
        value={form.tokenCap ?? null}
        onChange={(v) => setForm((f) => ({ ...f, tokenCap: v ? Math.trunc(v) : null } as SettingsFormState))}
        clearable={form.tokenCap != null}
      />

      {/* --- Project Model Lanes --- */}
      {/* FNXC:SettingsHelp 2026-07-16-12:45: Section description moved behind the shared "?" affordance beside the heading — operator requirement: no inline description paragraphs in Settings. */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.modelLanes", "Model Lanes")}</h4>
        <SettingsHelpTip settingKey="project-model-lanes">{t("settings.projectModels.overrideGlobalModelSettingsAtTheProjectLevel", " Override global model settings at the project level. Each lane controls a specific AI usage context. Unset lanes inherit from the corresponding global lane. The Project Default Model is the fallback for this project when a more specific lane is unset. ")}</SettingsHelpTip>
      </div>
      {modelsLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.projectModels.loadingAvailableModels", "Loading available models\u2026")} /></div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.noModelsAvailableConfigureAuthenticationFirst", " No models available. Configure authentication first. ")}</div>) : (<>
          {projectModelLanes.filter((lane) => lane.laneId === "default" || lane.laneId === "merger").map(renderProjectLane)}
          {renderMergerFallbackLane()}
          {projectModelLanes.filter((lane) => lane.laneId === "import-translate").map(renderProjectLane)}
        </>)}

      {/* FNXC:ChatModels 2026-07-12-20:45: Project Models owns the Direct-chat default because New Chat needs a project-scoped model-or-agent target plus prompt-vs-direct creation mode without changing workflow or in-chat switcher settings. */}
      {/* FNXC:SettingsHelp 2026-07-16-12:45: Section description moved behind the shared "?" affordance beside the heading — operator requirement: no inline description paragraphs in Settings. */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.chatHeading", "Chat")}</h4>
        <SettingsHelpTip settingKey="project-chat-defaults">{t("settings.projectModels.chatDescription", "Choose the default target for new Direct chats and whether New Chat should prompt or immediately use that default.")}</SettingsHelpTip>
      </div>
      {/*
      FNXC:SettingsModels 2026-07-15-17:35:
      Only the mode select migrates to a primitive. The target picker below it (Model/Agent segmented toggle + model dropdown or agent select + shared Reset) is one compound control over five form keys, not a row per key, so it stays bespoke.
      "prompt" is the unset default rather than a stored value: anything that is not `always-default` writes `undefined` so the key is deleted rather than persisted at its default.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "chatNewSessionMode",
          label: t("settings.projectModels.chatNewSessionMode", "New Chat behavior"),
          help: t("settings.projectModels.chatNewSessionModeHelp", "Prompt mode opens New Chat with this default preselected. Always-default mode skips the dialog when the configured default is complete."),
          scope: "project",
          options: [
            { value: "prompt", label: t("settings.projectModels.chatNewSessionModePrompt", "Prompt for model each time") },
            { value: "always-default", label: t("settings.projectModels.chatNewSessionModeAlwaysDefault", "Always use configured default") },
          ],
        }}
        value={form.chatNewSessionMode ?? "prompt"}
        onChange={(v) => setForm((f) => ({ ...f, chatNewSessionMode: v === "always-default" ? "always-default" : undefined } as SettingsFormState))}
      />
      <div className="form-group" data-testid="project-models-chat-kind">
        <label>{t("settings.projectModels.chatDefaultKind", "Chat default target")}</label>
        <div className="chat-new-dialog-mode-toggle" data-testid="project-models-chat-kind-toggle">
          <button type="button" className={`chat-new-dialog-mode-btn${chatDefaultKind === "model" ? " chat-new-dialog-mode-btn--active" : ""}`} onClick={() => setForm((f) => ({ ...f, chatDefaultKind: "model", chatDefaultAgentId: undefined } as SettingsFormState))}>
            {t("settings.projectModels.chatDefaultKindModel", "Model")}
          </button>
          <button type="button" className={`chat-new-dialog-mode-btn${chatDefaultKind === "agent" ? " chat-new-dialog-mode-btn--active" : ""}`} onClick={() => setForm((f) => ({ ...f, chatDefaultKind: "agent", chatDefaultModelProvider: undefined, chatDefaultModelId: undefined, chatDefaultThinkingLevel: undefined } as SettingsFormState))}>
            {t("settings.projectModels.chatDefaultKindAgent", "Agent")}
          </button>
        </div>
      </div>
      {chatDefaultKind === "model" ? (<div className="form-group" data-testid="project-models-chat-model">
          {/*
          FNXC:SettingsHelp 2026-07-15-21:40:
          Model mode is a plain label + control + help row, so its help hangs off the same "?" as the New Chat behavior select directly above it instead of printing a paragraph beside it.
          FNXC:SettingsHelp 2026-07-16-12:45: The agent-mode branch's descriptive help now hangs off the same "?" too — operator requirement: no inline description paragraphs in Settings. Only its dynamic empty-state line ("No agents are available for this project yet.") stays inline, because it is live status explaining an empty picker and must stay in view.
          */}
          <div className="settings-field-label-row">
            <label htmlFor="chatDefaultModel">{t("settings.projectModels.chatDefaultModel", "Chat Default Model")}</label>
            <SettingsHelpTip settingKey="chatDefaultModel">{t("settings.projectModels.chatDefaultModelHelp", "Model-mode New Chat uses the built-in Fusion chat agent with this provider/model pair. Leave empty to fall back to prompting.")}</SettingsHelpTip>
          </div>
          <div className="settings-model-lane-control-row">
            <div className="settings-model-lane-control-main">
              <CustomModelDropdown id="chatDefaultModel" label={t("settings.projectModels.chatDefaultModel", "Chat Default Model")} models={availableModels} value={chatDefaultModelValue} onChange={setChatDefaultModelValue} placeholder={t("settings.projectModels.selectChatDefaultModel", "Select a chat default model")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable" showThinkingLevel={true} thinkingLevel={chatDefaultThinkingValue} onThinkingLevelChange={setChatDefaultThinkingValue} defaultThinkingLevel={form.defaultThinkingLevel}/>
            </div>
            {chatDefaultCustomized && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.chatDefaultReset", "Reset Chat default")} onClick={resetChatDefaultValue}>{t("settings.projectModels.reset", " Reset ")}</button>)}
          </div>
        </div>) : (<div className="form-group" data-testid="project-models-chat-agent">
          <div className="settings-field-label-row">
            <label htmlFor="chatDefaultAgentId">{t("settings.projectModels.chatDefaultAgent", "Chat Default Agent")}</label>
            <SettingsHelpTip settingKey="chatDefaultAgentId">{t("settings.projectModels.chatDefaultAgentHelp", "Agent-mode New Chat starts a Direct chat with the selected durable agent.")}</SettingsHelpTip>
          </div>
          <div className="settings-model-lane-control-row">
            <div className="settings-model-lane-control-main">
              <select id="chatDefaultAgentId" value={form.chatDefaultAgentId ?? ""} disabled={agentsLoading || agents.length === 0} onChange={(event) => setForm((f) => ({ ...f, chatDefaultKind: "agent", chatDefaultAgentId: event.target.value || undefined, chatDefaultModelProvider: undefined, chatDefaultModelId: undefined, chatDefaultThinkingLevel: undefined } as SettingsFormState))}>
                <option value="">{agentsLoading ? t("settings.projectModels.loadingAgents", "Loading agents…") : t("settings.projectModels.selectChatDefaultAgent", "Select a chat default agent")}</option>
                {agents.map((agent) => (<option key={agent.id} value={agent.id}>{agent.name} ({agent.role})</option>))}
              </select>
            </div>
            {chatDefaultCustomized && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.chatDefaultReset", "Reset Chat default")} onClick={resetChatDefaultValue}>{t("settings.projectModels.reset", " Reset ")}</button>)}
          </div>
          {agents.length === 0 && !agentsLoading ? (<small>{t("settings.projectModels.chatDefaultAgentEmpty", "No agents are available for this project yet.")}</small>) : null}
        </div>)}

      {/* --- Default workflow model lanes --- */}
      {/* FNXC:SettingsHelp 2026-07-16-12:45: Section description moved behind the shared "?" affordance beside the heading — operator requirement: no inline description paragraphs in Settings. */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.defaultWorkflowModelLanes", "Default workflow model lanes")}</h4>
        <SettingsHelpTip settingKey="default-workflow-model-lanes">
          {t("settings.movedStub.modelLanes", "Per-phase model lanes (execution, planning, reviewer, and their fallbacks) now live on the workflow.")}{t("settings.projectModels.theseProjectOverridesApplyToTheActiveDefault", " These project overrides apply to the active default workflow. ")}</SettingsHelpTip>
      </div>
      {!projectId ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.openAProjectToEditWorkflowModelLanes", "Open a project to edit workflow model lanes.")}</div>) : workflowLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.projectModels.loadingWorkflowModelLanes", "Loading workflow model lanes\u2026")} /></div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.noModelsAvailableConfigureAuthenticationBeforeSelectingWorkflow", " No models available. Configure authentication before selecting workflow model lanes. ")}</div>) : (<>
          {workflowModelPairs.map((pair) => {
                const value = modelPairValue(effectiveWorkflowValues, pair);
                const rawThinkingValue = pair.thinkingId ? effectiveWorkflowValues[pair.thinkingId] : undefined;
                const thinkingValue: string = typeof rawThinkingValue === "string" ? rawThinkingValue : "";
                const modelCustomized = Object.prototype.hasOwnProperty.call(workflowPending, pair.providerId)
                    ? workflowPending[pair.providerId] !== null
                    : Boolean(workflowPayload?.stored && (Object.prototype.hasOwnProperty.call(workflowPayload.stored, pair.providerId)
                        || Object.prototype.hasOwnProperty.call(workflowPayload.stored, pair.modelId)));
                const thinkingCustomized = pair.thinkingId
                    ? (Object.prototype.hasOwnProperty.call(workflowPending, pair.thinkingId)
                        ? workflowPending[pair.thinkingId] !== null
                        : Boolean(workflowPayload?.stored && Object.prototype.hasOwnProperty.call(workflowPayload.stored, pair.thinkingId)))
                    : false;
                const customized = modelCustomized || thinkingCustomized;
                const error = workflowRejections[pair.providerId]?.message ?? workflowRejections[pair.modelId]?.message ?? (pair.thinkingId ? workflowRejections[pair.thinkingId]?.message : undefined);
                return (<div className="form-group" key={pair.id} data-testid={`workflow-model-lane-${pair.id}`}>
                <div className="settings-model-lane-label-row">
                  <label htmlFor={`workflow-${pair.id}-model`}>{pair.label}</label>
                  <span className={`settings-lane-badge ${customized ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`} title={customized ? "Explicitly set for this project workflow" : "Inherited from workflow defaults"}>
                    {customized ? "Override (Project)" : "Inherited (Workflow)"}
                  </span>
                  {/* FNXC:SettingsHelp 2026-07-15-23:10: Same affordance as the project lanes above — a workflow lane is the same shape, so its help hangs off the label row too rather than sitting under the dropdown as prose. */}
                  {pair.help ? <SettingsHelpTip settingKey={`workflow-${pair.id}-model`}>{pair.help}</SettingsHelpTip> : null}
                </div>
                <div className="settings-model-lane-control-row">
                  <div className="settings-model-lane-control-main">
                    <CustomModelDropdown id={`workflow-${pair.id}-model`} label={pair.label} models={availableModels} value={value} onChange={(next) => setWorkflowPairValue(pair, next)} placeholder={t("settings.projectModels.useWorkflowDefault", "Use workflow default")} defaultOptionLabel="Use workflow default" favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable" showThinkingLevel={Boolean(pair.thinkingId)} thinkingLevel={thinkingValue} onThinkingLevelChange={pair.thinkingId ? (level) => setWorkflowThinkingValue(pair, level) : undefined} defaultThinkingLevel={typeof form.defaultThinkingLevel === "string" ? form.defaultThinkingLevel : "off"}/>
                  </div>
                  {customized && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToInheritFromWorkflow", "Reset to inherit from workflow")} onClick={() => resetWorkflowPairValue(pair)} style={{ whiteSpace: "nowrap" }}>{t("settings.projectModels.reset", " Reset ")}</button>)}
                </div>
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
                }} placeholder={t("settings.projectModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable"/>
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
                }} placeholder={t("settings.projectModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable"/>
                </div>
              </>)}
          </div>
          <div className="modal-actions settings-preset-editor-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={onSavePresetDraft}>{t("settings.models.savePreset", "Save preset")}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setEditingPresetId(null); setPresetDraft(null); }}>{t("settings.actions.cancel", "Cancel")}</button>
          </div>
        </div>) : null}

      <SettingsToggleRow
        descriptor={{
          key: "autoSelectModelPreset",
          label: t("settings.projectModels.autoSelectPresetBasedOnTaskSize", " Auto-select preset based on task size "),
          help: t("settings.projectModels.autoSelectModelPresetHint", "Default: disabled."),
          scope: "project",
        }}
        value={form.autoSelectModelPreset || false}
        onChange={(v) => setForm((current) => ({ ...current, autoSelectModelPreset: v === true }))}
      />

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

      {/*
      FNXC:TaskDefinitionInputLanguage 2026-07-16-05:00:
      Keep task-definition language outside title and merge summarization controls: it changes
      triage authoring only, uses no summarizer lane, and is opt-in for supported detectable
      languages. The shared toggle row carries the responsive Project Models layout.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "taskDefinitionInInputLanguage",
          label: t("settings.projectModels.taskDefinitionInInputLanguage", "Write task definitions in the operator's input language"),
          help: t("settings.projectModels.taskDefinitionInInputLanguageHelp", "When enabled, generated task-definition prose uses supported detectable input languages (Spanish, French, Korean, or Chinese as zh-CN). Headings, markers, and code stay English. Unsupported or undetectable input stays English. Default: disabled."),
          scope: "project",
        }}
        value={form.taskDefinitionInInputLanguage || false}
        onChange={(v) => setForm((f) => ({ ...f, taskDefinitionInInputLanguage: v === true }))}
      />

      {/* --- AI Title and Git Commit Message Summarization --- */}
      <section data-testid="project-models-ai-summarization">
        {/*
        FNXC:SettingsHelp 2026-07-16-12:45:
        Section description moved behind the shared "?" affordance beside the heading — operator requirement: no inline description paragraphs in Settings.
        The formerly separate conditional paragraph (shown once any summarization feature is on) rides in the same tip as a conditional fragment; SettingsHelpTip's ReactNode children carry conditional copy, so the condition is preserved verbatim.
        */}
        <div className="settings-field-label-row">
          <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.projectModels.aITitleAndGitCommitMessageSummarization", " AI Title and Git Commit Message Summarization ")}</h4>
          <SettingsHelpTip settingKey="project-ai-summarization">
            {t("settings.projectModels.configuresTheModelUsedForTwoShortSummary", " Configures the model used for two short-summary jobs: auto-generating task titles from long descriptions, and generating merge commit summaries from step commits and diff stats. ")}
            {(form.autoSummarizeTitles || form.useAiMergeCommitSummary || form.githubTrackingEnabledByDefault || false)
              ? t("settings.movedStub.summarizerModelInline", "These summarization model controls govern title auto-summarization, merge commit summaries, GitHub tracking titles, and PR metadata generation.")
              : ""}
          </SettingsHelpTip>
        </div>
        {modelsLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.projectModels.loadingAvailableModels", "Loading available models…")} /></div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">{t("settings.projectModels.noModelsAvailableConfigureAuthenticationFirst", " No models available. Configure authentication first. ")}</div>) : (<>
            {summarizationLane ? renderProjectLane(summarizationLane) : null}
            {/* FNXC:Settings-ThinkingLevel 2026-07-10-12:08: Title-summarizer fallback provider/model/thinking settings are project-scoped, not workflow-declared. Render it with the summarization controls so saves use project null-as-delete semantics instead of the workflow-values API. */}
            <div className="form-group" data-testid="project-model-lane-title-summarizer-fallback">
              <div className="settings-model-lane-label-row">
                <label htmlFor="titleSummarizerFallbackModel">{t("settings.projectModels.titleSummarizerFallbackModel", "Title Summarizer Fallback Model")}</label>
                <span className={`settings-lane-badge ${titleSummarizerFallbackCustomized ? "settings-lane-badge--override" : "settings-lane-badge--inherited"}`} title={titleSummarizerFallbackCustomized ? "Explicitly set for this project" : "Inherited from global settings"}>
                  {titleSummarizerFallbackCustomized ? "Override (Project)" : "Inherited (Global)"}
                </span>
                {/* FNXC:SettingsHelp 2026-07-15-23:10: Same lane shape as the rows above, so its help hangs off the label row too — this was the last row in Settings still rendering help as a paragraph. */}
                <SettingsHelpTip settingKey="titleSummarizerFallbackModel">
                  {t("settings.projectModels.titleSummarizerFallbackHelp", "Fallback provider and model used when the primary Title Summarizer model cannot be used. Falls back to the global summarization lane and then the default model chain.")}
                </SettingsHelpTip>
              </div>
              <div className="settings-model-lane-control-row">
                <div className="settings-model-lane-control-main">
                  <CustomModelDropdown id="titleSummarizerFallbackModel" label="Title Summarizer Fallback Model" models={availableModels} value={titleSummarizerFallbackValue} onChange={setTitleSummarizerFallbackValue} placeholder={t("settings.projectModels.useGlobal", "Use global")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} menuWidth="readable" showThinkingLevel={true} thinkingLevel={titleSummarizerFallbackThinkingValue} onThinkingLevelChange={setTitleSummarizerFallbackThinkingValue} defaultThinkingLevel={form.defaultThinkingLevel}/>
                </div>
                {titleSummarizerFallbackCustomized && (<button type="button" className="btn btn-ghost btn-sm" title={t("settings.projectModels.resetToInheritFromGlobal", "Reset to inherit from global")} onClick={resetTitleSummarizerFallbackValue} style={{ whiteSpace: "nowrap" }}>{t("settings.projectModels.reset", " Reset ")}</button>)}
              </div>
            </div>
          </>)}
        {/*
        FNXC:SettingsSearch 2026-07-15-17:35:
        This is the row operators searched "summarize" for and could not find (FN-7907, patched again 2026-07-14). It is now indexed by descriptor key from ProjectModelsSection.search.ts, so the word in its own label is what search matches — no hand-maintained keyword list to fall behind again.
        */}
        <SettingsToggleRow
          descriptor={{
            key: "autoSummarizeTitles",
            label: t("settings.projectModels.autoSummarizeLongDescriptionsAsTitles", " Auto-summarize long descriptions as titles "),
            help: t("settings.projectModels.whenEnabledTasksCreatedWithoutATitleBut", " When enabled, tasks created without a title but with descriptions over 200 characters will automatically get an AI-generated title (max 60 characters). The same model is also used to generate fallback merge commit message bodies when the branch's commit log is empty (e.g. squash merges with no unique commits), and GitHub tracking issue titles when a tracked task has no title yet. Default: disabled. "),
            scope: "project",
          }}
          value={form.autoSummarizeTitles || false}
          onChange={(v) => setForm((f) => ({ ...f, autoSummarizeTitles: v === true }))}
        />

        <SettingsToggleRow
          descriptor={{
            key: "useAiMergeCommitSummary",
            label: t("settings.projectModels.aIMergeCommitSummaries", " AI merge commit summaries "),
            help: t("settings.projectModels.whenEnabledMergeCommitMessagesIncludeAnAI", " When enabled, merge commit messages include an AI-generated subject plus body summary (narrative + bullets + diff-stat) instead of just listing step commit subjects. Uses the title summarization model. Default: enabled. "),
            scope: "project",
          }}
          value={form.useAiMergeCommitSummary || false}
          onChange={(v) => setForm((f) => ({ ...f, useAiMergeCommitSummary: v === true }))}
        />

      <SettingsTextareaRow
        descriptor={{
          key: "prTitlePromptInstructions",
          label: t("settings.projectModels.prTitlePromptInstructions", "PR title prompt guidance"),
          help: t("settings.projectModels.prTitlePromptInstructionsHelp", "Guides the AI-generated Create PR title. Leave blank to use the default PR metadata prompt. No default \u2014 unset."),
          scope: "project",
          placeholder: t("settings.projectModels.prTitlePromptInstructionsPlaceholder", "Example: Use conventional-commit style and keep titles under 72 characters."),
        }}
        value={form.prTitlePromptInstructions || ""}
        onChange={(v) => setForm((f) => ({ ...f, prTitlePromptInstructions: v ?? "" }))}
      />

      <SettingsTextareaRow
        descriptor={{
          key: "prDescriptionPromptInstructions",
          label: t("settings.projectModels.prDescriptionPromptInstructions", "PR description prompt guidance"),
          help: t("settings.projectModels.prDescriptionPromptInstructionsHelp", "Guides the AI-generated Create PR summary, changes, and testing sections. Leave blank to use the default PR metadata prompt. No default \u2014 unset."),
          scope: "project",
          placeholder: t("settings.projectModels.prDescriptionPromptInstructionsPlaceholder", "Example: Emphasize operator-facing behavior and list verification commands exactly."),
        }}
        value={form.prDescriptionPromptInstructions || ""}
        onChange={(v) => setForm((f) => ({ ...f, prDescriptionPromptInstructions: v ?? "" }))}
      />
      </section>
    </>);
}
export default ProjectModelsSection;
