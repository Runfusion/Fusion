/**
 * Fusion-owned agent-browser lifecycle records.
 *
 * The native daemon is intentionally independent from Node, so a task session needs a
 * durable, opaque owner record that survives an abrupt parent death.  The CLI launcher
 * renews this record before it invokes the native command; recovery can then distinguish
 * a managed stale profile from an ordinary operator browser.
 */
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FUSION_AGENT_BROWSER_LEASE_DIR = "fusion-agent-browser-leases";
export const FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const FUSION_AGENT_BROWSER_MAX_IDLE_TIMEOUT_MS = 60 * 60_000;
/** Lease-less native profiles predate Fusion ownership and need a deliberately conservative age gate. */
export const FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS = 24 * 60 * 60_000;

export type FusionBrowserLease = {
  version: 1;
  sessionId: string;
  taskId: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
  profilePath: string;
  /** A normal close is still reaped if native shutdown leaves a wedged tree behind. */
  retiredAt?: number;
};

export type FusionBrowserLeaseDeps = {
  now?: () => number;
  tempRoot?: string;
  randomId?: () => string;
};

export function resolveFusionBrowserIdleTimeout(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(Math.trunc(parsed), FUSION_AGENT_BROWSER_MAX_IDLE_TIMEOUT_MS);
}

export function fusionBrowserLeaseRoot(tempRoot = tmpdir()): string {
  return resolve(tempRoot, FUSION_AGENT_BROWSER_LEASE_DIR);
}

export function fusionBrowserLeasePath(sessionId: string, tempRoot = tmpdir()): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid Fusion browser session id");
  return join(fusionBrowserLeaseRoot(tempRoot), `${sessionId}.json`);
}

/**
 * FNXC:AgentBrowserOwnership 2026-09-20-00:56:
 * A Fusion session owns an opaque browser session rather than a task-wide daemon.
 * Retried and concurrent sessions therefore receive separate leases and cannot close
 * each other's native agent-browser daemon.
 */
