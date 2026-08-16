/*
FNXC:CursorMcpBridge 2026-08-15-21:20:
The manifest is the authority for Fusion server entries, while current on-disk bytes remain authority for operator entries.
A baseline is committed before the first config write and every later write is journaled, so a crash cannot recapture Fusion output as operator content.
An unparsable operator edit is quarantined: it is never rewritten and the exclusion remains until reconciliation observes a repaired, Fusion-key-free file.
*/
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { classifyCursorConfigTracking, ensureCursorConfigExcluded, removeCursorConfigExclusion } from "./worktree-hygiene.js";

export interface ServerEntry { command: string; args: string[]; env?: Record<string, string>; }
type Pending = { kind: "write" | "restore" | "delete" | "quarantine"; raw: string | null; seq: number };
type Lease = { pid: number; hostname: string; heartbeatAt: number; serverEntry: ServerEntry };
type State = { version: 1; baseline: { existed: boolean; raw: string | null; mode: number | null; parsable: boolean; createdDir: boolean }; exclusionOwnedByFusion: boolean; lastWrittenRaw: string | null; pending: Pending | null; operatorEditObserved: boolean; configUnwritable: boolean; quarantine: { raw: string | null; fusionKeys: string[]; observedAt: string } | null; leases: Record<string, Lease> };
const TTL = 15 * 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_ATTEMPTS = 5;
const held = new Map<string, Set<string>>();
const paths = (worktreePath: string) => { const dir = join(worktreePath, ".cursor"); return { dir, config: join(dir, "mcp.json"), state: join(dir, ".fusion-mcp-state.json"), lock: join(dir, ".fusion-mcp.lock") }; };
const rawFile = (file: string) => existsSync(file) ? readFileSync(file, "utf8") : null;
/*
FNXC:CursorMcpBridge 2026-08-15-21:26:
The baseline, pending journal, and quarantine record are recovery authorities after
power loss. Fsync their temp file before rename and the containing directory after
rename so Fusion never writes a config whose only baseline or write intent vanished.
*/
const atomic = (file: string, raw: string, durable = false) => {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, raw, { mode: 0o600 });
  if (durable) {
    const fileDescriptor = openSync(temp, "r");
    try { fsyncSync(fileDescriptor); } finally { closeSync(fileDescriptor); }
  }
  renameSync(temp, file);
  if (durable) {
    // Some Windows filesystems reject directory fsync; the renamed file fsync remains durable there.
    try { const directoryDescriptor = openSync(dirname(file), "r"); try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); } } catch { /* platform does not support directory fsync */ }
  }
};
const writeState = (file: string, state: State, durable = false) => atomic(file, JSON.stringify(state), durable);
const same = (raw: string | null, expected: string | null) => raw === expected;
const own = (key: string) => /^fusion-custom-tools-/.test(key);

