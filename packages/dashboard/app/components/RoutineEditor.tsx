import { useState, useCallback, useEffect, useRef } from "react";
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

const CRON_PRESET_LABELS: Record<CronPresetType, string> = {
  hourly: "Every hour",
  daily: "Every day (midnight)",
  weekly: "Every week (Monday)",
  monthly: "Every month (1st)",
  custom: "Custom cron expression",
};

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
  return parts.every((p) => /^[\d*,/\-]+$/.test(p));
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

const EXECUTION_POLICY_OPTIONS: { value: RoutineExecutionPolicy; label: string }[] = [
  { value: "parallel", label: "Allow concurrent runs" },
  { value: "queue", label: "Queue after current (one at a time)" },
  { value: "reject", label: "Reject new runs while running" },
];

const CATCH_UP_POLICY_OPTIONS: { value: RoutineCatchUpPolicy; label: string }[] = [
  { value: "skip", label: "Skip missed runs" },
  { value: "run_one", label: "Run the most recent missed run" },
  { value: "run", label: "Run all missed runs" },
];

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
  const isEditing = !!routine;

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
        if (!cancelled) setModelsError(err instanceof Error ? err.message : "Failed to load models");
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
    if (!name.trim()) e.name = "Name is required";
    
    // Scope validation: project scope requires projectId
    if (localScope === "project" && !projectId) {
      e.scope = "Project-specific entries require an active project.";
    }
    
    if (triggerType === "cron" && cronPreset === "custom") {
      if (!cronExpression.trim()) {
        e.cronExpression = "Cron expression is required";
      } else if (!isLikelyCron(cronExpression)) {
        e.cronExpression = "Invalid cron format — expected 5 fields (e.g. '0 */6 * * *')";
      }
    }
    if (triggerType === "webhook" && !webhookPath.trim()) {
      e.webhookPath = "Webhook path is required";
    }
    if (triggerType === "api" && !endpoint.trim()) {
      e.endpoint = "API endpoint is required";
    }
    if (actionMode === "simple") {
      if (simpleActionType === "command" && !command.trim()) e.command = "Command is required";
      if (simpleActionType === "ai-prompt" && !prompt.trim()) e.prompt = "Prompt is required";
      if (simpleActionType === "create-task" && !taskDescription.trim()) e.taskDescription = "Task description is required";
      if ((modelProvider.trim() && !modelId.trim()) || (!modelProvider.trim() && modelId.trim())) {
        e.model = "Both model provider and model ID must be set, or both must be empty";
      }
    } else {
      if (steps.length === 0) e.steps = "At least one step is required";
      if (hasEditingSteps) e.stepsEditing = "Please save or cancel all step edits before saving the routine";
      const incompleteSteps: string[] = [];
      steps.forEach((step, index) => {
        if (!step.name?.trim()) incompleteSteps.push(`Step ${index + 1}: Name is required`);
        if (step.type === "command" && !step.command?.trim()) incompleteSteps.push(`Step ${index + 1}: Command is required`);
        if (step.type === "ai-prompt" && !step.prompt?.trim()) incompleteSteps.push(`Step ${index + 1}: Prompt is required`);
        if (step.type === "create-task" && !step.taskDescription?.trim()) incompleteSteps.push(`Step ${index + 1}: Task description is required`);
      });
      if (incompleteSteps.length > 0) e.steps = incompleteSteps.join("; ");
    }
    if (timeoutMs < 1000) e.timeoutMs = "Timeout must be at least 1 second (1000ms)";
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
        {isEditing ? "Edit Routine" : "New Routine"}
      </h4>

      {/* Basic Info */}
      <div className="form-group">
        <label htmlFor="routine-name">Name</label>
        <input
          id="routine-name"
          type="text"
          placeholder="e.g. Daily standup reminder"
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
        <label htmlFor="routine-description">Description (optional)</label>
        <textarea
          id="routine-description"
          placeholder="What does this routine do?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      {/* Scope selector */}
      <div className="form-group">
        <label>Scope</label>
        <div className="routine-scope-toggle" role="radiogroup" aria-label="Routine scope">
          <button
            type="button"
            className={`routine-scope-btn${localScope === "global" ? " active" : ""}`}
            onClick={() => { setLocalScope("global"); onScopeChange?.("global"); }}
            role="radio"
            aria-checked={localScope === "global" ? "true" : "false"}
            disabled={!!routine?.scope}
            title={routine?.scope ? `Scope is locked to ${routine.scope} for existing routines` : "Global scope"}
          >
            <Globe size={12} />
            Global
          </button>
          <button
            type="button"
            className={`routine-scope-btn${localScope === "project" ? " active" : ""}`}
            onClick={() => { setLocalScope("project"); onScopeChange?.("project"); }}
            role="radio"
            aria-checked={localScope === "project" ? "true" : "false"}
            disabled={!!routine?.scope || !projectId}
            title={routine?.scope ? `Scope is locked to ${routine.scope} for existing routines` : !projectId ? "Select a project to enable project scope" : "Project scope"}
          >
            <Folder size={12} />
            Project
          </button>
        </div>
        <small>
          {!projectId && !routine?.scope
            ? "No active project. Routines will be created at global scope."
            : localScope === "project" && projectId
              ? `This routine will be scoped to the current project.`
              : "This routine will be created at global scope."}
        </small>
        {errors.scope && (
          <small className="field-error">{errors.scope}</small>
        )}
      </div>

      {/* Trigger Type */}
      <div className="form-group">
        <label>Trigger Type</label>
        <div className="routine-trigger-type-selector" role="radiogroup" aria-label="Trigger type">
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "cron" ? " active" : ""}`}
            onClick={() => setTriggerType("cron")}
            role="radio"
            aria-checked={triggerType === "cron"}
          >
            <Calendar size={14} />
            Cron
          </button>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "webhook" ? " active" : ""}`}
            onClick={() => setTriggerType("webhook")}
            role="radio"
            aria-checked={triggerType === "webhook"}
          >
            <Webhook size={14} />
            Webhook
          </button>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "api" ? " active" : ""}`}
            onClick={() => setTriggerType("api")}
            role="radio"
            aria-checked={triggerType === "api"}
          >
            <Code size={14} />
            API
          </button>
          <button
            type="button"
            className={`routine-trigger-btn${triggerType === "manual" ? " active" : ""}`}
            onClick={() => setTriggerType("manual")}
            role="radio"
            aria-checked={triggerType === "manual"}
          >
            <Zap size={14} />
            Manual
          </button>
        </div>
      </div>

      {/* Cron Expression */}
      {triggerType === "cron" && (
        <div className="form-group">
          <label htmlFor="routine-frequency">Frequency</label>
          <select
            id="routine-frequency"
            value={cronPreset}
            onChange={(e) => handleCronPresetChange(e.target.value as CronPresetType)}
          >
            {Object.entries(CRON_PRESET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <label htmlFor="routine-cron">Cron Expression</label>
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
                <>min hour day month weekday — <a href="https://crontab.guru" target="_blank" rel="noopener noreferrer">crontab.guru</a></>
              ) : (
                `Auto-filled from preset: ${cronExpression}`
              )}
            </small>
          )}
        </div>
      )}

      {/* Webhook Configuration */}
      {triggerType === "webhook" && (
        <>
          <div className="form-group">
            <label htmlFor="routine-webhook-path">Webhook Path</label>
            <input
              id="routine-webhook-path"
              type="text"
              placeholder="/trigger/my-routine"
              value={webhookPath}
              onChange={(e) => setWebhookPath(e.target.value)}
              aria-invalid={!!errors.webhookPath}
              aria-describedby={errors.webhookPath ? webhookErrorId : undefined}
            />
            {errors.webhookPath ? (
              <small id={webhookErrorId} className="field-error">{errors.webhookPath}</small>
            ) : (
              <small>URL path for the webhook endpoint</small>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="routine-webhook-secret">Webhook Secret (optional)</label>
            <input
              id="routine-webhook-secret"
              type="password"
              placeholder="Optional — leave empty for unauthenticated webhooks"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
            <small>HMAC secret for signature verification. Leave empty for unauthenticated webhooks.</small>
          </div>
        </>
      )}

      {/* API Configuration */}
      {triggerType === "api" && (
        <div className="form-group">
          <label htmlFor="routine-endpoint">API Endpoint</label>
          <input
            id="routine-endpoint"
            type="text"
            placeholder="/api/routine/my-routine"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            aria-invalid={!!errors.endpoint}
            aria-describedby={errors.endpoint ? endpointErrorId : undefined}
          />
          {errors.endpoint ? (
            <small id={endpointErrorId} className="field-error">{errors.endpoint}</small>
          ) : (
            <small>API endpoint path that triggers this routine</small>
          )}
        </div>
      )}

      {/* Manual trigger info */}
      {triggerType === "manual" && (
        <div className="form-group">
          <small className="routine-trigger-info">
            This routine will be triggered manually via the dashboard or API.
          </small>
        </div>
      )}

      <div className="form-group">
        <label>Action Mode</label>
        <div className="schedule-mode-toggle" role="radiogroup" aria-label="Action mode">
          <button
            type="button"
            className={`schedule-mode-btn${actionMode === "simple" ? " active" : ""}`}
            onClick={() => setActionMode("simple")}
            role="radio"
            aria-checked={actionMode === "simple"}
          >
            Simple
          </button>
          <button
            type="button"
            className={`schedule-mode-btn${actionMode === "advanced" ? " active" : ""}`}
            onClick={() => setActionMode("advanced")}
            role="radio"
            aria-checked={actionMode === "advanced"}
          >
            Multi-Step
          </button>
        </div>
        <small>{actionMode === "simple" ? "Run one command, prompt, or task creation action" : "Run multiple actions sequentially"}</small>
      </div>

      {actionMode === "simple" ? (
        <>
          <div className="form-group">
            <label>Action Type</label>
            <div className="schedule-mode-toggle" role="radiogroup" aria-label="Action type">
              <button type="button" className={`schedule-mode-btn${simpleActionType === "command" ? " active" : ""}`} onClick={() => setSimpleActionType("command")} role="radio" aria-checked={simpleActionType === "command"}>Command</button>
              <button type="button" className={`schedule-mode-btn${simpleActionType === "ai-prompt" ? " active" : ""}`} onClick={() => setSimpleActionType("ai-prompt")} role="radio" aria-checked={simpleActionType === "ai-prompt"}>AI Prompt</button>
              <button type="button" className={`schedule-mode-btn${simpleActionType === "create-task" ? " active" : ""}`} onClick={() => setSimpleActionType("create-task")} role="radio" aria-checked={simpleActionType === "create-task"}>Create Task</button>
            </div>
          </div>

          {simpleActionType === "command" ? (
            <div className="form-group">
              <label htmlFor="routine-command">Command</label>
              <input id="routine-command" type="text" placeholder="e.g. npx runfusion.ai backup --create" value={command} onChange={(e) => setCommand(e.target.value)} aria-invalid={!!errors.command} aria-describedby={errors.command ? commandErrorId : undefined} />
              {errors.command ? <small id={commandErrorId} className="field-error">{errors.command}</small> : <small>Shell command to execute.</small>}
            </div>
          ) : simpleActionType === "ai-prompt" ? (
            <>
              <div className="form-group">
                <label htmlFor="routine-prompt">Prompt</label>
                <textarea id="routine-prompt" placeholder="e.g. Summarize recent activity and create action items" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-invalid={!!errors.prompt} aria-describedby={errors.prompt ? promptErrorId : undefined} />
                {errors.prompt ? <small id={promptErrorId} className="field-error">{errors.prompt}</small> : <small>AI prompt to execute.</small>}
              </div>
              <div className="form-group">
                <label htmlFor="routine-model">Model (optional)</label>
                <CustomModelDropdown id="routine-model" label="Model" models={models} value={modelValue} onChange={handleModelChange} placeholder="Use default" disabled={modelsLoading} />
                {modelsError && <small className="field-error">{modelsError}</small>}
                {errors.model && <small id={modelErrorId} className="field-error">{errors.model}</small>}
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="routine-task-title">Task Title (optional)</label>
                <input id="routine-task-title" type="text" placeholder="e.g. Review weekly dependencies" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="routine-task-description">Task Description</label>
                <textarea id="routine-task-description" placeholder="e.g. Check npm dependencies for security vulnerabilities" value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} rows={4} aria-invalid={!!errors.taskDescription} aria-describedby={errors.taskDescription ? taskDescriptionErrorId : undefined} />
                {errors.taskDescription ? <small id={taskDescriptionErrorId} className="field-error">{errors.taskDescription}</small> : <small>Describes the task that will be created.</small>}
              </div>
              <div className="form-group">
                <label htmlFor="routine-task-column">Target Column</label>
                <select id="routine-task-column" value={taskColumn} onChange={(e) => setTaskColumn(e.target.value)}>
                  <option value="triage">Triage</option>
                  <option value="todo">To Do</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="routine-task-model">Executor Model (optional)</label>
                <CustomModelDropdown id="routine-task-model" label="Executor Model" models={models} value={modelValue} onChange={handleModelChange} placeholder="Use default" disabled={modelsLoading} />
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
        <label htmlFor="routine-timeout">Timeout (ms)</label>
        <input id="routine-timeout" type="number" min={1000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} aria-invalid={!!errors.timeoutMs} aria-describedby={errors.timeoutMs ? timeoutErrorId : undefined} />
        {errors.timeoutMs ? <small id={timeoutErrorId} className="field-error">{errors.timeoutMs}</small> : <small>Maximum execution time in milliseconds.</small>}
      </div>

      {/* Execution Policy */}
      <div className="form-group">
        <label htmlFor="routine-execution-policy">Execution Policy</label>
        <select
          id="routine-execution-policy"
          value={executionPolicy}
          onChange={(e) => setExecutionPolicy(e.target.value as RoutineExecutionPolicy)}
        >
          {EXECUTION_POLICY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <small>How to handle concurrent executions of this routine</small>
      </div>

      {/* Catch-up Policy */}
      <div className="form-group">
        <label htmlFor="routine-catchup-policy">Catch-up Policy</label>
        <select
          id="routine-catchup-policy"
          value={catchUpPolicy}
          onChange={(e) => setCatchUpPolicy(e.target.value as RoutineCatchUpPolicy)}
        >
          {CATCH_UP_POLICY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <small>What to do when a scheduled run is missed</small>
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
          Enabled
        </label>
        <small>When disabled, the routine will not run automatically</small>
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={submitting}
        >
          {submitting ? "Saving…" : isEditing ? "Save Changes" : "Create Routine"}
        </button>
      </div>
    </form>
  );
}
