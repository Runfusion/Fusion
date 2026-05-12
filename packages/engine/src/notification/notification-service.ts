import type {
  ChatRoomMessage,
  Column,
  MergeResult,
  Message,
  NotificationEvent,
  NotificationPayload,
  NotificationProvider,
  Settings,
  Task,
} from "@fusion/core";
import { NotificationDispatcher } from "@fusion/core";
import { DEFAULT_NTFY_EVENTS } from "../notifier.js";
import { schedulerLog } from "../logger.js";
import { NtfyNotificationProvider } from "./ntfy-provider.js";
import { WebhookNotificationProvider } from "./webhook-provider.js";

export interface NotificationServiceOptions {
  /** Project identifier for notification deep links */
  projectId?: string;
  /** Base URL for ntfy.sh (backward compat with NtfyNotifierOptions) */
  ntfyBaseUrl?: string;
  /** Optional message store for mailbox message notifications */
  messageStore?: NotificationMessageStore;
  /** Optional chat store for room message notifications */
  chatStore?: NotificationChatStore;
  /** Resolve human-readable name for an agent ID used in message notifications */
  agentNameResolver?: (agentId: string) => Promise<string | null> | string | null;
}

interface NotificationServiceStore {
  getSettings(): Promise<Settings> | Settings;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

interface NotificationMessageStore {
  on(event: "message:sent", listener: (message: Message) => void): void;
  off?(event: "message:sent", listener: (message: Message) => void): void;
}

export interface NotificationChatStore {
  on(event: "chat:room:message:added", listener: (message: ChatRoomMessage) => void): void;
  off?(event: "chat:room:message:added", listener: (message: ChatRoomMessage) => void): void;
  getRoom?(id: string): { id: string; name: string } | undefined;
}

export class NotificationService {
  private readonly dispatcher = new NotificationDispatcher();
  private readonly notifiedEvents = new Set<string>();
  private started = false;
  private chatStore: NotificationChatStore | undefined;
  private notificationsEnabled = false;
  private ntfyProvider?: NtfyNotificationProvider;
  private webhookProvider?: WebhookNotificationProvider;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly store: NotificationServiceStore,
    private readonly options: NotificationServiceOptions = {},
  ) {
    this.chatStore = options.chatStore;
  }

  attachChatStore(chatStore: NotificationChatStore): void {
    if (this.chatStore && this.chatStore !== chatStore) {
      this.detachChatStoreListener(this.chatStore);
    }
    this.chatStore = chatStore;
    if (this.started) {
      this.chatStore.on("chat:room:message:added", this.handleRoomMessageAdded);
    }
  }

  registerProvider(provider: NotificationProvider): void {
    this.dispatcher.registerProvider(provider);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const settings = await this.store.getSettings();
    this.setNotificationsEnabledFromSettings(settings);
    await this.syncNtfyProvider(settings);
    await this.syncWebhookProvider(settings);

    await this.dispatcher.initializeAll();

    this.store.on("task:moved", this.handleTaskMoved);
    this.store.on("task:updated", this.handleTaskUpdated);
    this.store.on("task:merged", this.handleTaskMerged);
    this.store.on("settings:updated", this.handleSettingsUpdated);
    this.options.messageStore?.on("message:sent", this.handleMessageSent);
    this.started = true;
    this.chatStore?.on("chat:room:message:added", this.handleRoomMessageAdded);
    schedulerLog.log("NotificationService started");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (typeof this.store.off === "function") {
      this.store.off("task:moved", this.handleTaskMoved);
      this.store.off("task:updated", this.handleTaskUpdated);
      this.store.off("task:merged", this.handleTaskMerged);
      this.store.off("settings:updated", this.handleSettingsUpdated);
      if (typeof this.options.messageStore?.off === "function") {
        this.options.messageStore.off("message:sent", this.handleMessageSent);
      }
      this.detachChatStoreListener(this.chatStore);
    }

    await this.dispatcher.shutdownAll();
    this.started = false;

    schedulerLog.log("NotificationService stopped");
  }

  private handleTaskMoved = (data: { task: Task; from: Column; to: Column }): void => {
    if (!this.notificationsEnabled || data.to !== "in-review") {
      return;
    }

    const payload = this.createTaskPayload(data.task, "in-review");
    this.maybeNotify(data.task.id, "in-review", payload);
  };

  private handleTaskUpdated = (task: Task): void => {
    if (!this.notificationsEnabled) {
      return;
    }

    if (task.status === "failed") {
      this.maybeNotify(task.id, "failed", this.createTaskPayload(task, "failed"));
    }

    if (task.status === "awaiting-approval") {
      this.maybeNotify(
        task.id,
        "awaiting-approval",
        this.createTaskPayload(task, "awaiting-approval"),
      );
    }

    if (task.status === "awaiting-user-review") {
      this.maybeNotify(
        task.id,
        "awaiting-user-review",
        this.createTaskPayload(task, "awaiting-user-review"),
      );
    }
  };

