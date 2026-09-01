import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:RemoteAccess 2026-09-01-02:54:
`child_process.execFile`/`exec` carry their own util.promisify.custom implementation that resolves to
{ stdout, stderr }. A bare vi.fn() does not, so promisify() fell back to the callback convention and
resolved to the bare stdout STRING — every `const { stdout } = await execFileAsync(...)` in the source
then read undefined and the JSON-parsing probes silently returned null under test. Mirroring the custom
symbol here is what makes those probes actually exercised.
*/
const { mockExecFile, mockExec } = vi.hoisted(() => {
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  const withPromisifiedShape = <T extends (...args: never[]) => unknown>(fn: T): T => {
    const promisified = (...args: unknown[]) => new Promise((resolve, reject) => {
      const callback = (error: (Error & { stdout?: string; stderr?: string }) | null, stdout?: string, stderr?: string) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      };
      (fn as unknown as (...callArgs: unknown[]) => unknown)(...args, callback);
    });
    Object.defineProperty(fn, promisifyCustom, { value: promisified, configurable: true });
    return fn;
  };
  return {
    mockExecFile: withPromisifiedShape(vi.fn()),
    mockExec: withPromisifiedShape(vi.fn()),
  };
});

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

function tailscaleConfig(): TunnelProviderConfig {
  return {
    provider: "tailscale",
    executablePath: "tailscale",
    args: ["funnel", "4040"],
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

  it.each([
    ["cloudflare", cloudflareConfig()],
    ["tailscale", {
      provider: "tailscale",
      executablePath: "tailscale",
      args: ["funnel", "4040"],
    } satisfies TunnelProviderConfig],
  ] as const)("recreates an unexpectedly exited %s tunnel while the manager is active", async (provider, config) => {
    vi.useFakeTimers();
    const spawned: FakeChildProcess[] = [];
    const manager = new TunnelProcessManager({
      restartBaseDelayMs: 100,
      restartMaxDelayMs: 1_000,
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        spawned.push(child);
        return child as never;
      },
    });

    await manager.start(provider, config);
    spawned[0].close(1);

    expect(manager.getStatus()).toMatchObject({ state: "failed", provider });
    await vi.advanceTimersByTimeAsync(99);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(2);
    expect(manager.getStatus()).toMatchObject({ state: "starting", provider });
  });

  it("backs off repeated pre-readiness failures and caps the retry delay", async () => {
    vi.useFakeTimers();
    const spawned: FakeChildProcess[] = [];
    const manager = new TunnelProcessManager({
      restartBaseDelayMs: 100,
      restartMaxDelayMs: 200,
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        spawned.push(child);
        return child as never;
      },
    });

    await manager.start("cloudflare", cloudflareConfig());
    spawned[0].close(1);
    await vi.advanceTimersByTimeAsync(100);
    spawned[1].close(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(3);

    spawned[2].close(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(spawned).toHaveLength(4);
  });

  it("cancels a pending automatic restart when the tunnel is explicitly stopped", async () => {
    vi.useFakeTimers();
    const spawnImpl = vi.fn(() => {
      const child = new FakeChildProcess(++pid);
      children.set(child.pid, child);
      return child as never;
    });
    const manager = new TunnelProcessManager({ restartBaseDelayMs: 100, spawnImpl });

    await manager.start("cloudflare", cloudflareConfig());
    [...children.values()][0].close(1);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({ state: "stopped", provider: null });
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
    // FNXC:RemoteAccess 2026-09-01-02:54: this assertion used to be wrapped in `if (detected !== null)`,
    // which made it a no-op — the promisify shape above meant detection always returned null. Now that
    // the probe really runs, assert the result unconditionally.
    await expect(manager.detectExternalFunnel()).resolves.toEqual({
      provider: "tailscale",
      url: "https://machine.tailnet.ts.net/",
      pid: null,
    });
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
  /*
  FNXC:RemoteAccess 2026-09-01-02:54:
  Original symptom: Command Center "Restart" (and "Update from source", which ends in the same
  restart) came back with a healthy dashboard and a dead public URL — the funnel had been stopped
  because a supervised restart went down the process-exit teardown. These tests pin the handover and
  the adoption that replaces it.
  */
  describe("supervised restart handover", () => {
    const makeManager = () => new TunnelProcessManager({
      spawnImpl: () => {
        const child = new FakeChildProcess(++pid);
        children.set(child.pid, child);
        return child as never;
      },
    });

    async function startRunning(manager: TunnelProcessManager): Promise<FakeChildProcess> {
      await manager.start("cloudflare", cloudflareQuickTunnelConfig());
      const child = [...children.values()].at(-1) as FakeChildProcess;
      child.emitStdout("Tunnel ready https://demo.trycloudflare.com");
      await vi.waitFor(() => {
        expect(manager.getStatus().state).toBe("running");
      });
      return child;
    }

    it("releases a running tunnel without signalling it, and keeps reporting it as running", async () => {
      const manager = makeManager();
      const child = await startRunning(manager);
      processKillSpy.mockClear();

      expect(manager.releaseForSupervisedRestart()).toBe(true);

      // The whole point: nothing was killed. `stop()` would have SIGTERMed the process group here.
      expect(processKillSpy).not.toHaveBeenCalled();
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(manager.getStatus().state).toBe("running");
      expect(manager.getStatus().url).toBe("https://demo.trycloudflare.com");
    });

    it("refuses to claim a release when there is no live tunnel to hand over", async () => {
      const manager = makeManager();
      expect(manager.releaseForSupervisedRestart()).toBe(false);

      const child = await startRunning(manager);
      await manager.stop();
      expect(child.exitCode).toBe(0);
      expect(manager.releaseForSupervisedRestart()).toBe(false);
    });

    it("does not resurrect a released child through its close handler", async () => {
      const manager = makeManager();
      const child = await startRunning(manager);
      expect(manager.releaseForSupervisedRestart()).toBe(true);

      // If the released child ever does exit, this process must not treat it as an unexpected exit
      // and schedule a respawn — the restart is already handing ownership to the next process.
      child.close(0, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(manager.getStatus().state).toBe("running");
    });

    it("adopts an already-running tunnel instead of spawning a second one", async () => {
      const manager = makeManager();
      manager.adoptRunningTunnel("tailscale", "https://box.tail1234.ts.net/");

      const status = manager.getStatus();
      expect(status.state).toBe("running");
      expect(status.provider).toBe("tailscale");
      // No child of ours is behind an adopted tunnel.
      expect(status.pid).toBeNull();
      expect(status.url).toBe("https://box.tail1234.ts.net/");
      expect(children.size).toBe(0);

      // An adopted tunnel is running, so a start must not spawn a competing funnel.
      await expect(manager.start("tailscale", tailscaleConfig())).rejects.toThrow(/already_running/);
      expect(children.size).toBe(0);
    });

    it("stops an adopted tunnel through the provider reset, since there is no child to signal", async () => {
      const manager = makeManager();
      manager.adoptRunningTunnel("tailscale", "https://box.tail1234.ts.net/");
      mockExecFile.mockClear();

      await manager.stop();

      // "Stopped" in the UI has to mean the public URL is actually dark.
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", ["serve", "reset"], { timeout: 5_000 }, expect.any(Function));
      expect(manager.getStatus().state).toBe("stopped");
    });

    it("proves an active funnel from the serve config, including the port it proxies", async () => {
      mockExecFile.mockImplementation((_command: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string) => void) => {
        const callback = typeof optionsOrCallback === "function"
          ? optionsOrCallback as (error: Error | null, stdout?: string) => void
          : maybeCallback;
        const payload = JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4040" } } } },
          AllowFunnel: { "box.tail1234.ts.net:443": true },
        });
        callback?.(null, args.join(" ") === "serve status --json" ? payload : "");
        return {} as never;
      });

      const manager = new TunnelProcessManager();
      await expect(manager.detectActiveFunnel()).resolves.toEqual({
        provider: "tailscale",
        url: "https://box.tail1234.ts.net/",
        proxyPort: 4040,
      });
    });

    /*
    FNXC:RemoteAccess 2026-09-01-03:30:
    Payload captured verbatim from the operator's live container while its public URL was serving 200.
    `tailscale funnel <port>` — the exact command this manager spawns — registers a FOREGROUND session,
    so its config lands under `Foreground.<session-id>` and the top level is empty. Reading only the top
    level made a healthy, traffic-serving funnel undetectable, so a tunnel that survived a supervised
    restart was never adopted and the status route reported `stopped` while the URL worked.
    */
    it("proves a FOREGROUND funnel, which is the shape `tailscale funnel <port>` actually registers", async () => {
      mockExecFile.mockImplementation((_command: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string) => void) => {
        const callback = typeof optionsOrCallback === "function"
          ? optionsOrCallback as (error: Error | null, stdout?: string) => void
          : maybeCallback;
        const payload = JSON.stringify({
          Foreground: {
            bab18534080dc536: {
              TCP: { "443": { HTTPS: true } },
              Web: { "fusion-lab-1.barking-vibe.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4040" } } } },
              AllowFunnel: { "fusion-lab-1.barking-vibe.ts.net:443": true },
            },
          },
        });
        callback?.(null, args.join(" ") === "serve status --json" ? payload : "");
        return {} as never;
      });

      await expect(new TunnelProcessManager().detectActiveFunnel()).resolves.toEqual({
        provider: "tailscale",
        url: "https://fusion-lab-1.barking-vibe.ts.net/",
        proxyPort: 4040,
      });
    });

    it("still proves a persistent (backgrounded) funnel when both scopes are present", async () => {
      mockExecFile.mockImplementation((_command: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string) => void) => {
        const callback = typeof optionsOrCallback === "function"
          ? optionsOrCallback as (error: Error | null, stdout?: string) => void
          : maybeCallback;
        const payload = JSON.stringify({
          Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4040" } } } },
          AllowFunnel: { "box.tail1234.ts.net:443": true },
          Foreground: { session: { AllowFunnel: { "other.tail1234.ts.net:443": true } } },
        });
        callback?.(null, args.join(" ") === "serve status --json" ? payload : "");
        return {} as never;
      });

      await expect(new TunnelProcessManager().detectActiveFunnel()).resolves.toEqual({
        provider: "tailscale",
        url: "https://box.tail1234.ts.net/",
        proxyPort: 4040,
      });
    });

    it("reports no active funnel when tailscaled is serving nothing or is unreachable", async () => {
      mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string) => void) => {
        const callback = typeof optionsOrCallback === "function"
          ? optionsOrCallback as (error: Error | null, stdout?: string) => void
          : maybeCallback;
        callback?.(null, "{}");
        return {} as never;
      });
      await expect(new TunnelProcessManager().detectActiveFunnel()).resolves.toBeNull();

      // A logged-in node with no funnel must NOT read as adoptable — that was the weakness of the
      // DNSName-only probe, and adopting on it would report a dead URL as running.
      mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string) => void) => {
        const callback = typeof optionsOrCallback === "function"
          ? optionsOrCallback as (error: Error | null, stdout?: string) => void
          : maybeCallback;
        callback?.(null, JSON.stringify({ AllowFunnel: { "box.tail1234.ts.net:443": false } }));
        return {} as never;
      });
      await expect(new TunnelProcessManager().detectActiveFunnel()).resolves.toBeNull();

      mockExecFile.mockImplementation((_command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null) => void) => {
        const callback = typeof optionsOrCallback === "function"
          ? optionsOrCallback as (error: Error | null) => void
          : maybeCallback;
        callback?.(new Error("failed to connect to local tailscaled"));
        return {} as never;
      });
      await expect(new TunnelProcessManager().detectActiveFunnel()).resolves.toBeNull();
    });
  });
});
