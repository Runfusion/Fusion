import type { WhiteboardDocument } from "@fusion/core";
import { api } from "./client/client.js";
import { withProjectId } from "./client/health.js";

export interface WhiteboardSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Whiteboard extends WhiteboardSummary {
  document: WhiteboardDocument;
}

export interface WhiteboardRevision {
  revision: number;
  title: string;
  document: WhiteboardDocument;
  createdAt: string;
}

export function fetchWhiteboards(projectId: string, search = "", signal?: AbortSignal): Promise<{ whiteboards: WhiteboardSummary[] }> {
  const params = new URLSearchParams();
  if (search.trim()) params.set("q", search.trim());
  return api(withProjectId(`/whiteboards${params.size ? `?${params}` : ""}`, projectId), { signal });
}

export function fetchWhiteboard(projectId: string, id: string, signal?: AbortSignal): Promise<Whiteboard> {
  return api(withProjectId(`/whiteboards/${encodeURIComponent(id)}`, projectId), { signal });
}

export function createWhiteboard(projectId: string, title: string, document?: WhiteboardDocument): Promise<Whiteboard> {
  return api(withProjectId("/whiteboards", projectId), {
    method: "POST",
    body: JSON.stringify({ title, ...(document === undefined ? {} : { document }) }),
  });
}

export function renameWhiteboard(projectId: string, id: string, title: string, expectedRevision: number): Promise<Whiteboard> {
  return api(withProjectId(`/whiteboards/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ title, expectedRevision }),
  });
}

export function saveWhiteboard(projectId: string, id: string, document: WhiteboardDocument, expectedRevision: number): Promise<Whiteboard> {
  return api(withProjectId(`/whiteboards/${encodeURIComponent(id)}`, projectId), {
    method: "PUT",
    body: JSON.stringify({ document, expectedRevision }),
  });
}

export function deleteWhiteboard(projectId: string, id: string, expectedRevision: number): Promise<void> {
  return api(withProjectId(`/whiteboards/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`, projectId), { method: "DELETE" });
}

export function fetchWhiteboardRevisions(projectId: string, id: string, signal?: AbortSignal): Promise<{ revisions: WhiteboardRevision[] }> {
  return api(withProjectId(`/whiteboards/${encodeURIComponent(id)}/revisions`, projectId), { signal });
}

export function restoreWhiteboardRevision(projectId: string, id: string, revision: number, expectedRevision: number): Promise<Whiteboard> {
  return api(withProjectId(`/whiteboards/${encodeURIComponent(id)}/revisions/${revision}/restore`, projectId), {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}
