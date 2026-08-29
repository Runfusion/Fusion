import {createHash, randomUUID} from "node:crypto";
import {hostname} from "node:os";
import {dirname, join, resolve} from "node:path";
import {mkdir, readFile, rename, rm, rmdir, unlink, writeFile} from "node:fs/promises";

/**
 * FNXC:WorkflowLifecycle 2026-07-16-10:00:
 * Pinned worktrees are reused by independent engine processes, so archive and
 * acquisition share a host-scoped filesystem reservation. `claim/` is the
 * exclusive mkdir create-or-fail primitive; the durable state record is never
 * used as a lock because rename-over-destination does not exclude contenders.
 */
export type WorktreeReservationState = "held" | "released" | "quarantined";
export interface WorktreePathReservation {
  canonicalPath: string;
  token: string;
  previousState: "free" | "quarantined";
  state: WorktreeReservationState;
  release(): Promise<void>;
  quarantine(reason: string): Promise<void>;
}
interface ReservationRecord {
  pid: number;
  hostname: string;
  startedAt: string;
  canonicalPath: string;
  state: "held" | "quarantined";
  token: string;
  reason?: string;
}
export interface WorktreePathReservationOptions {
  canonicalPath: string;
  worktreesDir: string;
  rootDir: string;
  isLiveWorktree?: (canonicalPath: string) => Promise<boolean>;
  reconcileQuarantined?: (canonicalPath: string) => Promise<void>;
  ttlMs?: number;
  pollMs?: number;
  acquireTimeoutMs?: number;
}

export async function canonicalizeWorktreePath(path: string): Promise<string> {
  // resolve is intentional: absent orphan paths still need one stable lock key.
  return resolve(path);
}

function paths(worktreesDir: string, canonicalPath: string) {
  const key = createHash("sha256").update(canonicalPath).digest("hex");
  const container = join(resolve(worktreesDir), ".fusion-worktree-locks", key);
  return {container, claim: join(container, "claim"), state: join(container, "state.json")};
}

async function readRecord(statePath: string): Promise<ReservationRecord | null> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as ReservationRecord;
    return value?.token && value?.canonicalPath ? value : null;
  } catch { return null; }
}
async function writeRecord(statePath: string, record: ReservationRecord): Promise<void> {
  const temp = join(dirname(statePath), `.state-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(record), "utf8");
  await rename(temp, statePath);
}
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Read the durable record; it is diagnostic only and does not imply ownership. */
export async function readWorktreePathReservation(options: Pick<WorktreePathReservationOptions, "canonicalPath" | "worktreesDir">): Promise<ReservationRecord | null> {
  const canonicalPath = await canonicalizeWorktreePath(options.canonicalPath);
  return readRecord(paths(options.worktreesDir, canonicalPath).state);
}

export async function acquireWorktreePathReservation(options: WorktreePathReservationOptions): Promise<WorktreePathReservation> {
  const canonicalPath = await canonicalizeWorktreePath(options.canonicalPath);
  const layout = paths(options.worktreesDir, canonicalPath);
  const pollMs = options.pollMs ?? 25;
  const timeoutMs = options.acquireTimeoutMs ?? 30_000;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const started = Date.now();
  await mkdir(layout.container, {recursive: true});

  for (;;) {
    try {
      await mkdir(layout.claim);
      const prior = await readRecord(layout.state);
      const token = randomUUID();
      const record: ReservationRecord = {pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), canonicalPath, state: "held", token};
      await writeRecord(layout.state, record);
      let state: WorktreeReservationState = "held";
      const settle = async (quarantineReason?: string): Promise<void> => {
        if (state !== "held") return;
        const current = await readRecord(layout.state);
        if (!current || current.token !== token) { state = "released"; return; }
        if (quarantineReason !== undefined) {
          await writeRecord(layout.state, {...current, state: "quarantined", reason: quarantineReason});
          await rmdir(layout.claim).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
          state = "quarantined";
        } else {
          await unlink(layout.state).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
          await rmdir(layout.claim).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
          state = "released";
        }
      };
      const previousState = prior?.state === "quarantined" || prior?.state === "held" ? "quarantined" : "free";
      if (previousState === "quarantined" && options.reconcileQuarantined) {
        /*
        FNXC:WorkflowLifecycle 2026-07-16-10:00:
        A failed archive removal is retried by the successor while its exclusive
        claim is held. Re-quarantine on failure so it cannot attempt creation at
        the still-occupied pinned path.
        */
        try {
          await options.reconcileQuarantined(canonicalPath);
        } catch (error) {
          await settle(error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      return {canonicalPath, token, previousState, get state() { return state; }, release: () => settle(), quarantine: (reason) => settle(reason)};
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = await readRecord(layout.state);
      const age = record ? Date.now() - Date.parse(record.startedAt) : 0;
      const deadLocalOwner = !!record && record.hostname === hostname() && !pidAlive(record.pid);
      let stale = deadLocalOwner;
      if (!stale && record && age > ttlMs) {
        // Fail closed: inability to prove non-liveness never steals a claim.
        try { stale = !(await (options.isLiveWorktree?.(canonicalPath) ?? Promise.resolve(true))); } catch { stale = false; }
      }
      if (stale) {
        const reclaimed = join(layout.container, `.reclaim-${randomUUID()}`);
        try { await rename(layout.claim, reclaimed); await rm(reclaimed, {recursive: true, force: true}); continue; }
        catch (reclaimError: unknown) { if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError; continue; }
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring worktree reservation for ${canonicalPath} after ${timeoutMs}ms`);
      await sleep(pollMs);
    }
  }
}

export async function withWorktreePathReservation<T>(options: WorktreePathReservationOptions, fn: (reservation: WorktreePathReservation) => Promise<T>): Promise<T> {
  const reservation = await acquireWorktreePathReservation(options);
  try { return await fn(reservation); } finally { if (reservation.state === "held") await reservation.release(); }
}
