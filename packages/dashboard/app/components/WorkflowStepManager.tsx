import { useState, useEffect, useCallback } from "react";
import type { WorkflowStep, WorkflowStepInput, WorkflowStepMode } from "@fusion/core";
import {
  fetchWorkflowSteps,
  createWorkflowStep,
  updateWorkflowStep,
  deleteWorkflowStep,
  refineWorkflowStepPrompt,
  fetchWorkflowStepTemplates,
  createWorkflowStepFromTemplate,
  fetchScripts,
  type WorkflowStepTemplate,
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
  prompt: string;
  scriptName: string;
  enabled: boolean;
}

type TabId = "my-steps" | "templates";

const EMPTY_FORM: StepFormData = {
  name: "",
  description: "",
  mode: "prompt",
  prompt: "",
  scriptName: "",
  enabled: true,
};

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
    }
  }, [isOpen, loadSteps, loadTemplates, loadScripts]);

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
      prompt: step.prompt,
      scriptName: step.scriptName || "",
      enabled: step.enabled,
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
      if (isCreating) {
        const input: WorkflowStepInput = {
          name: form.name.trim(),
          description: form.description.trim(),
          mode: form.mode,
          prompt: form.mode === "prompt" ? (form.prompt.trim() || undefined) : undefined,
          scriptName: form.mode === "script" ? form.scriptName.trim() : undefined,
          enabled: form.enabled,
        };
        await createWorkflowStep(input, projectId);
        addToast("Workflow step created", "success");
      } else if (editingId) {
        await updateWorkflowStep(editingId, {
          name: form.name.trim(),
          description: form.description.trim(),
          mode: form.mode,
          prompt: form.mode === "prompt" ? form.prompt : "",
          scriptName: form.mode === "script" ? form.scriptName.trim() : undefined,
          enabled: form.enabled,
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
        const input: WorkflowStepInput = {
          name: form.name.trim(),
          description: form.description.trim(),
          mode: "prompt",
          prompt: form.prompt.trim() || undefined,
          enabled: form.enabled,
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

        <div className="modal-body" style={{ padding: "16px", maxHeight: "70vh", overflowY: "auto" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "32px", color: "var(--text-secondary)" }}>
              Loading...
            </div>
          ) : (
            <>
              {/* Tab Navigation */}
              {!isEditing && (
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    marginBottom: "16px",
                    borderBottom: "1px solid var(--border-primary)",
                    paddingBottom: "8px",
                  }}
                >
                  <button
                    className={`btn ${activeTab === "my-steps" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setActiveTab("my-steps")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "13px",
                      padding: "6px 12px",
                    }}
                    data-testid="tab-my-steps"
                  >
                    <BookOpen size={14} />
                    My Workflow Steps ({steps.length})
                  </button>
                  <button
                    className={`btn ${activeTab === "templates" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setActiveTab("templates")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "13px",
                      padding: "6px 12px",
                    }}
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
                    <div
                      style={{
                        textAlign: "center",
                        padding: "32px",
                        color: "var(--text-secondary)",
                        fontSize: "14px",
                      }}
                      data-testid="empty-state"
                    >
                      No workflow steps defined. Create one to get started, or add one from the Templates tab.
                    </div>
                  )}

                  {steps.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {steps.map((step) => (
                        <div
                          key={step.id}
                          className="workflow-step-card"
                          data-testid={`workflow-step-${step.id}`}
                          style={{
                            padding: "12px 16px",
                            border: "1px solid var(--border-primary)",
                            borderRadius: "8px",
                            background: "var(--bg-secondary)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "flex-start",
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                  marginBottom: "4px",
                                }}
                              >
                                <span style={{ fontWeight: 600, fontSize: "14px" }}>{step.name}</span>
                                <span
                                  style={{
                                    fontSize: "11px",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                    background: step.enabled
                                      ? "var(--status-success-bg, rgba(34, 197, 94, 0.15))"
                                      : "var(--bg-tertiary)",
                                    color: step.enabled
                                      ? "var(--status-success, #22c55e)"
                                      : "var(--text-secondary)",
                                  }}
                                >
                                  {step.enabled ? "Enabled" : "Disabled"}
                                </span>
                                <span
                                  style={{
                                    fontSize: "11px",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                    background: (step.mode || "prompt") === "script"
                                      ? "rgba(168, 85, 247, 0.15)"
                                      : "rgba(59, 130, 246, 0.15)",
                                    color: (step.mode || "prompt") === "script"
                                      ? "#a855f7"
                                      : "#3b82f6",
                                  }}
                                >
                                  {(step.mode || "prompt") === "script" ? "Script" : "AI Prompt"}
                                </span>
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "var(--text-secondary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {step.description}
                              </div>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: "4px",
                                marginLeft: "8px",
                                flexShrink: 0,
                              }}
                            >
                              <button
                                className="btn-icon"
                                onClick={() => handleEdit(step)}
                                title="Edit"
                                aria-label={`Edit ${step.name}`}
                              >
                                <Pencil size={14} />
                              </button>
                              {deleteConfirmId === step.id ? (
                                <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
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
                    <div style={{ textAlign: "center", padding: "32px", color: "var(--text-secondary)" }}>
                      <Loader2 size={24} className="spin" style={{ margin: "0 auto 8px" }} />
                      Loading templates...
                    </div>
                  ) : templates.length === 0 ? (
                    <div
                      style={{
                        textAlign: "center",
                        padding: "32px",
                        color: "var(--text-secondary)",
                        fontSize: "14px",
                      }}
                      data-testid="no-templates-state"
                    >
                      No templates available.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {templates.map((template) => {
                        const IconComponent = getTemplateIcon(template.icon);
                        const categoryColors = getCategoryColors(template.category);
                        const isAdding = addingTemplateId === template.id;

                        return (
                          <div
                            key={template.id}
                            data-testid={`template-${template.id}`}
                            style={{
                              padding: "16px",
                              border: "1px solid var(--border-primary)",
                              borderRadius: "8px",
                              background: "var(--bg-secondary)",
                            }}
                          >
                            <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                              {/* Icon */}
                              <div
                                style={{
                                  padding: "8px",
                                  borderRadius: "6px",
                                  background: "var(--bg-tertiary)",
                                  color: "var(--text-primary)",
                                  flexShrink: 0,
                                }}
                              >
                                <IconComponent size={20} />
                              </div>

                              {/* Content */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    marginBottom: "4px",
                                  }}
                                >
                                  <span style={{ fontWeight: 600, fontSize: "14px" }}>
                                    {template.name}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      padding: "2px 6px",
                                      borderRadius: "4px",
                                      background: categoryColors.bg,
                                      color: categoryColors.text,
                                    }}
                                  >
                                    {template.category}
                                  </span>
                                </div>
                                <div
                                  style={{
                                    fontSize: "12px",
                                    color: "var(--text-secondary)",
                                    marginBottom: "8px",
                                  }}
                                >
                                  {template.description}
                                </div>
                                <button
                                  className="btn btn-primary"
                                  onClick={() => handleAddTemplate(template)}
                                  disabled={isAdding}
                                  style={{
                                    fontSize: "12px",
                                    padding: "4px 12px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "4px",
                                  }}
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
                <div
                  style={{
                    padding: "16px",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "8px",
                    background: "var(--bg-secondary)",
                  }}
                  data-testid="workflow-step-form"
                >
                  <h3 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 600 }}>
                    {isCreating ? "New Workflow Step" : "Edit Workflow Step"}
                  </h3>

                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {/* Name */}
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          marginBottom: "4px",
                        }}
                      >
                        Name
                      </label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder="e.g. Documentation Review"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px solid var(--border-primary)",
                          background: "var(--bg-primary)",
                          color: "var(--text-primary)",
                          fontSize: "13px",
                        }}
                        data-testid="workflow-step-name"
                      />
                    </div>

                    {/* Description */}
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          marginBottom: "4px",
                        }}
                      >
                        Description
                      </label>
                      <textarea
                        value={form.description}
                        onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder="Brief description of what this step does"
                        rows={2}
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px solid var(--border-primary)",
                          background: "var(--bg-primary)",
                          color: "var(--text-primary)",
                          fontSize: "13px",
                          resize: "vertical",
                        }}
                        data-testid="workflow-step-description"
                      />
                    </div>

                    {/* Mode Selector */}
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                          marginBottom: "4px",
                        }}
                      >
                        Execution Mode
                      </label>
                      <div
                        style={{ display: "flex", gap: "8px" }}
                        data-testid="workflow-step-mode-selector"
                      >
                        <button
                          className={`btn ${form.mode === "prompt" ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setForm((prev) => ({ ...prev, mode: "prompt", scriptName: "" }))}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                            padding: "6px 12px",
                            flex: 1,
                            justifyContent: "center",
                          }}
                          data-testid="mode-prompt"
                        >
                          <MessageSquare size={14} />
                          AI Prompt
                        </button>
                        <button
                          className={`btn ${form.mode === "script" ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setForm((prev) => ({ ...prev, mode: "script", prompt: "" }))}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                            padding: "6px 12px",
                            flex: 1,
                            justifyContent: "center",
                          }}
                          data-testid="mode-script"
                        >
                          <Terminal size={14} />
                          Run Script
                        </button>
                      </div>
                    </div>

                    {/* Prompt (AI mode only) */}
                    {form.mode === "prompt" && (
                      <div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "4px",
                          }}
                        >
                          <label style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                            Agent Prompt
                          </label>
                          <button
                            className="btn-icon"
                            onClick={handleRefine}
                            disabled={!form.description.trim() || refining}
                            title="Refine with AI"
                            aria-label="Refine prompt with AI"
                            style={{
                              fontSize: "12px",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                            data-testid="refine-btn"
                          >
                            {refining ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <Sparkles size={12} />
                            )}
                            <span style={{ fontSize: "11px" }}>Refine with AI</span>
                          </button>
                        </div>
                        <textarea
                          value={form.prompt}
                          onChange={(e) => setForm((prev) => ({ ...prev, prompt: e.target.value }))}
                          placeholder="Leave empty to use AI refinement"
                          rows={6}
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            borderRadius: "6px",
                            border: "1px solid var(--border-primary)",
                            background: "var(--bg-primary)",
                            color: "var(--text-primary)",
                            fontSize: "13px",
                            fontFamily: "monospace",
                            resize: "vertical",
                          }}
                          data-testid="workflow-step-prompt"
                        />
                      </div>
                    )}

                    {/* Script selector (script mode only) */}
                    {form.mode === "script" && (
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontSize: "12px",
                            color: "var(--text-secondary)",
                            marginBottom: "4px",
                          }}
                        >
                          Script
                        </label>
                        {Object.keys(availableScripts).length === 0 ? (
                          <div
                            style={{
                              padding: "8px 12px",
                              borderRadius: "6px",
                              border: "1px solid var(--border-primary)",
                              background: "var(--bg-tertiary)",
                              color: "var(--text-secondary)",
                              fontSize: "12px",
                            }}
                            data-testid="no-scripts-message"
                          >
                            No scripts configured. Add scripts in Settings → Scripts first.
                          </div>
                        ) : (
                          <select
                            value={form.scriptName}
                            onChange={(e) => setForm((prev) => ({ ...prev, scriptName: e.target.value }))}
                            style={{
                              width: "100%",
                              padding: "8px 12px",
                              borderRadius: "6px",
                              border: "1px solid var(--border-primary)",
                              background: "var(--bg-primary)",
                              color: "var(--text-primary)",
                              fontSize: "13px",
                            }}
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
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                        data-testid="workflow-step-enabled"
                      />
                      Enabled (available for selection on new tasks)
                    </label>

                    {/* Form actions */}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: "8px",
                        marginTop: "4px",
                      }}
                    >
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
          <div
            className="modal-footer"
            style={{ padding: "12px 16px", borderTop: "1px solid var(--border-primary)" }}
          >
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
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
