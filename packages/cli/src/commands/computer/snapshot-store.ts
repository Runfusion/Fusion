import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ComputerUseError,
  isValidSnapshotId,
  targetKeyForApp,
  targetKeySlug,
  windowKeyFor,
  type AppRef,
  type Element,
  type SnapshotRecord,
  type SnapshotStaleReason,
  type WindowRef,
} from "./contract.js";

const SNAPSHOT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_RECORDS = 50;
let lastSnapshotTimestamp = 0;
let snapshotSequence = 0;

export interface SnapshotStoreOptions {
  /** Project root shared by all CLI invocations; tests inject an isolated root. */
  projectRoot?: string;
  now?: () => Date;
  ttlMs?: number;
  maxRecords?: number;
}

export interface PersistSnapshotInput {
  app: AppRef;
  window: WindowRef;
  elementCount: number;
  elements: readonly Element[];
  capturedAt?: string;
  expiresAt?: string;
}

export interface ResolveSnapshotInput {
  app: AppRef;
  snapshotId?: string;
  assertedWindowId?: string;
}

/**
 * FNXC:ComputerUse 2026-08-11-03:34:
 * Every computer command is a new process, so get-app-state must atomically persist a serializable
 * locator map before returning its snapshot ID. Actions only replay the current app-scoped record;
 * sparse indexes are map keys rather than positions or elementCount-derived values to prevent a
 * stale UI from turning an intended action into a wrong-element action.
 */
export class ComputerSnapshotStore {
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  get snapshotsDirectory(): string {
    return join(this.projectRoot, ".fusion", "computer-use", "snapshots");
  }

  get latestDirectory(): string {
    return join(this.projectRoot, ".fusion", "computer-use", "latest");
  }

  async persist(input: PersistSnapshotInput, alreadyFenced = false): Promise<SnapshotRecord> {
    const capturedAt = input.capturedAt ?? this.now().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.parse(capturedAt) + this.ttlMs).toISOString();
    const targetKey = targetKeyForApp(input.app);
    const record: SnapshotRecord = {
      snapshotId: this.nextSnapshotId(),
      targetKey,
      windowKey: windowKeyFor(targetKey, input.window.windowId),
      capturedAt,
      expiresAt,
      app: input.app,
      window: input.window,
      elementCount: input.elementCount,
      elements: Object.fromEntries(input.elements.map((element) => [String(element.index), element])),
    };

