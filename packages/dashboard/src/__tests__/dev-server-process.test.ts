// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevServerProcessManager } from "../dev-server-process.js";
import { loadDevServerStore, resetDevServerStore } from "../dev-server-store.js";

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("DevServerProcessManager", () => {
  const tempDirs: string[] = [];
  const managers: DevServerProcessManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      try {
        if (manager.isRunning()) {
          await manager.stop();
        }
      } catch {
        // ignore
      }
      manager.cleanup();
    }

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }

    resetDevServerStore();
  });

  async function createManager(options?: { stopTimeoutMs?: number; probeDelayMs?: number }) {
    const root = mkdtempSync(join(os.tmpdir(), "fn-dev-process-"));
    tempDirs.push(root);
    const store = await loadDevServerStore(root);
    const manager = new DevServerProcessManager(store, options);
    managers.push(manager);
    return { root, store, manager };
  }

  it("start() spawns child process and updates state to running", async () => {
    const { root, manager } = await createManager();
    const state = await manager.start("node -e \"setInterval(() => {}, 1000)\"", root);

    expect(state.status).toBe("running");
    expect(typeof state.pid).toBe("number");
  });

  it("start() emits started event", async () => {
    const { root, manager } = await createManager();

    const startedEvent = new Promise<void>((resolve) => {
      manager.once("started", () => resolve());
    });

    await manager.start("node -e \"setInterval(() => {}, 1000)\"", root);
    await startedEvent;
  });

  it("start() captures stdout into log buffer", async () => {
    const { root, store, manager } = await createManager();

    await manager.start("node -e \"console.log('hello from stdout'); setInterval(() => {}, 1000)\"", root);

    await waitFor(() => store.getState().logHistory.some((line) => line.includes("hello from stdout")));

    expect(store.getState().logHistory.some((line) => line.includes("hello from stdout"))).toBe(true);
  });

  it("start() throws if already running", async () => {
    const { root, manager } = await createManager();

    await manager.start("node -e \"setInterval(() => {}, 1000)\"", root);
    await expect(manager.start("node -e \"setInterval(() => {}, 1000)\"", root)).rejects.toThrow("already running");
  });

  it("start() throws if command is empty", async () => {
    const { root, manager } = await createManager();
    await expect(manager.start("   ", root)).rejects.toThrow("command is required");
  });

  it("stop() sends SIGTERM and waits for exit", async () => {
    const { root, store, manager } = await createManager();

    await manager.start("node -e \"setInterval(() => {}, 1000)\"", root);
    const state = await manager.stop();

    expect(state.status).toBe("stopped");
    expect(store.getState().status).toBe("stopped");
    expect(store.getState().exitCode).toBeDefined();
  });

  it("stop() falls back to SIGKILL after timeout", async () => {
    const { root, store, manager } = await createManager({ stopTimeoutMs: 150 });

    await manager.start(
      "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"",
      root,
    );

    const state = await manager.stop();
    expect(state.status).toBe("stopped");
    expect(store.getState().status).toBe("stopped");
  });

  it("stop() returns current state if nothing is running", async () => {
    const { store, manager } = await createManager();

    const state = await manager.stop();
    expect(state).toEqual(store.getState());
  });

  it("restart() stops then starts with same command", async () => {
    const { root, store, manager } = await createManager();

    await manager.start("node -e \"setInterval(() => {}, 1000)\"", root, { scriptId: "dev" });
    const firstPid = store.getState().pid;

    const state = await manager.restart();
    expect(state.status).toBe("running");
    expect(state.pid).toBeDefined();
    expect(state.scriptId).toBe("dev");
    expect(state.pid).not.toBe(firstPid);
  });

  it("detects URL from localhost output", async () => {
    const { root, store, manager } = await createManager();

    await manager.start(
      "node -e \"console.log('Server ready at http://localhost:3000'); setInterval(() => {}, 1000)\"",
      root,
    );

    await waitFor(() => store.getState().detectedUrl === "http://localhost:3000");
    expect(store.getState().detectedPort).toBe(3000);
  });

  it("detects URL from 127.0.0.1 output", async () => {
    const { root, store, manager } = await createManager();

    await manager.start(
      "node -e \"console.log('ready at http://127.0.0.1:4173'); setInterval(() => {}, 1000)\"",
      root,
    );

    await waitFor(() => store.getState().detectedUrl === "http://127.0.0.1:4173");
    expect(store.getState().detectedPort).toBe(4173);
  });

  it("detects URL from keyword plus port pattern", async () => {
    const { root, store, manager } = await createManager();

    await manager.start(
      "node -e \"console.log('Listening on port 5173'); setInterval(() => {}, 1000)\"",
      root,
    );

    await waitFor(() => store.getState().detectedUrl === "http://localhost:5173");
    expect(store.getState().detectedPort).toBe(5173);
  });

  it("cleanup() kills process and clears listeners", async () => {
    const { root, manager } = await createManager();

    await manager.start("node -e \"setInterval(() => {}, 1000)\"", root);
    manager.on("output", () => undefined);
    expect(manager.listenerCount("output")).toBeGreaterThan(0);

    manager.cleanup();
    await waitFor(() => manager.isRunning() === false);

    expect(manager.listenerCount("output")).toBe(0);
  });
});
