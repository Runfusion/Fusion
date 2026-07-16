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

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import {
  EmbeddedPostgresLifecycle,
  EmbeddedStartTimeoutError,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_EMBEDDED_POSTGRES_FLAGS,
  isDataDirInitialized,
  isWindowsElevatedAdmin,
  normalizeMacosEmbeddedPostgresDylibSymlinks,
  readPortFromPostmasterPid,
  __setEmbeddedPostgresCtorForTests,
  __setWindowsElevatedAdminForTests,
  __setWindowsEmbeddedPostgresNativeRootForTests,
  __setWindowsLauncherForTests,
  resolveElectronAsarUnpackedPath,
  fingerprintEmbeddedPostgresNativeRoot,
  buildEmbeddedPostgresMaterializationMarker,
  materializeEmbeddedPostgresRuntimeBinaries,
  installElectronAsarNativePathPatch,
  uninstallElectronAsarNativePathPatchForTests,
  type EmbeddedLifecycleOptions,
} from "../../postgres/embedded-lifecycle.js";

const testRequire = createRequire(import.meta.url);

const SKIP = process.env.FUSION_EMBEDDED_TEST_SKIP === "1";
const embeddedDescribe = SKIP ? describe.skip : describe;

/** Track lifecycle instances + temp dirs for teardown to avoid orphaned processes. */
const tracked: Array<{
  lifecycle: EmbeddedPostgresLifecycle;
  dataDir: string;
}> = [];

