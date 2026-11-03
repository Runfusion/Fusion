/**
 * Engine singleton lock — ensures only one engine per project per machine.
 *
 * Acquires two independent guards before the engine subsystems start:
 *
 *   1. A lockfile under `<workingDir>/.fusion/engine.lock` via `proper-lockfile`.
 *      Uses OS-level link()/atomic-rename semantics; auto-released on process
 *      death; stale locks are recovered after `STALE_MS` of no `mtime` updates.
 *
 *   2. A loopback listener on a per-project address. On POSIX this is a Unix
 *      domain socket under `os.tmpdir()`; on Windows it is a named pipe under
 *      `\\.\pipe\`. Node's `net.Server.listen(path)` abstracts both. If the
 *      address is already bound, another engine is live.
 *
 * Together the two guards cover the failure modes the other one misses:
 *   - Lockfile alone: file locks can survive an `rm -rf .fusion`.
 *   - Socket alone: stale UDS files survive crashes (we probe + unlink).
 *
 * If acquisition fails, both guards are unwound before throwing.
 */

import { mkdirSync } from "node:fs";
import { access, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { annotateEnospcError, type TempFsDiagnosticDeps } from "@fusion/core";

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;
const PROBE_TIMEOUT_MS = 500;

export interface EngineSingletonLock {
  /** Idempotent release of both the lockfile and the loopback listener. */
  release(): Promise<void>;
  /** Address of the loopback listener (UDS path or named pipe). */
  readonly socketPath: string;
  /** Path of the lockfile target. */
  readonly lockFilePath: string;
}

export class EngineAlreadyRunningError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly reason: "lockfile" | "socket",
    cause?: unknown,
  ) {
    super(
      `Another engine is already running for project ${projectId} on this machine (blocked by ${reason})`,
    );
    this.name = "EngineAlreadyRunningError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function projectHash(projectId: string): string {
  return createHash("sha1").update(projectId).digest("hex").slice(0, 16);
}

/**
 * Cross-platform local address for the loopback listener.
 *   - POSIX: UDS path under `os.tmpdir()`. macOS caps sun_path at 104 bytes,
 *     so we hash the project id to keep it short.
 *   - Windows: named pipe under `\\.\pipe\`. No length issue but we hash
 *     for symmetry and to avoid leaking project ids into the pipe namespace.
 */
export function computeEngineSocketPath(projectId: string): string {
  const hash = projectHash(projectId);
  if (platform() === "win32") {
    return `\\\\.\\pipe\\fusion-engine-${hash}`;
  }
  return join(tmpdir(), `fusion-engine-${hash}.sock`);
}

export function computeEngineLockFilePath(workingDir: string): string {
  return join(workingDir, ".fusion", "engine.lock");
}

