/**
 * Isolated-app-launch harness (U4).
 *
 * Stands up an ISOLATED instance of the Fusion app/dashboard for a verification
 * run, and tears it down unconditionally. This is the surface the app/browser
 * driver (U8) will drive; it owns the isolation/launch/teardown contracts so
 * those can be characterized and trusted *before* any navigation logic exists.
 *
 * It does NOT navigate, interact with, or observe the app (that is U8), and it
 * does NOT feed any verdict path (that is U5). It only launches + tears down.
 *
 * Safety contracts enforced here (R13) — the boundary, not a convention:
 * (port-4040-allowlist: the "4040" references below document the reserved-port
 * guard contract; this harness never kills or binds the live dashboard port.)
 * - **Non-reserved port.** The bound port is never a reserved dashboard port:
 *   4040 is always reserved, plus anything in `FUSION_RESERVED_PORTS` / `PORT` /
 *   `FUSION_SERVER_PORT` (mirrors the repo's existing port-4040 guards in
 *   `scripts/boot-smoke.mjs` / `check-no-kill-4040.mjs` and
 *   `dev-server-port-detect.ts`).
 * - **Disposable DB.** A fresh, empty DB created under a run-unique tmpdir —
 *   NEVER the shared central DB, never a copy of it, no credentials, no agent
 *   logs seeded.
 * - **Fresh bundle.** A freshly-built client bundle is served so verification
 *   cannot produce its own false verdicts from a stale `dist/client` (the trap
 *   documented in
 *   `docs/solutions/developer-experience/browser-testing-dashboard-from-worktree-safely.md`).
 * - **Unconditional teardown.** On crash / timeout / normal disposal the
 *   process is killed, the port is freed, and the tmpdir/DB are removed.
 *
 * Process-spawn and bundle-build are INJECTABLE so unit tests can characterize
 * the isolation contracts without launching a full server. A real end-to-end
 * launch belongs in a heavier lane / manual smoke (see `scripts/boot-smoke.mjs`,
 * which is the closest existing real-boot pattern), not in the merge-gate unit
 * tests.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import { createLogger } from "../logger.js";

const harnessLog = createLogger("mission-verify-app");

// ── Reserved-port policy (mirrors the repo's port-4040 guards) ────────────────

/**
 * Parse a comma-separated port list (matching the parsing in
 * `scripts/boot-smoke.mjs` and `@fusion/core/__test-utils__/port-probe-policy`).
 */
export function parsePortList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
}

/**
 * The reserved-port set derived from the environment. 4040 (the user's live
 * dashboard) is ALWAYS reserved; `FUSION_RESERVED_PORTS` / `PORT` /
 * `FUSION_SERVER_PORT` add more. Mirrors `resolveReservedPortsFromEnv` in
 * `@fusion/core/__test-utils__/port-probe-policy` (which is a test-only path and
 * not part of the public package surface, so it is re-derived here rather than
 * imported).
 */
export function resolveReservedPorts(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const reserved = new Set<number>([4040]);
  for (const port of parsePortList(env.FUSION_RESERVED_PORTS)) reserved.add(port);
  for (const port of parsePortList(env.PORT)) reserved.add(port);
  for (const port of parsePortList(env.FUSION_SERVER_PORT)) reserved.add(port);
  return reserved;
}

/**
 * Acquire an OS-assigned ephemeral port that is NOT in the reserved set. Mirrors
 * `getEphemeralPort` in `scripts/boot-smoke.mjs`: bind `listen(0)`, read the
 * assigned port, release it, and reject reserved ports before returning.
 *
 * Note this is a best-effort claim (the OS could hand the port to someone else
 * between release and the server's bind — the TOCTOU window boot-smoke retries
 * around). The launcher receives the port and is expected to retry on
 * EADDRINUSE; the contract this enforces is "never a reserved port".
 */
export async function acquireNonReservedPort(
  reserved: Set<number>,
  attempts = 10,
): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createNetServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        if (address && typeof address === "object") {
          const { port: assigned } = address;
          srv.close(() => resolve(assigned));
        } else {
          srv.close(() => reject(new Error("could not read ephemeral port from socket")));
        }
      });
    });
    if (!reserved.has(port)) return port;
  }
  throw new Error("could not obtain a non-reserved ephemeral port");
}

