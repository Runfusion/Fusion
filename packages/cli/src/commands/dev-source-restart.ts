import type { EventEmitter } from "node:events";

export const DEV_SOURCE_CHANGE_MESSAGE = "fusion:dev-source-changed";
export const DEV_SOURCE_RESTART_ARMED_MESSAGE = "fusion:dev-source-restart-armed";

interface DevSourceChangeMessage {
  type: typeof DEV_SOURCE_CHANGE_MESSAGE;
}

interface DevSourceRestartOptions {
  enabled: boolean;
  processEvents?: Pick<EventEmitter, "on" | "off">;
  notifyArmed?: () => void;
  beginDrain: () => Promise<void> | void;
  getLiveRunningAgentCounts: () => Promise<{ currentlyActive: number }>;
  requestRestart: (reason: string) => boolean;
  logger?: Pick<Console, "log" | "warn">;
  recheckIntervalMs?: number;
}

function isDevSourceChangeMessage(message: unknown): message is DevSourceChangeMessage {
  return Boolean(message)
    && typeof message === "object"
    && (message as { type?: unknown }).type === DEV_SOURCE_CHANGE_MESSAGE;
}

/**
 * FNXC:DevEngineWatch 2026-08-04-01:25:
 * A source edit is an intentional restart, not a crash or operating-system
 * signal. Wait for live top-level agents to drain, then enter the dashboard's
 * canonical exit-86 path so its existing graceful teardown and supervisor own
 * the lifecycle. Liveness read failures defer rather than aborting active work.
 */
export function registerDevSourceRestart({
  enabled,
  processEvents = process,
  notifyArmed,
  beginDrain,
  getLiveRunningAgentCounts,
  requestRestart,
  logger = console,
  recheckIntervalMs = 15_000,
}: DevSourceRestartOptions): () => void {
  if (!enabled) return () => undefined;

  let disposed = false;
  let pending = false;
  let checking = false;
  let restartAccepted = false;
  let deferredForActiveWork = false;
  let drainStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void checkRestartSafety();
    }, delayMs);
    timer.unref?.();
  };

  const checkRestartSafety = async () => {
    if (disposed || restartAccepted || !pending || checking) return;
    checking = true;
    try {
      const { currentlyActive } = await getLiveRunningAgentCounts();
      if (currentlyActive > 0) {
        if (!deferredForActiveWork) {
          const noun = currentlyActive === 1 ? "agent" : "agents";
          logger.log(`[fusion:dev] source restart deferred until ${currentlyActive} active ${noun} reach a safe boundary`);
          deferredForActiveWork = true;
        }
        schedule(recheckIntervalMs);
        return;
      }

      if (deferredForActiveWork) {
        logger.log("[fusion:dev] active work drained — applying pending source restart");
        deferredForActiveWork = false;
      }
      restartAccepted = requestRestart("dev-source-change");
      if (restartAccepted) {
        pending = false;
      } else {
        logger.warn("[fusion:dev] source restart request was declined by the host lifecycle");
        schedule(recheckIntervalMs);
      }
    } catch (error) {
      logger.warn(`[fusion:dev] could not verify restart safety: ${error instanceof Error ? error.message : String(error)}`);
      schedule(recheckIntervalMs);
    } finally {
      checking = false;
    }
  };

  const onMessage = (message: unknown) => {
    if (restartAccepted || !isDevSourceChangeMessage(message)) return;
    pending = true;
    if (drainStarted) return;
    drainStarted = true;
    // FNXC:DevSourceRestart 2026-08-04-09:19:
    // Enter the promise chain before draining so synchronous failures are logged instead of escaping IPC dispatch.
    void Promise.resolve()
      .then(beginDrain)
      .then(() => schedule(0))
      .catch((error) => {
        logger.warn(`[fusion:dev] could not begin source restart drain: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  processEvents.on("message", onMessage);
  notifyArmed?.();
  return () => {
    disposed = true;
    pending = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    processEvents.off("message", onMessage);
  };
}
