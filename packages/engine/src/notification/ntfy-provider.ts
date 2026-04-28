import type {
  NotificationEvent,
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
  NtfyNotificationEvent,
  Task,
} from "@fusion/core";
import {
  DEFAULT_NTFY_EVENTS,
  buildNtfyClickUrl,
  formatTaskIdentifier,
  resolveNtfyEvents,
  sendNtfyNotification,
} from "../notifier.js";

export interface NtfyProviderConfig {
  /** ntfy topic name */
  topic: string;
  /** ntfy server base URL (default: https://ntfy.sh) */
  ntfyBaseUrl?: string;
  /** Dashboard host for click-through deep links */
  dashboardHost?: string;
  /** Project identifier for deep links */
  projectId?: string;
  /** Events to enable (default: DEFAULT_NTFY_EVENTS) */
  events?: NtfyNotificationEvent[];
}

type SupportedNtfyEvent =
  | "in-review"
  | "merged"
  | "failed"
  | "awaiting-approval"
  | "awaiting-user-review"
  | "planning-awaiting-input";

const SUPPORTED_EVENTS = new Set<SupportedNtfyEvent>([
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
]);

export class NtfyNotificationProvider implements NotificationProvider {
  private config?: NtfyProviderConfig;
  private abortController: AbortController | null = null;

  getProviderId(): string {
    return "ntfy";
  }

  async initialize(config: Record<string, unknown>): Promise<void> {
    if (typeof config.topic !== "string" || config.topic.trim() === "") {
      return;
    }

    this.config = config as unknown as NtfyProviderConfig;
    this.config.events = resolveNtfyEvents(this.config.events);
    this.abortController = new AbortController();
  }

  async shutdown(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
  }

  isEventSupported(event: NotificationEvent): boolean {
    if (!SUPPORTED_EVENTS.has(event as SupportedNtfyEvent)) {
      return false;
    }

    const enabledEvents = this.config?.events ?? [...DEFAULT_NTFY_EVENTS];
    return enabledEvents.includes(event as NtfyNotificationEvent);
  }

  async sendNotification(
    event: NotificationEvent,
    payload: NotificationPayload,
  ): Promise<NotificationResult> {
    if (!this.config?.topic) {
      return { success: false, providerId: this.getProviderId(), error: "ntfy topic not configured" };
    }

    if (!this.isEventSupported(event)) {
      return {
        success: false,
        providerId: this.getProviderId(),
        error: `unsupported event: ${event}`,
      };
    }

    const taskLike = {
      id: payload.taskId,
      title: payload.taskTitle,
      description: payload.taskDescription ?? "",
    } as Pick<Task, "id" | "title" | "description"> as Task;

    const identifier = formatTaskIdentifier(taskLike);
    const clickUrl = buildNtfyClickUrl({
      dashboardHost: this.config.dashboardHost,
      projectId: this.config.projectId,
      taskId: payload.taskId,
    });

    const contentByEvent: Record<SupportedNtfyEvent, { title: string; message: string; priority: "default" | "high" }> = {
      "in-review": {
        title: `Task ${payload.taskId} completed`,
        message: `Task "${identifier}" is ready for review`,
        priority: "default",
      },
      merged: {
        title: `Task ${payload.taskId} merged`,
        message: `Task "${identifier}" has been merged to main`,
        priority: "default",
      },
      failed: {
        title: `Task ${payload.taskId} failed`,
        message: `Task "${identifier}" has failed and needs attention`,
        priority: "high",
      },
      "awaiting-approval": {
        title: `Plan needs approval for ${payload.taskId}`,
        message: `Task "${identifier}" needs your approval before it can proceed`,
        priority: "high",
      },
      "awaiting-user-review": {
        title: `User review needed for ${payload.taskId}`,
        message: `Task "${identifier}" needs human review before it can proceed`,
        priority: "high",
      },
      "planning-awaiting-input": {
        title: `Planning input needed for ${payload.taskId}`,
        message: `Task "${identifier}" is awaiting your input during planning`,
        priority: "high",
      },
    };

    const content = contentByEvent[event as SupportedNtfyEvent];
    await sendNtfyNotification({
      ntfyBaseUrl: this.config.ntfyBaseUrl,
      topic: this.config.topic,
      title: content.title,
      message: content.message,
      priority: content.priority,
      clickUrl,
      signal: this.abortController?.signal,
    });

    return { success: true, providerId: this.getProviderId() };
  }
}
