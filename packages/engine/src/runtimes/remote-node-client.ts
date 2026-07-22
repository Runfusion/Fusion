import type { Task, TaskCreateInput } from "@fusion/core";
import type { RuntimeMetrics } from "../project/project-runtime.js";
import { remoteNodeLog } from "../logger.js";

export type RemoteNodeEventType =
  | "task:created"
  | "task:moved"
  | "task:updated"
  | "task:assigned"
  | "error"
  | (string & {});

export interface RemoteNodeTaskAssignedPayload {
  taskId: string;
  agentId: string;
  fromNodeId?: string;
  toNodeId?: string;
  leaseEpoch?: number;
  assignedAt: string;
}

export interface RemoteNodeEvent {
  type: RemoteNodeEventType;
  payload: unknown;
  timestamp: string;
}

export interface RemoteNodeClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export type RemoteTaskListFilter = Record<string, string | number | boolean | undefined | null>;

class RemoteNodeRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "RemoteNodeRequestError";
  }
}

const RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;

export class RemoteNodeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteNodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async health(): Promise<{ status: string; version: string; uptime: number }> {
    return this.withRetry(() =>
      this.requestJson<{ status: string; version: string; uptime: number }>("/api/health", {
        method: "GET",
      })
    );
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    return this.withRetry(() =>
      this.requestJson<RuntimeMetrics>("/api/metrics", {
        method: "GET",
      })
    );
  }

  async createTask(input: TaskCreateInput): Promise<Task> {
    return this.withRetry(() =>
      this.requestJson<Task>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }

  async listTasks(filter?: RemoteTaskListFilter): Promise<Task[]> {
    const query = new URLSearchParams();
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined && value !== null) {
          query.set(key, String(value));
        }
      }
    }

    const path = query.toString().length > 0 ? `/api/tasks?${query.toString()}` : "/api/tasks";
    return this.withRetry(() =>
      this.requestJson<Task[]>(path, {
        method: "GET",
      })
    );
  }

  async executeTask(taskId: string): Promise<{ acknowledged: boolean; [key: string]: unknown }> {
    return this.withRetry(() =>
      this.requestJson<{ acknowledged: boolean; [key: string]: unknown }>(
        `/api/tasks/${encodeURIComponent(taskId)}/execute`,
        {
          method: "POST",
        }
      )
    );
  }

  async pollPendingAssignments(options?: { since?: string }): Promise<RemoteNodeTaskAssignedPayload[]> {
    const query = new URLSearchParams();
    if (options?.since) {
      query.set("since", options.since);
    }
    const path = query.size > 0
      ? `/api/events/assignments?${query.toString()}`
      : "/api/events/assignments";
    return this.withRetry(() =>
      this.requestJson<RemoteNodeTaskAssignedPayload[]>(path, {
        method: "GET",
      })
    );
  }

  async *streamEvents(options?: { signal?: AbortSignal }): AsyncIterable<RemoteNodeEvent> {
    const response = await this.withRetry(
      () => this.openStream("/api/events/stream", options?.signal),
      DEFAULT_MAX_RETRIES
    );

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body) {
      throw new Error("Remote node event stream opened without a body");
    }

    if (contentType.includes("text/event-stream")) {
      yield* this.parseSseStream(response.body, options?.signal);
      return;
    }

    // Fallback for long-polling endpoints that return JSON payloads.
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        for (const rawEvent of payload) {
          yield this.normalizeEvent(rawEvent, "message");
        }
      } else {
        yield this.normalizeEvent(payload, "message");
      }
      return;
    }

    // Generic fallback: treat each line as one JSON event.
    yield* this.parseJsonLines(response.body, options?.signal);
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchWithTimeout(path, {
      ...init,
      headers: {
        ...this.getAuthHeaders(),
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      await this.throwHttpError(path, response);
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new RemoteNodeRequestError(
        `Failed to parse JSON response for ${path}: ${error instanceof Error ? error.message : String(error)}`,
        false
      );
    }
  }

  private async openStream(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchWithTimeout(
      path,
      {
        method: "GET",
        headers: {
          ...this.getAuthHeaders(),
          Accept: "text/event-stream, application/json",
        },
      },
      signal
    );

    if (!response.ok) {
      await this.throwHttpError(path, response);
    }

    return response;
  }

  private async throwHttpError(path: string, response: Response): Promise<never> {
    const responseBody = (await response.text()).trim();
    const snippet = responseBody.length > 0 ? ` — ${responseBody.slice(0, 300)}` : "";
    const retryable = response.status >= 500;

    throw new RemoteNodeRequestError(
      `Remote node request failed (${response.status} ${response.statusText}) for ${path}${snippet}`,
      retryable,
      response.status
    );
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async fetchWithTimeout(
    path: string,
    init: RequestInit,
    externalSignal?: AbortSignal
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const onAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        throw new RemoteNodeRequestError("Request aborted", false);
      }
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof RemoteNodeRequestError) {
        throw error;
      }

      if (timedOut) {
        throw new RemoteNodeRequestError(
          `Remote node request timed out after ${this.timeoutMs}ms (${path})`,
          true
        );
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new RemoteNodeRequestError(`Remote node request aborted (${path})`, false);
      }

      throw new RemoteNodeRequestError(
        `Remote node network error (${path}): ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    } finally {
      clearTimeout(timeout);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async *parseSseStream(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): AsyncIterable<RemoteNodeEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let eventType = "message";
    let dataLines: string[] = [];

    const flushEvent = (): RemoteNodeEvent | null => {
      if (dataLines.length === 0) {
        eventType = "message";
        return null;
      }

      const data = dataLines.join("\n");
      dataLines = [];

      const normalized = this.normalizeEvent(data, eventType);
      eventType = "message";
      return normalized;
    };

    try {
      while (true) {
        if (signal?.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.length === 0) {
            const event = flushEvent();
            if (event) {
              yield event;
            }
            continue;
          }

          if (line.startsWith(":")) {
            continue;
          }

          const separator = line.indexOf(":");
          const field = separator === -1 ? line : line.slice(0, separator);
          const valuePart = separator === -1 ? "" : line.slice(separator + 1).trimStart();

          if (field === "event") {
            eventType = valuePart || "message";
          } else if (field === "data") {
            dataLines.push(valuePart);
          }
        }
      }

      if (buffer.trim().length > 0) {
        dataLines.push(buffer.trim());
      }

      const trailingEvent = flushEvent();
      if (trailingEvent) {
        yield trailingEvent;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async *parseJsonLines(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): AsyncIterable<RemoteNodeEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          yield this.normalizeEvent(trimmed, "message");
        }
      }

      const trailing = buffer.trim();
      if (trailing.length > 0) {
        yield this.normalizeEvent(trailing, "message");
      }
    } finally {
      reader.releaseLock();
    }
  }

  private normalizeEvent(raw: unknown, fallbackType: string): RemoteNodeEvent {
    const parsed = this.tryParseJson(raw);

    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      "timestamp" in parsed
    ) {
      return {
        type: String((parsed as { type: unknown }).type),
        payload: (parsed as { payload?: unknown }).payload,
        timestamp: String((parsed as { timestamp: unknown }).timestamp),
      };
    }

    return {
      type: fallbackType,
      payload: parsed,
      timestamp: new Date().toISOString(),
    };
  }

  private tryParseJson(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = DEFAULT_MAX_RETRIES): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        const isRetryable =
          error instanceof RemoteNodeRequestError
            ? error.retryable
            : this.isLikelyNetworkError(error);

        if (!isRetryable || attempt >= maxRetries) {
          throw error;
        }

        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        attempt += 1;
        remoteNodeLog.warn(
          `Request failed, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`,
          error
        );
        await this.sleep(delayMs);
      }
    }
  }

  private isLikelyNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    if (error.name === "AbortError") {
      return true;
    }

    return error instanceof TypeError;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
