/**
 * FN-4811 follow-up: `.changeset/` files are always allowed by the scope-leak guard,
 * regardless of the task's declared file scope. By convention every task may add its
 * own changeset entry under `.changeset/` (per AGENTS.md "Finalizing Changes"), and
 * cross-task changeset leakage is caught by stronger downstream guards (file-scope
 * invariant at squash, post-merge audit) — so the per-execution scope-leak warning
 * doesn't need to flag them.
 */
import { describe, it, expect } from "vitest";
import { isAlwaysAllowedScopeLeakPath } from "../executor.js";

describe("FN-4811 follow-up: scope-leak always-allowed paths", () => {
  it("treats .changeset/*.md files as always allowed", () => {
    expect(isAlwaysAllowedScopeLeakPath(".changeset/FN-4811-fix.md")).toBe(true);
    expect(isAlwaysAllowedScopeLeakPath(".changeset/fn-4811-fix.md")).toBe(true);
    expect(isAlwaysAllowedScopeLeakPath(".changeset/config.json")).toBe(true);
  });

  it("treats nested .changeset/ paths as always allowed", () => {
    expect(isAlwaysAllowedScopeLeakPath(".changeset/nested/dir/file.md")).toBe(true);
  });

  it("does NOT match arbitrary paths", () => {
    expect(isAlwaysAllowedScopeLeakPath("packages/engine/src/executor.ts")).toBe(false);
    expect(isAlwaysAllowedScopeLeakPath("README.md")).toBe(false);
    expect(isAlwaysAllowedScopeLeakPath(".changesetlike.md")).toBe(false);
    expect(isAlwaysAllowedScopeLeakPath("docs/.changeset/x.md")).toBe(false);
  });
});
