import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForwardedDevArgs,
  buildDevNodeArgs,
  createDevWatchRestartCoordinator,
  getPrebuildCommand,
  normalizePrebuildMode,
  parseDevWrapperArgs,
  readDevServerListening,
  readDevServerListeningPort,
  resolveDevTunnelPort,
  resolveIsolatedDevPaths,
  resolvePrebuildMode,
} from "../../../../scripts/dev-with-memory-lib.mjs";
import {
  extractQuickTunnelUrl,
  formatDevTunnelBanner,
  resolveDevTunnelAuth,
} from "../../../../scripts/lib/dev-tunnel.mjs";
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
      tunnel: false,
      tunnelPort: undefined,
      isolated: false,
      isolatedDir: undefined,
    });
  });

  it("keeps the wrapper-only watch flag out of CLI arguments", () => {
    expect(parseDevWrapperArgs(["--watch", "dashboard", "--port", "4050"], {})).toEqual({
      inspectFlags: [],
      args: ["dashboard", "--port", "4050"],
      requestedPrebuild: "auto",
      watchSource: true,
      watchSourceFromFlag: true,
      tunnel: false,
      tunnelPort: undefined,
      isolated: false,
      isolatedDir: undefined,
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

  it("retains changes while the child is disconnected and sends them later", () => {
    const log = vi.fn();
    const warn = vi.fn();
    const send = vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.());
    const child = { connected: false, send };
    const coordinator = createDevWatchRestartCoordinator({ log, warn });
    coordinator.attach(child);
    coordinator.onMessage({ type: "fusion:dev-source-restart-armed" });

    coordinator.request(["packages/core/src/first.ts"]);
    child.connected = true;
    coordinator.request(["packages/core/src/second.ts"]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not connected"));
    expect(send).toHaveBeenCalledWith(
      { type: "fusion:dev-source-changed" },
      expect.any(Function),
    );
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("packages/core/src/first.ts, packages/core/src/second.ts"),
    );
  });

  it("retains changes after a send callback error and retries later", () => {
    const log = vi.fn();
    const warn = vi.fn();
    const send = vi.fn()
      .mockImplementationOnce((_message: unknown, callback?: (error?: Error) => void) => callback?.(new Error("send failed")))
      .mockImplementationOnce((_message: unknown, callback?: (error?: Error) => void) => callback?.());
    const child = { connected: true, send };
    const coordinator = createDevWatchRestartCoordinator({ log, warn });
    coordinator.attach(child);
    coordinator.onMessage({ type: "fusion:dev-source-restart-armed" });

    coordinator.request(["packages/core/src/first.ts"]);
    coordinator.request(["packages/core/src/second.ts"]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("packages/core/src/first.ts, packages/core/src/second.ts"),
    );
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

  it("continues closing source watchers when one close throws", () => {
    const logger = { warn: vi.fn() };
    const closes = [
      vi.fn(() => {
        throw new Error("close failed");
      }),
      vi.fn(),
    ];
    let index = 0;
    const watcher = createDevSourceWatcher({
      rootDir: "/repo",
      watchPaths: ["packages/core/src", "packages/engine/src"],
      watch: () => ({ close: closes[index++]!, on: vi.fn() }) as never,
      onRestart: vi.fn(),
      logger,
    });

    expect(() => watcher.close()).not.toThrow();
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(closes[1]).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("close failed"));
  });

  /*
  FNXC:DevTunnel 2026-08-18-23:40:
  `--tunnel` exposes the dev server through a Cloudflare quick tunnel, for the case where Fusion runs
  on a remote box (a container, a shared machine) and the operator needs to view the dev server from
  their own browser. A quick tunnel needs no account, domain, or card BECAUSE the dev server is HTTP.

  The subtle case: `--tunnel` optionally takes a port, so the parser must not swallow the next token
  when it is a dev-command argument rather than a port — `--tunnel dashboard` means "tunnel the
  dashboard's default port and run the dashboard", not "tunnel port NaN".
  */
  describe("dev tunnel flag", () => {
    it("enables the tunnel without consuming a following non-port argument", () => {
      expect(parseDevWrapperArgs(["--tunnel", "dashboard"], {})).toMatchObject({
        args: ["dashboard"],
        tunnel: true,
        tunnelPort: undefined,
      });
    });

    it("accepts a port as a separate token or inline", () => {
      expect(parseDevWrapperArgs(["--tunnel", "5173"], {})).toMatchObject({ tunnel: true, tunnelPort: 5173, args: [] });
      expect(parseDevWrapperArgs(["--tunnel=3000"], {})).toMatchObject({ tunnel: true, tunnelPort: 3000, args: [] });
    });

    it("rejects a non-numeric inline port instead of tunnelling something arbitrary", () => {
      expect(() => parseDevWrapperArgs(["--tunnel=frontend"], {})).toThrow(/Expected a port number/);
    });

    it("stays off by default and can be enabled from the environment", () => {
      expect(parseDevWrapperArgs(["dashboard"], {})).toMatchObject({ tunnel: false });
      expect(parseDevWrapperArgs(["dashboard"], { FUSION_DEV_TUNNEL: "1" })).toMatchObject({ tunnel: true });
    });

    it("targets the dashboard port unless told otherwise", () => {
      expect(resolveDevTunnelPort(undefined, {})).toBe(4040);
      expect(resolveDevTunnelPort(undefined, { PORT: "8080" })).toBe(8080);
      // An explicit --tunnel=PORT wins, so a Vite server can be exposed while PORT names the dashboard.
      expect(resolveDevTunnelPort(5173, { PORT: "8080" })).toBe(5173);
    });

    /*
    FNXC:DevIsolation 2026-08-20-04:10:
    A plain `pnpm dev` inside a machine already running Fusion SHARES its database: everything
    durable hangs off $HOME/.fusion, and a process pointed at a data dir whose postmaster is already
    up attaches to it rather than starting its own. Isolating HOME alone still leaves both instances
    on one project directory, where the orphaned-task-dir sweep would have the dev instance adopt
    the real one's tasks — so the flag moves the working directory too.
    */
    it("parses --isolated with and without an explicit directory", () => {
      expect(parseDevWrapperArgs(["--isolated"], {})).toMatchObject({ isolated: true, isolatedDir: undefined });
      expect(parseDevWrapperArgs(["--isolated=/tmp/sandbox"], {})).toMatchObject({ isolated: true, isolatedDir: "/tmp/sandbox" });
      expect(parseDevWrapperArgs(["dashboard"], {})).toMatchObject({ isolated: false });
      expect(parseDevWrapperArgs(["dashboard"], { FUSION_DEV_ISOLATED: "1" })).toMatchObject({ isolated: true });
      expect(() => parseDevWrapperArgs(["--isolated="], {})).toThrow(/Missing directory/);
    });

    it("does not swallow a following argument as the isolation directory", () => {
      // `--isolated dashboard` means "isolate, and run the dashboard".
      expect(parseDevWrapperArgs(["--isolated", "dashboard"], {})).toMatchObject({ isolated: true, isolatedDir: undefined, args: ["dashboard"] });
    });

    it("keeps the sandbox out of the repo and separates database from project", () => {
      const paths = resolveIsolatedDevPaths({ repoRoot: "/Users/dev/Projects/kb", home: "/Users/dev" });
      // Outside the work tree: a project dir inside it shows up in git status and dies on a clean checkout.
      expect(paths.base).toBe("/Users/dev/.fusion-dev/kb");
      expect(paths.home).toBe("/Users/dev/.fusion-dev/kb/home");
      expect(paths.project).toBe("/Users/dev/.fusion-dev/kb/project");
      expect(paths.project.startsWith("/Users/dev/Projects/kb")).toBe(false);
    });

    it("keys the sandbox by checkout so two clones do not share one database", () => {
      const a = resolveIsolatedDevPaths({ repoRoot: "/w/kb", home: "/h" });
      const b = resolveIsolatedDevPaths({ repoRoot: "/w/kb-feature", home: "/h" });
      expect(a.home).not.toBe(b.home);
    });

    it("honours an explicit sandbox directory", () => {
      expect(resolveIsolatedDevPaths({ repoRoot: "/w/kb", explicitDir: "/tmp/sandbox" }))
        .toEqual({ base: "/tmp/sandbox", home: "/tmp/sandbox/home", project: "/tmp/sandbox/project" });
    });

    it("recognises the cloudflare quick-tunnel hostname in agent output", () => {
      expect(extractQuickTunnelUrl("INF |  https://neat-fox-tree.trycloudflare.com  |")).toBe("https://neat-fox-tree.trycloudflare.com");
      expect(extractQuickTunnelUrl("INF Registered tunnel connection")).toBeNull();
    });

    /*
    FNXC:DevTunnel 2026-08-19-01:18:
    The banner must state the target's ACTUAL auth. The default target is the dashboard, which is
    bearer-token gated, so a bare URL is unusable by the person it was shared with — and the old
    "public, unauthenticated" wording was wrong for exactly that default. Only a foreign port (a
    Vite server, say) is genuinely ungated, because Fusion has no auth to lend it.
    */
    const auth = (over: Record<string, unknown> = {}) => resolveDevTunnelAuth({
      port: 4040,
      dashboardPort: 4040,
      env: {},
      settingsFile: "/nonexistent/settings.json",
      readToken: () => null,
      ...over,
    });

    it("lends the dashboard token to a tunnel aimed at the dashboard", () => {
      expect(auth({ readToken: () => "fn_abc" })).toEqual({ kind: "token", token: "fn_abc" });
      expect(auth({ env: { FUSION_DASHBOARD_TOKEN: "fn_env" }, readToken: () => "fn_disk" }))
        .toEqual({ kind: "token", token: "fn_env" });
      expect(auth({ env: { FUSION_DAEMON_TOKEN: "fn_daemon" } }))
        .toEqual({ kind: "token", token: "fn_daemon" });
    });

    it("does not claim a foreign port or --no-auth is token-gated", () => {
      expect(auth({ port: 5173, readToken: () => "fn_abc" })).toEqual({ kind: "foreign" });
      expect(auth({ args: ["dashboard", "--no-auth"], readToken: () => "fn_abc" })).toEqual({ kind: "no-auth" });
    });

    it("defers to the dashboard banner when no token has been minted yet", () => {
      expect(auth()).toEqual({ kind: "token-pending" });
    });

    /*
    FNXC:DevTunnel 2026-08-19-02:05:
    The port the dev server is ASKED for is not the port it gets: an occupied port makes the
    dashboard rebind to an ephemeral one. With a normal Fusion already on 4040 the tunnel therefore
    pointed at THAT instance and served the wrong app under a dev-looking URL. The child's listening
    report is the only fact about where the dev server actually is.
    */
    it("reads the dev server's bound port from its listening report only", () => {
      expect(readDevServerListeningPort({ type: "fusion:dev-server-listening", port: 51234 })).toBe(51234);
      expect(readDevServerListeningPort({ type: "fusion:dev-source-restart-armed" })).toBeNull();
      expect(readDevServerListeningPort({ type: "fusion:dev-server-listening" })).toBeNull();
      expect(readDevServerListeningPort({ type: "fusion:dev-server-listening", port: 0 })).toBeNull();
      expect(readDevServerListeningPort({ type: "fusion:dev-server-listening", port: "51234" })).toBe(51234);
      expect(readDevServerListeningPort(null)).toBeNull();
      expect(readDevServerListeningPort("fusion:dev-server-listening")).toBeNull();
    });

    /*
    FNXC:DevTunnel 2026-08-19-03:00:
    The token must come from the child, not be re-derived. A real run proved the derivation wrong:
    ~/.fusion/settings.json held no daemonToken, so the tunnel banner said "no token yet" while the
    dashboard's own banner two lines above printed a working one.
    */
    it("reads the port and token the dev server reports", () => {
      expect(readDevServerListening({ type: "fusion:dev-server-listening", port: 58635, token: "fn_real" }))
        .toEqual({ port: 58635, token: "fn_real" });
      // A no-auth dev server reports no token; that is not a malformed report.
      expect(readDevServerListening({ type: "fusion:dev-server-listening", port: 58635 }))
        .toEqual({ port: 58635, token: null });
      expect(readDevServerListening({ type: "fusion:dev-source-restart-armed", port: 1 })).toBeNull();
      expect(readDevServerListening({ type: "fusion:dev-server-listening", port: 0 })).toBeNull();
    });

    it("prefers the reported token over anything it could derive", () => {
      expect(auth({ reportedToken: "fn_from_child", env: { FUSION_DASHBOARD_TOKEN: "fn_env" }, readToken: () => "fn_disk" }))
        .toEqual({ kind: "token", token: "fn_from_child" });
      // Falls back only when nothing was reported (e.g. an explicit --tunnel=PORT never waits).
      expect(auth({ reportedToken: null, env: { FUSION_DASHBOARD_TOKEN: "fn_env" } }))
        .toEqual({ kind: "token", token: "fn_env" });
    });

    it("still treats a dev dashboard on an ephemeral port as token-gated", () => {
      // The reported port IS the dashboard, so the banner must keep lending it the token rather
      // than classifying it "foreign" for not matching 4040.
      expect(auth({ port: 51234, dashboardPort: 51234, readToken: () => "fn_abc" }))
        .toEqual({ kind: "token", token: "fn_abc" });
    });

    it("prints an openable URL for the token case and a warning only where it is true", () => {
      const url = "https://neat-fox-tree.trycloudflare.com";
      const tokenLines = formatDevTunnelBanner({ url, port: 4040, auth: { kind: "token", token: "fn_abc" } }).join("\n");
      expect(tokenLines).toContain("token: fn_abc");
      expect(tokenLines).toContain(`${url}/?token=fn_abc`);
      expect(tokenLines).not.toContain("unauthenticated");

      expect(formatDevTunnelBanner({ url, port: 5173, auth: { kind: "foreign" } }).join("\n"))
        .toContain("Fusion adds no auth");
      expect(formatDevTunnelBanner({ url, port: 4040, auth: { kind: "no-auth" } }).join("\n"))
        .toContain("unauthenticated");
      expect(formatDevTunnelBanner({ url, port: 4040, auth: { kind: "token-pending" } }).join("\n"))
        .toContain("?token=");
    });
  });
});
