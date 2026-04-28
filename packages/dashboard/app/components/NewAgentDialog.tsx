import "./NewAgentDialog.css";
import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Agent, AgentCapability, ModelInfo, AgentGenerationSpec, PluginRuntimeInfo } from "../api";
import { createAgent, fetchAgents, fetchModels, updateGlobalSettings } from "../api";
import * as apiModule from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";
import { AgentGenerationModal } from "./AgentGenerationModal";
import { AGENT_PRESETS, type AgentPreset } from "./agent-presets";
import { SkillMultiselect } from "./SkillMultiselect";

export interface NewAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  projectId?: string;
}

const AGENT_ROLES: { value: AgentCapability; label: string; icon: string }[] = [
  { value: "triage", label: "Triage", icon: "⊕" },
  { value: "executor", label: "Executor", icon: "▶" },
  { value: "reviewer", label: "Reviewer", icon: "⊙" },
  { value: "merger", label: "Merger", icon: "⊞" },
  { value: "scheduler", label: "Scheduler", icon: "◷" },
  { value: "engineer", label: "Engineer", icon: "⎔" },
  { value: "custom", label: "Custom", icon: "✦" },
];

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Set of valid AgentCapability values for mapping generated roles */
const VALID_CAPABILITIES = new Set<string>(["triage", "executor", "reviewer", "merger", "scheduler", "engineer", "custom"]);

interface RuntimeConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
}

type StepZeroTab = "presets" | "custom";

