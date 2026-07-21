// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevServerProcessManager, type DevServerProcessManagerOptions } from "../dev-server-process.js";
import type { DevServerState, DevServerStore } from "../dev-server-store.js";

/*
FNXC:DevServerProcessTests 2026-07-19-18:45:
FN-8394 replaces the quarantined real-shell test with an injected child-process
and timer seam. The test still guards lifecycle behavior, while shard load cannot
starve a real process, filesystem store, stdout race, or fallback network probe.
*/

class MemoryDevServerStore {
  private state: DevServerState = {
    id: "",
    name: "default",
    status: "stopped",
    command: "",
    cwd: "",
    logHistory: [],
  };

  getState(): DevServerState {
    return { ...this.state, logHistory: [...this.state.logHistory] };
  }

  async updateState(partial: Partial<DevServerState>): Promise<DevServerState> {
    this.state = { ...this.state, ...partial, logHistory: partial.logHistory ?? this.state.logHistory };
    return this.getState();
  }

  async appendLog(line: string): Promise<void> {
    this.state.logHistory.push(line);
  }
}

class FakeChildProcess extends EventEmitter {
  pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();

  close(code = 0): void {
    this.exitCode = code;
    this.emit("close", code);
  }
}

function createFixture(options?: { closeOnSignal?: NodeJS.Signals[]; stopTimeoutMs?: number }) {
  const store = new MemoryDevServerStore();
  const children: FakeChildProcess[] = [];
  const signals: NodeJS.Signals[] = [];
  const closeOnSignal = options?.closeOnSignal ?? ["SIGTERM"];
  const managerOptions: DevServerProcessManagerOptions = {
    probeDelayMs: 10_000,
    stopTimeoutMs: options?.stopTimeoutMs,
    spawn: (() => {
      const child = new FakeChildProcess();
      children.push(child);
      return { child: child as unknown as ChildProcess };
    }) as DevServerProcessManagerOptions["spawn"],
    killManagedProcess: (child, signal) => {
      signals.push(signal);
      if (closeOnSignal.includes(signal)) {
        (child as unknown as FakeChildProcess).close();
      }
    },
  };
  return { store, children, signals, manager: new DevServerProcessManager(store as unknown as DevServerStore, managerOptions) };
}

async function settleLifecycleWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("DevServerProcessManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects invalid commands and duplicate starts before spawning another child", async () => {
    const { children, manager } = createFixture();

    await expect(manager.start("   ", "/repo")).rejects.toThrow("command is required");
    await expect(manager.start("echo $(unsafe)", "/repo")).rejects.toThrow("command substitution");
    await expect(manager.start("pnpm dev", " ")).rejects.toThrow("cwd is required");
    expect(children).toHaveLength(0);

    await manager.start("pnpm dev", "/repo");
    await expect(manager.start("pnpm dev", "/repo")).rejects.toThrow("already running");
    expect(children).toHaveLength(1);
    manager.cleanup();
  });

  it("starts an injected child, persists output, and detects its announced URL once", async () => {
    const { children, manager, store } = createFixture();
    const detected: unknown[] = [];
    manager.on("url-detected", (event) => detected.push(event));

    const state = await manager.start("pnpm dev", "/repo", { scriptId: "dev" });
    children[0].stdout.write("ready at http://localhost:4321\nready again at http://localhost:4321\n");
    await settleLifecycleWork();

    expect(state).toMatchObject({ status: "running", pid: 42, scriptId: "dev" });
    expect(store.getState()).toMatchObject({ detectedUrl: "http://localhost:4321", detectedPort: 4321 });
    expect(store.getState().logHistory).toEqual([
      "ready at http://localhost:4321",
      "ready again at http://localhost:4321",
    ]);
    expect(detected).toHaveLength(1);
    expect(manager.hasPendingProbeTimer()).toBe(false);
    manager.cleanup();
  });

  it.each([
    ["http://127.0.0.1:4173", "http://127.0.0.1:4173", 4173],
    ["Listening on port 5173", "http://localhost:5173", 5173],
  ])("detects alternate announced URL format %s", async (line, detectedUrl, detectedPort) => {
    const { children, manager, store } = createFixture();

    await manager.start("pnpm dev", "/repo");
    children[0].stdout.write(`${line}\n`);
    await settleLifecycleWork();

    expect(store.getState()).toMatchObject({ detectedUrl, detectedPort });
    manager.cleanup();
  });

  it("stops through the injected process-tree signal and clears the fallback timer", async () => {
    const { manager, signals, store } = createFixture();
    await manager.start("pnpm dev", "/repo");
    expect(manager.hasPendingProbeTimer()).toBe(true);

    const stopped = await manager.stop();

    expect(signals).toEqual(["SIGTERM"]);
    expect(stopped.status).toBe("stopped");
    expect(store.getState().status).toBe("stopped");
    expect(manager.hasPendingProbeTimer()).toBe(false);
  });

  it("returns the current state without signaling when no child is running", async () => {
    const { manager, signals, store } = createFixture();

    await expect(manager.stop()).resolves.toEqual(store.getState());
    expect(signals).toEqual([]);
  });

  it("falls back to SIGKILL when the injected child ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const { manager, signals, store } = createFixture({ closeOnSignal: ["SIGKILL"], stopTimeoutMs: 25 });
    await manager.start("pnpm dev", "/repo");

    const stopped = manager.stop();
    await vi.advanceTimersByTimeAsync(25);

    await expect(stopped).resolves.toMatchObject({ status: "stopped" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(store.getState().status).toBe("stopped");
  });

  it("clears the fallback timer on child failure and creates a fresh child on restart", async () => {
    const { children, manager } = createFixture();
    await manager.start("pnpm dev", "/repo", { scriptId: "dev" });
    children[0].emit("error", new Error("synthetic failure"));
    await settleLifecycleWork();
    expect(manager.hasPendingProbeTimer()).toBe(false);

    await manager.start("pnpm dev", "/repo", { scriptId: "dev" });
    const restarted = await manager.restart();

    expect(children).toHaveLength(3);
    expect(restarted).toMatchObject({ status: "running", scriptId: "dev" });
    expect(manager.hasPendingProbeTimer()).toBe(true);
    manager.cleanup();
    expect(manager.hasPendingProbeTimer()).toBe(false);
  });

  it("cleanup removes manager and child stream listeners without leaving a timer", async () => {
    const { children, manager } = createFixture();
    await manager.start("pnpm dev", "/repo");
    manager.on("output", () => undefined);
    expect(manager.listenerCount("output")).toBeGreaterThan(0);
    expect(children[0].stdout.listenerCount("data")).toBeGreaterThan(0);

    manager.cleanup();

    expect(manager.listenerCount("output")).toBe(0);
    expect(children[0].stdout.listenerCount("data")).toBe(0);
    expect(manager.hasPendingProbeTimer()).toBe(false);
    expect(manager.isRunning()).toBe(false);
  });
});
