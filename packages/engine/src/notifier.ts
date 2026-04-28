import type { Task, Settings, NtfyNotificationEvent } from "@fusion/core";
import type { GridlockEvent } from "./gridlock-detector.js";
import { schedulerLog } from "./logger.js";
import { NotificationService } from "./notification/index.js";

export interface NtfyNotifierOptions {
  /** Base URL for ntfy.sh. Default: https://ntfy.sh */
  ntfyBaseUrl?: string;
  /** Project identifier for deep links in notifications */
  projectId?: string;
}

export type NtfyNotificationPriority = "low" | "default" | "high" | "urgent";

const DEFAULT_NTFY_BASE_URL = "https://ntfy.sh";

export const DEFAULT_NTFY_EVENTS: readonly NtfyNotificationEvent[] = [
  "in-review",
  "merged",
  "failed",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
  "gridlock",
] as const;

export interface NtfyNotificationConfigInput {
  enabled?: boolean;
  topic?: string;
  dashboardHost?: string;
  events?: NtfyNotificationEvent[];
  projectId?: string;
  ntfyBaseUrl?: string;
}

export interface SendNtfyNotificationInput {
  ntfyBaseUrl?: string;
  topic: string;
  title: string;
  message: string;
  priority?: NtfyNotificationPriority;
  clickUrl?: string;
  signal?: AbortSignal;
}

interface NtfyConfig {
  enabled: boolean;
  topic: string | undefined;
  dashboardHost: string | undefined;
  events: NtfyNotificationEvent[];
}

/** Event types for task notification deduplication */
type TaskNotificationEvent = "in-review" | "merged" | "failed" | "awaiting-approval" | "awaiting-user-review";
type AnyNotificationEvent = TaskNotificationEvent | "gridlock";

/**
 * Format a task identifier for notifications.
 * - If title exists: returns "{title}"
 * - If no title: returns "{id}: {first 200 chars of description}" (truncated with "..." if > 200)
 */
export function formatTaskIdentifier(task: Task): string {
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

function resolveNtfyBaseUrl(baseUrl: string | undefined, fallback = DEFAULT_NTFY_BASE_URL): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/\/+$/, "");
}

export function resolveNtfyEvents(events?: NtfyNotificationEvent[]): NtfyNotificationEvent[] {
  return events ? [...events] : [...DEFAULT_NTFY_EVENTS];
}

export function isNtfyEventEnabled(events: NtfyNotificationEvent[] | undefined, event: NtfyNotificationEvent): boolean {
  return resolveNtfyEvents(events).includes(event);
}

export function buildNtfyClickUrl(options: {
  dashboardHost?: string;
  projectId?: string;
  taskId?: string;
}): string | undefined {
  const { dashboardHost, projectId, taskId } = options;
  if (!dashboardHost) {
    return undefined;
  }

  const normalizedHost = dashboardHost.replace(/\/+$/, "");
  const queryParts: string[] = [];

  if (projectId) {
    queryParts.push(`project=${encodeURIComponent(projectId)}`);
  }
  if (taskId) {
    queryParts.push(`task=${encodeURIComponent(taskId)}`);
  }

  const query = queryParts.join("&");
  return query ? `${normalizedHost}/?${query}` : `${normalizedHost}/`;
}

/**
 * Send a notification to ntfy.
 * Errors are logged and swallowed so callers can treat delivery as best-effort.
 */
