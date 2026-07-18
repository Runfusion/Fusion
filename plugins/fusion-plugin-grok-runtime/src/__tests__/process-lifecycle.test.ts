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
  FNXC:GrokRuntimeTests 2026-07-18-07:25:
  Symbol.for exit-hook guard is proven by two re-evaluations after the baseline
  import. Full-suite shard transform load made 5–15 dynamic imports of the full
  plugin graph hit the default 5s testTimeout; keep the bound assertion, not the
  iteration marathon.
  */
  it("keeps its process cleanup owner bounded across repeated module evaluation", async () => {
    const baseline = listenerCounts();
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);

    try {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        vi.resetModules();
        await import("../index.js");
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
