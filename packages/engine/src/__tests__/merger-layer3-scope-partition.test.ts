import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockStore, mockedExecSync } from "./merger-test-helpers.js";
import { applyLayer3ConflictScopePartition, partitionConflictsByFileScope } from "../merger.js";

describe("partitionConflictsByFileScope", () => {
  it("treats empty declared scope as no enforcement", () => {
    const result = partitionConflictsByFileScope({
      conflictFiles: ["AGENTS.md", "packages/core/src/store.ts"],
      declaredScope: [],
    });

    expect(result).toEqual({
      inScope: ["AGENTS.md", "packages/core/src/store.ts"],
      outOfScope: [],
    });
  });

  it("returns all in-scope files", () => {
    const result = partitionConflictsByFileScope({
      conflictFiles: ["packages/engine/src/merger.ts", "packages/engine/src/store.ts"],
      declaredScope: ["packages/engine/src/**"],
    });

    expect(result).toEqual({
      inScope: ["packages/engine/src/merger.ts", "packages/engine/src/store.ts"],
      outOfScope: [],
    });
  });

  it("returns all out-of-scope files", () => {
    const result = partitionConflictsByFileScope({
      conflictFiles: ["AGENTS.md", "packages/core/src/store.ts"],
      declaredScope: ["packages/desktop/src/**"],
    });

    expect(result).toEqual({
      inScope: [],
      outOfScope: ["AGENTS.md", "packages/core/src/store.ts"],
    });
  });

  it("partitions mixed files", () => {
    const result = partitionConflictsByFileScope({
      conflictFiles: ["packages/desktop/src/foo.ts", "packages/core/src/store.ts"],
      declaredScope: ["packages/desktop/src/**"],
    });

    expect(result).toEqual({
      inScope: ["packages/desktop/src/foo.ts"],
      outOfScope: ["packages/core/src/store.ts"],
    });
  });

  it("matches glob scope entries", () => {
    const result = partitionConflictsByFileScope({
      conflictFiles: ["packages/core/src/store.ts", "packages/core/test/store.test.ts"],
      declaredScope: ["packages/core/src/**"],
    });

    expect(result).toEqual({
      inScope: ["packages/core/src/store.ts"],
      outOfScope: ["packages/core/test/store.test.ts"],
    });
  });

  it("supports .changeset patterns", () => {
    const result = partitionConflictsByFileScope({
      conflictFiles: [".changeset/fn-4956.md", "AGENTS.md"],
      declaredScope: [".changeset/*"],
    });

    expect(result).toEqual({
      inScope: [".changeset/fn-4956.md"],
      outOfScope: ["AGENTS.md"],
    });
  });
});

describe("applyLayer3ConflictScopePartition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves out-of-scope conflicts to ours and emits skip audit", async () => {
    const store = createMockStore() as any;
    store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue(["packages/desktop/src/**"]);
    const task = await store.getTask("FN-050");
    const gitCalls: string[] = [];

    mockedExecSync.mockImplementation((cmd: any) => {
      const c = String(cmd);
      gitCalls.push(c);
      if (c.includes("git diff --cached --name-only")) {
        return "packages/desktop/src/foo.ts\n";
      }
      return "";
    });

    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await applyLayer3ConflictScopePartition({
      store,
      task,
      taskId: "FN-050",
      rootDir: "/tmp/root",
      branch: "fusion/fn-050",
      conflictFiles: ["packages/desktop/src/foo.ts", "AGENTS.md"],
      auditor: audit,
    });

    expect(result.inScopeConflicts).toEqual(["packages/desktop/src/foo.ts"]);
    expect(result.skippedFiles).toEqual(["AGENTS.md"]);
    expect(gitCalls.some((call) => call.includes("git checkout --ours -- AGENTS.md"))).toBe(true);
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "merge:layer3:foreign-file-skipped",
      target: "fusion/fn-050",
      metadata: expect.objectContaining({
        taskId: "FN-050",
        skippedFiles: ["AGENTS.md"],
        inScopeCount: 1,
        viaScopeOverride: false,
      }),
    }));
  });

  it("emits scope override bypass audit and skips partition", async () => {
    const store = createMockStore({ scopeOverride: true, scopeOverrideReason: "hotfix" }) as any;
    store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue(["packages/desktop/src/**"]);
    const task = await store.getTask("FN-050");
    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;

    const result = await applyLayer3ConflictScopePartition({
      store,
      task,
      taskId: "FN-050",
      rootDir: "/tmp/root",
      branch: "fusion/fn-050",
      conflictFiles: ["packages/desktop/src/foo.ts", "AGENTS.md"],
      auditor: audit,
    });

    expect(result.inScopeConflicts).toEqual(["packages/desktop/src/foo.ts", "AGENTS.md"]);
    expect(result.skippedFiles).toEqual([]);
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "merge:layer3:scope-override-bypass",
      metadata: expect.objectContaining({ viaScopeOverride: true }),
    }));
  });
});
