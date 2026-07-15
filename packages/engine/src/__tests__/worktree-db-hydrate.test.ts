import { describe, expect, it, vi } from "vitest";
import { hydrateWorktreeDb } from "../worktree-db-hydrate.js";

describe("hydrateWorktreeDb", () => {
  it("uses shared PostgreSQL storage without reading a worktree-local database", async () => {
    const getTask = vi.fn();
    const warn = vi.fn();

    const result = await hydrateWorktreeDb({
      rootDir: "/repo",
      worktreePath: "/worktrees/FN-1",
      taskId: "FN-1",
      store: { getTask },
      logger: { warn },
    });

    expect(result).toEqual({
      tasksCopied: 0,
      documentsCopied: 0,
      artifactsCopied: 0,
      degraded: false,
      reason: "postgres_shared_store",
    });
    expect(getTask).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("classifies the project root without attempting hydration", async () => {
    const result = await hydrateWorktreeDb({
      rootDir: "/repo",
      worktreePath: "/repo",
      taskId: "FN-1",
      store: { getTask: vi.fn() },
      logger: { warn: vi.fn() },
    });

    expect(result.reason).toBe("root_worktree");
    expect(result.degraded).toBe(false);
  });
});
