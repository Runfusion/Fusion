import type { Task, Settings, NtfyNotificationEvent } from "@fusion/core";
import type { GridlockEvent } from "../healing/gridlock-detector.js";
import { schedulerLog } from "../logger.js";
import { NotificationService } from "../index.js";

export interface NtfyNotifierOptions {
  /** Base URL for ntfy.sh. Default: https://ntfy.sh */
  ntfyBaseUrl?: string;
  /** Project identifier for deep links in notifications */
  projectId?: string;
  /** Resolve human-readable agent names for message notifications */
  agentNameResolver?: (agentId: string) => Promise<string | null> | string | null;
}

export type NtfyNotificationPriority = "low" | "default" | "high" | "urgent";

const DEFAULT_NTFY_BASE_URL = "https://ntfy.sh";
const GRIDLOCK_NOTIFICATION_COOLDOWN_MS = 15 * 60 * 1000;
const NTFY_TITLE_MAX = 250;
// ntfy documents a 4 KiB message body limit; reserve room for an ellipsis when truncating UTF-8 payloads.
const NTFY_MESSAGE_MAX = 4096;
const DEFAULT_NTFY_MAX_ATTEMPTS = 3;
const DEFAULT_NTFY_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_NTFY_RETRY_DELAY_MS = 500;

export const DEFAULT_NTFY_EVENTS: readonly NtfyNotificationEvent[] = [
  "in-review",
  "merged",
  // FNXC:TaskWedgeNotifications 2026-07-22-19:00: Wedge episodes are operator
  // escalation events, so normal Ntfy defaults must not silently filter them.
  "failed",
  "task-wedged",
  "awaiting-approval",
  "awaiting-user-review",
  "planning-awaiting-input",
  "cli-agent-awaiting-input",
  "gridlock",
  "board-stall-unrecovered",
  "db-corruption-detected",
  "fallback-used",
  "token-budget",
  "workflow-notify",
  "message:agent-to-user",
  "message:agent-to-agent",
  "message:room",
  "oauth-token-expired",
] as const;

export interface NtfyNotificationConfigInput {
  enabled?: boolean;
  topic?: string;
  dashboardHost?: string;
  events?: NtfyNotificationEvent[];
  projectId?: string;
  ntfyBaseUrl?: string;
  ntfyAccessToken?: string;
}

export interface SendNtfyNotificationInput {
  ntfyBaseUrl?: string;
  ntfyAccessToken?: string;
  topic: string;
  title: string;
  message: string;
  priority?: NtfyNotificationPriority;
  clickUrl?: string;
  signal?: AbortSignal;
  /** @internal Test seam for exercising timeout behavior without slow wall-clock waits. */
  attemptTimeoutMs?: number;
  /** @internal Test seam for exercising retry behavior without slow wall-clock waits. */
  retryDelayMs?: number;
  /** @internal Test seam for keeping retry-bound assertions narrow. */
  maxAttempts?: number;
}

interface NtfyConfig {
  enabled: boolean;
  topic: string | undefined;
  dashboardHost: string | undefined;
  events: NtfyNotificationEvent[];
}

/** Event types for task notification deduplication */
type TaskNotificationEvent = "in-review" | "merged" | "failed" | "awaiting-approval" | "awaiting-user-review";
type AnyNotificationEvent = TaskNotificationEvent | "gridlock" | "board-stall-unrecovered" | "fallback-used";

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

function isLatin1Safe(value: string): boolean {
  for (const char of value) {
    if (char.codePointAt(0)! > 0xff) {
      return false;
    }
  }
  return true;
}

function truncateNtfyTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= NTFY_TITLE_MAX) {
    return title;
  }
  return `${characters.slice(0, NTFY_TITLE_MAX - 1).join("")}…`;
}

