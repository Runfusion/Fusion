/**
 * Scheduling section (U9 / KTD-10).
 *
 * Project-scoped scheduling/capacity knobs: global + per-project concurrency,
 * poll interval, heartbeat discipline, stuck/stale detection, plan staleness,
 * auto-archive, overlap serialization with the ignored-paths editor, plus the
 * step-execution redirect stub (settings moved to the workflow, U4). The global
 * concurrency value is shell state (it persists via a separate API and is
 * dirty-tracked) and is relayed through props; the overlap-path editor handlers
 * also live in the shell (they share the file-browser hook). The day/archive
 * constants are co-located. Keys, unit conversions, and conditional disabling
 * are preserved verbatim from the original inline JSX.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MovedSettingsStub } from "./MovedSettingsStub";
import type { SettingsFormState, SetSettingsForm } from "./context";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AUTO_ARCHIVE_DEFAULT_AFTER_DAYS = 2;

export interface SchedulingSectionProps {
  scopeBanner: ReactNode;
  form: SettingsFormState;
  setForm: SetSettingsForm;
  globalMaxConcurrent: number | undefined;
  onGlobalMaxConcurrentChange: (value: number | undefined) => void;
  onOverlapIgnorePathChange: (index: number, value: string) => void;
  onOpenOverlapPathPicker: (index: number) => void;
  onRemoveOverlapIgnorePath: (index: number) => void;
  onAddOverlapIgnorePath: () => void;
  onOpenWorkflowSettings?: () => void;
}

export function SchedulingSection({
  scopeBanner,
  form,
  setForm,
  globalMaxConcurrent,
  onGlobalMaxConcurrentChange,
  onOverlapIgnorePathChange,
  onOpenOverlapPathPicker,
  onRemoveOverlapIgnorePath,
  onAddOverlapIgnorePath,
  onOpenWorkflowSettings,
}: SchedulingSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Scheduling</h4>
      <div className="form-group">
        <label htmlFor="globalMaxConcurrent">Global Max Concurrent</label>
        <input
          id="globalMaxConcurrent"
          type="number"
          min={0}
          max={10000}
          value={globalMaxConcurrent ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            onGlobalMaxConcurrentChange(val === "" ? undefined : Number(val));
          }}
        />
        <small className="form-text text-muted">Maximum concurrent agents across all projects</small>
      </div>
      <div className="form-group">
        <label htmlFor="maxConcurrent">Max Concurrent Tasks</label>
        <input
          id="maxConcurrent"
          type="number"
          min={1}
          max={10}
          value={form.maxConcurrent ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, maxConcurrent: val === "" ? undefined : Number(val) } as SettingsFormState));
          }}
        />
      </div>
      <div className="form-group">
        <label htmlFor="maxTriageConcurrent">Max Triage Concurrent</label>
        <input
          id="maxTriageConcurrent"
          type="number"
          min={1}
          max={10}
          value={form.maxTriageConcurrent ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, maxTriageConcurrent: val === "" ? undefined : Number(val) } as SettingsFormState));
          }}
        />
        <small>Maximum concurrent planning agents</small>
      </div>
      <div className="form-group">
        <label htmlFor="pollIntervalMs">Poll Interval (ms)</label>
        <input
          id="pollIntervalMs"
          type="number"
          min={5000}
          step={1000}
          value={form.pollIntervalMs ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, pollIntervalMs: val === "" ? undefined : Number(val) } as SettingsFormState));
          }}
        />
      </div>
      <div className="form-group">
        <label htmlFor="heartbeatScopeDiscipline">Heartbeat Scope Discipline</label>
        <select
          id="heartbeatScopeDiscipline"
          className="select"
          value={form.heartbeatScopeDiscipline ?? "strict"}
          onChange={(e) => {
            setForm((f) => ({
              ...f,
              heartbeatScopeDiscipline: e.target.value as "strict" | "lite" | "off",
            }));
          }}
        >
          <option value="strict">Strict (default)</option>
          <option value="lite">Lite</option>
          <option value="off">Off</option>
        </select>
        <small>Strict — coordination-focused; higher per-tick tokens. Lite — pre-2026-05-11 behavior. Off — minimal procedure.</small>
      </div>
      <div className="form-group">
        <label htmlFor="taskStuckTimeoutMs">Stuck Task Timeout (minutes)</label>
        <input
          id="taskStuckTimeoutMs"
          type="number"
          min={1}
          step={1}
          value={form.taskStuckTimeoutMs ? Math.round(form.taskStuckTimeoutMs / 60000) : ""}
          onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, taskStuckTimeoutMs: val && num > 0 ? num * 60000 : undefined }));
          }}
        />
        <small>Timeout in minutes for detecting stuck tasks. When a task&apos;s agent session shows no activity for longer than this duration, the task is terminated and retried. Leave empty to disable. Suggested: 10.</small>
      </div>
      <div className="form-group">
        <label htmlFor="staleHighFanoutBlockerAgeThresholdMs">Stale High Fan-out Escalation (hours)</label>
        <input
          id="staleHighFanoutBlockerAgeThresholdMs"
          type="number"
          min={1}
          step={1}
          value={form.staleHighFanoutBlockerAgeThresholdMs ? Math.round(form.staleHighFanoutBlockerAgeThresholdMs / 3600000) : ""}
          onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({
              ...f,
              staleHighFanoutBlockerAgeThresholdMs: val && num > 0 ? num * 3600000 : undefined,
            }));
          }}
        />
        <small>Escalate high fan-out blockers only after they remain in in-progress or in-review for this many hours (age source: columnMovedAt, fallback updatedAt). Default: 2 hours.</small>
      </div>
      <div className="form-group">
        <label htmlFor="preserveProgressOnStuckRequeue" className="checkbox-label">
          <input
            id="preserveProgressOnStuckRequeue"
            type="checkbox"
            checked={form.preserveProgressOnStuckRequeue !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, preserveProgressOnStuckRequeue: e.target.checked }))
            }
          />
          Preserve step progress on stuck-task requeue
        </label>
        <small>When the stuck detector kills and re-queues a task, keep completed step statuses so the agent can resume from where it left off. Disable to reset every step to pending on each stuck retry. Default: enabled.</small>
      </div>
      <div className="form-group">
        <label htmlFor="specStalenessEnabled" className="checkbox-label">
          <input
            id="specStalenessEnabled"
            type="checkbox"
            checked={form.specStalenessEnabled || false}
            onChange={(e) =>
              setForm((f) => ({ ...f, specStalenessEnabled: e.target.checked }))
            }
          />
          Enable plan staleness enforcement
        </label>
        <small>When enabled, tasks with stale plans (PROMPT.md older than the threshold) are automatically sent back to planning for replanning</small>
      </div>
      <div className="form-group">
        <label htmlFor="specStalenessMaxAgeMs">Stale Spec Threshold (hours)</label>
        <input
          id="specStalenessMaxAgeMs"
          type="number"
          min={0}
          step={1}
          value={form.specStalenessMaxAgeMs !== undefined ? Math.round(form.specStalenessMaxAgeMs / 3600000) : ""}
          onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, specStalenessMaxAgeMs: val !== "" ? num * 3600000 : undefined }));
          }}
          disabled={!form.specStalenessEnabled}
        />
        <small>Maximum age in hours before a plan is considered stale. Default: 6 hours.</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoArchiveDoneTasksEnabled" className="checkbox-label">
          <input
            id="autoArchiveDoneTasksEnabled"
            type="checkbox"
            checked={form.autoArchiveDoneTasksEnabled ?? true}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                autoArchiveDoneTasksEnabled: e.target.checked,
              }))
            }
          />
          Enable automatic task archiving
        </label>
        <small>Completed tasks older than the threshold are moved out of the active task database.</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoArchiveDoneAfterMs">Archive Completed Tasks After (days)</label>
        <input
          id="autoArchiveDoneAfterMs"
          type="number"
          min={1}
          step={1}
          value={form.autoArchiveDoneAfterMs !== undefined ? Math.round(form.autoArchiveDoneAfterMs / MS_PER_DAY) : AUTO_ARCHIVE_DEFAULT_AFTER_DAYS}
          onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({
              ...f,
              autoArchiveDoneAfterMs: val === "" ? undefined : num * MS_PER_DAY,
            }));
          }}
          disabled={form.autoArchiveDoneTasksEnabled === false}
        />
        <small>Number of days a task can stay in Done before it is archived. Default: 2 days (48 hours).</small>
      </div>
      <div className="form-group">
        <label htmlFor="archiveAgentLogMode">Archive Agent Log</label>
        <select
          id="archiveAgentLogMode"
          value={form.archiveAgentLogMode ?? "compact"}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              archiveAgentLogMode: e.target.value as "none" | "compact" | "full",
            }))
          }
          disabled={form.autoArchiveDoneTasksEnabled === false}
        >
          <option value="compact">Compact summary and recent entries</option>
          <option value="none">Do not archive agent logs</option>
          <option value="full">Full agent log</option>
        </select>
        <small>Compact mode keeps archive size low while preserving recent agent activity for context.</small>
      </div>
      <div className="form-group">
        <label htmlFor="maxStuckKills">Max Stuck Retries</label>
        <input
          id="maxStuckKills"
          type="number"
          min={1}
          step={1}
          value={form.maxStuckKills ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, maxStuckKills: val && num > 0 ? num : undefined }));
          }}
        />
        <small>Maximum stuck-detector retries before a task is marked failed. Default: 6.</small>
      </div>
      <div className="form-group">
        <label htmlFor="groupOverlappingFiles" className="checkbox-label">
          <input
            id="groupOverlappingFiles"
            type="checkbox"
            checked={form.groupOverlappingFiles}
            onChange={(e) =>
              setForm((f) => ({ ...f, groupOverlappingFiles: e.target.checked }))
            }
          />
          Serialize tasks with overlapping files
        </label>
        <small>When enabled, tasks that modify the same files are queued serially to avoid merge conflicts</small>
      </div>

      <div className="form-group settings-overlap-ignore-group">
        <label>Ignored overlap paths</label>
        <small>
          Optional file or directory paths to ignore when overlap serialization is enabled.
          Paths are project-relative (for example <code>docs/</code> or <code>generated/*</code>).
        </small>
        <div className="settings-overlap-ignore-list">
          {(form.overlapIgnorePaths && form.overlapIgnorePaths.length > 0 ? form.overlapIgnorePaths : [""]).map((path, index) => (
            <div key={`overlap-ignore-${index}`} className="settings-overlap-ignore-row">
              <div className="settings-overlap-ignore-path-controls">
                <input
                  type="text"
                  value={path}
                  placeholder="docs/"
                  onChange={(e) => onOverlapIgnorePathChange(index, e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onOpenOverlapPathPicker(index)}
                  aria-label={`Browse path for ignored overlap entry ${index + 1}`}
                >
                  Browse
                </button>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onRemoveOverlapIgnorePath(index)}
                disabled={(form.overlapIgnorePaths ?? []).length === 0 && index === 0}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onAddOverlapIgnorePath}
        >
          Add ignored path
        </button>
      </div>

      <div className="settings-section-divider" />

      <h5 className="settings-section-heading">Step Execution</h5>
      <MovedSettingsStub
        message={t(
          "settings.movedStub.stepExecution",
          "Step execution settings (run steps in new sessions, max parallel steps) now live on the workflow.",
        )}
        onOpenWorkflowSettings={onOpenWorkflowSettings}
      />
    </>
  );
}

export default SchedulingSection;
