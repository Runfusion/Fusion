import { describe, expect, it, vi } from "vitest";
import { PgForkDbPool } from "../__test-utils__/pg-fork-db-pool.js";

function fixture(cap = 2) {
  const hooks = { create: vi.fn(async () => {}), reset: vi.fn(async () => {}), verify: vi.fn(async () => true), drop: vi.fn(async () => {}) };
  return { hooks, pool: new PgForkDbPool({ enabled: true, cap, forkPid: 42, runToken: "run", hooks }) };
}

describe("PgForkDbPool", () => {
  it("only recycles after a passing reset and two-sided verification", async () => {
    const { hooks, pool } = fixture();
    const first = await pool.acquire();
    expect(first).not.toBeNull();
    await pool.release(first!.dbName);
    expect(hooks.reset).toHaveBeenCalledWith(first!.dbName);
    const second = await pool.acquire();
    expect(second).toEqual({ dbName: first!.dbName, recycled: true });
    expect(hooks.verify).toHaveBeenCalledTimes(2);
  });

  it("discards reset failures and acquire-side drift rather than handing them out", async () => {
    const { hooks, pool } = fixture();
    const lease = (await pool.acquire())!;
    hooks.verify.mockResolvedValueOnce(false);
    await pool.release(lease.dbName);
    expect(hooks.drop).toHaveBeenCalledWith(lease.dbName);
    const replacement = (await pool.acquire())!;
    await pool.release(replacement.dbName);
    hooks.verify.mockResolvedValueOnce(false);
    const fresh = (await pool.acquire())!;
    expect(fresh.recycled).toBe(false);
    expect(hooks.drop).toHaveBeenCalledWith(replacement.dbName);
  });

  it("bounds concurrent retained leases, falls through on cap, and drops abandoned leases once", async () => {
    const { hooks, pool } = fixture(1);
    const [lease, overflow] = await Promise.all([pool.acquire(), pool.acquire()]);
    expect(lease).not.toBeNull();
    expect(overflow).toBeNull();
    await Promise.all([pool.flush(), pool.discard(lease!.dbName), pool.flush()]);
    expect(hooks.drop).toHaveBeenCalledTimes(1);
    expect(hooks.drop).toHaveBeenCalledWith(lease!.dbName);
  });

  it("uses bounded defaults for non-finite configuration", async () => {
    const { hooks } = fixture();
    const pool = new PgForkDbPool({ enabled: true, cap: Number.NaN, gateTimeoutMs: Number.NaN, hooks });
    const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(leases.filter(Boolean)).toHaveLength(2);
  });

  it("is inert while disabled", async () => {
    const { hooks } = fixture();
    const pool = new PgForkDbPool({ enabled: false, hooks });
    expect(await pool.acquire()).toBeNull();
    await pool.flush();
    expect(hooks.create).not.toHaveBeenCalled();
    expect(hooks.drop).not.toHaveBeenCalled();
  });
});
