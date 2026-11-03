/*
FNXC:CapacityGateFacts 2026-11-02-23:30 (RUFU-372 second revision):
"Who is holding my slot?" is the question an operator asks after "why is this card stuck?", and before
this change it had no answer on any surface the operator can open: the audit row named the column and its
counts, the card's History line named neither the holders nor the fact that nobody recorded them.

The holders now ride the SAME accepted episode write as the counts, so the episode, the History line, and
the audit row quote one measurement. Two shapes must stay distinguishable in the History text, because
silence about holders reads as "nobody holds it" — the exact opposite claim, and the misread that made
235 capacity rows look like pressure when no pool had been consulted at all.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { WIP_ADMISSION_STALL_METADATA_KEY } from "@fusion/core";
import { recordWipAdmissionPark } from "../execution/wip-admission-park.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function storeHarness() {
  const patches: Array<Record<string, unknown>> = [];
  /** History lines as the store received them, whatever seam shape it exposes. */
  const actions: string[] = [];
  const store = {
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    }),
    logEntryOnce: vi.fn(async (_id: string, input: { action: string }) => {
      actions.push(input.action);
      return true;
    }),
    logEntry: vi.fn(async (_id: string, action: string) => {
      actions.push(action);
    }),
  } as unknown as TaskStore;
  return { store, patches, actions };
}

const baseContext = {
  code: "column-capacity",
  nodeId: "parse",
  fromColumn: "todo",
  toColumn: "in-progress",
  poolId: "in-progress",
  occupants: 2,
  limit: 2,
} as const;

function announced(actions: string[]): string {
  return actions.join("\n");
}

describe("recordWipAdmissionPark — holder forensics reach the card", () => {
  it("stores the holders on the episode and names them on the History line", async () => {
    const { store, patches, actions } = storeHarness();

    const result = await recordWipAdmissionPark(store, { id: "RUFU-372P1", sourceMetadata: undefined }, {
      ...baseContext,
      heldBy: ["RUFU-H1", "RUFU-H2"],
      oldestHolderAgeMs: 2 * 60 * 60_000,
    }, NOW);

    expect(result.accepted).toBe(true);
    const episode = (patches[0] as { sourceMetadataPatch: Record<string, any> }).sourceMetadataPatch[WIP_ADMISSION_STALL_METADATA_KEY];
    expect(episode.heldBy).toEqual(["RUFU-H1", "RUFU-H2"]);
    expect(episode.oldestHolderAgeMs).toBe(2 * 60 * 60_000);
    const announcedText = announced(actions);
    expect(announcedText).toContain("held by RUFU-H1, RUFU-H2");
    // The oldest hold is rendered as elapsed time, not a raw millisecond count.
    expect(announcedText).toContain("longest 2 h");
  });

  it("says so when holders were never recorded, instead of implying the pool is empty", async () => {
    const { store, actions } = storeHarness();

    await recordWipAdmissionPark(store, { id: "RUFU-372P2", sourceMetadata: undefined }, baseContext, NOW);

    // Three distinct sentences, three distinct claims. Absent holders must never render as "no holder".
    expect(announced(actions)).toContain("holders not recorded");
  });

  it("distinguishes a recorded-empty holder set from an unrecorded one", async () => {
    const { store, patches, actions } = storeHarness();

    await recordWipAdmissionPark(store, { id: "RUFU-372P3", sourceMetadata: undefined }, { ...baseContext, heldBy: [] }, NOW);

    const episode = (patches[0] as { sourceMetadataPatch: Record<string, any> }).sourceMetadataPatch[WIP_ADMISSION_STALL_METADATA_KEY];
    expect(episode.heldBy).toEqual([]);
    const text = announced(actions);
    expect(text).toContain("held by no recorded card");
    expect(text).not.toContain("holders not recorded");
  });
});
