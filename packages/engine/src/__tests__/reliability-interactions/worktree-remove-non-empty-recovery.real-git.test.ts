1|import { access, chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
2|import { constants } from "node:fs";
3|import { tmpdir } from "node:os";
4|import { dirname, join } from "node:path";
5|import { afterEach, describe, expect, it } from "vitest";
6|import { NativeWorktreeBackend, RemovalReason, removeWorktree } from "../../worktree/worktree-backend.js";
7|import { git, hasGit } from "./_helpers.js";
8|
9|async function pathExists(path: string): Promise<boolean> {
10|  try {
11|    await access(path, constants.F_OK);
12|    return true;
13|  } catch {
14|    return false;
15|  }
16|}
17|
18|describe.skipIf(!hasGit)("reliability interactions: worktree remove non-empty recovery", () => {
19|  const roots: string[] = [];
20|  let originalPath: string | undefined;
21|  let originalFailPath: string | undefined;
22|
23|  afterEach(async () => {
24|    if (originalPath === undefined) {
25|      delete process.env.PATH;
26|    } else {
27|      process.env.PATH = originalPath;
28|    }
29|    if (originalFailPath === undefined) {
30|      delete process.env.FUSION_FAIL_GIT_WORKTREE_REMOVE_PATH;
31|    } else {
32|      process.env.FUSION_FAIL_GIT_WORKTREE_REMOVE_PATH = originalFailPath;
33|    }
34|    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
35|    roots.length = 0;
36|  });
37|
38|  async function setupRepo(prefix = "fusion-remove-non-empty-") {
39|    const root = await mkdtemp(join(tmpdir(), prefix));
40|    roots.push(root);
41|    git(root, "git init -b main");
42|    git(root, 'git config user.email "test@example.com"');
43|    git(root, 'git config user.name "Test User"');
44|    await writeFile(join(root, "README.md"), "# repo\n", "utf-8");
45|    git(root, "git add README.md");
46|    git(root, 'git commit -m "init"');
47|    return root;
48|  }
49|
50|  async function createWorktree(root: string, name: string, branch: string): Promise<string> {
51|    const worktreePath = join(root, ".worktrees", name);
52|    git(root, `git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(worktreePath)}`);
53|    return worktreePath;
54|  }
55|
56|  async function installGitRemoveFailureShim(
57|    targetPath: string,
58|    stderr = "error: failed to delete '$4': Directory not empty",
59|  ): Promise<void> {
60|    const realGit = git(process.cwd(), "command -v git");
61|    const shimDir = await mkdtemp(join(tmpdir(), "fusion-fake-git-"));
62|    roots.push(shimDir);
63|    const shimPath = join(shimDir, "git");
64|    await writeFile(
65|      shimPath,
66|      `#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "remove" ] && [ "$3" = "--force" ] && [ "$4" = "$FUSION_FAIL_GIT_WORKTREE_REMOVE_PATH" ]; then\n  echo ${JSON.stringify(stderr)} >&2\n  exit 1\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
67|      "utf-8",
68|    );
69|    await chmod(shimPath, 0o755);
70|    originalPath = process.env.PATH;
71|    originalFailPath = process.env.FUSION_FAIL_GIT_WORKTREE_REMOVE_PATH;
72|    process.env.PATH = `${shimDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
73|    process.env.FUSION_FAIL_GIT_WORKTREE_REMOVE_PATH = targetPath;
74|  }
75|
76|  async function expectWorktreeRemoved(root: string, worktreePath: string): Promise<void> {
77|    expect(await pathExists(worktreePath)).toBe(false);
78|    const porcelain = git(root, "git worktree list --porcelain");
79|    expect(porcelain).not.toContain(`worktree ${worktreePath}`);
80|    expect(porcelain).not.toContain(`worktree ${await realpath(dirname(worktreePath)).catch(() => dirname(worktreePath))}/${worktreePath.split("/").pop()}`);
81|  }
82|
83|  it("removes and prunes a worktree with untracked-only content when git remove reports Directory not empty", async () => {
84|    const root = await setupRepo();
85|    const worktreePath = await createWorktree(root, "fn-untracked", "fusion/fn-untracked");
86|    const resolvedWorktreePath = await realpath(worktreePath);
87|    await mkdir(join(worktreePath, "dist"), { recursive: true });
88|    await writeFile(join(worktreePath, "dist", "artifact.txt"), "artifact\n", "utf-8");
89|    await installGitRemoveFailureShim(worktreePath);
90|    const events: string[] = [];
91|
92|    await removeWorktree({
93|      rootDir: root,
94|      worktreePath,
95|      settings: {},
96|      reason: RemovalReason.ExecutorDispose,
97|      force: true,
98|      audit: { git: async (event) => void events.push(event.type) },
99|    });
100|
101|    await expectWorktreeRemoved(root, resolvedWorktreePath);
102|    expect(events).toContain("worktree:remove-fallback");
103|    expect(events).toContain("worktree:admin-entry-pruned");
104|    expect(events).toContain("worktree:remove");
105|  });
106|
107|  it("preserves ignored content during an idle-sweep removal", async () => {
108|    const root = await setupRepo();
109|    await writeFile(join(root, ".gitignore"), ".env\n", "utf-8");
110|    git(root, "git add .gitignore");
111|    git(root, 'git commit -m "ignore env"');
112|    const worktreePath = await createWorktree(root, "fn-ignored", "fusion/fn-ignored");
113|    await writeFile(join(worktreePath, ".env"), "RECOVERABLE=1\n", "utf-8");
114|
115|    await expect(removeWorktree({
116|      rootDir: root,
117|      worktreePath,
118|      settings: {},
119|      reason: RemovalReason.SelfHealingIdleSweep,
120|    })).rejects.toThrow(/dirty worktree/);
121|
122|    expect(await pathExists(join(worktreePath, ".env"))).toBe(true);
123|  });
124|
125|  it("prunes a missing worktree registration during defensive cleanup", async () => {
126|    const root = await setupRepo();
127|    const worktreePath = await createWorktree(root, "fn-missing-pool", "fusion/fn-missing-pool");
128|    const resolvedWorktreePath = await realpath(worktreePath);
129|    await rm(worktreePath, { recursive: true, force: true });
130|
131|    await removeWorktree({
132|      rootDir: root,
133|      worktreePath,
134|      settings: {},
135|      reason: RemovalReason.PoolPrune,
136|    });
137|
138|    await expectWorktreeRemoved(root, resolvedWorktreePath);
139|  });
140|
141|  it("removes and prunes a worktree with nested-git content when native removal falls back", async () => {
142|    const root = await setupRepo();
143|    const worktreePath = await createWorktree(root, "fn-nested", "fusion/fn-nested");
144|    const resolvedWorktreePath = await realpath(worktreePath);
145|    const nestedRepo = join(worktreePath, "node_modules", "inner-repo");
146|    await mkdir(nestedRepo, { recursive: true });
147|    git(nestedRepo, "git init -b main");
148|    await writeFile(join(nestedRepo, "package.json"), "{}\n", "utf-8");
149|    await installGitRemoveFailureShim(worktreePath);
150|
151|    await new NativeWorktreeBackend().remove({ rootDir: root, worktreePath });
152|
153|    await expectWorktreeRemoved(root, resolvedWorktreePath);
154|  });
155|
156|  it("preserves native already-missing validation-failed behavior", async () => {
157|    const root = await setupRepo();
158|    const worktreePath = await createWorktree(root, "fn-missing", "fusion/fn-missing");
159|    await rm(worktreePath, { recursive: true, force: true });
160|    await installGitRemoveFailureShim(worktreePath, "fatal: validation failed, cannot remove working tree");
161|
162|    await expect(new NativeWorktreeBackend().remove({ rootDir: root, worktreePath })).rejects.toThrow(/validation failed/i);
163|  });
164|
165|  it("still rethrows non-recoverable native removal failures", async () => {
166|    const root = await setupRepo();
167|    const notAWorktreePath = join(root, "not-a-worktree");
168|    await mkdir(notAWorktreePath);
169|
170|    await expect(new NativeWorktreeBackend().remove({ rootDir: root, worktreePath: notAWorktreePath })).rejects.toThrow();
171|    expect(await pathExists(notAWorktreePath)).toBe(true);
172|  });
173|});
174|