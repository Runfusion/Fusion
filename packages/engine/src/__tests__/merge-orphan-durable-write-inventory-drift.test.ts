/*
FNXC:MergeReliability 2026-08-09-12:00:
This ratchet proves completeness only over the helper's pinned reachability closure and derived
TaskStore writer surface, with declared boundaries. It runs in engine affected/full-suite lanes,
not the curated blocking engine-core gate; a hand-written writer list or textual scanner would be
a blind spot.
*/
import { describe, expect, it } from "vitest";
import manifest from "./fixtures/merge-orphan-durable-write-inventory.json";
import { classifyReceiverForTest, deriveDurableWriterSurface, deriveMergeDurableWriteCallSites, deriveMergeReachableModules } from "./_merge-durable-write-callsites.js";

const taskId = /^FN-\d+$/;

describe("FN-8923 orphan durable-write inventory drift guard", () => {
  it("pins derived writer surface and closure", () => {
    const surface = deriveDurableWriterSurface(); const closure = deriveMergeReachableModules();
    expect(surface.unclassified, "task-store method is not classified as a durable writer or non-writer").toEqual([]);
    expect(surface.source, "writer-surface source drift").toBe(manifest.writerSurfaceSource);
    expect(surface.writers, "writer-set drift").toEqual(manifest.writerSurface);
    expect(surface.classified, "writer-surface classification drift").toEqual(manifest.writerSurfaceClassification);
    expect(closure.modules, "reachable module is not pinned in scannedModules").toEqual(manifest.scannedModules);
    expect(closure.boundary, "closure boundary drift").toEqual(manifest.closureBoundary.map(({ module, reason }) => ({ module, reason })));
  });
  it("is bijective by call-site id and fingerprint and fails closed on suspects", () => {
    const derived = deriveMergeDurableWriteCallSites();
    expect(derived.suspects, "durable-write scan could not resolve receiver").toEqual([]);
    const entries = manifest.entries;
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
    expect(manifest.inventoryStatus).toBe("final");
    for (const entry of manifest.entries) {
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
    for (const boundary of manifest.closureBoundary) expect(taskId.test(boundary.followUpTaskId)).toBe(true);
  });
});
