import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../../types.js";
import { evaluatePreMergeApprovals } from "../../merge/pre-merge-approval.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("workspace Code Review evidence publication (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workspace_review_evidence",
    projectId: "fn-259-workspace-review-evidence",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("publishes fenced repository evidence atomically and opens the matching workspace approval gate", async () => {
    const store = h.store();
    await mkdir(join(h.rootDir(), ".fusion"), { recursive: true });
    await writeFile(join(h.rootDir(), ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    const task = await store.createTask({ description: "publish workspace Code Review evidence" });
    const scopeRevision = task.repositoryScope!.revision!;
    const writeTaskJsonFile = vi.spyOn(store, "writeTaskJsonFile");
    const emitTaskLifecycleEventSafely = vi.spyOn(store, "emitTaskLifecycleEventSafely");
    const evidence = {
      "repo-a": { fingerprint: "fingerprint-a", approvedAt: "2026-08-29T00:00:00.000Z" },
      "repo-b": { fingerprint: "fingerprint-b", approvedAt: "2026-08-29T00:00:00.000Z" },
    };
    const modifiedFiles = ["repo-a/src/a.ts", "repo-b/src/b.ts"];

    const published = await store.publishWorkspaceCodeReviewEvidence(task.id, {
      expectedScopeRevision: scopeRevision,
      reviewEvidence: evidence,
      clearReviewRemediation: false,
      modifiedFiles,
    });

    expect(published).toMatchObject({ published: true });
    const reread = await store.getTask(task.id);
    expect(reread.repositoryScope?.reviewEvidence).toEqual(evidence);
    expect(reread.modifiedFiles).toEqual(modifiedFiles);
    expect(writeTaskJsonFile).toHaveBeenCalledWith(store.taskDir(task.id), expect.objectContaining({ id: task.id }));
    expect(emitTaskLifecycleEventSafely).toHaveBeenCalledWith("task:updated", [expect.objectContaining({ id: task.id })]);
    const projected = JSON.parse(await readFile(join(store.taskDir(task.id), "task.json"), "utf8")) as Task;
    expect(projected.repositoryScope?.reviewEvidence).toEqual(evidence);
    expect(projected.modifiedFiles).toEqual(modifiedFiles);

    const approval = evaluatePreMergeApprovals({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        reviewKind: "code",
        status: "passed",
        verdict: "APPROVE",
        repositoryScopeRevision: scopeRevision,
      }],
      repositoryScope: reread.repositoryScope,
    }, {
      requiredPreMergeStepIds: new Set(["code-review"]),
      mergeContent: {
        kind: "workspace",
        repositories: {
          state: "captured",
          fingerprints: { "repo-a": "fingerprint-a", "repo-b": "fingerprint-b" },
          inScopeModified: ["repo-a", "repo-b"],
        },
      },
    });
    expect(approval).toEqual([{ workflowStepId: "code-review", state: "approved" }]);

    const missing = evaluatePreMergeApprovals({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        reviewKind: "code",
        status: "passed",
        verdict: "APPROVE",
        repositoryScopeRevision: scopeRevision,
      }],
      repositoryScope: {
        ...reread.repositoryScope!,
        reviewEvidence: { "repo-a": evidence["repo-a"] },
      },
    }, {
      requiredPreMergeStepIds: new Set(["code-review"]),
      mergeContent: {
        kind: "workspace",
        repositories: {
          state: "captured",
          fingerprints: { "repo-a": "fingerprint-a", "repo-b": "fingerprint-b" },
          inScopeModified: ["repo-a", "repo-b"],
        },
      },
    });
    expect(missing).toEqual([{ workflowStepId: "code-review", state: "missing", repositories: ["repo-b"] }]);

    const superseded = await store.publishWorkspaceCodeReviewEvidence(task.id, {
      expectedScopeRevision: scopeRevision + 1,
      reviewEvidence: { "repo-a": { fingerprint: "changed", approvedAt: "2026-08-29T00:01:00.000Z" } },
      clearReviewRemediation: true,
      modifiedFiles: ["repo-a/src/changed.ts"],
    });
    expect(superseded).toMatchObject({ published: false, reason: "scope-superseded" });
    expect((await store.getTask(task.id)).repositoryScope?.reviewEvidence).toEqual(evidence);
    expect((await store.getTask(task.id)).modifiedFiles).toEqual(modifiedFiles);

    await store.updateTask(task.id, {
      repositoryScope: { repositories: ["not-persisted"], state: "confirmed", revision: 99 },
    } as never);
    expect((await store.getTask(task.id)).repositoryScope?.repositories).toEqual(["repo-a", "repo-b"]);
  });

  it("preserves unrelated remediation state and lets membership changes clear stale evidence", async () => {
    const store = h.store();
    await mkdir(join(h.rootDir(), ".fusion"), { recursive: true });
    const workspaceConfigPath = join(h.rootDir(), ".fusion", "workspace.json");
    await writeFile(workspaceConfigPath, JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    const task = await store.createTask({ description: "preserve workspace review remediation" });
    const revision = task.repositoryScope!.revision!;
    const remediation = { scopeRevision: revision, repository: "repo-a", inputSignature: "review-input" };
    await store.updateWorkspaceReviewState(task.id, revision, remediation);

    const published = await store.publishWorkspaceCodeReviewEvidence(task.id, {
      expectedScopeRevision: revision,
      reviewEvidence: { "repo-a": { fingerprint: "fingerprint-a", approvedAt: "2026-08-29T00:00:00.000Z" } },
      clearReviewRemediation: false,
      modifiedFiles: ["repo-a/src/a.ts"],
    });
    expect(published).toMatchObject({ published: true });
    expect((await store.getTask(task.id)).repositoryScope?.reviewRemediation).toEqual(remediation);

    await writeFile(workspaceConfigPath, JSON.stringify({ repos: ["repo-a", "repo-b", "repo-c"] }));
    const resynced = await store.updateTaskRepositoryScope(task.id, (await store.getTask(task.id)).repositoryScope);
    expect(resynced.repositoryScope).toMatchObject({ repositories: ["repo-a", "repo-b", "repo-c"] });
    expect(resynced.repositoryScope?.reviewEvidence).toBeUndefined();
    expect(resynced.repositoryScope?.reviewRemediation).toBeUndefined();
  });
});

void describe;
