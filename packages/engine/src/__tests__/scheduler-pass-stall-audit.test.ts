import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";

/**
 * RUFU-830 — a forced-open scheduler stall has to survive the log file.
 *
 * RUFU-828 made the stall attributable but wrote the attribution only to the process log. Measured the
 * same day: `/tmp/fusion-prod-20261006.log` was truncated in place (same inode) and lost everything
 * before 13:53 — 66 force-open readings, 3 465 pass durations and all 13 leg attributions went with it.
 * These tests pin the durable half: one bounded run-audit row per stall episode, ids/counts/fixed enums
 * only, and a sink that throws or hangs cannot change the dispatch decision.
 *
 * The seam is reached on the prototype with a synthetic `this`, as in the RUFU-828 attribution test:
 * the constructor subscribes to store events, which this assertion does not need.
 */

type Reporter = (self: Record<string, unknown>, stuckMs: number) => void;

const ROOT = "/home/schindler/git/Fusion";

function report(self: Record<string, unknown>, stuckMs: number): void {
  const fn = (Scheduler.prototype as unknown as { reportStuckPass(ms: number): void }).reportStuckPass;
  fn.call(self, stuckMs);
}

function schedulerWith(sink: unknown, phase = "hold-release-sweep") {
  const rows: any[] = [];
  const self = {
    schedulingPhase: phase,
    store: {
      getRootDir: () => ROOT,
      getProjectId: () => "proj_9326d74a133b421a",
      recordRunAuditEvent: sink ?? ((input: any) => { rows.push(input); return Promise.resolve(); }),
    },
  };
  return { self, rows };
}

describe("stuck scheduler pass is recorded durably", () => {
  it("emits one scheduler:pass-stalled row naming the project and the leg", () => {
    const { self, rows } = schedulerWith(undefined);
    report(self, 601_000);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.mutationType).toBe("scheduler:pass-stalled");
    expect(row.agentId).toBe("scheduler");
    expect(row.domain).toBe("database");
    expect(row.target).toBe("proj_9326d74a133b421a");
    expect(row.metadata.leg).toBe("hold-release-sweep");
    expect(row.metadata.outcome).toBe("guard-forced-open");
  });

  it("writes the closed metadata key set and nothing else", () => {
    const { self, rows } = schedulerWith(undefined);
    report(self, 612_000);
    expect(Object.keys(rows[0].metadata).sort()).toEqual(
      ["inFlightMs", "leg", "outcome", "thresholdMs"],
    );
    expect(rows[0].metadata.thresholdMs).toBe(600_000);
    // Rounded to whole seconds so a stall does not carry a millisecond-precision clock into the store.
    expect(rows[0].metadata.inFlightMs).toBe(612_000);
  });

  it("carries no root path into the row, only the project id", () => {
    const { self, rows } = schedulerWith(undefined);
    report(self, 600_000);
    const serialised = JSON.stringify({ target: rows[0].target, metadata: rows[0].metadata, runId: rows[0].runId });
    expect(serialised).not.toContain(ROOT);
    expect(serialised).not.toContain("/home/");
  });

  it("names the leg the pass actually reached", () => {
    const { self, rows } = schedulerWith(undefined, "post-sweep-reread");
    report(self, 900_000);
    expect(rows[0].metadata.leg).toBe("post-sweep-reread");
  });

  it("survives a sink that throws, without throwing at the caller", () => {
    const { self } = schedulerWith(() => {
      throw new Error("sink down");
    });
    expect(() => report(self, 600_000)).not.toThrow();
  });

  it("survives a sink that never settles", async () => {
    const hanging = vi.fn(() => new Promise(() => {}));
    const { self } = schedulerWith(hanging);
    expect(() => report(self, 600_000)).not.toThrow();
    await Promise.resolve();
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it("survives a store with no audit sink at all", () => {
    const self = {
      schedulingPhase: "board-read",
      store: { getRootDir: () => ROOT, getProjectId: () => null },
    };
    expect(() => report(self, 600_000)).not.toThrow();
  });
});
