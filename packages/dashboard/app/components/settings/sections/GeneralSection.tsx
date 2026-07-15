import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkflowDefinition } from "@fusion/core";
import { ProjectDefaultWorkflowField } from "../../WorkflowSelector";
import { WorkflowIcon } from "../../WorkflowIcon";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { fetchWorkflows } from "../../../api";
import { clearAllLocalCache } from "../../../utils/swrCache";
import type { ToastType } from "../../../hooks/useToast";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface GeneralSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    prefixError: string | null;
    setPrefixError: (value: string | null) => void;
    projectTrackingRepoOptions: TrackingRepoOption[];
    projectTrackingRepoLoading: boolean;
    projectTrackingRepoError: string | null;
    onQuickChatButtonModeChange?: (mode: "floating" | "footer" | "off") => void;
}
export function GeneralSection({ scopeBanner, form, setForm, projectId, addToast, prefixError, setPrefixError, projectTrackingRepoOptions, projectTrackingRepoLoading, projectTrackingRepoError, onQuickChatButtonModeChange, }: GeneralSectionProps) {
    const { t } = useTranslation("app");
    const [builtinWorkflows, setBuiltinWorkflows] = useState<WorkflowDefinition[]>([]);
    useEffect(() => {
        let cancelled = false;
        fetchWorkflows(projectId, { includeDisabledBuiltins: true })
            .then((workflows) => {
            if (!cancelled) {
                setBuiltinWorkflows(workflows.filter((workflow) => workflow.id.startsWith("builtin:") && workflow.kind !== "fragment"));
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
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.general.general", "General")}</h4>
      <div className="form-group">
        <label htmlFor="taskPrefix">{t("settings.general.taskPrefix", "Task Prefix")}</label>
        <input id="taskPrefix" type="text" placeholder={t("settings.general.fN", "FN")} value={form.taskPrefix || ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, taskPrefix: val || undefined }));
            if (val && !/^[A-Z]{1,5}$/.test(val)) {
                setPrefixError(t("settings.general.prefixMustBe15UppercaseLetters", "Prefix must be 1–5 uppercase letters"));
            }
            else {
                setPrefixError(null);
            }
        }}/>
        {prefixError && <small className="field-error">{prefixError}</small>}
        {!prefixError && <small>{t("settings.general.prefixForNewTaskIDsEGKB", "Prefix for new task IDs (e.g. KB, PROJ). No default \u2014 unset.")}</small>}
      </div>
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
      <div className="form-group">
        <label htmlFor="ephemeralAgentsCanCreateTasks" className="checkbox-label">
          <input id="ephemeralAgentsCanCreateTasks" type="checkbox" checked={form.ephemeralAgentsCanCreateTasks !== false} onChange={(e) => setForm((f) => ({ ...f, ephemeralAgentsCanCreateTasks: e.target.checked }))}/>{t("settings.general.allowEphemeralAgentsToCreateTasks", " Allow ephemeral agents to create tasks ")}</label>
        <small>{t("settings.general.allowEphemeralAgentsToCreateTasksHint", "When enabled (default), ephemeral task-worker agents can open follow-up tasks via fn_task_create. When disabled, only humans and permanent agents can create tasks; ephemeral callers are rejected.")}</small>
      </div>
      {/*
        FNXC:Workspace 2026-06-24-16:00:
        Workspace mode toggle: when enabled, the project root is treated as a workspace parent
        containing multiple git sub-repos instead of a single git repo. The executor runs tasks
        per-sub-repo, and git init is skipped at the root. Toggling on triggers detectWorkspaceRepos
        and persists .fusion/workspace.json; toggling off removes it.
      */}
      <div className="form-group">
        <label htmlFor="workspaceMode" className="checkbox-label">
          <input id="workspaceMode" type="checkbox" checked={form.workspaceMode === true} onChange={(e) => setForm((f) => ({ ...f, workspaceMode: e.target.checked }))}/>{t("settings.general.workspaceMode", " Workspace mode (multi-repo) ")}</label>
        <small>{t("settings.general.workspaceModeHint", "When enabled, the project root is treated as a workspace containing multiple git sub-repos. Tasks run per-sub-repo and no git repo is created at the root. Disable for single-repo projects. No default \u2014 unset (disabled).")}</small>
      </div>
      {/*
        FNXC:FileBrowser 2026-06-29-00:00:
        This project-scoped General toggle is intentionally default-off because slash-prefixed file-browser paths can browse outside the workspace. It only affects workspace file-browser routes and keeps task-local file APIs and other path validators confined.
      */}
      <div className="form-group">
        <label htmlFor="allowAbsoluteFileBrowserPaths" className="checkbox-label">
          <input id="allowAbsoluteFileBrowserPaths" type="checkbox" checked={form.allowAbsoluteFileBrowserPaths === true} onChange={(e) => setForm((f) => ({ ...f, allowAbsoluteFileBrowserPaths: e.target.checked }))}/>{t("settings.general.allowAbsoluteFileBrowserPaths", " Allow absolute file-browser paths ")}</label>
        <small>{t("settings.general.allowAbsoluteFileBrowserPathsHint", "When enabled, slash-prefixed paths such as /tmp can be opened in the workspace file browser. Windows drive-letter paths remain blocked, and other path validators are unchanged. Default: disabled.")}</small>
      </div>
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
      <div className="form-group">
        <label htmlFor="quickChatButtonMode">{t("settings.general.quickChatLauncher", "Quick Chat launcher")}</label>
        <select id="quickChatButtonMode" className="select" value={form.quickChatButtonMode ?? (form.showQuickChatFAB ? "floating" : "off")} onChange={(e) => setForm((f) => {
            const mode = e.target.value as "floating" | "footer" | "off";
            onQuickChatButtonModeChange?.(mode);
            return { ...f, quickChatButtonMode: mode, showQuickChatFAB: mode === "floating" };
        })}>
          <option value="floating">{t("settings.general.quickChatLauncherFloating", "Floating button")}</option>
          <option value="footer">{t("settings.general.quickChatLauncherFooter", "Footer button")}</option>
          <option value="off">{t("settings.general.off", "Off")}</option>
        </select>
        <small>{t("settings.general.quickChatLauncherHint", "Choose whether Quick Chat opens from the draggable floating button, a footer button beside Terminal, or stays hidden. Default: off (hidden).")}</small>
      </div>
      {/*
        FNXC:ChatModal 2026-06-28-00:00:
        Operators need a Settings > General toggle for Quick Chat outside-click dismissal because accidental board clicks can otherwise close active chat context. Default checked preserves the shipped FN-7152 interaction.
      */}
      <div className="form-group">
        <label htmlFor="quickChatCloseOnOutsideClick" className="checkbox-label">
          <input id="quickChatCloseOnOutsideClick" type="checkbox" checked={form.quickChatCloseOnOutsideClick !== false} onChange={(e) => setForm((f) => ({ ...f, quickChatCloseOnOutsideClick: e.target.checked }))}/>{t("settings.general.quickChatCloseOnOutsideClick", "Close Quick Chat on outside click")}</label>
        <small>{t("settings.general.quickChatCloseOnOutsideClickHint", "When enabled, clicking outside the Quick Chat window closes it. Disable to keep it open until you close it explicitly. Default: enabled.")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.chatHistory", "Chat history")}</h4>
      {/*
        FNXC:ChatModal 2026-07-01-00:00:
        Users asked for task-planner chats to stop cluttering the common Direct feed without forcing a new Direct/Rooms/Tasks tab split. Keep the default hidden and expose this project opt-in for operators who want the previous shared-feed behavior.
      */}
      <div className="form-group">
        <label htmlFor="showTaskChatsInCommonFeed" className="checkbox-label">
          <input id="showTaskChatsInCommonFeed" type="checkbox" checked={form.showTaskChatsInCommonFeed === true} onChange={(e) => setForm((f) => ({ ...f, showTaskChatsInCommonFeed: e.target.checked }))}/>{t("settings.general.showTaskChatsInCommonFeed", "Show task chats in common Chat feed")}</label>
        <small>{t("settings.general.showTaskChatsInCommonFeedHint", "When enabled, populated task-detail Chat conversations appear in the common Direct feed. Empty task chats stay hidden. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="chatAutoCleanupDays">{t("settings.general.autoCleanupOldChats", "Auto-cleanup old chats")}</label>
        <select id="chatAutoCleanupDays" className="select" value={form.chatAutoCleanupDays ?? 0} onChange={(e) => setForm((f) => ({ ...f, chatAutoCleanupDays: Number(e.target.value) || 0 }))}>
          <option value={0}>{t("settings.general.off", "Off")}</option>
          <option value={7}>{t("settings.general.7Days", "7 days")}</option>
          <option value={14}>{t("settings.general.14Days", "14 days")}</option>
          <option value={30}>{t("settings.general.30Days", "30 days")}</option>
          <option value={60}>{t("settings.general.60Days", "60 days")}</option>
          <option value={90}>{t("settings.general.90Days", "90 days")}</option>
        </select>
        <small>{t("settings.general.deleteChatSessionsAndRoomsThatHaveBeen", "Delete chat sessions and rooms that have been idle for this many days. Default: Off.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="mailAutoCleanupDays">{t("settings.general.autoPruneOldMail", "Auto-prune old mail")}</label>
        <select id="mailAutoCleanupDays" className="select" value={form.mailAutoCleanupDays ?? 0} onChange={(e) => setForm((f) => ({ ...f, mailAutoCleanupDays: Number(e.target.value) || 0 }))}>
          <option value={0}>{t("settings.general.off", "Off")}</option>
          <option value={7}>{t("settings.general.7Days", "7 days")}</option>
          <option value={14}>{t("settings.general.14Days", "14 days")}</option>
          <option value={30}>{t("settings.general.30Days", "30 days")}</option>
          <option value={60}>{t("settings.general.60Days", "60 days")}</option>
          <option value={90}>{t("settings.general.90Days", "90 days")}</option>
        </select>
        <small>{t("settings.general.deleteInboxOutboxMessagesOlderThanThisMany", "Delete inbox/outbox messages older than this many days. Default: Off. 7 days is the suggested setting.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="operationalLogRetentionDays">{t("settings.general.operationalLogRetention", "Operational log retention")}</label>
        <select id="operationalLogRetentionDays" className="select" value={form.operationalLogRetentionDays ?? 30} onChange={(e) => setForm((f) => ({ ...f, operationalLogRetentionDays: Number(e.target.value) || 0 }))}>
          <option value={0}>{t("settings.general.off", "Off")}</option>
          <option value={7}>{t("settings.general.7Days", "7 days")}</option>
          <option value={14}>{t("settings.general.14Days", "14 days")}</option>
          <option value={30}>{t("settings.general.30Days", "30 days")}</option>
          <option value={60}>{t("settings.general.60Days", "60 days")}</option>
          <option value={90}>{t("settings.general.90Days", "90 days")}</option>
        </select>
        <small>{t("settings.general.loweringThisWindowMeansReliabilityMetricsChartsAnd", " Lowering this window means Reliability metrics/charts and the Activity feed will not show history older than the selected range. Per-task task detail history is unaffected. Default: 30 days. ")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.chatRooms", "Chat Rooms")}</h4>
      <div className="form-group">
        <label htmlFor="chatRoomRecentVerbatimMessages">{t("settings.general.recentVerbatimRoomMessages", "Recent verbatim room messages")}</label>
        <input id="chatRoomRecentVerbatimMessages" type="number" min="1" className="input" placeholder={t("settings.general.25", "25")} value={form.chatRoomRecentVerbatimMessages ?? ""} onChange={(e) => setForm((f) => ({ ...f, chatRoomRecentVerbatimMessages: Number(e.target.value) || undefined }))}/>
        <small>{t("settings.general.numberOfMostRecentChatRoomMessagesKept", "Number of most-recent chat-room messages kept verbatim in the responder transcript. Older messages are compacted into a summary block. Default: 25.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="chatRoomCompactionFetchLimit">{t("settings.general.roomCompactionFetchLimit", "Room compaction fetch limit")}</label>
        <input id="chatRoomCompactionFetchLimit" type="number" min="1" className="input" placeholder={t("settings.general.200", "200")} value={form.chatRoomCompactionFetchLimit ?? ""} onChange={(e) => setForm((f) => ({ ...f, chatRoomCompactionFetchLimit: Number(e.target.value) || undefined }))}/>
        <small>{t("settings.general.upperBoundOnMessagesFetchedFromTheRoom", "Upper bound on messages fetched from the room store for compaction consideration. Default: 200.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="chatRoomSummaryMaxChars">{t("settings.general.roomSummaryMaxCharacters", "Room summary max characters")}</label>
        <input id="chatRoomSummaryMaxChars" type="number" min="200" className="input" placeholder={t("settings.general.3000", "3000")} value={form.chatRoomSummaryMaxChars ?? ""} onChange={(e) => setForm((f) => ({ ...f, chatRoomSummaryMaxChars: Number(e.target.value) || undefined }))}/>
        <small>{t("settings.general.hardCapOnTheSynthesizedEarlierRoomContext", "Hard cap on the synthesized \"Earlier room context\" summary block. Default: 3000.")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.capacityRiskBanner", "Capacity Risk Banner")}</h4>
      <div className="form-group">
        <label htmlFor="capacityRiskBannerEnabled" className="checkbox-label">
          <input id="capacityRiskBannerEnabled" type="checkbox" checked={form.capacityRiskBannerEnabled === true} onChange={(e) => setForm((f) => ({ ...f, capacityRiskBannerEnabled: e.target.checked }))}/>{t("settings.general.showCapacityRiskBanner", " Show capacity risk banner ")}</label>
        <small>{t("settings.general.warnOnTheBoardWhenTodoWorkExceeds", "Warn on the board when todo work exceeds the threshold and no idle agents are available. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="capacityRiskTodoThresholdGeneral">{t("settings.general.todoThreshold", "Todo threshold")}</label>
        <input id="capacityRiskTodoThresholdGeneral" type="number" min={0} className="input" value={form.capacityRiskTodoThreshold ?? 20} onChange={(e) => setForm((f) => ({
            ...f,
            capacityRiskTodoThreshold: e.target.value === ""
                ? 0
                : Math.max(0, Number.parseInt(e.target.value, 10) || 0),
        }))}/>
        <small>{t("settings.general.bannerFiresWhenTodoCountIsStrictlyGreater", "Banner fires when todo count is strictly greater than this value (default 20). Applies when the banner is enabled.")}</small>
      </div>
      {/*
        FNXC:PlannerOversight 2026-07-14-18:11:
        Project default for the session advisor (LLM overseer agent). Per-task overrides
        come from Quick Add (eye icon) and task detail. Provider/model stay under workflow settings.
      */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.sessionAdvisor", "Session advisor (overseer agent)")}</h4>
      <div className="form-group">
        <label htmlFor="sessionAdvisorMode">{t("settings.general.defaultSessionAdvisorForNewTasks", "Default for new tasks")}</label>
        <select
          id="sessionAdvisorMode"
          className="select"
          value={form.sessionAdvisorEnabledByDefault ? "new-tasks" : "off"}
          onChange={(e) => setForm((f) => ({
            ...f,
            sessionAdvisorEnabledByDefault: e.target.value === "new-tasks",
          }))}
          data-testid="settings-session-advisor-default"
        >
          <option value="off">{t("settings.general.offDefault", "Off (default)")}</option>
          <option value="new-tasks">{t("settings.general.onForNewTasks", "On for new tasks")}</option>
        </select>
        <small>
          {t(
            "settings.general.sessionAdvisorHelp",
            "Controls whether newly created tasks enable the session advisor (live LLM overseer of the executor). Individual tasks can override this from Quick Add or task detail. Also set Session advisor model provider and model id under workflow settings before the advisor can run.",
          )}
        </small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.gitHubTracking", "GitHub Tracking")}</h4>
      <div className="form-group">
        <label htmlFor="githubTrackingMode">{t("settings.general.defaultTrackingModeForNewTasks", "Default tracking mode for new tasks")}</label>
        <select id="githubTrackingMode" className="select" value={form.githubTrackingEnabledByDefault ? "new-tasks" : "off"} onChange={(e) => setForm((f) => ({
            ...f,
            githubTrackingEnabledByDefault: e.target.value === "new-tasks",
        }))}>
          <option value="off">{t("settings.general.offDefault", "Off (default)")}</option>
          <option value="new-tasks">{t("settings.general.onForNewTasks", "On for new tasks")}</option>
        </select>
        <small>{t("settings.general.controlsWhetherNewlyCreatedTasksHaveGitHubIssue", " Controls whether newly created tasks have GitHub issue tracking enabled by default. Individual tasks can still override this from the task detail modal. ")}</small>
        {/*
          FNXC:SettingsGeneral 2026-06-22-03:20:
          Tracking-issue helper copy. The FN-6771 JSX→t() extraction left a raw HTML
          entity ("&apos;") in this default string. As a t() argument the string is a
          plain JS value (not JSX-decoded), so the entity rendered verbatim as the
          literal "&apos;" instead of an apostrophe. Use a real apostrophe so the copy
          reads correctly in both modal and embedded presentations.
        */}
        <small>{t("settings.general.trackingIssuesUseThisTaskAposSTitle", " Tracking issues use this task's title. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models. ")}{!form.autoSummarizeTitles && !form.useAiMergeCommitSummary && !form.githubTrackingEnabledByDefault
            ? t("settings.general.enableSummarizationInProjectModelsToConfigureThatModel", " Enable summarization in Project Models to configure that model.")
            : ""}
        </small>
      </div>
      <div className="form-group">
        {/*
          FNXC:GithubImportTracking 2026-07-01-00:00:
          This checkbox is project-scoped and import-specific: operators can link imported GitHub issues to GitHub tracking without turning tracking on for every new task.
        */}
        <label htmlFor="githubLinkImportedIssuesToTracking" className="checkbox-label">
          <input id="githubLinkImportedIssuesToTracking" type="checkbox" checked={form.githubLinkImportedIssuesToTracking === true} onChange={(e) => setForm((f) => ({ ...f, githubLinkImportedIssuesToTracking: e.target.checked }))}/>{t("settings.general.alwaysLinkImportedGitHubIssuesToTracking", " Always link imported GitHub issues to GitHub tracking ")}</label>
        <small>{t("settings.general.whenEnabledImportedGitHubIssuesUseTheirSource", "When enabled, GitHub issue imports become tracked tasks that adopt the source issue. This does not turn GitHub tracking on for ordinary new tasks. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="projectGithubTrackingDefaultRepoGeneral">{t("settings.general.projectDefaultTrackingRepo", "Project default tracking repo")}</label>
        <TrackingRepoSelect id="projectGithubTrackingDefaultRepoGeneral" ariaLabel="Project default tracking repo" value={form.githubTrackingDefaultRepo ?? ""} options={projectTrackingRepoOptions} loading={projectTrackingRepoLoading} error={projectTrackingRepoError ?? undefined} placeholder={t("settings.general.ownerRepo", "owner/repo")} onChange={(nextValue) => setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))}/>
        <small>{t("settings.general.defaultRepoUsedWhenCreatingGitHubIssuesFor", "Default repo used when creating GitHub issues for tracked tasks. Falls back to the global default if blank.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="githubTrackingDedupEnabled" className="checkbox-label">
          <input id="githubTrackingDedupEnabled" type="checkbox" checked={form.githubTrackingDedupEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, githubTrackingDedupEnabled: e.target.checked }))}/>{t("settings.general.searchTheTrackingRepoForLikelyDuplicatesBefore", " Search the tracking repo for likely duplicates before opening a new issue ")}</label>
        <small>{t("settings.general.whenEnabledFusionChecksOpenAndClosedIssues", " When enabled, Fusion checks open and closed issues in the target repo for likely duplicates (using File Scope paths and key symptoms) before creating a new tracking issue. Uncheck to always create a new issue. Default: enabled. ")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.gitLabConfiguration", "GitLab Configuration")}</h4>
      {/*
        FNXC:GitLabEnablement 2026-07-02-00:00:
        FN-7453 keeps saved GitLab URL settings separate from the active integration switch. The disclosure is collapsed by default to reduce Settings noise; the summary toggle remains reachable without expanding advanced self-managed URL fields.
      */}
      <details className="settings-gitlab-disclosure" data-testid="project-gitlab-configuration-disclosure">
        <summary>
          <span className="settings-gitlab-disclosure__title">{t("settings.general.gitLabConfiguration", "GitLab Configuration")}</span>
          <label className="checkbox-label settings-gitlab-disclosure__toggle" htmlFor="gitlabEnabled" onClick={(event) => event.stopPropagation()}>
            <input id="gitlabEnabled" type="checkbox" checked={form.gitlabEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, gitlabEnabled: e.target.checked }))}/>
            {t("settings.general.enableGitLabIntegration", "Enable GitLab integration")}
          </label>
        </summary>
        <small className="settings-description">{form.gitlabEnabled === false ? t("settings.general.gitLabDisabledHint", "GitLab API imports, comments, close/reopen, and refresh operations are disabled. Saved URLs and tokens remain stored for re-enable.") : t("settings.general.gitLabEnabledHint", "Configure GitLab.com or self-managed GitLab URLs. Blank values inherit global fallbacks and then GitLab.com. No default — unset (unset behaves as enabled until explicitly disabled).")}</small>
        <div className="settings-gitlab-disclosure__body" aria-disabled={form.gitlabEnabled === false}>
          <div className="form-group">
            <label htmlFor="gitlabInstanceUrl">{t("settings.general.gitLabInstanceUrl", "GitLab instance URL")}</label>
            <input id="gitlabInstanceUrl" className="input" type="url" placeholder="https://gitlab.com" value={form.gitlabInstanceUrl ?? ""} disabled={form.gitlabEnabled === false} onChange={(e) => setForm((f) => ({ ...f, gitlabInstanceUrl: e.target.value || undefined }))}/>
            <small>{t("settings.general.gitLabInstanceUrlHint", "Blank uses GitLab.com or the global default. Set an absolute http:// or https:// URL for self-managed GitLab, such as https://gitlab.example.com/gitlab.")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="gitlabApiBaseUrl">{t("settings.general.gitLabApiBaseUrlOptional", "GitLab API base URL (optional / advanced)")}</label>
            <input id="gitlabApiBaseUrl" className="input" type="url" placeholder="https://gitlab.com/api/v4" value={form.gitlabApiBaseUrl ?? ""} disabled={form.gitlabEnabled === false} onChange={(e) => setForm((f) => ({ ...f, gitlabApiBaseUrl: e.target.value || undefined }))}/>
            <small>{t("settings.general.gitLabApiBaseUrlHint", "Blank derives <instance>/api/v4. Override only when a self-managed GitLab API is served from a different absolute http:// or https:// URL.")}</small>
          </div>
        </div>
      </details>
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
