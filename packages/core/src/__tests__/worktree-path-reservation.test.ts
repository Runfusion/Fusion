import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {acquireWorktreePathReservation, readWorktreePathReservation, resolveWorktreePathReservationDirectory} from "../tasks/worktree-path-reservation.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fusion-reservation-"));
  dirs.push(dir);
  return {rootDir: dir, worktreesDir: join(dir, "trees"), canonicalPath: join(dir, "trees", "pinned")};
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, {recursive: true, force: true}))); });

describe("worktree path reservation", () => {
  it("excludes concurrent owners until the current owner releases", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    let acquired = false;
    const second = acquireWorktreePathReservation({...options, pollMs: 1, acquireTimeoutMs: 500}).then((handle) => { acquired = true; return handle; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(acquired).toBe(false);
    await first.release();
    const handle = await second;
    expect(handle.previousState).toBe("free");
    await handle.release();
  });

  it("reconciles a quarantined path before handing it to a successor", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await first.quarantine("remove failed");
    const reconcileQuarantined = vi.fn().mockResolvedValue(undefined);

    const next = await acquireWorktreePathReservation({...options, reconcileQuarantined});

    expect(reconcileQuarantined).toHaveBeenCalledWith(options.canonicalPath);
    expect(next.previousState).toBe("quarantined");
    await next.release();
    expect(await readWorktreePathReservation(options)).toBeNull();
  });

  it("reconciles a stale held record and clears it after successful settlement", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await first.release();
    const directory = await resolveWorktreePathReservationDirectory(options);
    await writeFile(`${directory}/state.json`, JSON.stringify({
      pid: 999999,
      hostname: "stale-host",
      startedAt: new Date(0).toISOString(),
      canonicalPath: options.canonicalPath,
      state: "held",
      token: "stale-token",
    }));
    const reconcileQuarantined = vi.fn().mockResolvedValue(undefined);

    const next = await acquireWorktreePathReservation({...options, reconcileQuarantined});

    expect(next.previousState).toBe("quarantined");
    expect(reconcileQuarantined).toHaveBeenCalledWith(options.canonicalPath);
    await next.release();
    expect(await readWorktreePathReservation(options)).toBeNull();
  });

  it("keeps a quarantined path unavailable when successor reconciliation fails", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await first.quarantine("remove failed");

    await expect(acquireWorktreePathReservation({...options, reconcileQuarantined: async () => { throw new Error("still occupied"); }})).rejects.toThrow("still occupied");

    const record = await readWorktreePathReservation(options);
    expect(record?.state).toBe("quarantined");
    expect(record?.reason).toBe("still occupied");
  });

  it("times out rather than waiting forever for a live claim", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await expect(acquireWorktreePathReservation({...options, acquireTimeoutMs: 10, pollMs: 1})).rejects.toThrow("Timed out acquiring worktree reservation");
    await first.release();
  });
});
