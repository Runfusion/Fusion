import { useState, useEffect, useCallback } from "react";
import type { AgentCapability, ModelInfo, AgentGenerationSpec } from "../api";
import { createAgent, fetchModels } from "../api";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";
import { AgentGenerationModal } from "./AgentGenerationModal";

export interface NewAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  projectId?: string;
}

const AGENT_ROLES: { value: AgentCapability; label: string; icon: string }[] = [
  { value: "triage", label: "Triage", icon: "🔍" },
  { value: "executor", label: "Executor", icon: "⚡" },
  { value: "reviewer", label: "Reviewer", icon: "👁" },
  { value: "merger", label: "Merger", icon: "🔀" },
  { value: "scheduler", label: "Scheduler", icon: "⏰" },
  { value: "engineer", label: "Engineer", icon: "🛠" },
  { value: "custom", label: "Custom", icon: "🔧" },
];

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Set of valid AgentCapability values for mapping generated roles */
const VALID_CAPABILITIES = new Set<string>(["triage", "executor", "reviewer", "merger", "scheduler", "engineer", "custom"]);

interface RuntimeConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
}

/** Preset agent template for one-click creation */
interface AgentPreset {
  /** Unique identifier for the preset */
  id: string;
  /** Display name (e.g., "CEO", "CTO") */
  name: string;
  /** Emoji icon */
  icon: string;
  /** Professional title (e.g., "Chief Executive Officer") */
  title: string;
  /** Agent capability role */
  role: AgentCapability;
  /** Optional description of the agent's responsibilities */
  description?: string;
}

const AGENT_PRESETS: AgentPreset[] = [
  { id: "ceo", name: "CEO", icon: "👔", title: "Chief Executive Officer", role: "custom" },
  { id: "cto", name: "CTO", icon: "🧠", title: "Chief Technology Officer", role: "custom" },
  { id: "cmo", name: "CMO", icon: "📢", title: "Chief Marketing Officer", role: "custom" },
  { id: "cfo", name: "CFO", icon: "💰", title: "Chief Financial Officer", role: "custom" },
  { id: "engineer", name: "Engineer", icon: "👨‍💻", title: "Software Engineer", role: "engineer" },
  { id: "backend-engineer", name: "Backend Engineer", icon: "⚙️", title: "Backend Engineer", role: "engineer" },
  { id: "frontend-engineer", name: "Frontend Engineer", icon: "🎨", title: "Frontend Engineer", role: "engineer" },
  { id: "fullstack-engineer", name: "Fullstack Engineer", icon: "🚀", title: "Full Stack Engineer", role: "engineer" },
  { id: "qa-engineer", name: "QA Engineer", icon: "🧪", title: "Quality Assurance Engineer", role: "engineer" },
  { id: "devops-engineer", name: "DevOps Engineer", icon: "🔧", title: "DevOps Engineer", role: "engineer" },
  { id: "ci-engineer", name: "CI Engineer", icon: "⚡", title: "CI/CD Engineer", role: "engineer" },
  { id: "security-engineer", name: "Security Engineer", icon: "🛡️", title: "Security Engineer", role: "engineer" },
  { id: "data-engineer", name: "Data Engineer", icon: "📊", title: "Data Engineer", role: "engineer" },
  { id: "ml-engineer", name: "ML Engineer", icon: "🤖", title: "Machine Learning Engineer", role: "engineer" },
  { id: "product-manager", name: "Product Manager", icon: "📋", title: "Product Manager", role: "custom" },
  { id: "designer", name: "Designer", icon: "✏️", title: "Product Designer", role: "custom" },
  { id: "marketing-manager", name: "Marketing Manager", icon: "📣", title: "Marketing Manager", role: "custom" },
  { id: "technical-writer", name: "Technical Writer", icon: "📝", title: "Technical Writer", role: "custom" },
  { id: "triage", name: "Triage Agent", icon: "🔍", title: "Task Triage Agent", role: "triage" },
  { id: "reviewer", name: "Reviewer", icon: "👁️", title: "Code Reviewer", role: "reviewer" },
];

export function NewAgentDialog({ isOpen, onClose, onCreated, projectId }: NewAgentDialogProps) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [role, setRole] = useState<AgentCapability>("custom");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({
    model: "",
    thinkingLevel: "off",
    maxTurns: 10,
  });
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isGenerationModalOpen, setIsGenerationModalOpen] = useState(false);

  // Model dropdown state
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);

  // Load models on mount (global data, not per-agent)
  useEffect(() => {
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
  }, []);

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

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter(p => p !== provider)
      : [provider, ...currentFavorites];
    setFavoriteProviders(newFavorites);
  }, [favoriteProviders]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter(m => m !== modelId)
      : [modelId, ...currentFavorites];
    setFavoriteModels(newFavorites);
  }, [favoriteModels]);

  const handlePresetSelect = useCallback((preset: AgentPreset) => {
    setSelectedPresetId(preset.id);
    setName(preset.name);
    setIcon(preset.icon);
    setTitle(preset.title);
    setRole(preset.role);
    // Advance to Step 1 so user can review model selection
    setStep(1);
  }, []);

  if (!isOpen) return null;

  const handleClose = () => {
    setStep(0);
    setName("");
    setTitle("");
    setIcon("");
    setRole("custom");
    setRuntimeConfig({ model: "", thinkingLevel: "off", maxTurns: 10 });
    setSelectedPresetId(null);
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
      if (runtimeConfig.model.trim()) runtimeCfg.model = runtimeConfig.model.trim();
      if (runtimeConfig.thinkingLevel !== "off") runtimeCfg.thinkingLevel = runtimeConfig.thinkingLevel;
      if (runtimeConfig.maxTurns !== 10) runtimeCfg.maxTurns = runtimeConfig.maxTurns;
      await createAgent({
        name: name.trim(),
        role,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(Object.keys(runtimeCfg).length > 0 ? { runtimeConfig: runtimeCfg } : {}),
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

  return (
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
              {/* Quick Start Presets */}
              <div className="agent-presets">
                <div className="agent-presets-header">
                  Choose a preset or fill in details manually
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
                    </button>
                  ))}
                </div>
              </div>
              <div className="agent-dialog-field">
                <label htmlFor="agent-name">Name <span className="agent-dialog-required">*</span></label>
                <input
                  id="agent-name"
                  type="text"
                  className="input"
                  placeholder="e.g. Frontend Reviewer"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
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

          {step === 1 && (
            <div>
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
                  max={500}
                  value={runtimeConfig.maxTurns}
                  onChange={e => setRuntimeConfig(c => ({ ...c, maxTurns: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                />
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
                <div className="agent-dialog-summary-row">
                  <span className="agent-dialog-summary-row-label">Model</span>
                  <span>
                    {selectedModel ? (
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
              disabled={step === 0 && !name.trim()}
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
    </div>
  );
}
