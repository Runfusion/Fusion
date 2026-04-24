import type { Task, Column, Settings, MergeResult, NtfyNotificationEvent } from "@fusion/core";
import { schedulerLog } from "./logger.js";

export interface NtfyNotifierOptions {
  /** Base URL for ntfy.sh. Default: https://ntfy.sh */
  ntfyBaseUrl?: string;
  /** Project identifier for deep links in notifications */
  projectId?: string;
}

export type NtfyNotificationPriority = "low" | "default" | "high" | "urgent";

export const DEFAULT_NTFY_EVENTS: readonly NtfyNotificationEvent[] = [
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
] as const;

export interface NtfyNotificationConfigInput {
  enabled?: boolean;
  topic?: string;
  dashboardHost?: string;
  events?: NtfyNotificationEvent[];
  projectId?: string;
  ntfyBaseUrl?: string;
}

export interface SendNtfyNotificationInput {
  ntfyBaseUrl?: string;
  topic: string;
  title: string;
  message: string;
  priority?: NtfyNotificationPriority;
  clickUrl?: string;
  signal?: AbortSignal;
}

interface NtfyConfig {
  enabled: boolean;
  topic: string | undefined;
  dashboardHost: string | undefined;
  events: NtfyNotificationEvent[];
}

/** Event types for task notification deduplication */
type TaskNotificationEvent = "in-review" | "merged" | "failed" | "awaiting-approval" | "awaiting-user-review";

/**
 * Format a task identifier for notifications.
 * - If title exists: returns "{title}"
 * - If no title: returns "{id}: {first 200 chars of description}" (truncated with "..." if > 200)
 */
function formatTaskIdentifier(task: Task): string {
  if (task.title) {
    return task.title;
  }
  const maxLen = 200;
  const snippet = task.description.length > maxLen
    ? task.description.slice(0, maxLen) + "..."
    : task.description;
  return `${task.id}: ${snippet}`;
}

