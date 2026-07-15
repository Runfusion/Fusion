/**
 * Embedded PostgreSQL lifecycle manager (U2).
 *
 * FNXC:PostgresEmbedded 2026-06-24-09:05:
 * Manages a bundled embedded PostgreSQL process over a local data directory so
 * the full Fusion package works with zero system Postgres install when
 * DATABASE_URL is unset (the zero-config default, mirroring SQLite today).
 *
 * Lifecycle:
 *   1. `start()` — allocates a free port (if none configured), runs `initdb`
 *      ONLY when the data directory is not yet initialized (PG_VERSION absent),
 *      starts the postgres process, and ensures the application database
 *      exists (idempotent). Returns a `ResolvedBackend` (embedded mode) with the
 *      connection URL so the connection layer (U1) can build the Drizzle pool.
 *   2. `stop()` — stops the postgres process via SIGINT (pg_ctl semantics) so
 *      no orphaned process remains (VAL-CONN-007).
 *   3. A process-exit shutdown hook is registered automatically so SIGTERM /
 *      SIGINT cleanly stop the embedded process even if the caller forgets.
 *
 * Idempotency notes (critical for VAL-CONN-006 — data persists across restarts):
 *   - `embedded-postgres`'s `.initialise()` ALWAYS runs `initdb`, which FAILS if
 *     the data directory already exists ("directory exists but is not empty").
 *     This manager guards `initialise()` behind a `PG_VERSION` existence check so
 *     a second start reuses the existing cluster without re-initializing.
 *   - `embedded-postgres`'s `.createDatabase()` issues a raw `CREATE DATABASE`
 *     which errors if the DB exists. This manager queries `pg_database` first and
 *     only creates when missing, so re-starts are safe.
 *
 * Credential safety:
 *   - The connection URL contains the password (needed to connect). It is never
 *     logged; `getRedactedConnectionUrl()` provides a log-safe variant.
 *   - The `onLog`/`onError` callbacks are the only logging surfaces; callers
 *     must not embed credentials in log messages.
 */

// FNXC:RuntimeStartupWiring 2026-06-24-11:10:
// `embedded-postgres` is loaded LAZILY (not via a top-level static import) so
// that bundlers (tsup/esbuild with splitting:false) do not pull it — and its
// platform-specific optional binary dynamic imports — into the main bundle
// chunk. A top-level `import EmbeddedPostgres from "embedded-postgres"` would
// execute at module load, breaking the CLI bundle / boot smoke on platforms
// whose optional binary is absent. The lazy load via createRequire defers
// resolution to the first `start()` call, which only happens in embedded mode
// (DATABASE_URL unset AND FUSION_NO_EMBEDDED_PG not set — the default since
// the flip-embedded-pg-default change; the runtime startup factory is the
// sole caller and it dynamically imports this module only in that case).
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { createServer, type Server } from "node:net";
import { dirname, join, basename, sep } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createLogger } from "../logger.js";
import { redactConnectionString } from "./credential-redact.js";
import type { ResolvedBackend } from "./backend-resolver.js";

const require = createRequire(import.meta.url);

const EMBEDDED_PG_BIN_NAMES = new Set([
  "postgres",
  "initdb",
  "pg_ctl",
  "postgres.exe",
  "initdb.exe",
  "pg_ctl.exe",
]);

/*
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
 * Bump when the marker payload shape or fingerprint algorithm changes so older
 * host-local caches always rematerialize after a desktop update that ships a
 * new fingerprinting strategy (e.g. content-hashing lib/share, not path+size).
 */
const MATERIALIZATION_MARKER_VERSION = 2;

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-14-18:30:
 * Electron packages app code into app.asar. Platform package entrypoints resolve
 * native binary paths via import.meta.url, so paths look like
 * `.../app.asar/node_modules/@embedded-postgres/.../native/bin/postgres` even when
 * asarUnpack places the real files under `app.asar.unpacked/...`.
 * Node's spawn/chmod against the asar virtual path fail with ENOTDIR; rewrite to
 * the unpacked real path when that file exists. No-op outside Electron asar trees.
 */
