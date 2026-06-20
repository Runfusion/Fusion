import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkflowDefinition } from "@fusion/core";
import { ProjectDefaultWorkflowField } from "../../WorkflowSelector";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { fetchWorkflows } from "../../../api";
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
}
export function GeneralSection({ scopeBanner, form, setForm, projectId, addToast, prefixError, setPrefixError, projectTrackingRepoOptions, projectTrackingRepoLoading, projectTrackingRepoError, }: GeneralSectionProps) {
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
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.general.general", "General")}</h4>
      <div className="form-group">
        <label htmlFor="taskPrefix">{t("settings.general.taskPrefix", "Task Prefix")}</label>
        <input id="taskPrefix" type="text" placeholder={t("settings.general.fN", "FN")} value={form.taskPrefix || ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, taskPrefix: val || undefined }));
            if (val && !/^[A-Z]{1,10}$/.test(val)) {
                setPrefixError(t("settings.general.prefixMustBe110UppercaseLetters", "Prefix must be 1–10 uppercase letters"));
            }
            else {
                setPrefixError(null);
            }
        }}/>
        {prefixError && <small className="field-error">{prefixError}</small>}
        {!prefixError && <small>{t("settings.general.prefixForNewTaskIDsEGKB", "Prefix for new task IDs (e.g. KB, PROJ)")}</small>}
      </div>
      <div className="form-group">
        <ProjectDefaultWorkflowField projectId={projectId} addToast={addToast}/>
        <small>{t("settings.general.newTasksInheritThisCustomWorkflowsStepsOverridable", "New tasks inherit this custom workflow's steps (overridable per task)")}</small>
      </div>
      {builtinWorkflows.length > 0 && (<div className="form-group">
          <label>{t("settings.general.builtInWorkflows", "Built-in workflows")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            {builtinWorkflows.map((workflow) => (<label key={workflow.id} htmlFor={`builtin-workflow-${workflow.id}`} className="checkbox-label">
                <input id={`builtin-workflow-${workflow.id}`} type="checkbox" checked={enabledBuiltinWorkflowIds.has(workflow.id)} onChange={(e) => setBuiltinWorkflowEnabled(workflow.id, e.target.checked)}/>
                <span>{workflow.name}</span>
              </label>))}
          </div>
          <small>{t("settings.general.disabledBuiltInWorkflowsAreHiddenFromWorkflow", "Disabled built-in workflows are hidden from workflow pickers. Existing tasks that already use one continue to resolve.")}</small>
        </div>)}
      <div className="form-group">
        <label htmlFor="ephemeralAgentsEnabled" className="checkbox-label">
          <input id="ephemeralAgentsEnabled" type="checkbox" checked={form.ephemeralAgentsEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, ephemeralAgentsEnabled: e.target.checked }))}/>{t("settings.general.useEphemeralTaskWorkerAgents", " Use ephemeral task-worker agents ")}</label>
        <small>{t("settings.general.whenEnabledDefaultFusionSpawnsShortLived", " When enabled (default), Fusion spawns short-lived ")}<code>executor-FN-XXXX</code>{t("settings.general.agentsToRunEachTaskWhenDisabledOnly", " agents to run each task. When disabled, only permanent agents execute tasks and the scheduler auto-assigns work using the agent reporting chain. Tasks with no eligible permanent agent stay queued. ")}</small>
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
        <small>{t("settings.general.controlsHowFutureTaskSpecsHandleReleaseNote", " Controls how future task specs handle release-note artifacts at completion. Use changeset mode for repositories that follow ")}<code>.changeset</code>{t("settings.general.workflowsOrChangelogModeWhenContributorsShouldUpdate", " workflows, or changelog mode when contributors should update an existing changelog file. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="showQuickChatFAB" className="checkbox-label">
          <input id="showQuickChatFAB" type="checkbox" checked={form.showQuickChatFAB === true} onChange={(e) => setForm((f) => ({ ...f, showQuickChatFAB: e.target.checked }))}/>{t("settings.general.showQuickChatButton", " Show quick chat button ")}</label>
        <small>{t("settings.general.showTheFloatingChatButtonInTheDashboard", "Show the floating chat button in the dashboard. Chat is still accessible from the Chat tab in the mobile navigation.")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.chatHistory", "Chat history")}</h4>
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
        <small>{t("settings.general.warnOnTheBoardWhenTodoWorkExceeds", "Warn on the board when todo work exceeds the threshold and no idle agents are available.")}</small>
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
        <small>{t("settings.general.trackingIssuesUseThisTaskAposSTitle", " Tracking issues use this task&apos;s title. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models. ")}{!form.autoSummarizeTitles && !form.useAiMergeCommitSummary && !form.githubTrackingEnabledByDefault
            ? t("settings.general.enableSummarizationInProjectModelsToConfigureThatModel", " Enable summarization in Project Models to configure that model.")
            : ""}
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="projectGithubTrackingDefaultRepoGeneral">{t("settings.general.projectDefaultTrackingRepo", "Project default tracking repo")}</label>
        <TrackingRepoSelect id="projectGithubTrackingDefaultRepoGeneral" ariaLabel="Project default tracking repo" value={form.githubTrackingDefaultRepo ?? ""} options={projectTrackingRepoOptions} loading={projectTrackingRepoLoading} error={projectTrackingRepoError ?? undefined} placeholder={t("settings.general.ownerRepo", "owner/repo")} onChange={(nextValue) => setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))}/>
        <small>{t("settings.general.defaultRepoUsedWhenCreatingGitHubIssuesFor", "Default repo used when creating GitHub issues for tracked tasks. Falls back to the global default if blank.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="githubTrackingDedupEnabled" className="checkbox-label">
          <input id="githubTrackingDedupEnabled" type="checkbox" checked={form.githubTrackingDedupEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, githubTrackingDedupEnabled: e.target.checked }))}/>{t("settings.general.searchTheTrackingRepoForLikelyDuplicatesBefore", " Search the tracking repo for likely duplicates before opening a new issue ")}</label>
        <small>{t("settings.general.whenEnabledFusionChecksOpenAndClosedIssues", " When enabled, Fusion checks open and closed issues in the target repo for likely duplicates (using File Scope paths and key symptoms) before creating a new tracking issue. Uncheck to always create a new issue. ")}</small>
      </div>
    </>);
}
export default GeneralSection;
