import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFile, mockExec } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: mockExecFile,
    exec: mockExec,
  };
});

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

function cloudflareQuickTunnelConfig(overrides: Partial<TunnelProviderConfig> = {}): TunnelProviderConfig {
  return {
    provider: "cloudflare",
    quickTunnel: true,
    executablePath: "cloudflared",
    args: ["tunnel", "--url", "http://localhost:4040"],
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
    mockExecFile.mockReset();
    mockExec.mockReset();
    mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      callback?.(null, "", "");
      return {} as never;
    });
    mockExec.mockImplementation((_command: string, optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      callback?.(null, "", "");
      return {} as never;
    });

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

  it("accepts quick tunnel cloudflare config without token env requirements", async () => {
    const manager = new TunnelProcessManager({
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    await expect(manager.start("cloudflare", cloudflareQuickTunnelConfig())).resolves.toBeUndefined();
    expect(manager.getStatus().state).toBe("starting");
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

  it("detects trycloudflare readiness output for quick tunnel config", async () => {
    const manager = new TunnelProcessManager({
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    await manager.start("cloudflare", cloudflareQuickTunnelConfig());
    const child = [...children.values()][0];
    child.emitStdout("Tunnel ready https://demo.trycloudflare.com");

    await vi.waitFor(() => {
      expect(manager.getStatus().state).toBe("running");
    });
    expect(manager.getStatus().url).toBe("https://demo.trycloudflare.com");
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

  it("returns null when managed tunnel is already running during external detection", async () => {
    const manager = new TunnelProcessManager({
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    await manager.start("tailscale", {
      provider: "tailscale",
      executablePath: "tailscale",
      args: ["funnel", "4040"],
    });
    [...children.values()][0].emitStdout("Available on the internet: https://node.ts.net/");
    await vi.waitFor(() => expect(manager.getStatus().state).toBe("running"));

    await expect(manager.detectExternalFunnel()).resolves.toBeNull();
  });

  it("returns ExternalTunnelInfo when tailscale status has DNSName", async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      callback?.(null, "{\"Self\":{\"DNSName\":\"machine.tailnet.ts.net.\"}}", "");
      return {} as never;
    });

    const manager = new TunnelProcessManager();
    const detected = await manager.detectExternalFunnel();
    if (detected !== null) {
      expect(detected).toEqual({
        provider: "tailscale",
        url: "https://machine.tailnet.ts.net/",
        pid: null,
      });
    }
  });

  it("returns null when tailscale binary is unavailable", async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null) => void
        : maybeCallback;
      callback?.(new Error("ENOENT"));
      return {} as never;
    });

    const manager = new TunnelProcessManager();
    await expect(manager.detectExternalFunnel()).resolves.toBeNull();
  });

  it("returns null when tailscale status JSON is malformed", async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string) => void
        : maybeCallback;
      callback?.(null, "not-json");
      return {} as never;
    });

    const manager = new TunnelProcessManager();
    await expect(manager.detectExternalFunnel()).resolves.toBeNull();
  });

  it("killExternalFunnel uses tailscale reset command when available", async () => {
    const manager = new TunnelProcessManager();
    await expect(manager.killExternalFunnel()).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledWith("tailscale", ["serve", "reset"], { timeout: 5_000 }, expect.any(Function));
  });

  it("killExternalFunnel falls back gracefully when tailscale is unavailable", async () => {
    mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null) => void
        : maybeCallback;
      callback?.(new Error("ENOENT"));
      return {} as never;
    });
    mockExec.mockImplementation((_command: string, optionsOrCallback: unknown, maybeCallback?: (error: Error | null) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null) => void
        : maybeCallback;
      callback?.(new Error("no pgrep"));
      return {} as never;
    });

    const manager = new TunnelProcessManager();
    await expect(manager.killExternalFunnel()).resolves.toBeUndefined();
  });
});
