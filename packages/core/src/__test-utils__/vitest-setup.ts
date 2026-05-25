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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMainThread } from "node:worker_threads";
import { assertOutsideRealFusionPath } from "../test-safety.js";

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
const { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } = fs;

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

const TEST_HOME_PREFIX = "fn-test-home-";
const DEFAULT_TEST_SUBPROCESS_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.FUSION_TEST_SUBPROCESS_TIMEOUT_MS ?? "30000", 10) || 30_000,
);
const BLOCKED_TEST_CLI_PATTERN =
  /(^|[\s"'\\/])(?:claude|droid|paperclipai|hermes|openclaw)(?:\.(?:cmd|bat|ps1|exe))?(?=$|[\s"'\\/])/i;

const originalCwd = process.cwd.bind(process);

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

// Shared parent directory for all worker temp dirs in this run.
// globalTeardown wipes this at the end of the suite.
const WORKER_ROOT = join(tmpdir(), "fusion-test-workers");
try { mkdirSync(WORKER_ROOT, { recursive: true }); } catch { /* ignore */ }
process.env.FUSION_TEST_WORKER_ROOT = WORKER_ROOT;

function ensureIsolatedHome(): void {
  const existingHome = process.env.HOME ?? process.env.USERPROFILE;
  if (existingHome && existingHome.includes(tmpdir()) && existingHome.includes(TEST_HOME_PREFIX)) {
    return;
  }

  const tempHome = realpathSync(mkdtempSync(join(WORKER_ROOT, `${TEST_HOME_PREFIX}${process.pid}-`)));
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

ensureIsolatedHome();

let workerTempDir: string | null = null;
if (isMainThread) {
  workerTempDir = realpathSync(
    mkdtempSync(join(WORKER_ROOT, `w-${process.pid}-`))
  );
  process.chdir(workerTempDir);
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
    guardOne(prefix, "fs.mkdtempSync");
    return originalFs.mkdtempSync(prefix, options as Parameters<typeof fs.mkdtempSync>[1]);
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
    guardOne(args[0], "fs.promises.mkdtemp");
    return originalFsPromises.mkdtemp(...args);
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
function parsePortList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
}

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

async function resolveReservedFusionPorts(): Promise<number[]> {
  const reserved = new Set<number>([4040]);
  for (const port of parsePortList(process.env.FUSION_RESERVED_PORTS)) reserved.add(port);
  for (const port of parsePortList(process.env.PORT)) reserved.add(port);
  for (const port of parsePortList(process.env.FUSION_SERVER_PORT)) reserved.add(port);
  if (process.env.FUSION_TEST_SKIP_PORT_PROBE !== "1") {
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
    return originalChildProcess.spawnSync(command, args, options);
  }) as ChildProcessModule["spawnSync"];

  mutableChildProcess.execSync = ((command: string, options?: ExecSyncOptions) => {
    if (shouldBlockReservedPortKill(command)) {
      throw blockedReservedPortError(command);
    }
    if (shouldBlockRealTestCli(command)) {
      throw blockedCliError(command);
    }
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

process.on("exit", () => {
  for (const [proc] of trackedSubprocesses) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore — the process may have already exited.
    }
    cleanupTrackedSubprocess(proc);
  }
  if (!workerTempDir) return;
  try {
    originalChdir(tmpdir());
    rmSync(workerTempDir, { recursive: true, force: true });
  } catch {
    // Ignore — globalTeardown sweeps WORKER_ROOT anyway.
  }
});