export function resolveElectronAsarUnpackedPath(filePath: string): string {
  if (!filePath) return filePath;
  // Prefer a materialized runtime-bin path when we already copied binaries out of asar.
  const materialized = resolveMaterializedEmbeddedPostgresBinary(filePath);
  if (materialized) return materialized;
  if (filePath.includes(`${sep}app.asar.unpacked${sep}`)) {
    return filePath;
  }
  const marker = `${sep}app.asar${sep}`;
  const index = filePath.indexOf(marker);
  if (index === -1) return filePath;
  const unpacked =
    filePath.slice(0, index) +
    `${sep}app.asar.unpacked${sep}` +
    filePath.slice(index + marker.length);
  return existsSync(unpacked) ? unpacked : filePath;
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-14-18:45:
 * Host-local copy of packaged embedded Postgres binaries. Electron can still treat
 * paths that contain the `app.asar` substring oddly at spawn time on some hosts;
 * materializing into ~/.fusion avoids asar virtual-path issues entirely.
 */
export function embeddedPostgresRuntimeBinRoot(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  home: string = homedir(),
): string {
  return join(home, ".fusion", "embedded-postgres", "runtime-bin", `${platform}-${arch}`);
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-02:55:
 * Content-aware fingerprint of a packaged native root. Packaged in-place updates
 * keep `nativeRoot` path stable (same app.asar.unpacked layout) while replacing
 * postgres binaries and libraries; path-only markers would reuse stale payload.
 * Fingerprint mixes binary content hashes + sizes so both binary and library-only
 * payload changes invalidate the host-local materialization cache.
 *
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
 * Greptile P1: path+size for lib files missed same-size content patches, and
 * share/ was copied into runtime-bin but omitted from the fingerprint. Hash full
 * file contents under bin/ + lib/ + share/ so any payload byte change forces
 * rematerialization after an in-place app update.
 */
export function fingerprintEmbeddedPostgresNativeRoot(nativeRoot: string): string {
  const hash = createHash("sha256");
  const binNames =
    process.platform === "win32"
      ? (["postgres.exe", "initdb.exe", "pg_ctl.exe"] as const)
      : (["postgres", "initdb", "pg_ctl"] as const);
  for (const name of binNames) {
    const path = join(nativeRoot, "bin", name);
    hash.update(name);
    hash.update("\0");
    try {
      const st = statSync(path);
      hash.update(String(st.size));
      hash.update("\0");
      // Full content hash of each critical binary (sizes are small enough for startup).
      hash.update(readFileSync(path));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  // Full content walk of every tree that materialize() copies (lib + share).
  // Budget bounds pathological trees; real embedded-postgres installs are well under it.
  const budget = { remaining: 4096 };
  for (const tree of ["lib", "share"] as const) {
    const treeDir = join(nativeRoot, tree);
    hash.update(`tree:${tree}\0`);
    if (existsSync(treeDir)) {
      try {
        hashPayloadTreeContents(treeDir, tree, hash, budget);
      } catch {
        hash.update(`${tree}-unreadable`);
      }
    } else {
      hash.update(`${tree}-missing`);
    }
  }
  return hash.digest("hex");
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
 * Recursive content fingerprint for a payload subtree (lib/ or share/). Records
 * relative path + full file bytes so same-size security patches invalidate the
 * materialization marker. Directory entries are structural markers only.
 */
function hashPayloadTreeContents(
  absDir: string,
  relPrefix: string,
  hash: ReturnType<typeof createHash>,
  budget: { remaining: number },
): void {
  if (budget.remaining <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(absDir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    const abs = join(absDir, entry);
    const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
    try {
      // lstat so macOS dylib compatibility symlinks are fingerprinted by target
      // name (not followed) and same-size file content patches still hash bytes.
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        budget.remaining -= 1;
        hash.update(`l:${rel}:`);
        try {
          hash.update(readlinkSync(abs));
        } catch {
          hash.update("?");
        }
        hash.update("\0");
      } else if (st.isDirectory()) {
        hash.update(`d:${rel}\0`);
        hashPayloadTreeContents(abs, rel, hash, budget);
      } else if (st.isFile()) {
        budget.remaining -= 1;
        hash.update(`f:${rel}\0`);
        try {
          hash.update(readFileSync(abs));
        } catch {
          hash.update("unreadable");
        }
        hash.update("\0");
      }
    } catch {
      hash.update(`?:${rel}\0`);
    }
  }
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-02:55:
 * Materialization cache marker. Must change whenever either the source path OR
 * the native payload changes so in-place app updates re-copy fresh Postgres
 * binaries instead of reusing the previous release's host-local cache.
 * Legacy path-only markers fail equality and force rematerialization.
 */
export function buildEmbeddedPostgresMaterializationMarker(nativeRoot: string): string {
  const fingerprint = fingerprintEmbeddedPostgresNativeRoot(nativeRoot);
  return `v${MATERIALIZATION_MARKER_VERSION}\n${nativeRoot}\n${fingerprint}\n`;
}

function resolveMaterializedEmbeddedPostgresBinary(filePath: string): string | null {
  const name = basename(filePath);
  if (!EMBEDDED_PG_BIN_NAMES.has(name)) return null;
  if (!filePath.includes(`${sep}app.asar`)) return null;
  const candidate = join(embeddedPostgresRuntimeBinRoot(), "bin", name);
  return existsSync(candidate) ? candidate : null;
}

export interface MaterializeEmbeddedPostgresOptions {
  /**
   * Override the host-local dest root (tests). Defaults to
   * `~/.fusion/embedded-postgres/runtime-bin/<platform>-<arch>`.
   */
  readonly destRoot?: string;
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-14-18:45:
 * Copy initdb/pg_ctl/postgres (+ lib tree for dyld/@loader_path) from the packaged
 * native root into ~/.fusion so spawn never has to execute out of app.asar*.
 * Idempotent: skips when marker + binaries already exist.
 *
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-02:55:
 * Marker identity includes a content fingerprint of the source native root, not
 * only the path. Packaged app updates leave nativeRoot paths unchanged; without
 * the fingerprint this guard would keep serving the previous release's binaries
 * and libraries and bundled PostgreSQL fixes would never take effect.
 */
export function materializeEmbeddedPostgresRuntimeBinaries(
  nativeRoot: string,
  options?: MaterializeEmbeddedPostgresOptions,
): string {
  /*
   * FNXC:DesktopEmbeddedPostgres 2026-07-14-18:55:
   * Postgres expects a full install layout next to the binaries: bin/, lib/
   * (including lib/postgresql extension modules), and share/postgresql.
   * A shallow bin-only copy fails at start with "could not open directory
   * .../lib/postgresql". Copy the entire native root recursively.
   */
  const destRoot = options?.destRoot ?? embeddedPostgresRuntimeBinRoot();
  const destBin = join(destRoot, "bin");
  const marker = join(destRoot, ".materialized-from");
  const sourceMarker = buildEmbeddedPostgresMaterializationMarker(nativeRoot);
  if (
    existsSync(marker) &&
    readFileSync(marker, "utf8") === sourceMarker &&
    existsSync(join(destBin, process.platform === "win32" ? "postgres.exe" : "postgres")) &&
    existsSync(join(destRoot, "lib", "postgresql"))
  ) {
    return destRoot;
  }

  /*
   * FNXC:DesktopEmbeddedPostgres 2026-07-15-02:55:
   * Clear the previous materialization before re-copy so files removed in a newer
   * payload cannot linger beside the updated binaries (force-copy alone does not
   * delete orphans).
   */
  if (existsSync(destRoot)) {
    rmSync(destRoot, { recursive: true, force: true });
  }
  mkdirSync(destRoot, { recursive: true });
  // Recursive copy of bin/lib/share (and any other native install dirs).
  for (const entry of readdirSync(nativeRoot)) {
    const from = join(nativeRoot, entry);
    const to = join(destRoot, entry);
    cpSync(from, to, { recursive: true, force: true });
  }
  // Ensure executables keep +x after asar materialization.
  if (existsSync(destBin)) {
    for (const name of readdirSync(destBin)) {
      try {
        chmodSync(join(destBin, name), 0o755);
      } catch {
        // best-effort
      }
    }
  }
  // Re-apply macOS ABI compatibility links against the materialized lib dir.
  normalizeMacosEmbeddedPostgresDylibSymlinks(destRoot);
  writeFileSync(marker, sourceMarker, "utf8");
  return destRoot;
}

let electronAsarNativePathPatchInstalled = false;
/** Restores the pre-patch CJS/ESM builtins; used by unit tests only. */
let electronAsarNativePathPatchRestore: (() => void) | null = null;

type MutableSpawnModule = {
  spawn: (...args: unknown[]) => unknown;
};
type MutableFsPromisesModule = {
  stat: (...args: unknown[]) => unknown;
  chmod: (...args: unknown[]) => unknown;
};

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-14-18:30:
 * Install once before constructing embedded-postgres. That library calls
 * fs.promises.stat/chmod and child_process.spawn on binary paths derived from
 * asar module URLs; without this patch, packaged desktop local mode cannot boot
 * Postgres (ENOTDIR).
 *
 * Mutate the CJS exports objects (`require("child_process")` / `require("fs/promises")`)
 * rather than the frozen ESM namespace (`import * as ...`).
 *
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
 * Replacing CJS export properties does NOT automatically update already-resolved
 * ESM named imports of the same builtins — they keep the pre-patch function until
 * `syncBuiltinESMExports()` runs. Call it after every CJS mutation so ESM importers
 * of child_process/fs.promises (including embedded-postgres) observe the rewrite.
 * Safe outside Electron — rewrite is a no-op without asar.
 */
export function installElectronAsarNativePathPatch(): void {
  if (electronAsarNativePathPatchInstalled) return;
  electronAsarNativePathPatchInstalled = true;

  // Materialize only when the platform package lives under Electron's asar tree.
  // Dev/CLI installs already use real filesystem paths and must not copy binaries.
  try {
    const nativeRoot = resolveGenericEmbeddedPostgresNativeRoot();
    if (nativeRoot && nativeRoot.includes(`${sep}app.asar`)) {
      const sourceRoot = resolveElectronAsarUnpackedPath(nativeRoot);
      if (existsSync(join(sourceRoot, "bin"))) {
        materializeEmbeddedPostgresRuntimeBinaries(sourceRoot);
      }
    }
  } catch {
    // Materialization is best-effort; path rewrite still helps when possible.
  }

  const childProcessMod = require("child_process") as MutableSpawnModule;
  const originalSpawn = childProcessMod.spawn.bind(childProcessMod);
  childProcessMod.spawn = (command: unknown, ...rest: unknown[]) => {
    const fixedCommand =
      typeof command === "string" ? resolveElectronAsarUnpackedPath(command) : command;
    return originalSpawn(fixedCommand, ...rest);
  };

  const fsPromisesMod = require("fs/promises") as MutableFsPromisesModule;
  const originalStat = fsPromisesMod.stat.bind(fsPromisesMod);
  fsPromisesMod.stat = (path: unknown, ...rest: unknown[]) => {
    const fixedPath = typeof path === "string" ? resolveElectronAsarUnpackedPath(path) : path;
    return originalStat(fixedPath, ...rest);
  };
  const originalChmod = fsPromisesMod.chmod.bind(fsPromisesMod);
  fsPromisesMod.chmod = (path: unknown, ...rest: unknown[]) => {
    const fixedPath = typeof path === "string" ? resolveElectronAsarUnpackedPath(path) : path;
    return originalChmod(fixedPath, ...rest);
  };

  // Propagate CJS mutations to ESM named exports (spawn/stat/chmod).
  syncBuiltinESMExports();

  electronAsarNativePathPatchRestore = () => {
    childProcessMod.spawn = originalSpawn;
    fsPromisesMod.stat = originalStat;
    fsPromisesMod.chmod = originalChmod;
    syncBuiltinESMExports();
    electronAsarNativePathPatchInstalled = false;
    electronAsarNativePathPatchRestore = null;
  };
}

/**
 * FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
 * Test-only undo for {@link installElectronAsarNativePathPatch} so unit tests can
 * install a recording bottom-layer spawn/stat/chmod stub, then reinstall the
 * production patch on top and assert rewritten paths without real processes.
 */
export function uninstallElectronAsarNativePathPatchForTests(): void {
  electronAsarNativePathPatchRestore?.();
}

/**
 * Lazily resolve the `embedded-postgres` default export. Cached after the
 * first call. Throws if the package is not installed (e.g. a stripped-down
 * build that omitted the embedded binary).
 */
export type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
  getPgClient(db: string, host: string): {
    connect(): Promise<void>;
    query(text: string, params?: unknown[]): { rowCount: number | null };
    end(): Promise<void>;
  };
};
/** Instance type produced by the embedded-postgres constructor. */
type EmbeddedPostgresInstance = InstanceType<EmbeddedPostgresCtor>;
let embeddedPostgresCtorCache: EmbeddedPostgresCtor | null = null;

/** Test-only constructor seam for deterministic lifecycle cancellation coverage. */
export function __setEmbeddedPostgresCtorForTests(ctor: EmbeddedPostgresCtor | null): void {
  embeddedPostgresCtorCache = ctor;
}

function getEmbeddedPostgresCtor(): EmbeddedPostgresCtor {
  if (embeddedPostgresCtorCache) return embeddedPostgresCtorCache;
  // FNXC:DesktopEmbeddedPostgres 2026-07-14-18:30:
  // Patch asar binary paths before loading embedded-postgres so its module-level
  // binary promise and later spawn/chmod use real unpacked executables.
  installElectronAsarNativePathPatch();
  // Use require() so the bundler leaves this as a runtime resolution (esbuild
  // keeps createRequire'd specifiers out of the static import graph).
  const mod = require("embedded-postgres") as { default: EmbeddedPostgresCtor };
  embeddedPostgresCtorCache = mod.default ?? (mod as unknown as EmbeddedPostgresCtor);
  return embeddedPostgresCtorCache;
}

const log = createLogger("postgres-embedded");

/** Default credentials for the embedded cluster. Chosen to match embedded-postgres defaults. */
export const DEFAULT_EMBEDDED_USER = "postgres";
export const DEFAULT_EMBEDDED_PASSWORD = "password";
/** Default application database name created/ensured on the embedded cluster. */
export const DEFAULT_EMBEDDED_DATABASE = "fusion";

/**
 * FNXC:PostgresEmbedded 2026-06-24-09:05:
 * Default data directory location for the embedded cluster. Mirrors the
 * Paperclip layout (`~/.paperclip/instances/default/db/`) but under Fusion's
 * own storage area. The full package uses this default; tests override it with
 * a temp directory.
 */
export function defaultEmbeddedDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return join(home, ".fusion", "embedded-postgres", "default");
}

/** Options for constructing an {@link EmbeddedPostgresLifecycle}. */
export interface EmbeddedLifecycleOptions {
  /** Filesystem path to the persistent data directory. */
  readonly dataDir: string;
  /** Application database to ensure exists. Defaults to "fusion". */
  readonly database?: string;
  /**
   * Port to bind. When omitted, `start()` discovers a free TCP port.
   * Pinning a port is supported but not recommended for the default embedded
   * mode (concurrent instances would collide).
   */
  readonly port?: number;
  /** Cluster superuser name. Defaults to "postgres". */
  readonly user?: string;
  /** Cluster superuser password. Defaults to "password". */
  readonly password?: string;
  /** Additional initdb flags forwarded to the initdb process. */
  readonly initdbFlags?: readonly string[];
  /** Additional postgres (server) flags. */
  readonly postgresFlags?: readonly string[];
  /** Log handler for postgres/initdb stdout + lifecycle messages. */
  readonly onLog?: (message: string) => void;
  /** Error handler for postgres/initdb stderr. */
  readonly onError?: (messageOrError: string | Error | unknown) => void;
  /**
   * FNXC:PostgresEmbedded 2026-06-26-16:15 (fix migration-review P1 #24):
   * Hard timeout (ms) on the FULL `start()` sequence (initdb + pg_ctl start +
   * ensureDatabase). A stalled `initdb`/`pg_ctl` would otherwise hang startup
   * forever. Defaults to {@link DEFAULT_START_TIMEOUT_MS}. Set to 0 or
   * Infinity to disable the timeout (not recommended for production).
   */
  readonly startTimeoutMs?: number;
}

/**
 * FNXC:PostgresEmbedded 2026-06-26-16:15 (fix migration-review P1 #24):
 * Default startup timeout for the embedded cluster. initdb on a fresh data dir
 * can take ~30-60s on a cold filesystem / slow CI disk, and pg_ctl start a few
 * seconds more; 120s is a generous ceiling that still bounds a stuck process.
 * Reuse starts (no initdb) finish in seconds, well within the bound.
 */
export const DEFAULT_START_TIMEOUT_MS = 120_000;

/**
 * The marker file `initdb` writes into a data directory once initialization
 * succeeds. Its presence means the directory is an initialized cluster and
 * `initdb` must NOT be run again (it would fail).
 */
const PG_VERSION_FILENAME = "PG_VERSION";

/**
 * Return true when `dataDir` contains a `PG_VERSION` file, i.e. it has been
 * initialized by `initdb` and can be started directly without re-initializing.
 */
export function isDataDirInitialized(dataDir: string): boolean {
  return existsSync(join(dataDir, PG_VERSION_FILENAME));
}

interface EmbeddedDylibSymlinkSpec {
  readonly expected: string;
  readonly candidate: RegExp;
}

export interface EmbeddedDylibNormalization {
  readonly expected: string;
  readonly target: string;
  readonly created: boolean;
}

const MACOS_EMBEDDED_DYLIB_SYMLINKS: readonly EmbeddedDylibSymlinkSpec[] = [
  { expected: "libpq.5.dylib", candidate: /^libpq\.5\..+\.dylib$/ },
  { expected: "libzstd.1.dylib", candidate: /^libzstd\.1\..+\.dylib$/ },
  { expected: "liblz4.1.dylib", candidate: /^liblz4\.1\..+\.dylib$/ },
  { expected: "libz.1.dylib", candidate: /^libz\.1\..+\.dylib$/ },
  { expected: "libicui18n.dylib", candidate: /^libicui18n\..+\.dylib$/ },
];

function sortDylibCandidates(files: readonly string[], candidate: RegExp): string[] {
  return files
    .filter((file) => candidate.test(file))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * Normalize macOS embedded-postgres library names before initdb/postgres spawn.
 *
 * The @embedded-postgres/darwin-* packages can contain fully-versioned dylibs
 * (for example libpq.5.15.dylib, libzstd.1.5.7.dylib) while the bundled
 * binaries link against ABI compatibility names such as libpq.5.dylib and
 * libzstd.1.dylib via @loader_path/../lib/.... When the package postinstall
 * symlink hydration is skipped or incomplete, dyld fails before initdb can run.
 *
 * This is intentionally local to the embedded binary package and idempotent:
 * existing compatibility names are left alone; missing compatibility names are
 * repaired with relative symlinks to the matching versioned dylib.
 */
export function normalizeMacosEmbeddedPostgresDylibSymlinks(
  nativeRoot: string,
): EmbeddedDylibNormalization[] {
  const libDir = join(nativeRoot, "lib");
  if (!existsSync(libDir)) return [];

  const files = readdirSync(libDir);
  const results: EmbeddedDylibNormalization[] = [];
  for (const spec of MACOS_EMBEDDED_DYLIB_SYMLINKS) {
    const expectedPath = join(libDir, spec.expected);
    if (existsSync(expectedPath)) continue;
    const target = sortDylibCandidates(files, spec.candidate)[0];
    if (!target) continue;
    try {
      // existsSync() returns false for dangling symlinks. If a previous install
      // left libpq.5.dylib -> libpq.5.15.dylib behind and the versioned target
      // was later removed, symlinkSync() would otherwise throw EEXIST and abort
      // startup. Remove only that broken symlink case; leave real files alone.
      const existing = lstatSync(expectedPath, { throwIfNoEntry: false });
      if (existing?.isSymbolicLink()) {
        unlinkSync(expectedPath);
      }
      symlinkSync(target, expectedPath);
    } catch {
      // Best-effort repair: read-only package stores or filesystem quirks should
      // not crash startup before dyld gets a chance to use already-valid links.
      continue;
    }
    files.push(spec.expected);
    results.push({ expected: spec.expected, target, created: true });
  }
  return results;
}

function findPnpmVirtualStore(start: string): string | null {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (basename(current) === ".pnpm") return current;
    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
  return null;
}

function resolvePnpmPlatformPackageNativeRoot(packageName: string): string | null {
  try {
    const embeddedEntrypoint = require.resolve("embedded-postgres");
    const virtualStore = findPnpmVirtualStore(dirname(embeddedEntrypoint));
    if (!virtualStore) return null;
    const encodedName = packageName.replace("/", "+");
    const entry = readdirSync(virtualStore).find((name) => name.startsWith(`${encodedName}@`));
    if (!entry) return null;
    const packageRoot = join(virtualStore, entry, "node_modules", ...packageName.split("/"));
    return existsSync(packageRoot) ? join(packageRoot, "native") : null;
  } catch {
    return null;
  }
}

function embeddedPostgresPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "@embedded-postgres/darwin-arm64";
    if (arch === "x64") return "@embedded-postgres/darwin-x64";
    return null;
  }
  if (platform === "linux") {
    if (arch === "arm64") return "@embedded-postgres/linux-arm64";
    if (arch === "x64") return "@embedded-postgres/linux-x64";
    if (arch === "arm") return "@embedded-postgres/linux-arm";
    if (arch === "ia32") return "@embedded-postgres/linux-ia32";
    if (arch === "ppc64") return "@embedded-postgres/linux-ppc64";
    return null;
  }
  if (platform === "win32" && arch === "x64") return "@embedded-postgres/windows-x64";
  return null;
}

function resolveGenericEmbeddedPostgresNativeRoot(): string | null {
  const packageName = embeddedPostgresPlatformPackageName();
  if (!packageName) return null;
  try {
    const entrypoint = require.resolve(packageName);
    return resolveElectronAsarUnpackedPath(join(dirname(entrypoint), "..", "native"));
  } catch {
    return resolvePnpmPlatformPackageNativeRoot(packageName);
  }
}

function resolveMacosEmbeddedPostgresNativeRoot(): string | null {
  if (process.platform !== "darwin") return null;
  return resolveGenericEmbeddedPostgresNativeRoot();
}

function normalizeBundledMacosDylibs(onLog: (message: string) => void): void {
  const nativeRoot = resolveMacosEmbeddedPostgresNativeRoot();
  if (!nativeRoot) return;
  const created = normalizeMacosEmbeddedPostgresDylibSymlinks(nativeRoot);
  for (const link of created) {
    onLog(`embedded postgres: repaired macOS dylib link ${link.expected} -> ${link.target}`);
  }
}

/**
 * FNXC:PostgresCutover 2026-06-27-11:00:
 * Process-level registry of running embedded PG instances, keyed by data dir.
 * Prevents the P0 double-boot bug where central core and project runtime both
 * call createTaskStoreForBackend() in the same process, each starting its own
 * EmbeddedPostgresLifecycle against the same data dir. The second start would
 * fail with "postmaster.pid already exists" and hang.
 *
 * When start() detects an already-running instance for the same data dir, it
 * reads the port from postmaster.pid and returns a connection URL without
 * starting a new postmaster process.
 */
const runningInstances = new Map<string, { port: number; database: string }>();

/**
 * Read the port from a postmaster.pid file. The standard PostgreSQL format is:
 *   Line 1 (index 0): PID
 *   Line 2 (index 1): Data directory path
 *   Line 3 (index 2): Unix socket directory
 *   Line 4 (index 3): Listen address (e.g. localhost or *)
 *   Line 5 (index 4): Port number
 *   Line 6 (index 5): Shared memory key
 *   Line 7 (index 6): Postmaster start timestamp
 *
 * FNXC:PostgresCutover 2026-06-27-14:30 (fix code-review P1):
 * Previously read line 3 (index 2, the socket dir) which is never a port
 * number, so singleton detection via postmaster.pid ALWAYS failed. Fixed to
 * read line 5 (index 4, the TCP port).
 *
 * Returns null if the file cannot be read or parsed.
 */
export function readPortFromPostmasterPid(dataDir: string): number | null {
  try {
    const content = readFileSync(join(dataDir, "postmaster.pid"), "utf-8");
    const lines = content.split("\n");
    // Line 5 (index 4) is the TCP port in standard PostgreSQL postmaster.pid
    const portStr = lines[4]?.trim();
    if (portStr) {
      const port = parseInt(portStr, 10);
      if (!isNaN(port) && port > 0) return port;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether an embedded PG is already running for the given data dir.
 * Uses both the in-process registry AND a probe of the postmaster.pid file
 * (handles the case where another process started it).
 */
function isAlreadyRunning(dataDir: string): { port: number; database: string } | null {
  // Check in-process registry first
  const cached = runningInstances.get(dataDir);
  if (cached) return cached;

  // Check postmaster.pid — another process (or a prior call) may have started PG
  if (!existsSync(join(dataDir, "postmaster.pid"))) return null;

  // Read the port from postmaster.pid
  const port = readPortFromPostmasterPid(dataDir);
  if (!port) return null;

  // Probe: can we connect to this port?
  // We return the port optimistically — the connection layer will fail fast
  // if the port is stale (postmaster.pid left over from a crash).
  return { port, database: "fusion" };
}

/**
 * Find a free TCP port on 127.0.0.1 by binding to port 0 and reading the
 * assigned port, then closing the temporary listener.
 *
 * There is an inherent TOCTOU race between releasing the port and the embedded
 * postgres binding it, but this is the standard Node idiom and the race window
 * is tiny. For the zero-config default this is acceptable; callers needing a
 * fixed port can pass `options.port`.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Could not determine a free port"));
      }
    });
  });
}

/**
 * Manages the lifecycle of a bundled embedded PostgreSQL process.
 *
 * One instance owns one embedded cluster session (start → stop). The underlying
 * `embedded-postgres` object is created lazily in `start()` so the constructor
 * is cheap and side-effect-free.
 */
export class EmbeddedPostgresLifecycle {
  private readonly options: Required<
    Omit<
      EmbeddedLifecycleOptions,
      "port" | "onLog" | "onError" | "initdbFlags" | "postgresFlags" | "startTimeoutMs"
    >
  > & {
    port?: number;
    initdbFlags: readonly string[];
    postgresFlags: readonly string[];
    startTimeoutMs: number;
    onLog: (message: string) => void;
    onError: (messageOrError: string | Error | unknown) => void;
  };

  private pg: EmbeddedPostgresInstance | null = null;
  private resolvedPort: number | undefined;
  private running = false;
  // FNXC:PostgresCutover 2026-06-27-11:10:
  // True when THIS lifecycle instance owns (started) the postmaster process.
  // When we detect an already-running instance and connect to it, ownsProcess
  // is false and stop() is a no-op (the owning instance handles shutdown).
  private ownsProcess = true;
  private shutdownHookInstalled = false;
  /**
   * FNXC:PostgresEmbedded 2026-06-26-16:20 (fix migration-review P1 #24):
   * Active start() timeout timer, retained so it can be cleared on success or
   * on a failure that is handled before the timeout fires.
   */
  private startTimer: NodeJS.Timeout | null = null;

  constructor(opts: EmbeddedLifecycleOptions) {
    this.options = {
      dataDir: opts.dataDir,
      database: opts.database ?? DEFAULT_EMBEDDED_DATABASE,
      port: opts.port,
      user: opts.user ?? DEFAULT_EMBEDDED_USER,
      password: opts.password ?? DEFAULT_EMBEDDED_PASSWORD,
      initdbFlags: opts.initdbFlags ?? [],
      postgresFlags: opts.postgresFlags ?? [],
      startTimeoutMs: opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      onLog: opts.onLog ?? ((msg: string) => log.log(msg)),
      onError:
        opts.onError ?? ((err: string | Error | unknown) => log.error(String(err))),
    };
  }

  /** The configured or discovered port. Undefined until assigned (explicit or discovered in `start()`). */
  getPort(): number | undefined {
    return this.options.port ?? this.resolvedPort;
  }

  /** True when the embedded postgres process is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** The data directory backing this cluster. */
  getDataDir(): string {
    return this.options.dataDir;
  }

  /**
   * Build the `postgresql://` connection URL (with credentials) for the
   * configured database and port. The URL is only meaningful after `start()`
   * has assigned a port (or when an explicit port was configured).
   */
  getConnectionUrl(): string {
    const port = this.getPort();
    if (port === undefined) {
      throw new Error(
        "Cannot build connection URL before start(): no port assigned. " +
          "Pass an explicit port or call start() first.",
      );
    }
    return this.buildUrl(port, this.options.database);
  }

  /**
   * Log-safe variant of {@link getConnectionUrl} with the password redacted.
   * Use this for any startup/diagnostic logging.
   */
  getRedactedConnectionUrl(): string {
    return redactConnectionString(this.getConnectionUrl());
  }

  private buildUrl(port: number, database: string): string {
    return `postgresql://${encodeURIComponent(this.options.user)}:${encodeURIComponent(this.options.password)}@localhost:${port}/${encodeURIComponent(database)}`;
  }

  /**
   * Start the embedded PostgreSQL cluster.
   *
   * Steps:
   *   1. Resolve the port (explicit option or discover a free one).
   *   2. Construct the underlying `embedded-postgres` instance.
   *   3. Run `initialise()` (initdb) ONLY when the data dir is not yet
   *      initialized (PG_VERSION absent). On reuse, skip initdb.
   *   4. Start the postgres process.
   *   5. Ensure the application database exists (idempotent).
   *   6. Install the graceful-shutdown hook.
   *
   * Returns a `ResolvedBackend` (embedded mode) carrying the runtime URL so the
   * connection layer can build the Drizzle pool via `createConnectionSetFromUrl`.
   *
   * FNXC:PostgresEmbedded 2026-06-26-16:25 (fix migration-review P1 #24):
   * The full start sequence is wrapped in a hard timeout (`startTimeoutMs`,
   * default 120s). A stalled initdb/pg_ctl that would otherwise hang startup
   * forever instead rejects with a clear `EmbeddedStartTimeoutError` and
   * attempts to clean up the partially-started cluster (stop + clear the
   * running flag) so a retry is not left in a wedged state. Set
   * `startTimeoutMs: 0` to disable the timeout.
   */
  /**
   * Start the embedded PostgreSQL cluster.
   *
   * FNXC:PostgresCutover 2026-06-27-11:05:
   * IDempotent: if an embedded PG is already running for this data dir
   * (started by a prior start() call in the same process, or detected via
   * postmaster.pid), returns a connection URL without starting a new
   * postmaster. This prevents the P0 double-boot collision where central
   * core and project runtime both call createTaskStoreForBackend() and each
   * tries to start its own EmbeddedPostgresLifecycle against the same dir.
   */
  async start(): Promise<ResolvedBackend> {
    if (this.running) {
      throw new Error("EmbeddedPostgresLifecycle already running");
    }

    // FNXC:PostgresCutover 2026-06-27-11:05:
    // Check if PG is already running for this data dir. If so, reuse it.
    const existing = isAlreadyRunning(this.options.dataDir);
    if (existing) {
      this.options.onLog(
        `embedded postgres: already running on port ${existing.port} (data dir ${this.options.dataDir}), connecting without starting a new instance`,
      );
      this.resolvedPort = existing.port;
      this.running = false; // We didn't start it, so we won't stop it
      this.ownsProcess = false;

      // Ensure the database exists on the running instance
      const url = this.buildUrl(existing.port, this.options.database);
      return {
        mode: "embedded",
        runtimeUrl: url,
        migrationUrl: url,
        migrationUrlOverridden: false,
      };
    }
    if (this.options.startTimeoutMs <= 0) {
      return this.startInternal();
    }
    const controller = new AbortController();
    const startAttempt = this.startInternal(controller.signal);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new EmbeddedStartTimeoutError(
            this.options.startTimeoutMs,
            this.options.dataDir,
          ),
        );
      }, this.options.startTimeoutMs);
      // Unref so the timer alone does not keep the event loop alive.
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    this.startTimer = timer ?? null;
    try {
      return await Promise.race([startAttempt, timeout]);
    } catch (err) {
      controller.abort();
      // On timeout (or any failure), best-effort clean up the partial state so
      // a retry starts fresh. stop() is safe to call even when not fully running.
      await this.stop().catch(() => undefined);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.startTimer = null;
    }
  }

  /**
   * The actual start sequence, with no timeout wrapper. Called by {@link start}
   * either directly (timeout disabled) or via Promise.race with the timeout.
   */
  private async startInternal(signal?: AbortSignal): Promise<ResolvedBackend> {
    const port = this.options.port ?? (await findFreePort());
    if (signal?.aborted) throw new EmbeddedStartCancelledError(this.options.dataDir);
    this.resolvedPort = port;

    const alreadyInitialized = isDataDirInitialized(this.options.dataDir);

    normalizeBundledMacosDylibs(this.options.onLog);

    const pg = new (getEmbeddedPostgresCtor())({
      databaseDir: this.options.dataDir,
      user: this.options.user,
      password: this.options.password,
      port,
      persistent: true,
      authMethod: "password",
      initdbFlags: [...this.options.initdbFlags],
      postgresFlags: [...this.options.postgresFlags],
      onLog: this.options.onLog,
      onError: this.options.onError,
    });
    this.pg = pg;

    // FNXC:PostgresEmbedded 2026-06-24-09:06:
    // initialise() always runs initdb, which fails on an existing data dir.
    // Guard it so re-starts reuse the cluster (VAL-CONN-006).
    if (alreadyInitialized) {
      this.options.onLog(
        `embedded postgres: existing data directory at ${this.options.dataDir}, reusing without initdb`,
      );
    } else {
      this.options.onLog(
        `embedded postgres: initializing new data directory at ${this.options.dataDir} (initdb)`,
      );
      await pg.initialise();
    }

    if (signal?.aborted) {
      await this.settleCancelledStart(pg);
      throw new EmbeddedStartCancelledError(this.options.dataDir);
    }

    await pg.start();
    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-18:42:
    Promise.race does not cancel the losing embedded-postgres startup. Check the cooperative cancellation signal after every delayed phase and stop the exact late instance before it can publish running state, registry ownership, or process hooks. A timeout may already have attempted stop while pg.start() was pending, so the post-resolution stop is intentionally repeated to catch a postmaster that appeared after that first cleanup.
    */
    if (signal?.aborted) {
      await this.settleCancelledStart(pg);
      throw new EmbeddedStartCancelledError(this.options.dataDir);
    }
    this.running = true;
    this.ownsProcess = true;

    // Register in the process-level map so other callers can detect us
    runningInstances.set(this.options.dataDir, {
      port,
      database: this.options.database,
    });

    try {
      await this.ensureDatabase();
    } catch (error) {
      if (signal?.aborted) {
        await this.settleCancelledStart(pg);
        throw new EmbeddedStartCancelledError(this.options.dataDir);
      }
      throw error;
    }

    if (signal?.aborted) {
      await this.settleCancelledStart(pg);
      throw new EmbeddedStartCancelledError(this.options.dataDir);
    }

    this.installShutdownHook();

    const runtimeUrl = this.buildUrl(port, this.options.database);
    this.options.onLog(
      `embedded postgres: ready on port ${port} (database "${this.options.database}")`,
    );

    return {
      mode: "embedded",
      runtimeUrl,
      migrationUrl: runtimeUrl,
      migrationUrlOverridden: false,
    };
  }

  private async settleCancelledStart(pg: EmbeddedPostgresInstance): Promise<void> {
    try {
      await pg.stop();
    } catch (error) {
      this.options.onError(`embedded postgres: cancelled startup cleanup failed: ${String(error)}`);
    } finally {
      if (this.pg === pg) this.pg = null;
      this.running = false;
      runningInstances.delete(this.options.dataDir);
      this.uninstallShutdownHook();
    }
  }

  /**
   * Ensure the application database exists on the running cluster.
   *
   * Idempotent: queries `pg_database` first and only issues `CREATE DATABASE`
   * when the database is missing. `embedded-postgres.createDatabase()` throws on
   * an existing database, so this guard is required for safe re-starts.
   */
  async ensureDatabase(): Promise<void> {
    if (!this.pg || !this.running) {
      throw new Error(
        "Cannot ensure database: the embedded cluster is not running. Call start() first.",
      );
    }
    const exists = await this.databaseExists(this.options.database);
    if (exists) return;
    await this.pg.createDatabase(this.options.database);
  }

  /** Check whether a database with the given name exists on the cluster. */
  private async databaseExists(name: string): Promise<boolean> {
    if (!this.pg) return false;
    // Use the maintenance client (connects to the default "postgres" db).
    const client = this.pg.getPgClient("postgres", "localhost");
    try {
      await client.connect();
      const result = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [name],
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Stop the embedded PostgreSQL process. Safe to call multiple times.
   * After stop, the data directory is preserved (persistent), so a subsequent
   * `start()` reuses it.
   */
  async stop(): Promise<void> {
    this.uninstallShutdownHook();

    // FNXC:PostgresCutover 2026-06-27-11:10:
    // If we didn't start the postmaster (detected an already-running instance),
    // don't stop it — the owning instance handles shutdown.
    if (!this.ownsProcess) {
      this.running = false;
      return;
    }

    if (!this.pg) {
      this.running = false;
      // Clean up the registry even if pg is null
      runningInstances.delete(this.options.dataDir);
      return;
    }
    try {
      await this.pg.stop();
    } catch (err) {
      this.options.onError(`embedded postgres: error during stop: ${String(err)}`);
    } finally {
      this.pg = null;
      this.running = false;
      runningInstances.delete(this.options.dataDir);
    }
  }

  /**
   * Install process-level shutdown handlers so SIGTERM/SIGINT cleanly stop the
   * embedded postgres process (VAL-CONN-007 — no orphaned process remains).
   *
   * The handler is idempotent and removes itself after firing. We attach to
   * SIGTERM and SIGINT (the common graceful-shutdown signals) and `beforeExit`
   * (normal Node termination). We do NOT attach to SIGKILL (uncatchable).
   *
   * FNXC:PostgresEmbedded 2026-06-26-16:00 (fix migration-review P1 #23):
   * The SIGTERM/SIGINT handler MUST re-raise the signal after `stop()`
   * completes. Node's default behavior for SIGTERM/SIGINT is to terminate the
   * process; once we register a listener with `process.once(signal, ...)`,
   * that default is SUPPRESSED and the process keeps running. If the handler
   * only awaits `stop()` and returns, the process hangs alive (the cluster is
   * stopped but Node never exits) until an external SIGKILL. Re-raising the
   * signal via `process.kill(process.pid, signal)` after stop restores the
   * default termination behavior. `beforeExit` does not need re-raising (it is
   * a Node-internal event with no default-kill behavior).
   */
  private installShutdownHook(): void {
    if (this.shutdownHookInstalled) return;
    this.shutdownHookInstalled = true;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, this.boundShutdown);
    }
    process.once("beforeExit", this.boundShutdown);
  }

  private uninstallShutdownHook(): void {
    if (!this.shutdownHookInstalled) return;
    this.shutdownHookInstalled = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.removeListener(signal, this.boundShutdown);
    }
    process.removeListener("beforeExit", this.boundShutdown);
  }

  /**
   * Bound shutdown handler. Stops the cluster and re-raises the original
   * signal so the process exits with the signal's default behavior.
   *
   * FNXC:PostgresEmbedded 2026-06-26-16:05 (fix migration-review P1 #23):
   * For SIGTERM/SIGINT: after `stop()` resolves, re-raise the signal so the
   * process terminates (otherwise Node hangs alive with the listener
   * installed). We use `process.kill(process.pid, signal)` which delivers the
   * signal synchronously; because our listener was registered with
   * `process.once` and already removed itself, the re-raised signal hits the
   * default handler and terminates the process. If re-raising fails for any
   * reason, fall back to `process.exit(128 + signal-number)` so we never hang.
   *
   * For `beforeExit`: this is a Node-internal lifecycle event (no signal), so
   * we only stop the cluster and let Node continue its normal exit.
   */
  private readonly boundShutdown = async (
    signal: NodeJS.Signals | "beforeExit",
  ): Promise<void> => {
    if (!this.running && signal !== "beforeExit") return;
    if (!this.ownsProcess) return; // Don't stop an instance we didn't start
    this.options.onLog(
      `embedded postgres: received ${signal}, stopping embedded cluster`,
    );
    try {
      await this.stop();
    } catch (err) {
      this.options.onError(
        `embedded postgres: error during signal shutdown: ${String(err)}`,
      );
    }
    // Re-raise real signals so the process exits instead of hanging.
    if (signal !== "beforeExit") {
      const signo = signalNumber(signal);
      try {
        process.kill(process.pid, signal);
      } catch {
        // If we can't re-raise, exit with the conventional 128+signo code.
        process.exit(128 + signo);
      }
    }
  };
}

class EmbeddedStartCancelledError extends Error {
  constructor(dataDir: string) {
    super(`embedded postgres: cancelled late startup for ${dataDir}`);
    this.name = "EmbeddedStartCancelledError";
  }
}

/**
 * FNXC:PostgresEmbedded 2026-06-26-16:30 (fix migration-review P1 #24):
 * Thrown when the embedded PostgreSQL start sequence (initdb + pg_ctl start +
 * ensureDatabase) exceeds the configured {@link EmbeddedLifecycleOptions.startTimeoutMs}.
 * Carries the timeout duration and data directory for actionable diagnostics.
 * A separate error class lets callers distinguish a startup timeout from other
 * start failures (e.g. a port-in-use error) and react accordingly.
 */
export class EmbeddedStartTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly dataDir: string;

  constructor(timeoutMs: number, dataDir: string) {
    super(
      `embedded postgres: start timed out after ${timeoutMs}ms (data dir ${dataDir}). ` +
        `This usually means initdb or pg_ctl stalled. Check disk space, the data ` +
        `directory permissions, and the onLog/onError output for details.`,
    );
    this.name = "EmbeddedStartTimeoutError";
    this.timeoutMs = timeoutMs;
    this.dataDir = dataDir;
  }
}

/**
 * FNXC:PostgresEmbedded 2026-06-26-16:10 (fix migration-review P1 #23):
 * Map a Node signal name to its conventional POSIX signal number, used to
 * compute the conventional exit code (128 + signo) when re-raising the signal
 * fails. POSIX: SIGTERM=15, SIGINT=2. Unknown signals default to 0 (exit
 * code 128), which still terminates the process.
 */
function signalNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGTERM":
      return 15;
    case "SIGINT":
      return 2;
    case "SIGHUP":
      return 1;
    case "SIGQUIT":
      return 3;
    default:
      return 0;
  }
}
