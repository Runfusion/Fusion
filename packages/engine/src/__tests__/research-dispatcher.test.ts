import { describe, expect, it, vi } from "vitest";
import type { ResearchRun, ResearchStore } from "@fusion/core";
import type { ResearchOrchestrator } from "../research/research-orchestrator.js";
import { ResearchRunDispatcher } from "../research/research-dispatcher.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ResearchRunDispatcher", () => {
  function createStore(runs: ResearchRun[]): ResearchStore {
    return {
      listRuns: vi.fn(() => runs),
    } as unknown as ResearchStore;
  }

  it("dispatches queued runs", async () => {
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => ({ id: "RR-1" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await sleep(30);

    expect(startRun).toHaveBeenCalledWith("RR-1", "hello", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    await dispatcher.stop();
  });

  it("does not double-dispatch in-flight runs", async () => {
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    let resolveRun: (() => void) | undefined;
    const startRun = vi.fn(() => new Promise<ResearchRun>((resolve) => {
      resolveRun = () => resolve({ id: "RR-1" } as ResearchRun);
    }));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await sleep(40);
    expect(startRun).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await sleep(10);
    await dispatcher.stop();
  });

  it("survives startRun rejection", async () => {
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => {
      throw new Error("boom");
    });
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await sleep(40);

    expect(startRun).toHaveBeenCalled();
    await dispatcher.stop();
  });

  it("stop cancels timer", async () => {
    const runs = [{ id: "RR-1", query: "hello", status: "queued" } as ResearchRun];
    const store = createStore(runs);
    const startRun = vi.fn(async () => ({ id: "RR-1" } as ResearchRun));
    const orchestrator = { startRun } as unknown as ResearchOrchestrator;

    const dispatcher = new ResearchRunDispatcher({ store, orchestrator, tickIntervalMs: 10 });
    dispatcher.start();
    await sleep(30);
    await dispatcher.stop();

    const callsAfterStop = startRun.mock.calls.length;
    await sleep(40);
    expect(startRun).toHaveBeenCalledTimes(callsAfterStop);
  });
});