    await mkdir(this.snapshotsDirectory, { recursive: true });
    await mkdir(this.latestDirectory, { recursive: true });
    await writeJsonAtomically(this.snapshotPath(record.snapshotId), record);
    const writeLatest = async () => { await writeJsonAtomically(this.latestPath(targetKey), { snapshotId: record.snapshotId }); };
    if (alreadyFenced) await writeLatest();
    else await this.mutateLatestPointer(targetKey, writeLatest);
    await this.prune({ preserveSnapshotId: record.snapshotId });
    return record;
  }

  /**
   * FNXC:ComputerUse 2026-08-13-22:02:
   * A successful action consumes only this app's latest pointer, retaining the record for clear
   * stale details and pruning. The next element replay must capture a new accessibility tree.
   */
  async consume(app: AppRef, expectedSnapshotId?: string, alreadyFenced = false): Promise<boolean> {
    const targetKey = targetKeyForApp(app);
    let consumed = false;
    const consumeLatest = async () => {
      const latest = await this.readLatest(targetKey);
      if (!latest || (expectedSnapshotId !== undefined && latest.snapshotId !== expectedSnapshotId)) return;
      await writeJsonAtomically(this.latestPath(targetKey), { snapshotId: latest.snapshotId, consumedAt: this.now().toISOString() });
      consumed = true;
    };
    if (alreadyFenced) await consumeLatest();
    else await this.mutateLatestPointer(targetKey, consumeLatest);
    return consumed;
  }

  /**
   * FNXC:ComputerUse 2026-08-14-00:35:
   * Capture acquisition and element replay share this app fence, not merely their pointer writes.
   * This prevents an action resolved from S or a tree captured before it from racing to re-arm S.
   */
  async withAppFence<T>(app: AppRef, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.latestDirectory, { recursive: true });
    return withDirectoryLock(`${this.latestPath(targetKeyForApp(app))}.lock`, operation);
  }

  /** Read the current record for the resolved app and enforce the C9 fence order. */
  async resolve(input: ResolveSnapshotInput): Promise<SnapshotRecord> {
    const targetKey = targetKeyForApp(input.app);
    const latest = await this.readLatest(targetKey);
    if (!latest) {
      throw snapshotRequired();
    }

    const requestedId = input.snapshotId ?? latest.snapshotId;
    // Command parsing validates this too; the store repeats the guard so an injected caller cannot
    // turn an id into a path outside the snapshots directory.
    const record = isValidSnapshotId(requestedId) ? await this.readRecord(requestedId) : undefined;
    if (!record) {
      if (input.snapshotId) throw snapshotStale("not-found", requestedId);
      throw snapshotRequired();
    }

    if (input.snapshotId && latest.snapshotId !== input.snapshotId) {
      throw snapshotStale("superseded", input.snapshotId);
    }
    /*
     * FNXC:ComputerUse 2026-08-13-22:02:
     * Resolve checks consumption after supersession so an explicit old ID preserves the published
     * superseded diagnosis. A consumed latest pointer fails closed before expiry because its sparse
     * indexes may already name different live elements after the preceding action.
     */
    if (latest.consumedAt !== undefined) {
      throw snapshotStale("consumed-by-action", latest.snapshotId);
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) {
      throw snapshotStale("expired", record.snapshotId);
    }
    if (record.app.pid !== input.app.pid) {
      throw snapshotStale("pid-changed", record.snapshotId);
    }
    if (input.assertedWindowId !== undefined && record.window.windowId !== input.assertedWindowId) {
      throw snapshotStale("window-mismatch", record.snapshotId);
    }
    return record;
  }

  /** Look up the actual sparse index emitted by the captured accessibility traversal. */
  getElement(record: SnapshotRecord, elementIndex: number): Element {
    const element = record.elements[String(elementIndex)];
    if (element) return element;
    throw new ComputerUseError(
      "ELEMENT_INDEX_NOT_FOUND",
      `Element index ${elementIndex} is not in snapshot ${record.snapshotId}; re-run fn computer get-app-state.`,
      "Re-run fn computer get-app-state and use an element index from that snapshot.",
      { snapshotId: record.snapshotId, elementIndex },
    );
  }

  /**
   * Keep the store bounded with single-level reads only. A caller holding a resolved record passes
   * it as preserveSnapshotId so a concurrent capture cannot remove that action's replay source.
   */
  async prune(options: { preserveSnapshotId?: string } = {}): Promise<void> {
    const entries = await readDirectory(this.snapshotsDirectory);
    const records: Array<{ id: string; expiresAt: number; modifiedAt: number }> = [];
    const now = this.now().getTime();
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const record = await this.readRecord(id);
      if (!record) continue;
      const expiresAt = Date.parse(record.expiresAt);
      if (id !== options.preserveSnapshotId && Number.isFinite(expiresAt) && expiresAt <= now) {
        await rm(this.snapshotPath(id), { force: true });
        continue;
      }
      const info = await stat(this.snapshotPath(id)).catch(() => undefined);
      records.push({ id, expiresAt, modifiedAt: info?.mtimeMs ?? 0 });
    }

    const overflow = Math.max(0, records.length - this.maxRecords);
    for (const record of records.sort((a, b) => a.modifiedAt - b.modifiedAt).slice(0, overflow)) {
      if (record.id !== options.preserveSnapshotId) await rm(this.snapshotPath(record.id), { force: true });
    }
  }

  /**
   * FNXC:ComputerUse 2026-08-13-22:29:
   * Latest-pointer updates from separate CLI processes must serialize. An action that resolved S
   * must not overwrite a later get-app-state capture N, so consumption checks its expected ID only
   * while holding the same per-app lock that persist uses to re-arm the pointer.
   */
  private async mutateLatestPointer(targetKey: string, mutation: () => Promise<void>): Promise<void> {
    await this.withAppFence({ bundleId: targetKey.startsWith("bundle:") ? targetKey.slice("bundle:".length) : null, name: "snapshot-pointer", pid: targetKey.startsWith("pid:") ? Number(targetKey.slice("pid:".length)) : 0 }, mutation);
  }

  private snapshotPath(snapshotId: string): string {
    return join(this.snapshotsDirectory, `${snapshotId}.json`);
  }

  private latestPath(targetKey: string): string {
    return join(this.latestDirectory, `${targetKeySlug(targetKey)}.json`);
  }

  private async readLatest(targetKey: string): Promise<LatestPointer | undefined> {
    const value = await readJson(this.latestPath(targetKey));
    return isLatestPointer(value) ? value : undefined;
  }

  private async readRecord(snapshotId: string): Promise<SnapshotRecord | undefined> {
    const value = await readJson(this.snapshotPath(snapshotId));
    return isSnapshotRecord(value) ? value : undefined;
  }

  private nextSnapshotId(): string {
    const timestamp = this.now().getTime();
    if (timestamp > lastSnapshotTimestamp) {
      lastSnapshotTimestamp = timestamp;
      snapshotSequence = 0;
    } else {
      snapshotSequence += 1;
    }
    return `cs_${lastSnapshotTimestamp.toString(36).padStart(10, "0")}${snapshotSequence.toString(36).padStart(3, "0")}${randomBytes(4).toString("hex")}`;
  }
}

