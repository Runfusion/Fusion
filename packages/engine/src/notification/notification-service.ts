import type {
  Column,
  MergeResult,
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

export interface NotificationServiceOptions {
  /** Project identifier for notification deep links */
  projectId?: string;
  /** Base URL for ntfy.sh (backward compat with NtfyNotifierOptions) */
  ntfyBaseUrl?: string;
}

interface NotificationServiceStore {
  getSettings(): Promise<Settings> | Settings;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

export class NotificationService {
  private readonly dispatcher = new NotificationDispatcher();
  private readonly notifiedEvents = new Set<string>();
  private started = false;
  private ntfyEnabled = false;
  private ntfyProvider?: NtfyNotificationProvider;

  constructor(
    private readonly store: NotificationServiceStore,
    private readonly options: NotificationServiceOptions = {},
  ) {}

  registerProvider(provider: NotificationProvider): void {
    this.dispatcher.registerProvider(provider);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const settings = await this.store.getSettings();
    await this.syncNtfyProvider(settings);

    await this.dispatcher.initializeAll();

    this.store.on("task:moved", this.handleTaskMoved);
    this.store.on("task:updated", this.handleTaskUpdated);
    this.store.on("task:merged", this.handleTaskMerged);
    this.store.on("settings:updated", this.handleSettingsUpdated);

    this.started = true;
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
    }

    await this.dispatcher.shutdownAll();
    this.started = false;

    schedulerLog.log("NotificationService stopped");
  }

  private handleTaskMoved = (data: { task: Task; from: Column; to: Column }): void => {
    if (!this.ntfyEnabled || data.to !== "in-review") {
      return;
    }

    const payload = this.createTaskPayload(data.task, "in-review");
    this.maybeNotify(data.task.id, "in-review", payload);
  };

  private handleTaskUpdated = (task: Task): void => {
    if (!this.ntfyEnabled) {
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
    if (!this.ntfyEnabled || !result.merged) {
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

    if (
      settings.ntfyEnabled !== previous.ntfyEnabled ||
      settings.ntfyTopic !== previous.ntfyTopic ||
      settings.ntfyBaseUrl !== previous.ntfyBaseUrl ||
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
      } else if (settings.ntfyDashboardHost !== previous.ntfyDashboardHost) {
        schedulerLog.log("NotificationService ntfy dashboard host updated");
      } else if (JSON.stringify(settings.ntfyEvents) !== JSON.stringify(previous.ntfyEvents)) {
        schedulerLog.log("NotificationService ntfy events updated");
      }
    }
  };

  private async syncNtfyProvider(settings: Settings): Promise<void> {
    const enabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);
    this.ntfyEnabled = enabled;

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
      dashboardHost: settings.ntfyDashboardHost,
      events: settings.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS],
      projectId: this.options.projectId,
    });
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
      return;
    }

    this.notifiedEvents.add(key);
    this.dispatcher.dispatch(eventType, payload).catch(() => {
      // best effort dispatch
    });
  }
}