/*
FNXC:TempFsDiagnostics 2026-11-03-08:11 (RUFU-397):
Engine boot acquires TWO filesystem-backed guards: a lockfile under `<workingDir>/.fusion/` and a Unix
socket under `os.tmpdir()`. Either creation can fail with errno 28, and `acquireEngineSingleton` used
to fold ANY creation error into `EngineAlreadyRunningError` — whose consumer
(`project-engine-manager.ts`) treats it as POSITIVE "the engine is already live here" evidence and
skips the project silently, so the operator saw a clean startup log and no engine.

This is the one lane where annotating the message is not enough: the wrong message is not the only
loss, the wrong CONTROL FLOW is. An ENOSPC-shaped creation failure therefore throws a distinct error
that is NOT `EngineAlreadyRunningError`, so the consumer's `instanceof` leg cannot swallow it and the
project lands on its honest `Engine start failed:` warning leg instead. Every other creation error
keeps the existing class and reason verbatim.
*/
export class EngineStartupEnvironmentError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly reason: "lockfile" | "socket",
    cause?: unknown,
  ) {
    super(
      `Engine startup for project ${projectId} could not create its ${reason} guard: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "EngineStartupEnvironmentError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Wraps a guard-creation failure. Returns `EngineAlreadyRunningError` for every failure the probe
 * cannot classify as a temp-filesystem failure (the pre-existing leg: unchanged object type and
 * message), and `EngineStartupEnvironmentError` when the errno-28 class IS provable — because
 * "already running" is a claim about another process, and a filesystem refusal disproves it.
 *
 * Exported for unit testing: the invariant under test is a class identity (`instanceof
 * EngineAlreadyRunningError`), which is exactly what the consumer branches on. `deps` exists so the
 * probe stays fake-based; production call sites pass nothing.
 */
/*
FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397):
The target path passed to the probe is the path the failed creation ACTUALLY targeted, and it is
recorded only as a locator — `classifyTempFs` reads the nearest existing ancestor, because a creation
failure's own target was never created. That matters most here: when `net.Server.listen()` dies with
errno 28 the `.sock` file does not exist, and an earlier revision that statfs'd the socket path got
ENOENT back, produced no opinion, and therefore produced the OLD misclassification in production
while every path-blind fake-based test stayed green. The containing tmpfs is the resource that
refused, and that is the mount the record now names.

On Windows the address is a named pipe, not a filesystem path; every probe on it fails and the helper
degrades to the original sentence, which is the card's sanctioned behaviour for that branch.
*/
export function guardCreationError(
  err: unknown,
  projectId: string,
  reason: "lockfile" | "socket",
  targetPath: string,
  deps: TempFsDiagnosticDeps = {},
): Error {
  const annotated = annotateEnospcError(err, targetPath, deps);
  if (annotated === err) {
    return new EngineAlreadyRunningError(projectId, reason, err);
  }
  return new EngineStartupEnvironmentError(projectId, reason, annotated);
}

async function ensureLockTargetExists(lockPath: string): Promise<void> {
  try {
    await access(lockPath);
  } catch {
    await writeFile(lockPath, "");
  }
}

async function acquireLockfile(
  workingDir: string,
  onCompromised: (err: Error) => void,
): Promise<{ release: () => Promise<void>; path: string }> {
  const dir = join(workingDir, ".fusion");
  mkdirSync(dir, { recursive: true });
  const path = computeEngineLockFilePath(workingDir);
  await ensureLockTargetExists(path);
  const release = await lockfile.lock(path, {
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: 0,
    realpath: false,
    onCompromised,
  });
  return { release, path };
}

function listen(server: net.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

/** Probe the loopback address — true if another process accepts connections. */
async function isAddressLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const done = (live: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), PROBE_TIMEOUT_MS).unref();
  });
}

async function bindLoopback(socketPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.end();
  });
  // Don't let the listener itself keep the process alive — the engine has
  // its own refs (scheduler timers, db handles) that determine lifetime.
  server.unref();

  try {
    await listen(server, socketPath);
    return server;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && platform() !== "win32") {
      // POSIX: stale UDS file from a crashed engine. Probe first, unlink, retry.
      const live = await isAddressLive(socketPath);
      if (!live) {
        await unlink(socketPath).catch(() => {});
        const retryServer = net.createServer((s) => s.end());
        retryServer.unref();
        await listen(retryServer, socketPath);
        return retryServer;
      }
    }
    throw err;
  }
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Acquire both guards. On any failure throws {@link EngineAlreadyRunningError}
 * (or the underlying error) and releases whatever was partially acquired.
 *
 * @param projectId  Stable per-project id (used to derive the socket address).
 * @param workingDir Project root — must exist; `.fusion/` is created if missing.
 * @param onCompromised Called if the lockfile is lost mid-flight. Defaults to a no-op.
 */
export async function acquireEngineSingleton(
  projectId: string,
  workingDir: string,
  onCompromised: (err: Error) => void = () => {},
): Promise<EngineSingletonLock> {
  let lock: { release: () => Promise<void>; path: string } | undefined;
  let server: net.Server | undefined;
  const socketPath = computeEngineSocketPath(projectId);
  try {
    try {
      lock = await acquireLockfile(workingDir, onCompromised);
    } catch (err) {
      throw guardCreationError(err, projectId, "lockfile", workingDir);
    }
    try {
      server = await bindLoopback(socketPath);
    } catch (err) {
      throw guardCreationError(err, projectId, "socket", socketPath);
    }
  } catch (err) {
    if (server) {
      await closeServer(server).catch(() => {});
    }
    if (lock) {
      await lock.release().catch(() => {});
    }
    throw err;
  }

  let released = false;
  const lockPath = lock.path;
  const release = lock.release;
  const boundServer = server;
  return {
    socketPath,
    lockFilePath: lockPath,
    async release() {
      if (released) return;
      released = true;
      await closeServer(boundServer).catch(() => {});
      await release().catch(() => {});
    },
  };
}
