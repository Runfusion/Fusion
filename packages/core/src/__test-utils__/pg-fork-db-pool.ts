/*
FNXC:PgTestDbReuse 2026-08-17-03:38:
FN-9136 evaluates per-fork PostgreSQL database reuse without weakening DB-per-test
isolation. A lease is poisoned until release has reset and verified it against
its golden-template fingerprint; acquire verifies again because post-release
mutation is otherwise invisible to a release-only gate.
*/

export const PG_FORK_DB_POOL_PREFIX = "fusion_pool";

export interface PgForkDbLease {
  readonly dbName: string;
  readonly recycled: boolean;
}

export interface PgForkDbPoolHooks {
  create(name: string): Promise<void>;
  reset(name: string): Promise<void>;
  verify(name: string): Promise<boolean>;
  drop(name: string): Promise<void>;
}

export interface PgForkDbPoolOptions {
  readonly enabled: boolean;
  readonly cap?: number;
  readonly forkPid?: number;
  readonly runToken?: string;
  readonly prefix?: string;
  /** Bound every gate operation so a stuck cleanup is discarded, never reused. */
  readonly gateTimeoutMs?: number;
  readonly hooks: PgForkDbPoolHooks;
}

interface Entry { readonly name: string; state: "leased" | "releasing" | "free" | "dropped"; }

/** A small, non-blocking pool; overflow deliberately falls through to fresh DDL. */
export class PgForkDbPool {
  private readonly cap: number;
  private readonly entries = new Map<string, Entry>();
  private readonly free: string[] = [];
  private readonly dropped = new Set<string>();
  private sequence = 0;
  private readonly gateTimeoutMs: number;

  constructor(private readonly options: PgForkDbPoolOptions) {
    const requestedCap = options.cap ?? 2;
    const requestedGateTimeoutMs = options.gateTimeoutMs ?? 10_000;
    this.cap = Number.isFinite(requestedCap) ? Math.max(1, Math.min(8, Math.trunc(requestedCap))) : 2;
    this.gateTimeoutMs = Number.isFinite(requestedGateTimeoutMs)
      ? Math.max(1, Math.min(15_000, Math.trunc(requestedGateTimeoutMs)))
      : 10_000;
  }

  get enabled(): boolean { return this.options.enabled; }
  get size(): number { return this.entries.size; }

  async acquire(): Promise<PgForkDbLease | null> {
    if (!this.enabled) return null;
    while (this.free.length > 0) {
      const name = this.free.pop()!;
      const entry = this.entries.get(name);
      if (!entry || entry.state !== "free") continue;
      // Acquire-side verification fences mutations after a prior passing release.
      if (await this.safeVerify(name)) {
        entry.state = "leased";
        return { dbName: name, recycled: true };
      }
      await this.discard(name);
    }
    if (this.entries.size >= this.cap) return null;
    const name = this.nextName();
    // Reserve before the first await so concurrent acquires cannot pass the cap.
    this.entries.set(name, { name, state: "leased" });
    try {
      await this.options.hooks.create(name);
      return { dbName: name, recycled: false };
    } catch {
      await this.discard(name);
      return null;
    }
  }

  async release(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry || entry.state !== "leased") return;
    // Claim the transition before awaiting so only one completed release can free a lease.
    entry.state = "releasing";
    // Free-list membership is granted only by this complete reset+verification path.
    try {
      await this.withDeadline(this.options.hooks.reset(name));
      if (!await this.safeVerify(name)) throw new Error("poisoned pooled database");
      if (this.entries.get(name) !== entry || this.dropped.has(name)) return;
      entry.state = "free";
      this.free.push(name);
    } catch {
      await this.discard(name);
    }
  }

  async discard(name: string): Promise<void> {
    if (this.dropped.has(name)) return;
    this.dropped.add(name);
    const entry = this.entries.get(name);
    if (entry) entry.state = "dropped";
    this.entries.delete(name);
    const index = this.free.indexOf(name);
    if (index >= 0) this.free.splice(index, 1);
    await this.safeDrop(name);
  }

  /** Fork-exit path: leased (abandoned) and free entries are both poison and dropped. */
  async flush(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.discard(name)));
  }

  private async safeVerify(name: string): Promise<boolean> {
    try { return await this.withDeadline(this.options.hooks.verify(name)); } catch { return false; }
  }

  private async safeDrop(name: string): Promise<void> {
    try { await this.withDeadline(this.options.hooks.drop(name)); } catch { /* teardown must not reject */ }
  }

  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("pooled database gate timed out")), this.gateTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private nextName(): string {
    this.sequence += 1;
    const token = (this.options.runToken ?? "local").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 24) || "local";
    const pid = this.options.forkPid ?? process.pid;
    const prefix = this.options.prefix ?? PG_FORK_DB_POOL_PREFIX;
    return `${prefix}_${pid}_${token}_${this.sequence}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function parsePgForkDbPoolName(name: string): { pid: number; token: string } | null {
  const match = /^fusion_pool_(\d+)_([a-z0-9]+)_\d+_[a-z0-9]+$/i.exec(name);
  if (!match) return null;
  return { pid: Number(match[1]), token: match[2]! };
}

/**
 * FNXC:PgTestDbReuse 2026-08-17-04:05:
 * Pool cleanup is invocation-scoped. A prefix-only sweep can see a sibling
 * Vitest process and destroy its live database, so foreign tokens are only
 * candidates after their owner is proved dead.
 */
export function pgForkDbPoolIdentity(env: NodeJS.ProcessEnv = process.env): {
  pid: number;
  token: string;
  sharedInvocation: boolean;
} {
  const owner = env.FUSION_PG_TEMPLATE_OWNER_PID?.trim();
  const root = env.FUSION_TEST_WORKER_ROOT?.trim();
  const pid = owner && /^\d+$/.test(owner) ? Number(owner) : process.pid;
  const token = (root ? root.split(/[\\/]/).filter(Boolean).at(-1) : env.FUSION_TEST_RUN_TOKEN)
    ?.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-24) || "local";
  return { pid, token, sharedInvocation: Boolean(owner && root) };
}

export function shouldReclaimPgForkDbPoolName(
  name: string,
  identity: { token: string; sharedInvocation: boolean },
  isAlive: (pid: number) => boolean,
  tier: "fork" | "invocation" | "orphan",
): boolean {
  const parsed = parsePgForkDbPoolName(name);
  if (!parsed) return false;
  if (tier === "fork") return parsed.pid === process.pid;
  if (tier === "invocation") return parsed.token === identity.token && !isAlive(parsed.pid);
  return identity.sharedInvocation && parsed.token !== identity.token && !isAlive(parsed.pid);
}
