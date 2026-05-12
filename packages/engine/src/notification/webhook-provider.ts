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

function resolveParticipantLabel(
  metadata: NotificationPayload["metadata"] | undefined,
  kind: "from" | "to",
): string {
  const nameKey = kind === "from" ? "fromName" : "toName";
  const idKey = kind === "from" ? "fromId" : "toId";
  const name = typeof metadata?.[nameKey] === "string" ? metadata[nameKey].trim() : "";
  if (name.length > 0) {
    return name;
  }
  const id = typeof metadata?.[idKey] === "string" ? metadata[idKey].trim() : "";
  return id.length > 0 ? id : kind === "from" ? "agent" : "recipient";
}

function resolveRoomSenderLabel(metadata: NotificationPayload["metadata"] | undefined): string {
  const senderName = typeof metadata?.senderName === "string" ? metadata.senderName.trim() : "";
  if (senderName.length > 0) {
    return senderName;
  }
  const senderAgentId = typeof metadata?.senderAgentId === "string" ? metadata.senderAgentId.trim() : "";
  return senderAgentId.length > 0 ? senderAgentId : "agent";
}

function resolveRoomLabel(metadata: NotificationPayload["metadata"] | undefined): string {
  const roomName = typeof metadata?.roomName === "string" ? metadata.roomName.trim() : "";
  if (roomName.length > 0) {
    return roomName;
  }
  const roomId = typeof metadata?.roomId === "string" ? metadata.roomId.trim() : "";
  return roomId.length > 0 ? roomId : "room";
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
      case "message:agent-to-user": {
        const from = resolveParticipantLabel(payload.metadata, "from");
        const preview = typeof payload.metadata?.preview === "string" ? payload.metadata.preview : "(no preview)";
        return `From: ${from} → You: ${preview}`;
      }
      case "message:agent-to-agent": {
        const from = resolveParticipantLabel(payload.metadata, "from");
        const to = resolveParticipantLabel(payload.metadata, "to");
        const preview = typeof payload.metadata?.preview === "string" ? payload.metadata.preview : "(no preview)";
        return `From: ${from} → To: ${to}: ${preview}`;
      }
      case "message:room": {
        const roomName = resolveRoomLabel(payload.metadata);
        const senderLabel = resolveRoomSenderLabel(payload.metadata);
        const preview = typeof payload.metadata?.preview === "string" ? payload.metadata.preview : "(no preview)";
        return `In #${roomName}: ${senderLabel}: ${preview}`;
      }
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
    const roomId = typeof payload.metadata?.roomId === "string" ? payload.metadata.roomId : undefined;

    const fromLabel = resolveParticipantLabel(payload.metadata, "from");
    const toLabel = resolveParticipantLabel(payload.metadata, "to");
    const roomLabel = resolveRoomLabel(payload.metadata);
    const roomSenderLabel = resolveRoomSenderLabel(payload.metadata);

    return {
      event: payload.event,
      timestamp: new Date().toISOString(),
      task: {
        id: payload.taskId,
        title: payload.taskTitle,
      },
      metadata: {
        ...payload.metadata,
        ...(payload.event === "message:agent-to-user" || payload.event === "message:agent-to-agent"
          ? {
            fromName: typeof payload.metadata?.fromName === "string" ? payload.metadata.fromName : fromLabel,
            toName: typeof payload.metadata?.toName === "string" ? payload.metadata.toName : toLabel,
          }
          : {}),
        ...(payload.event === "message:room"
          ? {
            roomName: typeof payload.metadata?.roomName === "string" ? payload.metadata.roomName : roomLabel,
            senderName: typeof payload.metadata?.senderName === "string" ? payload.metadata.senderName : roomSenderLabel,
          }
          : {}),
      },
      clickUrl: payload.event === "message:room"
        ? buildNtfyClickUrl({
          dashboardHost: this.config.dashboardHost,
          projectId: this.config.projectId,
          roomId,
          messageId,
          view: "rooms",
        })
        : buildNtfyClickUrl({
          dashboardHost: this.config.dashboardHost,
          projectId: this.config.projectId,
          taskId: payload.taskId,
          messageId,
          view: "mailbox",
        }),
    };
  }
}
