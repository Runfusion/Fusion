import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { assertSquashOverlapsFileScope, applyLayer3ConflictScopePartition, getConflictedFiles } from "../../merger.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function setupConflictRepo() {
  const rootDir = await mkdtemp(join(tmpdir(), "fn-4956-ri-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');

  await mkdir(join(rootDir, "packages/desktop/src"), { recursive: true });
  await writeFile(join(rootDir, "AGENTS.md"), "line\nshared\n", "utf-8");
  await writeFile(join(rootDir, "packages/desktop/src/foo.ts"), "export const value = 'base';\n", "utf-8");
  git(rootDir, "git add AGENTS.md packages/desktop/src/foo.ts");
  git(rootDir, "git commit -m 'chore: base'");

  git(rootDir, "git checkout -b fusion/fn-4956");
  await writeFile(join(rootDir, "AGENTS.md"), "line\nbranch\n", "utf-8");
  await writeFile(join(rootDir, "packages/desktop/src/foo.ts"), "export const value = 'branch';\n", "utf-8");
  git(rootDir, "git add AGENTS.md packages/desktop/src/foo.ts");
  git(rootDir, "git commit -m 'feat: branch edits'");

  git(rootDir, "git checkout main");
  await writeFile(join(rootDir, "AGENTS.md"), "line\nmain\n", "utf-8");
  await writeFile(join(rootDir, "packages/desktop/src/foo.ts"), "export const value = 'main';\n", "utf-8");
  git(rootDir, "git add AGENTS.md packages/desktop/src/foo.ts");
  git(rootDir, "git commit -m 'feat: main edits'");

  git(rootDir, "git merge --squash fusion/fn-4956 || true");
  return rootDir;
}

describeIfGit("reliability interactions: layer3 ai arbiter file scope", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("skips foreign conflicted files and keeps squash in scope", async () => {
    const rootDir = await setupConflictRepo();
    roots.push(rootDir);

    const auditEvents: Array<{ type: string; metadata: any }> = [];
    const task = { id: "FN-4956", scopeOverride: false } as any;
    const store = {
      parseFileScopeFromPrompt: async () => ["packages/desktop/src/**"],
      appendAgentLog: async () => undefined,
      logEntry: async () => undefined,
    } as any;

    const conflicted = await getConflictedFiles(rootDir);
    expect(conflicted.sort()).toEqual(["AGENTS.md", "packages/desktop/src/foo.ts"].sort());

    const partitioned = await applyLayer3ConflictScopePartition({
      store,
      task,
      taskId: "FN-4956",
      rootDir,
      branch: "fusion/fn-4956",
      conflictFiles: conflicted,
      auditor: {
        git: async (event: any) => {
          auditEvents.push({ type: event.type, metadata: event.metadata });
        },
      } as any,
    });

    expect(partitioned.inScopeConflicts).toEqual(["packages/desktop/src/foo.ts"]);
    expect(partitioned.skippedFiles).toEqual(["AGENTS.md"]);

    const staged = git(rootDir, "git diff --cached --name-only").split("\n").filter(Boolean);
    expect(staged).toContain("packages/desktop/src/foo.ts");
    expect(staged).not.toContain("AGENTS.md");

    await expect(assertSquashOverlapsFileScope({
      store,
      taskId: "FN-4956",
      rootDir,
      task,
    } as any)).resolves.toBeUndefined();

    expect(auditEvents.some((event) => event.type === "merge:layer3:foreign-file-skipped" && event.metadata.skippedFiles.includes("AGENTS.md"))).toBe(true);
  });

  it("emits scope-override bypass and does not skip foreign files", async () => {
    const rootDir = await setupConflictRepo();
    roots.push(rootDir);

    const auditEvents: Array<{ type: string; metadata: any }> = [];
    const task = { id: "FN-4956", scopeOverride: true, scopeOverrideReason: "interaction-test" } as any;
    const store = {
      parseFileScopeFromPrompt: async () => ["packages/desktop/src/**"],
      appendAgentLog: async () => undefined,
      logEntry: async () => undefined,
    } as any;

    const conflicted = await getConflictedFiles(rootDir);
    const partitioned = await applyLayer3ConflictScopePartition({
      store,
      task,
      taskId: "FN-4956",
      rootDir,
      branch: "fusion/fn-4956",
      conflictFiles: conflicted,
      auditor: {
        git: async (event: any) => {
          auditEvents.push({ type: event.type, metadata: event.metadata });
        },
      } as any,
    });

    expect(partitioned.inScopeConflicts.sort()).toEqual(conflicted.sort());
    expect(partitioned.skippedFiles).toEqual([]);
    expect(auditEvents.some((event) => event.type === "merge:layer3:scope-override-bypass")).toBe(true);
    expect(auditEvents.some((event) => event.type === "merge:layer3:foreign-file-skipped")).toBe(false);
  });
});
