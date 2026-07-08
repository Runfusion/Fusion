import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ChevronUp, ChevronDown, Pencil, GripVertical } from "lucide-react";
import { AUTOMATION_SELECTABLE_TOOLS } from "@fusion/core";
import type { AutomationStep, AutomationStepType } from "@fusion/core";
import { StepTypeBadge } from "./StepTypeBadge";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { fetchModels } from "../api";
import type { ModelInfo } from "../api";

interface ScheduleStepsEditorProps {
  steps: AutomationStep[];
  onChange: (steps: AutomationStep[]) => void;
  /** Called when editing state changes. Useful for parent form validation. */
  onEditingChange?: (isEditing: boolean) => void;
}

function generateStepId(): string {
  // crypto.randomUUID() may be unavailable in non-secure contexts (HTTP),
  // older browsers, or some test environments. Fall back to a
  // cryptographically-acceptable alternative when needed.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Deterministic fallback: timestamp + random hex
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

const ALL_AUTOMATION_TOOLS = [...AUTOMATION_SELECTABLE_TOOLS];

function normalizeAllowedTools(selectedTools: string[]): string[] | undefined {
  return selectedTools.length === ALL_AUTOMATION_TOOLS.length ? undefined : selectedTools;
}

function resolveAllowedToolSelection(step?: AutomationStep): string[] {
  return step?.allowedTools === undefined ? ALL_AUTOMATION_TOOLS : step.allowedTools;
}

function createEmptyStep(type: AutomationStepType): AutomationStep {
  if (type === "command") {
    return {
      id: generateStepId(),
      type,
      name: "New Command Step",
      command: "",
      continueOnFailure: false,
    };
  }
  if (type === "ai-prompt") {
    return {
      id: generateStepId(),
      type,
      name: "New AI Prompt Step",
      prompt: "",
      continueOnFailure: false,
    };
  }
  // create-task
  return {
    id: generateStepId(),
    type,
    name: "New Create Task Step",
    taskDescription: "",
    taskColumn: "triage",
    continueOnFailure: false,
  };
}

interface StepEditorProps {
  step: AutomationStep;
  onSave: (step: AutomationStep) => void;
  onCancel: () => void;
}

function StepEditor({ step, onSave, onCancel }: StepEditorProps) {
  const { t } = useTranslation("app");
  const [name, setName] = useState(step.name);
  const [type, setType] = useState<AutomationStepType>(step.type);
  const [command, setCommand] = useState(step.command ?? "");
  const [prompt, setPrompt] = useState(step.prompt ?? "");
  const [modelProvider, setModelProvider] = useState(step.modelProvider ?? "");
  const [modelId, setModelId] = useState(step.modelId ?? "");
  /*
  FNXC:AutomationTools 2026-06-26-00:00:
  Multi-step AI prompts share the simple form's default-all contract: undefined means every selectable coding tool, while [] intentionally removes all tools for the step.
  */
  const [allowedTools, setAllowedTools] = useState<string[]>(() => resolveAllowedToolSelection(step));
  const [taskTitle, setTaskTitle] = useState(step.taskTitle ?? "");
  const [taskDescription, setTaskDescription] = useState(step.taskDescription ?? "");
  const [taskColumn, setTaskColumn] = useState(step.taskColumn ?? "triage");
  const [timeoutMs, setTimeoutMs] = useState<number | undefined>(step.timeoutMs);
  const [continueOnFailure, setContinueOnFailure] = useState(step.continueOnFailure ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Fetch models on mount
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);

    fetchModels()
      .then((response) => {
        if (!cancelled) {
          setModels(response.models);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setModelsError(err instanceof Error ? err.message : "Failed to load models");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const validate = useCallback((): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = t("schedule.stepNameRequired", "Step name is required");
    if (type === "command" && !command.trim()) e.command = t("schedule.commandRequired", "Command is required");
    if (type === "ai-prompt" && !prompt.trim()) e.prompt = t("schedule.promptRequired", "Prompt is required");
    if (type === "create-task" && !taskDescription.trim()) e.taskDescription = t("schedule.taskDescriptionRequired", "Task description is required");
    // Model pairing validation for ai-prompt and create-task
    if ((type === "ai-prompt" || type === "create-task") && (modelProvider || modelId)) {
      if (!modelProvider || !modelId) {
        e.modelProvider = t("schedule.modelProviderRequired", "Both model provider and model ID must be set together");
      }
    }
    if (timeoutMs !== undefined && timeoutMs < 1000) {
      e.timeoutMs = t("schedule.timeoutMinimum", "Timeout must be at least 1 second (1000ms)");
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, type, command, prompt, taskDescription, modelProvider, modelId, timeoutMs, t]);

  // Compute combined model value from separate fields
  const modelValue = (modelProvider && modelId) ? `${modelProvider}/${modelId}` : "";

  // Handle model selection from the dropdown
  const handleModelChange = useCallback((value: string) => {
    if (!value) {
      setModelProvider("");
      setModelId("");
    } else {
      const slashIdx = value.indexOf("/");
      if (slashIdx !== -1) {
        setModelProvider(value.slice(0, slashIdx));
        setModelId(value.slice(slashIdx + 1));
      }
    }
  }, []);

  const handleSave = useCallback(() => {
    if (!validate()) return;

    // Clear fields that don't apply to this step type
    const baseStep = {
      ...step,
      name: name.trim(),
      type,
      command: type === "command" ? command.trim() : undefined,
      prompt: type === "ai-prompt" ? prompt.trim() : undefined,
      taskTitle: type === "create-task" && taskTitle.trim() ? taskTitle.trim() : undefined,
      taskDescription: type === "create-task" && taskDescription.trim() ? taskDescription.trim() : undefined,
      taskColumn: type === "create-task" ? taskColumn : undefined,
      modelProvider: (type === "ai-prompt" || type === "create-task") && modelProvider.trim() ? modelProvider.trim() : undefined,
      modelId: (type === "ai-prompt" || type === "create-task") && modelId.trim() ? modelId.trim() : undefined,
      allowedTools: type === "ai-prompt" ? normalizeAllowedTools(allowedTools) : undefined,
      timeoutMs: timeoutMs || undefined,
      continueOnFailure,
    };

    // Clear ai-prompt and create-task specific fields when switching to command
    if (type !== "ai-prompt") {
      delete baseStep.prompt;
      delete baseStep.allowedTools;
    }
    if (type !== "create-task") {
      delete baseStep.taskTitle;
      delete baseStep.taskDescription;
      delete baseStep.taskColumn;
    }

    onSave(baseStep as AutomationStep);
  }, [validate, onSave, step, name, type, command, prompt, taskTitle, taskDescription, taskColumn, modelProvider, modelId, allowedTools, timeoutMs, continueOnFailure]);

  return (
    <div className="step-editor">
      <div className="form-group">
        <label htmlFor={`step-name-${step.id}`}>{t("schedule.stepName", "Step Name")}</label>
        <input
          id={`step-name-${step.id}`}
          type="text"
          placeholder={t("schedule.stepNamePlaceholder", "e.g. Run tests")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!errors.name}
        />
        {errors.name && <small className="field-error">{errors.name}</small>}
      </div>

      <div className="form-group">
        <label htmlFor={`step-type-${step.id}`}>{t("schedule.stepType", "Step Type")}</label>
        <select
          id={`step-type-${step.id}`}
          value={type}
          onChange={(e) => setType(e.target.value as AutomationStepType)}
        >
          <option value="command">{t("schedule.commandType", "Command")}</option>
          <option value="ai-prompt">{t("schedule.aiPromptType", "AI Prompt")}</option>
          <option value="create-task">{t("schedule.createTaskType", "Create Task")}</option>
        </select>
      </div>

      {type === "command" && (
        <div className="form-group">
          <label htmlFor={`step-command-${step.id}`}>{t("schedule.command", "Command")}</label>
          <textarea
            id={`step-command-${step.id}`}
            placeholder={t("schedule.commandPlaceholder", "e.g. npm test")}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={2}
            aria-invalid={!!errors.command}
          />
          {errors.command && <small className="field-error">{errors.command}</small>}
        </div>
      )}

      {type === "ai-prompt" && (
        <>
          <div className="form-group">
            <label htmlFor={`step-prompt-${step.id}`}>{t("schedule.prompt", "Prompt")}</label>
            <textarea
              id={`step-prompt-${step.id}`}
              placeholder={t("schedule.promptPlaceholder", "e.g. Summarize the test results and highlight any failures")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              aria-invalid={!!errors.prompt}
            />
            {errors.prompt && <small className="field-error">{errors.prompt}</small>}
          </div>

          <div className="form-group">
            <label htmlFor={`step-model-${step.id}`}>{t("schedule.modelOptional", "Model (optional)")}</label>
            <CustomModelDropdown
              id={`step-model-${step.id}`}
              label={t("schedule.model", "Model")}
              models={models}
              value={modelValue}
              onChange={handleModelChange}
              placeholder={t("schedule.useDefault", "Use default")}
              disabled={modelsLoading}
            />
            {modelsError && <small className="field-error">{modelsError}</small>}
            <small>{t("schedule.modelHelp", "AI model for this step. Uses default if not selected.")}</small>
          </div>

          <fieldset className="form-group automation-tool-selector">
            <legend>{t("schedule.allowedToolsLabel", "Allowed tools")}</legend>
            <small>{t("schedule.allowedToolsHint", "AI prompt steps use all tools by default. Clear tools only when this automation should run without tool access.")}</small>
            <div className="automation-tool-selector__actions">
              <button type="button" className="btn btn-sm" onClick={() => setAllowedTools(ALL_AUTOMATION_TOOLS)}>
                {t("schedule.selectAllTools", "Select all")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAllowedTools([])}>
                {t("schedule.clearTools", "Clear")}
              </button>
            </div>
            <div className="automation-tool-selector__grid">
              {ALL_AUTOMATION_TOOLS.map((tool) => (
                <label key={tool} className="checkbox-label automation-tool-selector__option">
                  <input
                    type="checkbox"
                    checked={allowedTools.includes(tool)}
                    onChange={(event) => {
                      setAllowedTools((current) => event.target.checked
                        ? [...current, tool].filter((value, index, array) => array.indexOf(value) === index)
                        : current.filter((value) => value !== tool));
                    }}
                  />
                  {tool}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}

      {type === "create-task" && (
        <>
          <div className="form-group">
            <label htmlFor={`step-task-title-${step.id}`}>{t("schedule.taskTitleOptional", "Task Title (optional)")}</label>
            <input
              id={`step-task-title-${step.id}`}
              type="text"
              placeholder={t("schedule.taskTitlePlaceholder", "e.g. Review weekly dependencies")}
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
            />
            <small>{t("schedule.taskTitleHelp", "Leave blank to auto-summarize from description")}</small>
          </div>

          <div className="form-group">
            <label htmlFor={`step-task-description-${step.id}`}>{t("schedule.taskDescription", "Task Description *")}</label>
            <textarea
              id={`step-task-description-${step.id}`}
              placeholder={t("schedule.taskDescriptionPlaceholder", "e.g. Check all npm dependencies for security vulnerabilities and update outdated packages")}
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              rows={4}
              aria-invalid={!!errors.taskDescription}
            />
            {errors.taskDescription && <small className="field-error">{errors.taskDescription}</small>}
          </div>

          <div className="form-group">
            <label htmlFor={`step-task-column-${step.id}`}>{t("schedule.targetColumn", "Target Column")}</label>
            <select
              id={`step-task-column-${step.id}`}
              value={taskColumn}
              onChange={(e) => setTaskColumn(e.target.value)}
            >
              <option value="triage">{t("schedule.triageColumn", "Planning")}</option>
              <option value="todo">{t("schedule.todoColumn", "To Do")}</option>
            </select>
            <small>{t("schedule.targetColumnHelp", "Column where the new task will be created")}</small>
          </div>

          <div className="form-group">
            <label htmlFor={`step-task-model-${step.id}`}>{t("schedule.executorModelOptional", "Executor Model (optional)")}</label>
            <CustomModelDropdown
              id={`step-task-model-${step.id}`}
              label={t("schedule.model", "Model")}
              models={models}
              value={modelValue}
              onChange={handleModelChange}
              placeholder={t("schedule.useDefault", "Use default")}
              disabled={modelsLoading}
            />
            {modelsError && <small className="field-error">{modelsError}</small>}
            {errors.modelProvider && <small className="field-error">{errors.modelProvider}</small>}
            <small>{t("schedule.executorModelHelp", "AI model for executing the created task. Uses default if not selected.")}</small>
          </div>
        </>
      )}

      <div className="form-group">
        <label htmlFor={`step-timeout-${step.id}`}>{t("schedule.timeoutOptional", "Timeout (ms, optional)")}</label>
        <input
          id={`step-timeout-${step.id}`}
          type="number"
          min={1000}
          step={1000}
          placeholder={t("schedule.timeoutPlaceholder", "Override schedule timeout")}
          value={timeoutMs ?? ""}
          onChange={(e) => setTimeoutMs(e.target.value ? Number(e.target.value) : undefined)}
          aria-invalid={!!errors.timeoutMs}
        />
        {errors.timeoutMs && <small className="field-error">{errors.timeoutMs}</small>}
      </div>

      <div className="form-group">
        <label htmlFor={`step-continue-${step.id}`} className="checkbox-label">
          <input
            id={`step-continue-${step.id}`}
            type="checkbox"
            checked={continueOnFailure}
            onChange={(e) => setContinueOnFailure(e.target.checked)}
          />
          {t("schedule.continueOnFailure", "Continue on failure")}
        </label>
        <small>{t("schedule.continueOnFailureHelp", "If checked, the next step will run even if this one fails")}</small>
      </div>

      <div className="step-editor-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {t("actions.cancel", "Cancel")}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>
          {t("schedule.saveStep", "Save Step")}
        </button>
      </div>
    </div>
  );
}

export function ScheduleStepsEditor({ steps, onChange, onEditingChange }: ScheduleStepsEditorProps) {
  const { t } = useTranslation("app");
  const [editingStepId, setEditingStepId] = useState<string | null>(null);

  // Notify parent when editing state changes
  useEffect(() => {
    onEditingChange?.(editingStepId !== null);
  }, [editingStepId, onEditingChange]);

  const handleAddStep = useCallback((type: AutomationStepType) => {
    const newStep = createEmptyStep(type);
    onChange([...steps, newStep]);
    setEditingStepId(newStep.id);
  }, [steps, onChange]);

  const handleDeleteStep = useCallback((stepId: string) => {
    onChange(steps.filter((s) => s.id !== stepId));
    if (editingStepId === stepId) setEditingStepId(null);
  }, [steps, onChange, editingStepId]);

  const handleMoveStep = useCallback((stepId: string, direction: "up" | "down") => {
    const index = steps.findIndex((s) => s.id === stepId);
    if (index < 0) return;
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= steps.length) return;
    const newSteps = [...steps];
    [newSteps[index], newSteps[newIndex]] = [newSteps[newIndex], newSteps[index]];
    onChange(newSteps);
  }, [steps, onChange]);

  const handleSaveStep = useCallback((updatedStep: AutomationStep) => {
    onChange(steps.map((s) => (s.id === updatedStep.id ? updatedStep : s)));
    setEditingStepId(null);
  }, [steps, onChange]);

  return (
    <div className="steps-editor">
      <div className="steps-editor-header">
        <span className="steps-editor-title">{t("schedule.steps", "Steps")} ({steps.length})</span>
      </div>

      {steps.length === 0 && (
        <div className="steps-empty-state">
          <p>{t("schedule.noStepsEmpty", "No steps added yet. Add a command or AI prompt step to get started.")}</p>
        </div>
      )}

      <div className="steps-list">
        {steps.map((step, index) => (
          <div key={step.id} className="step-card">
            {editingStepId === step.id ? (
              <StepEditor
                step={step}
                onSave={handleSaveStep}
                onCancel={() => setEditingStepId(null)}
              />
            ) : (
              <div className="step-card-row">
                <div className="step-card-drag">
                  <GripVertical size={14} />
                </div>
                <span className="step-card-index">{index + 1}</span>
                <StepTypeBadge type={step.type} />
                <span className="step-card-name">{step.name}</span>
                {step.continueOnFailure && (
                  <span className="step-card-flag" title={t("schedule.continuesOnFailure", "Continues on failure")}>⚡</span>
                )}
                <div className="step-card-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleMoveStep(step.id, "up")}
                    disabled={index === 0}
                    title={t("schedule.moveUp", "Move up")}
                    aria-label={t("schedule.moveStepUp", "Move {{name}} up", { name: step.name })}
                  >
                    <ChevronUp />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleMoveStep(step.id, "down")}
                    disabled={index === steps.length - 1}
                    title={t("schedule.moveDown", "Move down")}
                    aria-label={t("schedule.moveStepDown", "Move {{name}} down", { name: step.name })}
                  >
                    <ChevronDown />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setEditingStepId(step.id)}
                    title={t("actions.edit", "Edit")}
                    aria-label={t("schedule.editStep", "Edit {{name}}", { name: step.name })}
                  >
                    <Pencil />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleDeleteStep(step.id)}
                    title={t("actions.delete", "Delete")}
                    aria-label={t("schedule.deleteStep", "Delete {{name}}", { name: step.name })}
                  >
                    <Trash2 />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="steps-add-buttons">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => handleAddStep("command")}
        >
          <Plus size={14} />
          {t("schedule.addCommandStep", "Add Command Step")}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => handleAddStep("ai-prompt")}
        >
          <Plus size={14} />
          {t("schedule.addAiPromptStep", "Add AI Prompt Step")}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => handleAddStep("create-task")}
        >
          <Plus size={14} />
          {t("schedule.addCreateTaskStep", "Add Create Task Step")}
        </button>
      </div>
    </div>
  );
}
