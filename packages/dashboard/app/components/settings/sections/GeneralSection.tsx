/**
 * Project General section (U9 / KTD-10).
 *
 * Project-scoped general settings: task prefix, default workflow, ephemeral
 * agents, completion-documentation mode, quick-chat FAB, chat-history/mail/log
 * retention, chat-room compaction tuning, capacity-risk banner, and GitHub
 * tracking defaults. The prefix-validation error and the project tracking-repo
 * options are owned by the shell (the prefix error gates Save; the repo options
 * are fetched once) and relayed as props. Keys, validation regexes, and the
 * cross-field summarizer hint are preserved verbatim from the original inline
 * JSX.
 */
import type { ReactNode } from "react";
import { ProjectDefaultWorkflowField } from "../../WorkflowSelector";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import type { ToastType } from "../../../hooks/useToast";
import type { SectionBaseProps } from "./context";

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

export function GeneralSection({
  scopeBanner,
  form,
  setForm,
  projectId,
  addToast,
  prefixError,
  setPrefixError,
  projectTrackingRepoOptions,
  projectTrackingRepoLoading,
  projectTrackingRepoError,
}: GeneralSectionProps) {
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">General</h4>
      <div className="form-group">
        <label htmlFor="taskPrefix">Task Prefix</label>
        <input
          id="taskPrefix"
          type="text"
          placeholder="FN"
          value={form.taskPrefix || ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, taskPrefix: val || undefined }));
            if (val && !/^[A-Z]{1,10}$/.test(val)) {
              setPrefixError("Prefix must be 1–10 uppercase letters");
            } else {
              setPrefixError(null);
            }
          }}
        />
        {prefixError && <small className="field-error">{prefixError}</small>}
        {!prefixError && <small>Prefix for new task IDs (e.g. KB, PROJ)</small>}
      </div>
      <div className="form-group">
        <ProjectDefaultWorkflowField projectId={projectId} addToast={addToast} />
        <small>New tasks inherit this custom workflow's steps (overridable per task)</small>
      </div>
      <div className="form-group">
        <label htmlFor="ephemeralAgentsEnabled" className="checkbox-label">
          <input
            id="ephemeralAgentsEnabled"
            type="checkbox"
            checked={form.ephemeralAgentsEnabled !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, ephemeralAgentsEnabled: e.target.checked }))
            }
          />
          Use ephemeral task-worker agents
        </label>
        <small>
          When enabled (default), Fusion spawns short-lived <code>executor-FN-XXXX</code> agents to run each task. When disabled, only permanent agents execute tasks and the scheduler auto-assigns work using the agent reporting chain. Tasks with no eligible permanent agent stay queued.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="completionDocumentationMode">Completion Documentation Automation</label>
        <select
          id="completionDocumentationMode"
          value={form.completionDocumentationMode || "off"}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              completionDocumentationMode: e.target.value as "off" | "changeset" | "changelog",
            }))
          }
        >
          <option value="off">Off</option>
          <option value="changeset">Require changeset (.changeset/*.md)</option>
          <option value="changelog">Require changelog update (existing changelog)</option>
        </select>
        <small>
          Controls how future task specs handle release-note artifacts at completion. Use changeset mode for repositories that follow
          <code>.changeset</code> workflows, or changelog mode when contributors should update an existing changelog file.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="showQuickChatFAB" className="checkbox-label">
          <input
            id="showQuickChatFAB"
            type="checkbox"
            checked={form.showQuickChatFAB === true}
            onChange={(e) =>
              setForm((f) => ({ ...f, showQuickChatFAB: e.target.checked }))
            }
          />
          Show quick chat button
        </label>
        <small>Show the floating chat button in the dashboard. Chat is still accessible from the Chat tab in the mobile navigation.</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">Chat history</h4>
      <div className="form-group">
        <label htmlFor="chatAutoCleanupDays">Auto-cleanup old chats</label>
        <select
          id="chatAutoCleanupDays"
          className="select"
          value={form.chatAutoCleanupDays ?? 0}
          onChange={(e) =>
            setForm((f) => ({ ...f, chatAutoCleanupDays: Number(e.target.value) || 0 }))
          }
        >
          <option value={0}>Off</option>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
        <small>Delete chat sessions and rooms that have been idle for this many days. Default: Off.</small>
      </div>
      <div className="form-group">
        <label htmlFor="mailAutoCleanupDays">Auto-prune old mail</label>
        <select
          id="mailAutoCleanupDays"
          className="select"
          value={form.mailAutoCleanupDays ?? 0}
          onChange={(e) =>
            setForm((f) => ({ ...f, mailAutoCleanupDays: Number(e.target.value) || 0 }))
          }
        >
          <option value={0}>Off</option>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
        <small>Delete inbox/outbox messages older than this many days. Default: Off. 7 days is the suggested setting.</small>
      </div>
      <div className="form-group">
        <label htmlFor="operationalLogRetentionDays">Operational log retention</label>
        <select
          id="operationalLogRetentionDays"
          className="select"
          value={form.operationalLogRetentionDays ?? 30}
          onChange={(e) =>
            setForm((f) => ({ ...f, operationalLogRetentionDays: Number(e.target.value) || 0 }))
          }
        >
          <option value={0}>Off</option>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
        <small>
          Lowering this window means Reliability metrics/charts and the Activity feed will not show history older
          than the selected range. Per-task task detail history is unaffected. Default: 30 days.
        </small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">Chat Rooms</h4>
      <div className="form-group">
        <label htmlFor="chatRoomRecentVerbatimMessages">Recent verbatim room messages</label>
        <input
          id="chatRoomRecentVerbatimMessages"
          type="number"
          min="1"
          className="input"
          placeholder="25"
          value={form.chatRoomRecentVerbatimMessages ?? ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, chatRoomRecentVerbatimMessages: Number(e.target.value) || undefined }))
          }
        />
        <small>Number of most-recent chat-room messages kept verbatim in the responder transcript. Older messages are compacted into a summary block. Default: 25.</small>
      </div>
      <div className="form-group">
        <label htmlFor="chatRoomCompactionFetchLimit">Room compaction fetch limit</label>
        <input
          id="chatRoomCompactionFetchLimit"
          type="number"
          min="1"
          className="input"
          placeholder="200"
          value={form.chatRoomCompactionFetchLimit ?? ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, chatRoomCompactionFetchLimit: Number(e.target.value) || undefined }))
          }
        />
        <small>Upper bound on messages fetched from the room store for compaction consideration. Default: 200.</small>
      </div>
      <div className="form-group">
        <label htmlFor="chatRoomSummaryMaxChars">Room summary max characters</label>
        <input
          id="chatRoomSummaryMaxChars"
          type="number"
          min="200"
          className="input"
          placeholder="3000"
          value={form.chatRoomSummaryMaxChars ?? ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, chatRoomSummaryMaxChars: Number(e.target.value) || undefined }))
          }
        />
        <small>Hard cap on the synthesized "Earlier room context" summary block. Default: 3000.</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">Capacity Risk Banner</h4>
      <div className="form-group">
        <label htmlFor="capacityRiskBannerEnabled" className="checkbox-label">
          <input
            id="capacityRiskBannerEnabled"
            type="checkbox"
            checked={form.capacityRiskBannerEnabled === true}
            onChange={(e) =>
              setForm((f) => ({ ...f, capacityRiskBannerEnabled: e.target.checked }))
            }
          />
          Show capacity risk banner
        </label>
        <small>Warn on the board when todo work exceeds the threshold and no idle agents are available.</small>
      </div>
      <div className="form-group">
        <label htmlFor="capacityRiskTodoThresholdGeneral">Todo threshold</label>
        <input
          id="capacityRiskTodoThresholdGeneral"
          type="number"
          min={0}
          className="input"
          value={form.capacityRiskTodoThreshold ?? 20}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              capacityRiskTodoThreshold:
                e.target.value === ""
                  ? 0
                  : Math.max(0, Number.parseInt(e.target.value, 10) || 0),
            }))
          }
        />
        <small>Banner fires when todo count is strictly greater than this value (default 20). Applies when the banner is enabled.</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">GitHub Tracking</h4>
      <div className="form-group">
        <label htmlFor="githubTrackingMode">Default tracking mode for new tasks</label>
        <select
          id="githubTrackingMode"
          className="select"
          value={form.githubTrackingEnabledByDefault ? "new-tasks" : "off"}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              githubTrackingEnabledByDefault: e.target.value === "new-tasks",
            }))
          }
        >
          <option value="off">Off (default)</option>
          <option value="new-tasks">On for new tasks</option>
        </select>
        <small>
          Controls whether newly created tasks have GitHub issue tracking enabled by default. Individual tasks can still override this from the task detail modal.
        </small>
        <small>
          Tracking issues use this task&apos;s title. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models.
          {!form.autoSummarizeTitles && !form.useAiMergeCommitSummary && !form.githubTrackingEnabledByDefault
            ? " Enable summarization in Project Models to configure that model."
            : ""}
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="projectGithubTrackingDefaultRepoGeneral">Project default tracking repo</label>
        <TrackingRepoSelect
          id="projectGithubTrackingDefaultRepoGeneral"
          ariaLabel="Project default tracking repo"
          value={form.githubTrackingDefaultRepo ?? ""}
          options={projectTrackingRepoOptions}
          loading={projectTrackingRepoLoading}
          error={projectTrackingRepoError ?? undefined}
          placeholder="owner/repo"
          onChange={(nextValue) =>
            setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))
          }
        />
        <small>Default repo used when creating GitHub issues for tracked tasks. Falls back to the global default if blank.</small>
      </div>
      <div className="form-group">
        <label htmlFor="githubTrackingDedupEnabled" className="checkbox-label">
          <input
            id="githubTrackingDedupEnabled"
            type="checkbox"
            checked={form.githubTrackingDedupEnabled !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, githubTrackingDedupEnabled: e.target.checked }))
            }
          />
          Search the tracking repo for likely duplicates before opening a new issue
        </label>
        <small>
          When enabled, Fusion checks open and closed issues in the target repo for likely duplicates (using File Scope paths and key symptoms) before creating a new tracking issue. Uncheck to always create a new issue.
        </small>
      </div>
    </>
  );
}

export default GeneralSection;
