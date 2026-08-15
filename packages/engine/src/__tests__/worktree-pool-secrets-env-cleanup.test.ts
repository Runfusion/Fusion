1|import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
2|import { rm } from "node:fs/promises";
3|import { join } from "node:path";
4|import { tmpdir } from "node:os";
5|import { afterEach, describe, expect, it, vi } from "vitest";
6|
7|const cleanupSecretsEnvFile = vi.fn();
8|
9|vi.mock("../worktree/secrets-env-writer.js", () => ({
10|  cleanupSecretsEnvFile,
11|}));
12|
13|const dirs: string[] = [];
14|function tmpRoot(): string {
15|  const root = mkdtempSync(join(tmpdir(), "pool-cleanup-"));
16|  dirs.push(root);
17|  return root;
18|}
19|
20|afterEach(async () => {
21|  cleanupSecretsEnvFile.mockReset().mockResolvedValue({ outcome: "cleaned", reason: "fingerprint-match" });
22|  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
23|});
24|
25|describe("worktree-pool secrets cleanup hooks", () => {
26|  it("reapOrphanWorktrees invokes cleanup before removal", async () => {
27|    cleanupSecretsEnvFile.mockImplementationOnce(async ({ worktreePath }) => {
28|      rmSync(join(worktreePath, ".env"));
29|      return { outcome: "cleaned", reason: "fingerprint-match" };
30|    });
31|    const root = tmpRoot();
32|    const worktrees = join(root, ".worktrees");
33|    const orphan = join(worktrees, "orphan-1");
34|    mkdirSync(orphan, { recursive: true });
35|    writeFileSync(join(orphan, ".env"), "A=1\n");
36|
37|    const mod = await import("../worktree/worktree-pool.js");
38|    const removed = await mod.reapOrphanWorktrees(root);
39|
40|    expect(removed).toBe(1);
41|    expect(cleanupSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({
42|      worktreePath: orphan,
43|      taskId: "orphan:orphan-1",
44|    }));
45|    expect(existsSync(orphan)).toBe(false);
46|  });
47|
48|  it("cleanup failures do not block orphan removal", async () => {
49|    cleanupSecretsEnvFile.mockRejectedValueOnce(new Error("cleanup failed"));
50|    const root = tmpRoot();
51|    const orphan = join(root, ".worktrees", "orphan-2");
52|    mkdirSync(orphan, { recursive: true });
53|
54|    const mod = await import("../worktree/worktree-pool.js");
55|    const removed = await mod.reapOrphanWorktrees(root);
56|
57|    expect(removed).toBe(1);
58|    expect(existsSync(orphan)).toBe(false);
59|  });
60|});
61|