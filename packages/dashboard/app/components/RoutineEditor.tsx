import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, Webhook, Code, Zap, Globe, Folder } from "lucide-react";
import type {
  Routine,
  RoutineCreateInput,
  RoutineTrigger,
  RoutineTriggerType,
  RoutineCronTrigger,
  RoutineWebhookTrigger,
  RoutineApiTrigger,
  RoutineManualTrigger,
  RoutineCatchUpPolicy,
  RoutineExecutionPolicy,
  AutomationStep,
} from "@fusion/core";
import { ScheduleStepsEditor } from "./ScheduleStepsEditor";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { fetchModels, type ModelInfo } from "../api";

type CronPresetType = "hourly" | "daily" | "weekly" | "monthly" | "custom";

const CRON_PRESETS: Record<Exclude<CronPresetType, "custom">, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
  monthly: "0 0 1 * *",
};

// CRON_PRESET_LABELS are now built inside the component with t() — see useCronPresetLabels below

function resolveCronPreset(cronExpression: string): CronPresetType {
  const normalizedCron = cronExpression.trim();
  for (const [preset, value] of Object.entries(CRON_PRESETS)) {
    if (value === normalizedCron) {
      return preset as Exclude<CronPresetType, "custom">;
    }
  }
  return "custom";
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
 * Build a trigger object from form state.
 */
function buildTrigger(
  triggerType: RoutineTriggerType,
  cronExpression: string,
  webhookPath: string,
  webhookSecret: string,
  endpoint: string,
): RoutineTrigger {
  switch (triggerType) {
    case "cron":
      return { type: "cron", cronExpression } as RoutineCronTrigger;
    case "webhook":
      return {
        type: "webhook",
        webhookPath: webhookPath || "/trigger/" + Math.random().toString(36).slice(2, 10),
        secret: webhookSecret || undefined,
      } as RoutineWebhookTrigger;
    case "api":
      return {
        type: "api",
        endpoint: endpoint || "/api/routine/" + Math.random().toString(36).slice(2, 10),
      } as RoutineApiTrigger;
    case "manual":
      return { type: "manual" } as RoutineManualTrigger;
  }
}

/**
 * Extract trigger fields from a Routine object.
 */
function extractTriggerFields(routine: Routine) {
  const trigger = routine.trigger;
  switch (trigger.type) {
    case "cron":
      return {
        triggerType: "cron" as RoutineTriggerType,
        cronExpression: (trigger as RoutineCronTrigger).cronExpression,
        webhookPath: "",
        webhookSecret: "",
        endpoint: "",
      };
    case "webhook":
      return {
        triggerType: "webhook" as RoutineTriggerType,
        cronExpression: "",
        webhookPath: (trigger as RoutineWebhookTrigger).webhookPath,
        webhookSecret: (trigger as RoutineWebhookTrigger).secret || "",
        endpoint: "",
      };
    case "api":
      return {
        triggerType: "api" as RoutineTriggerType,
        cronExpression: "",
        webhookPath: "",
        webhookSecret: "",
        endpoint: (trigger as RoutineApiTrigger).endpoint,
      };
    case "manual":
      return {
        triggerType: "manual" as RoutineTriggerType,
        cronExpression: "",
        webhookPath: "",
        webhookSecret: "",
        endpoint: "",
      };
  }
}

// EXECUTION_POLICY_OPTIONS and CATCH_UP_POLICY_OPTIONS labels are now built inside the component with t()

function generateStepId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

type ActionMode = "simple" | "advanced";
type SimpleActionType = "command" | "ai-prompt" | "create-task";

interface RoutineEditorProps {
  /** Existing routine for editing. Omit for create mode. */
  routine?: Routine;
  /** Called with form data on submit. */
  onSubmit: (input: RoutineCreateInput) => Promise<void>;
  /** Called when the user cancels. */
  onCancel: () => void;
  /** Scope for the routine (global or project). Defaults to routine.scope or "project". */
  scope?: "global" | "project";
  /** Project ID for project-scoped routines. */
  projectId?: string;
  /** Called when the user changes the scope via the toggle buttons. */
  onScopeChange?: (scope: "global" | "project") => void;
}

export function RoutineEditor({ routine, onSubmit, onCancel, scope: formScope, projectId, onScopeChange }: RoutineEditorProps) {
  const { t } = useTranslation("app");
  const isEditing = !!routine;

  const CRON_PRESET_LABELS: Record<CronPresetType, string> = {
    hourly: t("schedule.cronPresetHourly", "Every hour"),
    daily: t("schedule.cronPresetDaily", "Every day (midnight)"),
    weekly: t("schedule.cronPresetWeekly", "Every week (Monday)"),
    monthly: t("schedule.cronPresetMonthly", "Every month (1st)"),
    custom: t("schedule.cronPresetCustom", "Custom cron expression"),
  };

  const EXECUTION_POLICY_OPTIONS: { value: RoutineExecutionPolicy; label: string }[] = [
    { value: "parallel", label: t("schedule.executionPolicyParallel", "Allow concurrent runs") },
    { value: "queue", label: t("schedule.executionPolicyQueue", "Queue after current (one at a time)") },
    { value: "reject", label: t("schedule.executionPolicyReject", "Reject new runs while running") },
  ];

  const CATCH_UP_POLICY_OPTIONS: { value: RoutineCatchUpPolicy; label: string }[] = [
    { value: "skip", label: t("schedule.catchUpPolicySkip", "Skip missed runs") },
    { value: "run_one", label: t("schedule.catchUpPolicyRunOne", "Run the most recent missed run") },
    { value: "run", label: t("schedule.catchUpPolicyRunAll", "Run all missed runs") },
  ];

  // Extract trigger fields if editing
  const initialTriggerFields = routine ? extractTriggerFields(routine) : {
    triggerType: "cron" as RoutineTriggerType,
    cronExpression: "0 * * * *",
    webhookPath: "",
    webhookSecret: "",
    endpoint: "",
  };

  const [name, setName] = useState(routine?.name ?? "");
  const [description, setDescription] = useState(routine?.description ?? "");
  const [triggerType, setTriggerType] = useState<RoutineTriggerType>(initialTriggerFields.triggerType);
  const [cronExpression, setCronExpression] = useState(initialTriggerFields.cronExpression);
  const [cronPreset, setCronPreset] = useState<CronPresetType>(() => {
    if (initialTriggerFields.triggerType !== "cron") return "custom";
    return resolveCronPreset(initialTriggerFields.cronExpression);
  });
  const [webhookPath, setWebhookPath] = useState(initialTriggerFields.webhookPath);
  const [webhookSecret, setWebhookSecret] = useState(initialTriggerFields.webhookSecret);
  const [endpoint, setEndpoint] = useState(initialTriggerFields.endpoint);
  const [executionPolicy, setExecutionPolicy] = useState<RoutineExecutionPolicy>(
    routine?.executionPolicy ?? "queue"
  );
  const [catchUpPolicy, setCatchUpPolicy] = useState<RoutineCatchUpPolicy>(
    routine?.catchUpPolicy ?? "run_one"
  );
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const isSimpleAiPrompt = routine?.steps && routine.steps.length === 1 &&
    routine.steps[0].type === "ai-prompt" && !routine.command;
  const isSimpleCreateTask = routine?.steps && routine.steps.length === 1 &&
    routine.steps[0].type === "create-task" && !routine.command;
  const [actionMode, setActionMode] = useState<ActionMode>(
    routine?.steps && routine.steps.length > 0 && !isSimpleAiPrompt && !isSimpleCreateTask ? "advanced" : "simple"
  );
  const [simpleActionType, setSimpleActionType] = useState<SimpleActionType>(() => {
    if (isSimpleAiPrompt) return "ai-prompt";
    if (isSimpleCreateTask) return "create-task";
    return "command";
  });
  const [command, setCommand] = useState(routine?.command ?? "");
  const [steps, setSteps] = useState<AutomationStep[]>(routine?.steps ?? []);
  const [hasEditingSteps, setHasEditingSteps] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState<number>(routine?.timeoutMs ?? 300000);
  const [prompt, setPrompt] = useState(isSimpleAiPrompt ? routine.steps?.[0]?.prompt ?? "" : "");
  const [taskTitle, setTaskTitle] = useState(isSimpleCreateTask ? routine.steps?.[0]?.taskTitle ?? "" : "");
  const [taskDescription, setTaskDescription] = useState(isSimpleCreateTask ? routine.steps?.[0]?.taskDescription ?? "" : "");
  const [taskColumn, setTaskColumn] = useState(isSimpleCreateTask ? routine.steps?.[0]?.taskColumn ?? "triage" : "triage");
  const [modelProvider, setModelProvider] = useState(
    isSimpleAiPrompt || isSimpleCreateTask ? routine.steps?.[0]?.modelProvider ?? "" : ""
  );
  const [modelId, setModelId] = useState(
    isSimpleAiPrompt || isSimpleCreateTask ? routine.steps?.[0]?.modelId ?? "" : ""
  );
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Scope toggle state
  const [localScope, setLocalScope] = useState<"global" | "project">(formScope ?? "global");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Sync localScope when formScope prop changes (e.g., when parent resets)
  useEffect(() => {
    if (formScope) setLocalScope(formScope);
  }, [formScope]);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    fetchModels()
      .then((response) => {
        if (!cancelled) setModels(response.models);
      })
      .catch((err: unknown) => {
        if (!cancelled) setModelsError(err instanceof Error ? err.message : t("schedule.errorLoadModels", "Failed to load models"));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const modelValue = modelProvider && modelId ? `${modelProvider}/${modelId}` : "";
  const handleModelChange = useCallback((value: string) => {
    if (!value) {
      setModelProvider("");
      setModelId("");
      return;
    }
    const slashIdx = value.indexOf("/");
    if (slashIdx !== -1) {
      setModelProvider(value.slice(0, slashIdx));
      setModelId(value.slice(slashIdx + 1));
    }
  }, []);

  const validate = useCallback((): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = t("schedule.errorNameRequired", "Name is required");

    // Scope validation: project scope requires projectId
    if (localScope === "project" && !projectId) {
      e.scope = t("schedule.errorScopeNoProject", "Project-specific entries require an active project.");
    }

    if (triggerType === "cron" && cronPreset === "custom") {
      if (!cronExpression.trim()) {
        e.cronExpression = t("schedule.errorCronRequired", "Cron expression is required");
      } else if (!isLikelyCron(cronExpression)) {
        e.cronExpression = t("schedule.errorCronInvalid", "Invalid cron format — expected 5 fields (e.g. '0 */6 * * *')");
      }
    }
    if (triggerType === "webhook" && !webhookPath.trim()) {
      e.webhookPath = t("schedule.errorWebhookPathRequired", "Webhook path is required");
    }
    if (triggerType === "api" && !endpoint.trim()) {
      e.endpoint = t("schedule.errorApiEndpointRequired", "API endpoint is required");
    }
    if (actionMode === "simple") {
      if (simpleActionType === "command" && !command.trim()) e.command = t("schedule.errorCommandRequired", "Command is required");
      if (simpleActionType === "ai-prompt" && !prompt.trim()) e.prompt = t("schedule.errorPromptRequired", "Prompt is required");
      if (simpleActionType === "create-task" && !taskDescription.trim()) e.taskDescription = t("schedule.errorTaskDescriptionRequired", "Task description is required");
      if ((modelProvider.trim() && !modelId.trim()) || (!modelProvider.trim() && modelId.trim())) {
        e.model = t("schedule.errorModelIncomplete", "Both model provider and model ID must be set, or both must be empty");
      }
    } else {
      if (steps.length === 0) e.steps = t("schedule.errorStepsRequired", "At least one step is required");
      if (hasEditingSteps) e.stepsEditing = t("schedule.errorStepsEditing", "Please save or cancel all step edits before saving the routine");
      const incompleteSteps: string[] = [];
      steps.forEach((step, index) => {
        if (!step.name?.trim()) incompleteSteps.push(t("schedule.errorStepNameRequired", "Step {{n}}: Name is required", { n: index + 1 }));
        if (step.type === "command" && !step.command?.trim()) incompleteSteps.push(t("schedule.errorStepCommandRequired", "Step {{n}}: Command is required", { n: index + 1 }));
        if (step.type === "ai-prompt" && !step.prompt?.trim()) incompleteSteps.push(t("schedule.errorStepPromptRequired", "Step {{n}}: Prompt is required", { n: index + 1 }));
        if (step.type === "create-task" && !step.taskDescription?.trim()) incompleteSteps.push(t("schedule.errorStepTaskDescRequired", "Step {{n}}: Task description is required", { n: index + 1 }));
      });
      if (incompleteSteps.length > 0) e.steps = incompleteSteps.join("; ");
    }
    if (timeoutMs < 1000) e.timeoutMs = t("schedule.errorTimeoutMin", "Timeout must be at least 1 second (1000ms)");
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, triggerType, cronExpression, cronPreset, webhookPath, endpoint, localScope, projectId, actionMode, simpleActionType, command, prompt, taskDescription, modelProvider, modelId, steps, hasEditingSteps, timeoutMs]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!validate()) return;
      setSubmitting(true);
      try {
        // Determine scope: use edit mode's existing scope, otherwise use localScope
        // When localScope is "project" but no projectId provided, fall back to "global"
        let effectiveScope = routine?.scope ?? localScope ?? (projectId ? "project" : "global");
        if (effectiveScope === "project" && !projectId) {
          effectiveScope = "global";
        }
        
        const trigger = buildTrigger(triggerType, cronExpression, webhookPath, webhookSecret, endpoint);
        let actionCommand: string | undefined;
        let actionSteps: AutomationStep[] | undefined;
        if (actionMode === "simple") {
          if (simpleActionType === "command") {
            actionCommand = command.trim() || undefined;
          } else if (simpleActionType === "ai-prompt") {
            actionSteps = [{
              id: generateStepId(),
              type: "ai-prompt",
              name: name.trim(),
              prompt: prompt.trim(),
              modelProvider: modelProvider.trim() || undefined,
              modelId: modelId.trim() || undefined,
            }];
          } else {
            actionSteps = [{
              id: generateStepId(),
              type: "create-task",
              name: name.trim(),
              taskTitle: taskTitle.trim() || undefined,
              taskDescription: taskDescription.trim(),
              taskColumn,
              modelProvider: modelProvider.trim() || undefined,
              modelId: modelId.trim() || undefined,
            }];
          }
        } else {
          actionSteps = steps;
        }
        const input: RoutineCreateInput = {
          name: name.trim(),
          agentId: routine?.agentId ?? "",
          description: description.trim() || undefined,
          trigger,
          command: actionCommand,
          steps: actionSteps,
          timeoutMs,
          executionPolicy,
          catchUpPolicy,
          enabled,
          scope: effectiveScope,
        };
        await onSubmit(input);
      } finally {
        if (isMountedRef.current) {
          setSubmitting(false);
        }
      }
    },
    [validate, onSubmit, name, description, triggerType, cronExpression, webhookPath, webhookSecret, endpoint, actionMode, simpleActionType, command, prompt, modelProvider, modelId, taskTitle, taskDescription, taskColumn, steps, timeoutMs, executionPolicy, catchUpPolicy, enabled, localScope, projectId, routine?.scope, routine?.agentId],
  );

  const nameErrorId = "routine-name-error";
  const cronErrorId = "routine-cron-error";
  const webhookErrorId = "routine-webhook-error";
  const endpointErrorId = "routine-endpoint-error";
  const commandErrorId = "routine-command-error";
  const promptErrorId = "routine-prompt-error";
  const taskDescriptionErrorId = "routine-task-description-error";
  const modelErrorId = "routine-model-error";
  const timeoutErrorId = "routine-timeout-error";

  const handleCronPresetChange = useCallback((preset: CronPresetType) => {
    setCronPreset(preset);
    if (preset !== "custom") {
      setCronExpression(CRON_PRESETS[preset]);
    }
  }, []);

  return (
    <form className="routine-form" onSubmit={handleSubmit} noValidate>
      <h4 className="settings-section-heading">
        {isEditing ? t("schedule.editRoutineHeading", "Edit Routine") : t("schedule.newRoutineHeading", "New Routine")}
      </h4>

      {/* Basic Info */}
      <div className="form-group">
        <label htmlFor="routine-name">{t("schedule.nameLabel", "Name")}</label>
        <input
          id="routine-name"
          type="text"
          placeholder={t("schedule.namePlaceholder", "e.g. Daily standup reminder")}
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
        <label htmlFor="routine-description">{t("schedule.descriptionLabel", "Description (optional)")}</label>
        <textarea
          id="routine-description"
          placeholder={t("schedule.descriptionPlaceholder", "What does this routine do?")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      {/* Scope selector */}
      <div className="form-group">
        <label>{t("schedule.scopeLabel", "Scope")}</label>
        <div className="routine-scope-toggle" role="radiogroup" aria-label={t("schedule.scopeAriaLabel", "Routine scope")}>
          <button
            type="button"
            className={`routine-scope-btn${localScope === "global" ? " active" : ""}`}
            onClick={() => { setLocalScope("global"); onScopeChange?.("global"); }}
            role="radio"
            aria-checked={localScope === "global" ? "true" : "false"}
            disabled={!!routine?.scope}
            title={routine?.scope ? t("schedule.scopeLockedTitle", "Scope is locked to {{scope}} for existing routines", { scope: routine.scope }) : t("schedule.globalScopeTitle", "Global scope")}
          >
            <Globe size={12} />
            {t("schedule.globalScope", "Global")}
          </button>
          <button
            type="button"
            className={`routine-scope-btn${localScope === "project" ? " active" : ""}`}
            onClick={() => { setLocalScope("project"); onScopeChange?.("project"); }}
            role="radio"
            aria-checked={localScope === "project" ? "true" : "false"}
            disabled={!!routine?.scope || !projectId}
            title={routine?.scope ? t("schedule.scopeLockedTitle", "Scope is locked to {{scope}} for existing routines", { scope: routine.scope }) : !projectId ? t("schedule.selectProjectTitle", "Select a project to enable project scope") : t("schedule.projectScopeTitle", "Project scope")}
          >
            <Folder size={12} />
            {t("schedule.projectScope", "Project")}
          </button>
        </div>
        <small>
          {!projectId && !routine?.scope
            ? t("schedule.scopeHintNoProject", "No active project. Routines will be created at global scope.")
            : localScope === "project" && projectId
              ? t("schedule.scopeHintProject", "This routine will be scoped to the current project.")
              : t("schedule.scopeHintGlobal", "This routine will be created at global scope.")}
        </small>
        {errors.scope && (
          <small className="field-error">{errors.scope}</small>
        )}
      </div>

      {/* Trigger Type */}
      <div className="form-group">
        <label>{t("schedule.triggerTypeLabel", "Trigger Type")}</label>
        <div className="routine-trigger-type-selector" role="radiogroup" aria-label={t("schedule.triggerTypeAriaLabel", "Trigger type")}>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "cron" ? " active" : ""}`}
            onClick={() => setTriggerType("cron")}
            role="radio"
            aria-checked={triggerType === "cron"}
          >
            <Calendar size={14} />
            {t("schedule.triggerCron", "Cron")}
          </button>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "webhook" ? " active" : ""}`}
            onClick={() => setTriggerType("webhook")}
            role="radio"
            aria-checked={triggerType === "webhook"}
          >
            <Webhook size={14} />
            {t("schedule.triggerWebhook", "Webhook")}
          </button>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "api" ? " active" : ""}`}
            onClick={() => setTriggerType("api")}
            role="radio"
            aria-checked={triggerType === "api"}
          >
            <Code size={14} />
            {t("schedule.triggerApi", "API")}
          </button>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "manual" ? " active" : ""}`}
            onClick={() => setTriggerType("manual")}
            role="radio"
            aria-checked={triggerType === "manual"}
          >
            <Zap size={14} />
            {t("schedule.triggerManual", "Manual")}
          </button>
        </div>
      </div>

      {/* Cron Expression */}
      {triggerType === "cron" && (
        <div className="form-group">
          <label htmlFor="routine-frequency">{t("schedule.frequencyLabel", "Frequency")}</label>
          <select
            id="routine-frequency"
            value={cronPreset}
            onChange={(e) => handleCronPresetChange(e.target.value as CronPresetType)}
          >
            {Object.entries(CRON_PRESET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <label htmlFor="routine-cron">{t("schedule.cronExpressionLabel", "Cron Expression")}</label>
          <input
            id="routine-cron"
            type="text"
            placeholder="* * * * *"
            value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)}
            disabled={cronPreset !== "custom"}
            aria-invalid={!!errors.cronExpression}
            aria-describedby={errors.cronExpression ? cronErrorId : undefined}
          />
          {errors.cronExpression ? (
            <small id={cronErrorId} className="field-error">{errors.cronExpression}</small>
          ) : (
            <small>
              {cronPreset === "custom" ? (
                <>{t("schedule.cronCustomHint", "min hour day month weekday")} — <a href="https://crontab.guru" target="_blank" rel="noopener noreferrer">{t("schedule.crontabGuru", "crontab.guru")}</a></>
              ) : (
                t("schedule.cronAutoFilledHint", "Auto-filled from preset: {{expression}}", { expression: cronExpression })
              )}
            </small>
          )}
        </div>
      )}

      {/* Webhook Configuration */}
      {triggerType === "webhook" && (
        <>
          <div className="form-group">
            <label htmlFor="routine-webhook-path">{t("schedule.webhookPathLabel", "Webhook Path")}</label>
            <input
              id="routine-webhook-path"
              type="text"
              placeholder={t("schedule.webhookPathPlaceholder", "/trigger/my-routine")}
              value={webhookPath}
              onChange={(e) => setWebhookPath(e.target.value)}
              aria-invalid={!!errors.webhookPath}
              aria-describedby={errors.webhookPath ? webhookErrorId : undefined}
            />
            {errors.webhookPath ? (
              <small id={webhookErrorId} className="field-error">{errors.webhookPath}</small>
            ) : (
              <small>{t("schedule.webhookPathHint", "URL path for the webhook endpoint")}</small>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="routine-webhook-secret">{t("schedule.webhookSecretLabel", "Webhook Secret (optional)")}</label>
            <input
              id="routine-webhook-secret"
              type="password"
              placeholder={t("schedule.webhookSecretPlaceholder", "Optional — leave empty for unauthenticated webhooks")}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
            <small>{t("schedule.webhookSecretHint", "HMAC secret for signature verification. Leave empty for unauthenticated webhooks.")}</small>
          </div>
        </>
      )}

      {/* API Configuration */}
      {triggerType === "api" && (
        <div className="form-group">
          <label htmlFor="routine-endpoint">{t("schedule.apiEndpointLabel", "API Endpoint")}</label>
          <input
            id="routine-endpoint"
            type="text"
            placeholder={t("schedule.apiEndpointPlaceholder", "/api/routine/my-routine")}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            aria-invalid={!!errors.endpoint}
            aria-describedby={errors.endpoint ? endpointErrorId : undefined}
          />
          {errors.endpoint ? (
            <small id={endpointErrorId} className="field-error">{errors.endpoint}</small>
          ) : (
            <small>{t("schedule.apiEndpointHint", "API endpoint path that triggers this routine")}</small>
          )}
        </div>
      )}

      {/* Manual trigger info */}
      {triggerType === "manual" && (
        <div className="form-group">
          <small className="routine-trigger-info">
            {t("schedule.manualTriggerInfo", "This routine will be triggered manually via the dashboard or API.")}
          </small>
        </div>
      )}

      <div className="form-group">
        <label>{t("schedule.actionModeLabel", "Action Mode")}</label>
        <div className="schedule-mode-toggle" role="radiogroup" aria-label={t("schedule.actionModeAriaLabel", "Action mode")}>
          <button
            type="button"
            className={`schedule-mode-btn${actionMode === "simple" ? " active" : ""}`}
            onClick={() => setActionMode("simple")}
            role="radio"
            aria-checked={actionMode === "simple"}
          >
            {t("schedule.actionModeSimple", "Simple")}
          </button>
          <button
            type="button"
            className={`schedule-mode-btn${actionMode === "advanced" ? " active" : ""}`}
            onClick={() => setActionMode("advanced")}
            role="radio"
            aria-checked={actionMode === "advanced"}
          >
            {t("schedule.actionModeAdvanced", "Multi-Step")}
          </button>
        </div>
        <small>{actionMode === "simple" ? t("schedule.actionModeSimpleHint", "Run one command, prompt, or task creation action") : t("schedule.actionModeAdvancedHint", "Run multiple actions sequentially")}</small>
      </div>

      {actionMode === "simple" ? (
        <>
          <div className="form-group">
            <label>{t("schedule.actionTypeLabel", "Action Type")}</label>
            <div className="schedule-mode-toggle" role="radiogroup" aria-label={t("schedule.actionTypeAriaLabel", "Action type")}>
              <button type="button" className={`schedule-mode-btn${simpleActionType === "command" ? " active" : ""}`} onClick={() => setSimpleActionType("command")} role="radio" aria-checked={simpleActionType === "command"}>{t("schedule.actionTypeCommand", "Command")}</button>
              <button type="button" className={`schedule-mode-btn${simpleActionType === "ai-prompt" ? " active" : ""}`} onClick={() => setSimpleActionType("ai-prompt")} role="radio" aria-checked={simpleActionType === "ai-prompt"}>{t("schedule.actionTypeAiPrompt", "AI Prompt")}</button>
              <button type="button" className={`schedule-mode-btn${simpleActionType === "create-task" ? " active" : ""}`} onClick={() => setSimpleActionType("create-task")} role="radio" aria-checked={simpleActionType === "create-task"}>{t("schedule.actionTypeCreateTask", "Create Task")}</button>
            </div>
          </div>

          {simpleActionType === "command" ? (
            <div className="form-group">
              <label htmlFor="routine-command">{t("schedule.commandLabel", "Command")}</label>
              <input id="routine-command" type="text" placeholder={t("schedule.commandPlaceholder", "e.g. npx runfusion.ai backup --create")} value={command} onChange={(e) => setCommand(e.target.value)} aria-invalid={!!errors.command} aria-describedby={errors.command ? commandErrorId : undefined} />
              {errors.command ? <small id={commandErrorId} className="field-error">{errors.command}</small> : <small>{t("schedule.commandHint", "Shell command to execute.")}</small>}
            </div>
          ) : simpleActionType === "ai-prompt" ? (
            <>
              <div className="form-group">
                <label htmlFor="routine-prompt">{t("schedule.promptLabel", "Prompt")}</label>
                <textarea id="routine-prompt" placeholder={t("schedule.promptPlaceholder", "e.g. Summarize recent activity and create action items")} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-invalid={!!errors.prompt} aria-describedby={errors.prompt ? promptErrorId : undefined} />
                {errors.prompt ? <small id={promptErrorId} className="field-error">{errors.prompt}</small> : <small>{t("schedule.promptHint", "AI prompt to execute.")}</small>}
              </div>
              <div className="form-group">
                <label htmlFor="routine-model">{t("schedule.modelLabel", "Model (optional)")}</label>
                <CustomModelDropdown id="routine-model" label={t("schedule.modelDropdownLabel", "Model")} models={models} value={modelValue} onChange={handleModelChange} placeholder={t("schedule.modelPlaceholder", "Use default")} disabled={modelsLoading} />
                {modelsError && <small className="field-error">{modelsError}</small>}
                {errors.model && <small id={modelErrorId} className="field-error">{errors.model}</small>}
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="routine-task-title">{t("schedule.taskTitleLabel", "Task Title (optional)")}</label>
                <input id="routine-task-title" type="text" placeholder={t("schedule.taskTitlePlaceholder", "e.g. Review weekly dependencies")} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="routine-task-description">{t("schedule.taskDescriptionLabel", "Task Description")}</label>
                <textarea id="routine-task-description" placeholder={t("schedule.taskDescriptionPlaceholder", "e.g. Check npm dependencies for security vulnerabilities")} value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} rows={4} aria-invalid={!!errors.taskDescription} aria-describedby={errors.taskDescription ? taskDescriptionErrorId : undefined} />
                {errors.taskDescription ? <small id={taskDescriptionErrorId} className="field-error">{errors.taskDescription}</small> : <small>{t("schedule.taskDescriptionHint", "Describes the task that will be created.")}</small>}
              </div>
              <div className="form-group">
                <label htmlFor="routine-task-column">{t("schedule.taskColumnLabel", "Target Column")}</label>
                <select id="routine-task-column" value={taskColumn} onChange={(e) => setTaskColumn(e.target.value)}>
                  <option value="triage">{t("schedule.taskColumnTriage", "Planning")}</option>
                  <option value="todo">{t("schedule.taskColumnTodo", "To Do")}</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="routine-task-model">{t("schedule.executorModelLabel", "Executor Model (optional)")}</label>
                <CustomModelDropdown id="routine-task-model" label={t("schedule.executorModelDropdownLabel", "Executor Model")} models={models} value={modelValue} onChange={handleModelChange} placeholder={t("schedule.modelPlaceholder", "Use default")} disabled={modelsLoading} />
                {modelsError && <small className="field-error">{modelsError}</small>}
                {errors.model && <small id={modelErrorId} className="field-error">{errors.model}</small>}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <ScheduleStepsEditor steps={steps} onChange={setSteps} onEditingChange={setHasEditingSteps} />
          {errors.steps && <small className="field-error">{errors.steps}</small>}
          {errors.stepsEditing && <small className="field-error">{errors.stepsEditing}</small>}
        </>
      )}

      <div className="form-group">
        <label htmlFor="routine-timeout">{t("schedule.timeoutLabel", "Timeout (ms)")}</label>
        <input id="routine-timeout" type="number" min={1000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} aria-invalid={!!errors.timeoutMs} aria-describedby={errors.timeoutMs ? timeoutErrorId : undefined} />
        {errors.timeoutMs ? <small id={timeoutErrorId} className="field-error">{errors.timeoutMs}</small> : <small>{t("schedule.timeoutHint", "Maximum execution time in milliseconds.")}</small>}
      </div>

      {/* Execution Policy */}
      <div className="form-group">
        <label htmlFor="routine-execution-policy">{t("schedule.executionPolicyLabel", "Execution Policy")}</label>
        <select
          id="routine-execution-policy"
          value={executionPolicy}
          onChange={(e) => setExecutionPolicy(e.target.value as RoutineExecutionPolicy)}
        >
          {EXECUTION_POLICY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <small>{t("schedule.executionPolicyHint", "How to handle concurrent executions of this routine")}</small>
      </div>

      {/* Catch-up Policy */}
      <div className="form-group">
        <label htmlFor="routine-catchup-policy">{t("schedule.catchUpPolicyLabel", "Catch-up Policy")}</label>
        <select
          id="routine-catchup-policy"
          value={catchUpPolicy}
          onChange={(e) => setCatchUpPolicy(e.target.value as RoutineCatchUpPolicy)}
        >
          {CATCH_UP_POLICY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <small>{t("schedule.catchUpPolicyHint", "What to do when a scheduled run is missed")}</small>
      </div>

      {/* Enabled */}
      <div className="form-group">
        <label htmlFor="routine-enabled" className="checkbox-label">
          <input
            id="routine-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("schedule.enabledLabel", "Enabled")}
        </label>
        <small>{t("schedule.enabledHint", "When disabled, the routine will not run automatically")}</small>
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("common.cancel", "Cancel")}
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={submitting}
        >
          {submitting ? t("common.saving", "Saving…") : isEditing ? t("schedule.saveChanges", "Save Changes") : t("schedule.createRoutine", "Create Routine")}
        </button>
      </div>
    </form>
  );
}
