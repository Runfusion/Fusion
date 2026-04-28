export {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationPayload,
  type NotificationProviderConfig,
} from "../types.js";

export interface NotificationResult {
  success: boolean;
  providerId: string;
  error?: string;
}

export interface NotificationDispatcherConfig {
  maxRetries?: number;
  retryDelayMs?: number;
}
