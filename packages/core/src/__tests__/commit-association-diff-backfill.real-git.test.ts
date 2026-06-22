import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";

function git(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function insertAssociation(
  store: TaskStore,
  input: {
    id: string;
    lineageId: string;
    sha: string;
    matchedBy?: string;
    additions?: number | null;
    deletions?: number | null;
  },
): void {
  const authoredAt = "2026-06-19T00:00:00.000Z";
  (store as any).db.prepare(
    `INSERT INTO task_commit_associations
       (id, taskLineageId, taskIdSnapshot, commitSha, commitSubject, authoredAt,
        matchedBy, confidence, additions, deletions, createdAt, updatedAt)
     VALUES (?, ?, 'FN-6714', ?, 'subject', ?, ?, 'canonical', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.lineageId,
    input.sha,
    authoredAt,
    input.matchedBy ?? "canonical-lineage-trailer",
    input.additions ?? null,
    input.deletions ?? null,
    authoredAt,
    authoredAt,
  );
}

function readStats(store: TaskStore, id: string): { additions: number | null; deletions: number | null; updatedAt: string } {
  return (store as any).db.prepare(
    `SELECT additions, deletions, updatedAt FROM task_commit_associations WHERE id = ?`,
  ).get(id) as { additions: number | null; deletions: number | null; updatedAt: string };
}

/**
 * FNXC:CommandCenterProductivity 2026-06-21-00:00:
 * Historical task commit associations may predate LOC columns, so the backfill contract must be proven against real git shortstat output while preserving populated rows and treating invalid or unavailable SHAs as non-fatal.
 */
describe("TaskStore.backfillCommitAssociationDiffStats", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-commit-diff-backfill-repo-"));
    globalDir = mkdtempSync(join(tmpdir(), "fn-commit-diff-backfill-global-"));
    git("git init --initial-branch=main", rootDir);
    git('git config user.name "Fusion Test"', rootDir);
    git('git config user.email "test@example.com"', rootDir);

    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("fills only NULL historical rows from local git and leaves unknown objects NULL", async () => {
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "src", "added.txt"), "one\n");
    git("git add src/added.txt", rootDir);
    git('git commit -m "add one line"', rootDir);
    const addOnlySha = git("git rev-parse HEAD", rootDir);

    writeFileSync(join(rootDir, "src", "changed.txt"), "one\ntwo\nthree\n");
    git("git add src/changed.txt", rootDir);
    git('git commit -m "add three lines"', rootDir);

    writeFileSync(join(rootDir, "src", "changed.txt"), "one\n");
    git("git add src/changed.txt", rootDir);
    git('git commit -m "delete two lines"', rootDir);
    const deletionSha = git("git rev-parse HEAD", rootDir);

    const unavailableSha = "abcdef1";
    const maliciousSha = "bad;touch should-not-exist";
    insertAssociation(store, { id: "null-add-1", lineageId: "lin-a", sha: addOnlySha });
    insertAssociation(store, { id: "null-add-2", lineageId: "lin-b", sha: addOnlySha, matchedBy: "legacy-subject" });
    insertAssociation(store, { id: "null-delete", lineageId: "lin-c", sha: deletionSha });
    insertAssociation(store, { id: "unavailable", lineageId: "lin-d", sha: unavailableSha });
    insertAssociation(store, { id: "malformed", lineageId: "lin-e", sha: maliciousSha });
    insertAssociation(store, { id: "already-populated", lineageId: "lin-f", sha: addOnlySha, additions: 99, deletions: 88 });
    const populatedBefore = readStats(store, "already-populated");

    const dryRun = await store.backfillCommitAssociationDiffStats({ dryRun: true });
    expect(dryRun).toEqual({
      scannedRows: 5,
      distinctCommits: 4,
      updatedRows: 3,
      skippedUnavailableCommits: 1,
      skippedInvalidShas: 1,
      dryRun: true,
    });
    expect(readStats(store, "null-add-1")).toMatchObject({ additions: null, deletions: null });
    expect(readStats(store, "unavailable")).toMatchObject({ additions: null, deletions: null });

    const report = await store.backfillCommitAssociationDiffStats({ dryRun: false });
    expect(report).toEqual({
      scannedRows: 5,
      distinctCommits: 4,
      updatedRows: 3,
      skippedUnavailableCommits: 1,
      skippedInvalidShas: 1,
      dryRun: false,
    });

    expect(readStats(store, "null-add-1")).toMatchObject({ additions: 1, deletions: 0 });
    expect(readStats(store, "null-add-2")).toMatchObject({ additions: 1, deletions: 0 });
    expect(readStats(store, "null-delete")).toMatchObject({ additions: 0, deletions: 2 });
    expect(readStats(store, "unavailable")).toMatchObject({ additions: null, deletions: null });
    expect(readStats(store, "malformed")).toMatchObject({ additions: null, deletions: null });
    expect(readStats(store, "already-populated")).toEqual(populatedBefore);

    const secondRun = await store.backfillCommitAssociationDiffStats({ dryRun: false });
    expect(secondRun).toEqual({
      scannedRows: 2,
      distinctCommits: 2,
      updatedRows: 0,
      skippedUnavailableCommits: 1,
      skippedInvalidShas: 1,
      dryRun: false,
    });
  });
});
