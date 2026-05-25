import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseStaleRegistrationPath, recoverStaleRegistration } from "../worktree-stale-registration.js";

const { execMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock };
});

vi.mock("node:child_process", () => ({ exec: execMock }));

describe("worktree-stale-registration", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("parseStaleRegistrationPath parses FN-5056 fixture", () => {
    const fixture = `Failed to create worktree: Command failed: git worktree add \"/repo/.worktrees/fast-tiger/.worktrees/happy-olive\" \"fusion/fn-4995\"\nPreparing worktree (checking out 'fusion/fn-4995')\nfatal: '/repo/.worktrees/fast-tiger/.worktrees/happy-olive' is a missing but already registered worktree; use 'add -f' to override, or 'prune' or 'remove' to clear`;
    expect(parseStaleRegistrationPath(fixture)).toBe(
      "/repo/.worktrees/fast-tiger/.worktrees/happy-olive",
    );
  });

  it("parseStaleRegistrationPath returns null for unrelated/empty input", () => {
    expect(parseStaleRegistrationPath("fatal: not a git repository")).toBeNull();
    expect(parseStaleRegistrationPath("")).toBeNull();
  });

  it("recoverStaleRegistration runs prune then remove-force when still registered", async () => {
    execMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/fn-1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await recoverStaleRegistration({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1" });

    expect(result).toEqual({ recovered: true, actions: ["prune", "remove-force"] });
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      "git worktree prune",
      expect.objectContaining({ cwd: "/repo", timeout: 30000, maxBuffer: 10485760 }),
    );
    expect(execMock).toHaveBeenNthCalledWith(2, "git worktree list --porcelain", expect.any(Object));
    expect(execMock).toHaveBeenNthCalledWith(3, 'git worktree remove --force "/repo/.worktrees/fn-1"', expect.any(Object));
  });

  it("returns recovered false when prune fails", async () => {
    execMock.mockRejectedValueOnce(new Error("prune failed"));

    const result = await recoverStaleRegistration({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1" });

    expect(result.recovered).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.reason).toContain("prune failed");
  });

  it("swallows remove-force errors when prune succeeds", async () => {
    execMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/fn-1\n", stderr: "" })
      .mockRejectedValueOnce(new Error("path missing"));

    const result = await recoverStaleRegistration({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1" });

    expect(result).toEqual({ recovered: true, actions: ["prune", "remove-force"] });
  });

  it("handles list --porcelain errors as non-fatal and still attempts remove-force", async () => {
    execMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("list failed"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await recoverStaleRegistration({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1" });

    expect(result).toEqual({ recovered: true, actions: ["prune", "remove-force"] });
    expect(execMock).toHaveBeenNthCalledWith(3, 'git worktree remove --force "/repo/.worktrees/fn-1"', expect.any(Object));
  });
});
