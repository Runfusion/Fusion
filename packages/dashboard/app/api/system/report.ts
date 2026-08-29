import type { ReportActionType, ReportTarget } from "@fusion/core";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json() as Promise<T>;
}

/** Filed report responses expose the actual GitHub destination after fallback. */
export interface FiledReportResponse { kind: "filed"; url: string; destination: "issue" | "discussion"; }
export interface ReportResponse {
  kind: string;
  destination?: "issue" | "discussion";
  url?: string;
  message?: string;
  report?: { userPrompt: string; sourcePrompt?: string; summary?: string; body?: string; context?: Record<string, unknown>; sessionToken?: string };
  issue?: { number: number; url: string; title: string; discussionId?: string; roadmap?: true };
  answer?: { summary?: string; content?: string };
}

export interface ReportContextInput { actionType: ReportActionType; userPrompt: string; contextRefs?: { taskId?: string; agentId?: string }; activityTrace?: string[]; screenshotArtifactId?: string; }
export function reportDraft(input: ReportContextInput & { targetType?: ReportTarget; discussionCategoryId?: string }) { return post<ReportResponse>("/api/report/draft", input); }
export function reportFile(input: { actionType: ReportActionType; report: unknown; targetType?: ReportTarget; discussionCategoryId?: string; endorseIssueNumber?: number; endorseDiscussionId?: string; endorseRoadmapIssueNumber?: number; activityTrace?: string[]; screenshotArtifactId?: string }) { return post<ReportResponse>("/api/report/file", input); }
export function reportHelp(question: string) { return post<{ answered?: boolean; answer?: { summary?: string; content?: string } }>("/api/report/help", { question }); }

/** Upload is intentionally multipart: screenshot bytes never join JSON report text. */
export async function reportAttachment(screenshot: Blob): Promise<{ artifactId: string }> {
  const form = new FormData(); form.append("screenshot", screenshot, "report-screenshot.png");
  const response = await fetch("/api/report/attachment", { method: "POST", body: form });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json() as Promise<{ artifactId: string }>;
}

export interface DiscussionCategoryOption { id: string; name: string; slug: string; }
export async function listDiscussionCategories(): Promise<{ categories: DiscussionCategoryOption[]; reason?: string }> {
  const response = await fetch("/api/report/discussion-categories");
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json();
}
