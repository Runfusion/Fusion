import type { ProjectNote, ProjectNoteCreateInput, ProjectNoteSummary, ProjectNoteUpdateInput } from "@fusion/core";
import { api } from "./client/client.js";
import { withProjectId } from "./client/health.js";

export function fetchNotes(projectId: string, search?: string, signal?: AbortSignal): Promise<{ notes: ProjectNoteSummary[] }> {
  const params = new URLSearchParams();
  if (search?.trim()) params.set("q", search.trim());
  const path = `/notes${params.size ? `?${params}` : ""}`;
  return api(withProjectId(path, projectId), { signal });
}
export function fetchNote(projectId: string, id: string, signal?: AbortSignal): Promise<ProjectNote> {
  return api(withProjectId(`/notes/${encodeURIComponent(id)}`, projectId), { signal });
}
export function createNote(projectId: string, input: ProjectNoteCreateInput): Promise<ProjectNote> {
  return api(withProjectId("/notes", projectId), { method: "POST", body: JSON.stringify(input) });
}
export function updateNote(projectId: string, id: string, input: ProjectNoteUpdateInput): Promise<ProjectNote> {
  return api(withProjectId(`/notes/${encodeURIComponent(id)}`, projectId), { method: "PATCH", body: JSON.stringify(input) });
}
export function deleteNote(projectId: string, id: string, expectedRevision: number): Promise<void> {
  const path = `/notes/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`;
  return api(withProjectId(path, projectId), { method: "DELETE" });
}
