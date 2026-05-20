import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyForeignOnlyContamination } from "../branch-conflicts.js";

const execAsync = promisify(exec);

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

describe("classifyForeignOnlyContamination", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4887-"));
    dirs.push(repoDir);

    await run("git init -b main", repoDir);
    await run("git config user.email test@example.com", repoDir);
    await run("git config user.name 'Test User'", repoDir);

    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await run("git add note.txt && git commit -m 'chore: base'", repoDir);
    const baseSha = await run("git rev-parse HEAD", repoDir);

    await run("git checkout -b feature", repoDir);
    return { repoDir, baseSha };
  }

  async function makeCommit(repoDir: string, line: string, subject: string, trailerTaskId?: string) {
    await appendFile(path.join(repoDir, "note.txt"), `${line}\n`, "utf-8");
    await run("git add note.txt", repoDir);
    if (trailerTaskId) {
      await run(`git commit -m ${JSON.stringify(subject)} -m ${JSON.stringify(`Fusion-Task-Id: ${trailerTaskId}`)}`, repoDir);
    } else {
      await run(`git commit -m ${JSON.stringify(subject)}`, repoDir);
    }
    return run("git rev-parse HEAD", repoDir);
  }

  it("returns foreign-only-no-own-work when only foreign-attributed commits exist", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const foreignSha = await makeCommit(repoDir, "foreign-a", "feat(FN-4001): foreign", "FN-4001");

    const result = await classifyForeignOnlyContamination({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4887",
      mainRef: "main",
    });

    expect(result.kind).toBe("foreign-only-no-own-work");
    expect(result.ownCommitCount).toBe(0);
    expect(result.nonAttributedCount).toBe(0);
    expect(result.foreignCommitCount).toBe(1);
    expect(result.uniqueShas).toEqual([foreignSha]);
  });

  it("classifies foreign commits already on main without treating them as unique branch work", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const foreignSha = await makeCommit(repoDir, "foreign-b", "feat(FN-4002): foreign upstream", "FN-4002");
    await run("git checkout main", repoDir);
    await run(`git cherry-pick ${foreignSha}`, repoDir);
    await run("git checkout feature", repoDir);

    const result = await classifyForeignOnlyContamination({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4887",
      mainRef: "main",
    });

    expect(["clean", "foreign-only-already-upstream"]).toContain(result.kind);
    expect(result.uniqueShas).toEqual([]);
    if (result.kind === "clean") {
      expect(result.foreignCommitCount).toBe(0);
      expect(result.alreadyUpstreamShas).toEqual([]);
    } else {
      expect(result.foreignCommitCount).toBe(1);
      expect(result.alreadyUpstreamShas).toEqual([foreignSha]);
    }
  });

  it("returns ambiguous when own and foreign commits are mixed", async () => {
    const { repoDir, baseSha } = await setupRepo();
    await makeCommit(repoDir, "foreign-c", "feat(FN-4003): foreign", "FN-4003");
    await makeCommit(repoDir, "own", "feat(FN-4887): own", "FN-4887");

    const result = await classifyForeignOnlyContamination({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4887",
      mainRef: "main",
    });

    expect(result.kind).toBe("ambiguous");
    expect(result.ownCommitCount).toBe(1);
    expect(result.foreignCommitCount).toBe(1);
  });

  it("returns ambiguous when non-attributed commits exist", async () => {
    const { repoDir, baseSha } = await setupRepo();
    await makeCommit(repoDir, "foreign-d", "feat(FN-4004): foreign", "FN-4004");
    await makeCommit(repoDir, "plain", "refactor: plain unattributed");

    const result = await classifyForeignOnlyContamination({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4887",
      mainRef: "main",
    });

    expect(result.kind).toBe("ambiguous");
    expect(result.nonAttributedCount).toBe(1);
  });

  it("returns clean when branch has no foreign commits", async () => {
    const { repoDir, baseSha } = await setupRepo();
    await makeCommit(repoDir, "own-clean", "feat(FN-4887): own", "FN-4887");

    const result = await classifyForeignOnlyContamination({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4887",
      mainRef: "main",
    });

    expect(result.kind).toBe("clean");
    expect(result.foreignCommitCount).toBe(0);
  });
});
