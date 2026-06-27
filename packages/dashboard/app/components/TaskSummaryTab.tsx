import React from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TaskDetail, TaskStep, WorkflowStepResult } from "@fusion/core";
import { createMermaidCodeComponent, sharedRehypePlugins } from "./markdownPipeline";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";

const EMPTY_MARKDOWN_CHILD_SEPARATOR = "";
const STRING_OBJECT_TAG = "[object String]";

const markdownLinkifyCodeComponent: NonNullable<Components["code"]> = ({ children, ...props }) => {
  const text = React.Children.toArray(children).join(EMPTY_MARKDOWN_CHILD_SEPARATOR);
  const linkedChildren = linkifyFilePaths(text);
  if (linkedChildren.length === 1 && Object.prototype.toString.call(linkedChildren[0]) === STRING_OBJECT_TAG) {
    return <code {...props}>{children}</code>;
  }
  return <code {...props}>{linkedChildren}</code>;
};

const markdownLinkifyComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  code: createMermaidCodeComponent("task-summary-mermaid-diagram", markdownLinkifyCodeComponent),
};

interface TaskSummaryTabProps {
  task: TaskDetail;
}

function getCompletedSteps(steps: TaskStep[] | undefined): TaskStep[] {
  return (steps ?? []).filter((step) => step.status === "done" || step.status === "skipped");
}

function getRenderableWorkflowResults(results: WorkflowStepResult[] | undefined): WorkflowStepResult[] {
  return (results ?? []).filter((result) => result.status !== "pending");
}

/**
 * FNXC:TaskDetailSummaryTab 2026-06-27-00:00:
 * TaskSummaryTab aggregates read-only completion data already loaded on TaskDetail: agent-written summary, changed-file metadata, implementation steps, workflow-step outcomes, and retry counts. It does not fetch, persist, or generate AI content so done-task details remain a front-end composition only.
 */
export function TaskSummaryTab({ task }: TaskSummaryTabProps) {
  const { t } = useTranslation("app");
  const summary = task.summary?.trim();
  const changedFiles = task.mergeDetails?.landedFiles?.length
    ? task.mergeDetails.landedFiles
    : task.modifiedFiles ?? [];
  const completedSteps = getCompletedSteps(task.steps);
  const workflowResults = getRenderableWorkflowResults(task.workflowStepResults);
  const retryTotal = task.retrySummary?.total ?? 0;
  const hasChangedStats = task.mergeDetails?.filesChanged != null
    || task.mergeDetails?.insertions != null
    || task.mergeDetails?.deletions != null;
  const hasChangedContent = changedFiles.length > 0 || hasChangedStats || Boolean(task.mergeDetails?.commitSha);
  const hasAgentWork = completedSteps.length > 0 || workflowResults.length > 0 || retryTotal > 0;

  return (
    <div className="task-summary-tab" data-testid="task-summary-tab">
      <section className="task-summary-section task-summary-section--completion">
        <h4>{t("taskDetail.summaryTab.completionHeading", "Completion summary")}</h4>
        {summary ? (
          <div className="markdown-body task-summary-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sharedRehypePlugins} components={markdownLinkifyComponents}>
              {summary}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="task-summary-empty">{t("taskDetail.summaryTab.noCompletionSummary", "No completion summary was recorded for this task.")}</p>
        )}
      </section>

      {hasChangedContent ? (
        <section className="task-summary-section task-summary-section--changes">
          <h4>{t("taskDetail.summaryTab.changedHeading", "What changed")}</h4>
          {(hasChangedStats || task.mergeDetails?.commitSha) && (
            <dl className="task-summary-stats">
              {task.mergeDetails?.commitSha && (
                <div>
                  <dt>{t("taskDetail.summaryTab.commit", "Commit")}</dt>
                  <dd><code>{task.mergeDetails.commitSha.slice(0, 7)}</code></dd>
                </div>
              )}
              {task.mergeDetails?.filesChanged != null && (
                <div>
                  <dt>{t("taskDetail.summaryTab.filesChanged", "Files")}</dt>
                  <dd>{task.mergeDetails.filesChanged}</dd>
                </div>
              )}
              {task.mergeDetails?.insertions != null && (
                <div>
                  <dt>{t("taskDetail.summaryTab.insertions", "Added")}</dt>
                  <dd className="task-summary-diff-add">+{task.mergeDetails.insertions}</dd>
                </div>
              )}
              {task.mergeDetails?.deletions != null && (
                <div>
                  <dt>{t("taskDetail.summaryTab.deletions", "Removed")}</dt>
                  <dd className="task-summary-diff-del">-{task.mergeDetails.deletions}</dd>
                </div>
              )}
            </dl>
          )}
          {changedFiles.length > 0 ? (
            <ul className="task-summary-file-list">
              {changedFiles.map((path) => (
                <li key={path}><bdo dir="ltr">{path}</bdo></li>
              ))}
            </ul>
          ) : (
            <p className="task-summary-empty">{t("taskDetail.summaryTab.noChangedFiles", "No changed-file list is available for this task.")}</p>
          )}
        </section>
      ) : null}

      {hasAgentWork ? (
        <section className="task-summary-section task-summary-section--agent-work">
          <h4>{t("taskDetail.summaryTab.agentWorkHeading", "Work done by agents")}</h4>
          {completedSteps.length > 0 && (
            <div className="task-summary-subsection">
              <h5>{t("taskDetail.summaryTab.completedSteps", "Completed steps")}</h5>
              <ul className="task-summary-work-list">
                {completedSteps.map((step, index) => (
                  <li key={`${step.name}-${index}`}>
                    <span className={`task-summary-status task-summary-status--${step.status}`}>{step.status}</span>
                    <span>{step.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {workflowResults.length > 0 && (
            <div className="task-summary-subsection">
              <h5>{t("taskDetail.summaryTab.workflowResults", "Workflow results")}</h5>
              <ul className="task-summary-work-list">
                {workflowResults.map((result) => (
                  <li key={`${result.workflowStepId}-${result.completedAt ?? result.startedAt ?? result.workflowStepName}`}>
                    <span className={`task-summary-status task-summary-status--${result.status}`}>{result.status.replace("_", " ")}</span>
                    <span>{result.workflowStepName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {retryTotal > 0 && (
            <p className="task-summary-retries">
              {t("taskDetail.summaryTab.retries", "Agents retried this task {{count}} time{{plural}}.", { count: retryTotal, plural: retryTotal === 1 ? "" : "s" })}
            </p>
          )}
        </section>
      ) : (
        <section className="task-summary-section task-summary-section--agent-work">
          <h4>{t("taskDetail.summaryTab.agentWorkHeading", "Work done by agents")}</h4>
          <p className="task-summary-empty">{t("taskDetail.summaryTab.noAgentWork", "No completed steps or workflow results are available for this task.")}</p>
        </section>
      )}
    </div>
  );
}
