import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForwardedDevArgs,
  buildDevNodeArgs,
  createDevWatchRestartCoordinator,
  getPrebuildCommand,
  normalizePrebuildMode,
  parseDevWrapperArgs,
  resolvePrebuildMode,
} from "../../../../scripts/dev-with-memory-lib.mjs";
import {
  createDevSourceWatcher,
  isRestartableSourceFile,
} from "../../../../scripts/lib/dev-source-watch.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("buildDevNodeArgs", () => {
  it("enables source-condition resolution before loading the tsx runtime", () => {
    const args = buildDevNodeArgs({
      inspectFlags: ["--inspect=9230"],
      preload: "/tmp/preflight.cjs",
      loader: "/tmp/loader.mjs",
      entry: "/tmp/bin.ts",
      args: ["dashboard", "--host", "0.0.0.0"],
    });

    expect(args).toEqual([
      "--inspect=9230",
      "--conditions=source",
      "--require",
      "/tmp/preflight.cjs",
      "--import",
      "file:///tmp/loader.mjs",
      "/tmp/bin.ts",
      "dashboard",
      "--host",
      "0.0.0.0",
    ]);
  });
});

describe("dev-with-memory prebuild options", () => {
  it("strips wrapper-only prebuild and inspector flags before forwarding CLI args", () => {
    const parsed = parseDevWrapperArgs(
      ["--inspect=9230", "--prebuild=none", "dashboard", "--port", "4050"],
      {},
    );

    expect(parsed).toEqual({
      inspectFlags: ["--inspect=9230"],
      args: ["dashboard", "--port", "4050"],
      requestedPrebuild: "none",
      watchSource: false,
      watchSourceFromFlag: false,
    });
  });

  it("keeps the wrapper-only watch flag out of CLI arguments", () => {
    expect(parseDevWrapperArgs(["--watch", "dashboard", "--port", "4050"], {})).toEqual({
      inspectFlags: [],
      args: ["dashboard", "--port", "4050"],
      requestedPrebuild: "auto",
      watchSource: true,
      watchSourceFromFlag: true,
    });
  });

  it("allows source watching to be enabled through the development environment", () => {
    expect(parseDevWrapperArgs(["dashboard"], { FUSION_DEV_WATCH: "1" })).toMatchObject({
      args: ["dashboard"],
      watchSource: true,
      watchSourceFromFlag: false,
    });
  });

  it("rejects explicit empty prebuild modes", () => {
    expect(() => normalizePrebuildMode("")).toThrow(/Invalid prebuild mode/);
    expect(() => parseDevWrapperArgs(["--prebuild=", "dashboard"], {})).toThrow(/Invalid prebuild mode/);
  });

  it("defaults a bare invocation to the dashboard command with the dev host", () => {
    // FNXC:DevWorkflow 2026-07-12-10:20: `pnpm dev`/`pnpm start` with no
    // command must equal `pnpm dev dashboard` (prebuild + host injection).
    expect(buildForwardedDevArgs([])).toEqual(["dashboard", "--host", "0.0.0.0"]);
  });

  it("defaults a flag-only invocation to the dashboard command, preserving flags", () => {
    expect(buildForwardedDevArgs(["--paused"])).toEqual([
      "dashboard",
      "--paused",
      "--host",
      "0.0.0.0",
    ]);
  });

  it("leaves non-dashboard commands untouched", () => {
    expect(buildForwardedDevArgs(["serve", "--port", "4050"])).toEqual([
      "serve",
      "--port",
      "4050",
    ]);
  });

  it("does not inject a dev host when --host=value is already present", () => {
    expect(buildForwardedDevArgs(["dashboard", "--host=127.0.0.1"])).toEqual([
      "dashboard",
      "--host=127.0.0.1",
    ]);
  });

  it("injects a LAN-reachable dev host for dashboard startup without a host override", () => {
    expect(buildForwardedDevArgs(["dashboard", "--port", "4050"])).toEqual([
      "dashboard",
      "--port",
      "4050",
      "--host",
      "0.0.0.0",
    ]);
  });

  it("rebuilds core + engine + dashboard (UI) + changed plugins for dashboard startup, not the full workspace", () => {
    // FN-6638/stale-dist: dev dashboard must refresh engine + core dist (not
    // just the client bundle) so landed fixes are not silently stale.
    // FN-7779/stale-plugin-dist: it must ALSO incrementally rebuild changed
    // plugins (plugin dist loads at runtime), so the client prebuild is now a
    // single orchestrator command covering both.
    expect(resolvePrebuildMode("auto", ["dashboard", "--port", "4050"])).toBe("client");
    expect(getPrebuildCommand("client")).toEqual({
      command: "node",
      args: ["scripts/dev-prebuild-client.mjs"],
      label: "core + engine + dashboard + changed plugins build",
    });
  });

  it("skips prebuild by default for non-dashboard CLI commands", () => {
    expect(resolvePrebuildMode("auto", ["task", "list"])).toBe("none");
    expect(getPrebuildCommand("none")).toBeNull();
  });

  it("keeps full workspace prebuild available when requested", () => {
    expect(resolvePrebuildMode("full", ["dashboard"])).toBe("full");
    expect(getPrebuildCommand("full")).toEqual({
      command: "pnpm",
      args: ["build"],
      label: "workspace build",
    });
  });
});

