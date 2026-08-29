import type { ReportListItemVm } from "../types.js";

export function ReportListItem({ report, selected, onSelect }: { report: ReportListItemVm; selected: boolean; onSelect: (id: string) => void }) {
  return <button className="card reports-list-item" data-selected={selected ? "true" : "false"} onClick={() => onSelect(report.id)}>
    <div className="card-header"><span className="card-title">{report.title}</span></div>
    <div className="card-meta"><span>{report.cadence}</span><span>{report.status}</span><span>{report.periodStart} → {report.periodEnd}</span></div>
  </button>;
}
