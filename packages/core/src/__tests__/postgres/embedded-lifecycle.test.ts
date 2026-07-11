/**
 * Embedded PostgreSQL lifecycle manager tests (U2 / VAL-CONN-001, VAL-CONN-006, VAL-CONN-007).
 *
 * FNXC:PostgresEmbedded 2026-06-24-09:10:
 * These are real-process integration tests against the bundled embedded-postgres
 * binary. They are gated behind FUSION_EMBEDDED_TEST_SKIP so CI / cold caches
 * can opt out, but run by default because the embedded lifecycle is the
 * zero-config default that must work out of the box. Each test uses a unique
 * temp data directory so runs are hermetic.
 *
 * Coverage targets:
 *   - VAL-CONN-001: first start runs initdb + ensures DB exists + serves.
 *   - VAL-CONN-006: second start reuses the data dir without re-initdb; data persists.
 *   - VAL-CONN-007: graceful shutdown stops the Postgres process; no orphan.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  readlinkSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  EmbeddedPostgresLifecycle,
  EmbeddedStartTimeoutError,
  DEFAULT_START_TIMEOUT_MS,
  isDataDirInitialized,
  normalizeMacosEmbeddedPostgresDylibSymlinks,
  readPortFromPostmasterPid,
  type EmbeddedLifecycleOptions,
} from "../../postgres/embedded-lifecycle.js";

const SKIP = process.env.FUSION_EMBEDDED_TEST_SKIP === "1";
const embeddedDescribe = SKIP ? describe.skip : describe;

/** Track lifecycle instances + temp dirs for teardown to avoid orphaned processes. */
const tracked: Array<{
  lifecycle: EmbeddedPostgresLifecycle;
  dataDir: string;
}> = [];

afterEach(async () => {
  while (tracked.length > 0) {
    const { lifecycle, dataDir } = tracked.pop()!;
    try {
      await lifecycle.stop();
    } catch {
      // best-effort shutdown
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-test-"));
  return dir;
}

function baseOptions(dataDir: string): EmbeddedLifecycleOptions {
  return {
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  };
}

describe("embedded-lifecycle: isDataDirInitialized (PG_VERSION marker)", () => {
  it("returns false for an empty/missing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-marker-"));
    try {
      expect(isDataDirInitialized(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when PG_VERSION exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-marker-"));
    try {
      // Simulate an initialized dir by writing PG_VERSION.
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(dir, "PG_VERSION"), "15\n");
      expect(isDataDirInitialized(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedded-lifecycle: constructor + URL helpers (no process)", () => {
  it("builds a connection URL with credentials for the configured database", () => {
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir: "/tmp/unused",
      database: "fusion",
      port: 55432,
      user: "postgres",
      password: "password",
    });
    const url = lifecycle.getConnectionUrl();
    expect(url).toContain("55432");
    expect(url).toContain("/fusion");
    // credential present in the URL (used internally; never logged by callers).
    expect(url).toContain("postgres:password@");
  });

  it("builds a redacted URL that hides the password", () => {
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir: "/tmp/unused",
      database: "fusion",
      port: 55432,
      user: "postgres",
      password: "password",
    });
    const redacted = lifecycle.getRedactedConnectionUrl();
    expect(redacted).not.toContain("password");
    expect(redacted).toContain("********");
    expect(redacted).toContain("55432");
  });

  it("getPort returns undefined before start when no explicit port is set", () => {
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir: "/tmp/unused",
      database: "fusion",
      user: "postgres",
      password: "password",
    });
    expect(lifecycle.getPort()).toBeUndefined();
  });

  it("getPort returns the explicit port before start when set", () => {
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir: "/tmp/unused",
      database: "fusion",
      port: 55433,
      user: "postgres",
      password: "password",
    });
    expect(lifecycle.getPort()).toBe(55433);
  });
});

describe("embedded-lifecycle: macOS dylib compatibility links", () => {
  it("repairs missing compatibility-name symlinks from versioned dylibs", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-native-"));
    try {
      const libDir = join(nativeRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "libpq.5.15.dylib"), "");
      writeFileSync(join(libDir, "libzstd.1.5.7.dylib"), "");
      writeFileSync(join(libDir, "liblz4.1.10.0.dylib"), "");
      writeFileSync(join(libDir, "libz.1.3.2.dylib"), "");
      writeFileSync(join(libDir, "libicui18n.68.2.dylib"), "");

      const created = normalizeMacosEmbeddedPostgresDylibSymlinks(nativeRoot);

      expect(created.map((link) => link.expected).sort()).toEqual([
        "libicui18n.dylib",
        "liblz4.1.dylib",
        "libpq.5.dylib",
        "libz.1.dylib",
        "libzstd.1.dylib",
      ]);
      expect(readlinkSync(join(libDir, "libpq.5.dylib"))).toBe("libpq.5.15.dylib");
      expect(readlinkSync(join(libDir, "libzstd.1.dylib"))).toBe("libzstd.1.5.7.dylib");

      // Idempotent: the second pass sees the compatibility names and creates nothing.
      expect(normalizeMacosEmbeddedPostgresDylibSymlinks(nativeRoot)).toEqual([]);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("replaces stale broken compatibility-name symlinks", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-native-"));
    try {
      const libDir = join(nativeRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "libpq.5.16.dylib"), "");
      symlinkSync("libpq.5.15.dylib", join(libDir, "libpq.5.dylib"));

      const created = normalizeMacosEmbeddedPostgresDylibSymlinks(nativeRoot);

      expect(created).toEqual([
        { expected: "libpq.5.dylib", target: "libpq.5.16.dylib", created: true },
      ]);
      expect(readlinkSync(join(libDir, "libpq.5.dylib"))).toBe("libpq.5.16.dylib");
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });
});

