import { describe, expect, it } from "vitest";
import { pruneTerminalPreviewSessions } from "../preview/preview-sessions.js";
import { candidateTaskCodeRefs, qualityQaWorktreePath } from "../preview/task-code-worktree.js";

function terminalSession(stoppedAt: string) {
  return {
    projectId: "project",
    taskId: stoppedAt,
    status: "stopped" as const,
    command: "pnpm run dev",
    cwd: "/workspace",
    stoppedAt,
    logTail: [],
  };
}

describe("preview session retention", () => {
  it("removes expired terminal sessions and bounds retained terminal metadata", () => {
    const now = Date.parse("2026-07-15T14:10:00.000Z");
    const sessions = new Map<string, ReturnType<typeof terminalSession>>([
      ["expired", terminalSession("2026-07-15T12:00:00.000Z")],
      ...Array.from({ length: 51 }, (_, index) => [
        `recent-${index}`,
        terminalSession(new Date(now - (51 - index) * 1_000).toISOString()),
      ] as const),
    ]);

    pruneTerminalPreviewSessions(sessions, now);

    expect(sessions.has("expired")).toBe(false);
    expect(sessions.size).toBe(50);
    expect(sessions.has("recent-0")).toBe(false);
  });
});

describe("task code worktree helpers", () => {
  it("prefers recorded branch, fusion/<id>, then merge sha", () => {
    expect(
      candidateTaskCodeRefs({
        id: "FN-12",
        branch: "feature/fn-12",
        mergeDetails: { commitSha: "abc1234" },
      }),
    ).toEqual(["feature/fn-12", "fusion/fn-12", "abc1234"]);
  });

  it("places disposable QA worktrees under .fusion/quality-qa", () => {
    expect(qualityQaWorktreePath("/repo", "FN-99")).toBe("/repo/.fusion/quality-qa/fn-99");
  });
});
