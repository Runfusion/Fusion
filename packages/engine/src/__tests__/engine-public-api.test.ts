import { describe, expect, it } from "vitest";
import {
  BranchConflictError,
  DiffVolumeRegressionError,
  MergeAbortedError,
  SquashAuditError,
  type SquashAuditFindings,
} from "../index.js";

const emptySquashAuditFindings: SquashAuditFindings = {
  strategy: "squash",
  squashSha: "abc12345",
  parentSha: "def67890",
  squashSubject: "squash subject",
  auditTargetLabel: "abc12345",
  lookback: 30,
  branchSubjects: [],
  recentMainSubjects: [],
  duplicateSubjects: [],
  touchedFiles: [],
  touchedFileOverlaps: [],
  findings: [],
  issueCount: 0,
  clean: true,
};

describe("engine public api barrel", () => {
  it.each([
    {
      name: "BranchConflictError",
      ctor: () => new BranchConflictError({
        branchName: "task/fn-4238",
        conflictingWorktreePath: "/tmp/worktree",
        existingTipSha: "0123456789ab",
        strandedCommits: [],
        startPoint: "main",
        recommendedAction: "Rebase the task branch.",
      }),
    },
    {
      name: "DiffVolumeRegressionError",
      ctor: () => new DiffVolumeRegressionError([]),
    },
    {
      name: "MergeAbortedError",
      ctor: () => new MergeAbortedError("merge aborted"),
    },
    {
      name: "SquashAuditError",
      ctor: () => new SquashAuditError("FN-4238", "abc12345", emptySquashAuditFindings),
    },
  ])("exports $name from ../index.js", ({ name, ctor }) => {
    expect(ctor).toBeTypeOf("function");

    const error = ctor();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
  });
});