export function createFusionBrowserLease(taskId: string, env: NodeJS.ProcessEnv, deps: FusionBrowserLeaseDeps = {}): {
  env: NodeJS.ProcessEnv;
  lease: FusionBrowserLease;
  leasePath: string;
} {
  const now = deps.now?.() ?? Date.now();
  const sessionId = `fusion_${(deps.randomId?.() ?? randomUUID()).replace(/-/g, "")}`;
  const idleTimeoutMs = resolveFusionBrowserIdleTimeout(env.AGENT_BROWSER_IDLE_TIMEOUT_MS);
  const root = fusionBrowserLeaseRoot(deps.tempRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const profilePath = join(resolve(deps.tempRoot ?? tmpdir()), `agent-browser-chrome-${sessionId}`);
  const lease: FusionBrowserLease = { version: 1, sessionId, taskId, createdAt: now, heartbeatAt: now, expiresAt: now + idleTimeoutMs, profilePath };
  const leasePath = fusionBrowserLeasePath(sessionId, deps.tempRoot);
  writeLease(leasePath, lease);
  return {
    lease,
    leasePath,
    env: {
      ...env,
      AGENT_BROWSER_SESSION: sessionId,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
      FUSION_AGENT_BROWSER_SESSION_ID: sessionId,
      FUSION_AGENT_BROWSER_LEASE_PATH: leasePath,
      // Force the native daemon to use a profile whose exact path is lease-bound.
      AGENT_BROWSER_PROFILE: profilePath,
    },
  };
}

export async function closeFusionBrowserSession(
  env: NodeJS.ProcessEnv,
  deps: { runClose?: (env: NodeJS.ProcessEnv) => Promise<void>; tempRoot?: string } = {},
): Promise<void> {
  const sessionId = env.FUSION_AGENT_BROWSER_SESSION_ID;
  if (!sessionId) return;
  try {
    await (deps.runClose ?? ((closeEnv) => execFileAsync("agent-browser", ["close"], { env: closeEnv, timeout: 15_000, windowsHide: true })))(env);
  } catch {
    // Native close is best-effort; the retired record deliberately remains reaper-owned.
  } finally {
    retireFusionBrowserLease(sessionId, deps.tempRoot);
  }
}

/**
 * FNXC:AgentBrowserReaping 2026-09-20-13:20:
 * Closing a daemon is not proof that its Chrome group exited. Preserve a fenced, immediately
 * expired lease so startup/maintenance can verify and force-reap a wedged tree instead of losing
 * the only safe ownership record.
 */
export function retireFusionBrowserLease(sessionId: string, tempRoot = tmpdir()): void {
  const path = fusionBrowserLeasePath(sessionId, tempRoot);
  try {
    const lease = JSON.parse(readFileSync(path, "utf8")) as FusionBrowserLease;
    if (lease.version !== 1 || lease.sessionId !== sessionId) return;
    const now = Date.now();
    writeLease(path, { ...lease, retiredAt: now, expiresAt: Math.min(lease.expiresAt, now) });
  } catch {
    // Missing or malformed ownership is never recreated during cleanup.
  }
}

export type FusionBrowserReaperDeps = {
  tempRoot?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  graceMs?: number;
  legacyStaleAgeMs?: number;
  /** Process discovery is injected so recovery never broadens an uncertain match. */
  findProcessGroups: (profilePath: string) => Promise<number[]>;
  signalGroup: (pgid: number, signal: NodeJS.Signals) => Promise<void>;
  groupsAlive: (pgids: number[]) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
};

type PsRow = { pid: number; ppid: number; pgid: number; command: string };

/**
 * The package's actual daemon is platform-suffixed (for example,
 * `agent-browser-darwin-arm64`), while direct CLI use may retain the unsuffixed name.
 * Accept only those executable basenames, never a substring in an argument.
 */
export function isFusionAgentBrowserDaemonCommand(command: string): boolean {
  return /(?:^|\/)agent-browser(?:-(?:darwin|linux)(?:-musl)?-(?:arm64|x64))?(?:\s|$)/.test(command);
}

/** A negative-PID signal is safe only when every member belongs to this exact browser tree. */
function isExclusiveFusionBrowserProcessGroup(
  rows: readonly PsRow[],
  byPid: ReadonlyMap<number, PsRow>,
  pgid: number,
  browserPid: number,
  daemonPid: number,
): boolean {
  return rows.filter((row) => row.pgid === pgid).every((row) => {
    if (row.pid === daemonPid) return true;
    let ancestor: PsRow | undefined = row;
    for (let depth = 0; ancestor && depth < 32; depth++, ancestor = byPid.get(ancestor.ppid)) {
      if (ancestor.pid === browserPid) return true;
    }
    return false;
  });
}

/** Production POSIX discovery is deliberately exact-profile and daemon-ancestry scoped. */
export function createFusionBrowserProductionReaperDeps(): FusionBrowserReaperDeps {
  let selected = new Set<number>();
  return {
    findProcessGroups: async (profilePath) => {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { timeout: 5_000, windowsHide: true });
      const rows = stdout.split("\n").flatMap((line): PsRow[] => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
      });
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const profileFlag = `--user-data-dir=${profilePath}`;
      const chrome = rows.filter((row) => /(?:^|\/)Chrom(?:e|ium)(?:\s|$)|(?:^|\s)chrome(?:\s|$)/i.test(row.command) && row.command.includes(profileFlag));
      const groups = new Set<number>();
      selected = new Set<number>();
      let verifiedBrowserCount = 0;
      for (const browser of chrome) {
        let ancestor: PsRow | undefined = browser;
        let daemon: PsRow | undefined;
        for (let depth = 0; ancestor && depth < 16; depth++, ancestor = byPid.get(ancestor.ppid)) {
          if (isFusionAgentBrowserDaemonCommand(ancestor.command)) { daemon = ancestor; break; }
        }
        if (!daemon) continue;
        const candidateGroups = [browser.pgid, daemon.pgid];
        if (candidateGroups.some((pgid) => !isExclusiveFusionBrowserProcessGroup(rows, byPid, pgid, browser.pid, daemon.pid))) {
          // A process group can include the engine's caller shell. Refuse rather than widen a kill.
          throw new Error("agent-browser process group contains an unowned process");
        }
        verifiedBrowserCount++;
        selected.add(browser.pid);
        selected.add(daemon.pid);
        groups.add(browser.pgid);
        groups.add(daemon.pgid);
      }
      if (verifiedBrowserCount !== chrome.length) {
        // A matching profile with a missing daemon ancestry is still live but unprovable.
        throw new Error("agent-browser Chrome ownership is ambiguous");
      }
      return [...groups];
    },
    signalGroup: async (pgid, signal) => {
      try { process.kill(-pgid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    groupsAlive: async () => {
      if (selected.size === 0) return false;
      const { stdout } = await execFileAsync("ps", ["-axo", "pid="], { timeout: 5_000, windowsHide: true });
      const alive = new Set(stdout.split("\n").map((value) => Number(value.trim())).filter(Number.isInteger));
      return [...selected].some((pid) => alive.has(pid));
    },
  };
}

export async function reapExpiredFusionBrowserLeasesInProduction(): Promise<number> {
  return reapExpiredFusionBrowserLeases(createFusionBrowserProductionReaperDeps());
}

/**
 * FNXC:AgentBrowserReaping 2026-09-20-00:56:
 * Recovery enumerates lease records plus legacy `agent-browser-chrome-*` directories
 * directly under tmpdir. A lease is eligible only after expiry, while a lease-less
 * profile needs a conservative age gate and an exact daemon/Chrome process proof.
 */
export async function reapExpiredFusionBrowserLeases(deps: FusionBrowserReaperDeps): Promise<number> {
  if ((deps.platform ?? process.platform) === "win32") return 0;
  const tempRoot = resolve(deps.tempRoot ?? tmpdir());
  const root = fusionBrowserLeaseRoot(tempRoot);
  const knownProfiles = new Set<string>();
  const managedProfileNames = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(root); } catch { /* A missing lease root does not prevent legacy recovery. */ }
  let reaped = 0;
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    const leasePath = join(root, name);
    let lease: FusionBrowserLease;
    try {
      if (!lstatSync(leasePath).isFile()) continue;
      lease = JSON.parse(readFileSync(leasePath, "utf8")) as FusionBrowserLease;
      if (lease.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(lease.sessionId) || leasePath !== fusionBrowserLeasePath(lease.sessionId, tempRoot)) continue;
      const canonicalProfile = resolve(lease.profilePath);
      if (!isDirectTempProfile(tempRoot, canonicalProfile)) continue;
      knownProfiles.add(canonicalProfile);
      managedProfileNames.add(`agent-browser-chrome-${lease.sessionId}`);
      try {
        if (lstatSync(canonicalProfile).isSymbolicLink()) continue;
      } catch (error) {
        // A normal native close may remove the profile before maintenance runs. ENOENT is
        // safe to continue through process proof so its retired lease does not accumulate.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      if ((deps.now?.() ?? Date.now()) < lease.expiresAt) continue;
      const groups = selectedGroups(await deps.findProcessGroups(canonicalProfile));
      if (groups.length === 0 || await terminateSelectedGroups(groups, deps)) {
        rmSync(canonicalProfile, { recursive: true, force: true });
        rmSync(leasePath, { force: true });
        reaped++;
      }
    } catch {
      // A concurrent daemon/profile mutation is ownership-ambiguous and must fail closed.
    }
  }
  return reaped + await reapLegacyBrowserProfiles(tempRoot, knownProfiles, managedProfileNames, deps);
}

function isDirectTempProfile(tempRoot: string, profilePath: string): boolean {
  return profilePath.startsWith(`${tempRoot}/`) && !relative(tempRoot, profilePath).startsWith("..") && relative(tempRoot, profilePath).split("/").length === 1;
}

function selectedGroups(groups: number[]): number[] {
  return [...new Set(groups)].filter((id) => Number.isInteger(id) && id > 0);
}

async function terminateSelectedGroups(groups: number[], deps: FusionBrowserReaperDeps): Promise<boolean> {
  await Promise.all(groups.map(async (pgid) => { try { await deps.signalGroup(pgid, "SIGTERM"); } catch { return; } }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  await sleep(deps.graceMs ?? 2_000);
  if (await deps.groupsAlive(groups)) {
    await Promise.all(groups.map(async (pgid) => { try { await deps.signalGroup(pgid, "SIGKILL"); } catch { return; } }));
  }
  return !(await deps.groupsAlive(groups));
}

/**
 * FNXC:AgentBrowserLegacyReaping 2026-09-20-01:50:
 * The original incident predates Fusion leases, so recovery scans only direct temp-root
 * profiles with the native prefix. A legacy candidate is removable only after its age gate
 * and exact daemon/Chrome process proof succeed; an empty or ambiguous profile stays intact.
 */
async function reapLegacyBrowserProfiles(
  tempRoot: string,
  knownProfiles: ReadonlySet<string>,
  managedProfileNames: ReadonlySet<string>,
  deps: FusionBrowserReaperDeps,
): Promise<number> {
  let names: string[];
  try { names = readdirSync(tempRoot); } catch { return 0; }
  const now = deps.now?.() ?? Date.now();
  const staleAgeMs = deps.legacyStaleAgeMs ?? FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS;
  if (!Number.isFinite(staleAgeMs) || staleAgeMs <= 0) return 0;
  let reaped = 0;
  for (const name of names) {
    if (!name.startsWith("agent-browser-chrome-") || managedProfileNames.has(name)) continue;
    const profilePath = resolve(tempRoot, name);
    try {
      if (!isDirectTempProfile(tempRoot, profilePath) || knownProfiles.has(profilePath)) continue;
      const entry = lstatSync(profilePath);
      if (!entry.isDirectory() || entry.isSymbolicLink() || now - statSync(profilePath).mtimeMs < staleAgeMs) continue;
      const groups = selectedGroups(await deps.findProcessGroups(profilePath));
      // An empty profile is not proof that Fusion owns it. Do not clean it by name/age alone.
      if (groups.length === 0 || !(await terminateSelectedGroups(groups, deps))) continue;
      const current = lstatSync(profilePath);
      if (!current.isDirectory() || current.isSymbolicLink()) continue;
      rmSync(profilePath, { recursive: true, force: false });
      reaped++;
    } catch {
      // Races, malformed entries, and ambiguous process discovery are intentionally retained.
    }
  }
  return reaped;
}

function writeLease(path: string, lease: FusionBrowserLease): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}