  private handleTaskMerged = (result: MergeResult): void => {
    if (!this.notificationsEnabled || !result.merged) {
      return;
    }

    this.maybeNotify(
      result.task.id,
      "merged",
      this.createTaskPayload(result.task, "merged"),
    );
  };

  private handleSettingsUpdated = async (data: { settings: Settings; previous: Settings }): Promise<void> => {
    const { settings, previous } = data;
    this.setNotificationsEnabledFromSettings(settings);

    if (
      settings.ntfyEnabled !== previous.ntfyEnabled ||
      settings.ntfyTopic !== previous.ntfyTopic ||
      settings.ntfyBaseUrl !== previous.ntfyBaseUrl ||
      settings.ntfyAccessToken !== previous.ntfyAccessToken ||
      settings.ntfyDashboardHost !== previous.ntfyDashboardHost ||
      JSON.stringify(settings.ntfyEvents) !== JSON.stringify(previous.ntfyEvents)
    ) {
      const wasEnabled = Boolean(previous.ntfyEnabled && previous.ntfyTopic);
      const isEnabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);

      await this.syncNtfyProvider(settings);

      if (isEnabled && !wasEnabled) {
        schedulerLog.log("NotificationService ntfy enabled");
      } else if (!isEnabled && wasEnabled) {
        schedulerLog.log("NotificationService ntfy disabled");
      } else if (settings.ntfyTopic !== previous.ntfyTopic) {
        schedulerLog.log("NotificationService ntfy topic updated");
      } else if (settings.ntfyBaseUrl !== previous.ntfyBaseUrl) {
        schedulerLog.log("NotificationService ntfy base URL updated");
      } else if (settings.ntfyAccessToken !== previous.ntfyAccessToken) {
        schedulerLog.log("NotificationService ntfy access token updated");
      } else if (settings.ntfyDashboardHost !== previous.ntfyDashboardHost) {
        schedulerLog.log("NotificationService ntfy dashboard host updated");
      } else if (JSON.stringify(settings.ntfyEvents) !== JSON.stringify(previous.ntfyEvents)) {
        schedulerLog.log("NotificationService ntfy events updated");
      }
    }

