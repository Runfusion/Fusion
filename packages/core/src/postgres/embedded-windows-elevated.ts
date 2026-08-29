// FNXC:WindowsDesktopPackaging 2026-07-17-22:30:
// Embedded PostgreSQL refuses to start under a Windows process token whose
// Administrators group is ENABLED (elevated / "Run as administrator" launches
// and GitHub windows runners). The first fix booted the server under a
// freshly-created non-admin local account ('fusion-pg') via Start-Process
// -Credential, but that approach created a real user account on operator
// machines (explicit operator complaint: Fusion must never create local
// accounts), and its cmd/PowerShell wrapper machinery produced two field
// failures: CreateProcessWithLogonW rejecting the inherited cwd ("The
// directory name is invalid") and EBUSY on the wrapper-held postgres.log.
//
// This module replaces all of that with PostgreSQL's own built-in mechanism:
// pg_ctl.exe (bundled next to postgres.exe) detects an elevated token and
// re-executes itself under a RESTRICTED token (Administrators SID disabled via
// CreateRestrictedToken; see src/common/restricted_token.c in PostgreSQL).
// The postmaster inherits that restricted token and accepts it — the same
// mechanism that already lets initdb run elevated in our boot path. No user
// account, no password, no icacls grants, no credential launch, no wrapper
// bat. The restricted token keeps the operator's own identity, so the data
// dir under the user profile stays accessible without ACL changes.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";

/** Handle returned by {@link startServerElevatedRestricted}; call stop() to kill it. */
export interface ElevatedServerHandle {
  /**
   * Best-effort OS pid of the running postgres server (from postmaster.pid when
   * available). 0 until postmaster.pid appears.
   */
  readonly postgresPid: number;
  /**
   * Stop the postgres server (pg_ctl stop -m fast, taskkill fallback). Safe to
   * call once.
   *
   * FNXC:PostgresStartupRace 2026-07-15-21:10 (semantics preserved):
   * Resolves its target through the data dir (`pg_ctl -D` / postmaster.pid), so
   * it stops whichever postmaster currently owns that dir — NOT necessarily the
   * one this handle launched. Only call it when this process is the sole
   * starter; a caller that lost a startup race must use {@link stopWrapperOnly}.
   */
  stop(): Promise<void>;
  /** Stop bounded runner-log observation without affecting PostgreSQL. */
  stopMonitoring(): void;
  /**
   * Reap only what this handle launched, never the postmaster named by the
   * shared data dir.
   *
   * FNXC:WindowsDesktopPackaging 2026-07-17-22:30:
   * With pg_ctl there is no wrapper process to reap: pg_ctl -W exits
   * immediately after spawning the postmaster, and a postmaster that lost the
   * postmaster.pid lock race exits on its own. This is therefore a no-op that
   * only marks the handle stopped, kept so the lifecycle's lost-race path
   * (which must never kill the race winner) stays shape-compatible.
   */
  stopWrapperOnly(): Promise<void>;
}

/**
 * Stateful, bounded detector for PostgreSQL's Windows DLL-init shutdown chain.
 *
 * FNXC:PostgresEmbedded 2026-07-22-16:25:
 * Restart only after the exact ordered PostgreSQL backend-crash shutdown chain.
 * A lone Windows exception, an ordinary shutdown following an earlier exception,
 * or a repeated log snapshot is not permission to restart a live cluster.
 *
 * FNXC:PostgresEmbedded 2026-07-22-22:21:
 * Issue #2411 recovery is reserved for PostgreSQL's ordered DLL-init failure:
 * backend 0xC0000142, peer termination, startup-process failure, then shutdown.
 * Do not infer a cluster crash from unordered snippets because an operator or an
 * external owner can shut down a cluster after an unrelated Windows exception.
 */
export class WindowsPostgresFatalDetector {
  private buffer = "";
  private matched = false;

  push(chunk: string): boolean {
    if (this.matched || !chunk) return false;
    this.buffer = (this.buffer + chunk).slice(-16_384);
    const text = this.buffer.toLowerCase();
    if (
      /server process(?:\s+\(pid\s+\d+\))?\s+was terminated by exception\s+0xc0000142[\s\S]*?terminating any other active server processes[\s\S]*?shutting down due to startup process failure[\s\S]*?database system is shut down/.test(
        text,
      )
    ) {
      this.matched = true;
      return true;
    }
    return false;
  }
}

