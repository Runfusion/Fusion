1|import { createHash } from "node:crypto";
2|import { execFileSync } from "node:child_process";
3|import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
4|import { rm } from "node:fs/promises";
5|import { join, resolve } from "node:path";
6|import { tmpdir } from "node:os";
7|import { afterEach, describe, expect, it, vi } from "vitest";
8|import { writeSecretsEnvFile } from "../../worktree/secrets-env-writer.js";
9|import { refreshReusedWorktreeBase } from "../../worktree-base-refresh.js";
10|import { reapOrphanWorktrees } from "../../worktree/worktree-pool.js";
11|import { acquireTaskWorktree } from "../../worktree/worktree-acquisition.js";
12|
13|const dirs: string[] = [];
14|function tmpRepo(): string {
15|  const root = mkdtempSync(join(tmpdir(), "secrets-rel-"));
16|  dirs.push(root);
17|  execFileSync("git", ["init"], { cwd: root });
18|  return root;
19|}
20|
21|afterEach(async () => {
22|  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
23|});
24|
25|describe("reliability interactions: secrets env materialization", () => {
26|  it("writer refuses non-ignored env path", async () => {
27|    const root = tmpRepo();
28|    const worktree = join(root, ".worktrees", "a");
29|    mkdirSync(worktree, { recursive: true });
30|    execFileSync("git", ["init"], { cwd: worktree });
31|
32|    const audit = { filesystem: vi.fn() };
33|    const result = await writeSecretsEnvFile({
34|      rootDir: root,
35|      worktreePath: worktree,
36|      taskId: "FN-1",
37|      settings: { secretsEnv: { enabled: true, filename: ".env", requireGitignored: true } },
38|      worktreeSource: "fresh",
39|      audit,
40|      secretsStore: { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any,
41|    });
42|
43|    expect(result.reason).toBe("not-gitignored");
44|    expect(audit.filesystem).toHaveBeenCalledWith(expect.objectContaining({ type: "secret:env-write-skipped" }));
45|  });
46|
47|  it("adopts a planning-era legacy sidecar before linked-worktree refresh while real dirt still blocks", async () => {
48|    const root = tmpRepo();
49|    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
50|    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
51|    writeFileSync(join(root, ".gitignore"), ".secrets.env\n");
52|    writeFileSync(join(root, "README.md"), "base\n");
53|    execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: root });
54|    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
55|    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
56|    const worktree = join(root, "linked");
57|    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-1", worktree, base], { cwd: root });
58|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
59|    await writeSecretsEnvFile({ rootDir: root, worktreePath: worktree, taskId: "FN-1", settings: { secretsEnv: { enabled: true, filename: ".secrets.env" } }, worktreeSource: "fresh", secretsStore });
60|    const gitDirOutput = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: worktree, encoding: "utf8" }).trim();
61|    const privateRecord = join(resolve(worktree, gitDirOutput), ".fusion-secrets-env.fingerprint");
62|    const legacyBytes = `${createHash("sha256").update(readFileSync(join(worktree, ".secrets.env"), "utf8")).digest("hex")}\n.secrets.env\n`;
63|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: This is the byte-for-byte v0.75.1 root wire format left by planning before execution reuses its linked worktree.
64|    writeFileSync(join(worktree, ".fusion-secrets-env.fingerprint"), legacyBytes);
65|    rmSync(privateRecord);
66|
67|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:51: Exercise the production resume seam, not the reconciler in isolation: planning's v0.75.1 root record must be adopted before executor-style refresh evaluates porcelain.
68|    const store = { updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) } as any;
69|    await expect(acquireTaskWorktree({
70|      task: { id: "FN-1", title: "secrets handoff", description: "", branch: "fusion/fn-1", worktree, baseCommitSha: base } as any,
71|      rootDir: root,
72|      store,
73|      settings: { secretsEnv: { enabled: true, filename: ".secrets.env" } } as any,
74|      refreshStaleBase: true,
75|      createWorktree: vi.fn(),
76|      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
77|    })).resolves.toMatchObject({ source: "existing", isResume: true, baseRefresh: { executionSafe: true } });
78|    expect(existsSync(join(worktree, ".fusion-secrets-env.fingerprint"))).toBe(false);
79|    expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" })).toBe("");
80|
81|    /*
82|    FNXC:SecretsEnvMaterialization 2026-08-09-23:49:
83|    Sidecar adoption must not launder REAL dirt into a clean verdict — the refresh still has to SEE it. Advance
84|    main first so a git mutation is genuinely required, which is the only situation where the working tree is
85|    consulted at all. Per FNXC:WorktreeBaseRefresh 2026-08-09-23:49 the dirt now declines the refresh instead of
86|    refusing execution, and the assertion that matters is that the agent's uncommitted work survives untouched.
87|    */
88|    writeFileSync(join(root, "advance.txt"), "C1\n");
89|    execFileSync("git", ["add", "advance.txt"], { cwd: root });
90|    execFileSync("git", ["commit", "-m", "C1"], { cwd: root });
91|
92|    writeFileSync(join(worktree, "unrelated.txt"), "dirt\n");
93|    await expect(refreshReusedWorktreeBase({ task: { id: "FN-1", baseCommitSha: base } as any, rootDir: root, worktreePath: worktree, store, settings: {} })).resolves.toMatchObject({ kind: "dirty-worktree", executionSafe: true, skipped: true });
94|    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim()).toBe(base);
95|    expect(readFileSync(join(worktree, "unrelated.txt"), "utf8")).toBe("dirt\n");
96|  });
97|
98|  it("orphan reap reclaims orphaned env artifacts", async () => {
99|    const root = tmpRepo();
100|    const worktreesDir = join(root, ".worktrees");
101|    const orphan = join(worktreesDir, "ghost");
102|    mkdirSync(orphan, { recursive: true });
103|    const body = "A=1\n";
104|    writeFileSync(join(orphan, ".env"), body);
105|    writeFileSync(join(orphan, ".fusion-secrets-env.fingerprint"), `${createHash("sha256").update(body).digest("hex")}\n.env\n`);
106|
107|    const removed = await reapOrphanWorktrees(root);
108|    expect(removed).toBe(1);
109|    expect(existsSync(orphan)).toBe(false);
110|  });
111|});
112|