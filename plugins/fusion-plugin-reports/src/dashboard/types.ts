import type { Report, ReportCadence, ReportStatus } from "../store/report-types.js";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ReportFilters {
  cadence: "all" | ReportCadence;
  status: "all" | ReportStatus;
  from: string;
  to: string;
  q: string;
  agentId: string;
}

export interface SectionRef {
  id: string;
  label: string;
  hash: string;
}

export type ReportRecord = Report;

export type ReportListItemVm = Pick<ReportRecord, "id" | "title" | "cadence" | "status" | "periodStart" | "periodEnd" | "createdAt" | "metadata">;
