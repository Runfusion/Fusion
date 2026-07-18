import type { ReportActionType } from "@fusion/core";

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json();
}

export interface ReportActivityTraceEntry { ts: string; kind: string; label: string; }
export interface ReportContextInput { actionType: ReportActionType; userPrompt: string; contextRefs?: { taskId?: string; agentId?: string }; activityTrace?: ReportActivityTraceEntry[]; screenshotArtifactId?: string; }

export async function uploadReportScreenshot(blob: Blob, contextRefs?: { taskId?: string; agentId?: string }): Promise<{ artifactId: string; uri?: string }> {
  const form = new FormData();
  form.append("screenshot", blob, "report-screenshot.jpg");
  if (contextRefs) form.append("contextRefs", JSON.stringify(contextRefs));
  const response = await fetch("/api/report/attachment", { method: "POST", body: form });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json();
}

export function reportDraft(input: ReportContextInput) { return post("/api/report/draft", input); }
export function reportFile(input: { actionType: ReportActionType; report: unknown; endorseIssueNumber?: number; endorseDiscussionId?: string; activityTrace?: ReportActivityTraceEntry[]; screenshotArtifactId?: string }) { return post("/api/report/file", input); }
export function reportHelp(question: string) { return post("/api/report/help", { question }); }
