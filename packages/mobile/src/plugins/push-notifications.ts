import { Capacitor } from "@capacitor/core";
import { EventEmitter } from "node:events";
import type { PluginEventMap } from "../types.js";

export interface PushNotificationEventMap extends PluginEventMap {
  "notification:received": {
    title: string;
    body: string;
    taskId?: string;
    data?: Record<string, unknown>;
  };
  "notification:tapped": { taskId?: string; data?: Record<string, unknown> };
  "permission:changed": { granted: boolean };
  "token:registered": { token: string };
  "ntfy:message": {
    id: string;
    title: string;
    message: string;
    priority: string;
    clickUrl?: string;
    event?: string;
    taskId?: string;
  };
}

export interface PushNotificationManagerOptions {
  /** ntfy.sh base URL. Default: https://ntfy.sh */
  ntfyBaseUrl?: string;
  /** How to fetch settings for ntfy configuration. Called periodically. */
  settingsFetcher?: () => Promise<{ ntfyEnabled?: boolean; ntfyTopic?: string }>;
  /** Polling interval in ms for ntfy.sh settings refresh. Default: 30000 */
  ntfyPollIntervalMs?: number;
}

type PushNotificationsModule = typeof import("@capacitor/push-notifications");

export class PushNotificationManager extends EventEmitter {
  private deviceToken: string | undefined;
  private ntfyBaseUrl: string;
  private settingsFetcher?: PushNotificationManagerOptions["settingsFetcher"];
  private ntfyPollIntervalMs: number;
  private ntfyAbortController: AbortController | null = null;
  private ntfyCurrentTopic: string | undefined;
  private settingsInterval: ReturnType<typeof setInterval> | null = null;
  private listenerHandles: Array<{ remove: () => Promise<void> }> = [];
  private pushNotifications: PushNotificationsModule["PushNotifications"] | null = null;

  constructor(options: PushNotificationManagerOptions = {}) {
    super();
    this.ntfyBaseUrl = options.ntfyBaseUrl ?? "https://ntfy.sh";
    this.settingsFetcher = options.settingsFetcher;
    this.ntfyPollIntervalMs = options.ntfyPollIntervalMs ?? 30_000;
  }

