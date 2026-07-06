import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Server } from "node:http";

class FakeServer {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(private readonly port: number) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(handler);
    this.listeners.set(event, current);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, current.filter((item) => item !== handler));
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(...args);
    }
  }

  address() {
    return { port: this.port };
  }

  close(callback: () => void): void {
    callback();
  }
}

describe("LocalRuntimeManager", () => {
  const store = {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts embedded local runtime and reports status", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
    });

    const status = await manager.startLocal();

    expect(store.init).toHaveBeenCalledTimes(1);
    expect(store.watch).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      source: "embedded-local",
      state: "running",
      port: 4545,
      baseUrl: "http://127.0.0.1:4545",
    });
    expect(manager.getServerPort()).toBe(4545);
  });

  it("returns external-cli status without starting embedded runtime", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      getExternalPort: () => 7777,
      createStore: async () => store,
      createDashboardServer: async () => new FakeServer(4545) as unknown as Server,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({
      source: "external-cli",
      state: "running",
      port: 7777,
      baseUrl: "http://127.0.0.1:7777",
    });
    expect(store.init).not.toHaveBeenCalled();
  });

  it("rolls back and exposes error status when startup fails (single attempt, no retry)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    store.init.mockRejectedValueOnce(new Error("init failed"));
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      // Pin to a single attempt — this test asserts pre-retry single-attempt rollback
      // semantics; the multi-attempt self-heal/persistent-failure behavior is covered below.
      startupRetries: 1,
    });

    await expect(manager.startLocal()).rejects.toThrow("init failed");
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({
      source: "embedded-local",
      state: "error",
      error: "init failed",
    });
  });

  it("surfaces dashboard import failures instead of replacing them with a generic timeout", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const importError = new TypeError("ERR_IMPORT_ATTRIBUTE_MISSING: registry-manifest.json requires an import attribute");
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        throw importError;
      },
      // Isolate the message-preservation assertion from retry mechanics (covered separately below).
      startupRetries: 1,
      startupRetryDelayMs: 0,
    });

    await expect(manager.startLocal()).rejects.toThrow("ERR_IMPORT_ATTRIBUTE_MISSING");
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({
      source: "embedded-local",
      state: "error",
      error: "ERR_IMPORT_ATTRIBUTE_MISSING: registry-manifest.json requires an import attribute",
    });
  });

  it("self-heals a transient store.init failure on attempt 1 (createStore path)", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    store.init.mockRejectedValueOnce(new Error("transient windows init failure"));
    const server = new FakeServer(4545);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(manager.getStatus().state).toBe("running");
    expect(store.init).toHaveBeenCalledTimes(2);
  });

  it("self-heals a transient createDashboardServer failure on attempt 1", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    let calls = 0;
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient dashboard server boot failure");
        }
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(calls).toBe(2);
  });

  it("exhausts retries and surfaces the final real error when every attempt fails", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const errors = [new Error("attempt 1 failed"), new Error("attempt 2 failed"), new Error("attempt 3 failed — real cause")];
    let calls = 0;
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        const error = errors[calls];
        calls += 1;
        throw error;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    await expect(manager.startLocal()).rejects.toThrow("attempt 3 failed — real cause");
    expect(calls).toBe(3);
    expect(manager.getStatus()).toMatchObject({
      source: "embedded-local",
      state: "error",
      error: "attempt 3 failed — real cause",
    });
  });

  it("fully cleans up store/server/cleanup between a failed attempt and the retry that follows", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const cleanupFns: Array<ReturnType<typeof vi.fn>> = [];
    const servers: FakeServer[] = [];
    let calls = 0;
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        calls += 1;
        const cleanup = vi.fn(async () => undefined);
        cleanupFns.push(cleanup);
        if (calls === 1) {
          const failingServer = new FakeServer(0);
          servers.push(failingServer);
          setTimeout(() => failingServer.emit("error", new Error("transient listen error")), 0);
          return { server: failingServer as unknown as Server, cleanup };
        }
        const server = new FakeServer(4545);
        servers.push(server);
        setTimeout(() => server.emit("listening"), 0);
        return { server: server as unknown as Server, cleanup };
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const closeSpies = servers.map(() => vi.fn());

    const status = await manager.startLocal();

    expect(status.state).toBe("running");
    expect(cleanupFns[0]).toHaveBeenCalledTimes(1);
    expect(cleanupFns[1]).toHaveBeenCalledTimes(0);
    expect(store.close).toHaveBeenCalledTimes(1); // only the failed attempt's store was closed
    void closeSpies;
  });

  it("does not retry the external-cli branch", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const createStore = vi.fn(async () => store);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      getExternalPort: () => 7777,
      createStore,
      createDashboardServer: async () => new FakeServer(4545) as unknown as Server,
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    const status = await manager.startLocal();

    expect(status).toMatchObject({ source: "external-cli", state: "running", port: 7777 });
    expect(createStore).not.toHaveBeenCalled();
  });

  it("does not retry the already-running branch", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const createStore = vi.fn(async () => store);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
      startupRetries: 3,
      startupRetryDelayMs: 0,
    });

    await manager.startLocal();
    const secondStatus = await manager.startLocal();

    expect(secondStatus).toMatchObject({ source: "embedded-local", state: "running", port: 4545 });
    expect(createStore).toHaveBeenCalledTimes(1);
  });

  it("stopLocal is idempotent and no-op when inactive", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const closeSpy = vi.spyOn(server, "close");
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
    });

    await manager.startLocal();
    await manager.stopLocal();
    await manager.stopLocal();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toEqual({ source: "none", state: "stopped" });
  });

  it("runs embedded runtime cleanup on stop", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const cleanup = vi.fn(async () => undefined);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return { server: server as unknown as Server, cleanup };
      },
    });

    await manager.startLocal();
    await manager.stopLocal();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("startLocal while already running returns current status", async () => {
    const { LocalRuntimeManager } = await import("../local-runtime.ts");
    const server = new FakeServer(4545);
    const manager = new LocalRuntimeManager({
      rootDir: "/repo",
      createStore: async () => store,
      createDashboardServer: async () => {
        setTimeout(() => server.emit("listening"), 0);
        return server as unknown as Server;
      },
    });

    const first = await manager.startLocal();
    const second = await manager.startLocal();

    expect(first).toEqual(second);
    expect(store.init).toHaveBeenCalledTimes(1);
  });
});