afterEach(async () => {
  __setEmbeddedPostgresCtorForTests(null);
  __setWindowsElevatedAdminForTests(null);
  __setWindowsEmbeddedPostgresNativeRootForTests(null);
  __setWindowsLauncherForTests(null);
  vi.useRealTimers();
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

describe("embedded-lifecycle: Windows elevation probe (no process)", () => {
  it("isWindowsElevatedAdmin is false on non-Windows platforms", () => {
    // FNXC:WindowsDesktopPackaging 2026-07-15-04:55:
    // The non-admin boot path is Windows-only; other OSes must never claim elevation.
    if (process.platform !== "win32") {
      expect(isWindowsElevatedAdmin()).toBe(false);
    } else {
      expect(typeof isWindowsElevatedAdmin()).toBe("boolean");
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

describe("embedded-lifecycle: Electron asar unpacked path rewrite", () => {
  /*
   * FNXC:DesktopEmbeddedPostgres 2026-07-14-18:30:
   * Packaged desktop resolves platform binaries under app.asar even when
   * asarUnpack places them on disk under app.asar.unpacked. Prove the rewrite
   * prefers the real unpacked file and leaves ordinary paths alone.
   *
   * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
   * Use a non-materialized binary name (`pg_dump`) so these assertions never
   * short-circuit through the user's real ~/.fusion runtime-bin cache (which
   * only applies to postgres/initdb/pg_ctl basenames).
   */
  it("rewrites app.asar binary paths to app.asar.unpacked when present", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-asar-rewrite-"));
    try {
      // pg_dump is intentionally NOT in the materialization BIN_NAMES set.
      const asarBin = join(root, "app.asar", "node_modules", "pkg", "bin", "pg_dump");
      const unpackedBin = join(root, "app.asar.unpacked", "node_modules", "pkg", "bin", "pg_dump");
      mkdirSync(dirname(unpackedBin), { recursive: true });
      writeFileSync(unpackedBin, "");
      expect(resolveElectronAsarUnpackedPath(asarBin)).toBe(unpackedBin);
      expect(resolveElectronAsarUnpackedPath(unpackedBin)).toBe(unpackedBin);
      expect(resolveElectronAsarUnpackedPath(join(root, "plain", "pg_dump"))).toBe(
        join(root, "plain", "pg_dump"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the asar path when no unpacked twin exists", () => {
    const asarOnly = join(tmpdir(), "app.asar", "missing", "pg_dump");
    expect(resolveElectronAsarUnpackedPath(asarOnly)).toBe(asarOnly);
  });

  it("patched spawn/stat/chmod receive rewritten asar paths without real processes", async () => {
    /*
     * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
     * Surface enumeration: exercise the production patch entry points (CJS
     * child_process.spawn + fs.promises.stat/chmod), not only the pure path
     * resolver. Install a recording bottom layer, then the production patch on
     * top, and assert rewritten paths without launching Postgres.
     */
    const root = mkdtempSync(join(tmpdir(), "fusion-asar-patch-"));
    const childProcessMod = testRequire("child_process") as {
      spawn: (...args: unknown[]) => unknown;
    };
    const fsPromisesMod = testRequire("fs/promises") as {
      stat: (...args: unknown[]) => unknown;
      chmod: (...args: unknown[]) => unknown;
    };
    // Undo any prior production patch so we can install fakes as the bottom layer.
    uninstallElectronAsarNativePathPatchForTests();
    const prevSpawn = childProcessMod.spawn;
    const prevStat = fsPromisesMod.stat;
    const prevChmod = fsPromisesMod.chmod;
    const spawnSeen: unknown[] = [];
    const statSeen: unknown[] = [];
    const chmodSeen: unknown[] = [];
    try {
      const asarBin = join(root, "app.asar", "node_modules", "pkg", "bin", "pg_dump");
      const unpackedBin = join(
        root,
        "app.asar.unpacked",
        "node_modules",
        "pkg",
        "bin",
        "pg_dump",
      );
      mkdirSync(dirname(unpackedBin), { recursive: true });
      writeFileSync(unpackedBin, "fake-bin");
      const plainPath = join(root, "plain", "pg_dump");

      // Bottom-layer fakes record the command/path the production patch forwards.
      childProcessMod.spawn = (command: unknown, ..._rest: unknown[]) => {
        spawnSeen.push(command);
        return {
          pid: 0,
          on: () => undefined,
          kill: () => true,
          stdout: null,
          stderr: null,
        };
      };
      fsPromisesMod.stat = async (p: unknown, ..._rest: unknown[]) => {
        statSeen.push(p);
        return { mode: 0o755, isFile: () => true };
      };
      fsPromisesMod.chmod = async (p: unknown, ..._rest: unknown[]) => {
        chmodSeen.push(p);
      };

      installElectronAsarNativePathPatch();

      childProcessMod.spawn(asarBin);
      childProcessMod.spawn(plainPath);
      await fsPromisesMod.stat(asarBin);
      await fsPromisesMod.stat(plainPath);
      await fsPromisesMod.chmod(asarBin, 0o755);
      await fsPromisesMod.chmod(plainPath, 0o755);

      expect(spawnSeen).toEqual([unpackedBin, plainPath]);
      expect(statSeen).toEqual([unpackedBin, plainPath]);
      expect(chmodSeen).toEqual([unpackedBin, plainPath]);
    } finally {
      // Restore production patch wrapper first (back to fakes), then real builtins.
      uninstallElectronAsarNativePathPatchForTests();
      childProcessMod.spawn = prevSpawn;
      fsPromisesMod.stat = prevStat;
      fsPromisesMod.chmod = prevChmod;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("embedded-lifecycle: materialize runtime binaries (update-safe marker)", () => {
  /*
   * FNXC:DesktopEmbeddedPostgres 2026-07-15-02:55:
   * Greptile P1 security: path-only `.materialized-from` markers reuse stale
   * Postgres binaries after an in-place packaged app update (nativeRoot path is
   * stable). Marker must include a content fingerprint so payload changes force
   * a re-copy of the host-local runtime-bin cache.
   *
   * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
   * Fingerprint now content-hashes lib/ + share/ (not path+size only) so
   * same-size library/support-file patches invalidate the cache.
   */
  const postgresBin = process.platform === "win32" ? "postgres.exe" : "postgres";
  const initdbBin = process.platform === "win32" ? "initdb.exe" : "initdb";
  const pgCtlBin = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";

  function seedNativeRoot(root: string, postgresBody: string): void {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib", "postgresql"), { recursive: true });
    mkdirSync(join(root, "share", "postgresql"), { recursive: true });
    writeFileSync(join(root, "bin", postgresBin), postgresBody);
    writeFileSync(join(root, "bin", initdbBin), "initdb-stub");
    writeFileSync(join(root, "bin", pgCtlBin), "pg_ctl-stub");
    writeFileSync(join(root, "lib", "postgresql", "plpgsql.so"), "ext-v1");
    writeFileSync(join(root, "share", "postgresql", "postgres.bki"), "share-v1");
  }

  it("fingerprint changes when binary contents change at the same path", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-fp-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-v1");
      const first = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      writeFileSync(join(nativeRoot, "bin", postgresBin), "postgres-v2-updated-payload");
      const second = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      expect(first).not.toBe(second);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("fingerprint changes when a library payload changes without bin renames", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-fp-lib-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-stable");
      const first = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      // Same name and size, different contents — must invalidate (content hash).
      writeFileSync(join(nativeRoot, "lib", "postgresql", "plpgsql.so"), "ext-v2");
      const second = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      expect(first).not.toBe(second);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("fingerprint changes when share support files change without bin renames", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-fp-share-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-stable");
      const first = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      // share/ is copied into runtime-bin and must participate in the fingerprint.
      writeFileSync(join(nativeRoot, "share", "postgresql", "postgres.bki"), "share-v2");
      const second = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      expect(first).not.toBe(second);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("same-size library content change forces rematerialization", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-samesize-"));
    const destRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-samesize-dst-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-stable");
      materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });
      expect(readFileSync(join(destRoot, "lib", "postgresql", "plpgsql.so"), "utf8")).toBe(
        "ext-v1",
      );

      // Equal-length security patch at the same path (in-place app update).
      writeFileSync(join(nativeRoot, "lib", "postgresql", "plpgsql.so"), "ext-v2");
      materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });
      expect(readFileSync(join(destRoot, "lib", "postgresql", "plpgsql.so"), "utf8")).toBe(
        "ext-v2",
      );
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
      rmSync(destRoot, { recursive: true, force: true });
    }
  });

  it("buildEmbeddedPostgresMaterializationMarker includes path + fingerprint", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-marker-build-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-body");
      const marker = buildEmbeddedPostgresMaterializationMarker(nativeRoot);
      const fingerprint = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
      expect(marker.startsWith("v2\n")).toBe(true);
      expect(marker).toContain(nativeRoot);
      expect(marker).toContain(fingerprint);
      // Path alone must not equal the full marker (legacy path-only markers rematerialize).
      expect(marker.trim()).not.toBe(nativeRoot);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("skips re-copy when marker + fingerprint still match (idempotent)", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-src-"));
    const destRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-dst-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-stable");
      // First materialization.
      materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });
      const markerPath = join(destRoot, ".materialized-from");
      const markerAfterFirst = readFileSync(markerPath, "utf8");
      const destPostgres = join(destRoot, "bin", postgresBin);
      expect(readFileSync(destPostgres, "utf8")).toBe("postgres-stable");
      // Destination-only sentinel: an always-recopy implementation would wipe it.
      const reuseSentinel = join(destRoot, ".reuse-sentinel");
      writeFileSync(reuseSentinel, "preserve");

      // Second call must reuse (same path + same fingerprint) without error.
      const returned = materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });
      expect(returned).toBe(destRoot);
      expect(readFileSync(reuseSentinel, "utf8")).toBe("preserve");
      expect(readFileSync(markerPath, "utf8")).toBe(markerAfterFirst);
      expect(readFileSync(destPostgres, "utf8")).toBe("postgres-stable");
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
      rmSync(destRoot, { recursive: true, force: true });
    }
  });

  it("re-copies when payload changes even though nativeRoot path is unchanged", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-update-"));
    const destRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-update-dst-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-release-1");
      materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });
      expect(readFileSync(join(destRoot, "bin", postgresBin), "utf8")).toBe("postgres-release-1");
      // Leave a stale orphan that force-copy alone would not remove.
      writeFileSync(join(destRoot, "bin", "orphan-from-old-release"), "stale");

      // Simulate in-place app update: same nativeRoot path, new binary payload.
      writeFileSync(join(nativeRoot, "bin", postgresBin), "postgres-release-2");
      materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });

      expect(readFileSync(join(destRoot, "bin", postgresBin), "utf8")).toBe("postgres-release-2");
      // Rematerialization clears dest first so orphans from prior releases do not linger.
      expect(existsSync(join(destRoot, "bin", "orphan-from-old-release"))).toBe(false);
      expect(readFileSync(join(destRoot, ".materialized-from"), "utf8")).toBe(
        buildEmbeddedPostgresMaterializationMarker(nativeRoot),
      );
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
      rmSync(destRoot, { recursive: true, force: true });
    }
  });

  it("treats legacy path-only markers as stale and rematerializes", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-legacy-"));
    const destRoot = mkdtempSync(join(tmpdir(), "fusion-embedded-mat-legacy-dst-"));
    try {
      seedNativeRoot(nativeRoot, "postgres-current");
      // Seed dest as if an older build wrote path-only markers.
      mkdirSync(join(destRoot, "bin"), { recursive: true });
      mkdirSync(join(destRoot, "lib", "postgresql"), { recursive: true });
      writeFileSync(join(destRoot, "bin", postgresBin), "postgres-stale-legacy");
      writeFileSync(join(destRoot, "lib", "postgresql", "plpgsql.so"), "old");
      writeFileSync(join(destRoot, ".materialized-from"), nativeRoot);

      materializeEmbeddedPostgresRuntimeBinaries(nativeRoot, { destRoot });
      expect(readFileSync(join(destRoot, "bin", postgresBin), "utf8")).toBe("postgres-current");
      expect(readFileSync(join(destRoot, ".materialized-from"), "utf8")).toBe(
        buildEmbeddedPostgresMaterializationMarker(nativeRoot),
      );
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
      rmSync(destRoot, { recursive: true, force: true });
    }
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

/*
 * FNXC:WindowsDesktopPackaging 2026-07-15-04:55:
 * Package default testTimeout is 15s (packages/core/vitest.config.ts). On
 * elevated Windows (GitHub windows-latest = runneradmin) the non-admin boot
 * path + initdb regularly takes 60–90s before "ready to accept connections".
 * The lifecycle startTimeout is 120s; the vitest wrapper must not kill earlier
 * or CI reports false timeouts while postgres is still healthy (and orphans the
 * non-admin postmaster). Use a per-test budget that covers elevated CI.
 *
 * FNXC:WindowsDesktopPackaging 2026-07-14-23:10:
 * Double-start tests (VAL-CONN-006 reuse, already-initialized log) need room
 * for two elevated boots. A 180s wall was tight: first start ~90s left the
 * second start racing the vitest budget, which timed out mid-readiness and
 * left EBUSY orphans on the data dir. 6 minutes covers 2×120s startTimeout
 * plus stop/teardown margin under loaded windows-latest runners.
 */
const REAL_PROCESS_TEST_TIMEOUT_MS = process.platform === "win32" ? 360_000 : 60_000;

embeddedDescribe("embedded-lifecycle: real process (VAL-CONN-001, VAL-CONN-006, VAL-CONN-007)", () => {
  it(
    "first start runs initdb, ensures DB exists, and serves traffic (VAL-CONN-001)",
    async () => {
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
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "second start reuses the existing data directory without re-initdb (VAL-CONN-006)",
    async () => {
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
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "ensureDatabase is idempotent: re-starting and ensuring the same DB does not error",
    async () => {
      const dataDir = makeDataDir();
      const lifecycle = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
      tracked.push({ lifecycle, dataDir });

      await lifecycle.start();
      // Calling ensureDatabase again on the already-created DB should not throw.
      await lifecycle.ensureDatabase();
      await lifecycle.ensureDatabase();
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  /*
  FNXC:PostgresStartupRace 2026-07-15-20:45:
  The owner creates the database only after its own start() resolves, but a joiner detects the
  instance earlier (registry entry, then postmaster.pid — written by postgres itself). A joiner
  landing in that window used to hand back a URL to a database that did not exist yet. Dropping
  the database from a started cluster reproduces exactly that state: postmaster up and
  published, database absent.
  */
  it(
    "a joining lifecycle creates the database when the owner has not yet",
    async () => {
      const dataDir = makeDataDir();
      const owner = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
      tracked.push({ lifecycle: owner, dataDir });
      await owner.start();
      const port = owner.getPort()!;

      const openAdmin = () =>
        postgres({
          host: "localhost",
          port,
          user: "postgres",
          password: "password",
          database: "postgres",
          max: 1,
          connect_timeout: 10,
        });

      // Rewind to the race window: cluster running, database not yet created.
      const admin = openAdmin();
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "fusion"`);
      } finally {
        await admin.end({ timeout: 5 });
      }

      const joiner = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
      const resolved = await joiner.start();

      // It joined rather than starting its own postmaster...
      expect(joiner.isRunning()).toBe(false);
      expect(resolved.runtimeUrl).toContain(`:${port}/`);

      // ...and did not hand back a URL to a database that does not exist.
      const check = openAdmin();
      try {
        const rows = await check`SELECT 1 AS one FROM pg_database WHERE datname = 'fusion'`;
        expect(rows.length).toBe(1);
      } finally {
        await check.end({ timeout: 5 });
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  /* FNXC:PostgresStartupRace 2026-07-15-20:45: both the owner's ensureDatabase and the join
     path create the database, so a concurrent CREATE must resolve as success (42P04), not throw.
     Racing them against one cluster is the only honest way to exercise that tolerance. */
  it(
    "concurrent ensureDatabase calls tolerate a duplicate-database race",
    async () => {
      const dataDir = makeDataDir();
      const lifecycle = new EmbeddedPostgresLifecycle(baseOptions(dataDir));
      tracked.push({ lifecycle, dataDir });
      await lifecycle.start();
      const port = lifecycle.getPort()!;

      const admin = postgres({
        host: "localhost",
        port,
        user: "postgres",
        password: "password",
        database: "postgres",
        max: 1,
        connect_timeout: 10,
      });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "fusion"`);
      } finally {
        await admin.end({ timeout: 5 });
      }

      // Both see "missing" and both issue CREATE DATABASE; one must lose and survive it.
      await expect(
        Promise.all([lifecycle.ensureDatabase(), lifecycle.ensureDatabase()]),
      ).resolves.toBeDefined();
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "graceful shutdown stops the Postgres process; no orphan remains (VAL-CONN-007)",
    async () => {
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
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "start reports already-initialized reuse via the log when the dir exists",
    async () => {
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
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});

/*
FNXC:PostgresStartupRace 2026-07-15-17:05:
The cross-process startup-race coverage uses a mocked EmbeddedPostgres ctor (no real
Postgres), so it must live OUTSIDE the real-process `embeddedDescribe` block. Nesting it
there made it skip under FUSION_EMBEDDED_TEST_SKIP=1 (the gate/CI default), silently
leaving the join-the-competing-postmaster fix unprotected. A regular `describe` keeps it
fast (~6ms) and always-on.
*/
describe("embedded-lifecycle: startup race (cross-process)", () => {
  it("joins the competing postmaster when startup loses a cross-process race", async () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
    const logLines: string[] = [];

    class RacingEmbeddedPostgres {
      initialise = vi.fn(async () => {});
      async start() {
        writeFileSync(
          join(dataDir, "postmaster.pid"),
          ["12345", dataDir, "/tmp", "localhost", "55440", "5432101", String(Date.now())].join("\n") + "\n",
        );
        throw new Error('lock file "postmaster.pid" already exists');
      }
      stop = vi.fn(async () => {});
    }

    __setEmbeddedPostgresCtorForTests(RacingEmbeddedPostgres as never);
    try {
      const lifecycle = new EmbeddedPostgresLifecycle({
        ...baseOptions(dataDir),
        port: 55439,
        onLog: (message) => logLines.push(message),
      });

      await expect(lifecycle.start()).resolves.toMatchObject({
        mode: "embedded",
        runtimeUrl: expect.stringContaining(":55440/"),
      });
      expect(lifecycle.isRunning()).toBe(false);
      expect(logLines.some((line) => /startup raced with an existing instance/i.test(line))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/*
FNXC:PostgresStartupRace 2026-07-15-20:45:
Mocked ctor, no real Postgres — kept outside the real-process block so it runs under the
gate/CI default (see the sibling startup-race block for why that placement matters).

Pins the best-effort half of the join-path database verify: `isAlreadyRunning` joins
optimistically without probing (a stale pid file from a crash still resolves to a port), so an
unreachable joined instance must return the URL exactly as it did before the verify existed and
let the connection layer report it. A hard throw here would turn every stale-pid start into a
startup failure.
*/
/*
FNXC:PostgresStartupRace 2026-07-15-21:10:
The startup-race join must fire only on a lock collision. Joining on ANY failure meant a start
that took the lock and then failed later read back its own postmaster.pid, "joined itself" with
ownsProcess=false, and orphaned a live postmaster nothing would stop. Mocked ctor, no real
Postgres, outside the real-process block so it runs under the gate/CI default.
*/
describe("embedded-lifecycle: startup race only joins on a lock collision", () => {
  it("propagates a non-lock startup failure even when a postmaster.pid is present", async () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "PG_VERSION"), "15\n");

    class FailingEmbeddedPostgres {
      initialise = vi.fn(async () => {});
      async start() {
        // A postmaster.pid exists (ours, or a racer's) but the failure is NOT a lock collision.
        writeFileSync(
          join(dataDir, "postmaster.pid"),
          ["12345", dataDir, "/tmp", "localhost", "55442", "5432101", String(Date.now())].join("\n") + "\n",
        );
        throw new Error("could not start postgres: readiness poll timed out");
      }
      stop = vi.fn(async () => {});
    }

    __setEmbeddedPostgresCtorForTests(FailingEmbeddedPostgres as never);
    try {
      const lifecycle = new EmbeddedPostgresLifecycle({ ...baseOptions(dataDir), port: 55443 });

      await expect(lifecycle.start()).rejects.toThrow(/readiness poll timed out/i);
      expect(lifecycle.isRunning()).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("still joins on a lock collision", async () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "PG_VERSION"), "15\n");

    class RacingEmbeddedPostgres {
      initialise = vi.fn(async () => {});
      async start() {
        writeFileSync(
          join(dataDir, "postmaster.pid"),
          ["12345", dataDir, "/tmp", "localhost", "55444", "5432101", String(Date.now())].join("\n") + "\n",
        );
        throw new Error('lock file "postmaster.pid" already exists');
      }
      stop = vi.fn(async () => {});
    }

    __setEmbeddedPostgresCtorForTests(RacingEmbeddedPostgres as never);
    try {
      const lifecycle = new EmbeddedPostgresLifecycle({ ...baseOptions(dataDir), port: 55445 });

      await expect(lifecycle.start()).resolves.toMatchObject({
        runtimeUrl: expect.stringContaining(":55444/"),
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("embedded-lifecycle: join-path database verify is best-effort", () => {
  it("still resolves optimistically when the joined instance is unreachable", async () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
    // A port nothing is listening on: the verify's probe cannot succeed.
    writeFileSync(
      join(dataDir, "postmaster.pid"),
      ["12345", dataDir, "/tmp", "localhost", "55441", "5432101", String(Date.now())].join("\n") + "\n",
    );
    const logLines: string[] = [];

    try {
      const lifecycle = new EmbeddedPostgresLifecycle({
        ...baseOptions(dataDir),
        onLog: (message) => logLines.push(message),
      });

      await expect(lifecycle.start()).resolves.toMatchObject({
        mode: "embedded",
        runtimeUrl: expect.stringContaining(":55441/"),
      });
      expect(lifecycle.isRunning()).toBe(false);
      expect(logLines.some((line) => /could not verify database/i.test(line))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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

  it("cancels a delayed postmaster start without publishing hooks or a running instance", async () => {
    vi.useFakeTimers();
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
    let releaseStart!: () => void;
    const delayedStart = new Promise<void>((resolve) => { releaseStart = resolve; });
    let resolveLateStop!: () => void;
    const lateStop = new Promise<void>((resolve) => { resolveLateStop = resolve; });
    const running = { value: false };
    const stop = vi.fn(async () => {
      running.value = false;
      if (stop.mock.calls.length === 2) resolveLateStop();
    });

    class DelayedEmbeddedPostgres {
      initialise = vi.fn(async () => {});
      async start() {
        await delayedStart;
        running.value = true;
      }
      stop = stop;
      createDatabase = vi.fn(async () => {});
      getPgClient() {
        return {
          connect: vi.fn(async () => {}),
          query: vi.fn(() => ({ rowCount: 1 })),
          end: vi.fn(async () => {}),
        };
      }
    }

    __setEmbeddedPostgresCtorForTests(DelayedEmbeddedPostgres as never);
    const beforeExitListeners = process.listenerCount("beforeExit");
    const lifecycle = new EmbeddedPostgresLifecycle({
      ...baseOptions(dataDir),
      port: 55439,
      startTimeoutMs: 25,
    });

    const start = lifecycle.start();
    const timeoutRejection = expect(start).rejects.toBeInstanceOf(EmbeddedStartTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await timeoutRejection;
    expect(running.value).toBe(false);

    releaseStart();
    await lateStop;

    expect(stop).toHaveBeenCalledTimes(2);
    expect(running.value).toBe(false);
    expect(lifecycle.isRunning()).toBe(false);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    rmSync(dataDir, { recursive: true, force: true });
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

/*
 * FNXC:PostgresEmbedded 2026-07-16-12:45:
 * Assert the shared-memory floor at the lifecycle boundary, which is used by
 * both startup-factory boot and direct lifecycle callers. Mock starts reject
 * before database work so these tests stay deterministic and process-free.
 */
describe("embedded-lifecycle: shared-memory-safe postgres flags", () => {
  const sentinel = new Error("mock postgres start complete");

  function installCtorRecorder(records: Record<string, unknown>[]): void {
    class RecordingEmbeddedPostgres {
      constructor(options: Record<string, unknown>) {
        records.push(options);
      }
      initialise = vi.fn(async () => {});
      async start() {
        throw sentinel;
      }
      stop = vi.fn(async () => {});
    }
    __setEmbeddedPostgresCtorForTests(RecordingEmbeddedPostgres as never);
  }

  it.each([
    ["omitted", undefined, [...DEFAULT_EMBEDDED_POSTGRES_FLAGS]],
    ["empty", [], [...DEFAULT_EMBEDDED_POSTGRES_FLAGS]],
    [
      "caller override after the default",
      ["-c", "shared_memory_type=sysv"],
      [...DEFAULT_EMBEDDED_POSTGRES_FLAGS, "-c", "shared_memory_type=sysv"],
    ],
  ])("passes %s flags to the normal embedded-postgres constructor", async (_state, postgresFlags, expected) => {
    const dataDir = makeDataDir();
    const records: Record<string, unknown>[] = [];
    installCtorRecorder(records);
    try {
      writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
      const lifecycle = new EmbeddedPostgresLifecycle({ ...baseOptions(dataDir), postgresFlags });

      await expect(lifecycle.start()).rejects.toBe(sentinel);
      expect(records).toHaveLength(1);
      expect(records[0]?.postgresFlags).toEqual(expected);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("passes the ordered defaults and caller override through the elevated Windows launcher", async () => {
    const dataDir = makeDataDir();
    const records: Record<string, unknown>[] = [];
    const launcherSentinel = new Error("mock Windows launcher reached");
    let launcherOptions: Record<string, unknown> | undefined;
    installCtorRecorder(records);
    __setWindowsElevatedAdminForTests(true);
    __setWindowsEmbeddedPostgresNativeRootForTests("/test/embedded-postgres/native");
    __setWindowsLauncherForTests(async (options) => {
      launcherOptions = options;
      throw launcherSentinel;
    });

    try {
      // Reuse skips real initdb; the sentinel rejects before ensureDatabase.
      writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
      const lifecycle = new EmbeddedPostgresLifecycle({
        ...baseOptions(dataDir),
        postgresFlags: ["-c", "shared_memory_type=sysv"],
      });

      await expect(lifecycle.start()).rejects.toBe(launcherSentinel);
      expect(records).toHaveLength(1);
      expect(launcherOptions?.postgresFlags).toEqual([
        ...DEFAULT_EMBEDDED_POSTGRES_FLAGS,
        "-c",
        "shared_memory_type=sysv",
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
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
