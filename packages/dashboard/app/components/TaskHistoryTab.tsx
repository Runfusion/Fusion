import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { useTranslation } from "react-i18next";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { buildTaskHistory, type TaskHistoryLabel } from "../utils/taskHistory";
import { formatDurationMs } from "../utils/taskTiming";
import "./TaskHistoryTab.css";

const EMPTY_MARKDOWN_CHILD_SEPARATOR = "";

/*
FNXC:TaskHistory 2026-08-28-23:05:
Stage reports now render inside Summary, where a file-path link must remain one interactive control.
Flatten code children to text before linking so ReactMarkdown does not receive an already-linked button
and create an invalid nested-button tree.
*/
const markdownCode: NonNullable<Components["code"]> = ({ children, ...props }) => {
  const text = React.Children.toArray(children).join(EMPTY_MARKDOWN_CHILD_SEPARATOR);
  const linkedChildren = linkifyFilePaths(text);
  if (linkedChildren.length === 1 && linkedChildren[0]?.constructor === String) {
    return <code {...props}>{children}</code>;
  }
  return <code {...props}>{linkedChildren}</code>;
};

const markdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  code: markdownCode,
  pre: ({ children, className, ...props }) => <pre {...props} className={["workflow-markdown-pre", className].filter(Boolean).join(" ")}>{linkifyReactChildren(children)}</pre>,
  table: ({ children, className, ...props }) => <table {...props} className={["workflow-markdown-table", className].filter(Boolean).join(" ")}>{children}</table>,
};

export interface TaskHistoryTabProps {
  task: TaskDetail;
  results: WorkflowStepResult[];
  loading?: boolean;
}

function formatTimestamp(iso?: string): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replaceAll("_", "-");
}

/*
FNXC:TaskHistory 2026-08-29-12:20:
Operators need Plan, Code, and Review reports visible in sequence rather than hidden in an accordion.
Merge facts belong only to the trailing MergeDetails panel for completed work. Every stage therefore
renders a static heading followed immediately by its reports or stage-specific empty state, with no
toggle shell or collapsed state. Entry badges stay driven by entry.verdict ?? entry.status, so a
completion report deliberately left without either value by the projection emits no status pill.
*/
export function TaskHistoryTab({ task, results, loading = false }: TaskHistoryTabProps) {
  const { t } = useTranslation("app");
  const stages = useMemo(() => buildTaskHistory(task, results), [task, results]);
  const renderLabel = (label: TaskHistoryLabel): string => label.kind === "text"
    ? label.text
    : t(label.key, label.defaultValue, label.params);

  return (
    <div className="task-history" data-testid="task-history-tab">
      {loading && results.length === 0 && (task.workflowStepResults?.length ?? 0) === 0 && (
        <div className="task-history-loading">{t("taskHistory.loading", "Loading history…")}</div>
      )}
      {stages.map((stage) => {
        const stageName = t(`taskHistory.stage.${stage.id}`, stage.id);
        return (
          <section className="task-history-stage" key={stage.id} data-testid={`task-history-stage-${stage.id}`}>
            <div className="task-history-stage-heading">
              <h4 className="task-history-stage-title">{stageName}</h4>
              <span className="task-history-count" data-testid={`task-history-count-${stage.id}`}>{stage.entries.length}</span>
            </div>
            <div className="task-history-panel">
              {stage.entries.length === 0 ? (
                <p className="task-history-empty">{t(`taskHistory.empty.${stage.id}`, "No reports recorded.")}</p>
              ) : (
                <div className="task-history-entries">
                  {stage.entries.map((entry) => {
                    const token = entry.verdict ?? entry.status;
                    return (
                      <article className="task-history-entry" key={entry.id}>
                        <header className="task-history-entry-header">
                          <h5>{renderLabel(entry.title)}</h5>
                          {token && (
                            <span className={`workflow-result-badge workflow-result-badge--${normalizeToken(token)}`}>
                              {t(`taskHistory.verdict.${normalizeToken(token)}`, token)}
                            </span>
                          )}
                        </header>
                        {(entry.timestamp || entry.durationMs != null) && (
                          <div className="task-history-entry-timing">
                            {entry.timestamp && <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>}
                            {entry.durationMs != null && (
                              <span className="task-history-entry-duration" data-testid="task-history-entry-duration">
                                {t("taskHistory.entry.duration", "Took {{duration}}", { duration: formatDurationMs(entry.durationMs) })}
                              </span>
                            )}
                          </div>
                        )}
                        {entry.meta && entry.meta.length > 0 && (
                          <dl className="task-history-meta">
                            {entry.meta.map((item, index) => (
                              <div key={`${entry.id}:meta:${index}`}><dt>{renderLabel(item.label)}</dt><dd>{item.value}</dd></div>
                            ))}
                          </dl>
                        )}
                        <div className="task-history-body markdown-body">
                          {entry.body?.trim() ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{entry.body}</ReactMarkdown>
                          ) : entry.verdict ? (
                            /*
                            FNXC:TaskHistory 2026-08-28-21:23:
                            A legacy review outcome with no captured rationale must say that the reviewer
                            recorded no notes rather than imply that the entire report record is missing.
                            */
                            <p data-testid="task-history-entry-no-notes">{t("taskHistory.entry.verdictNoNotes", "The reviewer recorded no notes for this verdict.")}</p>
                          ) : (
                            <p data-testid="task-history-entry-no-body">{t("taskHistory.entry.noBody", "No report body was recorded.")}</p>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