embeddedDescribe("embedded-lifecycle: real process (VAL-CONN-001, VAL-CONN-006, VAL-CONN-007)", () => {
  it("first start runs initdb, ensures DB exists, and serves traffic (VAL-CONN-001)", async () => {
    const dataDir = makeDataDir();
    const lifecycle = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
    tracked.push({ lifecycle, dataDir });

    // Before start, the dir is not initialized.
    expect(isDataDirInitialized(dataDir)).toBe(false);

    const backend = await lifecycle.start();

    // After start, PG_VERSION exists (initdb ran).
    expect(isDataDirInitialized(dataDir)).toBe(true);

    // Backend is embedded mode with a resolved runtime URL.
    expect(backend.mode).toBe("embedded");
    expect(backend.runtimeUrl).not.toBeNull();
    expect(backend.runtimeUrl).toContain("/fusion");

    // The port was assigned (free-port discovery).
    expect(lifecycle.getPort()).toBeGreaterThan(0);

    // Traffic is served: connect via postgres.js and query.
    const sql = postgres(lifecycle.getConnectionUrl(), { max: 1 });
    try {
      const rows = await sql`SELECT current_database() AS db`;
      expect(rows[0].db).toBe("fusion");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("second start reuses the existing data directory without re-initdb (VAL-CONN-006)", async () => {
    const dataDir = makeDataDir();

    // First lifecycle: start, write a marker row, stop.
    const first = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
    await first.start();
    const sql1 = postgres(first.getConnectionUrl(), { max: 1 });
    try {
      await sql1`CREATE TABLE persistence_marker (id int PRIMARY KEY, note text)`;
      await sql1`INSERT INTO persistence_marker (id, note) VALUES (1, 'persisted')`;
    } finally {
      await sql1.end({ timeout: 5 });
    }
    await first.stop();

    // The data dir is still initialized after stop (persistent).
    expect(isDataDirInitialized(dataDir)).toBe(true);

    // Second lifecycle: start against the SAME dir.
    const second = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
    tracked.push({ lifecycle: second, dataDir });

    await second.start();
    const sql2 = postgres(second.getConnectionUrl(), { max: 1 });
    try {
      const rows = await sql2`SELECT note FROM persistence_marker WHERE id = 1`;
      expect(rows[0].note).toBe("persisted");
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it("ensureDatabase is idempotent: re-starting and ensuring the same DB does not error", async () => {
    const dataDir = makeDataDir();
    const lifecycle = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
    tracked.push({ lifecycle, dataDir });

    await lifecycle.start();
    // Calling ensureDatabase again on the already-created DB should not throw.
    await lifecycle.ensureDatabase();
    await lifecycle.ensureDatabase();
  });

  it("graceful shutdown stops the Postgres process; no orphan remains (VAL-CONN-007)", async () => {
    const dataDir = makeDataDir();
    const lifecycle = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
    tracked.push({ lifecycle, dataDir });

    await lifecycle.start();
    const port = lifecycle.getPort()!;
    expect(port).toBeGreaterThan(0);

    // Confirm the port is accepting connections before shutdown.
    const probeBefore = postgres(
      `postgresql://postgres:password@localhost:${port}/fusion`,
      { max: 1, connect_timeout: 5 },
    );
    await probeBefore`SELECT 1`;
    await probeBefore.end({ timeout: 5 });

    await lifecycle.stop();
    expect(lifecycle.isRunning()).toBe(false);

    // After shutdown, the port should refuse new connections.
    const probeAfter = postgres(
      `postgresql://postgres:password@localhost:${port}/fusion`,
      { max: 1, connect_timeout: 3 },
    );
    await expect(probeAfter`SELECT 1`).rejects.toThrow();
    await probeAfter.end({ timeout: 5 }).catch(() => {});

    // Remove from tracked cleanup since we already stopped.
    const idx = tracked.findIndex((t) => t.lifecycle === lifecycle);
    if (idx >= 0) tracked.splice(idx, 1);
  });

  it("start reports already-initialized reuse via the log when the dir exists", async () => {
    const dataDir = makeDataDir();
    const reuseLogLines: string[] = [];
    const opts: EmbeddedLifecycleOptions = {
      ...baseOptions(dataDir),
      onLog: (msg) => reuseLogLines.push(msg),
    };

    const first = new EmbeddedPostgresLifecycle(opts);
    await first.start();
    await first.stop();

    reuseLogLines.length = 0;
    const second = new EmbeddedPostgresLifecycle(opts);
    tracked.push({ lifecycle: second, dataDir });
    await second.start();
    expect(
      reuseLogLines.some((l) => /existing data directory/i.test(l)),
    ).toBe(true);
  });
});

describe("embedded-lifecycle: startup timeout (P1 #24)", () => {
  it("EmbeddedStartTimeoutError carries the timeout and data dir", () => {
    const err = new EmbeddedStartTimeoutError(5000, "/tmp/data");
    expect(err.message).toContain("5000ms");
    expect(err.message).toContain("/tmp/data");
    expect(err.timeoutMs).toBe(5000);
    expect(err.dataDir).toBe("/tmp/data");
    expect(err.name).toBe("EmbeddedStartTimeoutError");
  });

  it("DEFAULT_START_TIMEOUT_MS is a positive number (120s default)", () => {
    expect(DEFAULT_START_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(DEFAULT_START_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });

  it("startTimeoutMs option is captured in the constructor (no process needed)", () => {
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir: "/tmp/unused",
      database: "fusion",
      port: 55432,
      user: "postgres",
      password: "password",
      startTimeoutMs: 42,
    });
    // The option is stored; we can't read it directly (private), but the
    // constructor must not throw and the instance is usable.
    expect(lifecycle).toBeDefined();
    expect(lifecycle.isRunning()).toBe(false);
  });
});

describe("embedded-lifecycle: readPortFromPostmasterPid (P1 code-review fix)", () => {
  it("reads the TCP port from line 5 (index 4) of postmaster.pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-pid-"));
    try {
      const { writeFileSync } = require("node:fs");
      // Standard PostgreSQL postmaster.pid format:
      // Line 1: PID
      // Line 2: data directory
      // Line 3: unix socket directory
      // Line 4: listen address
      // Line 5: port number
      // Line 6: shared memory key
      // Line 7: postmaster start timestamp
      writeFileSync(
        join(dir, "postmaster.pid"),
        [
          "12345",
          "/home/user/.fusion/embedded-postgres/default",
          "/tmp",
          "localhost",
          "55432",
          "5432101",
          String(Date.now()),
        ].join("\n") + "\n",
      );

      const port = readPortFromPostmasterPid(dir);
      expect(port).toBe(55432);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the port line is not a valid number", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-pid-"));
    try {
      const { writeFileSync } = require("node:fs");
      writeFileSync(
        join(dir, "postmaster.pid"),
        ["12345", "/data", "/tmp", "localhost", "not-a-port", "5432101"].join("\n") + "\n",
      );
      expect(readPortFromPostmasterPid(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-pid-"));
    try {
      expect(readPortFromPostmasterPid(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT read line 3 (index 2, socket dir) as the port", () => {
    // Regression: the bug read lines[2] (socket dir) which is never the port.
    // If the socket dir happened to contain digits, parseInt would produce
    // a wrong port. This test ensures we skip past it.
    const dir = mkdtempSync(join(tmpdir(), "fusion-embedded-pid-"));
    try {
      const { writeFileSync } = require("node:fs");
      writeFileSync(
        join(dir, "postmaster.pid"),
        ["12345", "/data", "/var/run/postgresql", "localhost", "5433", "5432101"].join("\n") + "\n",
      );
      const port = readPortFromPostmasterPid(dir);
      expect(port).toBe(5433);
      expect(port).not.toBeNaN();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedded-lifecycle: signal re-raise (P1 #23)", () => {
  it("boundShutdown re-raises real signals via process.kill (unit, no process)", async () => {
    // Verify the signal re-raise logic without a real cluster: construct a
    // lifecycle, install the hook, then invoke the handler path directly with
    // a stubbed stop. We assert that process.kill is called with the signal.
    // This is the core of the P1 #23 fix: without re-raising, the process
    // hangs after stop().
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir: "/tmp/unused",
      database: "fusion",
      port: 55432,
      user: "postgres",
      password: "password",
    });
    // Stub the internal pg + running state so stop() is a no-op (we never
    // started a real cluster). The boundShutdown handler checks this.running.
    // We set it true to exercise the stop path, then stub stop to flip it.
    (lifecycle as unknown as { running: boolean }).running = true;
    const killCalls: string[] = [];
    const realKill = process.kill;
    const realExit = process.exit;
    try {
      (process as unknown as { kill: (pid: number, sig?: string | number) => void }).kill = (
        pid: number,
        sig?: string | number,
      ) => {
        if (pid === process.pid && sig) {
          killCalls.push(String(sig));
        }
        // Don't actually kill — just record.
      };
      (process as unknown as { exit: (code?: number) => void }).exit = () => {
        // no-op for test
      };

      // Access the private boundShutdown handler.
      const boundShutdown = (
        lifecycle as unknown as {
          boundShutdown: (signal: NodeJS.Signals | "beforeExit") => Promise<void>;
        }
      ).boundShutdown.bind(lifecycle);

      await boundShutdown("SIGTERM");
      expect(killCalls).toContain("SIGTERM");
    } finally {
      (process as unknown as { kill: typeof realKill }).kill = realKill;
      (process as unknown as { exit: typeof realExit }).exit = realExit;
    }
  });
});
