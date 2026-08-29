import type { ReportRecord } from "./types.js";
import type { ShareBlocks } from "../share-blocks.js";

const BASE = "/api/plugins/reports";

interface ListReportsParams {
  cadence?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  agentId?: string;
  projectId?: string;
}

function qp(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => typeof value === "string" && value.length > 0) as Array<[string, string]>;
  if (entries.length === 0) return "";
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
}

async function request<T>(path: string, init?: RequestInit, responseType: "json" | "text" = "json"): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (responseType === "text") return (await response.text()) as T;
  return (await response.json()) as T;
}

export async function listReports(params: ListReportsParams = {}): Promise<ReportRecord[]> {
  const data = await request<{ reports: ReportRecord[] }>(`/reports${qp({ ...params })}`);
  return data.reports;
}

export async function getReport(id: string, projectId?: string): Promise<ReportRecord> {
  const data = await request<{ report: ReportRecord }>(`/reports/${encodeURIComponent(id)}${qp({ projectId })}`);
  return data.report;
}

export function getReportPreviewHtml(id: string, projectId?: string): Promise<string> {
  return request<string>(`/reports/${encodeURIComponent(id)}/preview.html${qp({ projectId })}`, undefined, "text");
}

export function getReportExportUrl(id: string, projectId?: string): string {
  return `${BASE}/reports/${encodeURIComponent(id)}/export.html${qp({ projectId })}`;
}

export async function approveReport(id: string, note?: string): Promise<ReportRecord> {
  const data = await request<{ report: ReportRecord }>(`/reports/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
  return data.report;
}

export async function rejectReport(id: string, note?: string): Promise<ReportRecord> {
  const data = await request<{ report: ReportRecord }>(`/reports/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
  return data.report;
}

export async function publishReport(id: string): Promise<ReportRecord> {
  const data = await request<{ report: ReportRecord }>(`/reports/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return data.report;
}

export async function getShareBlocks(id: string): Promise<ShareBlocks> {
  return request<ShareBlocks>(`/reports/${encodeURIComponent(id)}/share-blocks`);
}
