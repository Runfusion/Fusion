import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";

/*
 * FNXC:MergeContentDescriptorDoors 2026-08-23-09:15:
 * FN-180 requires merge doors to distinguish an empty patch from unavailable Git proof. The
 * capture seam is deliberately fail-closed: unavailable evidence is a descriptor the positive
 * gate can defer, never an implicit approval.
 */
describe("FN-180 merge content descriptor doors", () => {
  it("returns an unavailable singular descriptor when the door cannot establish a diff base", async () => {
    const descriptor = await captureMergeContentDescriptor({ id: "FN-180", column: "in-review" } as Task, {
      workspaceRootDir: process.cwd(), settings: {},
    });
    expect(descriptor).toEqual({ kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } });
  });

  it("keeps workspace evidence capture separate from the scalar singular descriptor", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../merge/merge-content-capture.ts", import.meta.url), "utf8",
    );
    expect(source).toContain("captureWorkspaceReviewEvidence");
    expect(source).toContain('state: "unavailable", reason: "workspace-evidence-capture-failed"');
    expect(source).not.toContain("reviewInputFingerprint");
  });
});
