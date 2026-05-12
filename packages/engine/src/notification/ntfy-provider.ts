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
  sendNtfyNotificationWithResult,
} from "../notifier.js";
import { schedulerLog } from "../logger.js";

export interface NtfyProviderConfig {
  /** ntfy topic name */
  topic: string;
  /** ntfy server base URL (default: https://ntfy.sh) */
  ntfyBaseUrl?: string;
  /** Dashboard host for click-through deep links */
  dashboardHost?: string;
  /** Project identifier for deep links */
  projectId?: string;
  /** Optional access token used for authenticated publishes */
  ntfyAccessToken?: string;
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
  | "message:agent-to-agent"
  | "message:room";

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
  "message:room",
]);

export function resolveParticipantLabel(
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
      schedulerLog.log(`NtfyNotificationProvider event filtered unsupported event=${event}`);
      return false;
    }

    const enabledEvents = this.config?.events ?? [...DEFAULT_NTFY_EVENTS];
    const allowed = enabledEvents.includes(event as NtfyNotificationEvent);
    schedulerLog.log(
      `NtfyNotificationProvider allowlist event=${event} decision=${allowed ? "allowed" : "filtered-by-event"}`,
    );
    return allowed;
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
    const senderLabel = resolveParticipantLabel(payload.metadata, "from");
    const recipientLabel = resolveParticipantLabel(payload.metadata, "to");
    const preview = typeof payload.metadata?.preview === "string"
      ? payload.metadata.preview
      : "(no preview)";
    const replyToMessageId = typeof payload.metadata?.replyToMessageId === "string"
      ? payload.metadata.replyToMessageId
      : undefined;
    const roomSenderLabel = resolveRoomSenderLabel(payload.metadata);
    const roomLabel = resolveRoomLabel(payload.metadata);
    const roomId = typeof payload.metadata?.roomId === "string" ? payload.metadata.roomId : undefined;

    const clickUrl = event === "message:room"
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
      "message:room": {
        title: `#${roomLabel} — ${roomSenderLabel}`,
        message: `${roomSenderLabel} in #${roomLabel}: ${preview}`,
        priority: "default",
      },
    };

    const content = contentByEvent[event as SupportedNtfyEvent];
    const resolvedBaseUrl = this.config.ntfyBaseUrl?.trim() || "https://ntfy.sh";
    const host = (() => {
      try {
        return new URL(resolvedBaseUrl).host;
      } catch {
        return "invalid-host";
      }
    })();

    schedulerLog.log(
      `NtfyNotificationProvider send event=${event} host=${host} topic=${this.config.topic}`,
    );

    const response = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: this.config.ntfyBaseUrl,
      ntfyAccessToken: this.config.ntfyAccessToken,
      topic: this.config.topic,
      title: content.title,
      message: content.message,
      priority: content.priority,
      clickUrl,
      signal: this.abortController?.signal,
    });

    schedulerLog.log(
      `NtfyNotificationProvider delivery event=${event} status=${response?.status ?? "error"} ok=${String(response?.ok ?? false)}`,
    );

    return {
      success: Boolean(response?.ok),
      providerId: this.getProviderId(),
      ...(response?.ok ? {} : { error: response ? `${response.status} ${response.statusText}` : "request failed" }),
    };
  }
}
