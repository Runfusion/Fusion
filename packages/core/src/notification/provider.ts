import type { NotificationEvent, NotificationPayload } from "./types.js";
import type { NotificationResult } from "./types.js";

export interface NotificationProvider {
  getProviderId(): string;
  sendNotification(
    event: NotificationEvent,
    payload: NotificationPayload,
  ): Promise<NotificationResult>;
  isEventSupported(event: NotificationEvent): boolean;
  initialize?(config: Record<string, unknown>): Promise<void>;
  shutdown?(): Promise<void>;
}
