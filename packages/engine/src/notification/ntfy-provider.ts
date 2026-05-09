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
  | "planning-awaiting-input"
  | "fallback-used"
  | "message:agent-to-user"
  | "message:agent-to-agent";

const SUPPORTED_EVENTS = new Set<SupportedNtfyEvent>([
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
  "fallback-used",
  "message:agent-to-user",
  "message:agent-to-agent",
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

    const taskId = payload.taskId ?? "unknown-task";
    const taskLike = {
      id: taskId,
      title: payload.taskTitle,
      description: payload.taskDescription ?? "",
    } as Pick<Task, "id" | "title" | "description"> as Task;

    const identifier = formatTaskIdentifier(taskLike);
    const messageId = typeof payload.metadata?.messageId === "string" ? payload.metadata.messageId : undefined;
    const senderLabel = typeof payload.metadata?.fromId === "string" ? payload.metadata.fromId : "agent";
    const recipientLabel = typeof payload.metadata?.toId === "string" ? payload.metadata.toId : "recipient";
    const preview = typeof payload.metadata?.preview === "string"
      ? payload.metadata.preview
      : "(no preview)";
    const replyToMessageId = typeof payload.metadata?.replyToMessageId === "string"
      ? payload.metadata.replyToMessageId
      : undefined;

    const clickUrl = buildNtfyClickUrl({
      dashboardHost: this.config.dashboardHost,
      projectId: this.config.projectId,
      taskId: payload.taskId,
      messageId,
      view: "mailbox",
    });

    const contentByEvent: Record<SupportedNtfyEvent, { title: string; message: string; priority: "default" | "high" }> = {
      "in-review": {
        title: `Task ${taskId} completed`,
        message: `Task "${identifier}" is ready for review`,
        priority: "default",
      },
      merged: {
        title: `Task ${taskId} merged`,
        message: `Task "${identifier}" has been merged to main`,
        priority: "default",
      },
      failed: {
        title: `Task ${taskId} failed`,
        message: `Task "${identifier}" has failed and needs attention`,
        priority: "high",
      },
      "awaiting-approval": {
        title: `Plan needs approval for ${taskId}`,
        message: `Task "${identifier}" needs your approval before it can proceed`,
        priority: "high",
      },
      "awaiting-user-review": {
        title: `User review needed for ${taskId}`,
        message: `Task "${identifier}" needs human review before it can proceed`,
        priority: "high",
      },
      "planning-awaiting-input": {
        title: `Planning input needed for ${taskId}`,
        message: `Task "${identifier}" is awaiting your input during planning`,
        priority: "high",
      },
      "fallback-used": {
        title: `Fallback model used${payload.taskId ? ` for ${payload.taskId}` : ""}`,
        message: `Fusion switched from ${String(payload.metadata?.primaryModel ?? "primary model")} to ${String(payload.metadata?.fallbackModel ?? "fallback model")} after a retryable failure (${String(payload.metadata?.triggerPoint ?? "unknown trigger")}).`,
        priority: "high",
      },
      "message:agent-to-user": {
        title: `New message from ${senderLabel}`,
        message: `${senderLabel} → you: ${preview}`,
        priority: "high",
      },
      "message:agent-to-agent": {
        title: replyToMessageId ? `Re: ${preview}` : `${senderLabel} → ${recipientLabel}`,
        message: `${senderLabel} messaged ${recipientLabel}: ${preview}`,
        priority: "default",
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
