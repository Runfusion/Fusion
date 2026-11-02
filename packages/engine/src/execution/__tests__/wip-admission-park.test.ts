import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { WIP_ADMISSION_STALL_METADATA_KEY } from "@fusion/core";
import {
  WIP_ADMISSION_STALL_ANNOUNCE_WINDOW_MS,
  WIP_ADMISSION_SWEEP_NODE,
  clearWipAdmissionPark,
  holdReleaseKind,
  isHumanOrEventRelease,
  publishWipAdmissionHold,
  recordWipAdmissionPark,
  wipAdmissionParkCodeForHeldReason,
  wipAdmissionSignatureFrom,
} from "../wip-admission-park.js";

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The recorder is the single place a withheld hold->WIP crossing becomes durable, so these tests pin the
three things that make it a bound instead of a second counter: one accepted write per changed condition
(everything else writes nothing), a marker write that is a KEY-PRESERVING patch (a whole-field
`sourceMetadata` wipe would orphan `duplicateOf`, `handoffFrom` and the RUFU-273 planning episode), and a
store failure that degrades to "no audit row" rather than throwing into the graph. The History-mirror
tests exist because the first draft called `logEntry` with an object where the store takes a positional
string — a shape bug that crashed an unrelated sweep test with `entry.message.includes is not a function`.
*/

const T0 = Date.parse("2026-11-01T00:00:00.000Z");

function card(sourceMetadata: Record<string, unknown> = {}): Pick<Task, "id" | "sourceMetadata"> {
  return { id: "RUFU-393", sourceMetadata };
}

function makeStore(overrides: Partial<TaskStore> = {}) {
  const updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ id: "RUFU-393", patch }));
  const logEntryOnce = vi.fn(async () => true);
  const logEntry = vi.fn(async () => undefined);
  const store = { updateTask, logEntryOnce, logEntry, ...overrides } as unknown as TaskStore;
  return { store, updateTask, logEntryOnce, logEntry };
}

const seamContext = {
  code: "scheduler-seam" as const,
  nodeId: "parse",
  fromColumn: "todo",
  toColumn: "in-progress",
};