function truncateNtfyMessage(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= NTFY_MESSAGE_MAX) {
    return message;
  }

  const characters = Array.from(message);
  let low = 0;
  let high = characters.length;
  let best = "…";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, mid).join("")}…`;
    if (Buffer.byteLength(candidate, "utf8") <= NTFY_MESSAGE_MAX) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function ntfyPriorityToInt(priority: NtfyNotificationPriority): number {
  switch (priority) {
    case "low":
      return 2;
    case "high":
      return 4;
    case "urgent":
      return 5;
    case "default":
    default:
      return 3;
  }
}

function isRetryableNtfyStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  if (signal?.aborted) {
    return Promise.resolve("aborted");
  }
  if (ms <= 0) {
    return Promise.resolve("slept");
  }

  return new Promise((resolve) => {
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const onAbort = () => {
      cleanup();
      resolve("aborted");
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve("slept");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveNtfyEvents(events?: NtfyNotificationEvent[]): NtfyNotificationEvent[] {
  return events && events.length > 0 ? [...events] : [...DEFAULT_NTFY_EVENTS];
}

export function isNtfyEventEnabled(events: NtfyNotificationEvent[] | undefined, event: NtfyNotificationEvent): boolean {
  return resolveNtfyEvents(events).includes(event);
}

export function buildNtfyClickUrl(options: {
  dashboardHost?: string;
  projectId?: string;
  taskId?: string;
  messageId?: string;
  roomId?: string;
  view?: string;
}): string | undefined {
  const { dashboardHost, projectId, taskId, messageId, roomId, view } = options;
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
  } else if (roomId) {
    queryParts.push(`view=${encodeURIComponent(view ?? "rooms")}`);
    queryParts.push(`room=${encodeURIComponent(roomId)}`);
  } else if (messageId) {
    queryParts.push(`view=${encodeURIComponent(view ?? "mailbox")}`);
    queryParts.push(`mailbox-message=${encodeURIComponent(messageId)}`);
  }

  const query = queryParts.join("&");
  const baseUrl = query ? `${normalizedHost}/?${query}` : `${normalizedHost}/`;

  if (messageId) {
    return `${baseUrl}#message-${encodeURIComponent(messageId)}`;
  }

  return baseUrl;
}

/**
 * Send a notification to ntfy.
 * Errors are logged and swallowed so callers can treat delivery as best-effort.
 */
export async function sendNtfyNotificationWithResult({
  ntfyBaseUrl,
  ntfyAccessToken,
  topic,
  title,
  message,
  priority = "default",
  clickUrl,
  signal,
  attemptTimeoutMs = DEFAULT_NTFY_ATTEMPT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_NTFY_RETRY_DELAY_MS,
  maxAttempts = DEFAULT_NTFY_MAX_ATTEMPTS,
}: SendNtfyNotificationInput): Promise<{ ok: boolean; status: number; statusText: string } | null> {
  const resolvedMaxAttempts = Math.max(1, Math.floor(maxAttempts));

  try {
    const resolvedBaseUrl = resolveNtfyBaseUrl(ntfyBaseUrl);
    const trimmedToken = ntfyAccessToken?.trim();
    const truncatedTitle = truncateNtfyTitle(title);
    const truncatedMessage = truncateNtfyMessage(message);
    const latin1Safe = isLatin1Safe(truncatedTitle) && isLatin1Safe(truncatedMessage);
    const url = latin1Safe ? `${resolvedBaseUrl}/${topic}` : `${resolvedBaseUrl}/`;
    const body = latin1Safe
      ? truncatedMessage
      : JSON.stringify({
        topic,
        title: truncatedTitle,
        message: truncatedMessage,
        priority: ntfyPriorityToInt(priority),
        ...(clickUrl ? { click: clickUrl } : {}),
      });

    /*
    FNXC:Notifications 2026-06-25-18:25:
    Task notifications are one-shot and a single transient ntfy network failure, timeout, 5xx, or 429 can permanently lose the user-facing event.
    Keep ntfy best-effort and never-throwing, but bound each attempt with an internal timeout and retry only retryable failures while honoring caller lifecycle aborts immediately.
    */
    for (let attempt = 1; attempt <= resolvedMaxAttempts; attempt += 1) {
      if (signal?.aborted) {
        return null;
      }

      const attemptController = new AbortController();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onCallerAbort = () => attemptController.abort();
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (attemptTimeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, attemptTimeoutMs);
      }

      try {
        const headers: Record<string, string> = {
          "Content-Type": latin1Safe ? "text/plain" : "application/json",
        };

        if (latin1Safe) {
          headers.Priority = priority;
          headers.Title = truncatedTitle;
          if (clickUrl) {
            headers.Click = clickUrl;
          }
        }

        if (trimmedToken) {
          headers.Authorization = `Bearer ${trimmedToken}`;
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: attemptController.signal,
        });

        if (!response.ok) {
          schedulerLog.log(`Ntfy notification failed: ${response.status} ${response.statusText}`);
        }

        const result = {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
        };
        if (response.ok || !isRetryableNtfyStatus(response.status) || attempt === resolvedMaxAttempts) {
          return result;
        }
      } catch (err) {
        if (signal?.aborted || (isAbortError(err) && !timedOut)) {
          return null;
        }
        if (attempt === resolvedMaxAttempts) {
          schedulerLog.log(`Failed to send ntfy notification: ${err}`);
          return null;
        }
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", onCallerAbort);
      }

      const slept = await sleep(retryDelayMs, signal);
      if (slept === "aborted") {
        return null;
      }
    }
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      return null;
    }
    schedulerLog.log(`Failed to send ntfy notification: ${err}`);
  }

  return null;
}

