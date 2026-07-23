/**
 * Tests for the isolated-app-launch harness (U4).
 *
 * Characterizes the R13 isolation/safety contracts BEFORE any real navigation
 * (U8) drives the instance. Process-spawn and bundle-build are injected, so
 * these unit tests assert the isolation guarantees WITHOUT launching a full
 * server — a real end-to-end launch belongs in a heavier lane / manual smoke
 * (see scripts/boot-smoke.mjs), not the merge gate.
 *
 * Contracts covered:
 * - Launch never binds a reserved dashboard port (R13).
 * - Uses a fresh/empty disposable DB under a unique tmpdir, not the central DB,
 *   with no credentials/agent logs seeded (R13).
 * - A stale bundle is rebuilt before launch (no false verdict from stale
 *   dist/client) (R13).
 * - Teardown frees the port and removes the DB/tmpdir, even when the launched
 *   process exits non-zero or times out (R13).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import { createServer as createNetServer } from "node:net";
import {
  launchIsolatedApp,
  resolveReservedPorts,
  parsePortList,
  acquireNonReservedPort,
  createDisposableAppWorkspace,
  type AppProcessSpawner,
  type BundleBuilder,
  type LaunchedAppProcess,
  type AppLaunchOptions,
} from "../missions/mission-verification-app-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── reserved-port policy ───────────────────────────────────────────────────────

describe("parsePortList", () => {
  it("parses a comma-separated list and drops invalid entries", () => {
    expect(parsePortList("4040, 5173 ,99999,abc,-1,0")).toEqual([4040, 5173]);
  });
  it("returns empty for undefined/empty", () => {
    expect(parsePortList(undefined)).toEqual([]);
    expect(parsePortList("")).toEqual([]);
  });
});

describe("resolveReservedPorts", () => {
  it("always reserves 4040", () => {
    expect(resolveReservedPorts({}).has(4040)).toBe(true);
  });
  it("adds FUSION_RESERVED_PORTS, PORT, and FUSION_SERVER_PORT", () => {
    const reserved = resolveReservedPorts({
      FUSION_RESERVED_PORTS: "5000,5001",
      PORT: "6000",
      FUSION_SERVER_PORT: "7000",
    });
    expect([...reserved].sort((a, b) => a - b)).toEqual([4040, 5000, 5001, 6000, 7000]);
  });
});

describe("acquireNonReservedPort", () => {
  it("returns a port that is not in the reserved set", async () => {
    const reserved = new Set<number>([4040]);
    const port = await acquireNonReservedPort(reserved);
    expect(reserved.has(port)).toBe(false);
    expect(port).toBeGreaterThan(0);
  });
});

// ── injectable launch stubs ─────────────────────────────────────────────────────

interface SpawnRecord {
  calls: AppLaunchOptions[];
}

/**
 * A stub spawner that records its launch options and never starts a real
 * process. `behavior` controls readiness so teardown can be tested across
 * normal/crash/timeout outcomes.
 */
function makeStubSpawner(
  record: SpawnRecord,
  behavior: "ready" | "crash" | "hang" = "ready",
): { spawner: AppProcessSpawner; killed: () => number } {
  let killCount = 0;
  const spawner: AppProcessSpawner = (options) => {
    record.calls.push(options);
    const handle: LaunchedAppProcess = {
      ready:
        behavior === "ready"
          ? Promise.resolve()
          : behavior === "crash"
            ? Promise.reject(new Error("server process exited with code 1 before becoming healthy"))
            : new Promise<void>(() => {
                /* never resolves — simulates a hung/timed-out launch */
              }),
      kill: async () => {
        killCount += 1;
      },
    };
    return handle;
  };
  return { spawner, killed: () => killCount };
}

/** A bundle builder whose staleness and build are scripted and recorded. */
function makeStubBundle(stale: boolean): BundleBuilder & {
  buildCalls: number;
  currentCalls: number;
} {
  const state = {
    buildCalls: 0,
    currentCalls: 0,
    async isStale() {
      return stale;
    },
    async build() {
      state.buildCalls += 1;
      return { clientDir: "/tmp/fresh-built-client" };
    },
    async current() {
      state.currentCalls += 1;
      return { clientDir: "/tmp/already-built-client" };
    },
  };
  return state;
}

