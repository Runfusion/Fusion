import type { NotificationProvider } from "./provider.js";
import type {
  NotificationDispatcherConfig,
  NotificationEvent,
  NotificationPayload,
  NotificationResult,
} from "./types.js";

export class NotificationDispatcher {
  private readonly providers = new Map<string, NotificationProvider>();

  constructor(private readonly config: NotificationDispatcherConfig = {}) {}

  registerProvider(provider: NotificationProvider): void {
    this.providers.set(provider.getProviderId(), provider);
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  getProviders(): readonly NotificationProvider[] {
    return [...this.providers.values()];
  }

  async dispatch(
    event: NotificationEvent,
    payload: NotificationPayload,
  ): Promise<NotificationResult[]> {
    const providers = this.getProviders().filter((provider) =>
      provider.isEventSupported(event),
    );

    const results = await Promise.all(
      providers.map(async (provider): Promise<NotificationResult> => {
        const providerId = provider.getProviderId();
        try {
          return await provider.sendNotification(event, payload);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[notification-dispatcher] Provider ${providerId} failed for event ${event}: ${message}`,
          );
          return { success: false, providerId, error: message };
        }
      }),
    );

    return results;
  }

  async initializeAll(): Promise<void> {
    await Promise.all(
      this.getProviders().map(async (provider) => {
        if (!provider.initialize) {
          return;
        }

        try {
          await provider.initialize(this.config as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[notification-dispatcher] Provider ${provider.getProviderId()} initialization failed: ${message}`,
          );
        }
      }),
    );
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(
      this.getProviders().map(async (provider) => {
        if (!provider.shutdown) {
          return;
        }

        try {
          await provider.shutdown();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[notification-dispatcher] Provider ${provider.getProviderId()} shutdown failed: ${message}`,
          );
        }
      }),
    );
  }
}
