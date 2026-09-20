import { describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";

function makeStore(): any {
  return new Proxy({
    getSettings: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => []),
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return vi.fn(async () => undefined);
    },
  });
}

describe("SelfHealingManager agent-browser recovery", () => {
  it("runs the bounded browser reaper during startup and maintenance", async () => {
    const reap = vi.fn(async () => 0);
    const manager = new SelfHealingManager(makeStore(), {
      rootDir: "/tmp/fusion-browser-reaper-test",
      reapExpiredFusionBrowserLeases: reap,
    });

    await manager.runStartupRecovery();
    await (manager as any).runMaintenance();

    expect(reap).toHaveBeenCalledTimes(2);
  });
});