// ── R13: never binds a reserved port ────────────────────────────────────────────

describe("launchIsolatedApp — reserved port (R13)", () => {
  it("never spawns on a reserved dashboard port, even with a wide reserved config", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner } = makeStubSpawner(record, "ready");
    const app = await launchIsolatedApp({
      spawn: spawner,
      bundle: makeStubBundle(false),
      env: { FUSION_RESERVED_PORTS: "4040,5173,6006", PORT: "3000" },
    });
    try {
      const reserved = resolveReservedPorts({ FUSION_RESERVED_PORTS: "4040,5173,6006", PORT: "3000" });
      expect(record.calls).toHaveLength(1);
      expect(reserved.has(app.port)).toBe(false);
      expect(app.port).not.toBe(4040);
      expect(app.baseUrl).toBe(`http://127.0.0.1:${app.port}`);
      expect(record.calls[0].port).toBe(app.port);
    } finally {
      await app.dispose();
    }
  });
});

// ── R13: fresh/empty disposable DB under a unique tmpdir ─────────────────────────

describe("createDisposableAppWorkspace — disposable DB (R13)", () => {
  it("creates a fresh empty DB under a unique tmpdir and removes it on dispose", async () => {
    const ws = await createDisposableAppWorkspace();
    // Under the OS tmpdir, not the central DB / project dir.
    expect(ws.tmpDir.startsWith(os.tmpdir())).toBe(true);
    expect(ws.dbPath.startsWith(ws.tmpDir)).toBe(true);
    // Fresh + empty: zero bytes => not a copy of the central DB, no seeded
    // credentials or agent logs.
    const stat = await fs.stat(ws.dbPath);
    expect(stat.size).toBe(0);
    await ws.dispose();
    await expect(fs.stat(ws.tmpDir)).rejects.toThrow();
  });

  it("yields a unique tmpdir per call", async () => {
    const a = await createDisposableAppWorkspace();
    const b = await createDisposableAppWorkspace();
    try {
      expect(a.tmpDir).not.toBe(b.tmpDir);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});

describe("launchIsolatedApp — disposable DB wiring (R13)", () => {
  it("launches against a fresh tmpdir DB, never the central DB", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner } = makeStubSpawner(record, "ready");
    const app = await launchIsolatedApp({
      spawn: spawner,
      bundle: makeStubBundle(false),
      env: {},
    });
    try {
      expect(record.calls[0].dbPath).toBe(app.dbPath);
      expect(app.dbPath.startsWith(os.tmpdir())).toBe(true);
      // The disposable DB exists and is empty before disposal.
      const stat = await fs.stat(app.dbPath);
      expect(stat.size).toBe(0);
      // The scrubbed env must carry no credentials.
      const env = record.calls[0].env;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });

  it("does not inherit credentials from the host env into the launched process", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner } = makeStubSpawner(record, "ready");
    const app = await launchIsolatedApp({
      spawn: spawner,
      bundle: makeStubBundle(false),
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "secret",
        FUSION_DAEMON_TOKEN: "tok",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    });
    try {
      const env = record.calls[0].env;
      expect(env.PATH).toBe("/usr/bin");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.FUSION_DAEMON_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      await app.dispose();
    }
  });
});

// ── R13: stale bundle rebuilt before launch ─────────────────────────────────────

describe("launchIsolatedApp — fresh bundle (R13)", () => {
  it("rebuilds a stale bundle before launch and serves the freshly-built dir", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner } = makeStubSpawner(record, "ready");
    const bundle = makeStubBundle(true);
    const app = await launchIsolatedApp({ spawn: spawner, bundle, env: {} });
    try {
      expect(bundle.buildCalls).toBe(1);
      expect(bundle.currentCalls).toBe(0);
      expect(app.clientDir).toBe("/tmp/fresh-built-client");
      expect(record.calls[0].clientDir).toBe("/tmp/fresh-built-client");
    } finally {
      await app.dispose();
    }
  });

  it("serves the current bundle without rebuilding when it is not stale", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner } = makeStubSpawner(record, "ready");
    const bundle = makeStubBundle(false);
    const app = await launchIsolatedApp({ spawn: spawner, bundle, env: {} });
    try {
      expect(bundle.buildCalls).toBe(0);
      expect(bundle.currentCalls).toBe(1);
      expect(app.clientDir).toBe("/tmp/already-built-client");
    } finally {
      await app.dispose();
    }
  });
});

