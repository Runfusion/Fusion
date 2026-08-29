import "./ReportsView.css";
import { ReportComparisonDrawer } from "./components/ReportComparisonDrawer.js";
import { ReportDetailPanel } from "./components/ReportDetailPanel.js";
import { ReportEmptyState } from "./components/ReportEmptyState.js";
import { ReportFiltersBar } from "./components/ReportFiltersBar.js";
import { ReportListItem } from "./components/ReportListItem.js";
import type { ToastType } from "./types.js";
import { useReports } from "./useReports.js";
import { useViewportMode } from "./useViewportMode.js";

export function ReportsView({ projectId, addToast }: { projectId?: string; addToast: (message: string, type?: ToastType) => void }) {
  const model = useReports({ projectId, addToast });
  const { mobile } = useViewportMode();
  const agents = [...new Set(model.reports.flatMap((r) => ((r.metadata?.agentIds as string[] | undefined) ?? [])))];
  return <div className="reports-view">
    <div className="reports-view-header"><h2>Reports</h2><button className="btn btn-sm" onClick={model.enterCompareMode}>Compare</button></div>
    <ReportFiltersBar filters={model.filters} onChange={model.setFilters} agents={agents} />
    <div className="reports-layout" data-mobile={mobile ? "true" : "false"}>
      <div className="reports-list">{model.reports.length === 0 ? <ReportEmptyState /> : model.reports.map((report) => <ReportListItem key={report.id} report={report} selected={model.selectedId === report.id} onSelect={model.selectId} />)}</div>
      <ReportDetailPanel report={model.selectedReport} projectId={projectId} />
    </div>
    {model.compareMode ? <ReportComparisonDrawer reports={model.reports} leftId={model.compareA} rightId={model.compareB} onPick={model.setCompareSlot} onClose={model.closeCompareMode} projectId={projectId} /> : null}
  </div>;
}
