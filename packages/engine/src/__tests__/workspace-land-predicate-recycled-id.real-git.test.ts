import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProvenLandedCommit, isRepoLanded } from "../merge/workspace-land-predicate.js";
import { hasGit } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string, env?: NodeJS.ProcessEnv): string {
  return execSync(command, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

/** Commit a real exact trailer line; explicit dates model recycled ids without relying on wall time. */
function commit(repo: string, name: string, taskId: string, date?: string, body = false): string {
  writeFileSync(join(repo, name), `${name}\n`);
  git(repo, `git add ${name}`);
  const message = body ? `note\n\nmentions Fusion-Task-Id: ${taskId}` : `land\n\nFusion-Task-Id: ${taskId}`;
  git(repo, `git commit -m "${message.split("\n")[0]}" ${body ? `-m "mentions Fusion-Task-Id: ${taskId}"` : `-m "Fusion-Task-Id: ${taskId}"`}`, date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : undefined);
  return git(repo, "git rev-parse HEAD");
}

describeIfGit("workspace land predicate recycled task id (real git)", () => {
  let repo = "";
  afterEach(() => repo && rmSync(repo, { recursive: true, force: true }));

  it("rejects ancient branch-gone trailers while preserving recent, skew, legacy-window, and primary proofs", async () => {
    repo = mkdtempSync(join(tmpdir(), "fn-9057-land-predicate-"));
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    const now = new Date();
    const createdAt = now.toISOString();
    const ancient = commit(repo, "ancient", "FN-2002", "2024-01-01T00:00:00Z");
    expect(await findProvenLandedCommit(repo, "main", undefined, "FN-2002", "fusion/fn-2002", undefined, createdAt)).toBeUndefined();
    expect(await isRepoLanded(repo, "main", undefined, "FN-2002", "fusion/fn-2002", undefined, createdAt)).toBe(false);

    const recent = commit(repo, "recent", "FN-2002");
    expect(await findProvenLandedCommit(repo, "main", undefined, "FN-2002", "fusion/fn-2002", undefined, createdAt)).toBe(recent);
    expect(await findProvenLandedCommit(repo, "main", undefined, "FN-2002")).toBe(recent);
    expect(await findProvenLandedCommit(repo, "main", recent, "FN-2002", "fusion/fn-2002", undefined, "2999dead")).toBe(recent);
    expect(ancient).not.toBe(recent);
  });

  it("leaves merge-base ranges and trailer-line precision unchanged", async () => {
    repo = mkdtempSync(join(tmpdir(), "fn-9057-land-predicate-"));
    git(repo, "git init -b main"); git(repo, 'git config user.email "test@example.com"'); git(repo, 'git config user.name "Test"');
    commit(repo, "base", "OTHER");
    git(repo, "git branch fusion/fn-2002");
    const oldAfterBase = commit(repo, "old-after-base", "FN-2002", "2024-01-01T00:00:00Z");
    expect(await findProvenLandedCommit(repo, "main", undefined, "FN-2002", "fusion/fn-2002", undefined, new Date().toISOString())).toBe(oldAfterBase);
    const mention = commit(repo, "mention", "FN-9999", undefined, true);
    expect(await findProvenLandedCommit(repo, "main", undefined, "FN-2002", "fusion/fn-2002")).toBe(oldAfterBase);
    expect(mention).not.toBe(oldAfterBase);
    expect(await findProvenLandedCommit(repo, "missing", undefined, "FN-2002")).toBeUndefined();
  });
});
