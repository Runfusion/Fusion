import "./NewAgentDialog.css";
import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Agent, AgentCapability, ModelInfo, AgentGenerationSpec, PluginRuntimeInfo, AgentOnboardingSummary } from "../api";
import { createAgent, fetchAgents, fetchModels } from "../api";
import * as apiModule from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { LoadingSpinner } from "./LoadingSpinner";
import { ProviderIcon } from "./ProviderIcon";
import { AgentGenerationModal } from "./AgentGenerationModal";
import { AGENT_PRESETS, type AgentPreset } from "./agent-presets";
import {
  buildAgentCreatePayload,
  mapOnboardingSummaryToAgentDraft,
  mapPresetToAgentDraft,
  VALID_AGENT_CAPABILITIES,
  type ThinkingLevel,
} from "./agent-presets/agentCreatePayload";
import { STANDING_INSTRUCTIONS_TEMPLATE } from "./agent-presets/standing-instructions-template";
import { SkillMultiselect } from "./SkillMultiselect";
import { AgentAvatar } from "./AgentAvatar";
import { ExperimentalAgentOnboardingModal } from "./ExperimentalAgentOnboardingModal";
import { useFavorites } from "../hooks/useFavorites";

export interface NewAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  projectId?: string;
  prefillDraft?: AgentOnboardingSummary | null;
  agentOnboardingEnabled?: boolean;
  existingAgents?: Agent[];
  onPrefillDraft?: (draft: AgentOnboardingSummary | null) => void;
}

const AGENT_ROLES: { value: AgentCapability }[] = [
  { value: "triage" },
  { value: "executor" },
  { value: "reviewer" },
  { value: "merger" },
  { value: "scheduler" },
  { value: "engineer" },
  { value: "custom" },
];

interface RuntimeConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
}

type StepZeroTab = "presets" | "custom";

