import { useState, useCallback, useEffect } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Globe, Folder } from "lucide-react";
import { AUTOMATION_SELECTABLE_TOOLS } from "@fusion/core";
import type { ScheduledTask, ScheduledTaskCreateInput, ScheduleType, AutomationStep } from "@fusion/core";
import { ScheduleStepsEditor } from "./ScheduleStepsEditor";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { fetchModels } from "../api";
import type { ModelInfo } from "../api";
import type { SchedulingScope } from "./ScheduledTasksModal";

/** Mapping from preset schedule types to their cron expressions. Mirrored from @fusion/core. */
const PRESET_CRON: Record<Exclude<ScheduleType, "custom">, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
  monthly: "0 0 1 * *",
  every15Minutes: "*/15 * * * *",
  every30Minutes: "*/30 * * * *",
  every2Hours: "0 */2 * * *",
  every6Hours: "0 */6 * * *",
  every12Hours: "0 */12 * * *",
  weekdays: "0 9 * * 1-5",
};

function getScheduleTypeLabels(t: TFunction<"app">): Record<ScheduleType, string> {
  return {
    hourly: t("schedule.typeHourly", "Every hour"),
    daily: t("schedule.typeDaily", "Every day (midnight)"),
    weekly: t("schedule.typeWeekly", "Every week (Monday)"),
    monthly: t("schedule.typeMonthly", "Every month (1st)"),
    custom: t("schedule.typeCustom", "Custom cron expression"),
    every15Minutes: t("schedule.typeEvery15Min", "Every 15 minutes"),
    every30Minutes: t("schedule.typeEvery30Min", "Every 30 minutes"),
    every2Hours: t("schedule.typeEvery2Hours", "Every 2 hours"),
    every6Hours: t("schedule.typeEvery6Hours", "Every 6 hours"),
    every12Hours: t("schedule.typeEvery12Hours", "Every 12 hours"),
    weekdays: t("schedule.typeWeekdays", "Weekdays at 9 AM (Mon-Fri)"),
  };
}

/**
 * Simple cron expression validator (5-field format).
 * Checks basic structure — authoritative validation happens server-side.
 */
function isLikelyCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Each field should contain digits, *, /, -, or ,
  return parts.every((p) => /^[\d*,/-]+$/.test(p));
}

/**
 * Generate a unique step ID using crypto.randomUUID with fallback.
 */
