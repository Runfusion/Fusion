import { useMemo, useState } from "react";
import { approveReport, publishReport, rejectReport } from "../api.js";
import type { ReportRecord } from "../types.js";
import "./ReportApprovalPanel.css";

interface Props {
  report: ReportRecord;
  onReportChange: (report: ReportRecord) => void;
}

export function ReportApprovalPanel({ report, onReportChange }: Props) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const approvalState = report.approvalState ?? "not_required";
  const canApprove = approvalState === "awaiting_approval";
  const canPublish = approvalState === "approved";

  const history = useMemo(() => [...(report.approvalHistory ?? [])].reverse(), [report.approvalHistory]);

  async function run(action: "approve" | "reject" | "publish") {
    setBusy(true);
    setError(null);
    try {
      const next = action === "approve"
        ? await approveReport(report.id, note)
        : action === "reject"
          ? await rejectReport(report.id, note)
          : await publishReport(report.id);
      onReportChange(next);
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <section className="report-approval-panel">
    <div className="report-approval-panel__header">
      <h4>Approval</h4>
      <span className={`card-status-badge card-status-badge--${approvalState}`}>{approvalState}</span>
    </div>
    {canApprove ? <>
      <textarea className="input report-approval-panel__note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note" />
      <div className="report-approval-panel__actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => run("approve")}>Approve</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => run("reject")}>Reject</button>
      </div>
    </> : null}
    {canPublish ? <div className="report-approval-panel__actions"><button className="btn btn-primary" disabled={busy} onClick={() => run("publish")}>Publish</button></div> : null}
    {error ? <div className="form-error">{error}</div> : null}
    <ul className="report-approval-panel__history">
      {history.map((item, index) => <li key={`${item.decidedAt}-${index}`}>{item.action} by {item.decidedBy} at {item.decidedAt}{item.note ? ` — ${item.note}` : ""}</li>)}
    </ul>
  </section>;
}
