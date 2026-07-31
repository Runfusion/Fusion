import { useTranslation } from "react-i18next";
import { isCompleteColumnRole } from "../utils/columnRoles";
import type { Task } from "@fusion/core";

interface MergeDetailsProps {
  /** Resolved column flags for this task, from the tab that renders it. */
  columnFlags?: Parameters<typeof isCompleteColumnRole>[0];
  task: Task;
}

function shortSha(sha?: string, t?: (key: string, defaultValue: string) => string): string {
  if (!sha) return t ? t("merge.unknown", "Unknown") : "Unknown";
  return sha.slice(0, 7);
}

export function MergeDetails({ task, columnFlags }: MergeDetailsProps) {
  const { t } = useTranslation("app");
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-15:20 (batch-dashboard-app):
  COMPLETE role, resolved. This panel shows the merge commit for finished work; keyed on the literal
  it rendered NOTHING on a renamed board, so an operator could not see what had actually landed.
  */
  if (!isCompleteColumnRole(columnFlags, task.column) || !task.mergeDetails) {
    return null;
  }

  const details = task.mergeDetails;

  return (
    <div className="detail-section">
      <h4>{t("merge.title", "Merge Details")}</h4>
      <div className="pr-card merge-details-card">
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span className="detail-log-action">{t("merge.status", "Status")}</span>
            <span className="detail-log-outcome">{details.mergeConfirmed === false ? t("merge.recordedNoConfirm", "Recorded without local merge confirmation") : t("merge.mergedSuccess", "Merged successfully")}</span>
          </div>
        </div>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span className="detail-log-action">{t("merge.commit", "Commit")}</span>
            <span className="detail-log-outcome">{shortSha(details.commitSha, t)}</span>
          </div>
        </div>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span
              className="detail-log-action"
              title={t("merge.shortstatTitle", "Final commit shortstat; for the full landed diff across all task commits, see the Changes tab.")}
            >
              {t("merge.filesChanged", "Files in merge commit")}
            </span>
            <span className="detail-log-outcome">{details.filesChanged ?? 0}</span>
          </div>
        </div>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span
              className="detail-log-action"
              title={t("merge.shortstatTitle", "Final commit shortstat; for the full landed diff across all task commits, see the Changes tab.")}
            >
              {t("merge.insertionsDeletions", "Merge-commit insertions / deletions")}
            </span>
            <span className="detail-log-outcome">+{details.insertions ?? 0} / -{details.deletions ?? 0}</span>
          </div>
        </div>
        {details.mergedAt ? (
          <div className="detail-log-entry">
            <div className="detail-log-header">
              <span className="detail-log-action">{t("merge.mergedAt", "Merged at")}</span>
              <span className="detail-log-outcome">{new Date(details.mergedAt).toLocaleString()}</span>
            </div>
          </div>
        ) : null}
        {details.prNumber ? (
          <div className="detail-log-entry">
            <div className="detail-log-header">
              <span className="detail-log-action">{t("merge.pr", "PR")}</span>
              {task.prInfo?.url ? (
                <a
                  className="detail-source-link detail-log-outcome"
                  href={task.prInfo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  #{details.prNumber}
                </a>
              ) : (
                <span className="detail-log-outcome">#{details.prNumber}</span>
              )}
            </div>
          </div>
        ) : null}
        {details.mergeCommitMessage ? (
          <div className="detail-log-entry">
            <div className="detail-log-header">
              <span className="detail-log-action">{t("merge.message", "Message")}</span>
            </div>
            <div className="detail-log-outcome">{details.mergeCommitMessage}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
