import { useState, useEffect, useCallback } from "react";
import type { WorkflowStep, WorkflowStepInput, WorkflowStepMode, WorkflowStepPhase } from "@fusion/core";
import {
  fetchWorkflowSteps,
  createWorkflowStep,
  updateWorkflowStep,
  deleteWorkflowStep,
  refineWorkflowStepPrompt,
  fetchWorkflowStepTemplates,
  createWorkflowStepFromTemplate,
  fetchScripts,
  fetchModels,
  type WorkflowStepTemplate,
  type ModelInfo,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import {
  X,
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Check,
  Loader2,
  FileText,
  CheckCircle,
  Shield,
  Zap,
  Eye,
  LayoutGrid,
  BookOpen,
  Terminal,
  MessageSquare,
} from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";

interface WorkflowStepManagerProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

interface StepFormData {
  name: string;
  description: string;
  mode: WorkflowStepMode;
  phase: WorkflowStepPhase;
  prompt: string;
  scriptName: string;
  enabled: boolean;
  defaultOn: boolean;
  modelProvider: string;
  modelId: string;
}

type TabId = "my-steps" | "templates";

const EMPTY_FORM: StepFormData = {
  name: "",
  description: "",
  mode: "prompt",
  phase: "pre-merge" as WorkflowStepPhase,
  prompt: "",
  scriptName: "",
  enabled: true,
  defaultOn: false,
  modelProvider: "",
  modelId: "",
};

/** Build the combined "provider/modelId" value for CustomModelDropdown */
function getModelDropdownValue(provider: string, modelId: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

/** Parse "provider/modelId" dropdown value back into separate fields */
function parseModelDropdownValue(value: string): { provider: string; modelId: string } {
  if (!value) return { provider: "", modelId: "" };
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return { provider: "", modelId: "" };
  return { provider: value.slice(0, slashIndex), modelId: value.slice(slashIndex + 1) };
}

/** Map template icon names to Lucide components */
function getTemplateIcon(iconName: string | undefined) {
  switch (iconName) {
    case "file-text":
      return FileText;
    case "check-circle":
      return CheckCircle;
    case "shield":
      return Shield;
    case "zap":
      return Zap;
    case "eye":
      return Eye;
    default:
      return CheckCircle;
  }
}

/** Get category badge colors */
function getCategoryColors(category: string): { bg: string; text: string } {
  switch (category.toLowerCase()) {
    case "quality":
      return { bg: "rgba(59, 130, 246, 0.15)", text: "#3b82f6" };
    case "security":
      return { bg: "rgba(239, 68, 68, 0.15)", text: "#ef4444" };
    default:
      return { bg: "var(--bg-tertiary)", text: "var(--text-secondary)" };
  }
}

export function WorkflowStepManager({ isOpen, onClose, addToast, projectId }: WorkflowStepManagerProps) {
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [templates, setTemplates] = useState<WorkflowStepTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("my-steps");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<StepFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [refining, setRefining] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [addingTemplateId, setAddingTemplateId] = useState<string | null>(null);
  const [availableScripts, setAvailableScripts] = useState<Record<string, string>>({});
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);

  const loadSteps = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchWorkflowSteps(projectId);
      setSteps(data);
    } catch (err: any) {
      addToast(err.message || "Failed to load workflow steps", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, projectId]);

  const loadScripts = useCallback(async () => {
    try {
      const scripts = await fetchScripts(projectId);
      setAvailableScripts(scripts || {});
    } catch {
      // Silently ignore — scripts are optional
    }
  }, [projectId]);

  const loadModels = useCallback(async () => {
    try {
      const response = await fetchModels();
      setAvailableModels(response.models || []);
    } catch {
      // Silently ignore — models are optional, dropdown will be empty
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      setTemplatesLoading(true);
      const response = await fetchWorkflowStepTemplates();
      setTemplates(response.templates);
    } catch (err: any) {
      addToast(err.message || "Failed to load templates", "error");
    } finally {
      setTemplatesLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    if (isOpen) {
      loadSteps();
      loadTemplates();
      loadScripts();
      loadModels();
    }
  }, [isOpen, loadSteps, loadTemplates, loadScripts, loadModels]);

  const handleCreate = useCallback(() => {
    setIsCreating(true);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }, []);

  const handleEdit = useCallback((step: WorkflowStep) => {
    setEditingId(step.id);
    setIsCreating(false);
    setForm({
      name: step.name,
      description: step.description,
      mode: step.mode || "prompt",
      phase: step.phase || "pre-merge",
      prompt: step.prompt,
      scriptName: step.scriptName || "",
      enabled: step.enabled,
      defaultOn: step.defaultOn || false,
      modelProvider: step.modelProvider || "",
      modelId: step.modelId || "",
    });
  }, []);

  const handleCancel = useCallback(() => {
    setEditingId(null);
    setIsCreating(false);
    setForm(EMPTY_FORM);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim() || !form.description.trim()) {
      addToast("Name and description are required", "error");
      return;
    }

    setSaving(true);
    try {
      // Build model override: only include when both fields are set (prompt mode)
      const modelFields = form.mode === "prompt" && form.modelProvider && form.modelId
        ? { modelProvider: form.modelProvider, modelId: form.modelId }
        : form.mode === "prompt"
          ? { modelProvider: undefined, modelId: undefined }
          : {};

      if (isCreating) {
        const input: WorkflowStepInput = {
          name: form.name.trim(),
          description: form.description.trim(),
          mode: form.mode,
          phase: form.phase,
          prompt: form.mode === "prompt" ? (form.prompt.trim() || undefined) : undefined,
          scriptName: form.mode === "script" ? form.scriptName.trim() : undefined,
          enabled: form.enabled,
          defaultOn: form.defaultOn || undefined,
          ...modelFields,
        };
        await createWorkflowStep(input, projectId);
        addToast("Workflow step created", "success");
      } else if (editingId) {
        await updateWorkflowStep(editingId, {
          name: form.name.trim(),
          description: form.description.trim(),
          mode: form.mode,
          phase: form.phase,
          prompt: form.mode === "prompt" ? form.prompt : "",
          scriptName: form.mode === "script" ? form.scriptName.trim() : undefined,
          enabled: form.enabled,
          defaultOn: form.defaultOn,
          ...modelFields,
        }, projectId);
        addToast("Workflow step updated", "success");
      }

      setIsCreating(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      await loadSteps();
    } catch (err: any) {
      addToast(err.message || "Failed to save workflow step", "error");
    } finally {
      setSaving(false);
    }
  }, [form, isCreating, editingId, addToast, loadSteps]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteWorkflowStep(id, projectId);
      addToast("Workflow step deleted", "success");
      setDeleteConfirmId(null);
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await loadSteps();
    } catch (err: any) {
      addToast(err.message || "Failed to delete workflow step", "error");
    }
  }, [editingId, addToast, loadSteps]);

  const handleRefine = useCallback(async () => {
    if (!editingId && !isCreating) return;
    // Refine only works for prompt mode
    if (form.mode !== "prompt") return;

    // For new steps being created, we need to save first then refine
    if (isCreating) {
      if (!form.name.trim() || !form.description.trim()) {
        addToast("Name and description are required before refining", "error");
        return;
      }

      setSaving(true);
      try {
        // Build model override for the intermediate create-then-refine flow
        const modelFields = form.modelProvider && form.modelId
          ? { modelProvider: form.modelProvider, modelId: form.modelId }
          : {};
        const input: WorkflowStepInput = {
          name: form.name.trim(),
          description: form.description.trim(),
          mode: "prompt",
          prompt: form.prompt.trim() || undefined,
          enabled: form.enabled,
          defaultOn: form.defaultOn || undefined,
          ...modelFields,
        };
        const created = await createWorkflowStep(input, projectId);
        setIsCreating(false);
        setEditingId(created.id);

        // Now refine
        setRefining(true);
        const result = await refineWorkflowStepPrompt(created.id, projectId);
        setForm((prev) => ({ ...prev, prompt: result.prompt }));
        addToast("Prompt refined with AI", "success");
        await loadSteps();
      } catch (err: any) {
        addToast(err.message || "Failed to refine prompt", "error");
      } finally {
        setSaving(false);
        setRefining(false);
      }
      return;
    }

    if (!editingId) return;

    setRefining(true);
    try {
      const result = await refineWorkflowStepPrompt(editingId, projectId);
      setForm((prev) => ({ ...prev, prompt: result.prompt }));
      addToast("Prompt refined with AI", "success");
      await loadSteps();
    } catch (err: any) {
      addToast(err.message || "Failed to refine prompt", "error");
    } finally {
      setRefining(false);
    }
  }, [editingId, isCreating, form, addToast, loadSteps]);

  const handleAddTemplate = useCallback(async (template: WorkflowStepTemplate) => {
    setAddingTemplateId(template.id);
    try {
      await createWorkflowStepFromTemplate(template.id, projectId);
      addToast(`Added ${template.name} workflow step`, "success");
      await loadSteps();
      // Switch to "My Workflow Steps" tab to show the newly added step
      setActiveTab("my-steps");
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        addToast(`A workflow step named '${template.name}' already exists`, "error");
      } else {
        addToast(err.message || "Failed to add workflow step from template", "error");
      }
    } finally {
      setAddingTemplateId(null);
    }
  }, [addToast, loadSteps]);

  if (!isOpen) return null;

  const isEditing = isCreating || editingId !== null;

  return (
    <div className="modal-overlay open" onClick={onClose} data-testid="workflow-step-manager">
      <div
        className="modal workflow-step-manager-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Workflow Steps"
      >
        {/* Header */}
        <div className="modal-header">
          <h2>Workflow Steps</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="wfm-body">
          {loading ? (
            <div className="wfm-loading">Loading...</div>
          ) : (
            <>
              {/* Tab Navigation */}
              {!isEditing && (
                <div className="wfm-tab-row">
                  <button
                    className={`btn ${activeTab === "my-steps" ? "btn-primary" : "btn-secondary"} wfm-tab-btn`}
                    onClick={() => setActiveTab("my-steps")}
                    data-testid="tab-my-steps"
                  >
                    <BookOpen size={14} />
                    My Workflow Steps ({steps.length})
                  </button>
                  <button
                    className={`btn ${activeTab === "templates" ? "btn-primary" : "btn-secondary"} wfm-tab-btn`}
                    onClick={() => setActiveTab("templates")}
                    data-testid="tab-templates"
                  >
                    <LayoutGrid size={14} />
                    Templates ({templates.length})
                  </button>
                </div>
              )}

              {/* My Workflow Steps Tab */}
              {activeTab === "my-steps" && !isEditing && (
                <>
                  {steps.length === 0 && (
                    <div className="wfm-empty" data-testid="empty-state">
                      No workflow steps defined. Create one to get started, or add one from the Templates tab.
                    </div>
                  )}

                  {steps.length > 0 && (
                    <div className="wfm-step-list">
                      {steps.map((step) => (
                        <div
                          key={step.id}
                          className="wfm-step-card"
                          data-testid={`workflow-step-${step.id}`}
                        >
                          <div className="wfm-step-card-top">
                            <div className="wfm-step-card-info">
                              <div className="wfm-step-card-title-row">
                                <span className="wfm-step-card-name">{step.name}</span>
                                <span className={`wfm-badge ${step.enabled ? "wfm-badge-enabled" : "wfm-badge-disabled"}`}>
                                  {step.enabled ? "Enabled" : "Disabled"}
                                </span>
                                <span className={`wfm-badge ${(step.mode || "prompt") === "script" ? "wfm-badge-script" : "wfm-badge-prompt"}`}>
                                  {(step.mode || "prompt") === "script" ? "Script" : "AI Prompt"}
                                </span>
                                <span className={`wfm-badge ${(step.phase || "pre-merge") === "post-merge" ? "wfm-badge-post-merge" : "wfm-badge-pre-merge"}`}>
                                  {(step.phase || "pre-merge") === "post-merge" ? "Post-merge" : "Pre-merge"}
                                </span>
                                {step.defaultOn && (
                                  <span className="wfm-badge wfm-badge-default-on">
                                    Default on
                                  </span>
                                )}
                              </div>
                              <div className="wfm-step-card-desc">
                                {step.description}
                              </div>
                            </div>
                            <div className="wfm-step-card-actions">
                              <button
                                className="btn-icon"
                                onClick={() => handleEdit(step)}
                                title="Edit"
                                aria-label={`Edit ${step.name}`}
                              >
                                <Pencil size={14} />
                              </button>
                              {deleteConfirmId === step.id ? (
                                <div className="wfm-delete-confirm">
                                  <button
                                    className="btn-icon"
                                    onClick={() => handleDelete(step.id)}
                                    title="Confirm delete"
                                    aria-label={`Confirm delete ${step.name}`}
                                    style={{ color: "var(--status-error, #ef4444)" }}
                                  >
                                    <Check size={14} />
                                  </button>
                                  <button
                                    className="btn-icon"
                                    onClick={() => setDeleteConfirmId(null)}
                                    title="Cancel delete"
                                    aria-label="Cancel delete"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  className="btn-icon"
                                  onClick={() => setDeleteConfirmId(step.id)}
                                  title="Delete"
                                  aria-label={`Delete ${step.name}`}
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Templates Tab */}
              {activeTab === "templates" && !isEditing && (
                <>
                  {templatesLoading ? (
                    <div className="wfm-loading">
                      <Loader2 size={24} className="spin wfm-spinner" />
                      Loading templates...
                    </div>
                  ) : templates.length === 0 ? (
                    <div className="wfm-empty" data-testid="no-templates-state">
                      No templates available.
                    </div>
                  ) : (
                    <div className="wfm-template-list">
                      {templates.map((template) => {
                        const IconComponent = getTemplateIcon(template.icon);
                        const categoryColors = getCategoryColors(template.category);
                        const isAdding = addingTemplateId === template.id;

                        return (
                          <div
                            key={template.id}
                            className="wfm-template-card"
                            data-testid={`template-${template.id}`}
                          >
                            <div className="wfm-template-inner">
                              {/* Icon */}
                              <div className="wfm-template-icon">
                                <IconComponent size={20} />
                              </div>

                              {/* Content */}
                              <div className="wfm-template-content">
                                <div className="wfm-template-title-row">
                                  <span className="wfm-template-name">
                                    {template.name}
                                  </span>
                                  <span
                                    className="wfm-badge-category"
                                    style={{ background: categoryColors.bg, color: categoryColors.text }}
                                  >
                                    {template.category}
                                  </span>
                                </div>
                                <div className="wfm-template-desc">
                                  {template.description}
                                </div>
                                <button
                                  className="btn btn-primary wfm-template-add-btn"
                                  onClick={() => handleAddTemplate(template)}
                                  disabled={isAdding}
                                  data-testid={`add-template-${template.id}`}
                                >
                                  {isAdding ? (
                                    <>
                                      <Loader2 size={12} className="spin" />
                                      Adding...
                                    </>
                                  ) : (
                                    <>
                                      <Plus size={12} />
                                      Add
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Edit / Create form */}
              {isEditing && (
                <div className="wfm-form" data-testid="workflow-step-form">
                  <h3 className="wfm-form-title">
                    {isCreating ? "New Workflow Step" : "Edit Workflow Step"}
                  </h3>

                  <div className="wfm-form-fields">
                    {/* Name */}
                    <div className="wfm-field">
                      <label>Name</label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder="e.g. Documentation Review"
                        data-testid="workflow-step-name"
                      />
                    </div>

                    {/* Description */}
                    <div className="wfm-field">
                      <label>Description</label>
                      <textarea
                        value={form.description}
                        onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder="Brief description of what this step does"
                        rows={2}
                        data-testid="workflow-step-description"
                      />
                    </div>

                    {/* Mode Selector */}
                    <div className="wfm-field">
                      <label>Execution Mode</label>
                      <div className="wfm-mode-selector" data-testid="workflow-step-mode-selector">
                        <button
                          className={`btn ${form.mode === "prompt" ? "btn-primary" : "btn-secondary"} wfm-mode-btn`}
                          onClick={() => setForm((prev) => ({ ...prev, mode: "prompt", scriptName: "" }))}
                          data-testid="mode-prompt"
                        >
                          <MessageSquare size={14} />
                          AI Prompt
                        </button>
                        <button
                          className={`btn ${form.mode === "script" ? "btn-primary" : "btn-secondary"} wfm-mode-btn`}
                          onClick={() => setForm((prev) => ({ ...prev, mode: "script", prompt: "", modelProvider: "", modelId: "" }))}
                          data-testid="mode-script"
                        >
                          <Terminal size={14} />
                          Run Script
                        </button>
                      </div>
                    </div>

                    {/* Phase Selector */}
                    <div className="wfm-field">
                      <label>Execution Phase</label>
                      <div className="wfm-mode-selector" data-testid="workflow-step-phase-selector">
                        <button
                          className={`btn ${form.phase === "pre-merge" ? "btn-primary" : "btn-secondary"} wfm-mode-btn`}
                          onClick={() => setForm((prev) => ({ ...prev, phase: "pre-merge" }))}
                          data-testid="phase-pre-merge"
                        >
                          Pre-merge
                        </button>
                        <button
                          className={`btn ${form.phase === "post-merge" ? "btn-primary" : "btn-secondary"} wfm-mode-btn`}
                          onClick={() => setForm((prev) => ({ ...prev, phase: "post-merge" }))}
                          data-testid="phase-post-merge"
                        >
                          Post-merge
                        </button>
                      </div>
                      <div className="wfm-field-hint">
                        {form.phase === "pre-merge"
                          ? "Runs before merge — can block merge on failure"
                          : "Runs after merge success — failures are logged but do not block"}
                      </div>
                    </div>

                    {/* Prompt (AI mode only) */}
                    {form.mode === "prompt" && (
                      <div className="wfm-field">
                        <div className="wfm-prompt-header">
                          <label>Agent Prompt</label>
                          <button
                            className="btn-icon wfm-refine-btn"
                            onClick={handleRefine}
                            disabled={!form.description.trim() || refining}
                            title="Refine with AI"
                            aria-label="Refine prompt with AI"
                            data-testid="refine-btn"
                          >
                            {refining ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <Sparkles size={12} />
                            )}
                            <span>Refine with AI</span>
                          </button>
                        </div>
                        <textarea
                          value={form.prompt}
                          onChange={(e) => setForm((prev) => ({ ...prev, prompt: e.target.value }))}
                          placeholder="Leave empty to use AI refinement"
                          rows={6}
                          className="wfm-prompt-textarea"
                          data-testid="workflow-step-prompt"
                        />
                      </div>
                    )}

                    {/* Model override (prompt mode only) */}
                    {form.mode === "prompt" && (
                      <div className="wfm-field" data-testid="workflow-step-model-field">
                        <div className="wfm-model-header">
                          <label>Model Override</label>
                          {form.modelProvider && form.modelId && (
                            <button
                              type="button"
                              className="btn-icon wfm-model-clear-btn"
                              onClick={() => setForm((prev) => ({ ...prev, modelProvider: "", modelId: "" }))}
                              title="Clear model override (use global default)"
                              data-testid="clear-model-override"
                            >
                              <X size={12} />
                              <span>Use default</span>
                            </button>
                          )}
                        </div>
                        <span className="wfm-model-hint">
                          {form.modelProvider && form.modelId
                            ? `Using ${form.modelProvider}/${form.modelId}`
                            : "Using global default model"}
                        </span>
                        <div data-testid="workflow-step-model-select">
                          <CustomModelDropdown
                            models={availableModels}
                            value={getModelDropdownValue(form.modelProvider, form.modelId)}
                            onChange={(value: string) => {
                              const parsed = parseModelDropdownValue(value);
                              setForm((prev) => ({ ...prev, modelProvider: parsed.provider, modelId: parsed.modelId }));
                            }}
                            placeholder="Select a model override…"
                            label="Model override for this workflow step"
                          />
                        </div>
                      </div>
                    )}

                    {/* Script selector (script mode only) */}
                    {form.mode === "script" && (
                      <div className="wfm-field">
                        <label>Script</label>
                        {Object.keys(availableScripts).length === 0 ? (
                          <div className="wfm-no-scripts" data-testid="no-scripts-message">
                            No scripts configured. Add scripts in Settings → Scripts first.
                          </div>
                        ) : (
                          <select
                            value={form.scriptName}
                            onChange={(e) => setForm((prev) => ({ ...prev, scriptName: e.target.value }))}
                            data-testid="workflow-step-script-select"
                          >
                            <option value="">Select a script…</option>
                            {Object.entries(availableScripts).map(([name, command]) => (
                              <option key={name} value={name}>
                                {name} ({command})
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}

                    {/* Enabled toggle */}
                    <label className="wfm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                        data-testid="workflow-step-enabled"
                      />
                      Enabled (available for selection on new tasks)
                    </label>

                    {/* Default on toggle */}
                    <label className="wfm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={form.defaultOn}
                        onChange={(e) => setForm((prev) => ({ ...prev, defaultOn: e.target.checked }))}
                        data-testid="workflow-step-default-on"
                      />
                      Default on for new tasks
                    </label>

                    {/* Form actions */}
                    <div className="wfm-form-actions">
                      <button className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={
                          saving ||
                          !form.name.trim() ||
                          !form.description.trim() ||
                          (form.mode === "script" && !form.scriptName.trim())
                        }
                        data-testid="save-workflow-step"
                      >
                        {saving ? "Saving..." : isCreating ? "Create" : "Save"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!isEditing && (
          <div className="wfm-footer">
            <button
              className="btn btn-primary wfm-footer-add-btn"
              onClick={handleCreate}
              data-testid="add-workflow-step"
            >
              <Plus size={14} />
              Add Workflow Step
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
