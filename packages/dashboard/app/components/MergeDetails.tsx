import type { Task } from "@kb/core";

interface MergeDetailsProps {
  task: Task;
}

function shortSha(sha?: string): string {
  if (!sha) return "Unknown";
  return sha.slice(0, 7);
}

export function MergeDetails({ task }: MergeDetailsProps) {
  if (task.column !== "done" || !task.mergeDetails) {
    return null;
  }

  const details = task.mergeDetails;

  return (
    <div className="detail-section">
      <h4>Merge Details</h4>
      <div className="pr-card" style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12 }}>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span className="detail-log-action">Status</span>
            <span className="detail-log-outcome">{details.mergeConfirmed === false ? "Recorded without local merge confirmation" : "Merged successfully"}</span>
          </div>
        </div>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span className="detail-log-action">Commit</span>
            <span className="detail-log-outcome">{shortSha(details.commitSha)}</span>
          </div>
        </div>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span className="detail-log-action">Files changed</span>
            <span className="detail-log-outcome">{details.filesChanged ?? 0}</span>
          </div>
        </div>
        <div className="detail-log-entry">
          <div className="detail-log-header">
            <span className="detail-log-action">Insertions / Deletions</span>
            <span className="detail-log-outcome">+{details.insertions ?? 0} / -{details.deletions ?? 0}</span>
          </div>
        </div>
        {details.mergedAt ? (
          <div className="detail-log-entry">
            <div className="detail-log-header">
              <span className="detail-log-action">Merged at</span>
              <span className="detail-log-outcome">{new Date(details.mergedAt).toLocaleString()}</span>
            </div>
          </div>
        ) : null}
        {details.prNumber ? (
          <div className="detail-log-entry">
            <div className="detail-log-header">
              <span className="detail-log-action">PR</span>
              <span className="detail-log-outcome">#{details.prNumber}</span>
            </div>
          </div>
        ) : null}
        {details.mergeCommitMessage ? (
          <div className="detail-log-entry">
            <div className="detail-log-header">
              <span className="detail-log-action">Message</span>
            </div>
            <div className="detail-log-outcome">{details.mergeCommitMessage}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
