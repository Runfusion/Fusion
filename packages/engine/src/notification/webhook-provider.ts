import type {
  NotificationEvent,
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from "@fusion/core";
import { schedulerLog } from "../logger.js";
import { buildNtfyClickUrl } from "../notifier.js";

export interface WebhookProviderConfig {
  /** Webhook endpoint URL */
  webhookUrl: string;
  /** Payload format: slack, discord, or generic */
  webhookFormat: "slack" | "discord" | "generic";
  /** Events to send (empty = all events) */
  events?: string[];
  /** Dashboard host for click-through deep links */
  dashboardHost?: string;
  /** Project identifier for deep links */
  projectId?: string;
}

export class WebhookNotificationProvider implements NotificationProvider {
  private config: WebhookProviderConfig | null = null;
  private abortController: AbortController | null = null;

  getProviderId(): string {
    return "webhook";
  }

  async initialize(config: Record<string, unknown>): Promise<void> {
    const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
    if (!webhookUrl) {
      throw new Error("webhookUrl is required");
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      throw new Error("webhookUrl must be a valid URL");
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("webhookUrl must use http:// or https://");
    }

    const webhookFormat =
      config.webhookFormat === "slack" || config.webhookFormat === "discord" || config.webhookFormat === "generic"
        ? config.webhookFormat
        : "generic";

    this.config = {
      webhookUrl,
      webhookFormat,
      events: Array.isArray(config.events) ? config.events.filter((event): event is string => typeof event === "string") : [],
      dashboardHost: typeof config.dashboardHost === "string" ? config.dashboardHost : undefined,
      projectId: typeof config.projectId === "string" ? config.projectId : undefined,
    };

    this.abortController?.abort();
    this.abortController = new AbortController();
  }

  async shutdown(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.config = null;
  }

  isEventSupported(event: NotificationEvent): boolean {
    if (!this.config?.events || this.config.events.length === 0) {
      return true;
    }
    return this.config.events.includes(event);
  }

  async sendNotification(event: NotificationEvent, payload: NotificationPayload): Promise<NotificationResult> {
    if (!this.config) {
      return { success: false, providerId: this.getProviderId(), error: "Not initialized" };
    }

    if (!this.isEventSupported(event)) {
      return {
        success: false,
        providerId: this.getProviderId(),
        error: `unsupported event: ${event}`,
      };
    }

    try {
      const message = this.formatMessage(event, payload);
      const body = this.formatPayload(payload, message);

      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: this.abortController?.signal,
      });

      if (!response.ok) {
        const error = `Webhook notification failed: ${response.status} ${response.statusText}`;
        schedulerLog.log(error);
        return {
          success: false,
          providerId: this.getProviderId(),
          error,
        };
      }

      return { success: true, providerId: this.getProviderId() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      schedulerLog.log(`Failed to send webhook notification: ${message}`);
      return {
        success: false,
        providerId: this.getProviderId(),
        error: message,
      };
    }
  }

  private formatMessage(event: NotificationEvent, payload: NotificationPayload): string {
    const identifier = this.formatTaskIdentifier(payload);
    switch (event) {
      case "in-review":
        return `Task "${identifier}" is ready for review`;
      case "merged":
        return `Task "${identifier}" has been merged to main`;
      case "failed":
        return `Task "${identifier}" has failed and needs attention`;
      case "awaiting-approval":
        return `Task "${identifier}" needs your approval before it can proceed`;
      case "awaiting-user-review":
        return `Task "${identifier}" needs human review before it can proceed`;
      case "planning-awaiting-input":
        return `Task "${identifier}" is awaiting your input during planning`;
      case "gridlock":
        return "Pipeline gridlocked";
      case "fallback-used":
        return `Fusion recovered by switching from ${String(payload.metadata?.primaryModel ?? "primary model")} to ${String(payload.metadata?.fallbackModel ?? "fallback model")} (${String(payload.metadata?.triggerPoint ?? "unknown trigger")})`;
      default:
        return `Event "${event}" for task ${identifier}`;
    }
  }

  private formatTaskIdentifier(payload: NotificationPayload): string {
    if (payload.taskTitle?.trim()) {
      return payload.taskTitle;
    }

    const description = payload.taskDescription ?? "";
    const snippet = description.length > 200 ? `${description.slice(0, 200)}...` : description;
    return `${payload.taskId ?? "unknown-task"}: ${snippet}`;
  }

  private formatPayload(payload: NotificationPayload, message: string): Record<string, unknown> {
    if (!this.config) {
      return {};
    }

    if (this.config.webhookFormat === "slack") {
      return { text: message };
    }

    if (this.config.webhookFormat === "discord") {
      return { content: message };
    }

    const messageId = typeof payload.metadata?.messageId === "string" ? payload.metadata.messageId : undefined;

    return {
      event: payload.event,
      timestamp: new Date().toISOString(),
      task: {
        id: payload.taskId,
        title: payload.taskTitle,
      },
      metadata: payload.metadata,
      clickUrl: buildNtfyClickUrl({
        dashboardHost: this.config.dashboardHost,
        projectId: this.config.projectId,
        taskId: payload.taskId,
        messageId,
        view: "mailbox",
      }),
    };
  }
}