export function NewAgentDialog({
  isOpen,
  onClose,
  onCreated,
  projectId,
  prefillDraft = null,
  agentOnboardingEnabled = false,
  existingAgents = [],
  onPrefillDraft,
}: NewAgentDialogProps) {
  const { t } = useTranslation("app");

  const getRoleLabel = (value: AgentCapability): string => {
    const labels: Record<AgentCapability, string> = {
      triage: t("agents.roleTriage", "Triage"),
      executor: t("agents.roleExecutor", "Executor"),
      reviewer: t("agents.roleReviewer", "Reviewer"),
      merger: t("agents.roleMerger", "Merger"),
      scheduler: t("agents.roleScheduler", "Scheduler"),
      engineer: t("agents.roleEngineer", "Engineer"),
      custom: t("agents.roleCustom", "Custom"),
    };
    return labels[value] ?? value;
  };

  const [step, setStep] = useState(0);
  const [stepZeroTab, setStepZeroTab] = useState<StepZeroTab>("presets");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [role, setRole] = useState<AgentCapability>("custom");
  const [reportsTo, setReportsTo] = useState("");
  const [instructionsPath, setInstructionsPath] = useState("");
  const [instructionsText, setInstructionsText] = useState("");
  const [heartbeatProcedurePath, setHeartbeatProcedurePath] = useState("");
  const [soul, setSoul] = useState("");
  const [memory, setMemory] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({
    model: "",
    thinkingLevel: "off",
    maxTurns: 1000,
  });
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isGenerationModalOpen, setIsGenerationModalOpen] = useState(false);
  const [isInterviewOpen, setIsInterviewOpen] = useState(false);

  // Model dropdown state
  const { favoriteProviders, favoriteModels, toggleFavoriteProvider, toggleFavoriteModel } = useFavorites();
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<"model" | "runtime">("model");
  const [selectedRuntimeId, setSelectedRuntimeId] = useState("");
  const [availableRuntimes, setAvailableRuntimes] = useState<PluginRuntimeInfo[]>([]);
  const [runtimesLoading, setRuntimesLoading] = useState(false);

  // Manager dropdown state
  const [availableManagers, setAvailableManagers] = useState<Agent[]>([]);
  const [managersLoading, setManagersLoading] = useState(false);

  // Load models when dialog opens — guard prevents async setState after test assertions
  useEffect(() => {
    if (!isOpen) return;
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
      })
      .catch(() => {
        // Gracefully handle — dropdown will show empty list
      })
      .finally(() => setModelsLoading(false));
  }, [isOpen]);

  // Load manager options when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    setManagersLoading(true);
    setAvailableManagers([]);
    fetchAgents(undefined, projectId)
      .then((agents) => {
        setAvailableManagers(agents);
      })
      .catch(() => {
        // Gracefully handle — manager selector will show "No manager" only
        setAvailableManagers([]);
      })
      .finally(() => setManagersLoading(false));
  }, [isOpen, projectId]);

  // Load plugin runtimes when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    const fetchPluginRuntimes = apiModule.fetchPluginRuntimes;
    if (typeof fetchPluginRuntimes !== "function") {
      setAvailableRuntimes([]);
      setRuntimesLoading(false);
      return;
    }

    setRuntimesLoading(true);
    setAvailableRuntimes([]);
    fetchPluginRuntimes(projectId)
      .then((runtimes) => {
        setAvailableRuntimes(runtimes);
      })
      .catch(() => {
        // Gracefully handle — runtime selector will show empty state
        setAvailableRuntimes([]);
      })
      .finally(() => setRuntimesLoading(false));
  }, [isOpen, projectId]);

  // Selected model in "provider/modelId" format, or "" for default
  const selectedModel = runtimeConfig.model.includes("/")
    ? runtimeConfig.model
    : "";
  /*
   * FNXC:AgentRoles 2026-06-23-00:19:
   * Role selection should feel professional and model-aware, not cartoony. Use the selected model provider mark on each role card and a neutral default mark before selection; role identity stays in text labels.
   */
  const selectedModelProvider = selectedModel ? selectedModel.split("/")[0] : "default";

  const handleGenerated = useCallback((spec: AgentGenerationSpec) => {
    // Map generated role to AgentCapability, default to "custom" if unrecognized
    const mappedRole = VALID_AGENT_CAPABILITIES.has(spec.role)
      ? (spec.role as AgentCapability)
      : "custom";

    setName(spec.title);
    setTitle(spec.description);
    setIcon(spec.icon);
    setRole(mappedRole);
    // Map generated systemPrompt to instructionsText
    setInstructionsText(spec.systemPrompt);
    setRuntimeConfig(c => ({
      ...c,
      thinkingLevel: spec.thinkingLevel,
      maxTurns: spec.maxTurns,
    }));
    setIsGenerationModalOpen(false);
    // Advance to Step 1 so user can review model selection
    setStep(1);
  }, []);

  const handleModelChange = useCallback((value: string) => {
    // value is "provider/modelId" or "" for default
    setRuntimeConfig(c => ({ ...c, model: value }));
  }, []);

  const handleRuntimeModeChange = useCallback((mode: "model" | "runtime") => {
    setRuntimeMode(mode);
    if (mode === "model") {
      setSelectedRuntimeId("");
    }
  }, []);


  const handlePresetSelect = useCallback((preset: AgentPreset) => {
    const draft = mapPresetToAgentDraft(preset);
    setSelectedPresetId(preset.id);
    setName(draft.name);
    setIcon(draft.icon ?? "");
    setTitle(draft.title ?? "");
    setRole(draft.role);
    setSoul(draft.soul ?? "");
    setInstructionsText(draft.instructionsText ?? "");
    // Advance to Step 1 so user can review model selection
    setStep(1);
  }, []);

  const applyDraftToForm = useCallback((draft: AgentOnboardingSummary) => {
    const values = mapOnboardingSummaryToAgentDraft(draft);

    setStep(1);
    setStepZeroTab("custom");
    setName(values.name);
    setTitle(values.title ?? "");
    setIcon(values.icon ?? "");
    setRole(values.role);
    setReportsTo(values.reportsTo ?? "");
    setInstructionsText(values.instructionsText ?? "");
    setHeartbeatProcedurePath(values.heartbeatProcedurePath ?? "");
    setSoul(values.soul ?? "");
    setMemory(values.memory ?? "");
    setSelectedSkills(values.skills ?? []);
    setRuntimeConfig((current) => ({
      ...current,
      model: values.model ?? "",
      thinkingLevel: values.thinkingLevel ?? current.thinkingLevel,
      maxTurns: values.maxTurns ?? current.maxTurns,
    }));
    if (values.runtimeHint) {
      setRuntimeMode("runtime");
      setSelectedRuntimeId(values.runtimeHint);
    } else {
      setRuntimeMode("model");
      setSelectedRuntimeId("");
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !prefillDraft) return;
    applyDraftToForm(prefillDraft);
  }, [isOpen, prefillDraft, applyDraftToForm]);

  if (!isOpen) return null;

  const handleClose = () => {
    setStep(0);
    setStepZeroTab("presets");
    setName("");
    setTitle("");
    setIcon("");
    setRole("custom");
    setReportsTo("");
    setInstructionsPath("");
    setInstructionsText("");
    setHeartbeatProcedurePath("");
    setSoul("");
    setMemory("");
    setRuntimeConfig({ model: "", thinkingLevel: "off", maxTurns: 1000 });
    setRuntimeMode("model");
    setSelectedRuntimeId("");
    setSelectedPresetId(null);
    setSelectedSkills([]);
    setError(null);
    setIsGenerationModalOpen(false);
    setIsInterviewOpen(false);
    onClose();
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await createAgent(buildAgentCreatePayload({
        name,
        role,
        title,
        icon,
        reportsTo,
        instructionsPath,
        instructionsText,
        heartbeatProcedurePath,
        soul,
        memory,
        model: runtimeMode === "model" ? runtimeConfig.model : "",
        runtimeHint: runtimeMode === "runtime" ? selectedRuntimeId : "",
        thinkingLevel: runtimeConfig.thinkingLevel,
        maxTurns: runtimeConfig.maxTurns,
        skills: selectedSkills,
      }), projectId);
      handleClose();
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("agents.createError", "Failed to create agent"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedRole = AGENT_ROLES.find(r => r.value === role);
  const selectedReportsToId = reportsTo.trim();
  const selectedManager = selectedReportsToId
    ? availableManagers.find((manager) => manager.id === selectedReportsToId)
    : undefined;
  const selectedRuntime = selectedRuntimeId
    ? availableRuntimes.find((runtime) => runtime.runtimeId === selectedRuntimeId)
    : undefined;

  const renderRuntimeSourceSection = (sourceLabelId: string) => (
    <>
      <div className="agent-dialog-field">
        <label id={sourceLabelId}>{t("agents.runtimeSource", "Runtime Source")}</label>
        <div className="agent-runtime-mode-toggle" role="radiogroup" aria-labelledby={sourceLabelId}>
          <label className={`agent-runtime-mode-option${runtimeMode === "model" ? " agent-runtime-mode-option--active" : ""}`}>
            <input
              type="radio"
              name={sourceLabelId}
              value="model"
              checked={runtimeMode === "model"}
              onChange={() => handleRuntimeModeChange("model")}
            />
            <span>{t("agents.runtimeSourceBuiltIn", "Built-in Model")}</span>
          </label>
          <label className={`agent-runtime-mode-option${runtimeMode === "runtime" ? " agent-runtime-mode-option--active" : ""}`}>
            <input
              type="radio"
              name={sourceLabelId}
              value="runtime"
              checked={runtimeMode === "runtime"}
              onChange={() => handleRuntimeModeChange("runtime")}
            />
            <span>{t("agents.runtimeSourcePlugin", "Plugin Runtime")}</span>
          </label>
        </div>
      </div>
      {runtimeMode === "model" ? (
        <div className="agent-dialog-field">
          <label>{t("agents.model", "Model")}</label>
          {modelsLoading ? (
            <div className="agent-dialog-loading"><LoadingSpinner label={t("agents.loadingModels", "Loading models…")} /></div>
          ) : (
            <CustomModelDropdown
              id="agent-model"
              label={t("agents.model", "Model")}
              value={selectedModel}
              onChange={handleModelChange}
              models={availableModels}
              placeholder={t("agents.modelPlaceholder", "Select a model…")}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={toggleFavoriteProvider}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={toggleFavoriteModel}
              thinkingLevel={runtimeConfig.thinkingLevel}
              onThinkingLevelChange={(level) => setRuntimeConfig(c => ({ ...c, thinkingLevel: level as ThinkingLevel }))}
            />
          )}
        </div>
      ) : (
        <div className="agent-dialog-field">
          <label htmlFor="agent-runtime-hint">{t("agents.runtime", "Runtime")}</label>
          {runtimesLoading ? (
            <div className="agent-dialog-loading"><LoadingSpinner label={t("agents.loadingRuntimes", "Loading runtimes…")} /></div>
          ) : (
            <select
              id="agent-runtime-hint"
              className="select"
              value={selectedRuntimeId}
              onChange={e => setSelectedRuntimeId(e.target.value)}
            >
              <option value="">
                {availableRuntimes.length > 0 ? t("agents.runtimePlaceholder", "Select a plugin runtime…") : t("agents.runtimeEmpty", "No plugin runtimes available")}
              </option>
              {availableRuntimes.map((runtime) => (
                <option key={`${runtime.pluginId}:${runtime.runtimeId}`} value={runtime.runtimeId}>
                  {runtime.description ? `${runtime.name} — ${runtime.description}` : runtime.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </>
  );

  // Render through a portal to document.body so the overlay escapes any
  // ancestor stacking context / `overflow: hidden`. Without this, `position:
  // fixed` on the overlay was being trapped under .agents-view, so the
  // dialog rendered with its top hidden behind the in-page Agents header on
  // mobile (the header isn't taller than the dialog top — it's just stacked
  // above it because the dialog couldn't escape its container).
  return createPortal(
    <div className="agent-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="agent-dialog" role="dialog" aria-modal="true" aria-label={t("agents.dialogAriaLabel", "Create new agent")}>
        {/* Header */}
        <div className="agent-dialog-header">
          <span className="agent-dialog-header-title">{t("agents.dialogTitle", "New Agent")}</span>
          <button
            className="btn-icon"
            onClick={handleClose}
            aria-label={t("agents.closeAriaLabel", "Close")}
          >
            ×
          </button>
        </div>

        {/* Step indicator */}
        <div className="agent-dialog-steps">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className={`agent-dialog-step${i === step ? " active" : i < step ? " completed" : ""}`}
              aria-label={t("agents.stepAriaLabel", "Step {{step}}", { step: i + 1 })}
            />
          ))}
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {step === 0 && (
            <div>
              {agentOnboardingEnabled && (
                <div className="agent-dialog-step-zero-actions">
                  <button
                    type="button"
                    className="btn agent-dialog-interview-btn"
                    onClick={() => setIsInterviewOpen(true)}
                  >
                    {t("agents.aiInterview", "AI Interview")}
                  </button>
                </div>
              )}
              <div className="agent-dialog-tabs" role="tablist" aria-label={t("agents.setupModeAriaLabel", "Agent setup mode")}>
                <button
                  id="agent-dialog-tab-presets"
                  type="button"
                  role="tab"
                  aria-controls="agent-dialog-panel-presets"
                  aria-selected={stepZeroTab === "presets"}
                  tabIndex={stepZeroTab === "presets" ? 0 : -1}
                  className={`agent-dialog-tab${stepZeroTab === "presets" ? " active" : ""}`}
                  onClick={() => setStepZeroTab("presets")}
                  data-testid="agent-dialog-tab-presets"
                >
                  {t("agents.tabPresets", "Preset personas")}
                </button>
                <button
                  id="agent-dialog-tab-custom"
                  type="button"
                  role="tab"
                  aria-controls="agent-dialog-panel-custom"
                  aria-selected={stepZeroTab === "custom"}
                  tabIndex={stepZeroTab === "custom" ? 0 : -1}
                  className={`agent-dialog-tab${stepZeroTab === "custom" ? " active" : ""}`}
                  onClick={() => {
                    setStepZeroTab("custom");
                    // FNXC:StandingInstructionsTemplate 2026-07-13-12:35:
                    // Blank custom creates seed the six-section standing instructions skeleton so new permanent agents get structure without rewriting presets or existing agents.
                    setInstructionsText((prev) => (prev.trim() ? prev : STANDING_INSTRUCTIONS_TEMPLATE));
                  }}
                  data-testid="agent-dialog-tab-custom"
                >
                  {t("agents.tabCustom", "Custom agent")}
                </button>
              </div>

              {stepZeroTab === "presets" && (
                <div
                  id="agent-dialog-panel-presets"
                  className="agent-dialog-tab-panel"
                  role="tabpanel"
                  aria-labelledby="agent-dialog-tab-presets"
                >
                  <div className="agent-presets">
                    <div className="agent-presets-header">
                      {t("agents.presetsHeader", "Choose a preset persona to prefill role, identity, soul, and instructions")}
                    </div>
                    <div className="agent-presets-grid">
                      {AGENT_PRESETS.map(preset => (
                        <button
                          key={preset.id}
                          type="button"
                          className={`agent-preset-card${selectedPresetId === preset.id ? " selected" : ""}`}
                          data-testid={`preset-${preset.id}`}
                          onClick={() => handlePresetSelect(preset)}
                          title={preset.title}
                        >
                          <span className="agent-preset-icon"><AgentAvatar agent={{ id: preset.id, icon: preset.icon, name: preset.name }} size={28} /></span>
                          <span className="agent-preset-name">{preset.name}</span>
                          <span className="agent-preset-role">{preset.role}</span>
                          {preset.description && (
                            <span className="agent-preset-description">{preset.description}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {stepZeroTab === "custom" && (
                <div
                  id="agent-dialog-panel-custom"
                  className="agent-dialog-tab-panel"
                  role="tabpanel"
                  aria-labelledby="agent-dialog-tab-custom"
                >
                  <div className="agent-dialog-section">
                    <div className="agent-dialog-section-header">{t("agents.sectionIdentity", "Identity")}</div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-name">{t("agents.fieldName", "Name")} {!selectedPresetId && <span className="agent-dialog-required">*</span>}</label>
                      <input
                        id="agent-name"
                        type="text"
                        className="input"
                        placeholder={t("agents.namePlaceholder", "e.g. Frontend Reviewer")}
                        value={name}
                        onChange={e => setName(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field agent-dialog-field--title">
                      <label htmlFor="agent-title">{t("agents.fieldTitle", "Title")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <input
                        id="agent-title"
                        type="text"
                        className="input"
                        placeholder={t("agents.titlePlaceholder", "e.g. Senior Code Reviewer")}
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-icon">{t("agents.fieldIcon", "Icon")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <input
                        id="agent-icon"
                        type="text"
                        className="input"
                        placeholder={t("agents.iconPlaceholder", "e.g. 🤖")}
                        value={icon}
                        onChange={e => setIcon(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label>{t("agents.fieldRole", "Role")}</label>
                      <div className="agent-role-grid">
                        {AGENT_ROLES.map(r => (
                          <button
                            key={r.value}
                            type="button"
                            className={`agent-role-option${role === r.value ? " selected" : ""}`}
                            onClick={() => setRole(r.value)}
                          >
                            <span className="agent-role-option-icon" aria-hidden="true">
                              <ProviderIcon provider={selectedModelProvider} size="sm" />
                            </span>
                            <span className="agent-role-option-label">{getRoleLabel(r.value)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="agent-dialog-section">
                    <div className="agent-dialog-section-header">{t("agents.sectionConfiguration", "Configuration")}</div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-reports-to">{t("agents.fieldReportsTo", "Reports To")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <select
                        id="agent-reports-to"
                        className="select"
                        value={reportsTo}
                        onChange={e => setReportsTo(e.target.value)}
                        disabled={managersLoading}
                      >
                        <option value="">{t("agents.noManager", "No manager")}</option>
                        {availableManagers.map((manager) => (
                          <option key={manager.id} value={manager.id}>
                            {manager.name} ({manager.id})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-soul">{t("agents.fieldSoul", "Soul")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <textarea
                        id="agent-soul"
                        className="input"
                        rows={2}
                        placeholder={t("agents.soulPlaceholder", "Describe the agent's personality and communication style...")}
                        value={soul}
                        onChange={e => setSoul(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-memory">{t("agents.fieldMemory", "Agent Memory")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <textarea
                        id="agent-memory"
                        className="input"
                        rows={2}
                        placeholder={t("agents.memoryPlaceholder", "Private to this agent — durable preferences, operating habits, and context it should carry across tasks...")}
                        value={memory}
                        onChange={e => setMemory(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-instructions-path">{t("agents.fieldInstructionsPath", "Instructions Path")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <input
                        id="agent-instructions-path"
                        type="text"
                        className="input"
                        placeholder={t("agents.instructionsPathPlaceholder", "e.g. .fusion/agents/reviewer.md")}
                        value={instructionsPath}
                        onChange={e => setInstructionsPath(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-heartbeat-procedure-path">{t("agents.fieldHeartbeatPath", "Heartbeat Procedure Path")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <input
                        id="agent-heartbeat-procedure-path"
                        type="text"
                        className="input"
                        placeholder={t("agents.heartbeatPathPlaceholder", "e.g. .fusion/agents/ceo-agent2736/HEARTBEAT.md")}
                        value={heartbeatProcedurePath}
                        onChange={e => setHeartbeatProcedurePath(e.target.value)}
                      />
                      <p className="agent-dialog-optional agent-dialog-field-hint">
                        {t("agents.heartbeatPathHint", "Path to the agent's heartbeat procedure path, typically .fusion/agents/ceo-agent2736/HEARTBEAT.md. Legacy id-only default paths still work.")}
                      </p>
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-instructions-text">{t("agents.fieldInstructionsText", "Inline Instructions")} <span className="agent-dialog-optional">{t("agents.optional", "(optional)")}</span></label>
                      <textarea
                        id="agent-instructions-text"
                        className="input"
                        rows={4}
                        placeholder={t("agents.instructionsTextPlaceholder", "Add custom behavior instructions...")}
                        value={instructionsText}
                        onChange={e => setInstructionsText(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="agent-dialog-section">
                    <div className="agent-dialog-section-header">{t("agents.sectionRuntime", "Runtime")}</div>
                    {renderRuntimeSourceSection("agent-runtime-source-step-0")}
                  </div>
                  {/* AI-assisted generation */}
                  <div className="agent-dialog-ai-generate">
                    <button
                      type="button"
                      className="btn btn--ai-generate"
                      onClick={() => setIsGenerationModalOpen(true)}
                    >
                      <span>✨</span>
                      {t("agents.generateWithAI", "Generate with AI")}
                    </button>
                    <p className="agent-dialog-ai-hint">
                      {t("agents.generateHint", "Describe your agent's role and let AI generate a specification")}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div>
              {renderRuntimeSourceSection("agent-runtime-source-step-1")}
              <div className="agent-dialog-field">
                <label htmlFor="agent-max-turns">{t("agents.fieldMaxTurns", "Max Turns")}</label>
                <input
                  id="agent-max-turns"
                  type="number"
                  className="input"
                  min={1}
                  max={2000}
                  value={runtimeConfig.maxTurns}
                  onChange={e => setRuntimeConfig(c => ({ ...c, maxTurns: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                />
              </div>
              <div className="agent-dialog-field">
                <SkillMultiselect
                  id="agent-skills"
                  label={t("agents.fieldSkills", "Skills")}
                  value={selectedSkills}
                  onChange={setSelectedSkills}
                  projectId={projectId}
                />
                <p className="agent-dialog-optional agent-dialog-skills-hint">
                  {t("agents.skillsHint", "Optional skills to assign to this agent")}
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <p className="agent-dialog-info">
                {t("agents.reviewHint", "Review your agent configuration before creating.")}
              </p>
              <div className="agent-dialog-summary">
                  <div className="agent-dialog-summary-row agent-dialog-summary-row--editable">
                  <label className="agent-dialog-summary-row-label" htmlFor="agent-review-name">{t("agents.fieldName", "Name")}</label>
                  <input
                    id="agent-review-name"
                    type="text"
                    className="input"
                    placeholder={t("agents.namePlaceholder", "e.g. Frontend Reviewer")}
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                </div>
                <div className="agent-dialog-summary-row agent-dialog-summary-row--editable agent-dialog-summary-row--title">
                  <label className="agent-dialog-summary-row-label" htmlFor="agent-review-title">{t("agents.fieldTitle", "Title")}</label>
                  <input
                    id="agent-review-title"
                    type="text"
                    className="input"
                    placeholder={t("agents.titlePlaceholder", "e.g. Senior Code Reviewer")}
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                  />
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">{t("agents.fieldRole", "Role")}</span>
                  <span>{selectedRole ? getRoleLabel(selectedRole.value) : ""}</span>
                </div>
                {selectedReportsToId && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">{t("agents.fieldReportsTo", "Reports To")}</span>
                    <span>
                      {selectedManager
                        ? `${selectedManager.name} (${selectedManager.id})`
                        : selectedReportsToId}
                    </span>
                  </div>
                )}
                <div className="agent-dialog-summary-row agent-dialog-summary-row--editable">
                  <label className="agent-dialog-summary-row-label" htmlFor="agent-review-soul">{t("agents.fieldSoul", "Soul")}</label>
                  <textarea
                    id="agent-review-soul"
                    className="input"
                    rows={2}
                    placeholder={t("agents.soulPlaceholder", "Describe the agent's personality and communication style...")}
                    value={soul}
                    onChange={e => setSoul(e.target.value)}
                  />
                </div>
                <div className="agent-dialog-summary-row agent-dialog-summary-row--editable">
                  <label className="agent-dialog-summary-row-label" htmlFor="agent-review-heartbeat-procedure-path">{t("agents.fieldHeartbeatPath", "Heartbeat Procedure Path")}</label>
                  <input
                    id="agent-review-heartbeat-procedure-path"
                    type="text"
                    className="input"
                    placeholder={t("agents.heartbeatPathPlaceholder", "e.g. .fusion/agents/ceo-agent2736/HEARTBEAT.md")}
                    value={heartbeatProcedurePath}
                    onChange={e => setHeartbeatProcedurePath(e.target.value)}
                  />
                </div>
                <div className="agent-dialog-summary-row agent-dialog-summary-row--editable">
                  <label className="agent-dialog-summary-row-label" htmlFor="agent-review-instructions-path">{t("agents.fieldInstructionsPath", "Instructions Path")}</label>
                  <input
                    id="agent-review-instructions-path"
                    type="text"
                    className="input"
                    placeholder={t("agents.instructionsPathPlaceholder", "e.g. .fusion/agents/reviewer.md")}
                    value={instructionsPath}
                    onChange={e => setInstructionsPath(e.target.value)}
                  />
                </div>
                <div className="agent-dialog-summary-row agent-dialog-summary-row--editable">
                  <label className="agent-dialog-summary-row-label" htmlFor="agent-review-instructions-text">{t("agents.fieldInstructionsText", "Inline Instructions")}</label>
                  <textarea
                    id="agent-review-instructions-text"
                    className="input"
                    rows={4}
                    placeholder={t("agents.instructionsTextPlaceholder", "Add custom behavior instructions...")}
                    value={instructionsText}
                    onChange={e => setInstructionsText(e.target.value)}
                  />
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">{runtimeMode === "runtime" ? t("agents.runtime", "Runtime") : t("agents.model", "Model")}</span>
                  <span>
                    {runtimeMode === "runtime" ? (
                      selectedRuntime ? (
                        selectedRuntime.name
                      ) : (
                        <em className="agent-dialog-summary-row-value--muted">{t("agents.notSelected", "Not selected")}</em>
                      )
                    ) : selectedModel ? (
                      <>
                        <ProviderIcon provider={selectedModel.split("/")[0]} size="sm" />
                        {" "}
                        {(() => {
                          const slashIdx = selectedModel.indexOf("/");
                          const provider = selectedModel.slice(0, slashIdx);
                          const modelId = selectedModel.slice(slashIdx + 1);
                          const model = availableModels.find(m => m.provider === provider && m.id === modelId);
                          return model?.name || selectedModel;
                        })()}
                      </>
                    ) : (
                      <em className="agent-dialog-summary-row-value--muted">{t("agents.modelDefault", "default")}</em>
                    )}
                  </span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">{t("agents.fieldThinking", "Thinking")}</span>
                  <span className="agent-dialog-summary-row-value--capitalize">{runtimeConfig.thinkingLevel}</span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">{t("agents.fieldMaxTurns", "Max Turns")}</span>
                  <span>{runtimeConfig.maxTurns}</span>
                </div>
                {selectedSkills.length > 0 && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">{t("agents.fieldSkills", "Skills")}</span>
                    <span>{t("agents.skillsSelected", "{{count}} skill selected", { count: selectedSkills.length, defaultValue_one: "{{count}} skill selected", defaultValue_other: "{{count}} skills selected" })}</span>
                  </div>
                )}
              </div>
              {error && (
                <p className="agent-dialog-error">{error}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="agent-dialog-footer">
          {step > 0 && (
            <button className="btn" onClick={() => setStep(s => s - 1)} disabled={isSubmitting}>
              {t("agents.back", "Back")}
            </button>
          )}
          <button className="btn" onClick={handleClose} disabled={isSubmitting}>
            {t("agents.cancel", "Cancel")}
          </button>
          {step < 2 ? (
            <button
              className="btn btn--primary"
              onClick={() => setStep(s => s + 1)}
              disabled={step === 0 && !name.trim() && !selectedPresetId}
            >
              {t("agents.next", "Next")}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={() => void handleCreate()}
              disabled={isSubmitting || !name.trim()}
            >
              {isSubmitting ? t("agents.creating", "Creating...") : t("agents.create", "Create")}
            </button>
          )}
        </div>
      </div>

      {/* AI-assisted agent generation modal */}
      <AgentGenerationModal
        isOpen={isGenerationModalOpen}
        onClose={() => setIsGenerationModalOpen(false)}
        onGenerated={handleGenerated}
        projectId={projectId}
      />

      <ExperimentalAgentOnboardingModal
        isOpen={isInterviewOpen}
        onClose={() => setIsInterviewOpen(false)}
        onUseDraft={(draft) => {
          onPrefillDraft?.(draft);
          if (!onPrefillDraft) {
            applyDraftToForm(draft);
          }
          setIsInterviewOpen(false);
        }}
        projectId={projectId}
        existingAgents={existingAgents}
        mode="create"
      />
    </div>,
    document.body,
  );
}