    if (
      settings.webhookEnabled !== previous.webhookEnabled ||
      settings.webhookUrl !== previous.webhookUrl ||
      settings.webhookFormat !== previous.webhookFormat ||
      JSON.stringify(settings.webhookEvents) !== JSON.stringify(previous.webhookEvents)
    ) {
      await this.syncWebhookProvider(settings);
      schedulerLog.log("WebhookNotificationProvider config updated");
    }
  };

  private async syncNtfyProvider(settings: Settings): Promise<void> {
    const enabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);

    if (!enabled) {
      if (this.ntfyProvider) {
        await this.ntfyProvider.shutdown?.();
        this.dispatcher.unregisterProvider(this.ntfyProvider.getProviderId());
        this.ntfyProvider = undefined;
      }
      return;
    }

    if (!this.ntfyProvider) {
      this.ntfyProvider = new NtfyNotificationProvider();
      this.registerProvider(this.ntfyProvider);
    }

    await this.ntfyProvider.initialize?.({
      topic: settings.ntfyTopic,
      ntfyBaseUrl: settings.ntfyBaseUrl ?? this.options.ntfyBaseUrl,
      ntfyAccessToken: settings.ntfyAccessToken,
      dashboardHost: settings.ntfyDashboardHost,
      events: settings.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS],
      projectId: this.options.projectId,
    });
  }

  private async syncWebhookProvider(settings: Settings): Promise<void> {
    const enabled = Boolean(settings.webhookEnabled && settings.webhookUrl);

    if (!enabled) {
      if (this.webhookProvider) {
        await this.webhookProvider.shutdown?.();
        this.dispatcher.unregisterProvider(this.webhookProvider.getProviderId());
        this.webhookProvider = undefined;
      }
      return;
    }

    if (!this.webhookProvider) {
      this.webhookProvider = new WebhookNotificationProvider();
      this.registerProvider(this.webhookProvider);
    }

    await this.webhookProvider.initialize?.({
      webhookUrl: settings.webhookUrl,
      webhookFormat: settings.webhookFormat ?? "generic",
      events: settings.webhookEvents ?? [],
      dashboardHost: settings.ntfyDashboardHost,
      projectId: this.options.projectId,
    });
  }

  private handleMessageSent = (message: Message): void => {
    void this.handleMessageSentAsync(message);
  };

  private handleRoomMessageAdded = (message: ChatRoomMessage): void => {
    void this.handleRoomMessageAddedAsync(message);
  };

  private async handleMessageSentAsync(message: Message): Promise<void> {
    schedulerLog.log(
      `NotificationService.handleMessageSent messageId=${message.id} type=${message.type} notificationsEnabled=${String(this.notificationsEnabled)} hasNtfyProvider=${String(Boolean(this.ntfyProvider))}`,
    );

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("message:sent");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    let eventType: NotificationEvent;
    if (message.type === "agent-to-user") {
      eventType = "message:agent-to-user";
    } else if (message.type === "agent-to-agent") {
      eventType = "message:agent-to-agent";
    } else {
      return;
    }

    const preview = this.createPreview(message.content);

    const taskId = typeof message.metadata?.taskId === "string" ? message.metadata.taskId : undefined;

    const fromName = await this.resolveAgentName(message.fromType, message.fromId, "from");
    const toName = await this.resolveAgentName(message.toType, message.toId, "to");

    this.maybeNotify(message.id, eventType, {
      taskId,
      taskTitle: undefined,
      event: eventType,
      metadata: {
        messageId: message.id,
        fromId: message.fromId,
        fromType: message.fromType,
        ...(fromName ? { fromName } : {}),
        toId: message.toId,
        toType: message.toType,
        ...(toName ? { toName } : {}),
        type: message.type,
        replyToMessageId: message.metadata?.replyTo?.messageId,
        preview,
      },
    });

    schedulerLog.log(
      `NotificationService.handleMessageSent scheduled eventType=${eventType} messageId=${message.id}`,
    );
  }

  private async handleRoomMessageAddedAsync(message: ChatRoomMessage): Promise<void> {
    schedulerLog.log(
      `NotificationService.handleRoomMessageAdded messageId=${message.id} roomId=${message.roomId} role=${message.role} notificationsEnabled=${String(this.notificationsEnabled)}`,
    );

    if (message.role !== "assistant" || message.senderAgentId == null) {
      return;
    }

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("chat:room:message:added");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    const senderName = await this.resolveAgentName("agent", message.senderAgentId, "from");
    const roomName = this.chatStore?.getRoom?.(message.roomId)?.name;
    const preview = this.createPreview(message.content);

    this.maybeNotify(message.id, "message:room", {
      event: "message:room",
      metadata: {
        messageId: message.id,
        roomId: message.roomId,
        ...(roomName ? { roomName } : {}),
        senderAgentId: message.senderAgentId,
        ...(senderName ? { senderName } : {}),
        preview,
        type: "room-assistant",
      },
    });

    schedulerLog.log(
      `NotificationService.handleRoomMessageAdded scheduled eventType=message:room messageId=${message.id}`,
    );
  }

  private async resolveAgentName(
    participantType: Message["fromType"],
    participantId: string,
    direction: "from" | "to",
  ): Promise<string | null> {
    if (participantType !== "agent") {
      return null;
    }

    const resolver = this.options.agentNameResolver;
    if (!resolver) {
      return null;
    }

    try {
      const resolved = await resolver(participantId);
      const trimmed = typeof resolved === "string" ? resolved.trim() : "";
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      schedulerLog.log(
        `NotificationService.handleMessageSent failed to resolve ${direction} agent name agentId=${participantId} error=${message}`,
      );
      return null;
    }
  }

  private createPreview(content: string): string {
    return content.length > 100 ? `${content.slice(0, 100)}…` : content;
  }

  private detachChatStoreListener(chatStore: NotificationChatStore | undefined): void {
    if (typeof chatStore?.off === "function") {
      chatStore.off("chat:room:message:added", this.handleRoomMessageAdded);
    }
  }

  private setNotificationsEnabledFromSettings(settings: Settings): void {
    this.notificationsEnabled = Boolean(
      (settings.ntfyEnabled && settings.ntfyTopic) ||
      (settings.webhookEnabled && settings.webhookUrl),
    );
  }

  async dispatch(eventType: NotificationEvent, payload: NotificationPayload): Promise<void> {
    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("manual-dispatch");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    const dedupTaskId = payload.taskId ?? "global";
    this.maybeNotify(dedupTaskId, eventType, payload);
  }

  private async refreshNotificationState(reason: string): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }

    this.refreshInFlight = (async () => {
      const settings = await this.store.getSettings();
      this.setNotificationsEnabledFromSettings(settings);
      await this.syncNtfyProvider(settings);
      await this.syncWebhookProvider(settings);
      schedulerLog.log(`NotificationService refreshed notification state reason=${reason} enabled=${String(this.notificationsEnabled)}`);
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private createTaskPayload(task: Task, event: NotificationEvent): NotificationPayload {
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      event,
    };
  }

  private maybeNotify(taskId: string, eventType: NotificationEvent, payload: NotificationPayload): void {
    const key = `${taskId}:${eventType}`;
    if (this.notifiedEvents.has(key)) {
      schedulerLog.log(`NotificationService.maybeNotify suppressed duplicate key=${key}`);
      return;
    }

    this.notifiedEvents.add(key);
    schedulerLog.log(`NotificationService.maybeNotify dispatching key=${key}`);
    this.dispatcher.dispatch(eventType, payload).catch(() => {
      // best effort dispatch
    });
  }
}
