import "./ReportsView.css";
import { Columns2, FileBarChart } from "lucide-react";
import { PluginDashboardViewHeader } from "@fusion/dashboard/app/plugins/PluginDashboardViewHeader";
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
    {/*
    FNXC:StandardizedPluginViews 2026-09-13-22:40:
    FN-379 replaces the local Reports title row with the cooperative plugin header, so a standalone host paints
    canonical chrome and a framing host stays the sole title owner. Compare remains a view-level action and keeps
    its existing controller callback; Reports has no creation, so no "+" is invented for it.
    */}
    <PluginDashboardViewHeader
      icon={FileBarChart}
      title="Reports"
      actions={(
        /*
        FNXC:StandardizedViewActions 2026-09-13-20:32:
        A header action that collapses to icon-only on phones must carry a decorative icon: the label is visually
        hidden there, so an icon-less button would be an empty touch target. The localized label stays the
        accessible name on every viewport.
        */
        <button
          type="button"
          className="btn btn-sm view-action-button view-action-button--mobile-icon-only"
          onClick={model.enterCompareMode}
          aria-label="Compare"
          data-testid="reports-compare-button"
        >
          <Columns2 size={16} aria-hidden="true" />
          <span className="view-action-button__label">Compare</span>
        </button>
      )}
    />
    <ReportFiltersBar filters={model.filters} onChange={model.setFilters} agents={agents} />
    <div className="reports-layout" data-mobile={mobile ? "true" : "false"}>
      <div className="reports-list">{model.reports.length === 0 ? <ReportEmptyState /> : model.reports.map((report) => <ReportListItem key={report.id} report={report} selected={model.selectedId === report.id} onSelect={model.selectId} />)}</div>
      <ReportDetailPanel report={model.selectedReport} projectId={projectId} />
    </div>
    {model.compareMode ? <ReportComparisonDrawer reports={model.reports} leftId={model.compareA} rightId={model.compareB} onPick={model.setCompareSlot} onClose={model.closeCompareMode} projectId={projectId} /> : null}
  </div>;
}
