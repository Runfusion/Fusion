import { describe, expect, it } from "vitest";
import { fileScopeLeaseBlocksCandidate, type FileScopeLeaseClassification } from "../index.js";

const active: FileScopeLeaseClassification = { kind: "active", waivedForTaskIds: [] };
const none: FileScopeLeaseClassification = { kind: "none", waivedForTaskIds: [] };
const dormant: FileScopeLeaseClassification = { kind: "dormant", waivedForTaskIds: [] };

function task(id: string, priority: "low" | "normal" | "high" | "urgent" = "normal", createdAt = "2026-01-01T00:00:00.000Z") {
  return { id, priority, createdAt };
}

describe("fileScopeLeaseBlocksCandidate", () => {
  it("does not let a lease block its own task", () => {
    const holder = task("FN-001");

    expect(fileScopeLeaseBlocksCandidate(holder, holder, active)).toBe(false);
  });

  it("honors targeted dependency waivers without releasing the lease to other work", () => {
    const holder = task("FN-001");
    const waived = task("FN-002");
    const unrelated = task("FN-003");
    const classification: FileScopeLeaseClassification = {
      kind: "active",
      waivedForTaskIds: [waived.id],
    };

    expect(fileScopeLeaseBlocksCandidate(holder, waived, classification)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(holder, unrelated, classification)).toBe(true);
  });

  it("orders dormant holders by priority, age, then numeric task id", () => {
    const candidate = task("FN-100", "normal", "2026-01-02T00:00:00.000Z");

    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "high"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "low"), candidate, dormant)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "normal", "2026-01-01T00:00:00.000Z"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-001", "normal", candidate.createdAt),
      task("FN-002", "normal", candidate.createdAt),
      dormant,
    )).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-002", "normal", candidate.createdAt),
      task("FN-001", "normal", candidate.createdAt),
      dormant,
    )).toBe(false);
  });

  it("never blocks when no lease exists", () => {
    expect(fileScopeLeaseBlocksCandidate(task("FN-001"), task("FN-002"), none)).toBe(false);
  });
});
