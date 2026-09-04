import { describe, expect, it, vi } from "vitest";

import type { Task, TaskStore } from "@fusion/core";

import { persistWorkspaceCodeReviewApproval } from "../executor/create-authoritative-workflow-seams.js";
import {
  buildWorkspaceReviewOutcome,
  preserveOutcomeFindingsFromReviewOutput,
  toWorkspaceRepoReviewResult,
  WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE,
} from "../executor/run-graph-custom-node.js";
import { qualifyRepositoryFindings, reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";
import { reviewInputSignature } from "../executor/request-pre-merge-optional-step-fix.js";
import { deriveWorkspaceReviewRemediation } from "../executor/workspace-review-remediation.js";
import { workflowStepVerdictNoNotesNotice } from "../executor/workflow-step-verdict.js";

function workspaceTask(): Task {
  return {
    id: "FN-201",
    column: "in-review",
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo-a", "repo-b"] },
    workspaceWorktrees: {
      "repo-a": { worktreePath: "/workspace/repo-a", baseCommitSha: "a" },
      "repo-b": { worktreePath: "/workspace/repo-b", baseCommitSha: "b" },
    },
  } as unknown as Task;
}

async function reviewWorkspace(
  results: Record<string, { verdict: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE"; findings?: Array<{ id: string; title: string; body: string; filePath?: string }> }>,
) {
  return reviewWorkspacePerRepo(workspaceTask(), async (cwd) => {
    const repo = cwd.slice(cwd.lastIndexOf("/") + 1);
    const result = results[repo];
    return { ...result, review: result.verdict, summary: result.verdict } as never;
  }, {
    workspaceRepos: ["repo-a", "repo-b"],
    workspaceRootDir: "/workspace",
    captureModifiedFiles: async (repo) => [`src/${repo}.ts`],
  });
}

describe("workspace Code Review findings", () => {
  it("forwards structured findings from a revised repository outcome", () => {
    const findings = [
      { id: "finding-1", title: "First", body: "Fix the first issue", filePath: "src/one.ts" },
      { id: "finding-2", title: "Second", body: "Fix the second issue", filePath: "src/two.ts" },
    ];

    expect(toWorkspaceRepoReviewResult({ success: false, verdict: "REVISE", output: "revise", findings })).toEqual({
      verdict: "REVISE",
      review: "revise",
      summary: "revise",
      retryable: true,
      findings,
    });
  });

  it("keeps successful finding-less outcomes compact", () => {
    expect(toWorkspaceRepoReviewResult({ success: true, output: "approved" })).toEqual({
      verdict: "APPROVE",
      review: "approved",
      summary: "approved",
      retryable: false,
    });
  });

  it("maps an errored outcome to unavailable review text", () => {
    expect(toWorkspaceRepoReviewResult({ success: false, error: "reviewer unavailable" })).toEqual({
      verdict: "UNAVAILABLE",
      review: "reviewer unavailable",
      summary: "reviewer unavailable",
      retryable: true,
    });
  });

  it("preserves repository notes and prefers them over mirrored output", () => {
    expect(toWorkspaceRepoReviewResult({ success: true, verdict: "APPROVE", output: "older output", notes: "review rationale" })).toEqual({
      verdict: "APPROVE",
      review: "review rationale",
      summary: "review rationale",
      retryable: false,
    });
    expect(toWorkspaceRepoReviewResult({ success: true, verdict: "APPROVE", output: "", notes: "review rationale" })).toMatchObject({
      review: "review rationale",
      summary: "review rationale",
    });
  });

  it("retains the workspace notice for an exit-zero script outcome with no text", () => {
    expect(toWorkspaceRepoReviewResult({ success: true })).toEqual({
      verdict: "APPROVE",
      review: WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE,
      summary: WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE,
      retryable: false,
    });
  });

  it("preserves shared prompt-review narration without selecting a second workspace notice", () => {
    const notice = workflowStepVerdictNoNotesNotice("APPROVE", "empty");
    const repositoryOutcome = toWorkspaceRepoReviewResult({
      success: true,
      verdict: "APPROVE",
      output: notice,
      notes: notice,
      notesMissing: true,
    });
    expect(repositoryOutcome).toEqual({
      verdict: "APPROVE",
      review: notice,
      summary: notice,
      retryable: false,
    });
    expect(repositoryOutcome.review).not.toBe(WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE);

    const aggregateOutcome = buildWorkspaceReviewOutcome({
      verdict: "APPROVE",
      review: notice,
      summary: notice,
      repositoryReviewOutcomes: [],
    });
    expect(aggregateOutcome).toMatchObject({ success: true, verdict: "APPROVE", output: notice, notes: notice });
    expect(aggregateOutcome).not.toHaveProperty("notesMissing");
  });

  it("qualifies identifiers, paths, and dispute links without changing other finding fields", () => {
    expect(qualifyRepositoryFindings("repo-a", [{
      id: "finding-1",
      title: "Title",
      body: "Body",
      filePath: "src/x.ts",
      rebutsDisputedFindingId: "finding-0",
      severity: "high",
      disputeRationale: "The implementation disagrees.",
    }])).toEqual([{
      id: "repo-a:finding-1",
      title: "Title",
      body: "Body",
      filePath: "repo-a/src/x.ts",
      rebutsDisputedFindingId: "repo-a:finding-0",
      severity: "high",
      disputeRationale: "The implementation disagrees.",
    }]);
  });

  it("does not double-qualify finding values that already name their repository", () => {
    const findings = [{ id: "repo-a:finding-1", title: "Title", body: "Body", filePath: "repo-a/src/x.ts", rebutsDisputedFindingId: "repo-a:finding-0" }];
    expect(qualifyRepositoryFindings("repo-a", findings)).toEqual(findings);
  });

  it("aggregates distinct repository-qualified findings into reviewed outcomes", async () => {
    const aggregate = await reviewWorkspace({
      "repo-a": { verdict: "APPROVE", findings: [{ id: "finding-1", title: "A", body: "Body A", filePath: "src/x.ts" }] },
      "repo-b": { verdict: "REVISE", findings: [{ id: "finding-1", title: "B", body: "Body B", filePath: "src/x.ts" }] },
    });

    expect(aggregate.findings).toEqual([
      { id: "repo-a:finding-1", title: "A", body: "Body A", filePath: "repo-a/src/x.ts" },
      { id: "repo-b:finding-1", title: "B", body: "Body B", filePath: "repo-b/src/x.ts" },
    ]);
    expect(aggregate.repositoryReviewOutcomes?.map((outcome) => outcome.findings)).toEqual([
      [{ id: "repo-a:finding-1", title: "A", body: "Body A", filePath: "repo-a/src/x.ts" }],
      [{ id: "repo-b:finding-1", title: "B", body: "Body B", filePath: "repo-b/src/x.ts" }],
    ]);
  });

  it("omits aggregate findings when reviewers return no structured findings", async () => {
    const aggregate = await reviewWorkspace({
      "repo-a": { verdict: "APPROVE" },
      "repo-b": { verdict: "APPROVE" },
    });

    expect(aggregate).not.toHaveProperty("findings");
    expect(aggregate.repositoryReviewOutcomes?.every((outcome) => !("findings" in outcome))).toBe(true);
  });

  it("treats approval with notes as approving while preserving repository notes", async () => {
    const notesFinding = { id: "note-1", title: "Note", body: "Consider a follow-up", filePath: "src/note.ts" };
    const aggregate = await reviewWorkspace({
      "repo-a": { verdict: "APPROVE_WITH_NOTES", findings: [notesFinding] },
      "repo-b": { verdict: "APPROVE" },
    });

    expect(aggregate.verdict).toBe("APPROVE");
    expect(aggregate.findings).toEqual([expect.objectContaining({ id: "repo-a:note-1", filePath: "repo-a/src/note.ts" })]);
    expect(aggregate.repositoryReviewOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-a", verdict: "APPROVE_WITH_NOTES" }),
      expect.objectContaining({ repository: "repo-b", verdict: "APPROVE" }),
    ]));
    expect(buildWorkspaceReviewOutcome({ ...aggregate, verdict: "APPROVE_WITH_NOTES" as never }).success).toBe(true);
  });

  it("keeps a rejection blocking when another repository approves with notes", async () => {
    const aggregate = await reviewWorkspace({
      "repo-a": { verdict: "APPROVE_WITH_NOTES", findings: [{ id: "note-1", title: "Note", body: "Note" }] },
      "repo-b": { verdict: "REVISE" },
    });

    expect(aggregate.verdict).toBe("REVISE");
    expect(aggregate.repositoryReviewOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-a", verdict: "APPROVE_WITH_NOTES" }),
      expect.objectContaining({ repository: "repo-b", verdict: "REVISE" }),
    ]));
  });

  it("persists approval-family evidence and rejects blocking evidence", async () => {
    const approvedTask = workspaceTask();
    approvedTask.repositoryScope = {
      ...approvedTask.repositoryScope!,
      reviewRemediation: { scopeRevision: 1, repository: "repo-a", inputSignature: "prior" },
    };
    const storeFor = (task: Task) => ({
      getTask: async () => task,
      updateTaskAtomic: async () => {
        throw new Error("workspace review evidence must not use updateTaskAtomic");
      },
      publishWorkspaceCodeReviewEvidence: async (_taskId: string, input: {
        expectedScopeRevision: number;
        reviewEvidence: NonNullable<NonNullable<Task["repositoryScope"]>["reviewEvidence"]>;
        clearReviewRemediation: boolean;
        modifiedFiles?: string[];
      }) => {
        const scope = task.repositoryScope;
        if (!scope) return { task, published: false as const, reason: "scope-absent" as const };
        if (scope.revision !== input.expectedScopeRevision) {
          return { task, published: false as const, reason: "scope-superseded" as const };
        }
        task.repositoryScope = {
          ...scope,
          reviewEvidence: input.reviewEvidence,
          ...(input.clearReviewRemediation && scope.reviewRemediation?.scopeRevision === input.expectedScopeRevision
            ? { reviewRemediation: undefined }
            : {}),
        };
        if (input.modifiedFiles !== undefined) task.modifiedFiles = input.modifiedFiles;
        return { task, published: true as const };
      },
    }) as unknown as TaskStore;

    await persistWorkspaceCodeReviewApproval(storeFor(approvedTask), approvedTask.id, {
      verdict: "APPROVE_WITH_NOTES" as never,
      repositoryScopeRevision: 1,
      repositoryDiffFingerprints: { "repo-a": "fingerprint-a", "repo-b": "fingerprint-b" },
      repositoryModifiedFiles: ["repo-a/src/a.ts", "repo-b/src/b.ts"],
    });

    expect(approvedTask.repositoryScope?.reviewEvidence).toMatchObject({
      "repo-a": { fingerprint: "fingerprint-a", approvedAt: expect.any(String) },
      "repo-b": { fingerprint: "fingerprint-b", approvedAt: expect.any(String) },
    });
    expect(approvedTask.repositoryScope?.reviewRemediation).toBeUndefined();

    const rejectedTask = workspaceTask();
    await persistWorkspaceCodeReviewApproval(storeFor(rejectedTask), rejectedTask.id, {
      verdict: "REVISE",
      repositoryScopeRevision: 1,
      repositoryDiffFingerprints: { "repo-a": "fingerprint-a" },
    });
    expect(rejectedTask.repositoryScope?.reviewEvidence).toBeUndefined();
  });

  it("does not publish evidence for revised or fingerprint-free approval aggregates", async () => {
    const task = workspaceTask();
    const publishWorkspaceCodeReviewEvidence = vi.fn();
    const store = {
      getTask: async () => task,
      publishWorkspaceCodeReviewEvidence,
    } as unknown as TaskStore;

    const revised = await persistWorkspaceCodeReviewApproval(store, task.id, {
      verdict: "REVISE",
      repositoryScopeRevision: 1,
      repositoryDiffFingerprints: { "repo-a": "fingerprint-a" },
    });
    const emptyApproval = await persistWorkspaceCodeReviewApproval(store, task.id, {
      verdict: "APPROVE",
      repositoryScopeRevision: 1,
      repositoryDiffFingerprints: {},
    });

    expect(revised).toMatchObject({ expected: false, published: false, superseded: false });
    expect(emptyApproval).toMatchObject({ expected: false, published: false, emptyApprovalFingerprints: true });
    expect(publishWorkspaceCodeReviewEvidence).not.toHaveBeenCalled();
    expect(task.repositoryScope?.reviewEvidence).toBeUndefined();
  });

  it("carries qualified aggregate findings and narration into the workspace node outcome", () => {
    const findings = [{ id: "repo-a:finding-1", title: "Title", body: "Body", filePath: "repo-a/src/x.ts" }];
    const outcome = buildWorkspaceReviewOutcome({
      verdict: "REVISE",
      review: "review",
      summary: "review",
      findings,
      repositoryReviewOutcomes: [],
      repositoryScopeRevision: 1,
    });
    expect(outcome).toMatchObject({
      success: false,
      verdict: "REVISE",
      output: "review",
      notes: "review",
      findings,
      repositoryScopeRevision: 1,
    });
    expect(outcome).not.toHaveProperty("notesMissing");
  });

  it("keeps superseded aggregate narration as notes", () => {
    const outcome = buildWorkspaceReviewOutcome({
      verdict: "UNAVAILABLE",
      review: "scope changed while review was running",
      summary: "scope changed while review was running",
    }, { superseded: true });
    expect(outcome.notes).toBe("scope changed while review was running");
    expect(outcome).not.toHaveProperty("notesMissing");
  });

  it("keeps structured workspace findings instead of reparsing concatenated review prose", () => {
    const findings = [{ id: "repo-a:finding-1", title: "Title", body: "Body", filePath: "repo-a/src/x.ts" }];
    const output = `${JSON.stringify({ verdict: "REVISE", notes: "prose", findings: [{ id: "unqualified", title: "Wrong", body: "Wrong", filePath: "src/x.ts" }] })}`;
    expect(preserveOutcomeFindingsFromReviewOutput({ success: false, verdict: "REVISE", output, findings }).findings).toEqual(findings);
  });

  it("still parses findings for a single-repository outcome that has none", () => {
    const output = JSON.stringify({ verdict: "REVISE", notes: "prose", findings: [{ id: "finding-1", title: "Title", body: "Body", filePath: "src/x.ts" }] });
    expect(preserveOutcomeFindingsFromReviewOutput({ success: false, verdict: "REVISE", output }).findings).toEqual([
      { id: "finding-1", title: "Title", body: "Body", filePath: "src/x.ts" },
    ]);
  });

  it("keeps superseded workspace outcomes free of actionable findings", () => {
    expect(buildWorkspaceReviewOutcome({
      verdict: "UNAVAILABLE",
      review: "superseded",
      summary: "superseded",
      findings: [{ id: "repo-a:finding-1", title: "Title", body: "Body" }],
    }, { superseded: true })).not.toHaveProperty("findings");
  });

  it("wires workspace review through structured mapping and aggregate outcome helpers", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../executor/run-graph-custom-node.ts", import.meta.url), "utf8");

    expect(source).toContain("return toWorkspaceRepoReviewResult(repoOutcome);");
    expect(source).toContain("outcome = buildWorkspaceReviewOutcome(aggregate, { superseded: reviewSuperseded });");
  });

  it("builds remediation convergence from every blocking repository", () => {
    const result = (overrides: { secondBody?: string; secondFingerprint?: string; secondId?: string; reverse?: boolean } = {}) => {
      const outcomes = [
        {
          repository: "repo-a",
          status: "REVIEWED",
          verdict: "REVISE",
          fingerprint: "fingerprint-a",
          episodeId: "episode",
          reviewedAt: "2026-08-28T11:50:00.000Z",
          findings: [{ id: "repo-a:finding-1", title: "A", body: "Body A", filePath: "repo-a/src/a.ts", line: 3 }],
        },
        {
          repository: "repo-b",
          status: "REVIEWED",
          verdict: "RETHINK",
          fingerprint: overrides.secondFingerprint ?? "fingerprint-b",
          episodeId: "episode",
          reviewedAt: "2026-08-28T11:50:00.000Z",
          findings: [{ id: overrides.secondId ?? "repo-b:finding-1", title: "B", body: overrides.secondBody ?? "Body B", filePath: "repo-b/src/b.ts", line: 8 }],
        },
      ];
      return {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        verdict: "RETHINK",
        repositoryScopeRevision: 4,
        repositoryReviewOutcomes: overrides.reverse ? outcomes.reverse() : outcomes,
      };
    };
    const original = result();
    const remediation = deriveWorkspaceReviewRemediation(original as never);

    expect(remediation?.repository).toBe("repo-a");
    expect(remediation?.inputSignature).not.toBe(deriveWorkspaceReviewRemediation(result({ secondBody: "Changed B" }) as never)?.inputSignature);
    expect(remediation?.inputSignature).not.toBe(deriveWorkspaceReviewRemediation(result({ secondFingerprint: "fingerprint-b2" }) as never)?.inputSignature);
    expect(remediation?.inputSignature).toBe(deriveWorkspaceReviewRemediation(result({ reverse: true }) as never)?.inputSignature);
    expect(remediation?.inputSignature).toBe(deriveWorkspaceReviewRemediation(result({ secondId: "repo-b:model-generated-new-id" }) as never)?.inputSignature);
  });

  it("keeps the durable review and remediation convergence signatures aligned", () => {
    const result = (secondBody = "Body B", reverse = false) => {
      const outcomes = [
        {
          repository: "repo-a",
          status: "REVIEWED",
          verdict: "REVISE",
          fingerprint: "fingerprint-a",
          episodeId: "episode",
          reviewedAt: "2026-08-28T11:50:00.000Z",
          findings: [{ id: "repo-a:finding-1", title: "A", body: "Body A", filePath: "repo-a/src/a.ts", line: 3 }],
        },
        {
          repository: "repo-b",
          status: "REVIEWED",
          verdict: "RETHINK",
          fingerprint: "fingerprint-b",
          episodeId: "episode",
          reviewedAt: "2026-08-28T11:50:00.000Z",
          findings: [{ id: "repo-b:finding-1", title: "B", body: secondBody, filePath: "repo-b/src/b.ts", line: 8 }],
        },
      ];
      return {
        workflowStepId: "code-review",
        verdict: "RETHINK",
        repositoryScopeRevision: 4,
        repositoryReviewOutcomes: reverse ? outcomes.reverse() : outcomes,
      };
    };
    const original = result();

    expect(deriveWorkspaceReviewRemediation(original as never)?.inputSignature).toBe(reviewInputSignature(original as never));
    expect(reviewInputSignature(original as never)).not.toBe(reviewInputSignature(result("Changed B") as never));
    expect(reviewInputSignature(original as never)).toBe(reviewInputSignature(result("Body B", true) as never));
  });

  it("treats workspace review findings with volatile identifiers as the same convergence input", () => {
    const result = (id: string, overrides: { body?: string; fingerprint?: string; verdict?: "REVISE" | "RETHINK"; revision?: number } = {}) => ({
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      verdict: overrides.verdict ?? "REVISE",
      repositoryScopeRevision: overrides.revision ?? 1,
      repositoryReviewOutcomes: [{
        repository: "repo-a",
        status: "REVIEWED",
        verdict: overrides.verdict ?? "REVISE",
        fingerprint: overrides.fingerprint ?? "fingerprint-a",
        episodeId: "episode-a",
        reviewedAt: "2026-08-27T12:00:00.000Z",
        findings: [{ id, title: "Title", body: overrides.body ?? "Body", filePath: "repo-a/src/x.ts", line: 5 }],
      }],
    });
    const original = result("repo-a:finding-1");

    expect(deriveWorkspaceReviewRemediation(original as never)?.inputSignature)
      .toBe(deriveWorkspaceReviewRemediation(result("repo-a:finding-2") as never)?.inputSignature);
    expect(reviewInputSignature(original as never)).toBe(reviewInputSignature(result("repo-a:finding-2") as never));
    expect(reviewInputSignature(original as never)).not.toBe(reviewInputSignature(result("repo-a:finding-1", { body: "Changed" }) as never));
    expect(reviewInputSignature(original as never)).not.toBe(reviewInputSignature(result("repo-a:finding-1", { fingerprint: "fingerprint-b" }) as never));
    expect(reviewInputSignature(original as never)).not.toBe(reviewInputSignature(result("repo-a:finding-1", { verdict: "RETHINK" }) as never));
    expect(reviewInputSignature(original as never)).not.toBe(reviewInputSignature(result("repo-a:finding-1", { revision: 2 }) as never));
  });
});