function generateStepId(): string {
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

type ScheduleMode = "simple" | "advanced";
type SimpleType = "command" | "ai-prompt" | "create-task";

interface ScheduleFormProps {
  /** Existing schedule for editing. Omit for create mode. */
  schedule?: ScheduledTask;
  /** Called with form data on submit. */
  onSubmit: (input: ScheduledTaskCreateInput) => Promise<void>;
  /** Called when the user cancels. */
  onCancel: () => void;
  /** Scope for the schedule (global or project). Defaults to schedule.scope or "project". */
  scope?: SchedulingScope;
  /** Project ID for project-scoped schedules. */
  projectId?: string;
  /** Called when the user changes the scope via the toggle buttons. */
  onScopeChange?: (scope: SchedulingScope) => void;
}

export function ScheduleForm({ schedule, onSubmit, onCancel, scope: formScope, projectId, onScopeChange }: ScheduleFormProps) {
  const { t } = useTranslation("app");
  const isEditing = !!schedule;

  // Determine initial mode based on whether the schedule has steps
  // But single ai-prompt and create-task steps from simple mode should show in simple mode
  const isSimpleAiPrompt = schedule?.steps && schedule.steps.length === 1 && 
    schedule.steps[0].type === "ai-prompt" && !schedule.command;
  const isSimpleCreateTask = schedule?.steps && schedule.steps.length === 1 && 
    schedule.steps[0].type === "create-task" && !schedule.command;
  const initialMode: ScheduleMode = (schedule?.steps && schedule.steps.length > 0 && !isSimpleAiPrompt && !isSimpleCreateTask) ? "advanced" : "simple";

  const [mode, setMode] = useState<ScheduleMode>(initialMode);
  const [name, setName] = useState(schedule?.name ?? "");
  const [description, setDescription] = useState(schedule?.description ?? "");
  const [scheduleType, setScheduleType] = useState<ScheduleType>(schedule?.scheduleType ?? "daily");
  const [cronExpression, setCronExpression] = useState(schedule?.cronExpression ?? "");
  const [command, setCommand] = useState(schedule?.command ?? "");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [timeoutMs, setTimeoutMs] = useState<number>(schedule?.timeoutMs ?? 300000);
  const [steps, setSteps] = useState<AutomationStep[]>(schedule?.steps ?? []);
  const [hasEditingSteps, setHasEditingSteps] = useState(false);

  // Scope toggle state
  const [localScope, setLocalScope] = useState<SchedulingScope>(formScope ?? "global");

  // Sync localScope when formScope prop changes (e.g., when parent resets)
  useEffect(() => {
    if (formScope) setLocalScope(formScope);
  }, [formScope]);

  // Simple mode type toggle state
  const [simpleType, setSimpleType] = useState<SimpleType>(() => {
    // Detect if editing a simple-mode AI prompt schedule
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "ai-prompt" && !schedule.command) {
      return "ai-prompt";
    }
    // Detect if editing a simple-mode create-task schedule
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "create-task" && !schedule.command) {
      return "create-task";
    }
    return "command";
  });
  const [prompt, setPrompt] = useState(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "ai-prompt" && !schedule.command) {
      return schedule.steps[0].prompt ?? "";
    }
    return "";
  });
  const [modelProvider, setModelProvider] = useState(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "ai-prompt" && !schedule.command) {
      return schedule.steps[0].modelProvider ?? "";
    }
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "create-task" && !schedule.command) {
      return schedule.steps[0].modelProvider ?? "";
    }
    return "";
  });
  const [modelId, setModelId] = useState(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "ai-prompt" && !schedule.command) {
      return schedule.steps[0].modelId ?? "";
    }
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "create-task" && !schedule.command) {
      return schedule.steps[0].modelId ?? "";
    }
    return "";
  });
  /*
  FNXC:AutomationTools 2026-06-26-00:00:
  Automation AI prompts default to every selectable coding tool for legacy schedules. Persist undefined for all-selected, but preserve an explicit empty array as the operator's no-tools choice.
  */
  const [simpleAllowedTools, setSimpleAllowedTools] = useState<string[]>(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "ai-prompt" && !schedule.command) {
      return resolveAllowedToolSelection(schedule.steps[0]);
    }
    return ALL_AUTOMATION_TOOLS;
  });
  // Create-task fields
  const [taskTitle, setTaskTitle] = useState(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "create-task" && !schedule.command) {
      return schedule.steps[0].taskTitle ?? "";
    }
    return "";
  });
  const [taskDescription, setTaskDescription] = useState(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "create-task" && !schedule.command) {
      return schedule.steps[0].taskDescription ?? "";
    }
    return "";
  });
  const [taskColumn, setTaskColumn] = useState(() => {
    if (schedule?.steps && schedule.steps.length === 1 && schedule.steps[0].type === "create-task" && !schedule.command) {
      return schedule.steps[0].taskColumn ?? "triage";
    }
    return "triage";
  });

  // Model dropdown state
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Fetch models for model dropdown
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

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Auto-fill cron expression when preset is selected
  useEffect(() => {
    if (scheduleType !== "custom") {
      setCronExpression(PRESET_CRON[scheduleType]);
    }
  }, [scheduleType]);

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

  const validate = useCallback((): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = t("schedule.nameRequired", "Name is required");
    
    // Scope validation: project scope requires projectId
    if (localScope === "project" && !projectId) {
      e.scope = t("schedule.projectRequired", "Project-specific entries require an active project.");
    }
    
    // Simple mode validation
    if (mode === "simple") {
      if (simpleType === "command") {
        if (!command.trim()) e.command = t("schedule.commandRequired", "Command is required");
      } else if (simpleType === "ai-prompt") {
        // AI Prompt mode
        if (!prompt.trim()) e.prompt = t("schedule.promptRequired", "Prompt is required");

        // Model consistency check: both must be set or both must be empty
        const hasProvider = !!modelProvider.trim();
        const hasModelId = !!modelId.trim();
        if (hasProvider !== hasModelId) {
          e.model = t("schedule.modelConsistency", "Both model provider and model ID must be set, or both must be empty");
        }
      } else if (simpleType === "create-task") {
        // Create Task mode
        if (!taskDescription.trim()) e.taskDescription = t("schedule.taskDescriptionRequired", "Task description is required");

        // Model consistency check: both must be set or both must be empty
        const hasProvider = !!modelProvider.trim();
        const hasModelId = !!modelId.trim();
        if (hasProvider !== hasModelId) {
          e.model = t("schedule.modelConsistency", "Both model provider and model ID must be set, or both must be empty");
        }
      }
    }
    
    // Advanced mode validation
    if (mode === "advanced" && steps.length === 0) e.steps = t("schedule.stepsRequired", "At least one step is required");
    
    // Validate step content in multi-step mode
    if (mode === "advanced" && steps.length > 0) {
      const incompleteSteps: string[] = [];
      
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step.name?.trim()) {
          incompleteSteps.push(t("schedule.stepNameRequired", "Step {{index}}: Name is required", { index: i + 1 }));
        }
        if (step.type === "command" && !step.command?.trim()) {
          incompleteSteps.push(t("schedule.stepCommandRequired", "Step {{index}}: Command is required", { index: i + 1 }));
        }
        if (step.type === "ai-prompt" && !step.prompt?.trim()) {
          incompleteSteps.push(t("schedule.stepPromptRequired", "Step {{index}}: Prompt is required", { index: i + 1 }));
        }
      }
      
      if (incompleteSteps.length > 0) {
        e.steps = incompleteSteps.join("; ");
      }
      
      // Check if any steps are currently being edited
      if (hasEditingSteps) {
        e.stepsEditing = t("schedule.stepsEditing", "Please save or cancel all step edits before saving the schedule");
      }
    }
    
    if (scheduleType === "custom") {
      if (!cronExpression.trim()) {
        e.cronExpression = t("schedule.cronRequired", "Cron expression is required for custom schedules");
      } else if (!isLikelyCron(cronExpression)) {
        e.cronExpression = t("schedule.cronInvalid", "Invalid cron format — expected 5 fields (e.g. '0 */6 * * *')");
      }
    }
    if (timeoutMs < 1000) {
      e.timeoutMs = t("schedule.timeoutMinimum", "Timeout must be at least 1 second (1000ms)");
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, command, prompt, modelProvider, modelId, mode, simpleType, steps, scheduleType, cronExpression, timeoutMs, hasEditingSteps, taskDescription, localScope]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!validate()) return;
      setSubmitting(true);
      try {
        let submitData: ScheduledTaskCreateInput;
        
        // Determine scope: use edit mode's existing scope, otherwise use localScope
        // When localScope is "project" but no projectId provided, fall back to "global"
        let effectiveScope = schedule?.scope ?? localScope;
        if (effectiveScope === "project" && !projectId) {
          effectiveScope = "global";
        }
        
        if (mode === "simple") {
          if (simpleType === "command") {
            submitData = {
              name: name.trim(),
              description: description.trim() || undefined,
              scheduleType,
              cronExpression: scheduleType === "custom" ? cronExpression.trim() : undefined,
              command: command.trim(),
              enabled,
              timeoutMs,
              steps: undefined,
              scope: effectiveScope,
            };
          } else if (simpleType === "ai-prompt") {
            // AI Prompt mode - create a single-step automation
            const aiStep: AutomationStep = {
              id: generateStepId(),
              type: "ai-prompt",
              name: name.trim(),
              prompt: prompt.trim(),
              modelProvider: modelProvider.trim() || undefined,
              modelId: modelId.trim() || undefined,
              allowedTools: normalizeAllowedTools(simpleAllowedTools),
            };
            submitData = {
              name: name.trim(),
              description: description.trim() || undefined,
              scheduleType,
              cronExpression: scheduleType === "custom" ? cronExpression.trim() : undefined,
              command: "",
              enabled,
              timeoutMs,
              steps: [aiStep],
              scope: effectiveScope,
            };
          } else {
            // Create Task mode - create a single-step create-task automation
            const createTaskStep: AutomationStep = {
              id: generateStepId(),
              type: "create-task",
              name: name.trim(),
              taskTitle: taskTitle.trim() || undefined,
              taskDescription: taskDescription.trim(),
              taskColumn: taskColumn,
              modelProvider: modelProvider.trim() || undefined,
              modelId: modelId.trim() || undefined,
            };
            submitData = {
              name: name.trim(),
              description: description.trim() || undefined,
              scheduleType,
              cronExpression: scheduleType === "custom" ? cronExpression.trim() : undefined,
              command: "",
              enabled,
              timeoutMs,
              steps: [createTaskStep],
              scope: effectiveScope,
            };
          }
        } else {
          submitData = {
            name: name.trim(),
            description: description.trim() || undefined,
            scheduleType,
            cronExpression: scheduleType === "custom" ? cronExpression.trim() : undefined,
            command: "",
            enabled,
            timeoutMs,
            steps,
            scope: effectiveScope,
          };
        }
        
        await onSubmit(submitData);
      } finally {
        setSubmitting(false);
      }
    },
    [validate, onSubmit, name, description, scheduleType, cronExpression, command, prompt, modelProvider, modelId, simpleAllowedTools, enabled, timeoutMs, mode, simpleType, steps, localScope, projectId, schedule?.scope, taskTitle, taskDescription, taskColumn],
  );

  const cronFieldId = "schedule-cron";
  const cronErrorId = "schedule-cron-error";
  const nameErrorId = "schedule-name-error";
  const commandErrorId = "schedule-command-error";
  const promptErrorId = "schedule-prompt-error";
  const modelErrorId = "schedule-model-error";
  const taskDescriptionErrorId = "schedule-task-description-error";
  const taskModelErrorId = "schedule-task-model-error";
  const timeoutErrorId = "schedule-timeout-error";

  const scheduleTypeLabels = getScheduleTypeLabels(t);

  return (
    <form className="schedule-form" onSubmit={handleSubmit} noValidate>
      <h4 className="settings-section-heading">
        {isEditing ? t("schedule.editTitle", "Edit Schedule") : t("schedule.newTitle", "New Schedule")}
      </h4>

      <div className="form-group">
        <label htmlFor="schedule-name">{t("schedule.nameLabel", "Name")}</label>
        <input
          id="schedule-name"
          type="text"
          placeholder={t("schedule.namePlaceholder", "e.g. Update dependencies")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? nameErrorId : undefined}
        />
        {errors.name && (
          <small id={nameErrorId} className="field-error">{errors.name}</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="schedule-description">{t("schedule.descriptionLabel", "Description (optional)")}</label>
        <textarea
          id="schedule-description"
          placeholder={t("schedule.descriptionPlaceholder", "What does this schedule do?")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      {/* Scope selector */}
      <div className="form-group">
        <label>{t("schedule.scopeLabel", "Scope")}</label>
        <div className="schedule-scope-toggle" role="radiogroup" aria-label={t("schedule.scopeAriaLabel", "Schedule scope")}>
          <button
            type="button"
            className={`schedule-scope-btn${localScope === 'global' ? " active" : ""}`}
            onClick={() => { setLocalScope("global"); onScopeChange?.("global"); }}
            role="radio"
            aria-checked={localScope === 'global' ? "true" : "false"}
            disabled={!!schedule?.scope}
            title={schedule?.scope ? t("schedule.scopeLocked", "Scope is locked to {{scope}} for existing schedules", { scope: schedule.scope }) : t("schedule.globalScopeTitle", "Global scope")}
          >
            <Globe size={12} />
            {t("schedule.globalScope", "Global")}
          </button>
          <button
            type="button"
            className={`schedule-scope-btn${localScope === 'project' ? " active" : ""}`}
            onClick={() => { setLocalScope("project"); onScopeChange?.("project"); }}
            role="radio"
            aria-checked={localScope === 'project' ? "true" : "false"}
            disabled={!!schedule?.scope || !projectId}
            title={schedule?.scope ? t("schedule.scopeLocked", "Scope is locked to {{scope}} for existing schedules", { scope: schedule.scope }) : !projectId ? t("schedule.projectScopeDisabled", "Select a project to enable project scope") : t("schedule.projectScopeTitle", "Project scope")}
          >
            <Folder size={12} />
            {t("schedule.projectScope", "Project")}
          </button>
        </div>
        <small>
          {!projectId && !schedule?.scope
            ? t("schedule.noActiveProject", "No active project. Schedules will be created at global scope.")
            : localScope === "project" && projectId
              ? t("schedule.projectScoped", "This schedule will be scoped to the current project.")
              : t("schedule.globalScoped", "This schedule will be created at global scope.")}
        </small>
        {errors.scope && (
          <small className="field-error">{errors.scope}</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="schedule-type">{t("schedule.scheduleLabel", "Schedule")}</label>
        <select
          id="schedule-type"
          value={scheduleType}
          onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
        >
          {Object.entries(scheduleTypeLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label htmlFor={cronFieldId}>
          {t("schedule.cronLabel", "Cron Expression")}
        </label>
        <input
          id={cronFieldId}
          type="text"
          placeholder="* * * * *"
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          disabled={scheduleType !== "custom"}
          aria-invalid={!!errors.cronExpression}
          aria-describedby={errors.cronExpression ? cronErrorId : undefined}
        />
        {errors.cronExpression ? (
          <small id={cronErrorId} className="field-error">{errors.cronExpression}</small>
        ) : (
          <small>
            {scheduleType === "custom" ? (
              <>{t("schedule.cronHelp", "min hour day month weekday — ")} <a href="https://crontab.guru" target="_blank" rel="noopener noreferrer">{t("schedule.crontabGuru", "crontab.guru")}</a></>
            ) : (
              t("schedule.cronAutoFilled", "Auto-filled from preset: {{cron}}", { cron: cronExpression })
            )}
          </small>
        )}
      </div>

      {/* Mode switcher */}
      <div className="form-group">
        <label>{t("schedule.modeLabel", "Execution Mode")}</label>
        <div className="schedule-mode-toggle" role="radiogroup" aria-label={t("schedule.modeAriaLabel", "Execution mode")}>
          <button
            type="button"
            className={`schedule-mode-btn${mode === "simple" ? " active" : ""}`}
            onClick={() => setMode("simple")}
            role="radio"
            aria-checked={mode === "simple"}
          >
            {t("schedule.simpleMode", "Simple")}
          </button>
          <button
            type="button"
            className={`schedule-mode-btn${mode === "advanced" ? " active" : ""}`}
            onClick={() => setMode("advanced")}
            role="radio"
            aria-checked={mode === "advanced"}
          >
            {t("schedule.advancedMode", "Multi-Step")}
          </button>
        </div>
        <small>
          {mode === "simple"
            ? t("schedule.simpleModeHelp", "Run a single shell command or AI prompt")
            : t("schedule.advancedModeHelp", "Run multiple steps sequentially (commands and AI prompts)")}
        </small>
      </div>

      {mode === "simple" ? (
        <>
          {/* Simple mode type toggle */}
          <div className="form-group">
            <label>{t("schedule.actionTypeLabel", "Action Type")}</label>
            <div className="schedule-mode-toggle" role="radiogroup" aria-label={t("schedule.actionTypeAriaLabel", "Action type")}>
              <button
                type="button"
                className={`schedule-mode-btn${simpleType === "command" ? " active" : ""}`}
                onClick={() => setSimpleType("command")}
                role="radio"
                aria-checked={simpleType === "command"}
              >
                {t("schedule.actionCommand", "Command")}
              </button>
              <button
                type="button"
                className={`schedule-mode-btn${simpleType === "ai-prompt" ? " active" : ""}`}
                onClick={() => setSimpleType("ai-prompt")}
                role="radio"
                aria-checked={simpleType === "ai-prompt"}
              >
                {t("schedule.actionAiPrompt", "AI Prompt")}
              </button>
              <button
                type="button"
                className={`schedule-mode-btn${simpleType === "create-task" ? " active" : ""}`}
                onClick={() => setSimpleType("create-task")}
                role="radio"
                aria-checked={simpleType === "create-task"}
              >
                {t("schedule.actionCreateTask", "Create Task")}
              </button>
            </div>
          </div>

          {simpleType === "command" ? (
            <div className="form-group">
              <label htmlFor="schedule-command">{t("schedule.commandLabel", "Command")}</label>
              <input
                id="schedule-command"
                type="text"
                placeholder={t("schedule.commandPlaceholder", "e.g. npm run update-deps")}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                aria-invalid={!!errors.command}
                aria-describedby={errors.command ? commandErrorId : undefined}
              />
              {errors.command ? (
                <small id={commandErrorId} className="field-error">{errors.command}</small>
              ) : (
                <small>{t("schedule.commandHelp", "Shell command to execute. Runs with your user permissions.")}</small>
              )}
            </div>
          ) : simpleType === "ai-prompt" ? (
            <>
              <div className="form-group">
                <label htmlFor="schedule-prompt">{t("schedule.promptLabel", "Prompt")}</label>
                <textarea
                  id="schedule-prompt"
                  placeholder={t("schedule.promptPlaceholder", "e.g. Summarize recent git commits and identify action items")}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                  aria-invalid={!!errors.prompt}
                  aria-describedby={errors.prompt ? promptErrorId : undefined}
                />
                {errors.prompt ? (
                  <small id={promptErrorId} className="field-error">{errors.prompt}</small>
                ) : (
                  <small>{t("schedule.promptHelp", "AI prompt to execute. Provide clear instructions for the task.")}</small>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="schedule-model">{t("schedule.modelLabel", "Model (optional)")}</label>
                <CustomModelDropdown
                  id="schedule-model"
                  label={t("schedule.modelDropdownLabel", "Model")}
                  models={models}
                  value={modelValue}
                  onChange={handleModelChange}
                  placeholder={t("schedule.modelPlaceholder", "Use default")}
                  disabled={modelsLoading}
                />
                {modelsError && <small className="field-error">{modelsError}</small>}
                {errors.model ? (
                  <small id={modelErrorId} className="field-error">{errors.model}</small>
                ) : (
                  <small>{t("schedule.modelHelp", "AI model for this prompt. Uses default if not selected.")}</small>
                )}
              </div>

              <fieldset className="form-group automation-tool-selector">
                <legend>{t("schedule.allowedToolsLabel", "Allowed tools")}</legend>
                <small>{t("schedule.allowedToolsHint", "AI prompt steps use all tools by default. Clear tools only when this automation should run without tool access.")}</small>
                <div className="automation-tool-selector__actions">
                  <button type="button" className="btn btn-sm" onClick={() => setSimpleAllowedTools(ALL_AUTOMATION_TOOLS)}>
                    {t("schedule.selectAllTools", "Select all")}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setSimpleAllowedTools([])}>
                    {t("schedule.clearTools", "Clear")}
                  </button>
                </div>
                <div className="automation-tool-selector__grid">
                  {ALL_AUTOMATION_TOOLS.map((tool) => (
                    <label key={tool} className="checkbox-label automation-tool-selector__option">
                      <input
                        type="checkbox"
                        checked={simpleAllowedTools.includes(tool)}
                        onChange={(event) => {
                          setSimpleAllowedTools((current) => event.target.checked
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
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="schedule-task-title">{t("schedule.taskTitleLabel", "Task Title (optional)")}</label>
                <input
                  id="schedule-task-title"
                  type="text"
                  placeholder={t("schedule.taskTitlePlaceholder", "e.g. Review weekly dependencies")}
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="schedule-task-description">{t("schedule.taskDescriptionLabel", "Task Description (required)")}</label>
                <textarea
                  id="schedule-task-description"
                  placeholder={t("schedule.taskDescriptionPlaceholder", "e.g. Check all npm dependencies for security vulnerabilities")}
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  rows={4}
                  aria-invalid={!!errors.taskDescription}
                  aria-describedby={errors.taskDescription ? taskDescriptionErrorId : undefined}
                />
                {errors.taskDescription ? (
                  <small id={taskDescriptionErrorId} className="field-error">{errors.taskDescription}</small>
                ) : (
                  <small>{t("schedule.taskDescriptionHelp", "Describes the task that will be created.")}</small>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="schedule-task-column">{t("schedule.targetColumnLabel", "Target Column")}</label>
                <select
                  id="schedule-task-column"
                  value={taskColumn}
                  onChange={(e) => setTaskColumn(e.target.value)}
                >
                  <option value="triage">{t("schedule.columnTriage", "Planning")}</option>
                  <option value="todo">{t("schedule.columnTodo", "To Do")}</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="schedule-task-model">{t("schedule.executorModelLabel", "Executor Model (optional)")}</label>
                <CustomModelDropdown
                  id="schedule-task-model"
                  label={t("schedule.executorModelDropdownLabel", "Executor Model")}
                  models={models}
                  value={modelValue}
                  onChange={handleModelChange}
                  placeholder={t("schedule.executorModelPlaceholder", "Use default")}
                  disabled={modelsLoading}
                />
                {modelsError && <small className="field-error">{modelsError}</small>}
                {errors.model ? (
                  <small id={taskModelErrorId} className="field-error">{errors.model}</small>
                ) : (
                  <small>{t("schedule.executorModelHelp", "AI model used to execute the created task. Uses default if not selected.")}</small>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <ScheduleStepsEditor 
            steps={steps} 
            onChange={setSteps} 
            onEditingChange={setHasEditingSteps}
          />
          {errors.steps && (
            <small className="field-error">{errors.steps}</small>
          )}
          {errors.stepsEditing && (
            <small className="field-error">{errors.stepsEditing}</small>
          )}
        </>
      )}

      <div className="form-group">
        <label htmlFor="schedule-timeout">{t("schedule.timeoutLabel", "Timeout (ms)")}</label>
        <input
          id="schedule-timeout"
          type="number"
          min={1000}
          step={1000}
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(Number(e.target.value))}
          aria-invalid={!!errors.timeoutMs}
          aria-describedby={errors.timeoutMs ? timeoutErrorId : undefined}
        />
        {errors.timeoutMs ? (
          <small id={timeoutErrorId} className="field-error">{errors.timeoutMs}</small>
        ) : (
          <small>{t("schedule.timeoutHelp", "Maximum execution time in milliseconds (default 300000 = 5 min)")}</small>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="schedule-enabled" className="checkbox-label">
          <input
            id="schedule-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("schedule.enabledLabel", "Enabled")}
        </label>
        <small>{t("schedule.enabledHelp", "When disabled, the schedule will not run automatically")}</small>
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("schedule.cancelButton", "Cancel")}
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={submitting}
        >
          {submitting ? t("schedule.saving", "Saving…") : isEditing ? t("schedule.saveChanges", "Save Changes") : t("schedule.createButton", "Create Schedule")}
        </button>
      </div>
    </form>
  );
}
