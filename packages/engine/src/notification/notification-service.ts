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
import { classifyTransientMergeError } from "../transient-merge-error-classifier.js";
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
  /** Test hook to override failed-notification grace period (default 60_000ms). */
  failedNotificationGraceMs?: number;
}

interface NotificationServiceStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: Column; to: Column }];
  "task:updated": [task: Task];
  "task:merged": [result: MergeResult];
  "settings:updated": [payload: { settings: Settings; previous: Settings }];
}

interface NotificationServiceStore {
  getSettings(): Promise<Settings> | Settings;
  getTask?(id: string): Promise<Task | undefined> | Task | undefined;
  on<K extends keyof NotificationServiceStoreEvents>(
    event: K,
    listener: (...args: NotificationServiceStoreEvents[K]) => void,
  ): void;
  on(event: string | symbol, listener: (...args: any[]) => void): void;
  off<K extends keyof NotificationServiceStoreEvents>(
    event: K,
    listener: (...args: NotificationServiceStoreEvents[K]) => void,
  ): void;
  off(event: string | symbol, listener: (...args: any[]) => void): void;
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
  private readonly pendingFailureNotifications = new Map<string, { timer: NodeJS.Timeout; payload: NotificationPayload }>();
  private readonly pendingFailureStartTimes = new Map<string, number>();
  private readonly failedNotificationGraceMs: number;
  private failureNotificationSuppressedCount = 0;
  private failureNotificationDelayMs = 60_000;
  private failureNotificationMode: "sticky-only" | "all" | "terminal-only" = "sticky-only";

  constructor(
    private readonly store: NotificationServiceStore,
    private readonly options: NotificationServiceOptions = {},
  ) {
    this.chatStore = options.chatStore;
    this.failedNotificationGraceMs = options.failedNotificationGraceMs ?? 60_000;
    this.failureNotificationDelayMs = this.failedNotificationGraceMs;
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
    this.refreshFailureNotificationSettings(settings);
    await this.syncNtfyProvider(settings);
    await this.syncWebhookProvider(settings);

    await this.dispatcher.initializeAll();

    this.store.on("task:created", this.handleTaskCreated);
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
      this.store.off("task:created", this.handleTaskCreated);
      this.store.off("task:moved", this.handleTaskMoved);
      this.store.off("task:updated", this.handleTaskUpdated);
      this.store.off("task:merged", this.handleTaskMerged);
      this.store.off("settings:updated", this.handleSettingsUpdated);
      if (typeof this.options.messageStore?.off === "function") {
        this.options.messageStore.off("message:sent", this.handleMessageSent);
      }
      this.detachChatStoreListener(this.chatStore);
    }

    for (const pending of this.pendingFailureNotifications.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingFailureNotifications.clear();
    this.pendingFailureStartTimes.clear();

    await this.dispatcher.shutdownAll();
    this.started = false;

    schedulerLog.log("NotificationService stopped");
  }

  private handleTaskCreated = (task: Task): void => {
    void this.handleTaskCreatedAsync(task);
  };

  private async handleTaskCreatedAsync(task: Task): Promise<void> {
    if (typeof task.sourceAgentId !== "string" || task.sourceAgentId.trim().length === 0) {
      return;
    }

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("task:created");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    const sourceAgentId = task.sourceAgentId.trim();
    const agentName = await this.resolveAgentName("agent", sourceAgentId, "from");

    this.maybeNotify(task.id, "task-created", {
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      event: "task-created",
      metadata: {
        sourceAgentId,
        ...(agentName ? { agentName } : {}),
        sourceType: task.sourceType,
      },
    });
  }

  private handleTaskMoved = (data: { task: Task; from: Column; to: Column }): void => {
    void this.handleTaskMovedAsync(data);
  };

