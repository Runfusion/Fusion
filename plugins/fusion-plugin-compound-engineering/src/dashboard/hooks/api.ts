import type { DiscoveryResult } from "../../artifacts/discovery.js";
import type { CeSession } from "../../session/session-store.js";

const BASE = "/api/plugins/fusion-plugin-compound-engineering";

function qp(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => typeof v === "string" && v.length > 0,
  ) as Array<[string, string]>;
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

export async function listArtifacts(projectId?: string): Promise<DiscoveryResult> {
  return request<DiscoveryResult>(`/artifacts${qp({ projectId })}`);
}

export async function getArtifact(
  id: string,
  projectId?: string,
): Promise<{ content: string; name: string }> {
  const data = await request<{ artifact: { name: string }; content: string }>(
    `/artifacts/${encodeURIComponent(id)}${qp({ projectId })}`,
  );
  return { content: data.content, name: data.artifact.name };
}

export function getArtifactPreviewUrl(id: string, projectId?: string): string {
  return `${BASE}/artifacts/${encodeURIComponent(id)}/preview.html${qp({ projectId })}`;
}

// --- Interactive CE session routes (polling transport, U5/U6) ---------------

/** Start a stage session. Returns the freshly-created session (after one turn). */
export async function startSession(
  stage: string,
  opts: { message?: string; projectId?: string } = {},
): Promise<CeSession> {
  const data = await request<{ session: CeSession }>(`/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage, message: opts.message ?? "", projectId: opts.projectId }),
  });
  return data.session;
}

/** Submit an answer to the awaiting question and advance the session. */
export async function answerSession(
  sessionId: string,
  questionId: string,
  response: unknown,
): Promise<CeSession> {
  const data = await request<{ session: CeSession }>(`/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionId, response }),
  });
  return data.session;
}

/** Resume an interrupted/error/awaiting session back to its current question. */
export async function resumeSession(sessionId: string): Promise<CeSession> {
  const data = await request<{ session: CeSession }>(`/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
  });
  return data.session;
}

/** Poll the current persisted session state. */
export async function getSession(sessionId: string): Promise<CeSession> {
  const data = await request<{ session: CeSession }>(`/sessions/${encodeURIComponent(sessionId)}`);
  return data.session;
}
