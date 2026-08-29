import { describe, expect, it } from "vitest";
import { parseNoOpCompletionMarker } from "../merge/no-op-completion-marker.js";

describe("parseNoOpCompletionMarker", () => {
  it.each([
    ["PREMISE STALE: already implemented on HEAD", "premise-stale"],
    ["NO-OP: existing behavior already satisfies the request", "no-op"],
    ["NOOP: no code changes are needed", "no-op"],
    ["DUPLICATE: FN-6239 covers the same requested behavior", "duplicate"],
    ["REDUNDANT: FN-6239 already landed this", "redundant"],
  ] as const)("recognizes leading prefix %s", (summary, kind) => {
    const marker = parseNoOpCompletionMarker(summary);

    expect(marker).toMatchObject({ kind });
    expect(marker?.reason.length).toBeGreaterThan(0);
  });

  it("matches prefixes case-insensitively", () => {
    expect(parseNoOpCompletionMarker("no-op: verified unchanged")?.kind).toBe("no-op");
    expect(parseNoOpCompletionMarker("duplicate: fn-6239 already covers it")).toMatchObject({
      kind: "duplicate",
      canonicalId: "FN-6239",
    });
  });

  it("requires the marker at the start of the summary", () => {
    expect(parseNoOpCompletionMarker("Verified existing behavior; NO-OP: no changes needed")).toBeNull();
    expect(parseNoOpCompletionMarker("The task is DUPLICATE: FN-6239")).toBeNull();
  });

  it("returns null for empty, undefined, and ordinary prose", () => {
    expect(parseNoOpCompletionMarker(undefined)).toBeNull();
    expect(parseNoOpCompletionMarker("")).toBeNull();
    expect(parseNoOpCompletionMarker("Implemented the requested behavior and verified tests.")).toBeNull();
  });

  it("captures duplicate and redundant canonical task ids", () => {
    expect(parseNoOpCompletionMarker("DUPLICATE: FN-6239 existing QuickChatFAB tests cover this")).toMatchObject({
      kind: "duplicate",
      canonicalId: "FN-6239",
      reason: "FN-6239 existing QuickChatFAB tests cover this",
    });
    expect(parseNoOpCompletionMarker("REDUNDANT: covered by fn-42 after rebase")).toMatchObject({
      kind: "redundant",
      canonicalId: "FN-42",
    });
  });

  it("does not require a canonical id for duplicate and redundant summaries", () => {
    expect(parseNoOpCompletionMarker("DUPLICATE: same request already exists on HEAD")).toEqual({
      kind: "duplicate",
      reason: "same request already exists on HEAD",
    });
  });
});