export async function sendNtfyNotification({
  ntfyBaseUrl,
  topic,
  title,
  message,
  priority = "default",
  clickUrl,
  signal,
}: SendNtfyNotificationInput): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Title: title,
      Priority: priority,
      "Content-Type": "text/plain",
    };

    if (clickUrl) {
      headers.Click = clickUrl;
    }

    const resolvedBaseUrl = resolveNtfyBaseUrl(ntfyBaseUrl);
    const response = await fetch(`${resolvedBaseUrl}/${topic}`, {
      method: "POST",
      headers,
      body: message,
      signal,
    });

    if (!response.ok) {
      schedulerLog.log(`Ntfy notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return;
    }
    schedulerLog.log(`Failed to send ntfy notification: ${err}`);
  }
}

/**
 * NtfyNotifier is a backward-compatible wrapper around NotificationService.
 * It keeps legacy APIs (getConfig, notifyGridlock) while delegating task event
 * notifications to the pluggable provider-based notification module.
 */
export class NtfyNotifier {
  private config: NtfyConfig = {
    enabled: false,
    topic: undefined,
    dashboardHost: undefined,
    events: [...DEFAULT_NTFY_EVENTS],
  };
  private readonly notificationService: NotificationService;
  private ntfyBaseUrl: string;
  private readonly defaultNtfyBaseUrl: string;
  private readonly projectId?: string;
  private notifiedEvents: Set<string> = new Set();
  private abortController: AbortController | null = null;

  constructor(
    private store: NtfyNotifierStore,
    options: NtfyNotifierOptions = {},
  ) {
    this.defaultNtfyBaseUrl = resolveNtfyBaseUrl(options.ntfyBaseUrl);
    this.ntfyBaseUrl = this.defaultNtfyBaseUrl;
    this.projectId = options.projectId;
    this.notificationService = new NotificationService(store, {
      projectId: this.projectId,
      ntfyBaseUrl: options.ntfyBaseUrl,
    });
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const settings = await this.store.getSettings();
    this.loadConfig(settings);
    this.store.on("settings:updated", this.handleSettingsUpdated);
    await this.notificationService.start();
    schedulerLog.log("NtfyNotifier started");
  }

  stop(): void {
    if (typeof this.store.off === "function") {
      this.store.off("settings:updated", this.handleSettingsUpdated);
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    void this.notificationService.stop();
    schedulerLog.log("NtfyNotifier stopped");
  }

  private handleSettingsUpdated = (data: { settings: Settings; previous: Settings }): void => {
    this.loadConfig(data.settings);
  };

  private loadConfig(settings: Settings): void {
    this.config = {
      enabled: settings.ntfyEnabled ?? false,
      topic: settings.ntfyTopic,
      dashboardHost: settings.ntfyDashboardHost,
      events: resolveNtfyEvents(settings.ntfyEvents),
    };
    this.ntfyBaseUrl = resolveNtfyBaseUrl(settings.ntfyBaseUrl, this.defaultNtfyBaseUrl);
  }

  notifyGridlock(event: GridlockEvent): void {
    if (!this.config.enabled || !this.config.topic || !this.isEventEnabled("gridlock")) return;

    const blockedTasks = event.blockedTaskIds.sort();
    const reasonSummary = Object.values(event.reasons).reduce((acc, reason) => {
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {} as Record<"dependency" | "overlap", number>);

    const reasons: string[] = [];
    if (reasonSummary.dependency) reasons.push(`${reasonSummary.dependency} dependency`);
    if (reasonSummary.overlap) reasons.push(`${reasonSummary.overlap} overlap`);

    const clickUrl = buildNtfyClickUrl({
      dashboardHost: this.config.dashboardHost,
      projectId: this.projectId,
    });

    const dedupKey = `gridlock:${blockedTasks.join(",")}`;
    this.maybeNotifyByKey(dedupKey, () =>
      sendNtfyNotification({
        ntfyBaseUrl: this.ntfyBaseUrl,
        topic: this.config.topic!,
        title: "Pipeline gridlocked",
        message: `${event.blockedTaskCount} todo tasks are blocked (${reasons.join(", ")}). Blocked: ${blockedTasks.join(", ")}. Blocking: ${event.blockingTaskIds.join(", ") || "none"}.`,
        priority: "high",
        clickUrl,
        signal: this.abortController?.signal,
      }),
    );
  }

  private isEventEnabled(event: AnyNotificationEvent): boolean {
    return isNtfyEventEnabled(this.config.events, event);
  }

  private maybeNotifyByKey(key: string, notifyFn: () => Promise<void>): void {
    if (this.notifiedEvents.has(key)) {
      return;
    }

    this.notifiedEvents.add(key);
    notifyFn().catch(() => {
      // sendNtfyNotification already logs; notifier must stay best-effort
    });
  }

  getConfig(): NtfyConfig {
    return { ...this.config, events: [...this.config.events] };
  }
}
