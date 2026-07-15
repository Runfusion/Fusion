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
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join, basename } from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../logger.js";
import { redactConnectionString } from "./credential-redact.js";
import type { ResolvedBackend } from "./backend-resolver.js";
import {
  isWindowsElevatedAdmin,
  startServerAsNonAdminUser,
  type NonAdminServerHandle,
} from "./embedded-windows-admin.js";

const require = createRequire(import.meta.url);

/**
 * Lazily resolve the `embedded-postgres` default export. Cached after the
 * first call. Throws if the package is not installed (e.g. a stripped-down
 * build that omitted the embedded binary).
 */
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
  getPgClient(db: string, host: string): {
    /** pg.Client option; bound here so callers (e.g. the readiness probe) can cap connect time without a cast. */
    connectionTimeoutMillis?: number;
    connect(): Promise<void>;
    query(text: string, params?: unknown[]): { rowCount: number | null };
    end(): Promise<void>;
  };
};
/** Instance type produced by the embedded-postgres constructor. */
type EmbeddedPostgresInstance = InstanceType<EmbeddedPostgresCtor>;
let embeddedPostgresCtorCache: EmbeddedPostgresCtor | null = null;
function getEmbeddedPostgresCtor(): EmbeddedPostgresCtor {
  if (embeddedPostgresCtorCache) return embeddedPostgresCtorCache;
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

function resolveMacosEmbeddedPostgresNativeRoot(): string | null {
  if (process.platform !== "darwin") return null;
  const packageName = process.arch === "arm64"
    ? "@embedded-postgres/darwin-arm64"
    : process.arch === "x64"
      ? "@embedded-postgres/darwin-x64"
      : null;
  if (!packageName) return null;

  try {
    const entrypoint = require.resolve(packageName);
    return join(dirname(entrypoint), "..", "native");
  } catch {
    return resolvePnpmPlatformPackageNativeRoot(packageName);
  }
}

/**
 * FNXC:WindowsDesktopPackaging 2026-07-14-21:40:
 * Resolve the bundled @embedded-postgres/windows-x64 native root (.../native,
 * containing bin/postgres.exe + lib + share). Used to launch the server under a
 * dedicated non-admin user when the process is elevated; see
 * embedded-windows-admin.ts.
 */
function resolveWindowsEmbeddedPostgresNativeRoot(): string | null {
  if (process.platform !== "win32") return null;
  const packageName = process.arch === "x64" ? "@embedded-postgres/windows-x64" : null;
  if (!packageName) return null;
  try {
    const entrypoint = require.resolve(packageName);
    return join(dirname(entrypoint), "..", "native");
  } catch {
    return resolvePnpmPlatformPackageNativeRoot(packageName);
  }
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
  /**
   * FNXC:WindowsDesktopPackaging 2026-07-14-21:40:
   * When the process is an elevated Windows admin, the server is booted under a
   * dedicated non-admin user (see embedded-windows-admin.ts) and this holds the
   * handle used to stop it. Null in the normal (non-elevated / non-Windows)
   * path, where stop() delegates to the embedded-postgres instance.
   */
  private nonAdminHandle: NonAdminServerHandle | null = null;

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
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
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
      return await Promise.race([this.startInternal(), timeout]);
    } catch (err) {
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
  private async startInternal(): Promise<ResolvedBackend> {
    const port = this.options.port ?? (await findFreePort());
    this.resolvedPort = port;

    const alreadyInitialized = isDataDirInitialized(this.options.dataDir);

    normalizeBundledMacosDylibs(this.options.onLog);

    this.pg = new (getEmbeddedPostgresCtor())({
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
      await this.pg.initialise();
    }

    // FNXC:WindowsDesktopPackaging 2026-07-14-21:40:
    // Under an elevated Windows admin token, postgres refuses to inherit the
    // process token ("Execution of PostgreSQL by a user with administrative
    // permissions is not permitted"). initdb + the pg client above ran as the
    // launching (admin) process and work unchanged; only the SERVER start is
    // re-homed under a dedicated non-admin local user. Normal (non-elevated /
    // non-Windows) launches use the inherited-token path as before.
    if (isWindowsElevatedAdmin()) {
      const nativeRoot = resolveWindowsEmbeddedPostgresNativeRoot();
      if (!nativeRoot) {
        throw new Error(
          "embedded postgres: the process is running elevated on Windows, where " +
            "PostgreSQL refuses to start under an administrative token, and the " +
            "non-admin boot path could not locate the bundled " +
            "@embedded-postgres/windows-x64 native binaries to stage. Run Fusion " +
            "non-elevated, or ensure the embedded-postgres platform package is installed.",
        );
      }
      this.nonAdminHandle = await startServerAsNonAdminUser({
        nativeRoot,
        dataDir: this.options.dataDir,
        port,
        postgresFlags: this.options.postgresFlags,
        onLog: this.options.onLog,
        onError: this.options.onError,
        startTimeoutMs: this.options.startTimeoutMs,
        // FNXC:WindowsDesktopPackaging 2026-07-14-23:20:
        // Real readiness probe for the non-admin path: a short-timeout SELECT 1.
        // During crash recovery postgres rejects the startup handshake fast
        // ("the database system is starting up"), so this resolves true only
        // once the server is actually accepting queries — unlike a bare TCP
        // connect, which succeeds the moment the port is bound.
        probeReady: async () => {
          const pg = this.pg;
          if (!pg) return false;
          const client = pg.getPgClient("postgres", "localhost");
          // FNXC:WindowsDesktopPackaging 2026-07-14-23:40:
          // pg copies connectionTimeoutMillis into _connectionTimeoutMillis
          // only in the Client constructor, so setting it after getPgClient()
          // does not bound connect(). Race connect+SELECT against a hard 1.5s
          // timeout so the probe resolves fast even if postgres accepts the
          // socket but stalls its startup response during crash recovery.
          const { promise: timeout, reject: timeoutReject } = Promise.withResolvers<never>();
          const timer = setTimeout(() => timeoutReject(new Error("probe timeout")), 1500);
          try {
            await Promise.race([
              client.connect().then(() => client.query("SELECT 1")),
              timeout,
            ]);
            return true;
          } catch {
            return false;
          } finally {
            clearTimeout(timer);
            await client.end().catch(() => {});
          }
        },
      });
    } else {
      await this.pg.start();
    }
    this.running = true;
    this.ownsProcess = true;

    // Register in the process-level map so other callers can detect us
    runningInstances.set(this.options.dataDir, {
      port,
      database: this.options.database,
    });

    await this.ensureDatabase();

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
    // FNXC:WindowsDesktopPackaging 2026-07-15-01:20:
    // Create the DB directly over TCP. embedded-postgres.createDatabase guards
    // on its internal this.process, which is null on the non-admin Windows path
    // (we boot the server ourselves, not via this.pg.start()), so it would
    // throw "cluster must be running". The server IS up — start() probed it.
    const client = this.pg.getPgClient("postgres", "localhost");
    try {
      await client.connect();
      const ident = this.options.database.replace(/"/g, '""');
      await client.query(`CREATE DATABASE "${ident}"`);
    } finally {
      await client.end().catch(() => {});
    }
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
      // FNXC:WindowsDesktopPackaging 2026-07-14-21:40:
      // Elevated-Windows path: the server was booted under a dedicated
      // non-admin user; stop it via the handle instead of the embedded-postgres
      // instance (which never owned a process in this path).
      if (this.nonAdminHandle) {
        await this.nonAdminHandle.stop();
        this.nonAdminHandle = null;
      } else {
        await this.pg.stop();
      }
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
