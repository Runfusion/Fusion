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
    concurrencyLoading?: boolean;
    onGlobalMaxConcurrentChange: (value: number | undefined) => void;
    onOverlapIgnorePathChange: (index: number, value: string) => void;
    onOpenOverlapPathPicker: (index: number) => void;
    onRemoveOverlapIgnorePath: (index: number) => void;
    onAddOverlapIgnorePath: () => void;
    onOpenWorkflowSettings?: () => void;
}
/*
FNXC:SettingsScopeGrouping 2026-06-25-10:42:
Mobile settings must make clear which controls are global (all projects) vs project-scoped; group scheduling fields under labeled Global/This-project subheadings with a scope badge so operators don't mistake the global concurrency cap for a per-project setting.
*/
interface ScopeGroupHeaderProps {
    title: string;
    caption: string;
    badgeLabel: string;
    scope: "global" | "project";
}
function ScopeGroupHeader({ title, caption, badgeLabel, scope }: ScopeGroupHeaderProps) {
    return (<div className="settings-scope-group">
      <div className="settings-scope-group-header">
        <h5 className="settings-section-heading">{title}</h5>
        <span className={`settings-scope-badge settings-scope-badge--${scope}`}>{badgeLabel}</span>
      </div>
      <small className="settings-scope-caption">{caption}</small>
    </div>);
}
export function SchedulingSection({ scopeBanner, form, setForm, globalMaxConcurrent, concurrencyLoading = false, onGlobalMaxConcurrentChange, onOverlapIgnorePathChange, onOpenOverlapPathPicker, onRemoveOverlapIgnorePath, onAddOverlapIgnorePath, onOpenWorkflowSettings, }: SchedulingSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.scheduling.scheduling", "Scheduling")}</h4>
      {/*
      FNXC:SettingsConcurrency 2026-06-22-20:18:
      Concurrency inputs represent live project/global limits. Keep them disabled while their actual values are still loading so users cannot edit a blank fallback and accidentally overwrite the resolved limits.
      */}
      <ScopeGroupHeader scope="global" title={t("settings.scheduling.scopeGlobalTitle", "Global — applies to all projects")} caption={t("settings.scheduling.scopeGlobalCaption", "Shared by every project on this machine.")} badgeLabel={t("settings.scheduling.scopeBadgeGlobal", "Global")}/>
      <div className="form-group">
        <label htmlFor="globalMaxConcurrent">{t("settings.scheduling.globalMaxConcurrent", "Global Max Concurrent")}</label>
        <input id="globalMaxConcurrent" type="number" min={0} max={10000} disabled={concurrencyLoading} value={globalMaxConcurrent ?? ""} onChange={(e) => {
            const val = e.target.value;
            onGlobalMaxConcurrentChange(val === "" ? undefined : Number(val));
        }}/>
        <small className="form-text text-muted">{t("settings.scheduling.maximumConcurrentAgentsAcrossAllProjects", "Maximum concurrent agents across all projects. Default: 4.")}</small>
      </div>
      <div className="settings-section-divider"/>
      <ScopeGroupHeader scope="project" title={t("settings.scheduling.scopeProjectTitle", "This project")} caption={t("settings.scheduling.scopeProjectCaption", "Only affects the currently selected project.")} badgeLabel={t("settings.scheduling.scopeBadgeProject", "Project")}/>
      <div className="form-group">
        <label htmlFor="maxConcurrent">{t("settings.scheduling.maxConcurrentTasks", "Max Concurrent Tasks")}</label>
        <input id="maxConcurrent" type="number" min={1} max={10} disabled={concurrencyLoading} value={form.maxConcurrent ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, maxConcurrent: val === "" ? undefined : Number(val) } as SettingsFormState));
        }}/>
        <small>{t("settings.scheduling.maxConcurrentTasksHint", "Default: 2.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="maxTriageConcurrent">{t("settings.scheduling.maxTriageConcurrent", "Max Triage Concurrent")}</label>
        <input id="maxTriageConcurrent" type="number" min={1} max={10} disabled={concurrencyLoading} value={form.maxTriageConcurrent ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, maxTriageConcurrent: val === "" ? undefined : Number(val) } as SettingsFormState));
        }}/>
        <small>{t("settings.scheduling.maximumConcurrentPlanningAgents", "Maximum concurrent planning agents. Default: 2.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="pollIntervalMs">{t("settings.scheduling.pollIntervalMs", "Poll Interval (ms)")}</label>
        <input id="pollIntervalMs" type="number" min={5000} step={1000} value={form.pollIntervalMs ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, pollIntervalMs: val === "" ? undefined : Number(val) } as SettingsFormState));
        }}/>
        <small>{t("settings.scheduling.pollIntervalMsHint", "Default: 15000 (15 seconds).")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="heartbeatScopeDiscipline">{t("settings.scheduling.heartbeatScopeDiscipline", "Heartbeat Scope Discipline")}</label>
        <select id="heartbeatScopeDiscipline" className="select" value={form.heartbeatScopeDiscipline ?? "strict"} onChange={(e) => {
            setForm((f) => ({
                ...f,
                heartbeatScopeDiscipline: e.target.value as "strict" | "lite" | "off",
            }));
        }}>
          <option value="strict">{t("settings.scheduling.strictDefault", "Strict (default)")}</option>
          <option value="lite">{t("settings.scheduling.lite", "Lite")}</option>
          <option value="off">{t("settings.scheduling.off", "Off")}</option>
        </select>
        <small>{t("settings.scheduling.strictCoordinationFocusedHigherPerTickTokensLite", "Strict \u2014 coordination-focused; higher per-tick tokens. Lite \u2014 pre-2026-05-11 behavior. Off \u2014 minimal procedure.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="engineerBacklogAutoClaim" className="checkbox-label">
          <input id="engineerBacklogAutoClaim" type="checkbox" checked={form.engineerBacklogAutoClaim === true} onChange={(e) => setForm((f) => ({ ...f, engineerBacklogAutoClaim: e.target.checked }))}/>{t("settings.scheduling.letEngineerAgentsAutoClaimBacklogTasks", " Let engineer agents auto-claim backlog tasks ")}</label>
        <small>{t("settings.scheduling.backlogNoTaskAutoClaimIsExecutorOnly", "Backlog/no-task auto-claim is executor-only by default. Enable to let engineer-role agents auto-claim unowned backlog tasks; explicit routing and delegation are unchanged. Default: off.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="taskStuckTimeoutMs">{t("settings.scheduling.stuckTaskTimeoutMinutes", "Stuck Task Timeout (minutes)")}</label>
        <input id="taskStuckTimeoutMs" type="number" min={1} step={1} value={form.taskStuckTimeoutMs ? Math.round(form.taskStuckTimeoutMs / 60000) : ""} onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, taskStuckTimeoutMs: val && num > 0 ? num * 60000 : undefined }));
        }}/>
        <small>{t("settings.scheduling.timeoutInMinutesForDetectingStuckTasksWhen", "Timeout in minutes for detecting stuck tasks. When a task's agent session shows no activity for longer than this duration, the task is terminated and retried. Leave empty to disable. Suggested: 10. Default: 10 minutes (600000ms).")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="buildTimeoutMs">{t("settings.scheduling.buildTimeoutMinutes", "Build/Verification Timeout (minutes)")}</label>
        <input id="buildTimeoutMs" type="number" min={1} step={1} value={form.buildTimeoutMs ? Math.round(form.buildTimeoutMs / 60000) : ""} onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, buildTimeoutMs: val && num > 0 ? num * 60000 : undefined }));
        }}/>
        <small>{t("settings.scheduling.maximumTimeInMinutesForBuildVerificationCommands", "Maximum time in minutes for build/verification commands before they are killed. Raise for large monorepo or Docker builds. Default: 5.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="staleHighFanoutBlockerAgeThresholdMs">{t("settings.scheduling.staleHighFanOutEscalationHours", "Stale High Fan-out Escalation (hours)")}</label>
        <input id="staleHighFanoutBlockerAgeThresholdMs" type="number" min={1} step={1} value={form.staleHighFanoutBlockerAgeThresholdMs ? Math.round(form.staleHighFanoutBlockerAgeThresholdMs / 3600000) : ""} onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({
                ...f,
                staleHighFanoutBlockerAgeThresholdMs: val && num > 0 ? num * 3600000 : undefined,
            }));
        }}/>
        <small>{t("settings.scheduling.escalateHighFanOutBlockersOnlyAfterThey", "Escalate high fan-out blockers only after they remain in in-progress or in-review for this many hours (age source: columnMovedAt, fallback updatedAt). Default: 2 hours.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="preserveProgressOnStuckRequeue" className="checkbox-label">
          <input id="preserveProgressOnStuckRequeue" type="checkbox" checked={form.preserveProgressOnStuckRequeue !== false} onChange={(e) => setForm((f) => ({ ...f, preserveProgressOnStuckRequeue: e.target.checked }))}/>{t("settings.scheduling.preserveStepProgressOnStuckTaskRequeue", " Preserve step progress on stuck-task requeue ")}</label>
        <small>{t("settings.scheduling.whenTheStuckDetectorKillsAndReQueues", "When the stuck detector kills and re-queues a task, keep completed step statuses so the agent can resume from where it left off. Disable to reset every step to pending on each stuck retry. Default: enabled.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="specStalenessEnabled" className="checkbox-label">
          <input id="specStalenessEnabled" type="checkbox" checked={form.specStalenessEnabled || false} onChange={(e) => setForm((f) => ({ ...f, specStalenessEnabled: e.target.checked }))}/>{t("settings.scheduling.enablePlanStalenessEnforcement", " Enable plan staleness enforcement ")}</label>
        <small>{t("settings.scheduling.whenEnabledTasksWithStalePlansPROMPTMd", "When enabled, tasks with stale plans (PROMPT.md older than the threshold) are automatically sent back to planning for replanning. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="specStalenessMaxAgeMs">{t("settings.scheduling.staleSpecThresholdHours", "Stale Spec Threshold (hours)")}</label>
        <input id="specStalenessMaxAgeMs" type="number" min={0} step={1} value={form.specStalenessMaxAgeMs !== undefined ? Math.round(form.specStalenessMaxAgeMs / 3600000) : ""} onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, specStalenessMaxAgeMs: val !== "" ? num * 3600000 : undefined }));
        }} disabled={!form.specStalenessEnabled}/>
        <small>{t("settings.scheduling.maximumAgeInHoursBeforeAPlanIs", "Maximum age in hours before a plan is considered stale. Default: 6 hours.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoArchiveDoneTasksEnabled" className="checkbox-label">
          <input id="autoArchiveDoneTasksEnabled" type="checkbox" checked={form.autoArchiveDoneTasksEnabled ?? true} onChange={(e) => setForm((f) => ({
            ...f,
            autoArchiveDoneTasksEnabled: e.target.checked,
        }))}/>{t("settings.scheduling.enableAutomaticTaskArchiving", " Enable automatic task archiving ")}</label>
        <small>{t("settings.scheduling.completedTasksOlderThanTheThresholdAreMoved", "Completed tasks older than the threshold are moved out of the active task database. Default: enabled.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoArchiveDoneAfterMs">{t("settings.scheduling.archiveCompletedTasksAfterDays", "Archive Completed Tasks After (days)")}</label>
        <input id="autoArchiveDoneAfterMs" type="number" min={1} step={1} value={form.autoArchiveDoneAfterMs !== undefined ? Math.round(form.autoArchiveDoneAfterMs / MS_PER_DAY) : AUTO_ARCHIVE_DEFAULT_AFTER_DAYS} onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({
                ...f,
                autoArchiveDoneAfterMs: val === "" ? undefined : num * MS_PER_DAY,
            }));
        }} disabled={form.autoArchiveDoneTasksEnabled === false}/>
        <small>{t("settings.scheduling.numberOfDaysATaskCanStayIn", "Number of days a task can stay in Done before it is archived. Default: 2 days (48 hours).")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="archiveAgentLogMode">{t("settings.scheduling.archiveAgentLog", "Archive Agent Log")}</label>
        <select id="archiveAgentLogMode" value={form.archiveAgentLogMode ?? "compact"} onChange={(e) => setForm((f) => ({
            ...f,
            archiveAgentLogMode: e.target.value as "none" | "compact" | "full",
        }))} disabled={form.autoArchiveDoneTasksEnabled === false}>
          <option value="compact">{t("settings.scheduling.compactSummaryAndRecentEntries", "Compact summary and recent entries")}</option>
          <option value="none">{t("settings.scheduling.doNotArchiveAgentLogs", "Do not archive agent logs")}</option>
          <option value="full">{t("settings.scheduling.fullAgentLog", "Full agent log")}</option>
        </select>
        <small>{t("settings.scheduling.compactModeKeepsArchiveSizeLowWhilePreserving", "Compact mode keeps archive size low while preserving recent agent activity for context. Default: compact.")}</small>
      </div>
      {/**
       * FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658):
       * Operators do not want same-agent duplicate tasks (FN-4892 intake heuristic)
       * silently archived on creation — they want visibility and a chance to decide
       * via the near-duplicate flag/UI. Default off; this toggle restores the old
       * aggressive auto-archive behavior when enabled.
       */}
      <div className="form-group">
        <label htmlFor="autoArchiveDuplicateTasksEnabled" className="checkbox-label">
          <input id="autoArchiveDuplicateTasksEnabled" type="checkbox" checked={form.autoArchiveDuplicateTasksEnabled ?? false} onChange={(e) => setForm((f) => ({
            ...f,
            autoArchiveDuplicateTasksEnabled: e.target.checked,
        }))}/>{t("settings.scheduling.autoArchiveDuplicateTasks", " Automatically archive duplicate tasks ")}</label>
        <small>{t("settings.scheduling.autoArchiveDuplicateTasksHelp", "Automatically archive tasks detected as same-agent duplicates on creation (off by default). When disabled, duplicates are flagged in place with the yellow Duplicate chip and Keep/Archive actions instead of being archived automatically.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="maxStuckKills">{t("settings.scheduling.maxStuckRetries", "Max Stuck Retries")}</label>
        <input id="maxStuckKills" type="number" min={1} step={1} value={form.maxStuckKills ?? ""} onChange={(e) => {
            const val = e.target.value;
            const num = Number(val);
            setForm((f) => ({ ...f, maxStuckKills: val && num > 0 ? num : undefined }));
        }}/>
        <small>{t("settings.scheduling.maximumStuckDetectorRetriesBeforeATaskIs", "Maximum stuck-detector retries before a task is marked failed. Default: 6.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="groupOverlappingFiles" className="checkbox-label">
          <input id="groupOverlappingFiles" type="checkbox" checked={form.groupOverlappingFiles} onChange={(e) => setForm((f) => ({ ...f, groupOverlappingFiles: e.target.checked }))}/>{t("settings.scheduling.serializeTasksWithOverlappingFiles", " Serialize tasks with overlapping files ")}</label>
        <small>{t("settings.scheduling.whenEnabledTasksThatModifyTheSameFiles", "When enabled, tasks that modify the same files are queued serially to avoid merge conflicts. Default: enabled.")}</small>
      </div>

      {/**
       * FNXC:SettingsScheduling 2026-06-23-13:22:
       * Operators need a Scheduling toggle that defaults on for ignoring hidden dot paths in overlap checks while preserving the selected value independently of overlap serialization being enabled.
       */}
      <div className="form-group">
        <label htmlFor="ignoreHiddenOverlapPaths" className="checkbox-label">
          <input id="ignoreHiddenOverlapPaths" type="checkbox" checked={form.ignoreHiddenOverlapPaths !== false} onChange={(e) => setForm((f) => ({ ...f, ignoreHiddenOverlapPaths: e.target.checked }))}/>{t("settings.scheduling.ignoreHiddenDotPathsInOverlapChecks", " Ignore hidden dot paths in overlap checks ")}</label>
        <small>{t("settings.scheduling.ignoreHiddenDotPathsHelp", "When enabled, overlap checks ignore hidden path segments such as .fusion/, .changeset/, .github/, .env, and nested .cache/ directories. Uncheck to restore legacy counting for stricter serialization. Default: enabled.")}</small>
      </div>

      <div className="form-group settings-overlap-ignore-group">
        <label>{t("settings.scheduling.ignoredOverlapPaths", "Ignored overlap paths")}</label>
        <small>{t("settings.scheduling.optionalFileOrDirectoryPathsToIgnoreWhen", " No default \u2014 unset (empty). Optional file or directory paths to ignore when overlap serialization is enabled. Paths are project-relative (for example ")}<code>docs/</code>{t("settings.scheduling.or", " or ")}<code>generated/*</code>{t("settings.scheduling.closeParenPeriod", ").")}
        </small>
        <div className="settings-overlap-ignore-list">
          {(form.overlapIgnorePaths && form.overlapIgnorePaths.length > 0 ? form.overlapIgnorePaths : [""]).map((path, index) => (<div key={`overlap-ignore-${index}`} className="settings-overlap-ignore-row">
              <div className="settings-overlap-ignore-path-controls">
                <input type="text" value={path} placeholder={t("settings.scheduling.docs", "docs/")} onChange={(e) => onOverlapIgnorePathChange(index, e.target.value)}/>
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