// ── Disposable DB (R13) ───────────────────────────────────────────────────────

/**
 * A disposable, run-unique workspace for an isolated app instance: a fresh DB
 * path under a tmpdir, never the central DB.
 */
export interface DisposableAppWorkspace {
  /** Run-unique tmpdir root. */
  tmpDir: string;
  /** Path to the fresh, empty disposable DB inside `tmpDir`. */
  dbPath: string;
  /** Remove the tmpdir (and the DB inside it) unconditionally. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Create a run-unique tmpdir containing a fresh, empty DB file path. The DB is
 * created empty (no schema, no rows) — never copied from the central DB and
 * never seeded with credentials or agent logs (R13). The launched app is
 * responsible for initializing its own schema in this empty file.
 */
export async function createDisposableAppWorkspace(): Promise<DisposableAppWorkspace> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fn-verify-app-"));
  const dbPath = path.join(tmpDir, "fusion-verify.db");
  // Touch an empty DB file so the path exists and is unmistakably fresh (zero
  // bytes => no central-DB copy, no seeded credentials/logs).
  await fs.writeFile(dbPath, "");
  return {
    tmpDir,
    dbPath,
    dispose: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        harnessLog.warn(`Failed to remove disposable app workspace ${tmpDir}:`, err);
      });
    },
  };
}

// ── Injectable launch primitives ──────────────────────────────────────────────

/** A handle to a launched (real or stubbed) app server process. */
export interface LaunchedAppProcess {
  /**
   * Resolves once the server is accepting connections / healthy on `port`.
   * Rejects if the process exits before becoming healthy, or on timeout.
   */
  ready: Promise<void>;
  /**
   * Kill the process and free the port. MUST be safe to call unconditionally,
   * including after the process has already exited (crash/timeout) — idempotent.
   */
  kill(): Promise<void>;
}

/**
 * Spawns the app server. Injectable so unit tests can characterize isolation
 * without launching a real server; the default (heavier-lane) implementation
 * would boot via the CLI `serve`/`dashboard` entry against `options`.
 */
export type AppProcessSpawner = (options: AppLaunchOptions) => LaunchedAppProcess;

/** Description of the client bundle the harness must serve. */
export interface ClientBundle {
  /** Absolute path to the freshly-built client dir to serve (FUSION_CLIENT_DIR). */
  clientDir: string;
}

/**
 * Ensures a freshly-built client bundle exists and returns the dir to serve.
 * Injectable; the default implementation would build `@fusion/dashboard` and
 * return its `dist/client`. Tests assert that a *stale* bundle triggers a
 * rebuild before launch (the `dist/client` trap).
 */
export interface BundleBuilder {
  /**
   * Whether the currently-built bundle is stale relative to source. The harness
   * rebuilds before launch when this returns true so verification never serves a
   * stale bundle.
   */
  isStale(): Promise<boolean>;
  /** Build the client bundle and return the dir to serve. */
  build(): Promise<ClientBundle>;
  /** Return the already-built bundle dir without building. */
  current(): Promise<ClientBundle>;
}

/** Options passed to the process spawner for an isolated launch. */
export interface AppLaunchOptions {
  port: number;
  host: string;
  dbPath: string;
  clientDir: string;
  /** Scrubbed env for the child (no credentials). */
  env: NodeJS.ProcessEnv;
  /** Abort signal to bound startup. */
  signal?: AbortSignal;
}

// ── launchIsolatedApp ─────────────────────────────────────────────────────────

export interface LaunchIsolatedAppOptions {
  /** Injectable process spawner (required — no real default in this unit). */
  spawn: AppProcessSpawner;
  /** Injectable bundle builder (required — no real default in this unit). */
  bundle: BundleBuilder;
  /** Env source for reserved-port resolution + scrubbing (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Host to bind (defaults to 127.0.0.1). */
  host?: string;
  /** Startup timeout in ms (defaults to 60s, matching boot-smoke). */
  readyTimeoutMs?: number;
  /** Abort signal to cancel/bound the launch. */
  signal?: AbortSignal;
}

