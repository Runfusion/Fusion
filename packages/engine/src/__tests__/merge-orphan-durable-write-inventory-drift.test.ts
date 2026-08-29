/*
FNXC:MergeReliability 2026-08-09-12:00:
This ratchet proves completeness only over the helper's pinned reachability closure and derived
TaskStore writer surface, with declared boundaries. It runs in engine affected/full-suite lanes,
not the curated blocking engine-core gate; a hand-written writer list or textual scanner would be
a blind spot.

FNXC:MergeReliability 2026-08-11-21:59:
Run `FUSION_UPDATE_MERGE_INVENTORY=1 pnpm --filter @fusion/engine exec vitest run
src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts` to update derivable structure.
It preserves human verdicts only by call-site id; new rows deliberately receive `pending:classify`
and stay red until a reviewer supplies a real lifecycle classification.
*/
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import rawManifest from "./fixtures/merge-orphan-durable-write-inventory.json";
import { assertInventoryRegenerationInputs, buildInventoryManifest, classifyReceiverForTest, deriveDurableWriterSurface, deriveMergeDurableWriteCallSites, deriveMergeReachableModules, type InventoryEntry, type InventoryManifest } from "./_merge-durable-write-callsites.js";

const taskId = /^FN-\d+$/;
const manifest = rawManifest as InventoryManifest;
const updateInventory = process.env.FUSION_UPDATE_MERGE_INVENTORY === "1";
const currentManifest = updateInventory ? buildInventoryManifest(manifest) : manifest;
if (updateInventory) writeFileSync(resolve(__dirname, "fixtures/merge-orphan-durable-write-inventory.json"), `${JSON.stringify(currentManifest, null, 2)}\n`);

function assertInventoryEntry(entry: InventoryEntry): void {
  expect(["checkpoint-covered", "checkpoint-gap", "unreachable-after-abort", "out-of-frontier", "indeterminate"]).toContain(entry.axis1);
  expect(["already-fenced", "benign-unfenced", "must-be-fenced", "out-of-frontier", "unresolved"]).toContain(entry.axis2Final);
  expect(entry.observedInSuite).not.toBe("layerB-not-observed"); expect(entry.executionProof).toBeTruthy(); expect(entry.axis1Evidence).toBeTruthy();
  if (entry.observedInSuite.startsWith("unobservable:")) expect(entry.axis2Final).toBe("unresolved");
  if (entry.axis2Final === "already-fenced") { expect(entry.executionProof).not.toBe("positive-observation"); expect(entry.executionProof.startsWith("none:")).toBe(false); }
  const outside = entry.axis1 === "out-of-frontier";
  if (outside) {
    expect([entry.axis2Final, entry.observedInSuite, entry.executionProof, entry.followUpTaskId]).toEqual(["out-of-frontier", "out-of-frontier", "none:out-of-frontier", "none:out-of-frontier"]);
    expect(entry.axis1Evidence).toContain("No call edge");
  }
  else expect(entry.followUpTaskId.startsWith("pending:")).toBe(false);
  if (["must-be-fenced", "unresolved"].includes(entry.axis2Final)) expect(taskId.test(entry.followUpTaskId)).toBe(true);
  if (["already-fenced", "benign-unfenced"].includes(entry.axis2Final)) expect(entry.followUpTaskId).toBe("none:no-follow-up-required");
}

