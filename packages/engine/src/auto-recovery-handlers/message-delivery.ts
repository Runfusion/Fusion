import type { AutoRecoverySettings } from "@fusion/core";
import { createLogger, type Logger } from "../logger.js";
import type { RunAuditor } from "../run-audit.js";

const baseLog = createLogger("auto-recovery:message-delivery");

export interface MessageDeliveryRecoveryDeps {
  runAudit: RunAuditor;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetryBurn?: (attempt: number) => Promise<void>;
}

export interface MessageDeliveryAttempt<T> {
  run: () => Promise<T>;
  correlation: { kind: "direct" | "room"; fromAgentId: string; toId?: string; roomId?: string };
  runId?: string;
}

export class MessageDeliveryAutoRecoveryHandler {
  constructor(private readonly deps: MessageDeliveryRecoveryDeps) {}

  private get logger(): Logger {
    return this.deps.logger ?? baseLog;
  }

  private isRetryMode(settings: AutoRecoverySettings): boolean {
    return settings.mode === "programmatic" || settings.mode === "ai-assisted";
  }

  private isTransientError(error: Error): boolean {
    const code = (error as Error & { code?: string }).code;
    const message = error.message.toLowerCase();
    return code === "SQLITE_BUSY"
      || message.includes("sqlite_busy")
      || message.includes("timeout")
      || message.includes("econnreset")
      || message.includes("eai_again");
  }

  async runWithBoundedRetry<T>(
    attempt: MessageDeliveryAttempt<T>,
    settings: AutoRecoverySettings,
    onRetryBurn?: () => Promise<void>,
  ): Promise<{ outcome: "delivered"; value: T } | { outcome: "parked"; error: Error; attempts: number }> {
    const maxAttempts = Math.max(1, settings.maxRetries ?? 3);
    const shouldRetry = this.isRetryMode(settings);
    const backoffs = [50, 200, 800];
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const value = await attempt.run();
        if (attempts > 1) {
          await this.deps.runAudit.database({
            type: "message-delivery:retry-issued",
            target: attempt.correlation.fromAgentId,
            metadata: { correlation: attempt.correlation, attempt: attempts, mode: settings.mode },
          });
          if (onRetryBurn) {
            await onRetryBurn();
          } else if (this.deps.onRetryBurn) {
            await this.deps.onRetryBurn(attempts);
          }
        }
        return { outcome: "delivered", value };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const transient = this.isTransientError(normalized);
        if (!transient || !shouldRetry || attempts >= maxAttempts) {
          await this.deps.runAudit.database({
            type: "message-delivery:park",
            target: attempt.correlation.fromAgentId,
            metadata: {
              correlation: attempt.correlation,
              attempts,
              errorMessage: normalized.message,
              mode: settings.mode,
            },
          });
          return { outcome: "parked", error: normalized, attempts };
        }
        const delayMs = backoffs[Math.min(attempts - 1, backoffs.length - 1)];
        this.logger.warn(`message-delivery retrying ${attempt.correlation.kind} message for ${attempt.correlation.fromAgentId} attempt=${attempts + 1}`);
        await (this.deps.sleep ? this.deps.sleep(delayMs) : new Promise((resolve) => setTimeout(resolve, delayMs)));
      }
    }

    const exhausted = new Error("message delivery retry loop exhausted");
    return { outcome: "parked", error: exhausted, attempts: maxAttempts };
  }
}