export interface ElevatedStartOptions {
  /** .../native dir containing bin/postgres.exe + bin/pg_ctl.exe + lib + share. */
  readonly nativeRoot: string;
  /** The initialized PG data directory. */
  readonly dataDir: string;
  /** TCP port postgres should listen on. */
  readonly port: number;
  /** Extra flags forwarded to postgres.exe (same semantics as embedded-postgres). */
  readonly postgresFlags: readonly string[];
  readonly onLog: (message: string) => void;
  readonly onError: (messageOrError: string | Error | unknown) => void;
  /** Hard timeout (ms) on reaching "ready to accept connections". <=0 disables. */
  readonly startTimeoutMs: number;
  /** Cooperative cancellation from EmbeddedPostgresLifecycle.start(). */
  readonly signal?: AbortSignal;
  /**
   * Invoked as soon as the postmaster launch is issued (before readiness) so
   * the lifecycle can stop orphans if the outer start() timeout wins the race.
   */
  readonly onLaunched?: (handle: ElevatedServerHandle) => void;
}

let elevatedCache: boolean | null = null;

/**
 * True only on Windows when the current process holds an elevated admin token.
 * `net session` succeeds (exit 0) exclusively under an elevated admin token, so
 * it is a reliable elevation probe that does not depend on UAC EnableLUA.
 */
export function isWindowsElevatedAdmin(): boolean {
  if (process.platform !== "win32") return false;
  if (elevatedCache !== null) return elevatedCache;
  const r = spawnSync("net", ["session"], { encoding: "utf8", shell: true });
  elevatedCache = r.status === 0;
  return elevatedCache;
}

/**
 * FNXC:WindowsDesktopPackaging 2026-07-17-22:30:
 * Earlier releases created a dedicated 'fusion-pg' local account for the
 * credential-based launch. Fusion must not leave accounts it created on
 * operator machines, so the replacement path deletes it best-effort on every
 * elevated start (idempotent: exits non-zero when the account is absent).
 */
export function removeLegacyNonAdminUser(onLog: (message: string) => void): void {
  try {
    const r = spawnSync("net", ["user", "fusion-pg", "/delete"], { encoding: "utf8" });
    if (r.status === 0) {
      onLog("embedded postgres: removed the legacy 'fusion-pg' local account created by earlier versions");
    }
  } catch {
    // Cleanup is strictly best-effort; never block startup on it.
  }
}

/**
 * FNXC:WindowsDesktopPackaging 2026-07-15-05:25 (retained):
 * Reject postgresFlags that could break the pg_ctl -o option-string quoting or
 * smuggle extra options (\r\n, ", and shell-sensitive characters).
 */
export function sanitizePostgresFlags(flags: readonly string[]): string[] {
  const safe: string[] = [];
  for (const flag of flags) {
    if (typeof flag !== "string" || flag.length === 0) {
      throw new Error(`embedded postgres: invalid postgresFlags entry (empty/non-string)`);
    }
    if (/[\r\n"%&|<>^!]/.test(flag)) {
      throw new Error(
        `embedded postgres: postgresFlags entry contains quoting-sensitive characters: ${JSON.stringify(flag)}`,
      );
    }
    safe.push(flag);
  }
  return safe;
}

/**
 * Build the pg_ctl `-o` option string: server flags passed through to
 * postgres.exe. Tokens containing spaces are double-quoted (sanitize rejects
 * embedded quotes, so plain wrapping is safe).
 */
export function buildPgCtlOptionsString(port: number, flags: readonly string[]): string {
  const tokens = ["-p", String(port), ...flags];
  return tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" ");
}

/**
 * pg_ctl argv for the elevated start. `-W` (no wait) so the call returns as
 * soon as the postmaster is spawned; readiness is observed via the server log
 * and a TCP probe, matching the previous launcher's cancellable poll loop.
 * `-l` routes postmaster output to a per-launch log file.
 */
export function buildPgCtlStartArgs(dataDir: string, logFile: string, optionsString: string): string[] {
  return ["-D", dataDir, "-o", optionsString, "-l", logFile, "-W", "start"];
}

/**
 * Build a child-only Windows environment with the bundled PostgreSQL bin first.
 *
 * FNXC:PostgresEmbedded 2026-07-22-16:10:
 * PostgreSQL backend children inherit the environment used for `pg_ctl`/`postgres`.
 * Keep the resolved native `bin` directory first in that child PATH so DLL lookup
 * cannot depend on the dashboard's install shape. Windows PATH keys are
 * case-insensitive; preserve the caller's spelling and every other variable.
 */