/** Minimal store interface needed by NtfyNotifier */
interface NtfyNotifierStore {
  getSettings(): Promise<Settings> | Settings;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

export function resolveNtfyEvents(events?: NtfyNotificationEvent[]): NtfyNotificationEvent[] {
  return events ? [...events] : [...DEFAULT_NTFY_EVENTS];
}

export function isNtfyEventEnabled(events: NtfyNotificationEvent[] | undefined, event: NtfyNotificationEvent): boolean {
  return resolveNtfyEvents(events).includes(event);
}

export function buildNtfyClickUrl(options: {
  dashboardHost?: string;
  projectId?: string;
  taskId?: string;
}): string | undefined {
  const { dashboardHost, projectId, taskId } = options;
  if (!dashboardHost) {
    return undefined;
  }

  const normalizedHost = dashboardHost.replace(/\/+$/, "");
  const queryParts: string[] = [];

  if (projectId) {
    queryParts.push(`project=${encodeURIComponent(projectId)}`);
  }
  if (taskId) {
    queryParts.push(`task=${encodeURIComponent(taskId)}`);
  }

  const query = queryParts.join("&");
  return query ? `${normalizedHost}/?${query}` : `${normalizedHost}/`;
}

/**
 * Send a notification to ntfy.
 * Errors are logged and swallowed so callers can treat delivery as best-effort.
 */
export async function sendNtfyNotification({
  ntfyBaseUrl = "https://ntfy.sh",
  topic,
  title,
  message,
  priority = "default",
  clickUrl,
  signal,
}: SendNtfyNotificationInput): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Title: title,
      Priority: priority,
      "Content-Type": "text/plain",
    };

    if (clickUrl) {
      headers.Click = clickUrl;
    }

    const response = await fetch(`${ntfyBaseUrl}/${topic}`, {
      method: "POST",
      headers,
      body: message,
      signal,
    });

    if (!response.ok) {
      schedulerLog.log(`Ntfy notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }
    schedulerLog.log(`Failed to send ntfy notification: ${err}`);
  }
}

/**
 * NtfyNotifier sends push notifications via ntfy.sh when tasks complete
 * or fail. It listens to TaskStore events and sends HTTP POST requests
 * to the configured ntfy topic.
 */
export class NtfyNotifier {
  private config: NtfyConfig = {
    enabled: false,
    topic: undefined,
    dashboardHost: undefined,
    events: [...DEFAULT_NTFY_EVENTS],
  };
  private ntfyBaseUrl: string;
  private projectId?: string;
  private notifiedEvents: Set<string> = new Set();
  private abortController: AbortController | null = null;

  constructor(
    private store: NtfyNotifierStore,
    options: NtfyNotifierOptions = {},
  ) {
    this.ntfyBaseUrl = options.ntfyBaseUrl ?? "https://ntfy.sh";
    this.projectId = options.projectId;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();

    const settings = await this.store.getSettings();
    this.loadConfig(settings);

    this.store.on("task:moved", this.handleTaskMoved);
    this.store.on("task:updated", this.handleTaskUpdated);
    this.store.on("task:merged", this.handleTaskMerged);
    this.store.on("settings:updated", this.handleSettingsUpdated);

    schedulerLog.log("NtfyNotifier started");
  }

  stop(): void {
    if (typeof this.store.off === "function") {
      this.store.off("task:moved", this.handleTaskMoved);
      this.store.off("task:updated", this.handleTaskUpdated);
      this.store.off("task:merged", this.handleTaskMerged);
      this.store.off("settings:updated", this.handleSettingsUpdated);
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    schedulerLog.log("NtfyNotifier stopped");
  }

  private handleTaskMoved = (data: { task: Task; from: Column; to: Column }): void => {
    if (!this.config.enabled || !this.config.topic) return;

    const { task, to } = data;

    if (to === "in-review" && this.isEventEnabled("in-review")) {
      const clickUrl = buildNtfyClickUrl({
        dashboardHost: this.config.dashboardHost,
        projectId: this.projectId,
        taskId: task.id,
      });
      this.maybeNotify(task.id, "in-review", () =>
        sendNtfyNotification({
          ntfyBaseUrl: this.ntfyBaseUrl,
          topic: this.config.topic!,
          title: `Task ${task.id} completed`,
          message: `Task "${formatTaskIdentifier(task)}" is ready for review`,
          priority: "default",
          clickUrl,
          signal: this.abortController?.signal,
        }),
      );
    }
  };

  private handleTaskUpdated = (task: Task): void => {
    if (!this.config.enabled || !this.config.topic) return;

    if (task.status === "failed" && this.isEventEnabled("failed")) {
      const clickUrl = buildNtfyClickUrl({
        dashboardHost: this.config.dashboardHost,
        projectId: this.projectId,
        taskId: task.id,
      });
      this.maybeNotify(task.id, "failed", () =>
        sendNtfyNotification({
          ntfyBaseUrl: this.ntfyBaseUrl,
          topic: this.config.topic!,
          title: `Task ${task.id} failed`,
          message: `Task "${formatTaskIdentifier(task)}" has failed and needs attention`,
          priority: "high",
          clickUrl,
          signal: this.abortController?.signal,
        }),
      );
    }

    if (task.status === "awaiting-approval" && this.isEventEnabled("awaiting-approval")) {
      const clickUrl = buildNtfyClickUrl({
        dashboardHost: this.config.dashboardHost,
        projectId: this.projectId,
        taskId: task.id,
      });
      this.maybeNotify(task.id, "awaiting-approval", () =>
        sendNtfyNotification({
          ntfyBaseUrl: this.ntfyBaseUrl,
          topic: this.config.topic!,
          title: `Plan needs approval for ${task.id}`,
          message: `Task "${formatTaskIdentifier(task)}" needs your approval before it can proceed`,
          priority: "high",
          clickUrl,
          signal: this.abortController?.signal,
        }),
      );
    }

    if (task.status === "awaiting-user-review" && this.isEventEnabled("awaiting-user-review")) {
      const clickUrl = buildNtfyClickUrl({
        dashboardHost: this.config.dashboardHost,
        projectId: this.projectId,
        taskId: task.id,
      });
      this.maybeNotify(task.id, "awaiting-user-review", () =>
        sendNtfyNotification({
          ntfyBaseUrl: this.ntfyBaseUrl,
          topic: this.config.topic!,
          title: `User review needed for ${task.id}`,
          message: `Task "${formatTaskIdentifier(task)}" needs human review before it can proceed`,
          priority: "high",
          clickUrl,
          signal: this.abortController?.signal,
        }),
      );
    }
  };

  private handleTaskMerged = (result: MergeResult): void => {
    if (!this.config.enabled || !this.config.topic) return;

    if (result.merged && this.isEventEnabled("merged")) {
      const clickUrl = buildNtfyClickUrl({
        dashboardHost: this.config.dashboardHost,
        projectId: this.projectId,
        taskId: result.task.id,
      });
      this.maybeNotify(result.task.id, "merged", () =>
        sendNtfyNotification({
          ntfyBaseUrl: this.ntfyBaseUrl,
          topic: this.config.topic!,
          title: `Task ${result.task.id} merged`,
          message: `Task "${formatTaskIdentifier(result.task)}" has been merged to main`,
          priority: "default",
          clickUrl,
          signal: this.abortController?.signal,
        }),
      );
    }
  };

  private handleSettingsUpdated = (data: { settings: Settings; previous: Settings }): void => {
    const { settings, previous } = data;

    if (settings.ntfyEnabled !== previous.ntfyEnabled ||
        settings.ntfyTopic !== previous.ntfyTopic ||
        settings.ntfyDashboardHost !== previous.ntfyDashboardHost ||
        JSON.stringify(settings.ntfyEvents) !== JSON.stringify(previous.ntfyEvents)) {
      const wasEnabled = this.config.enabled;
      this.loadConfig(settings);

      if (this.config.enabled && !wasEnabled) {
        schedulerLog.log("NtfyNotifier enabled");
      } else if (!this.config.enabled && wasEnabled) {
        schedulerLog.log("NtfyNotifier disabled");
      } else if (this.config.topic !== previous.ntfyTopic) {
        schedulerLog.log("NtfyNotifier topic updated");
      } else if (this.config.dashboardHost !== previous.ntfyDashboardHost) {
        schedulerLog.log("NtfyNotifier dashboard host updated");
      } else if (JSON.stringify(this.config.events) !== JSON.stringify(previous.ntfyEvents)) {
        schedulerLog.log("NtfyNotifier events updated");
      }
    }
  };

  private loadConfig(settings: Settings): void {
    this.config = {
      enabled: settings.ntfyEnabled ?? false,
      topic: settings.ntfyTopic,
      dashboardHost: settings.ntfyDashboardHost,
      events: resolveNtfyEvents(settings.ntfyEvents),
    };
  }

  private isEventEnabled(event: TaskNotificationEvent): boolean {
    return isNtfyEventEnabled(this.config.events, event);
  }

  private maybeNotify(
    taskId: string,
    eventType: TaskNotificationEvent,
    notifyFn: () => Promise<void>,
  ): void {
    const key = `${taskId}:${eventType}`;

    if (this.notifiedEvents.has(key)) {
      return;
    }

    this.notifiedEvents.add(key);
    notifyFn().catch(() => {
      // sendNtfyNotification already logs; notifier must stay best-effort
    });
  }

  getConfig(): NtfyConfig {
    return { ...this.config, events: [...this.config.events] };
  }
}