  private async handleTaskMovedAsync(data: { task: Task; from: Column; to: Column }): Promise<void> {
    await this.maybeSuppressTransientFailedNotification(data.task, `moved to ${data.to}`);

    if (data.to === "in-review") {
      if (!this.notificationsEnabled) {
        await this.refreshNotificationState("task:moved");
        if (!this.notificationsEnabled) {
          return;
        }
      }

      const payload = this.createTaskPayload(data.task, "in-review");
      this.maybeNotify(data.task.id, "in-review", payload);
      return;
    }

    if (data.to === "done" && this.isMergeBackedTerminalTask(data.task)) {
      // `task:merged` remains the canonical terminal merge event. This fallback
      // preserves notification parity for PR/webhook/recovery paths that reach
      // done through moveTask before (or without) a matching task:merged emit;
      // maybeNotify uses the same `merged` key so a later task:merged event is
      // suppressed instead of producing a duplicate alarm.
      if (!this.notificationsEnabled) {
        await this.refreshNotificationState("task:moved:done");
        if (!this.notificationsEnabled) {
          return;
        }
      }

      this.maybeNotify(data.task.id, "merged", this.createTaskPayload(data.task, "merged"));
    }
  };

  private handleTaskUpdated = (task: Task): void => {
    void this.maybeSuppressTransientFailedNotification(task, `status=${task.status ?? "undefined"}`);

    if (!this.notificationsEnabled) {
      return;
    }

    if (task.status === "failed") {
      // FN-5627: Suppress notifications entirely for transient merge failure
      // classes recognized by `classifyTransientMergeError`. These are
      // recovered automatically by `SelfHealingManager.recoverTransientMergeFailures`
      // and the per-tick auto-recovery in `project-engine.ts` fast-path; the
      // task either lands cleanly on a retry or stays in in-review for the
      // bounded recovery budget to handle. Without this guard, every flap
      // cycle (typically every ~5 min when the merger keeps hitting the same
      // transient class) fires another ntfy alarm even though the task is
      // never genuinely stuck — producing user-facing alarm spam with no
      // actionable information.
      const transientClass = classifyTransientMergeError(task.error);
      if (transientClass) {
        this.failureNotificationSuppressedCount += 1;
        schedulerLog.log(
          `[notify] ${task.id} transient merge failure (${transientClass}) — suppressed notification (self-heal in flight)`,
        );
        return;
      }
      if (this.failureNotificationMode === "all") {
        this.maybeNotify(task.id, "failed", this.createTaskPayload(task, "failed"));
      } else {
        this.scheduleFailureNotification(task);
      }
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

    const workflowTransition = this.classifyWorkflowTransitionNotification(task);
    if (workflowTransition) {
      this.maybeNotify(
        task.id,
        workflowTransition.event,
        this.createTaskPayload(task, workflowTransition.event, workflowTransition.metadata),
      );
    }
  };

  private handleTaskMerged = (result: MergeResult): void => {
    void this.handleTaskMergedAsync(result);
  };

  private async handleTaskMergedAsync(result: MergeResult): Promise<void> {
    if (!result.merged) {
      return;
    }

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("task:merged");
      if (!this.notificationsEnabled) {
        return;
      }
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
    this.refreshFailureNotificationSettings(settings);

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
      this.refreshFailureNotificationSettings(settings);
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

  private refreshFailureNotificationSettings(settings: Settings): void {
    this.failureNotificationDelayMs =
      typeof settings.failureNotificationDelayMs === "number" && settings.failureNotificationDelayMs >= 0
        ? settings.failureNotificationDelayMs
        : this.failedNotificationGraceMs;
    this.failureNotificationMode = settings.failureNotificationMode ?? "sticky-only";
  }

  private scheduleFailureNotification(task: Task): void {
    if (this.pendingFailureNotifications.has(task.id)) {
      return;
    }

    this.pendingFailureStartTimes.set(task.id, Date.now());
    const payload = this.createTaskPayload(task, "failed");
    const timer = setTimeout(() => {
      void this.fireDeferredFailureNotification(task.id);
    }, this.failureNotificationDelayMs);
    timer.unref?.();
    this.pendingFailureNotifications.set(task.id, { timer, payload });
  }

  private async maybeSuppressTransientFailedNotification(task: Task, reason: string): Promise<void> {
    if (!this.pendingFailureNotifications.has(task.id)) {
      return;
    }

    const currentTask = (await this.store.getTask?.(task.id)) ?? task;
    const hasAutoRecoveredLog = currentTask.log.some((entry) => /^Auto-recovered:/.test(entry.action));
    const movedToDone = currentTask.column === "done";
    const mergeConfirmed = currentTask.mergeDetails?.mergeConfirmed === true;
    const recoveredStatus = currentTask.status !== "failed" && hasAutoRecoveredLog;

    if (!movedToDone && !mergeConfirmed && !recoveredStatus) {
      return;
    }

    this.cancelPendingFailureNotification(task.id, reason);
  }

  private cancelPendingFailureNotification(taskId: string, reason: string): void {
    const pending = this.pendingFailureNotifications.get(taskId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingFailureNotifications.delete(taskId);
    const startedAt = this.pendingFailureStartTimes.get(taskId);
    this.pendingFailureStartTimes.delete(taskId);
    const elapsedMs = typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : 0;
    this.failureNotificationSuppressedCount += 1;
    schedulerLog.log(`NotificationService.maybeNotify suppressed transient failed key=${taskId}:failed (${reason}, ${elapsedMs}ms)`);
  }

  private async fireDeferredFailureNotification(taskId: string): Promise<void> {
    const pending = this.pendingFailureNotifications.get(taskId);
    if (!pending) {
      return;
    }

    this.pendingFailureNotifications.delete(taskId);
    this.pendingFailureStartTimes.delete(taskId);

    const task = await this.store.getTask?.(taskId);
    if (!task) {
      return;
    }

    if (task.status !== "failed") {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.log(`[notify] ${taskId} no longer failed at dispatch time — suppressed notification`);
      return;
    }

    // FN-5627 defense-in-depth: even when a failure notification was scheduled
    // (e.g., the failure happened slightly before the transient classifier
    // suppression landed on a newer cycle), re-check at dispatch time. Self-
    // healing may have flipped the error to a transient class via FN-5627
    // auto-recovery, in which case ntfy stays silent.
    const transientClassAtDispatch = classifyTransientMergeError(task.error);
    if (transientClassAtDispatch) {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.log(
        `[notify] ${taskId} transient merge failure (${transientClassAtDispatch}) at dispatch time — suppressed notification (self-heal in flight)`,
      );
      return;
    }

    const isTerminal = task.paused === true || task.column === "in-review";
    if (this.failureNotificationMode === "terminal-only" && !isTerminal) {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.log(`[notify] ${taskId} non-terminal failure — suppressed (mode=terminal-only)`);
      return;
    }

    const pausedTask = task as Task & { pausedReason?: string };
    let eventType: NotificationEvent = "failed";
    if (
      pausedTask.paused === true &&
      pausedTask.pausedReason === "dispatch-storm" &&
      DEFAULT_NTFY_EVENTS.includes("failed:auto-paused" as (typeof DEFAULT_NTFY_EVENTS)[number])
    ) {
      eventType = "failed:auto-paused" as NotificationEvent;
    }

    this.maybeNotify(task.id, eventType, eventType === "failed" ? pending.payload : this.createTaskPayload(task, eventType));
  }

  getMetrics(): { failureNotificationSuppressedCount: number } {
    return { failureNotificationSuppressedCount: this.failureNotificationSuppressedCount };
  }

  getPendingFailureCount(): number {
    return this.pendingFailureNotifications.size;
  }

  private isMergeBackedTerminalTask(task: Task): boolean {
    return task.prInfo?.status === "merged" ||
      task.mergeDetails?.mergeConfirmed === true ||
      task.mergeDetails?.noOpMerge === true ||
      typeof task.mergeDetails?.mergedAt === "string";
  }

  private classifyWorkflowTransitionNotification(task: Task): { event: NotificationEvent; metadata: Record<string, unknown> } | null {
    /*
     * FNXC:WorkflowNotifications 2026-06-29-11:50:
     * Workflow-specific operator waits should notify from the durable task update that already represents the wait, not from a new lifecycle bus. Plan/remediation await-input, workflow CLI approval, manual merge holds, and workflow recovery requeues each use a stable dedupe key so repeated task:updated emissions stay quiet while unrelated task notifications can still fire.
     */
    if (task.status === "awaiting-user-input" && this.isWorkflowAwaitingUserInput(task)) {
      return {
        event: "planning-awaiting-input",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:awaiting-user-input`,
          notificationKind: "workflow-awaiting-user-input",
          workflowStatus: task.status,
          pausedReason: task.pausedReason,
        },
      };
    }

    if (task.status === "awaiting-cli-approval" && task.pausedReason?.startsWith("workflow-cli-approval:")) {
      return {
        event: "cli-agent-awaiting-input",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:awaiting-cli-approval`,
          notificationKind: "workflow_cli_approval",
          workflowStatus: task.status,
          pausedReason: task.pausedReason,
        },
      };
    }

    if (task.status !== "failed" && this.isManualMergeHold(task)) {
      return {
        event: "workflow-notify",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:manual-merge-hold`,
          notificationKind: "manual_merge_hold",
          title: `Manual merge needed for ${task.id}`,
          message: "Workflow is holding for manual merge action.",
          pausedReason: task.pausedReason,
        },
      };
    }

    if (this.isWorkflowRecoveryRequeue(task)) {
      return {
        event: "workflow-notify",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:recovery-requeue`,
          notificationKind: "workflow_recovery_requeue",
          title: `Workflow requeued ${task.id}`,
          message: "Workflow recovery moved the task back to todo for another execution pass.",
        },
      };
    }

    return null;
  }

  private isWorkflowAwaitingUserInput(task: Task): boolean {
    if (!task.paused) {
      return false;
    }
    const pausedReason = task.pausedReason ?? "";
    const latest = this.latestLogAction(task);
    return pausedReason.startsWith("workflow-input:")
      || latest.startsWith("Workflow paused for user input")
      || (latest.startsWith("Workflow step ") && latest.includes(" is waiting for your input:"));
  }

  private isManualMergeHold(task: Task): boolean {
    if (task.column !== "in-review") {
      return false;
    }
    if (task.pausedReason === "manual-hold") {
      return true;
    }
    const latest = this.latestLogAction(task).toLowerCase();
    return latest.includes("manual-required")
      || latest.includes("manual merge required")
      || latest.includes("merge-manual-hold");
  }

  private isWorkflowRecoveryRequeue(task: Task): boolean {
    if (task.column !== "todo" || task.status === "failed") {
      return false;
    }
    const latest = this.latestLogAction(task).toLowerCase();
    return latest.includes("workflow")
      && (latest.includes("requeued") || latest.includes("moved back to todo"));
  }

  private latestLogAction(task: Task): string {
    return task.log.at(-1)?.action ?? "";
  }

  private createTaskPayload(task: Task, event: NotificationEvent, metadata?: Record<string, unknown>): NotificationPayload {
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      event,
      ...(metadata ? { metadata } : {}),
    };
  }