export function withWindowsNativeBinPath(
  environment: NodeJS.ProcessEnv,
  nativeRoot: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  // `node:path` follows the host platform, while tests and cross-compiled
  // packaging can construct a Windows child environment from a non-Windows host.
  const bin = nativeRoot.replace(/[\\/]+$/, "") + "\\bin";
  const normalize = (value: string) => value.replace(/\//g, "\\").toLowerCase();
  const inherited = environment[pathKey] ?? "";
  const segments = inherited.split(";").filter(Boolean);
  const normalizedBin = normalize(bin);
  const deduplicated = segments.filter((segment) => normalize(segment) !== normalizedBin);
  return { ...environment, [pathKey]: [bin, ...deduplicated].join(";") };
}

function readPostgresPid(dataDir: string): number | null {
  try {
    const lines = readFileSync(join(dataDir, "postmaster.pid"), "utf-8").split("\n");
    const pid = parseInt((lines[0] ?? "").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readTail(file: string, max: number): string {
  try {
    const content = readFileSync(file, "utf-8");
    return content.length > max ? "…" + content.slice(-max) : content;
  } catch {
    return "(no log file)";
  }
}

/*
FNXC:PostgresEmbedded 2026-07-23-10:40:
Issue #2411 (beta.4 follow-up): the pgctl runner log used to live INSIDE the
data directory (<dataDir>/.pgrunner). On an interrupted cluster, Windows crash
recovery runs SyncDataDirectory(), which fsync-walks every file under the data
dir — including Fusion's own live pgctl log, whose write handle the postmaster
inherits from pg_ctl as its stderr. PostgreSQL's fsync open then fails with
"could not open file ./.pgrunner/pgctl-<ts>.log: sharing violation … retrying
for 30 seconds", adding a 30s stall to every crash recovery (reporter measured
~1s recovery once the log was elsewhere). The runner dir is therefore a SIBLING
of the data dir (.pgrunner-<dataDirName>), so recovery's data-dir walk can never
touch it. The legacy in-dataDir .pgrunner directory is swept best-effort.
*/
export function resolvePgRunnerDir(dataDir: string): string {
  const normalized = dataDir.replace(/[\\/]+$/, "");
  return join(dirname(normalized), `.pgrunner-${basename(normalized)}`);
}

/**
 * FNXC:WindowsDesktopPackaging 2026-07-17-22:30:
 * Per-launch log file names + best-effort pruning replace the old truncate-on
 * -launch scheme. Truncating a shared postgres.log raised EBUSY when a live
 * wrapper/postmaster from a prior attempt still held it open (field report);
 * unique names make a held file harmless, and stale ones are swept next boot.
 * Legacy wrapper artifacts (launch.bat/launch.ps1/wrapper.log/postgres.log)
 * are swept the same way.
 */
function prepareRunDir(runDir: string, legacyInDataDirRunDir?: string): string {
  mkdirSync(runDir, { recursive: true });
  // FNXC:PostgresEmbedded 2026-07-23-10:40: sweep the pre-#2411-fix runner dir
  // that lived inside the data dir; leaving it would keep the crash-recovery
  // fsync sharing-violation stall alive for upgraded installs.
  if (legacyInDataDirRunDir) {
    try {
      rmSync(legacyInDataDirRunDir, { recursive: true, force: true });
    } catch {
      // A file held open by a live process stays; it is swept on a later boot.
    }
  }
  const legacy = ["launch.bat", "launch.ps1", "wrapper.log", "postgres.log"];
  let entries: string[] = [];
  try {
    entries = readdirSync(runDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (legacy.includes(entry) || /^pgctl-\d+\.log$/.test(entry)) {
      try {
        rmSync(join(runDir, entry), { force: true });
      } catch {
        // A file held open by a live process stays; unique naming makes that harmless.
      }
    }
  }
  return join(runDir, `pgctl-${Date.now()}.log`);
}

/*
FNXC:PostgresEmbedded 2026-07-23-10:40:
Issue #2411 (beta.4 follow-up): an interrupted cluster runs crash recovery
before accepting queries, and any client that connects during that window is
rejected with `FATAL: the database system is starting up` (SQLSTATE 57P03).
Those lines are normal recovery progress, not a startup failure — treating them
as fatal is what issued a fast-shutdown request ~0.2s into recovery and wedged
the boot. Strip them (and their in-recovery sibling) before scanning the log
tail for genuine startup errors.
*/
export function containsElevatedStartupFatal(tail: string): boolean {
  const scan = tail
    .split("\n")
    .filter((line) => !/the database system is (starting up|in recovery)/i.test(line))
    .join("\n");
  return /\bFATAL\b|\bPANIC\b|could not (bind|start|create|access|connect|load)|not permitted|Permission denied|is not the owner/i.test(
    scan,
  );
}

/**
 * Start postgres.exe on an elevated Windows process via pg_ctl's restricted
 * token re-exec, and resolve once it is accepting connections. Rejects with a
 * clear error (including the postgres log tail — the lifecycle's lock-collision
 * classifier depends on seeing the postmaster.pid FATAL text) on timeout,
 * cancellation, or early exit. The returned handle's stop() kills the server.
 */
export async function startServerElevatedRestricted(
  opts: ElevatedStartOptions,
): Promise<ElevatedServerHandle> {
  removeLegacyNonAdminUser(opts.onLog);

  const pgCtl = join(opts.nativeRoot, "bin", "pg_ctl.exe");
  if (!existsSync(pgCtl)) {
    throw new Error(`embedded postgres: pg_ctl.exe not found at ${pgCtl}`);
  }
  const runDir = resolvePgRunnerDir(opts.dataDir);
  const logFile = prepareRunDir(runDir, join(opts.dataDir, ".pgrunner"));
  const safeFlags = sanitizePostgresFlags(opts.postgresFlags);
  const args = buildPgCtlStartArgs(
    opts.dataDir,
    logFile,
    buildPgCtlOptionsString(opts.port, safeFlags),
  );

  opts.onLog(
    `embedded postgres: elevated start via pg_ctl restricted token (no helper account); log ${logFile}`,
  );

  let stopped = false;
  let logMonitor: NodeJS.Timeout | null = null;
  const stopMonitoring = (): void => {
    if (logMonitor) clearInterval(logMonitor);
    logMonitor = null;
  };
  const killAll = (): void => {
    stopMonitoring();
    if (stopped) return;
    stopped = true;
    const r = spawnSync(pgCtl, ["-D", opts.dataDir, "-m", "fast", "-t", "30", "-w", "stop"], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      opts.onLog(
        `embedded postgres: pg_ctl stop status=${r.status} ` +
          `output=${`${r.stdout || ""}${r.stderr || ""}`.trim().slice(0, 400)}; falling back to taskkill`,
      );
      const pid = readPostgresPid(opts.dataDir);
      if (pid) spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { encoding: "utf8" });
    }
  };

  // FNXC:WindowsDesktopPackaging 2026-07-17-23:40:
  // stop() must not resolve while the server still accepts connections. The
  // taskkill fallback (and TerminateProcess generally) returns before socket
  // teardown finishes, and CI observed a probe connecting right after stop()
  // resolved. Wait until the port stops accepting AND postmaster.pid is gone.
  const waitForDown = async (): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const pidGone = readPostgresPid(opts.dataDir) === null;
      const portClosed = !(await probeTcpPort(opts.port, 250));
      if (pidGone && portClosed) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    opts.onError("embedded postgres: server still reachable 15s after stop request");
  };

  const handle: ElevatedServerHandle = {
    get postgresPid() {
      return readPostgresPid(opts.dataDir) ?? 0;
    },
    async stop() {
      killAll();
      await waitForDown();
    },
    stopMonitoring,
    async stopWrapperOnly() {
      // No wrapper exists on this path; a lock-race loser postmaster exits on
      // its own. Only mark stopped so a later stop() cannot kill a race winner.
      stopMonitoring();
      stopped = true;
    },
  };

  // FNXC:WindowsDesktopPackaging 2026-07-17-23:05:
  // Publish the stop handle BEFORE awaiting pg_ctl so the lifecycle's outer
  // start() timeout can reap a postmaster that got spawned but never became
  // ready (first CI run orphaned one and cleanup hit EBUSY on the data dir).
  opts.onLaunched?.(handle);

  // pg_ctl -W exits right after spawning the postmaster; await that exit
  // without blocking the event loop (dashboard boot runs on it).
  //
  // FNXC:WindowsDesktopPackaging 2026-07-17-23:05:
  // Resolve on 'exit', NOT 'close': on Windows the spawned postmaster inherits
  // pg_ctl's stdout/stderr pipe handles, so the stdio streams stay open for
  // the postmaster's lifetime and 'close' never fires (first CI run hung here
  // until the outer timeout). Output captured before exit is still reported.
  const launch = await new Promise<{ status: number | null; output: () => string }>(
    (resolve, reject) => {
      const child = spawn(pgCtl, args, {
        windowsHide: true,
        // Do not mutate process.env: sibling dashboard/engine children must
        // retain their inherited environment unchanged.
        env: withWindowsNativeBinPath(process.env, opts.nativeRoot),
      });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      child.on("error", reject);
      child.on("exit", (status: number | null) => resolve({ status, output: () => output }));
    },
  );
  if (launch.status !== 0) {
    killAll();
    throw new Error(
      `embedded postgres: pg_ctl start failed (status=${launch.status}) ` +
        `output=${launch.output().trim().slice(0, 1000)}\n${readTail(logFile, 2000)}`,
    );
  }
  opts.onLog(`embedded postgres: pg_ctl start issued (status 0); polling for readiness`);

  // Poll for readiness until the server accepts connections or the timeout
  // hits. Same lightweight readFileSync-only loop as the previous launcher
  // (spawning tasklist per iteration blew poll budgets on windows-2025).
  const hasDeadline = opts.startTimeoutMs > 0 && Number.isFinite(opts.startTimeoutMs);
  const deadline = hasDeadline ? Date.now() + opts.startTimeoutMs : Number.POSITIVE_INFINITY;
  let ready = false;
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      killAll();
      throw new Error("embedded postgres: elevated launch cancelled before ready.");
    }
    // TCP is the readiness authority. The old reader inspected pg_ctl's `-l`
    // file on every poll and made that implementation detail part of startup.
    // Diagnostic snapshots are still bounded/open-read-close only; they never
    // retain a descriptor or delay readiness when Windows reports EBUSY.
    if (await probeTcpPort(opts.port, 500)) {
      ready = true;
      break;
    }
    const tail = readTail(logFile, 3000);
    if (tail !== lastSnapshot) {
      lastSnapshot = tail;
      opts.onLog(`elevated diagnostic pg={${tail.slice(-400)}}`);
    }
    if (containsElevatedStartupFatal(tail)) {
      killAll();
      throw new Error(
        `embedded postgres: elevated postgres reported a startup error before opening the port.\n${tail}`,
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  if (!ready) {
    const tail = readTail(logFile, 1500);
    killAll();
    throw new Error(
      `embedded postgres: elevated postgres did not become ready` +
        (hasDeadline ? ` within ${opts.startTimeoutMs}ms` : "") +
        `.\n${tail}`,
    );
  }

  if (opts.signal?.aborted) {
    killAll();
    throw new Error("embedded postgres: elevated launch cancelled after ready.");
  }

  const postgresPid = readPostgresPid(opts.dataDir);
  if (!postgresPid) {
    opts.onError("embedded postgres: started but could not read postmaster.pid");
  }
  opts.onLog(
    `embedded postgres: elevated server ready on 127.0.0.1:${opts.port} (pid ${postgresPid ?? 0}, restricted token)`,
  );

  /*
  FNXC:PostgresEmbedded 2026-07-22-23:05:
  pg_ctl exits before its restricted-token postmaster, so readiness cannot end
  observation of its bounded runner log. Poll open/read/close snapshots only
  while this owned handle exists; stop, detach, and race cleanup release the
  timer. This forwards a post-ready 0xC0000142 shutdown chain to the lifecycle
  without retaining an exclusive Windows file handle.
  */
  let lastLogSnapshot = "";
  const observePostReadyLog = (): void => {
    if (stopped) return;
    const snapshot = readTail(logFile, 16_384);
    if (snapshot === "(no log file)" || snapshot === lastLogSnapshot) return;
    const next = snapshot.startsWith(lastLogSnapshot)
      ? snapshot.slice(lastLogSnapshot.length)
      : snapshot;
    lastLogSnapshot = snapshot;
    if (next) opts.onLog(next);
  };
  observePostReadyLog();
  logMonitor = setInterval(observePostReadyLog, 250);
  if (typeof logMonitor.unref === "function") logMonitor.unref();
  return handle;
}

/** True when a TCP accept is available on 127.0.0.1:port within timeoutMs. */
function probeTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
