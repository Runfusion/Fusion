/**
 * Global test safety guard. Runs once per worker before any test.
 *
 *  1. Records the real project root so helpers know what to protect.
 *  2. Changes process.cwd() to a per-worker temp dir (main thread only) so any
 *     accidental `process.cwd()` call resolves to a disposable path.
 *  3. Wraps `process.chdir` to reject attempts to chdir into the real .fusion.
 *  4. Wraps write-capable fs APIs so tests cannot mutate the repo's live .fusion.
 *
 * Worker temp dirs live under a single parent (FUSION_WORKER_ROOT) that is
 * wiped by the vitest globalTeardown in vitest-teardown.ts — this handles the
 * case where workers are killed (SIGKILL) and never run their exit handlers.
 */

import { afterEach, expect } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isMainThread } from "node:worker_threads";
import { assertOutsideRealFusionPath } from "../test-safety.js";
import {
  resolveReservedPortsFromEnv,
  shouldRunPortProbe,
} from "./port-probe-policy.js";

type FsModule = typeof import("node:fs");
type FsPromisesModule = typeof import("node:fs/promises");
type ChildProcessModule = typeof import("node:child_process");
type ChildProcess = import("node:child_process").ChildProcess;
type SpawnOptions = import("node:child_process").SpawnOptions;
type SpawnSyncOptions = import("node:child_process").SpawnSyncOptions;
type ExecOptions = import("node:child_process").ExecOptions;
type ExecFileOptions = import("node:child_process").ExecFileOptions;
type ExecSyncOptions = import("node:child_process").ExecSyncOptions;
type ExecFileSyncOptions = import("node:child_process").ExecFileSyncOptions;
type ForkOptions = import("node:child_process").ForkOptions;

const requireFromHere = createRequire(import.meta.url);
const fs = requireFromHere("node:fs") as FsModule;
const fsPromises = requireFromHere("node:fs/promises") as FsPromisesModule;
const childProcess = requireFromHere("node:child_process") as ChildProcessModule;
const {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  existsSync,
  writeFileSync,
} = fs;

type EmitWarningArgs = Parameters<typeof process.emitWarning>;
type EmitWarningRestArgs = EmitWarningArgs extends [string | Error, ...infer Rest] ? Rest : never;

function installWarningFilter(): void {
  const warningState = globalThis as typeof globalThis & { __fusionTestWarningFilterInstalled?: boolean };
  if (warningState.__fusionTestWarningFilterInstalled) return;
  warningState.__fusionTestWarningFilterInstalled = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: EmitWarningRestArgs) => {
    const warningText = warning instanceof Error ? warning.message : warning;
    const warningType = typeof args[0] === "string" ? args[0] : undefined;
    if (warningType === "ExperimentalWarning" && warningText.includes("SQLite is an experimental feature")) {
      return;
    }
    return originalEmitWarning(warning, ...args);
  }) as typeof process.emitWarning;
}

installWarningFilter();

// Never let a DATABASE_URL exported for the operator's normal Fusion runtime
// leak into a Vitest worker. Tests that exercise external PostgreSQL construct
// an isolated database through FUSION_PG_TEST_* and set DATABASE_URL explicitly
// inside the test after this setup file has run.
delete process.env.DATABASE_URL;
delete process.env.DATABASE_MIGRATION_URL;

