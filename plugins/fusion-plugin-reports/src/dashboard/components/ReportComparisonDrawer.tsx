import { useMemo } from "react";
import type { ReportRecord } from "../types.js";
import { useReportPreview } from "../useReportPreview.js";
import { useReportSectionDiff } from "../useReportSectionDiff.js";

export function ReportComparisonDrawer({ reports, leftId, rightId, onPick, onClose, projectId }: { reports: ReportRecord[]; leftId?: string; rightId?: string; onPick: (slot: "a" | "b", id: string) => void; onClose: () => void; projectId?: string }) {
  const left = useMemo(() => reports.find((r) => r.id === leftId), [reports, leftId]);
  const right = useMemo(() => reports.find((r) => r.id === rightId), [reports, rightId]);
  const leftPreview = useReportPreview(leftId, projectId);
  const rightPreview = useReportPreview(rightId, projectId);
  const diff = useReportSectionDiff(left, right);
  return <div className="modal-overlay open reports-compare-overlay" role="dialog" aria-modal="true" aria-label="Compare reports">
    <div className="modal modal-lg reports-compare">
      <div className="modal-header reports-compare-header"><h3>Compare reports</h3><button className="btn btn-sm" onClick={onClose}>Close</button></div>
      <div className="reports-compare-pickers"><select className="select" value={leftId ?? ""} onChange={(e) => onPick("a", e.target.value)}>{reports.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
      <select className="select" value={rightId ?? ""} onChange={(e) => onPick("b", e.target.value)}>{reports.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></div>
      <div className="reports-compare-frames"><iframe sandbox="allow-same-origin" srcDoc={leftPreview.html} title="Report A" /><iframe sandbox="allow-same-origin" srcDoc={rightPreview.html} title="Report B" /></div>
      <div>Changed: {diff.changed.map((s) => s.id).join(", ")}</div>
    </div>
  </div>;
}