export function createComputerSnapshotStore(options: SnapshotStoreOptions = {}): ComputerSnapshotStore {
  return new ComputerSnapshotStore(options);
}

function snapshotRequired(): ComputerUseError {
  return new ComputerUseError(
    "SNAPSHOT_REQUIRED",
    "No current snapshot exists for this app; re-run fn computer get-app-state.",
    "Re-run fn computer get-app-state before using an element index.",
  );
}

function snapshotStale(reason: SnapshotStaleReason, snapshotId: string): ComputerUseError {
  return new ComputerUseError(
    "SNAPSHOT_STALE",
    `Snapshot ${snapshotId} is ${reason}; re-run fn computer get-app-state.`,
    "Re-run fn computer get-app-state before retrying this action.",
    { reason, snapshotId },
  );
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

const POINTER_LOCK_RETRY_MS = 5;
const POINTER_LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 1_000;

/**
 * FNXC:ComputerUse 2026-08-14-00:35:
 * An app fence lives through OS work, so its heartbeat—not a fixed maximum action duration—proves
 * liveness. Stale locks are atomically quarantined and token-checked on release: a crashed holder
 * cannot block forever, and a recovered holder cannot delete a successor's lock after a PID reuse.
 */
async function withDirectoryLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const ownerPath = join(lockPath, "owner.json");
  const token = randomBytes(16).toString("hex");
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeJsonAtomically(ownerPath, { token, pid: process.pid });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockInfo = await stat(lockPath).catch(() => undefined);
      const age = lockInfo === undefined ? Number.NaN : Date.now() - lockInfo.mtimeMs;
      if (Number.isFinite(age) && age > POINTER_LOCK_STALE_MS) {
        const quarantined = `${lockPath}.stale-${randomBytes(8).toString("hex")}`;
        try { await rename(lockPath, quarantined); await rm(quarantined, { recursive: true, force: true }); continue; }
        catch { continue; }
      }
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, POINTER_LOCK_RETRY_MS));
    }
  }
  const heartbeat = setInterval(() => { void utimes(lockPath, new Date(), new Date()).catch(() => undefined); }, LOCK_HEARTBEAT_MS);
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    const owner = await readJson(ownerPath) as { token?: unknown } | undefined;
    if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
  }
}

interface LatestPointer { snapshotId: string; consumedAt?: string; }

function isLatestPointer(value: unknown): value is LatestPointer {
  if (!value || typeof value !== "object") return false;
  const pointer = value as { snapshotId?: unknown; consumedAt?: unknown };
  return typeof pointer.snapshotId === "string" && (pointer.consumedAt === undefined || typeof pointer.consumedAt === "string");
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  const record = value as Partial<SnapshotRecord> | null;
  return !!record
    && typeof record.snapshotId === "string"
    && typeof record.targetKey === "string"
    && typeof record.windowKey === "string"
    && typeof record.capturedAt === "string"
    && typeof record.expiresAt === "string"
    && !!record.app && typeof record.app.pid === "number"
    && !!record.window && typeof record.window.windowId === "string"
    && typeof record.elementCount === "number"
    && !!record.elements && typeof record.elements === "object";
}
