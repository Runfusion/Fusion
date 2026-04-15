import { useState, useCallback, useEffect } from "react";
import type { ScheduledTask, ScheduledTaskCreateInput, ScheduleType, AutomationStep } from "@fusion/core";
import { ScheduleStepsEditor } from "./ScheduleStepsEditor";

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

const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  hourly: "Every hour",
  daily: "Every day (midnight)",
  weekly: "Every week (Monday)",
  monthly: "Every month (1st)",
  custom: "Custom cron expression",
  every15Minutes: "Every 15 minutes",
  every30Minutes: "Every 30 minutes",
  every2Hours: "Every 2 hours",
  every6Hours: "Every 6 hours",
  every12Hours: "Every 12 hours",
  weekdays: "Weekdays at 9 AM (Mon-Fri)",
};

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

type ScheduleMode = "simple" | "advanced";

interface ScheduleFormProps {
  /** Existing schedule for editing. Omit for create mode. */
  schedule?: ScheduledTask;
  /** Called with form data on submit. */
  onSubmit: (input: ScheduledTaskCreateInput) => Promise<void>;
  /** Called when the user cancels. */
  onCancel: () => void;
}

export function ScheduleForm({ schedule, onSubmit, onCancel }: ScheduleFormProps) {
  const isEditing = !!schedule;

  // Determine initial mode based on whether the schedule has steps
  const initialMode: ScheduleMode = schedule?.steps && schedule.steps.length > 0 ? "advanced" : "simple";

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

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Auto-fill cron expression when preset is selected
  useEffect(() => {
    if (scheduleType !== "custom") {
      setCronExpression(PRESET_CRON[scheduleType]);
    }
  }, [scheduleType]);

  const validate = useCallback((): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name is required";
    if (mode === "simple" && !command.trim()) e.command = "Command is required";
    if (mode === "advanced" && steps.length === 0) e.steps = "At least one step is required";
    
    // Validate step content in multi-step mode
    if (mode === "advanced" && steps.length > 0) {
      const incompleteSteps: string[] = [];
      
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step.name?.trim()) {
          incompleteSteps.push(`Step ${i + 1}: Name is required`);
        }
        if (step.type === "command" && !step.command?.trim()) {
          incompleteSteps.push(`Step ${i + 1}: Command is required`);
        }
        if (step.type === "ai-prompt" && !step.prompt?.trim()) {
          incompleteSteps.push(`Step ${i + 1}: Prompt is required`);
        }
      }
      
      if (incompleteSteps.length > 0) {
        e.steps = incompleteSteps.join("; ");
      }
      
      // Check if any steps are currently being edited
      if (hasEditingSteps) {
        e.stepsEditing = "Please save or cancel all step edits before saving the schedule";
      }
    }
    
    if (scheduleType === "custom") {
      if (!cronExpression.trim()) {
        e.cronExpression = "Cron expression is required for custom schedules";
      } else if (!isLikelyCron(cronExpression)) {
        e.cronExpression = "Invalid cron format — expected 5 fields (e.g. '0 */6 * * *')";
      }
    }
    if (timeoutMs < 1000) {
      e.timeoutMs = "Timeout must be at least 1 second (1000ms)";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, command, mode, steps, scheduleType, cronExpression, timeoutMs, hasEditingSteps]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!validate()) return;
      setSubmitting(true);
      try {
        await onSubmit({
          name: name.trim(),
          description: description.trim() || undefined,
          scheduleType,
          cronExpression: scheduleType === "custom" ? cronExpression.trim() : undefined,
          command: mode === "simple" ? command.trim() : "",
          enabled,
          timeoutMs,
          steps: mode === "advanced" ? steps : undefined,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [validate, onSubmit, name, description, scheduleType, cronExpression, command, enabled, timeoutMs, mode, steps],
  );

  const cronFieldId = "schedule-cron";
  const cronErrorId = "schedule-cron-error";
  const nameErrorId = "schedule-name-error";
  const commandErrorId = "schedule-command-error";
  const timeoutErrorId = "schedule-timeout-error";

  return (
    <form className="schedule-form" onSubmit={handleSubmit} noValidate>
      <h4 className="settings-section-heading">
        {isEditing ? "Edit Schedule" : "New Schedule"}
      </h4>

      <div className="form-group">
        <label htmlFor="schedule-name">Name</label>
        <input
          id="schedule-name"
          type="text"
          placeholder="e.g. Update dependencies"
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
        <label htmlFor="schedule-description">Description (optional)</label>
        <textarea
          id="schedule-description"
          placeholder="What does this schedule do?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      <div className="form-group">
        <label htmlFor="schedule-type">Schedule</label>
        <select
          id="schedule-type"
          value={scheduleType}
          onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
        >
          {Object.entries(SCHEDULE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label htmlFor={cronFieldId}>
          Cron Expression
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
              <>min hour day month weekday — <a href="https://crontab.guru" target="_blank" rel="noopener noreferrer">crontab.guru</a></>
            ) : (
              `Auto-filled from preset: ${cronExpression}`
            )}
          </small>
        )}
      </div>

      {/* Mode switcher */}
      <div className="form-group">
        <label>Execution Mode</label>
        <div className="schedule-mode-toggle" role="radiogroup" aria-label="Execution mode">
          <button
            type="button"
            className={`schedule-mode-btn${mode === "simple" ? " active" : ""}`}
            onClick={() => setMode("simple")}
            role="radio"
            aria-checked={mode === "simple"}
          >
            Simple
          </button>
          <button
            type="button"
            className={`schedule-mode-btn${mode === "advanced" ? " active" : ""}`}
            onClick={() => setMode("advanced")}
            role="radio"
            aria-checked={mode === "advanced"}
          >
            Multi-Step
          </button>
        </div>
        <small>
          {mode === "simple"
            ? "Run a single shell command"
            : "Run multiple steps sequentially (commands and AI prompts)"}
        </small>
      </div>

      {mode === "simple" ? (
        <div className="form-group">
          <label htmlFor="schedule-command">Command</label>
          <input
            id="schedule-command"
            type="text"
            placeholder="e.g. npm run update-deps"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            aria-invalid={!!errors.command}
            aria-describedby={errors.command ? commandErrorId : undefined}
          />
          {errors.command ? (
            <small id={commandErrorId} className="field-error">{errors.command}</small>
          ) : (
            <small>Shell command to execute. Runs with your user permissions.</small>
          )}
        </div>
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
        <label htmlFor="schedule-timeout">Timeout (ms)</label>
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
          <small>Maximum execution time in milliseconds (default 300000 = 5 min)</small>
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
          Enabled
        </label>
        <small>When disabled, the schedule will not run automatically</small>
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
          {submitting ? "Saving…" : isEditing ? "Save Changes" : "Create Schedule"}
        </button>
      </div>
    </form>
  );
}