/** A launched isolated app instance the driver (U8) can target. */
export interface IsolatedApp {
  /** Base URL the app is served at (e.g. http://127.0.0.1:<port>). */
  baseUrl: string;
  /** The bound, non-reserved port. */
  port: number;
  /** Path to the disposable, fresh DB under a run-unique tmpdir. */
  dbPath: string;
  /** Absolute path to the freshly-built client dir being served. */
  clientDir: string;
  /**
   * Tear down EVERYTHING unconditionally: kill the process, free the port,
   * remove the tmpdir/DB. Idempotent and safe after a crash/timeout.
   */
  dispose(): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Scrub credentials/secrets from the env handed to the launched app. */
const APP_ENV_ALLOWLIST = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"] as const;

function scrubAppEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const key of APP_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) scrubbed[key] = value;
  }
  // Isolation flags: never run the engine against the central DB, skip onboarding.
  scrubbed.FUSION_SKIP_ONBOARDING = "1";
  return scrubbed;
}

/**
 * Launch an isolated app instance for a verification run. Order matters:
 *
 *  1. Resolve a NON-RESERVED port (4040 + FUSION_RESERVED_PORTS guards).
 *  2. Create a fresh, empty disposable DB under a run-unique tmpdir.
 *  3. Ensure a FRESHLY-BUILT bundle (rebuild if stale — no `dist/client` trap).
 *  4. Spawn the server against the disposable DB + fresh bundle + isolated port.
 *  5. Wait for readiness, bounded by `readyTimeoutMs` / `signal`.
 *
 * If ANY step after the tmpdir is created fails (including a crash/timeout
 * during readiness), the harness tears the whole instance down before
 * rejecting — the process is killed, the port released, and the tmpdir/DB
 * removed (R13 unconditional teardown).
 */
export async function launchIsolatedApp(options: LaunchIsolatedAppOptions): Promise<IsolatedApp> {
  const env = options.env ?? process.env;
  const host = options.host ?? "127.0.0.1";
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  // 1. Non-reserved port.
  const reserved = resolveReservedPorts(env);
  const port = await acquireNonReservedPort(reserved);
  // Defense in depth: never proceed with a reserved port.
  if (reserved.has(port)) {
    throw new Error(`refusing to bind reserved port ${port}`);
  }

  // 2. Disposable DB under a run-unique tmpdir.
  const workspace = await createDisposableAppWorkspace();

  let launched: LaunchedAppProcess | undefined;
  const teardown = async () => {
    try {
      await launched?.kill();
    } catch (err) {
      harnessLog.warn("Failed to kill isolated app process during teardown:", err);
    }
    await workspace.dispose();
  };

  try {
    // 3. Fresh bundle — rebuild when stale so we never serve a stale dist/client.
    const bundle = (await options.bundle.isStale())
      ? await options.bundle.build()
      : await options.bundle.current();

    // 4. Spawn against the isolated surface.
    launched = options.spawn({
      port,
      host,
      dbPath: workspace.dbPath,
      clientDir: bundle.clientDir,
      env: scrubAppEnv(env),
      signal: options.signal,
    });

    // 5. Bounded readiness.
    await withTimeout(launched.ready, readyTimeoutMs, options.signal);

    return {
      baseUrl: `http://${host}:${port}`,
      port,
      dbPath: workspace.dbPath,
      clientDir: bundle.clientDir,
      dispose: teardown,
    };
  } catch (err) {
    // Unconditional teardown on crash/timeout/setup failure (R13).
    await teardown();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Resolve `promise`, or reject with a timeout / abort error after `timeoutMs`.
 * Used to bound startup so a hung launch is torn down rather than stranding the
 * verification run.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new Error("isolated app launch aborted before start");
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`isolated app did not become ready within ${timeoutMs}ms`));
        }, timeoutMs);
        if (signal) {
          onAbort = () => reject(new Error("isolated app launch aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