export async function sendNtfyNotification(input: SendNtfyNotificationInput): Promise<void> {
  await sendNtfyNotificationWithResult(input);
}

/**
 * NtfyNotifier is a backward-compatible wrapper around NotificationService.
 * It keeps legacy APIs (getConfig, notifyGridlock) while delegating task event
 * notifications to the pluggable provider-based notification module.
 */
let activeNotificationService: NotificationService | undefined;

export function getActiveNotificationService(): NotificationService | undefined {
  return activeNotificationService;
}

export interface FallbackNotificationInput {
  primaryModel: string;
  fallbackModel: string;
  triggerPoint: "session-creation" | "prompt-time";
  taskId?: string;
  taskTitle?: string;
  timestamp?: string;
}

export async function notifyFallbackUsed(input: FallbackNotificationInput): Promise<void> {
  if (!activeNotificationService) {
    return;
  }

  await activeNotificationService.dispatch("fallback-used", {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    event: "fallback-used",
    timestamp: input.timestamp,
    metadata: {
      primaryModel: input.primaryModel,
      fallbackModel: input.fallbackModel,
      triggerPoint: input.triggerPoint,
    },
  });
}

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
  private abortController: AbortController | null = null;
  private lastGridlockNotificationAt: number | null = null;
  private lastBoardStallNotificationAt: number | null = null;

  constructor(
    private store: NtfyNotifierStore,
    options: NtfyNotifierOptions = {},
    notificationService?: NotificationService,
  ) {
    this.defaultNtfyBaseUrl = resolveNtfyBaseUrl(options.ntfyBaseUrl);
    this.ntfyBaseUrl = this.defaultNtfyBaseUrl;
    this.projectId = options.projectId;
    this.notificationService = notificationService ?? new NotificationService(store, {
      projectId: this.projectId,
      ntfyBaseUrl: options.ntfyBaseUrl,
      agentNameResolver: options.agentNameResolver,
    });
    activeNotificationService = this.notificationService;
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

  notifyGridlock(event: GridlockEvent | null): void {
    if (event === null) {
      this.lastGridlockNotificationAt = null;
      return;
    }

    if (!this.config.enabled || !this.config.topic || !this.isEventEnabled("gridlock")) return;

    const now = Date.now();
    if (
      this.lastGridlockNotificationAt !== null
      && now - this.lastGridlockNotificationAt < GRIDLOCK_NOTIFICATION_COOLDOWN_MS
    ) {
      return;
    }

    const blockedTasks = [...event.blockedTaskIds].sort();
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

    this.lastGridlockNotificationAt = now;
    sendNtfyNotification({
      ntfyBaseUrl: this.ntfyBaseUrl,
      topic: this.config.topic!,
      title: "Pipeline gridlocked",
      message: `${event.blockedTaskCount} todo tasks are blocked (${reasons.join(", ")}). Blocked: ${blockedTasks.join(", ")}. Blocking: ${event.blockingTaskIds.join(", ") || "none"}.`,
      priority: "high",
      clickUrl,
      signal: this.abortController?.signal,
    }).catch(() => {
      // sendNtfyNotification already logs; notifier must stay best-effort
    });
  }

  private isEventEnabled(event: AnyNotificationEvent): boolean {
    return isNtfyEventEnabled(this.config.events, event);
  }

  async notifyBoardStallUnrecovered(input: { holderIds: string[]; followerCount: number; projectId?: string }): Promise<void> {
    if (!this.config.enabled || !this.config.topic || !this.isEventEnabled("board-stall-unrecovered")) return;
    const now = Date.now();
    if (this.lastBoardStallNotificationAt !== null && now - this.lastBoardStallNotificationAt < GRIDLOCK_NOTIFICATION_COOLDOWN_MS) {
      return;
    }
    const clickUrl = buildNtfyClickUrl({
      dashboardHost: this.config.dashboardHost,
      projectId: input.projectId ?? this.projectId,
    });
    this.lastBoardStallNotificationAt = now;
    await sendNtfyNotification({
      ntfyBaseUrl: this.ntfyBaseUrl,
      topic: this.config.topic,
      title: "Board stall unrecovered",
      message: `Auto-recovery could not clear board stall. Holders: ${input.holderIds.join(", ") || "none"}. Followers blocked: ${input.followerCount}.`,
      priority: "high",
      clickUrl,
      signal: this.abortController?.signal,
    });
  }

  getConfig(): NtfyConfig {
    return { ...this.config, events: [...this.config.events] };
  }
}
