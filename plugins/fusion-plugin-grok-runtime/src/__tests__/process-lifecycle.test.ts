import { afterEach, describe, expect, it, vi } from "vitest";

const EVENTS = ["exit", "beforeExit", "SIGTERM", "SIGINT"] as const;

function listenerCounts(): Record<(typeof EVENTS)[number], number> {
  return Object.fromEntries(EVENTS.map((event) => [event, process.listenerCount(event)])) as Record<
    (typeof EVENTS)[number],
    number
  >;
}

describe("Grok plugin process lifecycle", () => {
  afterEach(() => {
    vi.resetModules();
  });

  /*
  FNXC:GrokRuntimeTests 2026-07-18-07:40:
  Prove the process-manager Symbol.for exit-hook guard by re-importing the
  registry module (lifecycle owner), not the full plugin graph. Full-suite
  shard transform of @fusion/core via process-manager can still exceed the
  default 5s budget on cold workers — give the bound stress test 15s.
  */
  it("keeps its process cleanup owner bounded across repeated module evaluation", { timeout: 15_000 }, async () => {
    const baseline = listenerCounts();
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);

    try {
      for (let iteration = 0; iteration < 5; iteration += 1) {
        vi.resetModules();
        await import("../acp/process-manager.js");
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }

    const after = listenerCounts();
    expect(after.exit - baseline.exit).toBeLessThanOrEqual(1);
    expect(after.beforeExit - baseline.beforeExit).toBe(0);
    expect(after.SIGTERM - baseline.SIGTERM).toBe(0);
    expect(after.SIGINT - baseline.SIGINT).toBe(0);
    expect(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning")).toEqual([]);

    const manager = await import("../acp/process-manager.js");
    const child = {
      killed: false,
      exitCode: null,
      kill: vi.fn(),
      on: vi.fn(),
    };
    manager.registerProcess(child as never);
    for (const cleanup of process.listeners("exit")) {
      if (cleanup.name === "killAllProcesses") cleanup(0);
    }
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(manager.activeProcessCount()).toBe(0);
  });
});
