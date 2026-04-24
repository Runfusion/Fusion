import { useState, useCallback, useEffect, useRef } from "react";
import { BUILTIN_AGENT_PROMPTS, PROMPT_KEY_CATALOG } from "../utils/builtinPrompts";
import type { AgentPromptTemplate, AgentPromptsConfig, AgentCapability } from "@fusion/core";
import type { PromptKey } from "@fusion/core";
import { Plus, Pencil, Trash2, BookOpen, Users, Settings2, ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";

/**
 * Props for the AgentPromptsManager component.
 *
 * Provides a unified interface for managing:
 * - Template customization (built-in templates as read-only, custom templates as editable)
 * - Role assignments (mapping roles to template IDs)
 * - Prompt overrides (segment-level customization)
 */
interface AgentPromptsManagerProps {
  /** Current agent prompts configuration from settings */
  value: AgentPromptsConfig | undefined;
  /** Callback when agent prompts configuration changes */
  onChange: (value: AgentPromptsConfig) => void;
  /** Current prompt overrides from settings */
  promptOverrides: Record<PromptKey, string | null> | undefined;
  /** Callback when prompt overrides change */
  onPromptOverridesChange: (value: Record<PromptKey, string | null>) => void;
}

/** Tab identifiers */
type TabId = "templates" | "assignments" | "overrides";

/** Core agent roles that have built-in templates */
const CORE_ROLES: AgentCapability[] = ["executor", "triage", "reviewer", "merger"];

/** Role display labels */
const ROLE_LABELS: Record<AgentCapability, string> = {
  executor: "Executor Agent",
  triage: "Triage Agent",
  reviewer: "Reviewer Agent",
  merger: "Merger Agent",
  scheduler: "Scheduler Agent",
  engineer: "Engineer Agent",
  custom: "Custom Agent",
};

/** Role badge colors */
const ROLE_COLORS: Record<AgentCapability, string> = {
  executor: "#3b82f6",
  triage: "#f59e0b",
  reviewer: "#8b5cf6",
  merger: "#10b981",
  scheduler: "#06b6d4",
  engineer: "#ec4899",
  custom: "#6b7280",
};

/** Form data for editing/creating a custom template */
interface TemplateFormData {
  name: string;
  description: string;
  role: AgentCapability;
  prompt: string;
}

const EMPTY_TEMPLATE_FORM: TemplateFormData = {
  name: "",
  description: "",
  role: "executor",
  prompt: "",
};

type FullscreenTemplateView = {
  source: "builtin" | "custom";
  id: string;
};

/**
 * Generate a kebab-case ID from a template name.
 * If collision exists with built-in or existing custom IDs, append -2, -3, etc.
 */
function generateTemplateId(
  name: string,
  existingCustomTemplates: AgentPromptTemplate[],
): string {
  // Generate base kebab-case ID
  const baseId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  // Get all IDs that would cause a collision
  const builtinIds = new Set(BUILTIN_AGENT_PROMPTS.map((t) => t.id));
  const customIds = new Set(existingCustomTemplates.map((t) => t.id));

  // If no collision, return base ID
  if (!builtinIds.has(baseId) && !customIds.has(baseId)) {
    return baseId;
  }

  // Find the next available number
  let counter = 2;
  while (builtinIds.has(`${baseId}-${counter}`) || customIds.has(`${baseId}-${counter}`)) {
    counter++;
  }

  return `${baseId}-${counter}`;
}

/**
 * AgentPromptsManager - A unified component for managing agent prompt templates,
 * role assignments, and prompt segment overrides.
 *
 * Provides three tabs:
 * 1. **Templates**: View built-in templates, create/edit/delete custom templates
 * 2. **Assignments**: Map agent roles to specific templates
 * 3. **Overrides**: Customize specific segments of agent prompts
 */
export function AgentPromptsManager({
  value,
  onChange,
  promptOverrides,
  onPromptOverridesChange,
}: AgentPromptsManagerProps) {
  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>("templates");

  // Template editing state
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [templateForm, setTemplateForm] = useState<TemplateFormData>(EMPTY_TEMPLATE_FORM);
  const [templateIdError, setTemplateIdError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Override expanded state for accordion behavior
  const [expandedOverrides, setExpandedOverrides] = useState<Set<PromptKey>>(new Set());

  // Fullscreen state for overrides tab
  const [fullscreenOverrideKey, setFullscreenOverrideKey] = useState<PromptKey | null>(null);

  // Fullscreen state for templates tab
  const [isTemplatePromptFullscreen, setIsTemplatePromptFullscreen] = useState(false);
  const [fullscreenViewTemplate, setFullscreenViewTemplate] = useState<FullscreenTemplateView | null>(null);
  const fullscreenViewContainerRef = useRef<HTMLDivElement | null>(null);

  // Get custom templates from current config
  const customTemplates = value?.templates ?? [];

  // Get role assignments from current config
  const roleAssignments = value?.roleAssignments ?? {};

  const fullscreenTemplate =
    fullscreenViewTemplate === null
      ? null
      : fullscreenViewTemplate.source === "builtin"
        ? BUILTIN_AGENT_PROMPTS.find((template) => template.id === fullscreenViewTemplate.id)
        : customTemplates.find((template) => template.id === fullscreenViewTemplate.id);

  // Get templates for a specific role (both built-in and custom)
  const getTemplatesForRole = useCallback(
    (role: AgentCapability): AgentPromptTemplate[] => {
      const builtIn = BUILTIN_AGENT_PROMPTS.filter((t) => t.role === role);
      const custom = customTemplates.filter((t) => t.role === role);
      return [...builtIn, ...custom];
    },
    [customTemplates],
  );

  useEffect(() => {
    if (fullscreenViewTemplate !== null) {
      fullscreenViewContainerRef.current?.focus();
    }
  }, [fullscreenViewTemplate]);

  // Handle starting template creation
  const handleStartCreate = useCallback(() => {
    setIsCreating(true);
    setEditingTemplateId(null);
    setTemplateForm(EMPTY_TEMPLATE_FORM);
    setTemplateIdError(null);
    setFullscreenViewTemplate(null);
  }, []);

  // Handle starting template edit
  const handleStartEdit = useCallback((template: AgentPromptTemplate) => {
    setEditingTemplateId(template.id);
    setIsCreating(false);
    setTemplateForm({
      name: template.name,
      description: template.description,
      role: template.role,
      prompt: template.prompt,
    });
    setTemplateIdError(null);
    setFullscreenViewTemplate(null);
  }, []);

  // Handle canceling template edit
  const handleCancelEdit = useCallback(() => {
    setEditingTemplateId(null);
    setIsCreating(false);
    setTemplateForm(EMPTY_TEMPLATE_FORM);
    setTemplateIdError(null);
    setFullscreenViewTemplate(null);
    setIsTemplatePromptFullscreen(false);
  }, []);

  // Handle saving a template (create or update)
  const handleSaveTemplate = useCallback(() => {
    const trimmedName = templateForm.name.trim();
    if (!trimmedName) {
      setTemplateIdError("Template name is required");
      return;
    }

    // Generate ID for new templates
    let templateId: string;
    if (isCreating) {
      templateId = generateTemplateId(trimmedName, customTemplates);

      // Check for collision with built-in IDs (shouldn't happen with generateTemplateId, but be defensive)
      const builtinIds = new Set(BUILTIN_AGENT_PROMPTS.map((t) => t.id));
      if (builtinIds.has(templateId)) {
        setTemplateIdError(`Template ID "${templateId}" conflicts with a built-in template. Please use a different name.`);
        return;
      }
    } else {
      templateId = editingTemplateId!;
    }

    const newTemplate: AgentPromptTemplate = {
      id: templateId,
      name: trimmedName,
      description: templateForm.description.trim(),
      role: templateForm.role,
      prompt: templateForm.prompt,
      builtIn: false,
    };

    let newTemplates: AgentPromptTemplate[];
    if (isCreating) {
      newTemplates = [...customTemplates, newTemplate];
    } else {
      newTemplates = customTemplates.map((t) =>
        t.id === templateId ? newTemplate : t,
      );
    }

    // If changing role, clear any assignment to this template
    const newAssignments = { ...roleAssignments };
    for (const [role, assignedId] of Object.entries(newAssignments)) {
      if (assignedId === templateId && templateForm.role !== role) {
        delete newAssignments[role as AgentCapability];
      }
    }

    onChange({
      ...value,
      templates: newTemplates,
      roleAssignments: Object.keys(newAssignments).length > 0 ? newAssignments : undefined,
    });

    handleCancelEdit();
  }, [
    templateForm,
    isCreating,
    editingTemplateId,
    customTemplates,
    roleAssignments,
    value,
    onChange,
    handleCancelEdit,
  ]);

  // Handle deleting a template
  const handleDeleteTemplate = useCallback(
    (templateId: string) => {
      // Remove the template
      const newTemplates = customTemplates.filter((t) => t.id !== templateId);

      // Clear any role assignments pointing to this template
      const newAssignments = { ...roleAssignments };
      let assignmentCleared = false;
      for (const [role, assignedId] of Object.entries(newAssignments)) {
        if (assignedId === templateId) {
          delete newAssignments[role as AgentCapability];
          assignmentCleared = true;
        }
      }

      onChange({
        ...value,
        templates: newTemplates.length > 0 ? newTemplates : undefined,
        roleAssignments:
          Object.keys(newAssignments).length > 0 || assignmentCleared
            ? Object.keys(newAssignments).length > 0
              ? newAssignments
              : undefined
            : roleAssignments,
      });

      setDeleteConfirmId(null);
      if (editingTemplateId === templateId) {
        handleCancelEdit();
      }
    },
    [customTemplates, roleAssignments, value, onChange, editingTemplateId, handleCancelEdit],
  );

  // Handle changing a role assignment
  const handleRoleAssignmentChange = useCallback(
    (role: AgentCapability, templateId: string) => {
      const newAssignments = { ...roleAssignments };
      if (templateId === "") {
        delete newAssignments[role];
      } else {
        newAssignments[role] = templateId;
      }

      onChange({
        ...value,
        roleAssignments: Object.keys(newAssignments).length > 0 ? newAssignments : undefined,
      });
    },
    [roleAssignments, value, onChange],
  );

  // Handle prompt override change
  const handlePromptOverrideChange = useCallback(
    (key: PromptKey, value: string) => {
      const newOverrides = { ...promptOverrides } as Record<PromptKey, string | null>;
      newOverrides[key] = value || null;
      onPromptOverridesChange(newOverrides);
    },
    [promptOverrides, onPromptOverridesChange],
  );

  // Handle reset (set to null) for a prompt override
  const handleResetOverride = useCallback(
    (key: PromptKey) => {
      const newOverrides = { ...promptOverrides } as Record<PromptKey, string | null>;
      newOverrides[key] = null;
      onPromptOverridesChange(newOverrides);
    },
    [promptOverrides, onPromptOverridesChange],
  );

  // Toggle override accordion
  const toggleOverrideExpanded = useCallback((key: PromptKey) => {
    setExpandedOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Toggle fullscreen for an override
  const toggleFullscreenOverride = useCallback((key: PromptKey) => {
    setFullscreenOverrideKey((prev) => (prev === key ? null : key));
  }, []);

  const openTemplateViewFullscreen = useCallback(
    (source: FullscreenTemplateView["source"], id: string) => {
      setIsTemplatePromptFullscreen(false);
      setFullscreenViewTemplate({ source, id });
    },
    [],
  );

  // Toggle fullscreen for template prompt
  const toggleTemplatePromptFullscreen = useCallback(() => {
    setFullscreenViewTemplate(null);
    setIsTemplatePromptFullscreen((prev) => !prev);
  }, []);

  // Check if a template ID collides with built-in
  const isBuiltinId = (id: string): boolean => {
    return BUILTIN_AGENT_PROMPTS.some((t) => t.id === id);
  };

  return (
    <div className="prompt-manager">
      {/* Tab Navigation */}
      <div className="prompt-manager-tabs">
        <button
          className={`prompt-manager-tab ${activeTab === "templates" ? "active" : ""}`}
          onClick={() => setActiveTab("templates")}
          data-testid="tab-templates"
        >
          <BookOpen size={14} />
          Templates
        </button>
        <button
          className={`prompt-manager-tab ${activeTab === "assignments" ? "active" : ""}`}
          onClick={() => setActiveTab("assignments")}
          data-testid="tab-assignments"
        >
          <Users size={14} />
          Assignments
        </button>
        <button
          className={`prompt-manager-tab ${activeTab === "overrides" ? "active" : ""}`}
          onClick={() => setActiveTab("overrides")}
          data-testid="tab-overrides"
        >
          <Settings2 size={14} />
          Overrides
        </button>
      </div>

      {/* Tab Content */}
      <div className="prompt-manager-content">
        {/* Templates Tab */}
        {activeTab === "templates" && (
          <div className="prompt-manager-templates-tab" data-testid="templates-tab">
            {/* Template Editor (shown when creating or editing) */}
            {(isCreating || editingTemplateId !== null) && (
              <div className="prompt-template-editor" data-testid="template-editor">
                <h4 className="prompt-template-editor-title">
                  {isCreating ? "New Custom Template" : "Edit Custom Template"}
                </h4>

                <div className="prompt-template-editor-fields">
                  <div className="prompt-template-field">
                    <label htmlFor="template-name">Name</label>
                    <input
                      id="template-name"
                      type="text"
                      value={templateForm.name}
                      onChange={(e) =>
                        setTemplateForm((f) => ({ ...f, name: e.target.value }))
                      }
                      placeholder="e.g. My Custom Executor"
                      data-testid="template-name-input"
                    />
                  </div>

                  <div className="prompt-template-field">
                    <label htmlFor="template-description">Description</label>
                    <input
                      id="template-description"
                      type="text"
                      value={templateForm.description}
                      onChange={(e) =>
                        setTemplateForm((f) => ({ ...f, description: e.target.value }))
                      }
                      placeholder="Brief description of this template"
                      data-testid="template-description-input"
                    />
                  </div>

                  <div className="prompt-template-field">
                    <label htmlFor="template-role">Role</label>
                    <select
                      id="template-role"
                      value={templateForm.role}
                      onChange={(e) =>
                        setTemplateForm((f) => ({
                          ...f,
                          role: e.target.value as AgentCapability,
                        }))
                      }
                      data-testid="template-role-select"
                    >
                      {CORE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="prompt-template-field">
                    <div className="prompt-template-prompt-label-row">
                      <label htmlFor="template-prompt">Prompt</label>
                      <button
                        type="button"
                        className="btn-icon prompt-template-fullscreen-btn"
                        onClick={toggleTemplatePromptFullscreen}
                        aria-label="Expand prompt to fullscreen"
                        data-testid="template-prompt-fullscreen"
                      >
                        <Maximize2 size={14} />
                      </button>
                    </div>
                    {isTemplatePromptFullscreen ? (
                      <div
                        className="prompt-override-fullscreen"
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setIsTemplatePromptFullscreen(false);
                          }
                        }}
                      >
                        <div className="prompt-override-fullscreen-header">
                          <div className="prompt-override-fullscreen-title">Edit Prompt</div>
                          <button
                            type="button"
                            className="prompt-override-fullscreen-close"
                            onClick={() => setIsTemplatePromptFullscreen(false)}
                            data-testid="template-prompt-collapse"
                          >
                            <Minimize2 size={14} />
                            Collapse
                          </button>
                        </div>
                        <textarea
                          id="template-prompt-fullscreen"
                          aria-label="Template prompt - fullscreen"
                          className="prompt-template-prompt-textarea"
                          value={templateForm.prompt}
                          onChange={(e) =>
                            setTemplateForm((f) => ({ ...f, prompt: e.target.value }))
                          }
                          placeholder="Enter the system prompt for this template..."
                          rows={30}
                          autoFocus
                          data-testid="template-prompt-input-fullscreen"
                        />
                        <div className="prompt-override-footer">
                          <small className="prompt-override-hint">
                            {templateForm.prompt.length} characters
                          </small>
                        </div>
                      </div>
                    ) : (
                      <textarea
                        id="template-prompt"
                        value={templateForm.prompt}
                        onChange={(e) =>
                          setTemplateForm((f) => ({ ...f, prompt: e.target.value }))
                        }
                        placeholder="Enter the system prompt for this template..."
                        rows={8}
                        className="prompt-template-prompt-textarea"
                        data-testid="template-prompt-input"
                      />
                    )}
                  </div>

                  {templateIdError && (
                    <div className="prompt-template-error" data-testid="template-error">
                      {templateIdError}
                    </div>
                  )}

                  <div className="prompt-template-editor-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={handleCancelEdit}
                      data-testid="cancel-template-btn"
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleSaveTemplate}
                      data-testid="save-template-btn"
                    >
                      {isCreating ? "Create" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Built-in Templates Section */}
            <div className="prompt-template-section" data-testid="builtin-templates">
              <h4 className="prompt-template-section-title">Built-in Templates</h4>
              <p className="prompt-template-section-desc">
                These templates are provided by Fusion and cannot be modified.
              </p>
              <div className="prompt-template-list">
                {BUILTIN_AGENT_PROMPTS.map((template) => (
                  <div
                    key={template.id}
                    className="prompt-template-card"
                    data-testid={`builtin-template-${template.id}`}
                  >
                    <div className="prompt-template-card-header">
                      <div className="prompt-template-card-info">
                        <span className="prompt-template-card-name">
                          {template.name}
                        </span>
                        <span
                          className="prompt-template-badge-built-in"
                          style={{ borderColor: ROLE_COLORS[template.role] }}
                        >
                          Built-in
                        </span>
                        <span
                          className="prompt-template-badge-role"
                          style={{
                            backgroundColor: ROLE_COLORS[template.role] + "20",
                            color: ROLE_COLORS[template.role],
                          }}
                        >
                          {ROLE_LABELS[template.role]}
                        </span>
                      </div>
                      <div className="prompt-template-card-actions">
                        <button
                          type="button"
                          className="btn-icon prompt-template-fullscreen-btn"
                          onClick={() => openTemplateViewFullscreen("builtin", template.id)}
                          title="View full prompt"
                          aria-label={`View full prompt for ${template.name}`}
                          data-testid={`expand-view-${template.id}`}
                        >
                          <Maximize2 size={14} />
                        </button>
                      </div>
                    </div>
                    <p className="prompt-template-card-description">
                      {template.description}
                    </p>
                    <div className="prompt-template-card-preview">
                      <code>{template.prompt}</code>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Custom Templates Section */}
            <div className="prompt-template-section" data-testid="custom-templates">
              <h4 className="prompt-template-section-title">Custom Templates</h4>
              <p className="prompt-template-section-desc">
                Create custom templates to override built-in prompts for specific roles.
              </p>

              {customTemplates.length === 0 && !isCreating && (
                <div className="prompt-template-empty">
                  No custom templates yet. Create one to get started.
                </div>
              )}

              {customTemplates.length > 0 && (
                <div className="prompt-template-list">
                  {customTemplates.map((template) => (
                    <div
                      key={template.id}
                      className="prompt-template-card"
                      data-testid={`custom-template-${template.id}`}
                    >
                      {deleteConfirmId === template.id ? (
                        <div className="prompt-template-delete-confirm">
                          <p>Delete "{template.name}"?</p>
                          <div className="prompt-template-delete-actions">
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => handleDeleteTemplate(template.id)}
                              data-testid={`confirm-delete-${template.id}`}
                            >
                              Delete
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={() => setDeleteConfirmId(null)}
                              data-testid={`cancel-delete-${template.id}`}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="prompt-template-card-header">
                            <div className="prompt-template-card-info">
                              <span className="prompt-template-card-name">
                                {template.name}
                              </span>
                              <span className="prompt-template-badge-custom">
                                Custom
                              </span>
                              <span
                                className="prompt-template-badge-role"
                                style={{
                                  backgroundColor: ROLE_COLORS[template.role] + "20",
                                  color: ROLE_COLORS[template.role],
                                }}
                              >
                                {ROLE_LABELS[template.role]}
                              </span>
                              {/* Show override indicator if this custom template overrides a built-in */}
                              {isBuiltinId(template.id) && (
                                <span className="prompt-template-badge-override">
                                  Overrides built-in
                                </span>
                              )}
                            </div>
                            <div className="prompt-template-card-actions">
                              <button
                                type="button"
                                className="btn-icon prompt-template-fullscreen-btn"
                                onClick={() => openTemplateViewFullscreen("custom", template.id)}
                                title="View full prompt"
                                aria-label={`View full prompt for ${template.name}`}
                                data-testid={`expand-view-${template.id}`}
                              >
                                <Maximize2 size={14} />
                              </button>
                              <button
                                className="btn-icon"
                                onClick={() => handleStartEdit(template)}
                                title="Edit"
                                aria-label={`Edit ${template.name}`}
                                data-testid={`edit-${template.id}`}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                className="btn-icon"
                                onClick={() => setDeleteConfirmId(template.id)}
                                title="Delete"
                                aria-label={`Delete ${template.name}`}
                                data-testid={`delete-${template.id}`}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                          <p className="prompt-template-card-description">
                            {template.description}
                          </p>
                          <div className="prompt-template-card-preview">
                            <code>{template.prompt}</code>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Add Custom Template Button */}
              {!isCreating && editingTemplateId === null && (
                <button
                  className="btn btn-primary prompt-template-add-btn"
                  onClick={handleStartCreate}
                  data-testid="add-template-btn"
                >
                  <Plus size={14} />
                  Add Custom Template
                </button>
              )}
            </div>

            {fullscreenTemplate && (
              <div
                ref={fullscreenViewContainerRef}
                className="prompt-override-fullscreen"
                role="dialog"
                aria-modal="true"
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setFullscreenViewTemplate(null);
                  }
                }}
              >
                <div className="prompt-override-fullscreen-header">
                  <div className="prompt-override-fullscreen-title">
                    {fullscreenTemplate.name}
                    <span
                      className="prompt-template-badge-role"
                      style={{
                        backgroundColor: ROLE_COLORS[fullscreenTemplate.role] + "20",
                        color: ROLE_COLORS[fullscreenTemplate.role],
                      }}
                    >
                      {ROLE_LABELS[fullscreenTemplate.role]}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="prompt-override-fullscreen-close"
                    onClick={() => setFullscreenViewTemplate(null)}
                    data-testid={`collapse-view-${fullscreenTemplate.id}`}
                  >
                    <Minimize2 size={14} />
                    Collapse
                  </button>
                </div>
                <pre className="prompt-template-fullscreen-pre">{fullscreenTemplate.prompt}</pre>
              </div>
            )}
          </div>
        )}

        {/* Assignments Tab */}
        {activeTab === "assignments" && (
          <div className="prompt-manager-assignments-tab" data-testid="assignments-tab">
            <p className="prompt-assignments-desc">
              Assign specific templates to agent roles. When a role has an assignment, that
              template will be used instead of the default built-in.
            </p>

            <div className="prompt-role-assignment-list">
              {CORE_ROLES.map((role) => {
                const availableTemplates = getTemplatesForRole(role);
                const currentAssignment = roleAssignments[role] ?? "";
                const selectedTemplate = availableTemplates.find(
                  (t) => t.id === currentAssignment,
                );
                const isOverriding = !!currentAssignment;

                return (
                  <div
                    key={role}
                    className="prompt-role-assignment-row"
                    data-testid={`assignment-${role}`}
                  >
                    <div className="prompt-role-assignment-label">
                      <span
                        className="prompt-role-badge"
                        style={{
                          backgroundColor: ROLE_COLORS[role] + "20",
                          color: ROLE_COLORS[role],
                        }}
                      >
                        {ROLE_LABELS[role]}
                      </span>
                      {isOverriding && (
                        <span className="prompt-role-assignment-status">
                          {selectedTemplate?.name ?? "Custom"} (overrides default)
                        </span>
                      )}
                    </div>
                    <select
                      className="prompt-role-select"
                      value={currentAssignment}
                      onChange={(e) =>
                        handleRoleAssignmentChange(role, e.target.value)
                      }
                      data-testid={`select-${role}`}
                    >
                      <option value="">Use default</option>
                      {availableTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                          {isBuiltinId(template.id) ? " (built-in)" : " (custom)"}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            {Object.keys(roleAssignments).length > 0 && (
              <div className="prompt-assignments-note">
                <strong>Note:</strong> Role assignments are stored in the agentPrompts
                configuration. Custom templates override built-ins by ID.
              </div>
            )}
          </div>
        )}

        {/* Overrides Tab */}
        {activeTab === "overrides" && (
          <div className="prompt-manager-overrides-tab" data-testid="overrides-tab">
            <p className="prompt-overrides-desc">
              Customize specific segments of AI agent prompts. Edits override built-in
              defaults. Use the Reset button to restore the original default for any
              prompt.
            </p>

            <div className="prompt-overrides-list">
              {Object.values(PROMPT_KEY_CATALOG).map((promptMeta) => {
                const key = promptMeta.key;
                const currentOverride = promptOverrides?.[key] ?? "";
                const hasOverride = currentOverride !== "";
                const isExpanded = expandedOverrides.has(key);

                return (
                  <div
                    key={key}
                    className="prompt-override-item"
                    data-testid={`override-${key}`}
                  >
                    <div className="prompt-override-header">
                      <div
                        className="prompt-override-info"
                        onClick={() => toggleOverrideExpanded(key)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            toggleOverrideExpanded(key);
                          }
                        }}
                      >
                        <span className="prompt-override-name">
                          {promptMeta.name}
                        </span>
                        <code className="prompt-override-key">{key}</code>
                        {hasOverride && (
                          <span className="prompt-override-badge">customized</span>
                        )}
                      </div>
                      <div className="prompt-override-header-actions">
                        {isExpanded && (
                          <button
                            className="prompt-override-fullscreen-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFullscreenOverride(key);
                            }}
                            aria-label="Expand to fullscreen"
                            data-testid={`fullscreen-${key}`}
                          >
                            <Maximize2 size={14} />
                          </button>
                        )}
                        <button
                          className="prompt-override-expand-btn"
                          aria-label={isExpanded ? "Collapse" : "Expand"}
                          data-testid={`expand-${key}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleOverrideExpanded(key);
                          }}
                        >
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </div>
                    </div>
                    <p className="prompt-override-description">
                      {promptMeta.description}
                    </p>

                    {isExpanded && (
                      fullscreenOverrideKey === key ? (
                        <div
                          className="prompt-override-fullscreen"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setFullscreenOverrideKey(null);
                            }
                          }}
                        >
                          <div className="prompt-override-fullscreen-header">
                            <div className="prompt-override-fullscreen-title">
                              {promptMeta.name}
                              <code className="prompt-override-key">{key}</code>
                            </div>
                            <button
                              type="button"
                              className="prompt-override-fullscreen-close"
                              onClick={() => setFullscreenOverrideKey(null)}
                              data-testid={`collapse-fullscreen-${key}`}
                            >
                              <Minimize2 size={14} />
                              Collapse
                            </button>
                          </div>
                          <textarea
                            id={`prompt-${key}-fullscreen`}
                            aria-label={`${promptMeta.name} prompt override (${key}) - fullscreen`}
                            className="prompt-override-textarea"
                            value={currentOverride}
                            onChange={(e) => {
                              handlePromptOverrideChange(key, e.target.value);
                            }}
                            placeholder={`Default: ${promptMeta.defaultContent.slice(0, 100)}${promptMeta.defaultContent.length > 100 ? "..." : ""}`}
                            rows={30}
                            autoFocus
                            data-testid={`override-input-fullscreen-${key}`}
                          />
                          <div className="prompt-override-footer">
                            {hasOverride && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleResetOverride(key)}
                                data-testid={`reset-fullscreen-${key}`}
                              >
                                Reset
                              </button>
                            )}
                            <small className="prompt-override-hint">
                              {hasOverride
                                ? "Custom override active. Click Reset to restore default."
                                : `No override set. Using built-in default (${promptMeta.defaultContent.length} chars).`}
                            </small>
                          </div>
                        </div>
                      ) : (
                        <div className="prompt-override-editor">
                          <textarea
                            id={`prompt-${key}`}
                            aria-label={`${promptMeta.name} prompt override (${key})`}
                            className="prompt-override-textarea"
                            value={currentOverride}
                            onChange={(e) => {
                              handlePromptOverrideChange(key, e.target.value);
                            }}
                            placeholder={`Default: ${promptMeta.defaultContent.slice(0, 100)}${promptMeta.defaultContent.length > 100 ? "..." : ""}`}
                            rows={4}
                            data-testid={`override-input-${key}`}
                          />
                          <div className="prompt-override-footer">
                            {hasOverride && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResetOverride(key);
                                }}
                                data-testid={`reset-${key}`}
                              >
                                Reset
                              </button>
                            )}
                            <small className="prompt-override-hint">
                              {hasOverride
                                ? "Custom override active. Click Reset to restore default."
                                : `No override set. Using built-in default (${promptMeta.defaultContent.length} chars).`}
                            </small>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