export function NewAgentDialog({ isOpen, onClose, onCreated, projectId }: NewAgentDialogProps) {
  const [step, setStep] = useState(0);
  const [stepZeroTab, setStepZeroTab] = useState<StepZeroTab>("presets");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [role, setRole] = useState<AgentCapability>("custom");
  const [reportsTo, setReportsTo] = useState("");
  const [instructionsPath, setInstructionsPath] = useState("");
  const [instructionsText, setInstructionsText] = useState("");
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

  // Model dropdown state
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
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
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
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

  const handleGenerated = useCallback((spec: AgentGenerationSpec) => {
    // Map generated role to AgentCapability, default to "custom" if unrecognized
    const mappedRole = VALID_CAPABILITIES.has(spec.role)
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

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter(p => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      // Revert on error
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter(m => m !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      // Revert on error
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  const handlePresetSelect = useCallback((preset: AgentPreset) => {
    setSelectedPresetId(preset.id);
    setName(preset.name);
    setIcon(preset.icon);
    setTitle(preset.description ?? preset.title);
    setRole(preset.role);
    setSoul(preset.soul ?? "");
    setInstructionsText(preset.instructionsText ?? "");
    // Advance to Step 1 so user can review model selection
    setStep(1);
  }, []);

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
    setSoul("");
    setMemory("");
    setRuntimeConfig({ model: "", thinkingLevel: "off", maxTurns: 1000 });
    setRuntimeMode("model");
    setSelectedRuntimeId("");
    setSelectedPresetId(null);
    setSelectedSkills([]);
    setError(null);
    setIsGenerationModalOpen(false);
    onClose();
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const runtimeCfg: Record<string, unknown> = {};
      if (runtimeMode === "runtime") {
        if (selectedRuntimeId.trim()) runtimeCfg.runtimeHint = selectedRuntimeId.trim();
      } else if (runtimeConfig.model.trim()) {
        runtimeCfg.model = runtimeConfig.model.trim();
      }
      if (runtimeConfig.thinkingLevel !== "off") runtimeCfg.thinkingLevel = runtimeConfig.thinkingLevel;
      if (runtimeConfig.maxTurns !== 1000) runtimeCfg.maxTurns = runtimeConfig.maxTurns;
      await createAgent({
        name: name.trim(),
        role,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(reportsTo.trim() ? { reportsTo: reportsTo.trim() } : {}),
        ...(instructionsPath.trim() ? { instructionsPath: instructionsPath.trim() } : {}),
        ...(instructionsText.trim() ? { instructionsText: instructionsText.trim() } : {}),
        ...(soul.trim() ? { soul: soul.trim() } : {}),
        ...(memory.trim() ? { memory: memory.trim() } : {}),
        ...(Object.keys(runtimeCfg).length > 0 ? { runtimeConfig: runtimeCfg } : {}),
        ...(selectedSkills.length > 0 ? { metadata: { skills: selectedSkills } } : {}),
      }, projectId);
      handleClose();
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
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
        <label id={sourceLabelId}>Runtime Source</label>
        <div className="agent-runtime-mode-toggle" role="radiogroup" aria-labelledby={sourceLabelId}>
          <label className={`agent-runtime-mode-option${runtimeMode === "model" ? " agent-runtime-mode-option--active" : ""}`}>
            <input
              type="radio"
              name={sourceLabelId}
              value="model"
              checked={runtimeMode === "model"}
              onChange={() => handleRuntimeModeChange("model")}
            />
            <span>Built-in Model</span>
          </label>
          <label className={`agent-runtime-mode-option${runtimeMode === "runtime" ? " agent-runtime-mode-option--active" : ""}`}>
            <input
              type="radio"
              name={sourceLabelId}
              value="runtime"
              checked={runtimeMode === "runtime"}
              onChange={() => handleRuntimeModeChange("runtime")}
            />
            <span>Plugin Runtime</span>
          </label>
        </div>
      </div>
      {runtimeMode === "model" ? (
        <div className="agent-dialog-field">
          <label>Model</label>
          {modelsLoading ? (
            <div className="agent-dialog-loading">Loading models…</div>
          ) : (
            <CustomModelDropdown
              id="agent-model"
              label="Model"
              value={selectedModel}
              onChange={handleModelChange}
              models={availableModels}
              placeholder="Select a model…"
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
            />
          )}
        </div>
      ) : (
        <div className="agent-dialog-field">
          <label htmlFor="agent-runtime-hint">Runtime</label>
          {runtimesLoading ? (
            <div className="agent-dialog-loading">Loading runtimes…</div>
          ) : (
            <select
              id="agent-runtime-hint"
              className="select"
              value={selectedRuntimeId}
              onChange={e => setSelectedRuntimeId(e.target.value)}
            >
              <option value="">
                {availableRuntimes.length > 0 ? "Select a plugin runtime…" : "No plugin runtimes available"}
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
      <div className="agent-dialog" role="dialog" aria-modal="true" aria-label="Create new agent">
        {/* Header */}
        <div className="agent-dialog-header">
          <span className="agent-dialog-header-title">New Agent</span>
          <button
            className="btn-icon"
            onClick={handleClose}
            aria-label="Close"
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
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {step === 0 && (
            <div>
              <div className="agent-dialog-tabs" role="tablist" aria-label="Agent setup mode">
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
                  Preset personas
                </button>
                <button
                  id="agent-dialog-tab-custom"
                  type="button"
                  role="tab"
                  aria-controls="agent-dialog-panel-custom"
                  aria-selected={stepZeroTab === "custom"}
                  tabIndex={stepZeroTab === "custom" ? 0 : -1}
                  className={`agent-dialog-tab${stepZeroTab === "custom" ? " active" : ""}`}
                  onClick={() => setStepZeroTab("custom")}
                  data-testid="agent-dialog-tab-custom"
                >
                  Custom agent
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
                      Choose a preset persona to prefill role, identity, soul, and instructions
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
                          <span className="agent-preset-icon">{preset.icon}</span>
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
                    <div className="agent-dialog-section-header">Identity</div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-name">Name {!selectedPresetId && <span className="agent-dialog-required">*</span>}</label>
                      <input
                        id="agent-name"
                        type="text"
                        className="input"
                        placeholder="e.g. Frontend Reviewer"
                        value={name}
                        onChange={e => setName(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-title">Title <span className="agent-dialog-optional">(optional)</span></label>
                      <input
                        id="agent-title"
                        type="text"
                        className="input"
                        placeholder="e.g. Senior Code Reviewer"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-icon">Icon <span className="agent-dialog-optional">(optional)</span></label>
                      <input
                        id="agent-icon"
                        type="text"
                        className="input"
                        placeholder="e.g. 🤖"
                        value={icon}
                        onChange={e => setIcon(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label>Role</label>
                      <div className="agent-role-grid">
                        {AGENT_ROLES.map(r => (
                          <button
                            key={r.value}
                            type="button"
                            className={`agent-role-option${role === r.value ? " selected" : ""}`}
                            onClick={() => setRole(r.value)}
                          >
                            <span className="agent-role-option-icon">{r.icon}</span>
                            <span className="agent-role-option-label">{r.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="agent-dialog-section">
                    <div className="agent-dialog-section-header">Configuration</div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-reports-to">Reports To <span className="agent-dialog-optional">(optional)</span></label>
                      <select
                        id="agent-reports-to"
                        className="select"
                        value={reportsTo}
                        onChange={e => setReportsTo(e.target.value)}
                        disabled={managersLoading}
                      >
                        <option value="">No manager</option>
                        {availableManagers.map((manager) => (
                          <option key={manager.id} value={manager.id}>
                            {manager.name} ({manager.id})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-soul">Soul <span className="agent-dialog-optional">(optional)</span></label>
                      <textarea
                        id="agent-soul"
                        className="input"
                        rows={2}
                        placeholder="Describe the agent's personality and communication style..."
                        value={soul}
                        onChange={e => setSoul(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-memory">Agent Memory <span className="agent-dialog-optional">(optional)</span></label>
                      <textarea
                        id="agent-memory"
                        className="input"
                        rows={2}
                        placeholder="Private to this agent — durable preferences, operating habits, and context it should carry across tasks..."
                        value={memory}
                        onChange={e => setMemory(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-instructions-path">Instructions Path <span className="agent-dialog-optional">(optional)</span></label>
                      <input
                        id="agent-instructions-path"
                        type="text"
                        className="input"
                        placeholder="e.g. .fusion/agents/reviewer.md"
                        value={instructionsPath}
                        onChange={e => setInstructionsPath(e.target.value)}
                      />
                    </div>
                    <div className="agent-dialog-field">
                      <label htmlFor="agent-instructions-text">Inline Instructions <span className="agent-dialog-optional">(optional)</span></label>
                      <textarea
                        id="agent-instructions-text"
                        className="input"
                        rows={4}
                        placeholder="Add custom behavior instructions..."
                        value={instructionsText}
                        onChange={e => setInstructionsText(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="agent-dialog-section">
                    <div className="agent-dialog-section-header">Runtime</div>
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
                      Generate with AI
                    </button>
                    <p className="agent-dialog-ai-hint">
                      Describe your agent&apos;s role and let AI generate a specification
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
                <label htmlFor="agent-thinking">Thinking Level</label>
                <select
                  id="agent-thinking"
                  className="select"
                  value={runtimeConfig.thinkingLevel}
                  onChange={e => setRuntimeConfig(c => ({ ...c, thinkingLevel: e.target.value as ThinkingLevel }))}
                >
                  <option value="off">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div className="agent-dialog-field">
                <label htmlFor="agent-max-turns">Max Turns</label>
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
                  label="Skills"
                  value={selectedSkills}
                  onChange={setSelectedSkills}
                  projectId={projectId}
                />
                <p className="agent-dialog-optional agent-dialog-skills-hint">
                  Optional skills to assign to this agent
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <p className="agent-dialog-info">
                Review your agent configuration before creating.
              </p>
              <div className="agent-dialog-summary">
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">Name</span>
                  <span className="agent-dialog-summary-row-value">
                    {icon && <span className="agent-dialog-icon-prefix">{icon}</span>}
                    {name}
                  </span>
                </div>
                {title && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">Title</span>
                    <span>{title}</span>
                  </div>
                )}
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">Role</span>
                  <span>{selectedRole?.icon} {selectedRole?.label}</span>
                </div>
                {selectedReportsToId && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">Reports To</span>
                    <span>
                      {selectedManager
                        ? `${selectedManager.name} (${selectedManager.id})`
                        : selectedReportsToId}
                    </span>
                  </div>
                )}
                {instructionsPath.trim() && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">Instructions File</span>
                    <span>{instructionsPath.trim()}</span>
                  </div>
                )}
                {instructionsText.trim() && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">Inline Instructions</span>
                    <span>{instructionsText.trim().length} chars</span>
                  </div>
                )}
                {soul.trim() && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">Soul</span>
                    <span>{soul.trim().length} chars</span>
                  </div>
                )}
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">{runtimeMode === "runtime" ? "Runtime" : "Model"}</span>
                  <span>
                    {runtimeMode === "runtime" ? (
                      selectedRuntime ? (
                        selectedRuntime.name
                      ) : (
                        <em className="agent-dialog-summary-row-value--muted">Not selected</em>
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
                      <em className="agent-dialog-summary-row-value--muted">default</em>
                    )}
                  </span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">Thinking</span>
                  <span className="agent-dialog-summary-row-value--capitalize">{runtimeConfig.thinkingLevel}</span>
                </div>
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">Max Turns</span>
                  <span>{runtimeConfig.maxTurns}</span>
                </div>
                {selectedSkills.length > 0 && (
                  <div className="agent-dialog-summary-row">
                    <span className="agent-dialog-summary-row-label">Skills</span>
                    <span>{selectedSkills.length} skill{selectedSkills.length !== 1 ? "s" : ""} selected</span>
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
              Back
            </button>
          )}
          <button className="btn" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </button>
          {step < 2 ? (
            <button
              className="btn btn--primary"
              onClick={() => setStep(s => s + 1)}
              disabled={step === 0 && !name.trim() && !selectedPresetId}
            >
              Next
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={() => void handleCreate()}
              disabled={isSubmitting || !name.trim()}
            >
              {isSubmitting ? "Creating..." : "Create"}
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
    </div>,
    document.body,
  );
}