describe("recordWipAdmissionPark", () => {
  it("records a changed condition once and warrants exactly one audit row", async () => {
    const { store, updateTask } = makeStore();
    const first = await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(first.accepted).toBe(true);
    expect(first.auditRowWarranted).toBe(true);
    expect(updateTask).toHaveBeenCalledTimes(1);

    // The same refusal 15 seconds later must write nothing: the storm was one row per dispatch.
    const again = await recordWipAdmissionPark(store, card(first.episode ? { [WIP_ADMISSION_STALL_METADATA_KEY]: first.episode } : {}), seamContext, T0 + 15_000);
    expect(again.accepted).toBe(false);
    expect(again.auditRowWarranted).toBe(false);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("writes through a key-preserving patch, never a whole sourceMetadata replacement", async () => {
    const { store, updateTask } = makeStore();
    await recordWipAdmissionPark(store, card({ duplicateOf: "RUFU-000" }), seamContext, T0);
    const patch = updateTask.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["sourceMetadataPatch"]);
    expect(Object.keys(patch.sourceMetadataPatch as Record<string, unknown>)).toEqual([WIP_ADMISSION_STALL_METADATA_KEY]);
    expect(patch).not.toHaveProperty("sourceMetadata");
  });

  it("refreshes past the floor with the age preserved and one further audit row", async () => {
    const { store } = makeStore();
    const first = await recordWipAdmissionPark(store, card(), seamContext, T0);
    const refreshed = await recordWipAdmissionPark(
      store,
      card({ [WIP_ADMISSION_STALL_METADATA_KEY]: first.episode }),
      seamContext,
      T0 + 20 * 60_000,
    );
    expect(refreshed.accepted).toBe(true);
    expect(refreshed.episode?.firstAt).toBe(first.episode?.firstAt);
    expect(refreshed.episode?.stallCount).toBe(2);
  });

  it("degrades a store failure to no-marker and no-audit-row instead of throwing", async () => {
    const { store } = makeStore({ updateTask: vi.fn(async () => { throw new Error("store down"); }) } as unknown as Partial<TaskStore>);
    const result = await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(result).toEqual({ accepted: false, auditRowWarranted: false });
  });
});

describe("recordWipAdmissionPark History mirror", () => {
  it("announces through the durable once-seam keyed by the episode signature", async () => {
    const { store, logEntryOnce } = makeStore();
    await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(logEntryOnce).toHaveBeenCalledTimes(1);
    const [taskId, input] = logEntryOnce.mock.calls[0] as unknown as [string, { action: string; dedupeKey: string; windowMs: number }];
    expect(taskId).toBe("RUFU-393");
    expect(input.dedupeKey).toBe(`wip-admission-park:${wipAdmissionSignatureFrom(seamContext)}`);
    expect(input.windowMs).toBe(WIP_ADMISSION_STALL_ANNOUNCE_WINDOW_MS);
    expect(input.action).toContain("scheduler-seam");
  });

  it("falls back to logEntry with a positional string, matching the store signature", async () => {
    const { store, logEntry } = makeStore({ logEntryOnce: undefined } as unknown as Partial<TaskStore>);
    await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(logEntry).toHaveBeenCalledTimes(1);
    const [taskId, action] = logEntry.mock.calls[0] as unknown as [string, unknown];
    expect(taskId).toBe("RUFU-393");
    // The pre-fix draft passed an object here, which stored a non-string `message` and blew up a sweep test.
    expect(typeof action).toBe("string");
  });

  it("keeps the marker for a readiness gate but stays out of History", async () => {
    const { store, updateTask, logEntryOnce } = makeStore();
    await recordWipAdmissionPark(store, card(), { ...seamContext, code: "awaiting-planning" }, T0);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(logEntryOnce).not.toHaveBeenCalled();
  });

  it("swallows a History failure so telemetry cannot fail the marker", async () => {
    const { store } = makeStore({ logEntryOnce: vi.fn(async () => { throw new Error("log sink down"); }) } as unknown as Partial<TaskStore>);
    const result = await recordWipAdmissionPark(store, card(), seamContext, T0);
    expect(result.accepted).toBe(true);
  });
});

describe("publishWipAdmissionHold", () => {
  it("publishes a measured sweep verdict under the graph's node when one already parked the card", async () => {
    const { store, updateTask } = makeStore();
    const parkedByGraph = {
      code: "scheduler-seam",
      signature: wipAdmissionSignatureFrom(seamContext),
      nodeId: "parse",
      fromColumn: "todo",
      toColumn: "in-progress",
      lastAt: new Date(T0 - 20 * 60_000).toISOString(),
      firstAt: new Date(T0 - 20 * 60_000).toISOString(),
      stallCount: 1,
    };
    await publishWipAdmissionHold(
      store,
      card({ [WIP_ADMISSION_STALL_METADATA_KEY]: parkedByGraph }),
      { fromColumn: "todo", toColumn: "in-progress", heldReason: "downstream-full", poolId: "column:in-progress", occupants: 4, limit: 4 },
      T0,
    );
    const patch = (updateTask.mock.calls[0][1] as { sourceMetadataPatch: Record<string, never> }).sourceMetadataPatch;
    const episode = patch[WIP_ADMISSION_STALL_METADATA_KEY] as { nodeId: string; code: string; firstAt: string; occupants?: number };
    // One episode, one counter: the sweep sharpens the gate but inherits the graph's node and clock.
    expect(episode.nodeId).toBe("parse");
    expect(episode.code).toBe("downstream-full");
    expect(episode.occupants).toBe(4);
    expect(episode.firstAt).toBe(parkedByGraph.firstAt);
  });

  it("names itself as the author when no graph episode exists to inherit", async () => {
    const { store, updateTask } = makeStore();
    await publishWipAdmissionHold(
      store,
      card(),
      { fromColumn: "todo", toColumn: "in-progress", heldReason: "downstream-full", poolId: "column:in-progress", occupants: 2, limit: 2 },
      T0,
    );
    const patch = (updateTask.mock.calls[0][1] as { sourceMetadataPatch: Record<string, never> }).sourceMetadataPatch;
    expect((patch[WIP_ADMISSION_STALL_METADATA_KEY] as { nodeId: string }).nodeId).toBe(WIP_ADMISSION_SWEEP_NODE);
  });

  it("publishes nothing for an arm outside the closed gate vocabulary", async () => {
    const { store, updateTask } = makeStore();
    await publishWipAdmissionHold(store, card(), { fromColumn: "todo", toColumn: "in-progress", heldReason: "timer-not-elapsed" }, T0);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("sweep-arm and release-kind eligibility", () => {
  it("maps each measured sweep arm onto a gate and refuses to invent one", () => {
    expect(wipAdmissionParkCodeForHeldReason("downstream-full")).toBe("downstream-full");
    expect(wipAdmissionParkCodeForHeldReason("no-downstream-capacity-column")).toBe("no-downstream-capacity-column");
    expect(wipAdmissionParkCodeForHeldReason("move-rejected-or-no-slot")).toBe("move-rejected-or-no-slot");
    expect(wipAdmissionParkCodeForHeldReason("awaiting-approval")).toBe("awaiting-approval");
    // The readiness probe is parameterized; the gate is one thing.
    expect(wipAdmissionParkCodeForHeldReason("awaiting-planning:seed-prompt")).toBe("awaiting-planning");
    expect(wipAdmissionParkCodeForHeldReason("timer-not-elapsed")).toBeUndefined();
    expect(wipAdmissionParkCodeForHeldReason("manual-only")).toBeUndefined();
    expect(wipAdmissionParkCodeForHeldReason("reason-someone-adds-tomorrow")).toBeUndefined();
  });

  it("reads the hold release kind from the IR and treats only manual/event releases as human-owned", () => {
    const ir = (release: string) => ({
      version: "v2",
      columns: [{ id: "todo", traits: [{ trait: "hold", config: { release } }] }],
    }) as unknown as WorkflowIr;
    expect(holdReleaseKind(ir("capacity"), "todo")).toBe("capacity");
    expect(holdReleaseKind(ir("manual"), "todo")).toBe("manual");
    expect(holdReleaseKind(undefined, "todo")).toBeUndefined();
    expect(holdReleaseKind(ir("manual"), "review")).toBeUndefined();

    expect(isHumanOrEventRelease("manual")).toBe(true);
    expect(isHumanOrEventRelease("external-event")).toBe(true);
    expect(isHumanOrEventRelease("capacity")).toBe(false);
    expect(isHumanOrEventRelease("timer")).toBe(false);
    expect(isHumanOrEventRelease(undefined)).toBe(false);
  });

  it("derives one signature for one crossing no matter which writer measured what", () => {
    // The graph never sees a pool; the sweep always does. Both must name the same wait.
    const fromGraph = wipAdmissionSignatureFrom({ code: "scheduler-seam", nodeId: "parse", fromColumn: "todo", toColumn: "in-progress" });
    const fromSweep = wipAdmissionSignatureFrom({
      code: "downstream-full", nodeId: WIP_ADMISSION_SWEEP_NODE, fromColumn: "todo", toColumn: "in-progress",
      poolId: "column:in-progress", occupants: 4, limit: 4,
    });
    expect(fromSweep).toBe(fromGraph);
    // A different destination is a different wait.
    expect(wipAdmissionSignatureFrom({ code: "scheduler-seam", nodeId: "parse", fromColumn: "todo", toColumn: "review" })).not.toBe(fromGraph);
  });
});

describe("clearWipAdmissionPark", () => {
  it("clears the marker key only, and never names a column", async () => {
    const { store, updateTask } = makeStore();
    
    await clearWipAdmissionPark(store, "RUFU-393");
    const patch = updateTask.mock.calls[0][1] as { sourceMetadataPatch: Record<string, unknown> };
    expect(patch.sourceMetadataPatch).toEqual({ [WIP_ADMISSION_STALL_METADATA_KEY]: null });
  });

  it("swallows a clear failure so a marker that outlives its meaning cannot fail the move", async () => {
    const { store } = makeStore({ updateTask: vi.fn(async () => { throw new Error("store down"); }) } as unknown as Partial<TaskStore>);
    
    await expect(clearWipAdmissionPark(store, "RUFU-393")).resolves.toBeUndefined();
  });
});