export const parseCursorMcpConfig = (raw: string) => JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
export const detectFusionKeysInRaw = (raw: string | null) => { try { return Object.keys(parseCursorMcpConfig(raw ?? "{}").mcpServers ?? {}).filter(own); } catch { return []; } };
export function stripFusionKeys(parsed: { mcpServers?: Record<string, unknown> }) { const copy = { ...parsed, mcpServers: { ...(parsed.mcpServers ?? {}) } }; for (const key of Object.keys(copy.mcpServers)) if (own(key)) delete copy.mcpServers[key]; return copy; }
export function composeMcpConfig({ currentRaw, leases }: { currentRaw: string | null; leases: Record<string, { serverEntry: ServerEntry }> }) { let parsed: { mcpServers?: Record<string, unknown> }; try { parsed = currentRaw ? parseCursorMcpConfig(currentRaw) : {}; } catch { parsed = {}; } const next = stripFusionKeys(parsed); next.mcpServers ??= {}; for (const [key, lease] of Object.entries(leases)) next.mcpServers[key] = lease.serverEntry; return `${JSON.stringify(next, null, 2)}\n`; }
export function detectOperatorEdit({ currentRaw, lastWrittenRaw, pending, baseline, stateExists }: { currentRaw: string | null; lastWrittenRaw: string | null; pending: Pending | null; baseline: { raw: string | null }; stateExists: boolean }) { if (!stateExists) return false; return !same(currentRaw, lastWrittenRaw ?? baseline.raw) && !same(currentRaw, pending?.raw ?? "__no_pending__"); }
export function resolvePendingJournal({ currentRaw, lastWrittenRaw, pending, baseline }: { currentRaw: string | null; lastWrittenRaw: string | null; pending: Pending | null; baseline: { raw: string | null } }): "promote" | "discard" | "discard-edited" { if (!pending) return "discard"; if (pending.kind === "quarantine" || same(currentRaw, pending.raw)) return "promote"; return same(currentRaw, lastWrittenRaw ?? baseline.raw) ? "discard" : "discard-edited"; }
export function evaluateQuarantine({ currentRaw, quarantine }: { currentRaw: string | null; quarantine: State["quarantine"] }): "clear" | "hold" | "repin" | "unknown" { if (!quarantine) return "unknown"; if (currentRaw === null) return "clear"; if (currentRaw === quarantine.raw) return "hold"; try { return Object.keys(parseCursorMcpConfig(currentRaw).mcpServers ?? {}).some(own) ? "hold" : "clear"; } catch { return "repin"; } }

/*
FNXC:CursorMcpBridge 2026-08-15-21:17:
The lock owns an on-disk identity, not merely a directory. A crashed holder may
be reclaimed only after a dead same-host PID or the short critical-section TTL;
bounded retries let a peer finish its compose without writing unlocked.
*/
type LockOwner = { pid: number; hostname: string; acquiredAt: number };
const lockOwnerPath = (lock: string) => join(lock, "owner.json");
const currentHost = () => hostname();
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readLockOwner = (lock: string): LockOwner | undefined => { try { return JSON.parse(readFileSync(lockOwnerPath(lock), "utf8")) as LockOwner; } catch { return undefined; } };
const lockAgeMs = (lock: string) => { try { return Date.now() - statSync(lock).mtimeMs; } catch { return Number.POSITIVE_INFINITY; } };
/*
FNXC:CursorMcpBridge 2026-08-15-21:46:
A contender can observe the atomic lock directory after mkdir but before owner.json
is published. Treat missing or malformed metadata as a live acquisition until the
lock directory itself exceeds the TTL; reclaiming it immediately would admit two
writers to the MCP config critical section.
*/
const lockIsStale = (lock: string, owner: LockOwner | undefined) =>
  lockAgeMs(lock) > LOCK_TTL_MS ||
  (owner !== undefined && (Date.now() - owner.acquiredAt > LOCK_TTL_MS ||
    (owner.hostname === currentHost() && !pidAlive(owner.pid))));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withLock<T>(worktreePath: string, create: boolean, fn: () => T | Promise<T>): Promise<T | undefined> {
  const p = paths(worktreePath); if (!existsSync(p.dir)) { if (!create) return undefined; mkdirSync(p.dir, { recursive: true }); }
  const mine: LockOwner = { pid: process.pid, hostname: currentHost(), acquiredAt: Date.now() };
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try { mkdirSync(p.lock); writeFileSync(lockOwnerPath(p.lock), JSON.stringify(mine), { mode: 0o600 }); break; }
    catch {
      if (existsSync(p.lock) && lockIsStale(p.lock, readLockOwner(p.lock))) { try { rmSync(p.lock, { recursive: true, force: true }); } catch { /* contender won; retry */ } }
      if (attempt === LOCK_ATTEMPTS - 1) throw Object.assign(new Error("Cursor MCP config lock unavailable"), { code: "bridge-start-failed" });
      await pause(8 + Math.floor(Math.random() * 12));
    }
  }
  try { return await fn(); } finally {
    const owner = readLockOwner(p.lock);
    if (owner?.pid === mine.pid && owner.hostname === mine.hostname) { try { rmSync(p.lock, { recursive: true, force: true }); } catch { /* stale cleanup will repair */ } }
  }
}

