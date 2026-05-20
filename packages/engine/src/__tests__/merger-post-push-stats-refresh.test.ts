import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, setupHappyPathExecSync, type Task } from "./merger-test-helpers.js";
import * as mergerModule from "../merger.js";
import { mergerLog } from "../logger.js";

describe("aiMergeTask — post-push mergeDetails stats refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);
  });

  function makeStore(initialMergeDetails: Task["mergeDetails"]) {
    const store = createMockStore(
      { id: "FN-4526", worktree: "/tmp/root/.worktrees/FN-4526", mergeDetails: initialMergeDetails },
      [{ id: "FN-4526", worktree: "/tmp/root/.worktrees/FN-4526", column: "in-review" } as Task],
    );
    const task = {
      id: "FN-4526",
      title: "Test",
      description: "Test",
      column: "in-review",
      dependencies: [],
      worktree: "/tmp/root/.worktrees/FN-4526",
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergeDetails: initialMergeDetails,
      prompt: "# test",
    } as Task;
    (store.getTask as any).mockResolvedValue(task);
    (store.getSettings as any).mockResolvedValue({
      pushAfterMerge: true,
      pushRemote: "origin",
      includeTaskIdInCommit: true,
      mergeConflictStrategy: "smart-prefer-main",
      mergeIntegrationWorktree: "cwd-main" as const,
    });
    return store;
  }

  it("recomputes mergeDetails stats when post-push HEAD changes", async () => {
    const store = makeStore({ commitSha: "OLD_SHA", filesChanged: 108, insertions: 200, deletions: 50, mergeConfirmed: true, mergeCommitMessage: "summary" });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("git symbolic-ref --short HEAD")) return "main";
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "NEW_SHA";
      if (s.includes("show --shortstat --format= HEAD")) return "108 files changed, 200 insertions(+), 50 deletions(-)";
      if (s.includes("show --shortstat --format=") && !s.includes("HEAD")) return "2 files changed, 5 insertions(+), 1 deletion(-)\n";
      if (s.includes("git log")) return "- feat: summary" as any;
      if (s.includes("merge-base")) return Buffer.from("base123");
      if (s.includes("merge --squash")) return Buffer.from("");
      if (s.includes("pull --rebase")) return "";
      if (s.includes("git push origin main")) return "";
      if (s.includes("diff --cached --quiet")) return "1" as any;
      if (s.includes("diff --cached")) return "0" as any;
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4526");
    const updates = (store.updateTask as any).mock.calls.map((c: any[]) => c[1]);
    expect(updates.some((u: any) => u.mergeDetails?.commitSha === "NEW_SHA" && u.mergeDetails?.filesChanged === 2 && u.mergeDetails?.insertions === 5 && u.mergeDetails?.deletions === 1)).toBe(true);
  });

  it("falls back to SHA-only refresh when post-push shortstat read fails", async () => {
    const warnSpy = vi.spyOn(mergerLog, "warn").mockImplementation(() => undefined);
    const store = makeStore({ commitSha: "OLD_SHA", filesChanged: 108, insertions: 200, deletions: 50, mergeConfirmed: true, mergeCommitMessage: "summary" });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("git symbolic-ref --short HEAD")) return "main";
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "NEW_SHA";
      if (s.includes("show --shortstat --format= HEAD")) return "108 files changed, 200 insertions(+), 50 deletions(-)";
      if (s.includes("show --shortstat --format=") && !s.includes("HEAD")) throw new Error("shortstat failed");
      if (s.includes("git log")) return "- feat: summary" as any;
      if (s.includes("merge-base")) return Buffer.from("base123");
      if (s.includes("merge --squash")) return Buffer.from("");
      if (s.includes("pull --rebase")) return "";
      if (s.includes("git push origin main")) return "";
      if (s.includes("diff --cached --quiet")) return "1" as any;
      if (s.includes("diff --cached")) return "0" as any;
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4526");
    const updates = (store.updateTask as any).mock.calls.map((c: any[]) => c[1]);
    expect(updates.some((u: any) => u.mergeDetails?.commitSha === "NEW_SHA" && u.mergeDetails?.filesChanged === 108 && u.mergeDetails?.insertions === 200 && u.mergeDetails?.deletions === 50)).toBe(true);
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("post-push SHA refreshed but stat recompute failed"))).toBe(true);
  });

  it("does not write a post-push refresh when HEAD SHA is unchanged", async () => {
    const store = makeStore({ commitSha: "SAME_SHA", filesChanged: 108, insertions: 200, deletions: 50, mergeConfirmed: true, mergeCommitMessage: "summary" });
    mockedExecSync.mockImplementation((cmd: any) => {
      const s = String(cmd);
      if (s.includes("git symbolic-ref --short HEAD")) return "main";
      if (s === "git rev-parse HEAD" || s.startsWith("git rev-parse HEAD ")) return "SAME_SHA";
      if (s.includes("show --shortstat --format= HEAD")) return "108 files changed, 200 insertions(+), 50 deletions(-)";
      if (s.includes("git log")) return "- feat: summary" as any;
      if (s.includes("merge-base")) return Buffer.from("base123");
      if (s.includes("merge --squash")) return Buffer.from("");
      if (s.includes("pull --rebase")) return "";
      if (s.includes("git push origin main")) return "";
      if (s.includes("diff --cached --quiet")) return "1" as any;
      if (s.includes("diff --cached")) return "0" as any;
      return Buffer.from("");
    });

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-4526");
    const updates = (store.updateTask as any).mock.calls.map((c: any[]) => c[1]);
    expect(updates.some((u: any) => u.mergeDetails?.commitSha === "SAME_SHA" && u.mergeDetails?.filesChanged === 108)).toBe(true);
    expect(updates.some((u: any) => u.mergeDetails?.commitSha === "SAME_SHA" && u.mergeDetails?.filesChanged === 2)).toBe(false);
  });
});
