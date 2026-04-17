import { useState, useCallback } from "react";
import { Calendar, Webhook, Code, Zap, Globe, Folder } from "lucide-react";
import type {
  Routine,
  RoutineCreateInput,
  RoutineUpdateInput,
  RoutineTrigger,
  RoutineTriggerType,
  RoutineCronTrigger,
  RoutineWebhookTrigger,
  RoutineApiTrigger,
  RoutineManualTrigger,
  RoutineCatchUpPolicy,
  RoutineExecutionPolicy,
} from "@fusion/core";

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

const TRIGGER_TYPE_LABELS: Record<RoutineTriggerType, string> = {
  cron: "Cron Schedule",
  webhook: "Webhook",
  api: "API",
  manual: "Manual",
};

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
}

export function RoutineEditor({ routine, onSubmit, onCancel, scope: formScope, projectId }: RoutineEditorProps) {
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

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = useCallback((): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name is required";
    
    // Scope validation: project scope requires projectId
    if (formScope === "project" && !projectId) {
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
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, triggerType, cronExpression, cronPreset, webhookPath, endpoint, formScope, projectId]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!validate()) return;
      setSubmitting(true);
      try {
        // Determine scope: use edit mode's existing scope, otherwise use formScope prop
        // When formScope is "project" but no projectId provided, fall back to "global"
        let effectiveScope = routine?.scope ?? formScope ?? (projectId ? "project" : "global");
        if (effectiveScope === "project" && !projectId) {
          effectiveScope = "global";
        }
        
        const trigger = buildTrigger(triggerType, cronExpression, webhookPath, webhookSecret, endpoint);
        const input: RoutineCreateInput = {
          name: name.trim(),
          agentId: routine?.agentId ?? "",
          description: description.trim() || undefined,
          trigger,
          executionPolicy,
          catchUpPolicy,
          enabled,
          scope: effectiveScope,
        };
        await onSubmit(input);
      } finally {
        setSubmitting(false);
      }
    },
    [validate, onSubmit, name, description, triggerType, cronExpression, webhookPath, webhookSecret, endpoint, executionPolicy, catchUpPolicy, enabled, formScope, projectId, routine?.scope],
  );

  const nameErrorId = "routine-name-error";
  const cronErrorId = "routine-cron-error";
  const webhookErrorId = "routine-webhook-error";
  const endpointErrorId = "routine-endpoint-error";

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
            className={`routine-scope-btn${(!formScope || formScope === 'global') ? " active" : ""}`}
            role="radio"
            aria-checked={(!formScope || formScope === 'global') ? "true" : "false"}
            disabled={!!routine?.scope}
            title={routine?.scope ? `Scope is locked to ${routine.scope} for existing routines` : "Global scope"}
          >
            <Globe size={12} />
            Global
          </button>
          <button
            type="button"
            className={`routine-scope-btn${formScope === 'project' ? " active" : ""}`}
            role="radio"
            aria-checked={formScope === 'project' ? "true" : "false"}
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
            : formScope === "project" && projectId
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
