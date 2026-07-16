import { useEffect, useMemo, useState } from "react";
import { DEPRECATED_BUILTIN_WORKFLOW_IDS, isLocale, SUPPORTED_LOCALES, type WorkflowDefinition } from "@fusion/core";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Locale labels come from core's shared `localeDisplayName` (endonyms), NOT from the LanguageSelector component: importing a component module for a constant drags its i18n/react-i18next initialization into every consumer of this section, which breaks tests that mock react-i18next narrowly.
The core helper is the same list the translate banner labels source languages with, so the two surfaces cannot drift.
*/
import { localeDisplayName } from "@fusion/core/detect-content-language";
import { ProjectDefaultWorkflowField } from "../../WorkflowSelector";
import { WorkflowIcon } from "../../WorkflowIcon";
import { fetchWorkflows } from "../../../api";
import { clearAllLocalCache } from "../../../utils/swrCache";
import type { ToastType } from "../../../hooks/useToast";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface GeneralSectionProps extends SectionBaseProps {
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    prefixError: string | null;
    setPrefixError: (value: string | null) => void;
    onQuickChatButtonModeChange?: (mode: "floating" | "footer" | "off") => void;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
Plain settings rows render through the shared primitives instead of hand-rolled `form-group` + `checkbox-label` markup, so labels, help copy, and padding come from one type scale. `.form-group` stays global and untouched — 35 non-settings files style forms with it — so the fix is to migrate settings off it, not to restyle it underneath the rest of the dashboard.
Every key here is project-scoped (DEFAULT_PROJECT_SETTINGS), which the per-row badge states: the nav already labels the section "Project General", but the badge is what distinguishes these from the global-tier settings an operator sees one section away.
Rows that stay bespoke are the ones a single-string descriptor cannot carry without rewording the copy — help built from `t()` fragments interleaved with `<code>` (ephemeral agents, completion documentation) — plus the custom widgets and editors: the workflow pickers, the built-in workflow enablement list, and the Clear-local-data button.

FNXC:SourceControl 2026-07-15-20:30:
GitHub/GitLab settings are NOT in this section. The tracking block, the tracking-repo select, and the GitLab disclosure moved to "Source Control · Project" (SourceControlSection.tsx), which also absorbed Merge's GitHub/GitLab auth blocks. Do not add source-control settings back here: `gitlabEnabled` was previously writable from both this section and Merge, and one owning section is what keeps that from recurring.
*/
export function GeneralSection({ form, setForm, projectId, addToast, prefixError, setPrefixError, onQuickChatButtonModeChange, }: GeneralSectionProps) {
    const { t } = useTranslation("app");
    const [builtinWorkflows, setBuiltinWorkflows] = useState<WorkflowDefinition[]>([]);
    useEffect(() => {
        let cancelled = false;
        fetchWorkflows(projectId, { includeDisabledBuiltins: true })
            .then((workflows) => {
            if (!cancelled) {
                // FNXC:WorkflowBrainstorming 2026-07-15-15:49: FN-7970 keeps deprecated built-ins out of Settings toggles, which are a new-selection surface.
                setBuiltinWorkflows(workflows.filter(
                    (workflow) => workflow.id.startsWith("builtin:")
                        && workflow.kind !== "fragment"
                        && !DEPRECATED_BUILTIN_WORKFLOW_IDS.has(workflow.id),
                ));
            }
        })
            .catch(() => {
            if (!cancelled)
                setBuiltinWorkflows([]);
        });
        return () => {
            cancelled = true;
        };
    }, [projectId]);
    /*
    FNXC:TaskRevert 2026-07-05-00:00:
    AI-undo (revert) board tasks default to the stricter builtin:review-heavy workflow
    (FN-7556) so reversals of already-shipped code get extra review scrutiny. This picker
    surfaces that choice: the empty-string option means "inherit project default workflow"
    (the revert route treats blank/whitespace as inherit), an unset form value displays the
    effective builtin:review-heavy default, and any other value is the concrete workflow id
    to use for AI-undo tasks. Loaded separately from builtinWorkflows above because this list
    includes custom workflows too (builtinWorkflows is deliberately builtin-only, used for the
    enable/disable checkboxes).
    */
    const [aiUndoWorkflowOptions, setAiUndoWorkflowOptions] = useState<WorkflowDefinition[]>([]);
    useEffect(() => {
        let cancelled = false;
        fetchWorkflows(projectId)
            .then((workflows) => {
            if (!cancelled) {
                setAiUndoWorkflowOptions(workflows.filter((workflow) => workflow.kind !== "fragment"));
            }
        })
            .catch(() => {
            if (!cancelled)
                setAiUndoWorkflowOptions([]);
        });
        return () => {
            cancelled = true;
        };
    }, [projectId]);
    const aiUndoTaskWorkflowValue = form.aiUndoTaskWorkflowId ?? "builtin:review-heavy";
    const aiUndoWorkflowHasStoredValue = aiUndoTaskWorkflowValue === "" ||
        aiUndoWorkflowOptions.some((workflow) => workflow.id === aiUndoTaskWorkflowValue);
    const enabledBuiltinWorkflowIds = useMemo(() => {
        const configured = Array.isArray(form.enabledBuiltinWorkflowIds) ? form.enabledBuiltinWorkflowIds : undefined;
        return new Set(configured ?? builtinWorkflows.map((workflow) => workflow.id));
    }, [builtinWorkflows, form.enabledBuiltinWorkflowIds]);
    const setBuiltinWorkflowEnabled = (workflowId: string, enabled: boolean) => {
        setForm((f) => {
            const allIds = builtinWorkflows.map((workflow) => workflow.id);
            const current = new Set(Array.isArray(f.enabledBuiltinWorkflowIds) ? f.enabledBuiltinWorkflowIds : allIds);
            if (enabled) {
                current.add(workflowId);
            }
            else {
                current.delete(workflowId);
            }
            const nextIds = allIds.filter((id) => current.has(id));
            return {
                ...f,
                enabledBuiltinWorkflowIds: nextIds.length === allIds.length ? undefined : nextIds,
            };
        });
    };
    /*
    FNXC:SettingsGeneral 2026-07-02-00:00:
    User-facing escape hatch for localStorage quota exhaustion. The dashboard accumulates per-project
    SWR hydration caches (chat sessions, rooms, tasks, board snapshots) whose stale entries linger
    indefinitely. clearAllLocalCache wipes all Fusion-owned browser data (caches + UI prefs) while
    preserving the auth token so the session survives the reload. Tasks and project settings live
    server-side and are unaffected.
    */
    const handleClearLocalData = () => {
        const confirmed = window.confirm(t("settings.general.clearLocalDataConfirm", "Clear all cached data and UI preferences stored in this browser? This frees space used by stale chat, task, and board caches. Your tasks and project settings are safe (stored server-side). The dashboard will reload."));
        if (!confirmed) {
            return;
        }
        clearAllLocalCache();
        window.location.reload();
    };
    return (<>
      <h4 className="settings-section-heading">{t("settings.general.general", "General")}</h4>
      {/*
        FNXC:SettingsGeneral 2026-07-15-17:35:
        A blank prefix stores `undefined`, not "": empty means "no prefix configured" and must delete the
        key rather than persist an empty string. Validation is advisory — the typed value is stored even
        while it fails the 1–5 uppercase rule, so the operator keeps editing what they typed.
      */}
      <SettingsTextRow
        descriptor={{
          key: "taskPrefix",
          label: t("settings.general.taskPrefix", "Task Prefix"),
          help: t("settings.general.prefixForNewTaskIDsEGKB", "Prefix for new task IDs (e.g. KB, PROJ). No default — unset."),
          scope: "project",
          placeholder: t("settings.general.fN", "FN"),
        }}
        value={form.taskPrefix || ""}
        onChange={(v) => {
            const val = v ?? "";
            setForm((f) => ({ ...f, taskPrefix: val || undefined }));
            if (val && !/^[A-Z]{1,5}$/.test(val)) {
                setPrefixError(t("settings.general.prefixMustBe15UppercaseLetters", "Prefix must be 1–5 uppercase letters"));
            }
            else {
                setPrefixError(null);
            }
        }}
        error={prefixError ?? undefined}
      />
      <div className="form-group">
        <ProjectDefaultWorkflowField projectId={projectId} addToast={addToast}/>
        <small>{t("settings.general.newTasksInheritThisCustomWorkflowsStepsOverridable", "New tasks inherit this custom workflow's steps (overridable per task). No default \u2014 unset (built-in default workflow).")}</small>
      </div>
      {builtinWorkflows.length > 0 && (<div className="form-group">
          <label>{t("settings.general.fusionWorkflows", "Fusion workflows")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            {builtinWorkflows.map((workflow) => (<label key={workflow.id} htmlFor={`builtin-workflow-${workflow.id}`} className="checkbox-label">
                <input id={`builtin-workflow-${workflow.id}`} type="checkbox" checked={enabledBuiltinWorkflowIds.has(workflow.id)} onChange={(e) => setBuiltinWorkflowEnabled(workflow.id, e.target.checked)}/>
                <WorkflowIcon workflowId={workflow.id} decorative />
                <span>{workflow.name}</span>
              </label>))}
          </div>
          <small>{t("settings.general.disabledFusionWorkflowsAreHiddenFromWorkflow", "Disabled Fusion workflows are hidden from workflow pickers. Existing tasks that already use one continue to resolve. Default: all built-in workflows enabled (unset).")}</small>
        </div>)}
      <div className="form-group">
        <label htmlFor="aiUndoTaskWorkflowId">{t("settings.general.aiUndoTaskWorkflow", "AI-undo task workflow")}</label>
        <select id="aiUndoTaskWorkflowId" className="select" data-testid="ai-undo-workflow-select" value={aiUndoTaskWorkflowValue} onChange={(e) => setForm((f) => ({ ...f, aiUndoTaskWorkflowId: e.target.value }))}>
          <option value="">{t("settings.general.aiUndoTaskWorkflowInherit", "Inherit project default workflow")}</option>
          {aiUndoWorkflowOptions.map((workflow) => (<option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>))}
          {!aiUndoWorkflowHasStoredValue && (<option value={aiUndoTaskWorkflowValue}>{aiUndoTaskWorkflowValue}</option>)}
        </select>
        <small>{t("settings.general.aiUndoTaskWorkflowHelp", "Workflow assigned to AI-undo (revert) tasks, which reverse already-shipped code and warrant stricter review. Choose \"Inherit project default workflow\" to leave them on the project default. Default: review-heavy.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="ephemeralAgentsEnabled" className="checkbox-label">
          <input id="ephemeralAgentsEnabled" type="checkbox" checked={form.ephemeralAgentsEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, ephemeralAgentsEnabled: e.target.checked }))}/>{t("settings.general.useEphemeralTaskWorkerAgents", " Use ephemeral task-worker agents ")}</label>
        <small>{t("settings.general.whenEnabledDefaultFusionSpawnsShortLived", " When enabled (default), Fusion spawns short-lived ")}<code>executor-FN-XXXX</code>{t("settings.general.agentsToRunEachTaskWhenDisabledOnly", " agents to run each task. When disabled, only permanent agents execute tasks and the scheduler auto-assigns work using the agent reporting chain. Tasks with no eligible permanent agent stay queued. ")}</small>
      </div>
      {/*
        FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
        Default-on toggle controlling whether ephemeral task-worker agents may open new tasks via fn_task_create. Turning it off confines task creation to humans and permanent agents; ephemeral callers get a rejection.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "ephemeralAgentsCanCreateTasks",
          label: t("settings.general.allowEphemeralAgentsToCreateTasks", " Allow ephemeral agents to create tasks "),
          help: t("settings.general.allowEphemeralAgentsToCreateTasksHint", "When enabled (default), ephemeral task-worker agents can open follow-up tasks via fn_task_create. When disabled, only humans and permanent agents can create tasks; ephemeral callers are rejected."),
          scope: "project",
        }}
        value={form.ephemeralAgentsCanCreateTasks !== false}
        onChange={(v) => setForm((f) => ({ ...f, ephemeralAgentsCanCreateTasks: v === true }))}
      />
      {/*
        FNXC:Workspace 2026-06-24-16:00:
        Workspace mode toggle: when enabled, the project root is treated as a workspace parent
        containing multiple git sub-repos instead of a single git repo. The executor runs tasks
        per-sub-repo, and git init is skipped at the root. Toggling on triggers detectWorkspaceRepos
        and persists .fusion/workspace.json; toggling off removes it.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "workspaceMode",
          label: t("settings.general.workspaceMode", " Workspace mode (multi-repo) "),
          help: t("settings.general.workspaceModeHint", "When enabled, the project root is treated as a workspace containing multiple git sub-repos. Tasks run per-sub-repo and no git repo is created at the root. Disable for single-repo projects. No default \u2014 unset (disabled)."),
          scope: "project",
        }}
        value={form.workspaceMode === true}
        onChange={(v) => setForm((f) => ({ ...f, workspaceMode: v === true }))}
      />
      {/*
        FNXC:FileBrowser 2026-06-29-00:00:
        This project-scoped General toggle is intentionally default-off because slash-prefixed file-browser paths can browse outside the workspace. It only affects workspace file-browser routes and keeps task-local file APIs and other path validators confined.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "allowAbsoluteFileBrowserPaths",
          label: t("settings.general.allowAbsoluteFileBrowserPaths", " Allow absolute file-browser paths "),
          help: t("settings.general.allowAbsoluteFileBrowserPathsHint", "When enabled, slash-prefixed paths such as /tmp can be opened in the workspace file browser. Windows drive-letter paths remain blocked, and other path validators are unchanged. Default: disabled."),
          scope: "project",
        }}
        value={form.allowAbsoluteFileBrowserPaths === true}
        onChange={(v) => setForm((f) => ({ ...f, allowAbsoluteFileBrowserPaths: v === true }))}
      />
      <div className="form-group">
        <label htmlFor="completionDocumentationMode">{t("settings.general.completionDocumentationAutomation", "Completion Documentation Automation")}</label>
        <select id="completionDocumentationMode" value={form.completionDocumentationMode || "off"} onChange={(e) => setForm((f) => ({
            ...f,
            completionDocumentationMode: e.target.value as "off" | "changeset" | "changelog",
        }))}>
          <option value="off">{t("settings.general.off", "Off")}</option>
          <option value="changeset">{t("settings.general.requireChangesetChangesetMd", "Require changeset (.changeset/*.md)")}</option>
          <option value="changelog">{t("settings.general.requireChangelogUpdateExistingChangelog", "Require changelog update (existing changelog)")}</option>
        </select>
        <small>{t("settings.general.controlsHowFutureTaskSpecsHandleReleaseNote", " Controls how future task specs handle release-note artifacts at completion. Use changeset mode for repositories that follow ")}<code>.changeset</code>{t("settings.general.workflowsOrChangelogModeWhenContributorsShouldUpdate", " workflows, or changelog mode when contributors should update an existing changelog file. Default: off. ")}</small>
      </div>
      {/*
        FNXC:SettingsGeneral 2026-07-15-17:35:
        `showQuickChatFAB` is written alongside `quickChatButtonMode` on every change: the legacy boolean
        is still the fallback this control reads when no mode is stored, so the two must never disagree.
        The change is also reported synchronously via onQuickChatButtonModeChange so the launcher moves
        before Save — operators need to see where the button lands while choosing.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "quickChatButtonMode",
          label: t("settings.general.quickChatLauncher", "Quick Chat launcher"),
          help: t("settings.general.quickChatLauncherHint", "Choose whether Quick Chat opens from the draggable floating button, a footer button beside Terminal, or stays hidden. Default: off (hidden)."),
          scope: "project",
          options: [
            { value: "floating", label: t("settings.general.quickChatLauncherFloating", "Floating button") },
            { value: "footer", label: t("settings.general.quickChatLauncherFooter", "Footer button") },
            { value: "off", label: t("settings.general.off", "Off") },
          ],
        }}
        value={form.quickChatButtonMode ?? (form.showQuickChatFAB ? "floating" : "off")}
        onChange={(v) => setForm((f) => {
            const mode = (v ?? "off") as "floating" | "footer" | "off";
            onQuickChatButtonModeChange?.(mode);
            return { ...f, quickChatButtonMode: mode, showQuickChatFAB: mode === "floating" };
        })}
      />
      {/*
        FNXC:ChatModal 2026-06-28-00:00:
        Operators need a Settings > General toggle for Quick Chat outside-click dismissal because accidental board clicks can otherwise close active chat context. Default checked preserves the shipped FN-7152 interaction.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "quickChatCloseOnOutsideClick",
          label: t("settings.general.quickChatCloseOnOutsideClick", "Close Quick Chat on outside click"),
          help: t("settings.general.quickChatCloseOnOutsideClickHint", "When enabled, clicking outside the Quick Chat window closes it. Disable to keep it open until you close it explicitly. Default: enabled."),
          scope: "project",
        }}
        value={form.quickChatCloseOnOutsideClick !== false}
        onChange={(v) => setForm((f) => ({ ...f, quickChatCloseOnOutsideClick: v === true }))}
      />
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.chatHistory", "Chat history")}</h4>
      {/*
        FNXC:ChatModal 2026-07-01-00:00:
        Users asked for task-planner chats to stop cluttering the common Direct feed without forcing a new Direct/Rooms/Tasks tab split. Keep the default hidden and expose this project opt-in for operators who want the previous shared-feed behavior.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "showTaskChatsInCommonFeed",
          label: t("settings.general.showTaskChatsInCommonFeed", "Show task chats in common Chat feed"),
          help: t("settings.general.showTaskChatsInCommonFeedHint", "When enabled, populated task-detail Chat conversations appear in the common Direct feed. Empty task chats stay hidden. Default: disabled."),
          scope: "project",
        }}
        value={form.showTaskChatsInCommonFeed === true}
        onChange={(v) => setForm((f) => ({ ...f, showTaskChatsInCommonFeed: v === true }))}
      />
      {/*
        FNXC:SettingsGeneral 2026-07-15-17:35:
        The three retention pickers store a NUMBER of days, not the option string, and collapse every
        falsy choice to 0 — 0 is the "Off" sentinel these settings read, so an unparseable or empty
        selection must disable cleanup rather than persist NaN.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "chatAutoCleanupDays",
          label: t("settings.general.autoCleanupOldChats", "Auto-cleanup old chats"),
          help: t("settings.general.deleteChatSessionsAndRoomsThatHaveBeen", "Delete chat sessions and rooms that have been idle for this many days. Default: Off."),
          scope: "project",
          options: [
            { value: "0", label: t("settings.general.off", "Off") },
            { value: "7", label: t("settings.general.7Days", "7 days") },
            { value: "14", label: t("settings.general.14Days", "14 days") },
            { value: "30", label: t("settings.general.30Days", "30 days") },
            { value: "60", label: t("settings.general.60Days", "60 days") },
            { value: "90", label: t("settings.general.90Days", "90 days") },
          ],
        }}
        value={String(form.chatAutoCleanupDays ?? 0)}
        onChange={(v) => setForm((f) => ({ ...f, chatAutoCleanupDays: Number(v) || 0 }))}
      />
      <SettingsSelectRow
        descriptor={{
          key: "mailAutoCleanupDays",
          label: t("settings.general.autoPruneOldMail", "Auto-prune old mail"),
          help: t("settings.general.deleteInboxOutboxMessagesOlderThanThisMany", "Delete inbox/outbox messages older than this many days. Default: Off. 7 days is the suggested setting."),
          scope: "project",
          options: [
            { value: "0", label: t("settings.general.off", "Off") },
            { value: "7", label: t("settings.general.7Days", "7 days") },
            { value: "14", label: t("settings.general.14Days", "14 days") },
            { value: "30", label: t("settings.general.30Days", "30 days") },
            { value: "60", label: t("settings.general.60Days", "60 days") },
            { value: "90", label: t("settings.general.90Days", "90 days") },
          ],
        }}
        value={String(form.mailAutoCleanupDays ?? 0)}
        onChange={(v) => setForm((f) => ({ ...f, mailAutoCleanupDays: Number(v) || 0 }))}
      />
      <SettingsSelectRow
        descriptor={{
          key: "operationalLogRetentionDays",
          label: t("settings.general.operationalLogRetention", "Operational log retention"),
          help: t("settings.general.loweringThisWindowMeansReliabilityMetricsChartsAnd", " Lowering this window means Reliability metrics/charts and the Activity feed will not show history older than the selected range. Per-task task detail history is unaffected. Default: 30 days. "),
          scope: "project",
          options: [
            { value: "0", label: t("settings.general.off", "Off") },
            { value: "7", label: t("settings.general.7Days", "7 days") },
            { value: "14", label: t("settings.general.14Days", "14 days") },
            { value: "30", label: t("settings.general.30Days", "30 days") },
            { value: "60", label: t("settings.general.60Days", "60 days") },
            { value: "90", label: t("settings.general.90Days", "90 days") },
          ],
        }}
        value={String(form.operationalLogRetentionDays ?? 30)}
        onChange={(v) => setForm((f) => ({ ...f, operationalLogRetentionDays: Number(v) || 0 }))}
      />
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.chatRooms", "Chat Rooms")}</h4>
      {/*
        FNXC:SettingsGeneral 2026-07-15-17:35:
        Blank and 0 both store `undefined` for the three room-compaction limits: these settings have no
        "zero" meaning, so an emptied field must fall back to the schema default rather than pin the
        transcript to zero verbatim messages.
      */}
      <SettingsNumberRow
        descriptor={{
          key: "chatRoomRecentVerbatimMessages",
          label: t("settings.general.recentVerbatimRoomMessages", "Recent verbatim room messages"),
          help: t("settings.general.numberOfMostRecentChatRoomMessagesKept", "Number of most-recent chat-room messages kept verbatim in the responder transcript. Older messages are compacted into a summary block. Default: 25."),
          scope: "project",
          min: 1,
          placeholder: t("settings.general.25", "25"),
        }}
        value={form.chatRoomRecentVerbatimMessages ?? null}
        onChange={(v) => setForm((f) => ({ ...f, chatRoomRecentVerbatimMessages: v || undefined }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "chatRoomCompactionFetchLimit",
          label: t("settings.general.roomCompactionFetchLimit", "Room compaction fetch limit"),
          help: t("settings.general.upperBoundOnMessagesFetchedFromTheRoom", "Upper bound on messages fetched from the room store for compaction consideration. Default: 200."),
          scope: "project",
          min: 1,
          placeholder: t("settings.general.200", "200"),
        }}
        value={form.chatRoomCompactionFetchLimit ?? null}
        onChange={(v) => setForm((f) => ({ ...f, chatRoomCompactionFetchLimit: v || undefined }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "chatRoomSummaryMaxChars",
          label: t("settings.general.roomSummaryMaxCharacters", "Room summary max characters"),
          help: t("settings.general.hardCapOnTheSynthesizedEarlierRoomContext", "Hard cap on the synthesized \"Earlier room context\" summary block. Default: 3000."),
          scope: "project",
          min: 200,
          placeholder: t("settings.general.3000", "3000"),
        }}
        value={form.chatRoomSummaryMaxChars ?? null}
        onChange={(v) => setForm((f) => ({ ...f, chatRoomSummaryMaxChars: v || undefined }))}
      />
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.capacityRiskBanner", "Capacity Risk Banner")}</h4>
      <SettingsToggleRow
        descriptor={{
          key: "capacityRiskBannerEnabled",
          label: t("settings.general.showCapacityRiskBanner", " Show capacity risk banner "),
          help: t("settings.general.warnOnTheBoardWhenTodoWorkExceeds", "Warn on the board when todo work exceeds the threshold and no idle agents are available. Default: disabled."),
          scope: "project",
        }}
        value={form.capacityRiskBannerEnabled === true}
        onChange={(v) => setForm((f) => ({ ...f, capacityRiskBannerEnabled: v === true }))}
      />
      {/*
        FNXC:SettingsGeneral 2026-07-15-17:35:
        The threshold is a task COUNT: it is floored at 0 and truncated to a whole number, and an emptied
        field stores 0 rather than deleting the key, because the banner compares todo count against a
        concrete number and a fractional or negative threshold has no meaning.
      */}
      <SettingsNumberRow
        descriptor={{
          key: "capacityRiskTodoThreshold",
          label: t("settings.general.todoThreshold", "Todo threshold"),
          help: t("settings.general.bannerFiresWhenTodoCountIsStrictlyGreater", "Banner fires when todo count is strictly greater than this value (default 20). Applies when the banner is enabled."),
          scope: "project",
          min: 0,
        }}
        value={form.capacityRiskTodoThreshold ?? 20}
        onChange={(v) => setForm((f) => ({
            ...f,
            capacityRiskTodoThreshold: v === null
                ? 0
                : Math.max(0, Math.trunc(v) || 0),
        }))}
      />
      {/*
        FNXC:PlannerOversight 2026-07-14-18:11:
        Project default for the session advisor (LLM overseer agent). Per-task overrides
        come from Quick Add (eye icon) and task detail. Provider/model stay under workflow settings.
      */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.sessionAdvisor", "Session advisor (overseer agent)")}</h4>
      {/*
        FNXC:PlannerOversight 2026-07-15-17:35:
        The stored setting is the boolean `sessionAdvisorEnabledByDefault`; the two-option picker is only
        its presentation, so "off"/"new-tasks" must map back to false/true rather than being persisted.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "sessionAdvisorEnabledByDefault",
          label: t("settings.general.defaultSessionAdvisorForNewTasks", "Default for new tasks"),
          help: t(
            "settings.general.sessionAdvisorHelp",
            "Controls whether newly created tasks enable the session advisor (live LLM overseer of the executor). Individual tasks can override this from Quick Add or task detail. Also set Session advisor model provider and model id under workflow settings before the advisor can run.",
          ),
          scope: "project",
          options: [
            { value: "off", label: t("settings.general.offDefault", "Off (default)") },
            { value: "new-tasks", label: t("settings.general.onForNewTasks", "On for new tasks") },
          ],
        }}
        value={form.sessionAdvisorEnabledByDefault ? "new-tasks" : "off"}
        onChange={(v) => setForm((f) => ({
          ...f,
          sessionAdvisorEnabledByDefault: v === "new-tasks",
        }))}
      />
      {/*
        FNXC:SourceControl 2026-07-15-20:30:
        The GitHub Tracking controls, the GitLab disclosure, and `githubLinkImportedIssuesToTracking` moved to "Source Control · Project". The two import-translate rows below did NOT: they only affect the Import Tasks panel's rendering of issue text, not how Fusion talks to GitHub/GitLab.
        The heading stays because those rows still sit under it and it is their existing copy — there is no "issue import" heading string in the catalog, and inventing one here would be new operator-facing text rather than a move.
      */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.gitHubTracking", "GitHub Tracking")}</h4>
      {/*
        FNXC:GitHubImportTranslate 2026-07-15-09:30:
        Both controls live beside the other import-scoped GitHub settings because they
        only ever affect the Import Tasks panel, never ordinary task creation.
        Auto-translate is OFF by default: translation is a per-issue AI call, so operators
        on all-English repos must never pay for it without asking. When ON, the panel
        translates foreign-language issue titles/bodies into the target language and shows
        the translation by default (the original stays one toggle away).
        Target language is deliberately clearable — the empty option means "follow the
        dashboard language", so an operator who switches the dashboard to Korean gets Korean
        translations without touching this setting twice.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "githubImportAutoTranslate",
          label: t("settings.general.autoTranslateImportedIssues", "Auto-translate imported issues"),
          help: t("settings.general.autoTranslateImportedIssuesHelp", "When enabled, the Import Tasks panel automatically translates foreign-language issue titles and bodies into the target language below and shows the translation by default. You can always switch back to the original text, and imported tasks carry the translated text. Default: disabled."),
          scope: "project",
        }}
        value={form.githubImportAutoTranslate === true}
        /*
        FNXC:GitHubImportTranslate 2026-07-15-19:10:
        Switching OFF must store `undefined`, not `false`, so the key stays absent from the settings blob and keeps inheriting rather than persisting an explicit opt-out (PR #2147's contract, pinned by GeneralSection.importTranslate.test.tsx).
        `v ?? undefined` does not do that — the toggle emits `false`, and `false ?? undefined` is `false`. Only a cleared row emits null.
        */
        onChange={(v) => setForm((f) => ({ ...f, githubImportAutoTranslate: v === true ? true : undefined }))}
      />
      <SettingsSelectRow
        descriptor={{
          key: "importTranslateTargetLocale",
          label: t("settings.general.translationTargetLanguage", "Translation target language"),
          help: t("settings.general.translationTargetLanguageHelp", "Language imported issues are translated into when auto-translation is enabled. No default — unset inherits the dashboard language."),
          scope: "project",
          options: [
            { value: "", label: t("settings.general.followDashboardLanguage", "Follow dashboard language") },
            ...SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: localeDisplayName(locale) })),
          ],
        }}
        value={form.importTranslateTargetLocale ?? ""}
        onChange={(v) => setForm((f) => ({
          ...f,
          importTranslateTargetLocale: v && isLocale(v) ? v : undefined,
        }))}
      />
      {/*
        FNXC:SettingsGeneral 2026-07-02-00:00:
        "Clear local data" panel — the user-facing escape hatch when the dashboard runs out of
        browser localStorage quota. Frees stale SWR hydration caches (chat sessions, rooms, tasks,
        board snapshots) plus UI prefs. The auth token is preserved so the reload keeps the session.
      */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.browserData", "Browser Data")}</h4>
      <div className="form-group">
        <label>{t("settings.general.clearLocalData", "Clear local data")}</label>
        <small>{t("settings.general.clearLocalDataHint", "Remove cached board snapshots, chat threads, and UI preferences stored in this browser. Frees space when the dashboard runs low on browser storage. Your tasks and project settings are stored server-side and are not affected.")}</small>
        <div style={{ marginTop: "var(--space-sm)" }}>
          <button type="button" className="btn btn-sm" onClick={handleClearLocalData}>{t("settings.general.clearLocalDataButton", "Clear local data")}</button>
        </div>
      </div>
    </>);
}
export default GeneralSection;