  override on<K extends keyof PushNotificationEventMap>(
    eventName: K,
    listener: (payload: PushNotificationEventMap[K]) => void,
  ): this;
  override on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(eventName, listener);
  }

  override off<K extends keyof PushNotificationEventMap>(
    eventName: K,
    listener: (payload: PushNotificationEventMap[K]) => void,
  ): this;
  override off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  override off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(eventName, listener);
  }

  emit<K extends keyof PushNotificationEventMap>(
    eventName: K,
    payload: PushNotificationEventMap[K],
  ): boolean;
  emit(eventName: string | symbol, payload?: unknown): boolean;
  emit(eventName: string | symbol, payload?: unknown): boolean {
    return super.emit(eventName, payload);
  }

  async start(): Promise<void> {
    await this.initListeners();
    void this.requestPermission();
    this.startSettingsPoll();
  }

  async destroy(): Promise<void> {
    for (const handle of this.listenerHandles) {
      try {
        await handle.remove();
      } catch (error) {
        console.warn("Failed to remove push notification listener", error);
      }
    }

    this.listenerHandles = [];
    this.stopNtfySubscription();

    if (this.settingsInterval) {
      clearInterval(this.settingsInterval);
      this.settingsInterval = null;
    }

    this.removeAllListeners();
    this.deviceToken = undefined;
    this.pushNotifications = null;
  }

  async requestPermission(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) {
      return false;
    }

    try {
      const pushNotifications = await this.loadPushNotifications();
      if (!pushNotifications) {
        this.emit("permission:changed", { granted: false });
        return false;
      }

      const result = await pushNotifications.requestPermissions();
      const granted = result.receive === "granted";

      if (!granted) {
        this.emit("permission:changed", { granted: false });
        return false;
      }

      await pushNotifications.register();
      this.emit("permission:changed", { granted: true });
      return true;
    } catch (error) {
      console.warn("Failed to request push notification permission", error);
      this.emit("permission:changed", { granted: false });
      return false;
    }
  }

  getDeviceToken(): string | undefined {
    return this.deviceToken;
  }

  async initListeners(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    const pushNotifications = await this.loadPushNotifications();
    if (!pushNotifications) {
      return;
    }

    const registrationHandle = await pushNotifications.addListener("registration", (token) => {
      const value = typeof token?.value === "string" ? token.value : "";
      if (!value) {
        return;
      }

      this.deviceToken = value;
      this.emit("token:registered", { token: value });
    });
    this.listenerHandles.push(registrationHandle);

    const registrationErrorHandle = await pushNotifications.addListener("registrationError", (error) => {
      console.warn("Push registration error", error);
      this.emit("permission:changed", { granted: false });
    });
    this.listenerHandles.push(registrationErrorHandle);

    const receivedHandle = await pushNotifications.addListener("pushNotificationReceived", (notification) => {
      const data = this.normalizeData(notification.data);
      const title = notification.title ?? "";
      const body = notification.body ?? "";
      const taskId = this.extractTaskId({
        data,
        title,
        message: body,
      });

      this.emit("notification:received", {
        title,
        body,
        taskId,
        data,
      });
    });
    this.listenerHandles.push(receivedHandle);

    const actionPerformedHandle = await pushNotifications.addListener("pushNotificationActionPerformed", (actionResult) => {
      const notification = actionResult.notification;
      const data = this.normalizeData(notification?.data);
      const taskId = this.extractTaskId({
        data,
        title: notification?.title,
        message: notification?.body,
      });

      this.emit("notification:tapped", {
        taskId,
        data,
      });
    });
    this.listenerHandles.push(actionPerformedHandle);
  }

  private normalizeData(data: unknown): Record<string, unknown> | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return undefined;
    }

    return data as Record<string, unknown>;
  }

  private extractTaskId(params: {
    data?: Record<string, unknown>;
    clickUrl?: string;
    title?: string;
    message?: string;
  }): string | undefined {
    const directTaskId = params.data?.taskId;
    if (typeof directTaskId === "string" && directTaskId.trim().length > 0) {
      return directTaskId;
    }

    if (params.clickUrl) {
      try {
        const url = new URL(params.clickUrl);
        const taskFromQuery = url.searchParams.get("task");
        if (taskFromQuery && taskFromQuery.trim().length > 0) {
          return taskFromQuery;
        }
      } catch {
        // ignore malformed click URLs
      }
    }

    const combinedText = `${params.title ?? ""} ${params.message ?? ""}`;
    const taskMatch = combinedText.match(/(FN|KB)-\d{3,}/i);
    if (taskMatch?.[0]) {
      return taskMatch[0].toUpperCase();
    }

    return undefined;
  }

  async startNtfySubscription(topic: string): Promise<void> {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      this.stopNtfySubscription();
      return;
    }

    if (this.ntfyCurrentTopic === normalizedTopic && this.ntfyAbortController) {
      return;
    }

    if (this.ntfyCurrentTopic && this.ntfyCurrentTopic !== normalizedTopic) {
      this.stopNtfySubscription();
    }

    const abortController = new AbortController();
    this.ntfyAbortController = abortController;
    this.ntfyCurrentTopic = normalizedTopic;

    try {
      const response = await fetch(`${this.ntfyBaseUrl}/${normalizedTopic}/json`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        console.warn(`Failed to start ntfy subscription for topic ${normalizedTopic}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          this.handleNtfyMessage(line);
        }
      }

      if (buffer.trim()) {
        this.handleNtfyMessage(buffer);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      console.warn(`ntfy subscription error for topic ${normalizedTopic}`, error);
    } finally {
      if (this.ntfyAbortController === abortController) {
        this.ntfyAbortController = null;
        this.ntfyCurrentTopic = undefined;
      }
    }
  }

  stopNtfySubscription(): void {
    if (this.ntfyAbortController) {
      this.ntfyAbortController.abort();
    }

    this.ntfyAbortController = null;
    this.ntfyCurrentTopic = undefined;
  }

  startSettingsPoll(): void {
    if (!this.settingsFetcher) {
      return;
    }

    if (this.settingsInterval) {
      clearInterval(this.settingsInterval);
      this.settingsInterval = null;
    }

    const checkSettings = async () => {
      if (!this.settingsFetcher) {
        return;
      }

      try {
        const settings = await this.settingsFetcher();
        const ntfyEnabled = settings.ntfyEnabled === true;
        const ntfyTopic = settings.ntfyTopic?.trim();

        if (ntfyEnabled && ntfyTopic) {
          if (this.ntfyCurrentTopic !== ntfyTopic) {
            void this.startNtfySubscription(ntfyTopic);
          }
          return;
        }

        this.stopNtfySubscription();
      } catch (error) {
        console.warn("Failed to fetch ntfy settings", error);
      }
    };

    void checkSettings();
    this.settingsInterval = setInterval(() => {
      void checkSettings();
    }, this.ntfyPollIntervalMs);
  }

  private handleNtfyMessage(rawLine: string): void {
    let parsed: Record<string, unknown>;

    try {
      const json = JSON.parse(rawLine);
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return;
      }
      parsed = json as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.event !== "message") {
      return;
    }

    const title = typeof parsed.title === "string" ? parsed.title : "";
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const clickUrl = typeof parsed.click === "string" ? parsed.click : undefined;
    const taskId = this.extractTaskId({
      clickUrl,
      title,
      message,
    });

    const priorityNumber = typeof parsed.priority === "number" ? parsed.priority : 3;
    const priority = this.mapNtfyPriority(priorityNumber);
    const id = typeof parsed.id === "string" ? parsed.id : "";

    this.emit("ntfy:message", {
      id,
      title,
      message,
      priority,
      clickUrl,
      event: "message",
      taskId,
    });
  }

  private mapNtfyPriority(priority: number): string {
    switch (priority) {
      case 1:
        return "low";
      case 4:
        return "high";
      case 5:
        return "urgent";
      case 3:
      default:
        return "default";
    }
  }

  private async loadPushNotifications(): Promise<PushNotificationsModule["PushNotifications"] | null> {
    if (!Capacitor.isNativePlatform()) {
      return null;
    }

    if (this.pushNotifications) {
      return this.pushNotifications;
    }

    try {
      const mod: PushNotificationsModule = await import("@capacitor/push-notifications");
      this.pushNotifications = mod.PushNotifications;
      return this.pushNotifications;
    } catch (error) {
      console.warn("Failed to load @capacitor/push-notifications", error);
      return null;
    }
  }
}
