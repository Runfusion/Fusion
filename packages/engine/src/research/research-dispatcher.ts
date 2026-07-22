import type { ResearchRun } from "@fusion/core";
import { createLogger, formatError } from "../logger.js";
import type { ResearchExecutorStore, ResearchOrchestrator } from "./research-orchestrator.js";

const log = createLogger("research-dispatcher");

export interface ResearchRunDispatcherOptions {
  store: ResearchExecutorStore;
  orchestrator: ResearchOrchestrator;
  tickIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

export class ResearchRunDispatcher {
  // FNXC:ResearchStore 2026-06-28-11:30: store is the sync ResearchStore or the
  // PG-backed AsyncResearchStore union; listRuns is awaited so queued-run polling
  // works in both backends.
  private readonly store: ResearchExecutorStore;
  private readonly orchestrator: ResearchOrchestrator;
  private readonly tickIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: ResearchRunDispatcherOptions) {
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.tickIntervalMs = Math.max(100, options.tickIntervalMs ?? 1_000);
    this.shutdownTimeoutMs = Math.max(500, options.shutdownTimeoutMs ?? 5_000);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const controller of this.controllers.values()) {
      controller.abort(new Error("Research dispatcher stopped"));
    }

    const start = Date.now();
    while (this.inFlight.size > 0 && Date.now() - start < this.shutdownTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    let queuedRuns: ResearchRun[] = [];
    try {
      queuedRuns = await this.store.listRuns({ status: "queued" });
    } catch (error) {
      const { message, detail } = formatError(error);
      log.warn(`Failed to list queued research runs: ${message}\n${detail}`);
      return;
    }

    for (const run of queuedRuns) {
      if (this.inFlight.has(run.id)) continue;
      const controller = new AbortController();
      this.inFlight.add(run.id);
      this.controllers.set(run.id, controller);
      void this.orchestrator
        .startRun(run.id, run.query, { abortSignal: controller.signal })
        .catch((error) => {
          const { message, detail } = formatError(error);
          log.warn(`Failed to dispatch research run ${run.id}: ${message}\n${detail}`);
        })
        .finally(() => {
          this.inFlight.delete(run.id);
          this.controllers.delete(run.id);
        });
    }
  }
}
