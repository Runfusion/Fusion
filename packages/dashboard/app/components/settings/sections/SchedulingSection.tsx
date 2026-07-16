import { useTranslation } from "react-i18next";
import { MovedSettingsStub } from "./MovedSettingsStub";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
import type { SettingsFormState, SetSettingsForm } from "./context";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AUTO_ARCHIVE_DEFAULT_AFTER_DAYS = 2;
export interface SchedulingSectionProps {
    form: SettingsFormState;
    setForm: SetSettingsForm;
    concurrencyLoading?: boolean;
    onOverlapIgnorePathChange: (index: number, value: string) => void;
    onOpenOverlapPathPicker: (index: number) => void;
    onRemoveOverlapIgnorePath: (index: number) => void;
    onAddOverlapIgnorePath: () => void;
    onOpenWorkflowSettings?: () => void;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
The plain label+control+help rows here render through the shared settings primitives instead of hand-rolled `form-group` + `checkbox-label` + `form-text text-muted` markup, so their labels, help copy, and padding come from the one settings type scale. `.form-group` itself stays untouched and global — 35 non-settings files style forms with it, so settings migrate off it rather than restyle it underneath the rest of the dashboard.

FNXC:SettingsScope 2026-07-15-18:52:
This section is single-scope: every key here is project-scoped (`DEFAULT_PROJECT_SETTINGS`) — concurrency, timeouts, staleness, archiving, and overlap policy all describe one project's scheduling posture.
The machine-wide cap (`globalMaxConcurrent`) moved to SchedulingGlobalSection, and the `ScopeGroupHeader` chrome that used to separate the two authority levels went with it. Mixing scopes in one section meant the answer to "does this affect my other projects?" depended on which subheading you had scrolled past, and a search result landing mid-section shows no subheading at all.
Rows keep their per-row `scope` badge even though the section is now uniformly project-scoped: search can land an operator on a single control with no section chrome in view, so the badge is the only scope signal at that moment.

FNXC:SettingsStyling 2026-07-15-17:35:
The `overlapIgnorePaths` allowlist deliberately keeps its bespoke markup: it is a repeating row editor with per-row Browse/Remove buttons, so no shared row primitive fits. Its help interleaves `t()` fragments with `<code>` elements, which a single-string descriptor `help` cannot express — but SettingsHelpTip takes ReactNode, so that copy now lives behind the shared "?" affordance instead of an inline `<small>`.
*/
export function SchedulingSection({ form, setForm, concurrencyLoading = false, onOverlapIgnorePathChange, onOpenOverlapPathPicker, onRemoveOverlapIgnorePath, onAddOverlapIgnorePath, onOpenWorkflowSettings, }: SchedulingSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.scheduling.scheduling", "Scheduling")}</h4>
      <SettingsNumberRow
        descriptor={{
          key: "maxConcurrent",
          label: t("settings.scheduling.maxConcurrentTasks", "Max Concurrent Tasks"),
          help: t("settings.scheduling.maxConcurrentTasksHint", "Default: 2."),
          scope: "project",
          min: 1,
          max: 10,
          disabled: concurrencyLoading,
        }}
        value={form.maxConcurrent ?? null}
        onChange={(v) => setForm((f) => ({ ...f, maxConcurrent: v ?? undefined } as SettingsFormState))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "maxConcurrentVerifications",
          label: t("settings.scheduling.maxConcurrentVerifications", "Max Concurrent Verifications"),
          help: t("settings.scheduling.maxConcurrentVerificationsHint", "Caps stacked typecheck/build verification across tasks. Default: 1. Range: 1–8."),
          scope: "project",
          min: 1,
          max: 8,
          disabled: concurrencyLoading,
        }}
        value={form.maxConcurrentVerifications ?? null}
        onChange={(v) => {
            if (v === null) {
              setForm((f) => ({ ...f, maxConcurrentVerifications: undefined } as SettingsFormState));
              return;
            }
            // FNXC:VerificationConcurrency 2026-07-15-08:20: Clamp to 1–8 on the form path so UI cannot persist values outside the engine hard cap.
            const n = Math.min(8, Math.max(1, Math.floor(v) || 1));
            setForm((f) => ({ ...f, maxConcurrentVerifications: n } as SettingsFormState));
        }}
      />
      <SettingsNumberRow
        descriptor={{
          key: "maxTriageConcurrent",
          label: t("settings.scheduling.maxTriageConcurrent", "Max Triage Concurrent"),
          help: t("settings.scheduling.maximumConcurrentPlanningAgents", "Maximum concurrent planning agents. Default: 2."),
          scope: "project",
          min: 1,
          max: 10,
          disabled: concurrencyLoading,
        }}
        value={form.maxTriageConcurrent ?? null}
        onChange={(v) => setForm((f) => ({ ...f, maxTriageConcurrent: v ?? undefined } as SettingsFormState))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "pollIntervalMs",
          label: t("settings.scheduling.pollIntervalMs", "Poll Interval (ms)"),
          help: t("settings.scheduling.pollIntervalMsHint", "Default: 15000 (15 seconds)."),
          scope: "project",
          min: 5000,
          step: 1000,
        }}
        value={form.pollIntervalMs ?? null}
        onChange={(v) => setForm((f) => ({ ...f, pollIntervalMs: v ?? undefined } as SettingsFormState))}
      />
      <SettingsSelectRow
        descriptor={{
          key: "heartbeatScopeDiscipline",
          label: t("settings.scheduling.heartbeatScopeDiscipline", "Heartbeat Scope Discipline"),
          help: t("settings.scheduling.strictCoordinationFocusedHigherPerTickTokensLite", "Strict \u2014 coordination-focused; higher per-tick tokens. Lite \u2014 pre-2026-05-11 behavior. Off \u2014 minimal procedure."),
          scope: "project",
          options: [
            { value: "strict", label: t("settings.scheduling.strictDefault", "Strict (default)") },
            { value: "lite", label: t("settings.scheduling.lite", "Lite") },
            { value: "off", label: t("settings.scheduling.off", "Off") },
          ],
        }}
        value={form.heartbeatScopeDiscipline ?? "strict"}
        onChange={(v) => setForm((f) => ({
            ...f,
            heartbeatScopeDiscipline: v as "strict" | "lite" | "off",
        }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "engineerBacklogAutoClaim",
          label: t("settings.scheduling.letEngineerAgentsAutoClaimBacklogTasks", " Let engineer agents auto-claim backlog tasks "),
          help: t("settings.scheduling.backlogNoTaskAutoClaimIsExecutorOnly", "Backlog/no-task auto-claim is executor-only by default. Enable to let engineer-role agents auto-claim unowned backlog tasks; explicit routing and delegation are unchanged. Default: off."),
          scope: "project",
        }}
        value={form.engineerBacklogAutoClaim === true}
        onChange={(v) => setForm((f) => ({ ...f, engineerBacklogAutoClaim: v === true }))}
      />
      {/* FNXC:SettingsScheduling 2026-07-15-17:35: Minutes are a display unit only — the setting persists milliseconds. A non-positive or emptied value stores `undefined` (not 0), so the key is absent from the settings blob and the stuck detector falls back to its schema default rather than treating every task as instantly stuck. */}
      <SettingsNumberRow
        descriptor={{
          key: "taskStuckTimeoutMs",
          label: t("settings.scheduling.stuckTaskTimeoutMinutes", "Stuck Task Timeout (minutes)"),
          help: t("settings.scheduling.timeoutInMinutesForDetectingStuckTasksWhen", "Timeout in minutes for detecting stuck tasks. When a task's agent session shows no activity for longer than this duration, the task is terminated and retried. Leave empty to disable. Suggested: 10. Default: 10 minutes (600000ms)."),
          scope: "project",
          min: 1,
          step: 1,
        }}
        value={form.taskStuckTimeoutMs ? Math.round(form.taskStuckTimeoutMs / 60000) : null}
        onChange={(v) => setForm((f) => ({ ...f, taskStuckTimeoutMs: v !== null && v > 0 ? v * 60000 : undefined }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "buildTimeoutMs",
          label: t("settings.scheduling.buildTimeoutMinutes", "Build/Verification Timeout (minutes)"),
          help: t("settings.scheduling.maximumTimeInMinutesForBuildVerificationCommands", "Maximum time in minutes for build/verification commands before they are killed. Raise for large monorepo or Docker builds. Default: 5."),
          scope: "project",
          min: 1,
          step: 1,
        }}
        value={form.buildTimeoutMs ? Math.round(form.buildTimeoutMs / 60000) : null}
        onChange={(v) => setForm((f) => ({ ...f, buildTimeoutMs: v !== null && v > 0 ? v * 60000 : undefined }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "staleHighFanoutBlockerAgeThresholdMs",
          label: t("settings.scheduling.staleHighFanOutEscalationHours", "Stale High Fan-out Escalation (hours)"),
          help: t("settings.scheduling.escalateHighFanOutBlockersOnlyAfterThey", "Escalate high fan-out blockers only after they remain in in-progress or in-review for this many hours (age source: columnMovedAt, fallback updatedAt). Default: 2 hours."),
          scope: "project",
          min: 1,
          step: 1,
        }}
        value={form.staleHighFanoutBlockerAgeThresholdMs ? Math.round(form.staleHighFanoutBlockerAgeThresholdMs / 3600000) : null}
        onChange={(v) => setForm((f) => ({
            ...f,
            staleHighFanoutBlockerAgeThresholdMs: v !== null && v > 0 ? v * 3600000 : undefined,
        }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "preserveProgressOnStuckRequeue",
          label: t("settings.scheduling.preserveStepProgressOnStuckTaskRequeue", " Preserve step progress on stuck-task requeue "),
          help: t("settings.scheduling.whenTheStuckDetectorKillsAndReQueues", "When the stuck detector kills and re-queues a task, keep completed step statuses so the agent can resume from where it left off. Disable to reset every step to pending on each stuck retry. Default: enabled."),
          scope: "project",
        }}
        value={form.preserveProgressOnStuckRequeue !== false}
        onChange={(v) => setForm((f) => ({ ...f, preserveProgressOnStuckRequeue: v === true }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "specStalenessEnabled",
          label: t("settings.scheduling.enablePlanStalenessEnforcement", " Enable plan staleness enforcement "),
          help: t("settings.scheduling.whenEnabledTasksWithStalePlansPROMPTMd", "When enabled, tasks with stale plans (PROMPT.md older than the threshold) are automatically sent back to planning for replanning. Default: disabled."),
          scope: "project",
        }}
        value={form.specStalenessEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, specStalenessEnabled: v === true }))}
      />
      {/* FNXC:SettingsScheduling 2026-07-15-17:35: The threshold is gated on its own enforcement toggle and disabled rather than hidden, so an operator turning staleness on can see the age that will take effect. Unlike the timeouts above, an explicit 0 is preserved (immediate staleness) — only an emptied field stores `undefined`. */}
      <SettingsNumberRow
        descriptor={{
          key: "specStalenessMaxAgeMs",
          label: t("settings.scheduling.staleSpecThresholdHours", "Stale Spec Threshold (hours)"),
          help: t("settings.scheduling.maximumAgeInHoursBeforeAPlanIs", "Maximum age in hours before a plan is considered stale. Default: 6 hours."),
          scope: "project",
          min: 0,
          step: 1,
          disabled: !form.specStalenessEnabled,
        }}
        value={form.specStalenessMaxAgeMs !== undefined ? Math.round(form.specStalenessMaxAgeMs / 3600000) : null}
        onChange={(v) => setForm((f) => ({ ...f, specStalenessMaxAgeMs: v !== null ? v * 3600000 : undefined }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "autoArchiveDoneTasksEnabled",
          label: t("settings.scheduling.enableAutomaticTaskArchiving", " Enable automatic task archiving "),
          help: t("settings.scheduling.completedTasksOlderThanTheThresholdAreMoved", "Completed tasks older than the threshold are moved out of the active task database. Default: enabled."),
          scope: "project",
        }}
        value={form.autoArchiveDoneTasksEnabled ?? true}
        onChange={(v) => setForm((f) => ({
            ...f,
            autoArchiveDoneTasksEnabled: v === true,
        }))}
      />
      {/* FNXC:SettingsScheduling 2026-07-15-17:35: The threshold and log mode are gated on the archiving toggle and disabled rather than hidden, so an operator turning archiving on can see the values that will take effect. An unset threshold displays the schema default (2 days) rather than an empty field, because archiving is on by default and a blank box would misread as "never". */}
      <SettingsNumberRow
        descriptor={{
          key: "autoArchiveDoneAfterMs",
          label: t("settings.scheduling.archiveCompletedTasksAfterDays", "Archive Completed Tasks After (days)"),
          help: t("settings.scheduling.numberOfDaysATaskCanStayIn", "Number of days a task can stay in Done before it is archived. Default: 2 days (48 hours)."),
          scope: "project",
          min: 1,
          step: 1,
          disabled: form.autoArchiveDoneTasksEnabled === false,
        }}
        value={form.autoArchiveDoneAfterMs !== undefined ? Math.round(form.autoArchiveDoneAfterMs / MS_PER_DAY) : AUTO_ARCHIVE_DEFAULT_AFTER_DAYS}
        onChange={(v) => setForm((f) => ({
            ...f,
            autoArchiveDoneAfterMs: v === null ? undefined : v * MS_PER_DAY,
        }))}
      />
      <SettingsSelectRow
        descriptor={{
          key: "archiveAgentLogMode",
          label: t("settings.scheduling.archiveAgentLog", "Archive Agent Log"),
          help: t("settings.scheduling.compactModeKeepsArchiveSizeLowWhilePreserving", "Compact mode keeps archive size low while preserving recent agent activity for context. Default: compact."),
          scope: "project",
          disabled: form.autoArchiveDoneTasksEnabled === false,
          options: [
            { value: "compact", label: t("settings.scheduling.compactSummaryAndRecentEntries", "Compact summary and recent entries") },
            { value: "none", label: t("settings.scheduling.doNotArchiveAgentLogs", "Do not archive agent logs") },
            { value: "full", label: t("settings.scheduling.fullAgentLog", "Full agent log") },
          ],
        }}
        value={form.archiveAgentLogMode ?? "compact"}
        onChange={(v) => setForm((f) => ({
            ...f,
            archiveAgentLogMode: v as "none" | "compact" | "full",
        }))}
      />
      {/**
       * FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658):
       * Operators do not want same-agent duplicate tasks (FN-4892 intake heuristic)
       * silently archived on creation — they want visibility and a chance to decide
       * via the near-duplicate flag/UI. Default off; this toggle restores the old
       * aggressive auto-archive behavior when enabled.
       */}
      <SettingsToggleRow
        descriptor={{
          key: "autoArchiveDuplicateTasksEnabled",
          label: t("settings.scheduling.autoArchiveDuplicateTasks", " Automatically archive duplicate tasks "),
          help: t("settings.scheduling.autoArchiveDuplicateTasksHelp", "Automatically archive tasks detected as same-agent duplicates on creation (off by default). When disabled, duplicates are flagged in place with the yellow Duplicate chip and Keep/Archive actions instead of being archived automatically."),
          scope: "project",
        }}
        value={form.autoArchiveDuplicateTasksEnabled ?? false}
        onChange={(v) => setForm((f) => ({
            ...f,
            autoArchiveDuplicateTasksEnabled: v === true,
        }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "maxStuckKills",
          label: t("settings.scheduling.maxStuckRetries", "Max Stuck Retries"),
          help: t("settings.scheduling.maximumStuckDetectorRetriesBeforeATaskIs", "Maximum stuck-detector retries before a task is marked failed. Default: 6."),
          scope: "project",
          min: 1,
          step: 1,
        }}
        value={form.maxStuckKills ?? null}
        onChange={(v) => setForm((f) => ({ ...f, maxStuckKills: v !== null && v > 0 ? v : undefined }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "groupOverlappingFiles",
          label: t("settings.scheduling.serializeTasksWithOverlappingFiles", " Serialize tasks with overlapping files "),
          help: t("settings.scheduling.whenEnabledTasksThatModifyTheSameFiles", "When enabled, tasks that modify the same files are queued serially to avoid merge conflicts. Default: enabled."),
          scope: "project",
        }}
        value={form.groupOverlappingFiles}
        onChange={(v) => setForm((f) => ({ ...f, groupOverlappingFiles: v === true }))}
      />

      {/**
       * FNXC:SettingsScheduling 2026-06-23-13:22:
       * Operators need a Scheduling toggle that defaults on for ignoring hidden dot paths in overlap checks while preserving the selected value independently of overlap serialization being enabled.
       */}
      <SettingsToggleRow
        descriptor={{
          key: "ignoreHiddenOverlapPaths",
          label: t("settings.scheduling.ignoreHiddenDotPathsInOverlapChecks", " Ignore hidden dot paths in overlap checks "),
          help: t("settings.scheduling.ignoreHiddenDotPathsHelp", "When enabled, overlap checks ignore hidden path segments such as .fusion/, .changeset/, .github/, .env, and nested .cache/ directories. Uncheck to restore legacy counting for stricter serialization. Default: enabled."),
          scope: "project",
        }}
        value={form.ignoreHiddenOverlapPaths !== false}
        onChange={(v) => setForm((f) => ({ ...f, ignoreHiddenOverlapPaths: v === true }))}
      />

      <div className="form-group settings-overlap-ignore-group">
        {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance \u2014 operator requirement: no inline description paragraphs in Settings. The tip is a SIBLING of the label (a button inside a label is invalid), wrapped with it in `.settings-field-label-row`; the `<code>` fragments ride along verbatim because SettingsHelpTip takes ReactNode. */}
        <div className="settings-field-label-row">
          <label>{t("settings.scheduling.ignoredOverlapPaths", "Ignored overlap paths")}</label>
          <SettingsHelpTip settingKey="overlapIgnorePaths">{t("settings.scheduling.optionalFileOrDirectoryPathsToIgnoreWhen", " No default \u2014 unset (empty). Optional file or directory paths to ignore when overlap serialization is enabled. Paths are project-relative (for example ")}<code>docs/</code>{t("settings.scheduling.or", " or ")}<code>generated/*</code>{t("settings.scheduling.closeParenPeriod", ").")}</SettingsHelpTip>
        </div>
        <div className="settings-overlap-ignore-list">
          {(form.overlapIgnorePaths && form.overlapIgnorePaths.length > 0 ? form.overlapIgnorePaths : [""]).map((path, index) => (<div key={`overlap-ignore-${index}`} className="settings-overlap-ignore-row">
              <div className="settings-overlap-ignore-path-controls">
                {/*
                FNXC:SettingsStyling 2026-07-15-18:52:
                Carries `.input` even though this row stays bespoke. Without a class it was a bare input inside `.form-group`, which styles its children `8px 12px` at 14px — while every other settings control (`.input`, and the shared row primitives that now name it) renders `6px 10px` at 13px. It was the one visibly mismatched text field left in Settings.
                The global `.form-group input` rule is deliberately not touched: 35 non-settings files depend on it. Naming the standard class on this input is the settings-local fix.
                */}
                <input className="input" type="text" value={path} placeholder={t("settings.scheduling.docs", "docs/")} onChange={(e) => onOverlapIgnorePathChange(index, e.target.value)}/>
                <button type="button" className="btn btn-sm" onClick={() => onOpenOverlapPathPicker(index)} aria-label={`Browse path for ignored overlap entry ${index + 1}`}>{t("settings.scheduling.browse", " Browse ")}</button>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => onRemoveOverlapIgnorePath(index)} disabled={(form.overlapIgnorePaths ?? []).length === 0 && index === 0}>{t("settings.scheduling.remove", " Remove ")}</button>
            </div>))}
        </div>
        <button type="button" className="btn btn-sm" onClick={onAddOverlapIgnorePath}>{t("settings.scheduling.addIgnoredPath", " Add ignored path ")}</button>
      </div>

      <div className="settings-section-divider"/>

      <h5 className="settings-section-heading">{t("settings.scheduling.stepExecution", "Step Execution")}</h5>
      <MovedSettingsStub message={t("settings.movedStub.stepExecution", "Step execution settings (run steps in new sessions, max parallel steps) now live on the workflow.")} onOpenWorkflowSettings={onOpenWorkflowSettings}/>
    </>);
}
export default SchedulingSection;