const TEST_HOME_PREFIX = "fn-test-home-";
const WORKER_ROOT_OWNER_FILE = ".fusion-test-worker-root-owner";
const FUSION_TEST_RUN_TOKEN_ENV = "FUSION_TEST_RUN_TOKEN";
const DEFAULT_TEST_SUBPROCESS_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.FUSION_TEST_SUBPROCESS_TIMEOUT_MS ?? "30000", 10) || 30_000,
);
const BLOCKED_TEST_CLI_PATTERN =
  /(^|[\s"'\\/])(?:claude|droid|paperclipai|hermes|openclaw)(?:\.(?:cmd|bat|ps1|exe))?(?=$|[\s"'\\/])/i;

const originalCwd = process.cwd.bind(process);

// Harden git for every test process against host/CI differences that silently
// broke git-worktree tests in CI only (they pass on developer macOS machines):
//
//  1. Pin `git init` to the `main` branch. Git defaults the initial branch to
//     `master` unless `init.defaultBranch` is set — true on Linux CI runners
//     but usually `main` on dev machines. The gap broke worktree tests that
//     assume `main` (e.g. the shared-branch-group reliability suite).
//  2. Never block on an interactive prompt. A Linux CI git can hang forever
//     waiting on a credential/editor/pager prompt where a dev's git config
//     suppresses it — the suite then runs to the job timeout and is killed
//     with no test failure. Disable terminal prompts, the editor, and pagers.
//
// GIT_CONFIG_* applies config to all child git invocations without mutating the
// developer's global config; the prompt/editor/pager env vars are inherited by
// every spawned git. Config entries are appended, not clobbered.
(() => {
  const base = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const entries: Array<[string, string]> = [["init.defaultBranch", "main"]];
  entries.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${base + i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(base + entries.length);

  process.env.GIT_TERMINAL_PROMPT ??= "0"; // never prompt for credentials
  process.env.GIT_EDITOR ??= "true";       // merges/rebases never open an editor
  process.env.GIT_PAGER ??= "cat";         // no pager waiting on a TTY
})();

function ensureValidCwd(): string {
  try {
    return originalCwd();
  } catch {
    const fallback = tmpdir();
    try {
      process.chdir(fallback);
    } catch {
      // Ignore — if this fails too, callers will still get fallback.
    }
    return fallback;
  }
}

// Guard against uv_cwd crashes if a prior test removed the current directory.
process.cwd = (() => {
  return function guardedCwd() {
    return ensureValidCwd();
  };
})() as typeof process.cwd;

const realProjectRootRaw = ensureValidCwd();
const realProjectRoot = (() => {
  try {
    return realpathSync(realProjectRootRaw);
  } catch {
    return resolve(realProjectRootRaw);
  }
})();

function findRepoRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(join(current, ".fusion")) || existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

const repoRoot = findRepoRoot(realProjectRoot);
process.env.FUSION_TEST_REAL_ROOT = repoRoot;

// Prevent MasterKeyManager from hitting the real macOS/Linux keychain during
// tests — keytar can block for 15s+ on CI-like environments. Tests that need
// to exercise the keychain branch inject a fake KeytarLike via the constructor.
if (!process.env.FUSION_MASTER_KEY_DISABLE_KEYCHAIN) {
  process.env.FUSION_MASTER_KEY_DISABLE_KEYCHAIN = "1";
}

// Shared parent directory for all worker temp dirs in this Vitest invocation.
// Keep this per-run (globalSetup seeds FUSION_TEST_WORKER_ROOT) instead of a
// single long-lived tmpdir/fusion-test-workers directory: redirect setup does a
// bounded one-level sweep of WORKER_ROOT, and a static root can accumulate enough
// stale worker/home dirs after interrupted runs to make every mkdtempSync call
// take seconds.
function ensureTestRunToken(): string {
  const existing = process.env[FUSION_TEST_RUN_TOKEN_ENV];
  if (existing && existing.trim().length > 0) return existing;
  const token = randomUUID();
  process.env[FUSION_TEST_RUN_TOKEN_ENV] = token;
  return token;
}

function writeWorkerRootOwnerMarker(root: string): void {
  try {
    writeFileSync(
      join(root, WORKER_ROOT_OWNER_FILE),
      `${process.pid}\nrunToken=${ensureTestRunToken()}\n`,
    );
  } catch {
    // Best effort only. The marker helps the pnpm-test runner distinguish a
    // live same-run root from stale pid reuse; local exit cleanup still owns
    // self-minted fallback roots by absolute path.
  }
}

const { root: WORKER_ROOT, selfMinted: SELF_MINTED_WORKER_ROOT } = (() => {
  const fromEnv = process.env.FUSION_TEST_WORKER_ROOT;
  const selfMinted = !(fromEnv && fromEnv.trim().length > 0);
  const root = selfMinted
    ? realpathSync(mkdtempSync(join(tmpdir(), "fusion-test-workers-")))
    : resolve(fromEnv);
  try { mkdirSync(root, { recursive: true }); } catch { /* ignore */ }
  process.env.FUSION_TEST_WORKER_ROOT = root;
  ensureTestRunToken();
  if (selfMinted) {
    // FN-6396/FN-6360 recurrence: without globalSetup there is no teardown
    // owner for this fallback root. Mark it and remove the root itself on exit
    // so an empty fusion-test-workers-* shell cannot trip check-test-isolation.
    writeWorkerRootOwnerMarker(root);
  }
  return { root, selfMinted };
})();

const REAL_TMPDIR = (() => {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
})();
const REAL_WORKER_ROOT = (() => {
  try {
    return realpathSync(WORKER_ROOT);
  } catch {
    return resolve(WORKER_ROOT);
  }
})();

const TMPDIR_REDIRECT_REGISTRY = join(WORKER_ROOT, ".redir-pids");
let tmpdirRedirectSink: string | null = null;
let tmpdirRedirectExitCleanupInstalled = false;
let tmpdirRedirectSweepComplete = false;

function ensureWorkerRoot(): void {
  /*
  FNXC:TestIsolation 2026-06-14-01:55:
  Concurrent Vitest lanes can observe a worker-root cleanup race where the per-invocation root disappears after module initialization but before a worker creates HOME or cwd directories.
  Recreate the root immediately before every mkdtemp under it so a transient sibling teardown cannot fail suite startup with ENOENT.

  FNXC:TestIsolation 2026-06-14-02:08:
  When this helper recreates a removed root, it must also restore the owner marker; otherwise the post-test isolation guard reports the still-active rebuilt root as an unowned leak.
  */
  mkdirSync(WORKER_ROOT, { recursive: true });
  writeWorkerRootOwnerMarker(WORKER_ROOT);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function removeTmpdirRedirectSinkForPid(ownerPid: number): void {
  if (ownerPid === process.pid || isProcessAlive(ownerPid)) return;

  try {
    rmSync(join(WORKER_ROOT, `redir-${ownerPid}`), { recursive: true, force: true });
  } catch {
    // Ignore stale-sink cleanup failures; global teardown still owns WORKER_ROOT.
  }
}

function sweepDeadTmpdirRedirectSinks(): void {
  if (tmpdirRedirectSweepComplete) return;
  tmpdirRedirectSweepComplete = true;

  // Registry-backed cleanup avoids scanning the OS temp root while still
  // reclaiming redirect sinks from fork-pool workers that were hard-killed.
  let ownerPids: number[] = [];
  try {
    ownerPids = Array.from(new Set(
      readFileSync(TMPDIR_REDIRECT_REGISTRY, "utf8")
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ));
  } catch {
    // The registry may not exist yet. The bounded WORKER_ROOT sweep below still
    // catches legacy redirect dirs created before the registry was introduced.
  }

  const liveOwnerPids: number[] = [];
  for (const ownerPid of ownerPids) {
    if (ownerPid === process.pid || isProcessAlive(ownerPid)) {
      liveOwnerPids.push(ownerPid);
      continue;
    }

    removeTmpdirRedirectSinkForPid(ownerPid);
  }

  // Preserve the local self-healing behavior for redirect dirs that predate the
  // registry or whose registry append was skipped. This is a single-level scan
  // of WORKER_ROOT (not the OS temp root) and only touches dead pid-owned dirs.
  try {
    for (const entry of readdirSync(WORKER_ROOT)) {
      const match = /^redir-(\d+)$/.exec(entry);
      if (!match) continue;
      const ownerPid = Number.parseInt(match[1], 10);
      if (ownerPid === process.pid || liveOwnerPids.includes(ownerPid) || isProcessAlive(ownerPid)) {
        continue;
      }
      removeTmpdirRedirectSinkForPid(ownerPid);
    }
  } catch {
    // Best-effort only; stale entries are harmless and swept by future workers.
  }

  try {
    writeFileSync(TMPDIR_REDIRECT_REGISTRY, liveOwnerPids.length > 0 ? `${liveOwnerPids.join("\n")}\n` : "");
  } catch {
    // Best-effort only; stale entries are harmless and swept by future workers.
  }
}

export const __fusionTmpdirRedirectTestHooks = {
  workerRoot: WORKER_ROOT,
  registryPath: TMPDIR_REDIRECT_REGISTRY,
  sinkForPid(pid: number): string {
    return join(WORKER_ROOT, `redir-${pid}`);
  },
  resetSweepForTest(): void {
    tmpdirRedirectSweepComplete = false;
  },
  sweepDeadTmpdirRedirectSinks,
};

function ensureTmpdirRedirectSink(): string {
  ensureWorkerRoot();
  if (tmpdirRedirectSink) {
    // FN-6310: recovery-timeout cleanup can remove a live worker's cached
    // redirect sink; recreate it on demand so later mkdtemp calls don't ENOENT.
    mkdirSync(tmpdirRedirectSink, { recursive: true });
    return tmpdirRedirectSink;
  }

  sweepDeadTmpdirRedirectSinks();
  const sink = join(WORKER_ROOT, `redir-${process.pid}`);
  mkdirSync(sink, { recursive: true });
  try {
    appendFileSync(TMPDIR_REDIRECT_REGISTRY, `${process.pid}\n`);
  } catch {
    // Best-effort only; the process exit hook and global teardown still clean up.
  }
  tmpdirRedirectSink = sink;

  if (!tmpdirRedirectExitCleanupInstalled) {
    tmpdirRedirectExitCleanupInstalled = true;
    process.once("exit", () => {
      try {
        rmSync(sink, { recursive: true, force: true });
      } catch {
        // Best-effort only. vitest globalTeardown also sweeps WORKER_ROOT.
      }
    });
  }

  return sink;
}

/**
 * If a mkdtemp prefix points straight at the OS temp root, rewrite it into a
 * swept per-process sink under WORKER_ROOT. Prefixes already nested under a
 * subdirectory pass through unchanged, as do non-string prefixes (Buffer/URL).
 */
function redirectTmpdirPrefix<T>(prefix: T): T {
  if (typeof prefix !== "string") return prefix;

  const parent = dirname(prefix);
  if (parent !== tmpdir() && parent !== REAL_TMPDIR) return prefix;

  return join(ensureTmpdirRedirectSink(), basename(prefix)) as T;
}

function isWorkerHomePath(path: string | undefined): boolean {
  if (!path) return false;
  const resolved = (() => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  })();
  const workerRoots = Array.from(new Set([resolve(WORKER_ROOT), REAL_WORKER_ROOT]));
  return workerRoots.some((root) => {
    const relativeHome = relative(root, resolved);
    return Boolean(relativeHome)
      && !relativeHome.startsWith("..")
      && !isAbsolute(relativeHome)
      && basename(resolved).startsWith(TEST_HOME_PREFIX);
  });
}

function isCurrentWorkerHome(path: string | undefined): boolean {
  if (!isWorkerHomePath(path)) return false;
  if (!existsSync(path!)) {
    ensureWorkerRoot();
    mkdirSync(path!, { recursive: true });
  }
  return existsSync(path!);
}

function assignHomeEnv(tempHome: string): void {
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  if (process.platform === "win32") {
    const match = tempHome.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      process.env.HOMEDRIVE = match[1];
      process.env.HOMEPATH = match[2] || "\\";
    }
  }
}

function ensureIsolatedHome(): void {
  const existingHome = process.env.HOME ?? process.env.USERPROFILE;
  if (isCurrentWorkerHome(existingHome)) {
    return;
  }

  ensureWorkerRoot();
  /*
  FNXC:TestIsolation 2026-06-14-00:31:
  Nested or recursive Vitest lanes may inherit a parent worker's `fn-test-home-*` HOME value, which shares global settings/cache state across files and keeps CLI suites load-sensitive.
  Reuse HOME only when it belongs to this invocation's worker root; otherwise mint a fresh per-run HOME under `fusion-test-workers-*` so teardown removes it with the worker root.

  FNXC:TestIsolation 2026-06-18-07:22:
  FN-6610 requires a live worker's HOME redirect to survive sibling teardown without leaking a new `fn-test-home-*` directory per subprocess.
  Recreate the owned HOME path when it was swept so repeated git/config subprocesses keep one stable per-worker HOME.
  */
  const tempHome = realpathSync(mkdtempSync(join(WORKER_ROOT, `${TEST_HOME_PREFIX}${process.pid}-`)));
  assignHomeEnv(tempHome);
}

ensureIsolatedHome();

let workerTempDir: string | null = null;
if (isMainThread) {
  ensureWorkerRoot();
  workerTempDir = realpathSync(
    mkdtempSync(join(WORKER_ROOT, `w-${process.pid}-`))
  );
  process.chdir(workerTempDir);
}

function ensureWorkerCwdForSubprocess(): void {
  if (!isMainThread) return;
  try {
    originalCwd();
    return;
  } catch {
    // Recreate below. A child process launched while uv_cwd is invalid fails
    // before its own command can run, so the subprocess seam must repair cwd.
  }

  ensureWorkerRoot();
  if (!workerTempDir || !existsSync(workerTempDir)) {
    workerTempDir = realpathSync(mkdtempSync(join(WORKER_ROOT, `w-${process.pid}-`)));
  }
  process.chdir(workerTempDir);
}

function ensureRuntimeIsolationForSubprocess(): void {
  /*
  FNXC:TestIsolation 2026-06-18-07:22:
  FN-6610 traced engine-lane git/config failures to live workers inheriting a swept cwd or `fn-test-home-*` directory after setup.
  Revalidate cwd and HOME immediately before subprocess launch so real-git tests do not depend on setup-time paths surviving sibling teardown or recovery cleanup.
  */
  ensureWorkerRoot();
  ensureIsolatedHome();
  ensureWorkerCwdForSubprocess();
}

function installFsGuards(): void {
  const guardState = globalThis as typeof globalThis & { __fusionTestFsGuardInstalled?: boolean };
  if (guardState.__fusionTestFsGuardInstalled) return;
  guardState.__fusionTestFsGuardInstalled = true;

  const mutableFs = fs as unknown as Record<string, unknown>;
  const mutableFsPromises = fsPromises as unknown as Record<string, unknown>;

  const originalFs = {
    mkdirSync: fs.mkdirSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    appendFileSync: fs.appendFileSync.bind(fs),
    rmSync: fs.rmSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    rmdirSync: fs.rmdirSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    copyFileSync: fs.copyFileSync.bind(fs),
    cpSync: fs.cpSync.bind(fs),
    mkdtempSync: fs.mkdtempSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    createWriteStream: fs.createWriteStream.bind(fs),
    truncateSync: fs.truncateSync.bind(fs),
    linkSync: fs.linkSync.bind(fs),
    symlinkSync: fs.symlinkSync.bind(fs),
    mkdir: fs.mkdir.bind(fs),
    writeFile: fs.writeFile.bind(fs),
    appendFile: fs.appendFile.bind(fs),
    rm: fs.rm.bind(fs),
    unlink: fs.unlink.bind(fs),
    rmdir: fs.rmdir.bind(fs),
    rename: fs.rename.bind(fs),
    copyFile: fs.copyFile.bind(fs),
    cp: fs.cp.bind(fs),
    open: fs.open.bind(fs),
    truncate: fs.truncate.bind(fs),
    link: fs.link.bind(fs),
    symlink: fs.symlink.bind(fs),
  };

  const originalFsPromises = {
    mkdir: fsPromises.mkdir.bind(fsPromises),
    writeFile: fsPromises.writeFile.bind(fsPromises),
    appendFile: fsPromises.appendFile.bind(fsPromises),
    rm: fsPromises.rm.bind(fsPromises),
    unlink: fsPromises.unlink.bind(fsPromises),
    rmdir: fsPromises.rmdir.bind(fsPromises),
    rename: fsPromises.rename.bind(fsPromises),
    copyFile: fsPromises.copyFile.bind(fsPromises),
    cp: fsPromises.cp.bind(fsPromises),
    open: fsPromises.open.bind(fsPromises),
    mkdtemp: fsPromises.mkdtemp.bind(fsPromises),
    truncate: fsPromises.truncate.bind(fsPromises),
    link: fsPromises.link.bind(fsPromises),
    symlink: fsPromises.symlink.bind(fsPromises),
  };

  const guardOne = (pathValue: unknown, context: string) => {
    if (pathValue === undefined || pathValue === null) return;
    assertOutsideRealFusionPath(pathValue as Parameters<typeof assertOutsideRealFusionPath>[0], context);
  };
  const guardBoth = (source: unknown, target: unknown, context: string) => {
    guardOne(source, `${context} source`);
    guardOne(target, `${context} target`);
  };

  mutableFs.mkdirSync = ((path, options) => {
    guardOne(path, "fs.mkdirSync");
    return originalFs.mkdirSync(path, options as Parameters<typeof fs.mkdirSync>[1]);
  }) as typeof fs.mkdirSync;
  mutableFs.writeFileSync = ((path, data, options) => {
    guardOne(path, "fs.writeFileSync");
    return originalFs.writeFileSync(path, data, options as Parameters<typeof fs.writeFileSync>[2]);
  }) as typeof fs.writeFileSync;
  mutableFs.appendFileSync = ((path, data, options) => {
    guardOne(path, "fs.appendFileSync");
    return originalFs.appendFileSync(path, data, options as Parameters<typeof fs.appendFileSync>[2]);
  }) as typeof fs.appendFileSync;
  mutableFs.rmSync = ((path, options) => {
    guardOne(path, "fs.rmSync");
    return originalFs.rmSync(path, options as Parameters<typeof fs.rmSync>[1]);
  }) as typeof fs.rmSync;
  mutableFs.unlinkSync = ((path) => {
    guardOne(path, "fs.unlinkSync");
    return originalFs.unlinkSync(path);
  }) as typeof fs.unlinkSync;
  mutableFs.rmdirSync = ((path, options) => {
    guardOne(path, "fs.rmdirSync");
    return originalFs.rmdirSync(path, options as Parameters<typeof fs.rmdirSync>[1]);
  }) as typeof fs.rmdirSync;
  mutableFs.renameSync = ((oldPath, newPath) => {
    guardBoth(oldPath, newPath, "fs.renameSync");
    return originalFs.renameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  mutableFs.copyFileSync = ((src, dest, mode) => {
    guardBoth(src, dest, "fs.copyFileSync");
    return originalFs.copyFileSync(src, dest, mode as Parameters<typeof fs.copyFileSync>[2]);
  }) as typeof fs.copyFileSync;
  mutableFs.cpSync = ((src, dest, options) => {
    guardBoth(src, dest, "fs.cpSync");
    return originalFs.cpSync(src, dest, options as Parameters<typeof fs.cpSync>[2]);
  }) as typeof fs.cpSync;
  mutableFs.mkdtempSync = ((prefix, options) => {
    const redirectedPrefix = redirectTmpdirPrefix(prefix);
    guardOne(redirectedPrefix, "fs.mkdtempSync");
    return originalFs.mkdtempSync(redirectedPrefix, options as Parameters<typeof fs.mkdtempSync>[1]);
  }) as typeof fs.mkdtempSync;
  mutableFs.openSync = ((path, flags, mode) => {
    guardOne(path, "fs.openSync");
    return originalFs.openSync(path, flags, mode as Parameters<typeof fs.openSync>[2]);
  }) as typeof fs.openSync;
  mutableFs.createWriteStream = ((path, options) => {
    guardOne(path, "fs.createWriteStream");
    return originalFs.createWriteStream(path, options as Parameters<typeof fs.createWriteStream>[1]);
  }) as typeof fs.createWriteStream;
  mutableFs.truncateSync = ((path, len) => {
    guardOne(path, "fs.truncateSync");
    return originalFs.truncateSync(path, len as Parameters<typeof fs.truncateSync>[1]);
  }) as typeof fs.truncateSync;
  mutableFs.linkSync = ((existingPath, newPath) => {
    guardBoth(existingPath, newPath, "fs.linkSync");
    return originalFs.linkSync(existingPath, newPath);
  }) as typeof fs.linkSync;
  mutableFs.symlinkSync = ((target, path, type) => {
    guardBoth(target, path, "fs.symlinkSync");
    return originalFs.symlinkSync(target, path, type as Parameters<typeof fs.symlinkSync>[2]);
  }) as typeof fs.symlinkSync;

  mutableFs.mkdir = ((...args: Parameters<typeof fs.mkdir>) => {
    guardOne(args[0], "fs.mkdir");
    return originalFs.mkdir(...args);
  }) as typeof fs.mkdir;
  mutableFs.writeFile = ((...args: Parameters<typeof fs.writeFile>) => {
    guardOne(args[0], "fs.writeFile");
    return originalFs.writeFile(...args);
  }) as typeof fs.writeFile;
  mutableFs.appendFile = ((...args: Parameters<typeof fs.appendFile>) => {
    guardOne(args[0], "fs.appendFile");
    return originalFs.appendFile(...args);
  }) as typeof fs.appendFile;
  mutableFs.rm = ((...args: Parameters<typeof fs.rm>) => {
    guardOne(args[0], "fs.rm");
    return originalFs.rm(...args);
  }) as typeof fs.rm;
  mutableFs.unlink = ((...args: Parameters<typeof fs.unlink>) => {
    guardOne(args[0], "fs.unlink");
    return originalFs.unlink(...args);
  }) as typeof fs.unlink;
  mutableFs.rmdir = ((...args: Parameters<typeof fs.rmdir>) => {
    guardOne(args[0], "fs.rmdir");
    return originalFs.rmdir(...args);
  }) as typeof fs.rmdir;
  mutableFs.rename = ((...args: Parameters<typeof fs.rename>) => {
    guardBoth(args[0], args[1], "fs.rename");
    return originalFs.rename(...args);
  }) as typeof fs.rename;
  mutableFs.copyFile = ((...args: Parameters<typeof fs.copyFile>) => {
    guardBoth(args[0], args[1], "fs.copyFile");
    return originalFs.copyFile(...args);
  }) as typeof fs.copyFile;
  mutableFs.cp = ((...args: Parameters<typeof fs.cp>) => {
    guardBoth(args[0], args[1], "fs.cp");
    return originalFs.cp(...args);
  }) as typeof fs.cp;
  mutableFs.open = ((...args: Parameters<typeof fs.open>) => {
    guardOne(args[0], "fs.open");
    return originalFs.open(...args);
  }) as typeof fs.open;
  mutableFs.truncate = ((...args: Parameters<typeof fs.truncate>) => {
    guardOne(args[0], "fs.truncate");
    return originalFs.truncate(...args);
  }) as typeof fs.truncate;
  mutableFs.link = ((...args: Parameters<typeof fs.link>) => {
    guardBoth(args[0], args[1], "fs.link");
    return originalFs.link(...args);
  }) as typeof fs.link;
  mutableFs.symlink = ((...args: Parameters<typeof fs.symlink>) => {
    guardBoth(args[0], args[1], "fs.symlink");
    return originalFs.symlink(...args);
  }) as typeof fs.symlink;

  mutableFsPromises.mkdir = (async (...args: Parameters<typeof fsPromises.mkdir>) => {
    guardOne(args[0], "fs.promises.mkdir");
    return originalFsPromises.mkdir(...args);
  }) as typeof fsPromises.mkdir;
  mutableFsPromises.writeFile = (async (...args: Parameters<typeof fsPromises.writeFile>) => {
    guardOne(args[0], "fs.promises.writeFile");
    return originalFsPromises.writeFile(...args);
  }) as typeof fsPromises.writeFile;
  mutableFsPromises.appendFile = (async (...args: Parameters<typeof fsPromises.appendFile>) => {
    guardOne(args[0], "fs.promises.appendFile");
    return originalFsPromises.appendFile(...args);
  }) as typeof fsPromises.appendFile;
  mutableFsPromises.rm = (async (...args: Parameters<typeof fsPromises.rm>) => {
    guardOne(args[0], "fs.promises.rm");
    return originalFsPromises.rm(...args);
  }) as typeof fsPromises.rm;
  mutableFsPromises.unlink = (async (...args: Parameters<typeof fsPromises.unlink>) => {
    guardOne(args[0], "fs.promises.unlink");
    return originalFsPromises.unlink(...args);
  }) as typeof fsPromises.unlink;
  mutableFsPromises.rmdir = (async (...args: Parameters<typeof fsPromises.rmdir>) => {
    guardOne(args[0], "fs.promises.rmdir");
    return originalFsPromises.rmdir(...args);
  }) as typeof fsPromises.rmdir;
  mutableFsPromises.rename = (async (...args: Parameters<typeof fsPromises.rename>) => {
    guardBoth(args[0], args[1], "fs.promises.rename");
    return originalFsPromises.rename(...args);
  }) as typeof fsPromises.rename;
  mutableFsPromises.copyFile = (async (...args: Parameters<typeof fsPromises.copyFile>) => {
    guardBoth(args[0], args[1], "fs.promises.copyFile");
    return originalFsPromises.copyFile(...args);
  }) as typeof fsPromises.copyFile;
  mutableFsPromises.cp = (async (...args: Parameters<typeof fsPromises.cp>) => {
    guardBoth(args[0], args[1], "fs.promises.cp");
    return originalFsPromises.cp(...args);
  }) as typeof fsPromises.cp;
  mutableFsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
    guardOne(args[0], "fs.promises.open");
    return originalFsPromises.open(...args);
  }) as typeof fsPromises.open;
  mutableFsPromises.mkdtemp = (async (...args: Parameters<typeof fsPromises.mkdtemp>) => {
    const redirectedPrefix = redirectTmpdirPrefix(args[0]);
    guardOne(redirectedPrefix, "fs.promises.mkdtemp");
    return originalFsPromises.mkdtemp(redirectedPrefix, args[1]);
  }) as typeof fsPromises.mkdtemp;
  mutableFsPromises.truncate = (async (...args: Parameters<typeof fsPromises.truncate>) => {
    guardOne(args[0], "fs.promises.truncate");
    return originalFsPromises.truncate(...args);
  }) as typeof fsPromises.truncate;
  mutableFsPromises.link = (async (...args: Parameters<typeof fsPromises.link>) => {
    guardBoth(args[0], args[1], "fs.promises.link");
    return originalFsPromises.link(...args);
  }) as typeof fsPromises.link;
  mutableFsPromises.symlink = (async (...args: Parameters<typeof fsPromises.symlink>) => {
    guardBoth(args[0], args[1], "fs.promises.symlink");
    return originalFsPromises.symlink(...args);
  }) as typeof fsPromises.symlink;

  syncBuiltinESMExports();
}

installFsGuards();

const originalChdir = process.chdir.bind(process);
process.chdir = (target: string) => {
  assertOutsideRealFusionPath(target, "process.chdir");
  originalChdir(target);
};

type TrackedSubprocess = {
  commandLine: string;
  startedAt: number;
  timeoutTimer: NodeJS.Timeout | null;
  timedOut: boolean;
  testName: string | null;
};

const originalChildProcess = {
  spawn: childProcess.spawn.bind(childProcess),
  spawnSync: childProcess.spawnSync.bind(childProcess),
  exec: childProcess.exec.bind(childProcess),
  execFile: childProcess.execFile.bind(childProcess),
  execSync: childProcess.execSync.bind(childProcess),
  execFileSync: childProcess.execFileSync.bind(childProcess),
  fork: childProcess.fork.bind(childProcess),
};

const trackedSubprocesses = new Map<ChildProcess, TrackedSubprocess>();

// Typed failure record so afterEach can attribute each timed-out subprocess
// back to the test that spawned it rather than blindly throwing in whichever
// test happens to run next (cascade false-positives).
type CompletedSubprocessFailure = { ownerTestName: string | null; message: string };
const completedSubprocessFailures: CompletedSubprocessFailure[] = [];

function describeTestSubprocessCommand(command: string, args?: readonly string[]): string {
  return [command, ...(args ?? [])].join(" ").trim();
}

function currentTestName(): string | null {
  return expect.getState().currentTestName ?? null;
}

// Cheap, no-network introspection invocations are safe to run in tests — they
// don't open an AI session, don't hit a paid API, and the dashboard's CLI
// availability probe needs them to tell the truth about the local system.
//
// This must stay strict: only exact "is this binary installed / what version is
// it?" probes are allowed. Do not match `--help` / `--version` substrings
// inside arbitrary prompt text, or the test guard can be bypassed.
const SAFE_INTROSPECTION_LOOKUP_PATTERN =
  /^\s*(?:which|where|type)\s+(?:-[a-zA-Z]+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s*$/i;
const SAFE_INTROSPECTION_COMMAND_V_PATTERN =
  /^\s*command\s+-v\s+(?:"[^"]+"|'[^']+'|\S+)\s*$/i;
const SAFE_INTROSPECTION_BLOCKED_CLI_PATTERN =
  /^\s*(?:"[^"]*(?:claude|droid|paperclipai|hermes|openclaw)(?:\.(?:cmd|bat|ps1|exe))?[^"]*"|'[^']*(?:claude|droid|paperclipai|hermes|openclaw)(?:\.(?:cmd|bat|ps1|exe))?[^']*'|(?:\S+[\\/])?(?:claude|droid|paperclipai|hermes|openclaw)(?:\.(?:cmd|bat|ps1|exe))?)\s+(?:--version|--help|-V|-h)\s*$/i;

function isSafeIntrospectionCommand(commandLine: string): boolean {
  return (
    SAFE_INTROSPECTION_LOOKUP_PATTERN.test(commandLine) ||
    SAFE_INTROSPECTION_COMMAND_V_PATTERN.test(commandLine) ||
    SAFE_INTROSPECTION_BLOCKED_CLI_PATTERN.test(commandLine)
  );
}

function shouldBlockRealTestCli(commandLine: string): boolean {
  if (process.env.FUSION_TEST_ALLOW_REAL_AI_CLI === "1") {
    return false;
  }
  if (!BLOCKED_TEST_CLI_PATTERN.test(commandLine)) {
    return false;
  }
  return !isSafeIntrospectionCommand(commandLine);
}

// The live Fusion dashboard port(s) must not be killed by tests. We protect:
//   - the documented default (4040)
//   - process.env.PORT (set by `fusion serve` / desktop / docker)
//   - process.env.FUSION_SERVER_PORT (set when desktop spawns serve)
//   - any ports listed in FUSION_RESERVED_PORTS (comma-separated escape hatch)
//   - any port detected by a synchronous probe of localhost candidates
// Detection runs once per worker at setup time so the regex set is stable.
// parsePortList / shouldRunPortProbe / resolveReservedPortsFromEnv live in
// ./port-probe-policy.ts so they can be unit-tested without importing this
// side-effectful setup module.

async function probeFusionHealthPort(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const text = await response.text();
    // The Fusion dashboard health payload always includes a `status` field.
    return /"status"\s*:/.test(text);
  } catch {
    return false;
  }
}

async function detectLiveFusionPorts(candidates: readonly number[]): Promise<number[]> {
  const results = await Promise.all(
    candidates.map(async (port) => ((await probeFusionHealthPort(port, 250)) ? port : null)),
  );
  return results.filter((port): port is number => port !== null);
}

// U3: the per-worker 4040–4045 discovery probe exists to detect a *live local*
// dashboard so tests can't kill it. In CI there is never a live dashboard, so
// shouldRunPortProbe() (in ./port-probe-policy.ts) skips the six
// fetch-with-250ms-timeout calls per worker. This conditions only *discovery*;
// the reserved-port block wrapper (RESERVED_PORT_KILL_PATTERNS) is untouched and
// the default plus any declared ports remain in the guard set regardless.
async function resolveReservedFusionPorts(): Promise<number[]> {
  const reserved = resolveReservedPortsFromEnv(process.env);
  if (shouldRunPortProbe(process.env)) {
    const probeRange = [4040, 4041, 4042, 4043, 4044, 4045];
    for (const port of await detectLiveFusionPorts(probeRange)) reserved.add(port);
  }
  return [...reserved];
}

const RESERVED_FUSION_PORTS = await resolveReservedFusionPorts();

function buildPortKillPatterns(ports: readonly number[]): readonly RegExp[] {
  return ports.flatMap((port) => {
    const p = String(port);
    return [
      new RegExp(`\\b(?:kill|pkill|killall|fuser)\\b[^\\n]*\\b${p}\\b`),
      new RegExp(`\\blsof\\b[^\\n]*\\b${p}\\b`),
      new RegExp(`\\b${p}\\b[^\\n]*\\b(?:kill|pkill|killall|fuser)\\b`),
    ];
  });
}

const RESERVED_PORT_KILL_PATTERNS = buildPortKillPatterns(RESERVED_FUSION_PORTS);

function shouldBlockReservedPortKill(commandLine: string): boolean {
  return RESERVED_PORT_KILL_PATTERNS.some((pattern) => pattern.test(commandLine));
}

function blockedReservedPortError(commandLine: string): Error {
  return new Error(
    `Reserved Fusion port kill blocked during tests: ${commandLine}\n` +
    `Reserved ports: ${RESERVED_FUSION_PORTS.join(", ")}. ` +
    "Use --port 0 or another free port for test servers.",
  );
}

function blockedCliError(commandLine: string): Error {
  return new Error(
    `Real AI CLI launch blocked during tests: ${commandLine}\n` +
    "Mock node:child_process for this case, or set FUSION_TEST_ALLOW_REAL_AI_CLI=1 for an explicitly bounded integration test.",
  );
}

function withDefaultTimeout<T extends { timeout?: number | undefined }>(options: T | undefined): T {
  if (typeof options?.timeout === "number" && Number.isFinite(options.timeout)) {
    return options;
  }
  return {
    ...(options ?? {}),
    timeout: DEFAULT_TEST_SUBPROCESS_TIMEOUT_MS,
  } as T;
}

function cleanupTrackedSubprocess(proc: ChildProcess): void {
  const tracked = trackedSubprocesses.get(proc);
  if (!tracked) return;
  if (tracked.timeoutTimer) {
    clearTimeout(tracked.timeoutTimer);
    tracked.timeoutTimer = null;
  }
  trackedSubprocesses.delete(proc);
}

function registerTrackedSubprocess(proc: ChildProcess, commandLine: string): void {
  const tracked: TrackedSubprocess = {
    commandLine,
    startedAt: Date.now(),
    timeoutTimer: null,
    timedOut: false,
    testName: currentTestName(),
  };
  trackedSubprocesses.set(proc, tracked);

  tracked.timeoutTimer = setTimeout(() => {
    tracked.timedOut = true;
    completedSubprocessFailures.push({
      ownerTestName: tracked.testName,
      message: `Timed out after ${DEFAULT_TEST_SUBPROCESS_TIMEOUT_MS}ms: ${tracked.commandLine}${tracked.testName ? ` (${tracked.testName})` : ""}`,
    });
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore — the process may have already exited.
    }
  }, DEFAULT_TEST_SUBPROCESS_TIMEOUT_MS);

  const finish = () => cleanupTrackedSubprocess(proc);
  proc.once("close", finish);
  proc.once("error", finish);
}

function installChildProcessGuards(): void {
  const guardState = globalThis as typeof globalThis & { __fusionTestChildProcessGuardInstalled?: boolean };
  if (guardState.__fusionTestChildProcessGuardInstalled) return;
  guardState.__fusionTestChildProcessGuardInstalled = true;

  const mutableChildProcess = childProcess as unknown as Record<string, unknown>;

  mutableChildProcess.spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
    const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
    const options = Array.isArray(argsOrOptions) ? (maybeOptions ?? {}) : (argsOrOptions ?? {});
    const commandLine = describeTestSubprocessCommand(command, args);
    if (shouldBlockReservedPortKill(commandLine)) {
      throw blockedReservedPortError(commandLine);
    }
    if (shouldBlockRealTestCli(commandLine)) {
      throw blockedCliError(commandLine);
    }
    ensureRuntimeIsolationForSubprocess();
    const proc = originalChildProcess.spawn(command, args, options);
    registerTrackedSubprocess(proc, commandLine);
    return proc;
  }) as ChildProcessModule["spawn"];

  mutableChildProcess.spawnSync = ((command: string, argsOrOptions?: readonly string[] | SpawnSyncOptions, maybeOptions?: SpawnSyncOptions) => {
    const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
    const options = Array.isArray(argsOrOptions) ? withDefaultTimeout(maybeOptions) : withDefaultTimeout(argsOrOptions);
    const commandLine = describeTestSubprocessCommand(command, args);
    if (shouldBlockReservedPortKill(commandLine)) {
      throw blockedReservedPortError(commandLine);
    }
    if (shouldBlockRealTestCli(commandLine)) {
      throw blockedCliError(commandLine);
    }
    ensureRuntimeIsolationForSubprocess();
    return originalChildProcess.spawnSync(command, args, options);
  }) as ChildProcessModule["spawnSync"];

  mutableChildProcess.execSync = ((command: string, options?: ExecSyncOptions) => {
    if (shouldBlockReservedPortKill(command)) {
      throw blockedReservedPortError(command);
    }
    if (shouldBlockRealTestCli(command)) {
      throw blockedCliError(command);
    }
    ensureRuntimeIsolationForSubprocess();
    return originalChildProcess.execSync(command, withDefaultTimeout(options));
  }) as ChildProcessModule["execSync"];

  mutableChildProcess.execFileSync = ((file: string, argsOrOptions?: readonly string[] | ExecFileSyncOptions, maybeOptions?: ExecFileSyncOptions) => {
    const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
    const options = Array.isArray(argsOrOptions) ? withDefaultTimeout(maybeOptions) : withDefaultTimeout(argsOrOptions);
    const commandLine = describeTestSubprocessCommand(file, args);
    if (shouldBlockReservedPortKill(commandLine)) {
      throw blockedReservedPortError(commandLine);
    }
    if (shouldBlockRealTestCli(commandLine)) {
      throw blockedCliError(commandLine);
    }
    ensureRuntimeIsolationForSubprocess();
    return originalChildProcess.execFileSync(file, args, options);
  }) as ChildProcessModule["execFileSync"];

  // Preserve util.promisify(exec) → { stdout, stderr } semantics. Function.prototype.bind
  // and our wrapper drop the original [util.promisify.custom] symbol, which would otherwise
  // make awaited execAsync resolve to a raw stdout string and break destructuring.
  const execWrapper = ((command: string, optionsOrCallback?: ExecOptions | ((error: Error | null, stdout: string, stderr: string) => void), maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (shouldBlockReservedPortKill(command)) {
      throw blockedReservedPortError(command);
    }
    if (shouldBlockRealTestCli(command)) {
      throw blockedCliError(command);
    }
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    ensureRuntimeIsolationForSubprocess();
    const proc = originalChildProcess.exec(command, withDefaultTimeout(options), callback);
    registerTrackedSubprocess(proc, command);
    return proc;
  }) as unknown as ChildProcessModule["exec"];
  (execWrapper as unknown as Record<symbol, unknown>)[promisify.custom] = (command: string, options?: ExecOptions) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execWrapper(command, options ?? {}, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          (error as Error & { stdout?: string; stderr?: string }).stdout = stdout;
          (error as Error & { stdout?: string; stderr?: string }).stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  mutableChildProcess.exec = execWrapper;

  const execFileWrapper = ((file: string, argsOrOptions?: readonly string[] | ExecFileOptions | ((error: Error | null, stdout: string, stderr: string) => void), optionsOrCallback?: ExecFileOptions | ((error: Error | null, stdout: string, stderr: string) => void), maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void) => {
    const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
    const commandLine = describeTestSubprocessCommand(file, args);
    if (shouldBlockReservedPortKill(commandLine)) {
      throw blockedReservedPortError(commandLine);
    }
    if (shouldBlockRealTestCli(commandLine)) {
      throw blockedCliError(commandLine);
    }
    const options = Array.isArray(argsOrOptions)
      ? (typeof optionsOrCallback === "function" ? undefined : optionsOrCallback)
      : (typeof argsOrOptions === "function" ? undefined : argsOrOptions);
    const callback = Array.isArray(argsOrOptions)
      ? (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback)
      : (typeof argsOrOptions === "function" ? argsOrOptions : typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback);
    ensureRuntimeIsolationForSubprocess();
    const proc = originalChildProcess.execFile(file, args, withDefaultTimeout(options), callback);
    registerTrackedSubprocess(proc, commandLine);
    return proc;
  }) as unknown as ChildProcessModule["execFile"];
  (execFileWrapper as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args?: readonly string[], options?: ExecFileOptions) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFileWrapper(file, args ?? [], options ?? {}, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          (error as Error & { stdout?: string; stderr?: string }).stdout = stdout;
          (error as Error & { stdout?: string; stderr?: string }).stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  mutableChildProcess.execFile = execFileWrapper;

  mutableChildProcess.fork = ((modulePath: string, argsOrOptions?: readonly string[] | ForkOptions, maybeOptions?: ForkOptions) => {
    const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
    const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;
    const commandLine = describeTestSubprocessCommand(modulePath, args);
    if (shouldBlockReservedPortKill(commandLine)) {
      throw blockedReservedPortError(commandLine);
    }
    if (shouldBlockRealTestCli(commandLine)) {
      throw blockedCliError(commandLine);
    }
    ensureRuntimeIsolationForSubprocess();
    const proc = originalChildProcess.fork(modulePath, args, options);
    registerTrackedSubprocess(proc, commandLine);
    return proc;
  }) as ChildProcessModule["fork"];

  syncBuiltinESMExports();
}

installChildProcessGuards();

afterEach(async () => {
  // Drain the completed-subprocess failure queue. Only surface failures that
  // belong to the currently-finishing test; failures from a *previous* test
  // whose 30 s timer fired while this test was already running are left in
  // place so the correct test's afterEach can pick them up — or, if that test
  // has already finished, they are simply discarded here to avoid false-positive
  // cascade failures on innocent successor tests.
  const currentTest = currentTestName();
  const owned: string[] = [];
  const remaining: CompletedSubprocessFailure[] = [];
  for (const failure of completedSubprocessFailures) {
    if (failure.ownerTestName === currentTest) {
      owned.push(failure.message);
    } else {
      // Keep failures that belong to other tests so they can be surfaced when
      // that test's afterEach runs (concurrent-worker scenario). Failures whose
      // owner test has already completed cannot be re-surfaced; they're dropped
      // here silently — the subprocess guard already SIGKILL'd the process and
      // the owning test presumably has its own failure path.
      remaining.push(failure);
    }
  }
  completedSubprocessFailures.length = 0;
  completedSubprocessFailures.push(...remaining);
  const failures = owned;

  // Give SIGTERM'd processes a brief grace period to exit before declaring
  // them "left running" — tests like dev-server-process.cleanup() send SIGTERM
  // and immediately drop their reference, so the OS exit lags the test by a
  // few ms even when the production code did the right thing.
  // Under concurrent load (pnpm recursive test) the event loop can be busy
  // enough that git shell processes take longer to emit 'close'; 1 s prevents
  // false-positive guard failures without weakening the safety net.
  const SUBPROCESS_GRACE_MS = 1000;
  if (trackedSubprocesses.size > 0) {
    const stillRunningProcs: ChildProcess[] = [];
    for (const [proc] of trackedSubprocesses) {
      if (proc.exitCode === null && proc.signalCode === null) {
        stillRunningProcs.push(proc);
      }
    }
    if (stillRunningProcs.length > 0) {
      await new Promise<void>((resolve) => {
        let remaining = stillRunningProcs.length;
        const done = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
        };
        const timer = setTimeout(() => resolve(), SUBPROCESS_GRACE_MS);
        for (const proc of stillRunningProcs) {
          if (proc.exitCode !== null || proc.signalCode !== null) {
            done();
            continue;
          }
          const finish = () => {
            proc.removeListener("exit", finish);
            proc.removeListener("close", finish);
            done();
          };
          proc.once("exit", finish);
          proc.once("close", finish);
        }
        timer.unref?.();
      });
    }
  }

  for (const [proc, tracked] of trackedSubprocesses) {
    const stillRunning = proc.exitCode === null && proc.signalCode === null;
    if (stillRunning) {
      // Under concurrent load (pool:threads + isolate:true), tests in the
      // same worker can interleave. Only flag processes started by the
      // current test to avoid false-positive "left running" errors from
      // sibling tests that are still wrapping up their subprocesses.
      if (tracked.testName === currentTest) {
        failures.push(
          `Left running at end of test: ${tracked.commandLine}${tracked.testName ? ` (${tracked.testName})` : ""}`,
        );
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore — the process may have already exited.
        }
      }
    }
    // Always clean up (cancel the tracking timer and remove from map) so the
    // 60s timeout timer cannot fire after this afterEach, regardless of which
    // test originally spawned the process.
    cleanupTrackedSubprocess(proc);
  }

  if (failures.length > 0) {
    throw new Error(
      "Test subprocess guard detected unsafe child-process usage:\n" +
      failures.map((failure) => `- ${failure}`).join("\n"),
    );
  }
});

function sleepMsSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeSelfMintedWorkerRootWithRetry(
  workerRoot = WORKER_ROOT,
  selfMinted = SELF_MINTED_WORKER_ROOT,
  delayMs = 25,
): void {
  if (!selfMinted) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rmSync(workerRoot, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 3) sleepMsSync(delayMs);
    }
  }
}

export const __fusionWorkerRootCleanupTestHooks = {
  removeSelfMintedWorkerRootWithRetry,
  writeWorkerRootOwnerMarker,
};

process.on("exit", () => {
  for (const [proc] of trackedSubprocesses) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore — the process may have already exited.
    }
    cleanupTrackedSubprocess(proc);
  }
  if (workerTempDir) {
    try {
      originalChdir(tmpdir());
      rmSync(workerTempDir, { recursive: true, force: true });
    } catch {
      // Ignore — globalTeardown sweeps env-owned WORKER_ROOT; self-minted roots
      // get their own bounded best-effort removal below.
    }
  }
  removeSelfMintedWorkerRootWithRetry();
});
