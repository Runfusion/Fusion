// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevServerManager,
  resetDevServerManager,
  type DevServerStartOptions,
} from "../dev-server-manager.js";
import { DevServerStore } from "../dev-server-store.js";

async function createManager(rootDir: string): Promise<{ manager: DevServerManager; store: DevServerStore }> {
  const store = new DevServerStore(rootDir);
  await store.load();
  const manager = new DevServerManager(rootDir, store, { logLimit: 50 });
  await manager.initialize();
  return { manager, store };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function longRunningCommand(previewUrl = "http://127.0.0.1:4173/preview"): DevServerStartOptions {
  const script = `console.log('ready ${previewUrl}'); setInterval(() => {}, 1000);`;
  return {
    command: `node -e \"${script}\"`,
    scriptName: "dev",
  };
}

describe("DevServerManager persistence", () => {
  const runningManagers: DevServerManager[] = [];

  afterEach(async () => {
    for (const manager of runningManagers.splice(0)) {
      try {
        await manager.shutdown();
      } catch {
        // ignore cleanup failures
      }
    }
    resetDevServerManager();
  });

  it("rehydrates persisted state and reconciles stale PIDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const store = new DevServerStore(root);
    await store.load();
    await store.updateState({
      status: "running",
      pid: 999_999,
      command: "pnpm dev",
      cwd: root,
      startedAt: new Date().toISOString(),
    });

    const manager = new DevServerManager(root, store);
    runningManagers.push(manager);
    await manager.initialize();

    const state = manager.getState();
    expect(state.status).toBe("stopped");
    expect(state.pid).toBeNull();
    expect(manager.getRecentLogs().some((entry) => entry.message.includes("Recovered stale persisted PID"))).toBe(true);
  });

  it("persists lifecycle transitions and stdout logs while running", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager, store } = await createManager(root);
    runningManagers.push(manager);

    await manager.start(longRunningCommand());

    await waitFor(() => manager.getState().previewUrl !== null);

    const state = manager.getState();
    expect(state.status).toBe("running");
    expect(state.previewUrl).toContain("http://127.0.0.1:4173");
    expect(typeof state.pid).toBe("number");

    await store.load();
    const persistedState = store.getState();
    expect(persistedState.status).toBe("running");
    expect(persistedState.detectedUrl).toContain("127.0.0.1:4173");
    expect(persistedState.logHistory.some((line) => line.includes("ready http://127.0.0.1:4173/preview"))).toBe(true);

    await manager.stop();
    expect(manager.getState().status).toBe("stopped");
  });

  it("restores persisted logs into in-memory snapshot on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const store = new DevServerStore(root);
    await store.load();
    await store.appendLog("first");
    await store.appendLog("second");

    const manager = new DevServerManager(root, store, { logLimit: 10 });
    runningManagers.push(manager);
    await manager.initialize();

    expect(manager.getRecentLogs().map((entry) => entry.message)).toEqual(["first", "second"]);
  });

  it("restart stops existing process and spawns a fresh PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-server-manager-"));
    const { manager } = await createManager(root);
    runningManagers.push(manager);

    await manager.start(longRunningCommand("http://127.0.0.1:4180"));
    await waitFor(() => manager.getState().status === "running" && manager.getState().pid !== null);
    const firstPid = manager.getState().pid;

    await manager.restart(longRunningCommand("http://127.0.0.1:4181"));
    await waitFor(() => manager.getState().previewUrl?.includes("4181") ?? false);
    const secondPid = manager.getState().pid;

    expect(firstPid).not.toBeNull();
    expect(secondPid).not.toBeNull();
    expect(secondPid).not.toBe(firstPid);
  });
});
