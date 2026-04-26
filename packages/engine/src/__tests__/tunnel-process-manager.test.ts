import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TunnelProcessManager } from "../remote-access/tunnel-process-manager.js";
import type { TunnelProviderConfig } from "../remote-access/types.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  readonly stdio = [null, this.stdout, this.stderr] as const;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(public readonly pid: number) {
    super();
  }

  emitStdout(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  emitStderr(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function cloudflareConfig(overrides: Partial<TunnelProviderConfig> = {}): TunnelProviderConfig {
  return {
    provider: "cloudflare",
    executablePath: "cloudflared",
    args: ["tunnel", "--token", "secret-token"],
    tokenEnvVar: "CLOUDFLARED_TOKEN",
    env: { CLOUDFLARED_TOKEN: "secret-token" },
    ...overrides,
  } as TunnelProviderConfig;
}

describe("TunnelProcessManager", () => {
  let pid = 1000;
  let children = new Map<number, FakeChildProcess>();
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pid = 1000;
    children = new Map();
    processKillSpy = vi.spyOn(process, "kill") as unknown as ReturnType<typeof vi.spyOn>;
    processKillSpy.mockImplementation((...args: unknown[]) => {
      const targetPid = Number(args[0]);
      const signal = args[1] as NodeJS.Signals | number | undefined;
      const child = children.get(Math.abs(targetPid));
      if (!child) {
        return true;
      }
      if (signal === "SIGKILL") {
        child.close(0, "SIGKILL");
      } else if (signal === "SIGTERM") {
        child.close(0, "SIGTERM");
      }
      return true;
    });
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    vi.useRealTimers();
  });

  it("starts, emits readiness transitions, and redacts token-bearing logs", async () => {
    const manager = new TunnelProcessManager({
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    const states: Array<string> = [];
    const logs: string[] = [];
    manager.subscribeStatus((snapshot) => states.push(snapshot.state));
    manager.subscribeLogs((entry) => logs.push(entry.message));

    await manager.start("cloudflare", cloudflareConfig());

    const child = [...children.values()][0];
    child.emitStdout("Connected at https://demo.trycloudflare.com with secret-token");

    await vi.waitFor(() => {
      expect(manager.getStatus().state).toBe("running");
    });

    const status = manager.getStatus();
    expect(status.url).toBe("https://demo.trycloudflare.com");
    expect(states).toContain("starting");
    expect(states).toContain("running");

    const allLogs = logs.join("\n");
    expect(allLogs).toContain("[REDACTED]");
    expect(allLogs).not.toContain("secret-token");
  });

  it("transitions start→running and stop→stopped, with idempotent repeated stop", async () => {
    const manager = new TunnelProcessManager({
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    const states: string[] = [];
    manager.subscribeStatus((snapshot) => states.push(snapshot.state));

    await manager.start("cloudflare", cloudflareConfig());
    const child = [...children.values()][0];
    child.emitStdout("Tunnel ready https://demo.trycloudflare.com");

    await vi.waitFor(() => {
      expect(manager.getStatus().state).toBe("running");
    });

    await manager.stop();
    expect(manager.getStatus().state).toBe("stopped");

    // Idempotent: repeated stop keeps manager in a deterministic stopped state.
    await manager.stop();
    expect(manager.getStatus()).toMatchObject({
      provider: null,
      state: "stopped",
      pid: null,
      lastError: null,
    });

    expect(states).toContain("starting");
    expect(states).toContain("running");
    expect(states).toContain("stopping");
    expect(states).toContain("stopped");
  });

  it("falls back to SIGKILL when graceful stop times out", async () => {
    vi.useFakeTimers();

    processKillSpy.mockImplementation((...args: unknown[]) => {
      const targetPid = Number(args[0]);
      const signal = args[1] as NodeJS.Signals | number | undefined;
      const child = children.get(Math.abs(targetPid));
      if (!child) {
        return true;
      }
      if (signal === "SIGKILL") {
        child.close(0, "SIGKILL");
      }
      return true;
    });

    const manager = new TunnelProcessManager({
      stopTimeoutMs: 10,
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    await manager.start("cloudflare", cloudflareConfig({ stopTimeoutMs: 10 }));
    const child = [...children.values()][0];
    child.emitStdout("Tunnel ready https://demo.trycloudflare.com");
    await vi.waitFor(() => expect(manager.getStatus().state).toBe("running"));

    const stopPromise = manager.stop();
    await vi.advanceTimersByTimeAsync(20);
    await stopPromise;

    expect(processKillSpy).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
    expect(manager.getStatus().state).toBe("stopped");
  });

  it("switchProvider stops active provider before starting target provider", async () => {
    const order: string[] = [];
    const manager = new TunnelProcessManager({
      spawnImpl: () => {
        order.push("spawn");
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    manager.subscribeStatus((snapshot) => order.push(`state:${snapshot.state}`));

    await manager.start("tailscale", {
      provider: "tailscale",
      executablePath: "tailscale",
      args: ["serve", "status"],
    });
    const initialChild = [...children.values()][0];
    initialChild.emitStdout("Serve started https://machine.ts.net");
    await vi.waitFor(() => expect(manager.getStatus().state).toBe("running"));

    const switchPromise = manager.switchProvider("cloudflare", cloudflareConfig());

    await vi.waitFor(() => {
      expect(processKillSpy).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
    });

    const cloudflareChild = [...children.values()].at(-1);
    cloudflareChild?.emitStdout("Connected https://demo.trycloudflare.com");
    await switchPromise;

    expect(manager.getStatus()).toMatchObject({
      state: "running",
      provider: "cloudflare",
      url: "https://demo.trycloudflare.com",
    });
    expect(order.indexOf("state:stopping")).toBeLessThan(order.lastIndexOf("spawn"));
  });

  it("switchProvider failure is rollback-safe and never leaks raw token values", async () => {
    const manager = new TunnelProcessManager({
      spawnImpl: vi
        .fn()
        .mockImplementationOnce(() => {
          const child = new FakeChildProcess(++pid);
          children.set(child.pid, child);
          return child as never;
        })
        .mockImplementationOnce(() => {
          throw new Error("cloudflare launcher boom token=secret-token");
        }),
    });

    const states: string[] = [];
    const logs: string[] = [];
    manager.subscribeStatus((snapshot) => states.push(snapshot.state));
    manager.subscribeLogs((entry) => logs.push(entry.message));

    await manager.start("tailscale", {
      provider: "tailscale",
      executablePath: "tailscale",
      args: ["serve", "status"],
    });
    const child = [...children.values()][0];
    child.emitStdout("Serve started https://machine.ts.net");
    await vi.waitFor(() => expect(manager.getStatus().state).toBe("running"));

    await expect(
      manager.switchProvider("cloudflare", cloudflareConfig()),
    ).rejects.toThrow("cloudflare launcher boom");

    const finalStatus = manager.getStatus();
    expect(finalStatus.state).toBe("failed");
    expect(finalStatus.lastError?.code).toBe("switch_failed");
    expect(finalStatus.provider).toBe("cloudflare");
    expect(states).toContain("stopping");
    expect(states).toContain("stopped");

    const logText = logs.join("\n");
    expect(logText).not.toContain("secret-token");
  });
});
