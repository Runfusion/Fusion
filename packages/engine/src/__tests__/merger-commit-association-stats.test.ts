import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { recordCommitAssociationFromHead } from "../merger.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fusion-merger-commit-assoc-"));
  git(repo, "git init -b main");
  git(repo, "git config user.email fusion@example.com");
  git(repo, "git config user.name Fusion");
  writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
  git(repo, "git add file.txt");
  git(repo, "git commit -m 'initial commit'");
  writeFileSync(join(repo, "file.txt"), "one\ntwo\nthree\nfour\n");
  git(repo, "git add file.txt");
  git(repo, "git commit -m 'update file'");
  return repo;
}

function makeStore(): Pick<TaskStore, "upsertTaskCommitAssociation"> {
  return {
    upsertTaskCommitAssociation: vi.fn(async (association) => ({
      id: "assoc-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...association,
    })),
  } as Pick<TaskStore, "upsertTaskCommitAssociation">;
}

describeIfGit("recordCommitAssociationFromHead", () => {
  const cleanup: string[] = [];
  let originalPath: string | undefined;

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    while (cleanup.length > 0) {
      rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it("persists HEAD diff stats as additions and deletions", async () => {
    const repo = makeRepo();
    cleanup.push(repo);
    const store = makeStore();

    await recordCommitAssociationFromHead(store as TaskStore, repo, "FN-6704", "lineage-1");

    expect(store.upsertTaskCommitAssociation).toHaveBeenCalledWith(expect.objectContaining({
      taskLineageId: "lineage-1",
      taskIdSnapshot: "FN-6704",
      commitSubject: "update file",
      additions: 2,
      deletions: 0,
    }));
  });

  it("persists the association without stats when shortstat capture fails", async () => {
    const repo = makeRepo();
    const fakeBin = mkdtempSync(join(tmpdir(), "fusion-fake-git-"));
    cleanup.push(repo, fakeBin);
    const realGit = execSync("command -v git", { encoding: "utf-8" }).trim();
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, `#!/bin/sh\nif [ "$1" = "show" ] && [ "$2" = "--shortstat" ]; then\n  echo shortstat failed >&2\n  exit 42\nfi\nexec ${realGit} "$@"\n`);
    chmodSync(fakeGit, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const store = makeStore();

    await recordCommitAssociationFromHead(store as TaskStore, repo, "FN-6704", "lineage-1");

    expect(store.upsertTaskCommitAssociation).toHaveBeenCalledWith(expect.objectContaining({
      taskLineageId: "lineage-1",
      taskIdSnapshot: "FN-6704",
      commitSubject: "update file",
      additions: undefined,
      deletions: undefined,
    }));
  });
});
