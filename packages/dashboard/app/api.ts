import type { Task, TaskDetail, TaskAttachment, TaskCreateInput, Column, MergeResult, Settings } from "@hai/core";

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
}

export function fetchTasks(): Promise<Task[]> {
  return api<Task[]>("/tasks");
}

export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  const maxAttempts = 2; // 1 initial + 1 retry
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`/api/tasks/${id}`, {
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (res.ok) return data as TaskDetail;
    if (attempt === maxAttempts) {
      throw new Error((data as { error?: string }).error || "Request failed");
    }
  }
  // unreachable
  throw new Error("Request failed");
}

export function createTask(input: TaskCreateInput): Promise<Task> {
  return api<Task>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTask(id: string, updates: { title?: string; description?: string; prompt?: string; dependencies?: string[] }): Promise<Task> {
  return api<Task>(`/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function moveTask(id: string, column: Column): Promise<Task> {
  return api<Task>(`/tasks/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ column }),
  });
}

export function deleteTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}`, { method: "DELETE" });
}

export function mergeTask(id: string): Promise<MergeResult> {
  return api<MergeResult>(`/tasks/${id}/merge`, { method: "POST" });
}

export function retryTask(id: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/retry`, { method: "POST" });
}

export function fetchConfig(): Promise<{ maxConcurrent: number }> {
  return api<{ maxConcurrent: number }>("/config");
}

export function fetchSettings(): Promise<Settings> {
  return api<Settings>("/settings");
}

export function updateSettings(settings: Partial<Settings>): Promise<Settings> {
  return api<Settings>("/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function uploadAttachment(id: string, file: File): Promise<TaskAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`/api/tasks/${id}/attachments`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Upload failed");
  return data as TaskAttachment;
}

export async function deleteAttachment(id: string, filename: string): Promise<Task> {
  return api<Task>(`/tasks/${id}/attachments/${filename}`, { method: "DELETE" });
}