describe("development source restart watcher", () => {
  it("holds source changes until the child acknowledges its IPC listener", () => {
    const send = vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.());
    const child = { connected: true, send };
    const coordinator = createDevWatchRestartCoordinator({ log: vi.fn(), warn: vi.fn() });
    coordinator.attach(child);

    coordinator.request(["packages/core/src/store.ts"]);
    expect(send).not.toHaveBeenCalled();

    coordinator.onMessage({ type: "fusion:dev-source-restart-armed" });
    expect(send).toHaveBeenCalledWith(
      { type: "fusion:dev-source-changed" },
      expect.any(Function),
    );
    expect(coordinator.detach(child)).toBe(true);
  });

  it("re-arms after the watched child is replaced", () => {
    const first = { connected: true, send: vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.()) };
    const second = { connected: true, send: vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.()) };
    const coordinator = createDevWatchRestartCoordinator({ log: vi.fn(), warn: vi.fn() });

    coordinator.attach(first);
    coordinator.onMessage({ type: "fusion:dev-source-restart-armed" });
    coordinator.request(["packages/core/src/first.ts"]);
    expect(coordinator.detach(first)).toBe(true);

    coordinator.attach(second);
    coordinator.request(["packages/core/src/second.ts"]);
    expect(second.send).not.toHaveBeenCalled();
    coordinator.onMessage({ type: "fusion:dev-source-restart-armed" });
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it("restarts for runtime sources but ignores tests and generated declarations", () => {
    expect(isRestartableSourceFile("store.ts")).toBe(true);
    expect(isRestartableSourceFile("routes/system.tsx")).toBe(true);
    expect(isRestartableSourceFile("__tests__/store.test.ts")).toBe(false);
    expect(isRestartableSourceFile("store.spec.ts")).toBe(false);
    expect(isRestartableSourceFile("generated/runtime.d.ts")).toBe(false);
    expect(isRestartableSourceFile("README.md")).toBe(false);
  });

  it("coalesces source events into one restart and reports the changed paths", () => {
    vi.useFakeTimers();
    const listeners: Array<(eventType: string, filename: string | Buffer | null) => void> = [];
    const close = vi.fn();
    const onRestart = vi.fn();

    const watcher = createDevSourceWatcher({
      rootDir: "/repo",
      watchPaths: ["packages/core/src", "packages/engine/src"],
      debounceMs: 250,
      watch: (_path, _options, listener) => {
        listeners.push(listener);
        return { close, on: vi.fn() };
      },
      onRestart,
    });

    listeners[0]?.("change", "store.ts");
    listeners[1]?.("rename", "triage.ts");
    listeners[1]?.("change", "__tests__/triage.test.ts");

    vi.advanceTimersByTime(249);
    expect(onRestart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith([
      "packages/core/src/store.ts",
      "packages/engine/src/triage.ts",
    ]);

    watcher.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not starve a restart during a sustained source event stream", () => {
    vi.useFakeTimers();
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const onRestart = vi.fn();
    const watcher = createDevSourceWatcher({
      rootDir: "/repo",
      watchPaths: ["packages/core/src"],
      debounceMs: 350,
      maxWaitMs: 1_000,
      watch: (_path, _options, nextListener) => {
        listener = nextListener;
        return { close: vi.fn(), on: vi.fn() } as never;
      },
      onRestart,
    });

    for (let elapsed = 0; elapsed < 1_000; elapsed += 200) {
      listener?.("change", `file-${elapsed}.ts`);
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(1);

    expect(onRestart).toHaveBeenCalledTimes(1);
    watcher.close();
  });
});