describe("FN-8923 orphan durable-write inventory drift guard", () => {
  it("pins derived writer surface and closure", () => {
    const surface = deriveDurableWriterSurface(); const closure = deriveMergeReachableModules();
    expect(surface.unclassified, "task-store method is not classified as a durable writer or non-writer").toEqual([]);
    expect(surface.source, "writer-surface source drift").toBe(currentManifest.writerSurfaceSource);
    expect(surface.writers, "writer-set drift").toEqual(currentManifest.writerSurface);
    expect(surface.classified, "writer-surface classification drift").toEqual(currentManifest.writerSurfaceClassification);
    expect(closure.modules, "reachable module is not pinned in scannedModules").toEqual(currentManifest.scannedModules);
    expect(closure.boundary, "closure boundary drift").toEqual(currentManifest.closureBoundary.map(({ module, reason }) => ({ module, reason })));
  });
  it("is bijective by call-site id and fingerprint and fails closed on suspects", () => {
    const derived = deriveMergeDurableWriteCallSites();
    expect(derived.suspects, "durable-write scan could not resolve receiver").toEqual([]);
    const entries = currentManifest.entries;
    expect(new Set(entries.map((entry) => entry.callSiteId)).size).toBe(entries.length);
    expect(derived.callSites.map((site) => site.callSiteId), "new durable write is not classified").toEqual(entries.map((entry) => entry.callSiteId));
    for (const site of derived.callSites) expect(entries.find((entry) => entry.callSiteId === site.callSiteId)?.callSiteFingerprint, `durable write ${site.callSiteId} has a different call shape`).toBe(site.callSiteFingerprint);
  });
  it("pins the provable-alias versus unprovable-receiver split", () => {
    expect(classifyReceiverForTest("const s = options.store; s.updateTask()"), "provable alias becomes a call site").toBe("provable");
    expect(classifyReceiverForTest("const { updateTask } = options.store; updateTask()"), "destructured receiver fails closed").toBe("suspect");
    expect(classifyReceiverForTest("options.store[\"updateTask\"]()"), "computed receiver fails closed").toBe("suspect");
  });
  it("enforces final lifecycle, axes, observations, proofs, and out-of-frontier tuple", () => {
    expect(currentManifest.inventoryStatus).toBe("final");
    for (const entry of currentManifest.entries) assertInventoryEntry(entry);
    for (const boundary of currentManifest.closureBoundary) expect(taskId.test(boundary.followUpTaskId)).toBe(true);
  });
  it("rebuilds a current manifest without changing it", () => {
    expect(buildInventoryManifest(manifest)).toEqual(manifest);
  });
  it("marks a missing call-site verdict pending and fails the lifecycle guard", () => {
    const withoutEntry = { ...manifest, entries: manifest.entries.slice(1) };
    const rebuilt = buildInventoryManifest(withoutEntry);
    const pending = rebuilt.entries.find((entry) => entry.callSiteId === manifest.entries[0]?.callSiteId);
    expect(pending?.followUpTaskId).toMatch(/^pending:/);
    expect(() => assertInventoryEntry(pending!)).toThrow();
  });
  it("carries every human verdict forward while replacing structural fields", () => {
    const prior = manifest.entries[0]!;
    const revised = { ...manifest, entries: [{ ...prior, axis1Evidence: "human verdict survives structural reconciliation" }] };
    const rebuilt = buildInventoryManifest(revised);
    const result = rebuilt.entries.find((entry) => entry.callSiteId === prior.callSiteId)!;
    const expectedVerdict = revised.entries[0]!;
    for (const field of ["owningEntryPoint", "reachableDataStates", "axis1", "axis1Evidence", "axis2Provisional", "axis2Final", "observedInSuite", "executionProof", "followUpTaskId"] as const) expect(result[field]).toEqual(expectedVerdict[field]);
    const derived = deriveMergeDurableWriteCallSites().callSites.find((site) => site.callSiteId === prior.callSiteId)!;
    expect({ callSiteId: result.callSiteId, callSiteFingerprint: result.callSiteFingerprint, file: result.file, enclosingSymbolPath: result.enclosingSymbolPath, writer: result.writer, ordinal: result.ordinal, lineHint: result.lineHint }).toEqual(derived);
  });
  it("refuses regeneration when classification or receiver derivation is incomplete", () => {
    expect(() => assertInventoryRegenerationInputs({ unclassified: ["newWriter"], suspects: [] })).toThrow("unclassified TaskStore methods");
    expect(() => assertInventoryRegenerationInputs({ unclassified: [], suspects: [{ file: "fixture.ts", line: 1, text: "store[newWriter]()", reason: "computed" }] })).toThrow("unresolved durable-write receivers");
  });
});
