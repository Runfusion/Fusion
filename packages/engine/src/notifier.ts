import type { TaskStore, Task, Column, Settings, MergeResult } from "@fusion/core";
import { EventEmitter } from "node:events";
import { schedulerLog } from "./logger.js";

export interface NtfyNotifierOptions {
  /** Base URL for ntfy.sh. Default: https://ntfy.sh */
  ntfyBaseUrl?: string;
}

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

interface NtfyConfig {
  enabled: boolean;
  topic: string | undefined;
  dashboardHost: string | undefined;
}

/** Event types for notification deduplication */
type NotificationEventType = "in-review" | "merged" | "failed";

/**
 * NtfyNotifier sends push notifications via ntfy.sh when tasks complete
 * or fail. It listens to TaskStore events and sends HTTP POST requests
 * to the configured ntfy topic.
 *
 * Features:
 * - Runtime reconfiguration via settings:updated events
 * - Best-effort delivery (errors are logged but never thrown)
 * - Duplicate prevention per event type (in-review, merged, failed)
 * - Configurable notification events (hardcoded defaults)
 */
export class NtfyNotifier {
  private config: NtfyConfig = { enabled: false, topic: undefined, dashboardHost: undefined };
  private ntfyBaseUrl: string;
  /** Tracks which (taskId, eventType) pairs have been notified to prevent duplicates */
  private notifiedEvents: Set<string> = new Set();
  /** AbortController for in-flight requests during shutdown */
  private abortController: AbortController | null = null;

  constructor(
    private store: NtfyNotifierStore,
    options: NtfyNotifierOptions = {},
  ) {
    this.ntfyBaseUrl = options.ntfyBaseUrl ?? "https://ntfy.sh";
  }

  /**
   * Start listening to store events.
   * Must be called after store is initialized.
   * Returns a promise that resolves when initial config is loaded.
   */
  async start(): Promise<void> {
    this.abortController = new AbortController();

    // Load initial config
    const settings = await this.store.getSettings();
    this.loadConfig(settings);

    // Listen for task movements
    this.store.on("task:moved", this.handleTaskMoved);

    // Listen for task updates (status changes)
    this.store.on("task:updated", this.handleTaskUpdated);

    // Listen for merge events
    this.store.on("task:merged", this.handleTaskMerged);

    // Listen for settings changes for runtime reconfiguration
    this.store.on("settings:updated", this.handleSettingsUpdated);

    schedulerLog.log("NtfyNotifier started");
  }

  /**
   * Stop listening to store events and abort in-flight requests.
   */
  stop(): void {
    this.store.off("task:moved", this.handleTaskMoved);
    this.store.off("task:updated", this.handleTaskUpdated);
    this.store.off("task:merged", this.handleTaskMerged);
    this.store.off("settings:updated", this.handleSettingsUpdated);

    // Abort any in-flight requests
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    schedulerLog.log("NtfyNotifier stopped");
  }

  private handleTaskMoved = (data: { task: Task; from: Column; to: Column }): void => {
    if (!this.config.enabled || !this.config.topic) return;

    const { task, to } = data;

    // Notify when task moves to in-review (completed work, ready for review)
    if (to === "in-review") {
      const clickUrl = this.buildTaskUrl(task.id);
      this.maybeNotify(task.id, "in-review", () =>
        this.sendNotification(
          this.config.topic!,
          `Task ${task.id} completed`,
          `Task "${formatTaskIdentifier(task)}" is ready for review`,
          "default",
          clickUrl,
        ),
      );
    }

    // Note: "done" notifications come from handleTaskMerged (task:merged event)
    // to avoid duplicate notifications when moveToDone is called before merge
  };

  private handleTaskUpdated = (task: Task): void => {
    if (!this.config.enabled || !this.config.topic) return;

    // Notify when task fails
    if (task.status === "failed") {
      const clickUrl = this.buildTaskUrl(task.id);
      this.maybeNotify(task.id, "failed", () =>
        this.sendNotification(
          this.config.topic!,
          `Task ${task.id} failed`,
          `Task "${formatTaskIdentifier(task)}" has failed and needs attention`,
          "high",
          clickUrl,
        ),
      );
    }
  };

  private handleTaskMerged = (result: MergeResult): void => {
    if (!this.config.enabled || !this.config.topic) return;

    // Only notify on successful merges
    if (result.merged) {
      const clickUrl = this.buildTaskUrl(result.task.id);
      this.maybeNotify(result.task.id, "merged", () =>
        this.sendNotification(
          this.config.topic!,
          `Task ${result.task.id} merged`,
          `Task "${formatTaskIdentifier(result.task)}" has been merged to main`,
          "default",
          clickUrl,
        ),
      );
    }
  };

  private handleSettingsUpdated = (data: { settings: Settings; previous: Settings }): void => {
    const { settings, previous } = data;

    // Check if ntfy settings changed
    if (settings.ntfyEnabled !== previous.ntfyEnabled ||
        settings.ntfyTopic !== previous.ntfyTopic ||
        settings.ntfyDashboardHost !== previous.ntfyDashboardHost) {
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
      }
    }
  };

  private loadConfig(settings: Settings): void {
    this.config = {
      enabled: settings.ntfyEnabled ?? false,
      topic: settings.ntfyTopic,
      dashboardHost: settings.ntfyDashboardHost,
    };
  }

  /**
   * Build a dashboard URL for deep linking to a task.
   * Returns undefined if dashboardHost is not configured.
   */
  private buildTaskUrl(taskId: string): string | undefined {
    if (!this.config.dashboardHost) {
      return undefined;
    }
    // Strip trailing slash from hostname if present
    const host = this.config.dashboardHost.replace(/\/$/, "");
    return `${host}/?task=${encodeURIComponent(taskId)}`;
  }

  /**
   * Send notification if this (taskId, eventType) pair hasn't been notified before.
   * This prevents duplicate notifications for the same event type per task.
   */
  private maybeNotify(
    taskId: string,
    eventType: NotificationEventType,
    notifyFn: () => Promise<void>,
  ): void {
    const key = `${taskId}:${eventType}`;

    if (this.notifiedEvents.has(key)) {
      // Already sent this notification type for this task
      return;
    }

    this.notifiedEvents.add(key);
    notifyFn().catch(() => {
      // Errors are logged in sendNotification, just need to catch here
    });
  }

  /**
   * Send a notification to ntfy.sh.
   * Errors are caught and logged, never thrown.
   */
  private async sendNotification(
    topic: string,
    title: string,
    message: string,
    priority: "low" | "default" | "high" | "urgent" = "default",
    clickUrl?: string,
  ): Promise<void> {
    const url = `${this.ntfyBaseUrl}/${topic}`;
    const signal = this.abortController?.signal;

    try {
      const headers: Record<string, string> = {
        "Title": title,
        "Priority": priority,
        "Content-Type": "text/plain",
      };

      // Add Click header for deep linking if URL is provided
      if (clickUrl) {
        headers["Click"] = clickUrl;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: message,
        signal,
      });

      if (!response.ok) {
        schedulerLog.log(`Ntfy notification failed: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      // Don't throw - notifications are best-effort
      if (err instanceof Error && err.name === "AbortError") {
        // Expected during shutdown
        return;
      }
      schedulerLog.log(`Failed to send ntfy notification: ${err}`);
    }
  }

  /**
   * Get current config (for testing purposes).
   */
  getConfig(): NtfyConfig {
    return { ...this.config };
  }
}