/** Exit handlers cannot await retry or stale-owner checks; they only take a free lock once. */
function withLockSync<T>(worktreePath: string, fn: () => T): T | undefined {
  const p = paths(worktreePath); if (!existsSync(p.dir)) return undefined;
  const mine: LockOwner = { pid: process.pid, hostname: currentHost(), acquiredAt: Date.now() };
  try { mkdirSync(p.lock); writeFileSync(lockOwnerPath(p.lock), JSON.stringify(mine), { mode: 0o600 }); } catch { return undefined; }
  try { return fn(); } catch { return undefined; } finally {
    const owner = readLockOwner(p.lock);
    if (owner?.pid === mine.pid && owner.hostname === mine.hostname) { try { rmSync(p.lock, { recursive: true, force: true }); } catch { /* exit backstop never throws */ } }
  }
}
function readState(p: ReturnType<typeof paths>): State | undefined { try { const state = JSON.parse(readFileSync(p.state, "utf8")) as State; return state.version === 1 && state.baseline ? state : undefined; } catch { return undefined; } }
function recoverJournal(p: ReturnType<typeof paths>, state: State, current: string | null) { if (!state.pending) return; const resolution = resolvePendingJournal({ currentRaw: current, lastWrittenRaw: state.lastWrittenRaw, pending: state.pending, baseline: state.baseline }); if (resolution === "promote") state.lastWrittenRaw = state.pending.raw; if (resolution === "discard-edited") { state.operatorEditObserved = true; try { if (current !== null) parseCursorMcpConfig(current); } catch { state.configUnwritable = true; } } state.pending = null; writeState(p.state, state); }
function journalWrite(p: ReturnType<typeof paths>, state: State, kind: Pending["kind"], raw: string | null) { state.pending = { kind, raw, seq: (state.pending?.seq ?? 0) + 1 }; writeState(p.state, state, true); if (kind === "delete") { if (existsSync(p.config)) unlinkSync(p.config); } else if (kind !== "quarantine") atomic(p.config, raw ?? ""); state.lastWrittenRaw = raw; state.pending = null; writeState(p.state, state); }
/*
FNXC:CursorMcpBridge 2026-08-15-21:26:
A same-host process ID can be proven dead immediately, so retain neither its bridge
entry nor its stale MCP server until the lease TTL. Foreign-host records remain
TTL-only because process IDs are not portable across shared worktrees.
*/
function stale(state: State) {
  for (const [key, lease] of Object.entries(state.leases)) {
    if (Date.now() - lease.heartbeatAt > TTL || (lease.hostname === currentHost() && !pidAlive(lease.pid))) delete state.leases[key];
  }
}
/*
FNXC:CursorMcpBridge 2026-08-15-21:17:
Release must latch a byte-different operator edit before composing its own write.
When the last lease exits, this function returns directory cleanup to its caller
so the nested lock is removed first; otherwise rmdir can never succeed.
*/
function terminal(worktreePath: string, p: ReturnType<typeof paths>, state: State): boolean {
  const current = rawFile(p.config);
  if (state.configUnwritable) { state.leases = {}; state.quarantine = { raw: current, fusionKeys: detectFusionKeysInRaw(current), observedAt: new Date().toISOString() }; state.pending = { kind: "quarantine", raw: current, seq: 1 }; writeState(p.state, state, true); state.pending = null; state.lastWrittenRaw = null; writeState(p.state, state, true); return false; }
  if (!state.operatorEditObserved) journalWrite(p, state, state.baseline.existed ? "restore" : "delete", state.baseline.raw);
  else if (current !== null) journalWrite(p, state, "write", composeMcpConfig({ currentRaw: current, leases: {} }));
  unlinkSync(p.state); if (state.exclusionOwnedByFusion) removeCursorConfigExclusion(worktreePath);
  // The nested main lock still exists here. Its owner performs this one rmdir only after releasing it.
  return state.baseline.createdDir;
}

