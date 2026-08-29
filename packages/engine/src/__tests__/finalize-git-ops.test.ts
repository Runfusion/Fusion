import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultGitOps } from "../experiment/git-ops.js";

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "finalize-git-ops-"));
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "one\n");
  execSync("git add file.txt", { cwd: dir });
  execSync('git commit -m "first"', { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "two\n");
  execSync("git add file.txt", { cwd: dir });
  execSync('git commit -m "second"', { cwd: dir });
  return dir;
}

describe.skipIf(process.platform === "win32")("finalize git ops", () => {
  it("supports mergeBase/branch/checkout/currentBranch/deleteBranch/cherryPick", async () => {
    const cwd = createRepo();
    try {
      const git = defaultGitOps(cwd);
      const head = await git.head();
      const initialBranch = (await git.currentBranch()) ?? "main";
      await git.createBranch("feature/a", head);
      expect(await git.branchExists("feature/a")).toBe(true);

      await git.checkout("feature/a");
      expect(await git.currentBranch()).toBe("feature/a");

      writeFileSync(join(cwd, "file.txt"), "feature\n");
      await git.add(["file.txt"]);
      const featureCommit = await git.commit("feature change");

      await git.checkout(initialBranch);
      writeFileSync(join(cwd, "main.txt"), "main\n");
      await git.add(["main.txt"]);
      await git.commit("main change");

      const mergeBase = await git.mergeBase(initialBranch, "feature/a");
      expect(mergeBase).toBe(head);

      await git.checkout(initialBranch);
      await git.cherryPick(featureCommit);
      expect((await git.statusPorcelain()).trim()).toBe("");

      await git.deleteBranch("feature/a", { force: true });
      expect(await git.branchExists("feature/a")).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
