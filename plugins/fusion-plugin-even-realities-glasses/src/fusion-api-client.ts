import type { TaskColumn } from "./settings.js";

export type FusionTask = {
  id: string;
  title: string;
  description: string;
  column: TaskColumn;
  status?: string;
};

export type ListTasksFilter = {
  limit?: number;
  offset?: number;
  column?: TaskColumn;
  status?: string;
  q?: string;
  includeArchived?: boolean;
};

export class FusionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Fusion API request failed: ${status}`);
  }
}

type FetchLike = typeof fetch;

export class FusionApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async listTasks(filter: ListTasksFilter = {}): Promise<FusionTask[]> {
    const params = new URLSearchParams();
    if (typeof filter.limit === "number") params.set("limit", String(Math.floor(filter.limit)));
    if (typeof filter.offset === "number") params.set("offset", String(Math.floor(filter.offset)));
    if (typeof filter.q === "string" && filter.q.trim()) params.set("q", filter.q.trim());
    if (typeof filter.includeArchived === "boolean") params.set("includeArchived", String(filter.includeArchived));

    const query = params.toString();
    const data = await this.request<FusionTask[]>("GET", `/api/tasks${query ? `?${query}` : ""}`);
    let tasks = Array.isArray(data) ? data : [];
    if (filter.column) tasks = tasks.filter((task) => task.column === filter.column);
    if (filter.status) tasks = tasks.filter((task) => task.status === filter.status);
    return tasks;
  }

  async getTask(id: string): Promise<FusionTask> {
    return this.request<FusionTask>("GET", `/api/tasks/${encodeURIComponent(id)}`);
  }

  async createTask(input: { title: string; description: string; column?: TaskColumn }): Promise<FusionTask> {
    return this.request<FusionTask>("POST", "/api/tasks", input);
  }

  async updateTask(id: string, patch: Partial<Pick<FusionTask, "title" | "description" | "status">>): Promise<FusionTask> {
    return this.request<FusionTask>("PATCH", `/api/tasks/${encodeURIComponent(id)}`, patch);
  }

  async moveTask(id: string, column: TaskColumn): Promise<FusionTask> {
    return this.request<FusionTask>("POST", `/api/tasks/${encodeURIComponent(id)}/move`, { column });
  }

  async retryTask(id: string): Promise<FusionTask> {
    return this.request<FusionTask>("POST", `/api/tasks/${encodeURIComponent(id)}/retry`, {});
  }

  async refineTask(id: string, feedback: string): Promise<FusionTask> {
    return this.request<FusionTask>("POST", `/api/tasks/${encodeURIComponent(id)}/refine`, { feedback });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new FusionApiError(response.status, payload);
    }
    return payload as T;
  }
}