  private maybeNotify(taskId: string, eventType: NotificationEvent, payload: NotificationPayload): void {
    const metadataDedupeKey = typeof payload.metadata?.notificationDedupeKey === "string"
      ? payload.metadata.notificationDedupeKey.trim()
      : "";
    /*
     * FNXC:ToolPermissionNotifications 2026-06-27-00:00:
     * Some notification surfaces are not task-lifecycle events. Honor a caller-provided dedupe key so CLI tool-permission prompts can suppress repeated telemetry records without suppressing unrelated future task notifications.
     */
    const key = metadataDedupeKey.length > 0 ? metadataDedupeKey : `${taskId}:${eventType}`;
    if (this.notifiedEvents.has(key)) {
      schedulerLog.log(`NotificationService.maybeNotify suppressed duplicate key=${key}`);
      return;
    }

    this.notifiedEvents.add(key);
    schedulerLog.log(`NotificationService.maybeNotify dispatching key=${key}`);
    this.dispatcher.dispatch(eventType, payload).then((results) => {
      if (results.some((result) => result.success)) {
        return;
      }
      this.notifiedEvents.delete(key);
      schedulerLog.log(
        `NotificationService.maybeNotify no successful providers for key=${key} results=${JSON.stringify(results)}`,
      );
    }).catch((error) => {
      this.notifiedEvents.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      schedulerLog.log(`NotificationService.maybeNotify dispatch failed key=${key} error=${message}`);
    });
  }
}