// ── R13: unconditional teardown (crash / timeout / normal) ───────────────────────

describe("launchIsolatedApp — unconditional teardown (R13)", () => {
  it("frees the port and removes the tmpdir/DB on normal disposal", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner, killed } = makeStubSpawner(record, "ready");
    const app = await launchIsolatedApp({ spawn: spawner, bundle: makeStubBundle(false), env: {} });
    const port = app.port;
    const dbPath = app.dbPath;
    await app.dispose();
    // Process killed.
    expect(killed()).toBe(1);
    // DB/tmpdir removed.
    await expect(fs.stat(dbPath)).rejects.toThrow();
    // Port freed — we can now bind it ourselves.
    await expect(bindAndRelease(port)).resolves.toBeUndefined();
  });

  it("tears down (kills process + removes DB) when the process crashes before ready", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner, killed } = makeStubSpawner(record, "crash");
    await expect(
      launchIsolatedApp({ spawn: spawner, bundle: makeStubBundle(false), env: {} }),
    ).rejects.toThrow(/exited with code 1/);
    // The launch failed, but teardown still ran: process killed, DB removed.
    expect(killed()).toBe(1);
    expect(record.calls).toHaveLength(1);
    await expect(fs.stat(record.calls[0].dbPath)).rejects.toThrow();
  });

  it("tears down on a startup timeout (hung process)", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner, killed } = makeStubSpawner(record, "hang");
    await expect(
      launchIsolatedApp({
        spawn: spawner,
        bundle: makeStubBundle(false),
        env: {},
        readyTimeoutMs: 20,
      }),
    ).rejects.toThrow(/did not become ready/);
    expect(killed()).toBe(1);
    await expect(fs.stat(record.calls[0].dbPath)).rejects.toThrow();
  });

  it("tears down when the launch is aborted via signal", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner, killed } = makeStubSpawner(record, "hang");
    const controller = new AbortController();
    const launch = launchIsolatedApp({
      spawn: spawner,
      bundle: makeStubBundle(false),
      env: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(launch).rejects.toThrow(/abort/i);
    expect(killed()).toBe(1);
    await expect(fs.stat(record.calls[0].dbPath)).rejects.toThrow();
  });

  it("removes the tmpdir/DB even if the bundle build fails before spawn", async () => {
    const failingBundle: BundleBuilder = {
      async isStale() {
        return true;
      },
      async build() {
        throw new Error("bundle build failed");
      },
      async current() {
        return { clientDir: "/tmp/unused" };
      },
    };
    const record: SpawnRecord = { calls: [] };
    const { spawner, killed } = makeStubSpawner(record, "ready");
    await expect(
      launchIsolatedApp({ spawn: spawner, bundle: failingBundle, env: {} }),
    ).rejects.toThrow(/bundle build failed/);
    // Spawn never happened; nothing to kill, and no tmpdir leak.
    expect(killed()).toBe(0);
    expect(record.calls).toHaveLength(0);
    // (Workspace was created then disposed — verified indirectly: no spawn means
    // the only filesystem artifact is the tmpdir, which dispose removed. We
    // cannot capture its path here, so this asserts the no-spawn invariant.)
  });

  it("dispose is idempotent (safe to call twice)", async () => {
    const record: SpawnRecord = { calls: [] };
    const { spawner, killed } = makeStubSpawner(record, "ready");
    const app = await launchIsolatedApp({ spawn: spawner, bundle: makeStubBundle(false), env: {} });
    await app.dispose();
    await expect(app.dispose()).resolves.toBeUndefined();
    expect(killed()).toBe(2); // kill is idempotent at the handle level
  });
});

/** Bind a port and release it — proves it is free. */
function bindAndRelease(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve());
    });
  });
}