function removeCursorDirectoryAfterLock(dir: string, shouldRemove: boolean) {
  if (!shouldRemove) return;
  try { rmdirSync(dir); } catch { /* a peer or operator directory is retained without retry */ }
}

function detectAndLatch(p: ReturnType<typeof paths>, state: State, current: string | null) {
  recoverJournal(p, state, current);
  const observed = rawFile(p.config);
  if (detectOperatorEdit({ currentRaw: observed, lastWrittenRaw: state.lastWrittenRaw, pending: state.pending, baseline: state.baseline, stateExists: true })) {
    state.operatorEditObserved = true;
    try { if (observed) parseCursorMcpConfig(observed); } catch { state.configUnwritable = true; }
    writeState(p.state, state);
  }
}

export function bootstrapCursorWorktree(worktreePath: string) { if (classifyCursorConfigTracking(worktreePath) === "tracked") throw Object.assign(new Error("Cursor MCP config is git-tracked"), { code: "bridge-start-failed" }); const exclusion = ensureCursorConfigExcluded(worktreePath); const p = paths(worktreePath); const existed = existsSync(p.dir); mkdirSync(p.dir, { recursive: true }); return { exclusion, createdDirObserved: !existed }; }
export async function stageCursorMcpLease({ worktreePath, serverKey, serverEntry }: { worktreePath: string; serverKey: string; serverEntry: ServerEntry }): Promise<{ heartbeat: () => Promise<unknown>; dispose: () => Promise<void> }> {
  const boot = bootstrapCursorWorktree(worktreePath); const p = paths(worktreePath); let clearedQuarantine = false;
  await withLock(worktreePath, true, () => {
    const current = rawFile(p.config); let state = readState(p);
    if (state?.quarantine) {
      const verdict = evaluateQuarantine({ currentRaw: current, quarantine: state.quarantine });
      if (verdict !== "clear") {
        if (verdict === "repin") { state.quarantine = { raw: current, fusionKeys: detectFusionKeysInRaw(current), observedAt: new Date().toISOString() }; writeState(p.state, state, true); }
        throw Object.assign(new Error("Cursor MCP worktree is quarantined"), { code: "bridge-start-failed" });
      }
      /*
      FNXC:CursorMcpBridge 2026-08-15-21:36:
      A quarantine clear is terminal: remove its exclusion only as the last
      in-lock act, then release this nested lock before a fresh stage bootstraps.
      Writing a new lease after removal would expose config and lock files to git add -A.
      */
      unlinkSync(p.state);
      if (state.exclusionOwnedByFusion) removeCursorConfigExclusion(worktreePath);
      clearedQuarantine = true;
      return;
    }
    if (!state) {
      let parsable = true;
      try { if (current) parseCursorMcpConfig(current); } catch { parsable = false; }
      state = { version: 1, baseline: { existed: current !== null, raw: current, mode: current === null ? null : statSync(p.config).mode, parsable, createdDir: boot.createdDirObserved }, exclusionOwnedByFusion: boot.exclusion.fusionAuthored, lastWrittenRaw: null, pending: null, operatorEditObserved: false, configUnwritable: !parsable, quarantine: parsable ? null : { raw: current, fusionKeys: detectFusionKeysInRaw(current), observedAt: new Date().toISOString() }, leases: {} };
      writeState(p.state, state, true);
      /*
      FNXC:CursorMcpBridge 2026-08-15-23:46:
      An initially malformed operator config is quarantined before composition; byte equality with the captured baseline must never authorize replacing it with Fusion-only JSON.
      */
      if (!parsable) throw Object.assign(new Error("Cursor MCP config is not safely writable"), { code: "bridge-start-failed" });
    }
    detectAndLatch(p, state, current);
    if (state.configUnwritable) throw Object.assign(new Error("Cursor MCP config is not safely writable"), { code: "bridge-start-failed" });
    const exclusion = ensureCursorConfigExcluded(worktreePath, { lockHeld: true }); state.exclusionOwnedByFusion ||= exclusion.fusionAuthored; stale(state); state.leases[serverKey] = { pid: process.pid, hostname: currentHost(), heartbeatAt: Date.now(), serverEntry }; const composed = composeMcpConfig({ currentRaw: rawFile(p.config), leases: state.leases }); journalWrite(p, state, "write", composed); const worktreeLeases = held.get(worktreePath) ?? new Set<string>(); worktreeLeases.add(serverKey); held.set(worktreePath, worktreeLeases);
  });
  if (clearedQuarantine) return stageCursorMcpLease({ worktreePath, serverKey, serverEntry });
  let released = false;
  return { heartbeat: async () => await withLock(worktreePath, false, () => { const state = readState(p); if (state?.leases[serverKey]) { detectAndLatch(p, state, rawFile(p.config)); if (!state.configUnwritable) { state.leases[serverKey].heartbeatAt = Date.now(); writeState(p.state, state); } } }), dispose: async () => { if (released) return; released = true; let removeDir = false; await withLock(worktreePath, false, () => { const state = readState(p); if (!state) return; detectAndLatch(p, state, rawFile(p.config)); delete state.leases[serverKey]; stale(state); if (Object.keys(state.leases).length) { if (!state.configUnwritable) journalWrite(p, state, "write", composeMcpConfig({ currentRaw: rawFile(p.config), leases: state.leases })); else writeState(p.state, state); } else removeDir = terminal(worktreePath, p, state); held.get(worktreePath)?.delete(serverKey); }); removeCursorDirectoryAfterLock(p.dir, removeDir); } };
}
export async function reconcileCursorWorktree(worktreePath: string) { const p = paths(worktreePath); if (!existsSync(p.dir)) return; let removeDir = false; try { await withLock(worktreePath, false, () => { const state = readState(p); if (!state) return; const current = rawFile(p.config); if (state.quarantine) { const verdict = evaluateQuarantine({ currentRaw: current, quarantine: state.quarantine }); if (verdict === "clear") { unlinkSync(p.state); if (state.exclusionOwnedByFusion) removeCursorConfigExclusion(worktreePath); removeDir = state.baseline.createdDir; } else if (verdict === "repin") { state.quarantine = { raw: current, fusionKeys: detectFusionKeysInRaw(current), observedAt: new Date().toISOString() }; writeState(p.state, state, true); } return; } detectAndLatch(p, state, current); const leaseCount = Object.keys(state.leases).length; stale(state); if (!Object.keys(state.leases).length) removeDir = terminal(worktreePath, p, state); else if (!state.configUnwritable && Object.keys(state.leases).length !== leaseCount) {
      // Reaping a dead peer must also remove its MCP entry; the manifest is authoritative.
      journalWrite(p, state, "write", composeMcpConfig({ currentRaw: rawFile(p.config), leases: state.leases }));
    } else if (Object.keys(state.leases).length !== leaseCount) writeState(p.state, state); }); } catch { /* reconciliation is deliberately best effort */ } removeCursorDirectoryAfterLock(p.dir, removeDir); }
export function releaseHeldLeasesSync(worktreePath?: string) { for (const [path, keys] of held) { if (worktreePath && path !== worktreePath) continue; for (const key of [...keys]) { const p = paths(path); let removeDir = false; withLockSync(path, () => { const state = readState(p); if (!state || state.quarantine) return; detectAndLatch(p, state, rawFile(p.config)); delete state.leases[key]; if (!Object.keys(state.leases).length) removeDir = terminal(path, p, state); else if (!state.configUnwritable) journalWrite(p, state, "write", composeMcpConfig({ currentRaw: rawFile(p.config), leases: state.leases })); else writeState(p.state, state); }); removeCursorDirectoryAfterLock(p.dir, removeDir); } } }
