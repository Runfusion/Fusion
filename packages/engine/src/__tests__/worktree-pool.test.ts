1|import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
2|import type { ExecException } from "node:child_process";
3|
4|// Route async `exec` (via promisify) through the `execSync` mock so existing
5|// test setups that configure `mockedExecSync.mockImplementation` keep working.
6|vi.mock("node:child_process", async () => {
7|  const { promisify } = await import("node:util");
8|  const execSyncFn = vi.fn();
9|   
10|  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
11|    const callback = typeof opts === "function" ? opts : cb;
12|    const options = typeof opts === "function" ? {} : (opts ?? {});
13|    try {
14|      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
15|      const stdout = out === undefined || (Buffer.isBuffer(out) && out.length === 0)
16|        ? (cmd.includes("rev-parse --show-toplevel") ? (cmd.match(/-C (\S+)/)?.[1] ?? "") + "\n" : "")
17|        : out.toString();
18|      if (typeof callback === "function") callback(null, stdout, "");
19|    } catch (err) {
20|      if (typeof callback === "function") {
21|        const error = err as ExecException & { stdout?: string; stderr?: string };
22|        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
23|      }
24|    }
25|  });
26|
27|  const execFileFn: any = vi.fn((file: string, args: string[] | undefined, opts: any, cb: any) =>
28|    execFn([file, ...(Array.isArray(args) ? args : [])].join(" "), opts, cb),
29|  );
30|
31|  execFn[promisify.custom] = (cmd: string, opts?: any) =>
32|    new Promise((resolve, reject) => {
33|       
34|      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
35|        if (err) {
36|          (err as Record<string, unknown>).stdout = stdout;
37|          (err as Record<string, unknown>).stderr = stderr;
38|          reject(err);
39|        } else {
40|          resolve({ stdout, stderr });
41|        }
42|      });
43|    });
44|  execFileFn[promisify.custom] = (file: string, args?: string[], opts?: any) =>
45|    execFn[promisify.custom]([file, ...(Array.isArray(args) ? args : [])].join(" "), opts);
46|  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn };
47|});
48|
49|vi.mock("../worktree/worktree-desktop-artifacts.js", () => ({
50|  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
51|}));
52|
53|vi.mock("node:fs", () => ({
54|  existsSync: vi.fn().mockReturnValue(true),
55|  lstatSync: vi.fn().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false }),
56|  readdirSync: vi.fn().mockReturnValue([]),
57|  readFileSync: vi.fn().mockReturnValue(""),
58|  rmdirSync: vi.fn(),
59|  unlinkSync: vi.fn(),
60|}));
61|
62|vi.mock("../worktree/worktree-prune.js", () => ({
63|  pruneWorktreeAdminEntries: vi.fn().mockResolvedValue(undefined),
64|}));
65|
66|import * as desktopArtifacts from "../worktree/worktree-desktop-artifacts.js";
67|import * as worktreePrune from "../worktree/worktree-prune.js";
68|import {
69|  WorktreePool,
70|  detectGitRepository,
71|  getRegisteredWorktreeBranchMap,
72|  getRegisteredWorktreePaths,
73|  isGitRepository,
74|  scanIdleWorktrees,
75|  cleanupOrphanedWorktrees,
76|  reapOrphanWorktrees,
77|} from "../worktree/worktree-pool.js";
78|import { BranchConflictError } from "../execution/branch-conflicts.js";
79|import * as branchConflictModule from "../execution/branch-conflicts.js";
80|import { execSync } from "node:child_process";
81|import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
82|import type { Task, Column } from "@fusion/core";
83|
84|const mockedExecSync = vi.mocked(execSync);
85|const mockedExistsSync = vi.mocked(existsSync);
86|const mockedLstatSync = vi.mocked(lstatSync);
87|const mockedReaddirSync = vi.mocked(readdirSync);
88|const mockedReadFileSync = vi.mocked(readFileSync);
89|const mockedRmdirSync = vi.mocked(rmdirSync);
90|const mockedUnlinkSync = vi.mocked(unlinkSync);
91|const mockedPruneWorktreeAdminEntries = vi.mocked(worktreePrune.pruneWorktreeAdminEntries);
92|const TEST_TASK_ID = "FN-test";
93|
94|let errorSpy: ReturnType<typeof vi.spyOn>;
95|let warnSpy: ReturnType<typeof vi.spyOn>;
96|
97|beforeEach(() => {
98|  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
99|  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
100|  /*
101|  FNXC:TestInfrastructure 2026-07-29-17:05:
102|  worktree-pool logs its checkout-failure at DEBUG level, and createLogger's debug
103|  writes to console.error like the rest — but debug is GATED on FUSION_DEBUG
104|  (logger.ts:43), which is unset under vitest. So the line was never emitted and
105|  the two checkout-failure cases below measured zero calls. One of them is even
106|  named "logs checkout -- failure at debug level" while asserting a channel debug
107|  could not reach without this flag. Enabling it is what makes those assertions
108|  real; re-pointing them at another channel would only describe whatever the code
109|  happened to do. Deleted in afterEach so the flag cannot leak into sibling files.
110|  */
111|  process.env.FUSION_DEBUG = "worktree-pool";
112|});
113|
114|afterEach(() => {
115|  delete process.env.FUSION_DEBUG;
116|  errorSpy.mockRestore();
117|  warnSpy.mockRestore();
118|});
119|
120|describe("WorktreePool", () => {
121|  let pool: WorktreePool;
122|
123|  beforeEach(() => {
124|    vi.clearAllMocks();
125|    vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mockResolvedValue({ removed: [], skipped: [], failures: [] });
126|    mockedExistsSync.mockReturnValue(true);
127|    pool = new WorktreePool();
128|  });
129|
130|  describe("acquire", () => {
131|    it("returns null when pool is empty", () => {
132|      expect(pool.acquire(TEST_TASK_ID)).toBeNull();
133|    });
134|
135|    it("returns a released path on acquire", () => {
136|      pool.release("/tmp/worktree-1");
137|      const result = pool.acquire(TEST_TASK_ID);
138|      expect(result).toBe("/tmp/worktree-1");
139|    });
140|
141|    it("prunes entries where directory no longer exists on disk", () => {
142|      pool.release("/tmp/stale-worktree");
143|      pool.release("/tmp/good-worktree");
144|      // First path doesn't exist, second does
145|      mockedExistsSync.mockImplementation((p) => p === "/tmp/good-worktree");
146|
147|      const result = pool.acquire(TEST_TASK_ID);
148|      expect(result).toBe("/tmp/good-worktree");
149|      expect(pool.size).toBe(0);
150|    });
151|
152|    it("returns null when all entries are stale", () => {
153|      pool.release("/tmp/stale-1");
154|      pool.release("/tmp/stale-2");
155|      mockedExistsSync.mockReturnValue(false);
156|
157|      expect(pool.acquire(TEST_TASK_ID)).toBeNull();
158|      expect(pool.size).toBe(0);
159|    });
160|  });
161|
162|  describe("double-lease invariant", () => {
163|    it("skips rehydrate entries that are already leased", () => {
164|      const handler = vi.fn();
165|      pool.setInvariantViolationHandler(handler);
166|      pool.release("/tmp/wt-lease");
167|      expect(pool.acquire(TEST_TASK_ID)).toBe("/tmp/wt-lease");
168|
169|      pool.rehydrate(["/tmp/wt-lease"]);
170|
171|      expect(pool.size).toBe(0);
172|      expect(pool.getLeasedPaths().get("/tmp/wt-lease")).toBe(TEST_TASK_ID);
173|      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
174|        path: "/tmp/wt-lease",
175|        existingHolder: TEST_TASK_ID,
176|        phase: "rehydrate",
177|      }));
178|    });
179|  });
180|
181|  describe("release", () => {
182|    it("adds a path to the pool", () => {
183|      pool.release("/tmp/wt-1");
184|      expect(pool.size).toBe(1);
185|      expect(pool.has("/tmp/wt-1")).toBe(true);
186|    });
187|
188|    it("does not duplicate on double release", () => {
189|      pool.release("/tmp/wt-1");
190|      pool.release("/tmp/wt-1");
191|      expect(pool.size).toBe(1);
192|    });
193|  });
194|
195|  describe("size", () => {
196|    it("reflects correct count after operations", () => {
197|      expect(pool.size).toBe(0);
198|      pool.release("/tmp/a");
199|      pool.release("/tmp/b");
200|      expect(pool.size).toBe(2);
201|      pool.acquire(TEST_TASK_ID);
202|      expect(pool.size).toBe(1);
203|      pool.acquire(TEST_TASK_ID);
204|      expect(pool.size).toBe(0);
205|    });
206|  });
207|
208|  describe("has", () => {
209|    it("returns false for unknown paths", () => {
210|      expect(pool.has("/tmp/unknown")).toBe(false);
211|    });
212|
213|    it("returns true for released paths", () => {
214|      pool.release("/tmp/wt");
215|      expect(pool.has("/tmp/wt")).toBe(true);
216|    });
217|
218|    it("returns false after path is acquired", () => {
219|      pool.release("/tmp/wt");
220|      pool.acquire(TEST_TASK_ID);
221|      expect(pool.has("/tmp/wt")).toBe(false);
222|    });
223|  });
224|
225|  describe("drain", () => {
226|    it("empties the pool and returns all paths", () => {
227|      pool.release("/tmp/a");
228|      pool.release("/tmp/b");
229|      pool.release("/tmp/c");
230|      const paths = pool.drain();
231|      expect(paths).toHaveLength(3);
232|      expect(paths).toContain("/tmp/a");
233|      expect(paths).toContain("/tmp/b");
234|      expect(paths).toContain("/tmp/c");
235|      expect(pool.size).toBe(0);
236|    });
237|
238|    it("returns empty array when pool is empty", () => {
239|      expect(pool.drain()).toEqual([]);
240|    });
241|  });
242|
243|  describe("prepareForTask", () => {
244|    it("returns the original branch name on success", async () => {
245|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
246|      expect(result).toMatchObject({ branch: "fusion/fn-042", reclaimed: false, worktreePath: "/tmp/wt" });
247|    });
248|
249|    it("cleans dirty working tree before checkout", async () => {
250|      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
251|
252|      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
253|      expect(calls).toContain("git checkout -- .");
254|      expect(calls).toContain("git clean -fd");
255|    });
256|
257|    it("removes desktop artifacts after git clean and before detach checkout", async () => {
258|      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
259|
260|      expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/wt", expect.anything());
261|      const cleanOrder = mockedExecSync.mock.calls.find((c) => c[0] === "git clean -fd");
262|      const detachOrder = mockedExecSync.mock.calls.find((c) => c[0] === "git checkout --detach main");
263|      expect(cleanOrder).toBeDefined();
264|      expect(detachOrder).toBeDefined();
265|      const cleanupOrder = vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mock.invocationCallOrder[0];
266|      const cleanCallOrder = mockedExecSync.mock.invocationCallOrder[mockedExecSync.mock.calls.findIndex((c) => c[0] === "git clean -fd")];
267|      const detachCallOrder = mockedExecSync.mock.invocationCallOrder[mockedExecSync.mock.calls.findIndex((c) => c[0] === "git checkout --detach main")];
268|      expect(cleanCallOrder).toBeLessThan(cleanupOrder);
269|      expect(cleanupOrder).toBeLessThan(detachCallOrder);
270|    });
271|
272|    it("creates branch from main with force-reset", async () => {
273|      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
274|
275|      expect(mockedExecSync).toHaveBeenCalledWith(
276|        "git checkout --detach main",
277|        expect.objectContaining({}),
278|      );
279|
280|      const checkoutCall = mockedExecSync.mock.calls.find(
281|        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
282|      );
283|      expect(checkoutCall).toBeDefined();
284|      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" main');
285|    });
286|
287|    it("creates branch from custom startPoint when provided", async () => {
288|      await pool.prepareForTask("/tmp/wt", "fusion/fn-042", "fusion/fn-041");
289|
290|      expect(mockedExecSync).toHaveBeenCalledWith(
291|        "git checkout --detach fusion/fn-041",
292|        expect.objectContaining({}),
293|      );
294|
295|      const checkoutCall = mockedExecSync.mock.calls.find(
296|        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
297|      );
298|      expect(checkoutCall).toBeDefined();
299|      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" fusion/fn-041');
300|    });
301|
302|    it("tolerates git checkout -- . failure (already clean)", async () => {
303|      mockedExecSync.mockImplementation((cmd: any) => {
304|        if (cmd === "git checkout -- .") throw new Error("nothing to checkout");
305|        return Buffer.from("");
306|      });
307|
308|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-001");
309|      expect(result).toMatchObject({ branch: "fusion/fn-001", reclaimed: false, worktreePath: "/tmp/wt" });
310|
311|      expect(errorSpy).toHaveBeenCalledWith(
312|        expect.stringContaining("[worktree-pool] git checkout -- . failed (may be clean): nothing to checkout"),
313|      );
314|
315|      // Should still run clean and branch creation
316|      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
317|      expect(calls).toContain("git clean -fd");
318|      expect(calls).toContain("git checkout --detach main");
319|      expect(calls).toContain('git checkout -B "fusion/fn-001" main');
320|    });
321|
322|    it("logs checkout -- failure at debug level", async () => {
323|      mockedExecSync.mockImplementation((cmd: any) => {
324|        if (cmd === "git checkout -- .") {
325|          throw new Error("working tree already clean");
326|        }
327|        return Buffer.from("");
328|      });
329|
330|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
331|
332|      expect(result).toMatchObject({ branch: "fusion/fn-042", reclaimed: false, worktreePath: "/tmp/wt" });
333|      expect(errorSpy).toHaveBeenCalledWith(
334|        expect.stringContaining("[worktree-pool] git checkout -- . failed (may be clean): working tree already clean"),
335|      );
336|    });
337|
338|    it("returns reclaimed result when branch is already live elsewhere for the same task", async () => {
339|      mockedExistsSync.mockImplementation((p) => {
340|        if (p === "/other/wt") return true;
341|        return true;
342|      });
343|
344|      mockedExecSync.mockImplementation((cmd: any) => {
345|        const cmdStr = String(cmd);
346|        if (cmdStr === 'git checkout -B "fusion/fn-042" main') {
347|          const err: any = new Error("branch conflict");
348|          err.stderr = Buffer.from(
349|            "fatal: 'fusion/fn-042' is already used by worktree at '/other/wt'"
350|          );
351|          throw err;
352|        }
353|        if (cmdStr === "git worktree list --porcelain") {
354|          return Buffer.from([
355|            "worktree /other/wt",
356|            "HEAD 1111111",
357|            "branch refs/heads/fusion/fn-042",
358|            "",
359|          ].join("\n"));
360|        }
361|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) {
362|          return Buffer.from("abc123def456\n");
363|        }
364|        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) {
365|          return Buffer.from("aaa111\tPreserve prior fix\n");
366|        }
367|        return Buffer.from("");
368|      });
369|
370|      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
371|        kind: "reclaimable",
372|        livePath: "/other/wt",
373|        tipSha: "abc123def456",
374|        taskAttributedCommitCount: 1,
375|        strandedCommits: [{ sha: "aaa111", subject: "Preserve prior fix" }],
376|      });
377|
378|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042", "main", {
379|        repoDir: "/tmp/repo",
380|        requestingTaskId: "FN-042",
381|      });
382|
383|      expect(result).toMatchObject({
384|        branch: "fusion/fn-042",
385|        worktreePath: "/other/wt",
386|        reclaimed: true,
387|        existingTipSha: "abc123def456",
388|        strandedCommitCount: 1,
389|      });
390|    });
391|
392|    it("maps slugged fusion branches to canonical task IDs", async () => {
393|      mockedExistsSync.mockReturnValue(true);
394|
395|      mockedExecSync.mockImplementation((cmd: any) => {
396|        const cmdStr = String(cmd);
397|        if (cmdStr === 'git checkout -B "fusion/fn-5671-add-dropdown" main') {
398|          const err: any = new Error("branch conflict");
399|          err.stderr = Buffer.from("fatal: 'fusion/fn-5671-add-dropdown' is already used by worktree at '/other/wt'");
400|          throw err;
401|        }
402|        if (cmdStr === "git worktree list --porcelain") {
403|          return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-5671-add-dropdown", ""].join("\n"));
404|        }
405|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-5671-add-dropdown^{commit}'")) {
406|          return Buffer.from("abc123def456\n");
407|        }
408|        return Buffer.from("");
409|      });
410|
411|      const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
412|        kind: "live-foreign",
413|        livePath: "/other/wt",
414|        error: new BranchConflictError({
415|          branchName: "fusion/fn-5671-add-dropdown",
416|          conflictingWorktreePath: "/other/wt",
417|          existingTipSha: "abc123def456",
418|          strandedCommits: [],
419|          startPoint: "main",
420|          recommendedAction: "Inspect/reclaim.",
421|        }),
422|      });
423|
424|      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-5671-add-dropdown")).rejects.toBeInstanceOf(BranchConflictError);
425|      expect(inspectSpy).toHaveBeenCalledWith(expect.objectContaining({
426|        branchName: "fusion/fn-5671-add-dropdown",
427|        ownerTaskId: "FN-5671",
428|        requestingTaskId: "FN-5671",
429|      }));
430|    });
431|
432|    it("throws BranchConflictError for cross-task live-foreign conflicts", async () => {
433|      mockedExistsSync.mockReturnValue(true);
434|
435|      mockedExecSync.mockImplementation((cmd: any) => {
436|        const cmdStr = String(cmd);
437|        if (cmdStr === 'git checkout -B "fusion/fn-042" main') {
438|          const err: any = new Error("branch conflict");
439|          err.stderr = Buffer.from("fatal: 'fusion/fn-042' is already used by worktree at '/other/wt'");
440|          throw err;
441|        }
442|        if (cmdStr === "git worktree list --porcelain") {
443|          return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
444|        }
445|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) {
446|          return Buffer.from("abc123def456\n");
447|        }
448|        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) {
449|          return Buffer.from("aaa111\tForeign fix\n");
450|        }
451|        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-042'")) {
452|          return Buffer.from("aaa111\tfeat(FN-999): foreign\x1fFusion-Task-Id: FN-999\n");
453|        }
454|        return Buffer.from("");
455|      });
456|
457|      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
458|        kind: "live-foreign",
459|        livePath: "/other/wt",
460|        error: new BranchConflictError({
461|          branchName: "fusion/fn-042",
462|          conflictingWorktreePath: "/other/wt",
463|          existingTipSha: "abc123def456",
464|          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
465|          startPoint: "main",
466|          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
467|        }),
468|      });
469|
470|      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042", undefined, {
471|        repoDir: "/tmp/repo",
472|        requestingTaskId: "FN-042",
473|      })).rejects.toBeInstanceOf(BranchConflictError);
474|
475|      const checkoutCalls = mockedExecSync.mock.calls
476|        .map((c) => c[0])
477|        .filter((c) => typeof c === "string" && c.includes("checkout -B"));
478|      expect(checkoutCalls).not.toContain('git checkout -B "fusion/fn-042-2" fusion/fn-042');
479|    });
480|
481|    it("restores legacy suffixed branch behavior only when explicitly enabled", async () => {
482|      mockedExistsSync.mockReturnValue(true);
483|
484|      mockedExecSync.mockImplementation((cmd: any) => {
485|        const cmdStr = String(cmd);
486|        if (cmdStr === 'git checkout -B "fusion/fn-042" fusion/fn-041') {
487|          const err: any = new Error("branch conflict");
488|          err.stderr = Buffer.from("fatal: 'fusion/fn-042' is already used by worktree at '/other/wt'");
489|          throw err;
490|        }
491|        if (cmdStr === "git worktree list --porcelain") {
492|          return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
493|        }
494|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) return Buffer.from("abc123def456\n");
495|        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'fusion/fn-041..fusion/fn-042'")) return Buffer.from("aaa111\tPreserve prior fix\n");
496|        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'fusion/fn-041..fusion/fn-042'")) return Buffer.from("aaa111\u001ffeat(FN-999): foreign\u001fFusion-Task-Id: FN-999\n");
497|        return Buffer.from("");
498|      });
499|
500|      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
501|        kind: "live-foreign",
502|        livePath: "/other/wt",
503|        error: new BranchConflictError({
504|          branchName: "fusion/fn-042",
505|          conflictingWorktreePath: "/other/wt",
506|          existingTipSha: "abc123def456",
507|          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
508|          startPoint: "fusion/fn-041",
509|          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
510|        }),
511|      });
512|
513|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042", "fusion/fn-041", { allowSiblingBranchRename: true, repoDir: "/tmp/repo" });
514|      expect(result.branch).toBe("fusion/fn-042-2");
515|    });
516|
517|    it("increments suffix when lower suffixes are also in use in legacy rename mode", async () => {
518|      mockedExistsSync.mockReturnValue(true);
519|
520|      mockedExecSync.mockImplementation((cmd: any) => {
521|        const cmdStr = String(cmd);
522|        if (cmdStr.startsWith('git checkout -B "fusion/fn-042" ') || cmdStr.startsWith('git checkout -B "fusion/fn-042-2" ')) {
523|          const err: any = new Error("branch conflict");
524|          err.stderr = Buffer.from("fatal: 'x' is already used by worktree at '/other/wt'");
525|          throw err;
526|        }
527|        if (cmdStr === "git worktree list --porcelain") return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
528|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) return Buffer.from("abc123def456\n");
529|        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) return Buffer.from("aaa111\tPreserve prior fix\n");
530|        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-042'")) return Buffer.from("aaa111\u001ffeat(FN-999): foreign\u001fFusion-Task-Id: FN-999\n");
531|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042-2^{commit}'")) return Buffer.from("bbb222ccc333\n");
532|        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042-2'")) return Buffer.from("bbb222\tFirst sibling\n");
533|        return Buffer.from("");
534|      });
535|
536|      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
537|        kind: "live-foreign",
538|        livePath: "/other/wt",
539|        error: new BranchConflictError({
540|          branchName: "fusion/fn-042",
541|          conflictingWorktreePath: "/other/wt",
542|          existingTipSha: "abc123def456",
543|          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
544|          startPoint: "main",
545|          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
546|        }),
547|      });
548|
549|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042", undefined, { allowSiblingBranchRename: true, repoDir: "/tmp/repo" });
550|      expect(result.branch).toBe("fusion/fn-042-3");
551|    });
552|
553|    it("falls back to git worktree prune when conflicting worktree no longer exists on disk", async () => {
554|      mockedExistsSync.mockImplementation((p) => {
555|        // The conflicting worktree does NOT exist
556|        if (p === "/gone/wt") return false;
557|        return true;
558|      });
559|
560|      let checkoutBCount = 0;
561|      mockedExecSync.mockImplementation((cmd: any) => {
562|        const cmdStr = String(cmd);
563|        if (cmdStr.includes("checkout -B")) {
564|          checkoutBCount++;
565|          if (checkoutBCount === 1) {
566|            const err: any = new Error("branch conflict");
567|            err.stderr = Buffer.from(
568|              "fatal: 'fusion/fn-042' is already used by worktree at '/gone/wt'"
569|            );
570|            throw err;
571|          }
572|          return Buffer.from("");
573|        }
574|        return Buffer.from("");
575|      });
576|
577|      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
578|      expect(result.branch).toBe("fusion/fn-042");
579|
580|      const cmds = mockedExecSync.mock.calls.map((c) => c[0]);
581|      expect(cmds).toContain("git worktree prune");
582|    });
583|
584|    it("re-throws non-conflict errors from checkout -B unchanged", async () => {
585|      mockedExecSync.mockImplementation((cmd: any) => {
586|        if (String(cmd).includes("checkout -B")) {
587|          const err: any = new Error("some other git error");
588|          err.stderr = Buffer.from("fatal: some other git error");
589|          throw err;
590|        }
591|        return Buffer.from("");
592|      });
593|
594|      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042")).rejects.toThrow(
595|        "some other git error"
596|      );
597|    });
598|
599|    it("throws when all suffixed names are exhausted in legacy rename mode", async () => {
600|      mockedExistsSync.mockReturnValue(true);
601|      mockedExecSync.mockImplementation((cmd: any) => {
602|        const cmdStr = String(cmd);
603|        if (cmdStr.includes("checkout -B")) {
604|          const err: any = new Error("branch conflict");
605|          err.stderr = Buffer.from("fatal: 'x' is already used by worktree at '/other/wt'");
606|          throw err;
607|        }
608|        if (cmdStr === "git worktree list --porcelain") return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
609|        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) return Buffer.from("abc123def456\n");
610|        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) return Buffer.from("aaa111\tPreserve prior fix\n");
611|        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-042'")) return Buffer.from("aaa111\u001ffeat(FN-999): foreign\u001fFusion-Task-Id: FN-999\n");
612|        return Buffer.from("");
613|      });
614|
615|      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
616|        kind: "live-foreign",
617|        livePath: "/other/wt",
618|        error: new BranchConflictError({
619|          branchName: "fusion/fn-042",
620|          conflictingWorktreePath: "/other/wt",
621|          existingTipSha: "abc123def456",
622|          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
623|          startPoint: "main",
624|          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
625|        }),
626|      });
627|
628|      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042", undefined, { allowSiblingBranchRename: true, repoDir: "/tmp/repo" })).rejects.toThrow(/suffixes -2 through -6 are all in use/);
629|    });
630|  });
631|
632|  describe("rehydrate", () => {
633|    it("loads paths into the idle set", () => {
634|      mockedExistsSync.mockReturnValue(true);
635|      pool.rehydrate(["/tmp/wt-1", "/tmp/wt-2", "/tmp/wt-3"]);
636|      expect(pool.size).toBe(3);
637|      expect(pool.has("/tmp/wt-1")).toBe(true);
638|      expect(pool.has("/tmp/wt-2")).toBe(true);
639|      expect(pool.has("/tmp/wt-3")).toBe(true);
640|    });
641|
642|    it("skips paths that don't exist on disk", () => {
643|      mockedExistsSync.mockImplementation((p) => p === "/tmp/good-wt");
644|      pool.rehydrate(["/tmp/good-wt", "/tmp/gone-wt"]);
645|      expect(pool.size).toBe(1);
646|      expect(pool.has("/tmp/good-wt")).toBe(true);
647|      expect(pool.has("/tmp/gone-wt")).toBe(false);
648|    });
649|
650|    it("handles empty array", () => {
651|      pool.rehydrate([]);
652|      expect(pool.size).toBe(0);
653|    });
654|
655|    it("does not duplicate entries already in the pool", () => {
656|      mockedExistsSync.mockReturnValue(true);
657|      pool.release("/tmp/existing");
658|      pool.rehydrate(["/tmp/existing", "/tmp/new"]);
659|      expect(pool.size).toBe(2);
660|    });
661|  });
662|});
663|
664|describe("detectGitRepository", () => {
665|  beforeEach(() => {
666|    vi.clearAllMocks();
667|  });
668|
669|  it("classifies a POSIX git repository as repo", async () => {
670|    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
671|      expect(opts).toEqual(expect.objectContaining({ cwd: "/tmp/repo", timeout: 10_000 }));
672|      if (String(cmd) === "git rev-parse --git-dir") {
673|        return Buffer.from(".git\n");
674|      }
675|      return Buffer.from("");
676|    });
677|
678|    await expect(detectGitRepository("/tmp/repo")).resolves.toEqual({ status: "repo" });
679|    await expect(isGitRepository("/tmp/repo")).resolves.toBe(true);
680|  });
681|
682|  it("classifies a genuine non-git directory as not-repo", async () => {
683|    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
684|      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/plain") {
685|        const error: any = new Error("fatal: not a git repository (or any of the parent directories): .git");
686|        error.stderr = Buffer.from("fatal: not a git repository (or any of the parent directories): .git");
687|        throw error;
688|      }
689|      return Buffer.from("");
690|    });
691|
692|    await expect(detectGitRepository("/tmp/plain")).resolves.toEqual({
693|      status: "not-repo",
694|      stderr: "fatal: not a git repository (or any of the parent directories): .git",
695|    });
696|    await expect(isGitRepository("/tmp/plain")).resolves.toBe(false);
697|  });
698|
699|  it("classifies dubious ownership on a Windows OneDrive Documents path as an error", async () => {
700|    const windowsPath = "C:/Users/drewd/Documents/1. App Development/1. Active/NextGenEHS";
701|    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
702|      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === windowsPath) {
703|        const error: any = new Error(`fatal: detected dubious ownership in repository at '${windowsPath}'`);
704|        error.stderr = Buffer.from(`fatal: detected dubious ownership in repository at '${windowsPath}'`);
705|        throw error;
706|      }
707|      return Buffer.from("");
708|    });
709|
710|    await expect(detectGitRepository(windowsPath)).resolves.toEqual({
711|      status: "error",
712|      reason: "dubious-ownership",
713|      stderr: `fatal: detected dubious ownership in repository at '${windowsPath}'`,
714|    });
715|    await expect(isGitRepository(windowsPath)).resolves.toBe(false);
716|  });
717|
718|  it("classifies git missing from PATH as an error", async () => {
719|    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
720|      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/repo") {
721|        const error: any = new Error("spawn git ENOENT");
722|        error.code = "ENOENT";
723|        throw error;
724|      }
725|      return Buffer.from("");
726|    });
727|
728|    await expect(detectGitRepository("/tmp/repo")).resolves.toEqual({
729|      status: "error",
730|      reason: "git-missing",
731|      stderr: "spawn git ENOENT",
732|    });
733|    await expect(isGitRepository("/tmp/repo")).resolves.toBe(false);
734|  });
735|
736|  it("classifies a timed-out git probe as an error", async () => {
737|    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
738|      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/repo") {
739|        const error: any = new Error("Command failed: git rev-parse --git-dir");
740|        error.code = "ETIMEDOUT";
741|        error.killed = true;
742|        error.stderr = Buffer.from("Timed out: git rev-parse --git-dir");
743|        throw error;
744|      }
745|      return Buffer.from("");
746|    });
747|
748|    await expect(detectGitRepository("/tmp/repo")).resolves.toEqual({
749|      status: "error",
750|      reason: "timeout",
751|      stderr: "Timed out: git rev-parse --git-dir",
752|    });
753|    await expect(isGitRepository("/tmp/repo")).resolves.toBe(false);
754|  });
755|});
756|
757|describe("getRegisteredWorktreePaths", () => {
758|  beforeEach(() => {
759|    vi.clearAllMocks();
760|  });
761|
762|  it("logs warning and returns empty set when git worktree list fails", async () => {
763|    mockedExecSync.mockImplementation((cmd: any) => {
764|      if (String(cmd) === "git worktree list --porcelain") {
765|        throw new Error("git unavailable");
766|      }
767|      return Buffer.from("");
768|    });
769|
770|    const registered = await getRegisteredWorktreePaths("/root");
771|
772|    expect(registered).toEqual(new Set());
773|    expect(warnSpy).toHaveBeenCalledWith(
774|      expect.stringContaining("[worktree-pool] Failed to list registered worktrees: git unavailable"),
775|    );
776|  });
777|});
778|
779|describe("getRegisteredWorktreeBranchMap", () => {
780|  beforeEach(() => {
781|    vi.clearAllMocks();
782|  });
783|
784|  it("returns a branch→worktree map from porcelain output", async () => {
785|    mockedExecSync.mockImplementation((cmd: any) => {
786|      if (String(cmd) === "git worktree list --porcelain") {
787|        return [
788|          "worktree /root",
789|          "HEAD abc",
790|          "branch refs/heads/main",
791|          "",
792|          "worktree /root/.worktrees/sleek-stone",
793|          "HEAD def",
794|          "branch refs/heads/fusion/fn-4913",
795|          "",
796|          "worktree /root/.worktrees/detached",
797|          "HEAD 123",
798|          "detached",
799|          "",
800|        ].join("\n") as any;
801|      }
802|      return Buffer.from("");
803|    });
804|
805|    const map = await getRegisteredWorktreeBranchMap("/root");
806|    expect(map.get("main")).toBe("/root");
807|    expect(map.get("fusion/fn-4913")).toBe("/root/.worktrees/sleek-stone");
808|    expect(map.has("detached")).toBe(false);
809|  });
810|});
811|
812|// ── Helper for mock store ─────────────────────────────────────────────
813|
814|function makeTask(id: string, column: Column, worktree?: string): Task {
815|  return {
816|    id,
817|    title: `Task ${id}`,
818|    description: `Description for ${id}`,
819|    column,
820|    dependencies: [],
821|    worktree,
822|    steps: [],
823|    currentStep: 0,
824|    log: [],
825|    createdAt: new Date().toISOString(),
826|    updatedAt: new Date().toISOString(),
827|  };
828|}
829|
830|function createMockStore(tasks: Task[] = []) {
831|  return {
832|    listTasks: vi.fn().mockResolvedValue(tasks),
833|  } as any;
834|}
835|
836|function makeDirEntry(name: string) {
837|  return { name, isDirectory: () => true } as any;
838|}
839|
840|function mockRegisteredWorktrees(rootDir: string, names: string[]) {
841|  mockedExecSync.mockImplementation((cmd: any) => {
842|    if (String(cmd) === "git worktree list --porcelain") {
843|      return [
844|        `worktree ${rootDir}`,
845|        "HEAD abc123",
846|        "branch refs/heads/main",
847|        "",
848|        ...names.flatMap((name) => [
849|          `worktree ${rootDir}/.worktrees/${name}`,
850|          "HEAD def456",
851|          `branch refs/heads/fusion/${name}`,
852|          "",
853|        ]),
854|      ].join("\n") as any;
855|    }
856|    return Buffer.from("");
857|  });
858|}
859|
860|// ── scanIdleWorktrees tests ───────────────────────────────────────────
861|
862|describe("scanIdleWorktrees", () => {
863|  beforeEach(() => {
864|    vi.clearAllMocks();
865|    mockedExistsSync.mockReturnValue(true);
866|    mockRegisteredWorktrees("/root", []);
867|  });
868|
869|  it("correctly identifies idle vs active worktrees", async () => {
870|    mockedReaddirSync.mockReturnValue([
871|      makeDirEntry("swift-falcon"),
872|      makeDirEntry("calm-river"),
873|      makeDirEntry("bold-eagle"),
874|    ] as any);
875|    mockRegisteredWorktrees("/root", ["swift-falcon", "calm-river", "bold-eagle"]);
876|
877|    const store = createMockStore([
878|      makeTask("FN-001", "in-progress", "/root/.worktrees/swift-falcon"),
879|      makeTask("FN-002", "done", "/root/.worktrees/calm-river"),
880|    ]);
881|
882|    const idle = await scanIdleWorktrees("/root", store);
883|
884|    expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false, startupMemo: true });
885|    expect(idle).toContain("/root/.worktrees/calm-river");
886|    expect(idle).toContain("/root/.worktrees/bold-eagle");
887|    expect(idle).not.toContain("/root/.worktrees/swift-falcon");
888|  });
889|
890|  it("handles empty .worktrees/ directory", async () => {
891|    mockedReaddirSync.mockReturnValue([] as any);
892|    const store = createMockStore([]);
893|
894|    const idle = await scanIdleWorktrees("/root", store);
895|    expect(idle).toEqual([]);
896|  });
897|
898|  it("handles missing .worktrees/ directory", async () => {
899|    mockedExistsSync.mockReturnValue(false);
900|    const store = createMockStore([]);
901|
902|    const idle = await scanIdleWorktrees("/root", store);
903|    expect(idle).toEqual([]);
904|  });
905|
906|  it("treats in-review tasks as active (worktree preserved)", async () => {
907|    mockedReaddirSync.mockReturnValue([
908|      makeDirEntry("review-wt"),
909|    ] as any);
910|    mockRegisteredWorktrees("/root", ["review-wt"]);
911|
912|    const store = createMockStore([
913|      makeTask("FN-010", "in-review", "/root/.worktrees/review-wt"),
914|    ]);
915|
916|    const idle = await scanIdleWorktrees("/root", store);
917|    expect(idle).not.toContain("/root/.worktrees/review-wt");
918|  });
919|
920|  it("returns all worktrees when no tasks exist", async () => {
921|    mockedReaddirSync.mockReturnValue([
922|      makeDirEntry("wt-1"),
923|      makeDirEntry("wt-2"),
924|    ] as any);
925|    mockRegisteredWorktrees("/root", ["wt-1", "wt-2"]);
926|
927|    const store = createMockStore([]);
928|
929|    const idle = await scanIdleWorktrees("/root", store);
930|    expect(idle).toHaveLength(2);
931|    expect(idle).toContain("/root/.worktrees/wt-1");
932|    expect(idle).toContain("/root/.worktrees/wt-2");
933|  });
934|
935|  it("returns empty array when readdirSync throws", async () => {
936|    mockedReaddirSync.mockImplementation(() => {
937|      throw new Error("Permission denied");
938|    });
939|    const store = createMockStore([]);
940|
941|    const idle = await scanIdleWorktrees("/root", store);
942|    expect(idle).toEqual([]);
943|    expect(warnSpy).toHaveBeenCalledWith(
944|      expect.stringContaining("[worktree-pool] Failed to read .worktrees/ directory: Permission denied"),
945|    );
946|  });
947|
948|  it("excludes internal containers even when git lists their children", async () => {
949|    mockedReaddirSync.mockReturnValue([
950|      makeDirEntry(".ai-merge"),
951|      makeDirEntry(".fusion-recovery"),
952|      makeDirEntry("registered-wt"),
953|    ] as any);
954|    mockRegisteredWorktrees("/root", [
955|      ".ai-merge/fusion-ai-merge-fn-1-active",
956|      ".fusion-recovery/worktrees/fn-1-preserved",
957|      "registered-wt",
958|    ]);
959|
960|    const store = createMockStore([]);
961|
962|    const idle = await scanIdleWorktrees("/root", store);
963|    expect(idle).toEqual(["/root/.worktrees/registered-wt"]);
964|    expect(idle).not.toContain("/root/.worktrees/.ai-merge");
965|    expect(idle).not.toContain("/root/.worktrees/.fusion-recovery");
966|  });
967|
968|  it("does not return unregistered directories for pool rehydration", async () => {
969|    mockedReaddirSync.mockReturnValue([
970|      makeDirEntry("registered-wt"),
971|      makeDirEntry("broken-wt"),
972|    ] as any);
973|    mockRegisteredWorktrees("/root", ["registered-wt"]);
974|
975|    const store = createMockStore([
976|      makeTask("FN-001", "in-progress", "/root/.worktrees/broken-wt"),
977|    ]);
978|
979|    const idle = await scanIdleWorktrees("/root", store);
980|    expect(idle).toEqual(["/root/.worktrees/registered-wt"]);
981|  });
982|});
983|
984|// ── cleanupOrphanedWorktrees tests ────────────────────────────────────
985|
986|describe("cleanupOrphanedWorktrees", () => {
987|  beforeEach(() => {
988|    vi.clearAllMocks();
989|    mockedExistsSync.mockReturnValue(true);
990|    mockRegisteredWorktrees("/root", []);
991|    mockedPruneWorktreeAdminEntries.mockResolvedValue(undefined);
992|  });
993|
994|  it("removes worktrees not assigned to any active task", async () => {
995|    mockedReaddirSync.mockReturnValue([
996|      makeDirEntry("orphan-1"),
997|      makeDirEntry("orphan-2"),
998|    ] as any);
999|    mockRegisteredWorktrees("/root", ["orphan-1", "orphan-2"]);
1000|
1001|    const store = createMockStore([]);
1002|
1003|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1004|
1005|    expect(cleaned).toBe(2);
1006|    const removeCalls = mockedExecSync.mock.calls.filter(
1007|      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
1008|    );
1009|    expect(removeCalls).toHaveLength(2);
1010|    expect(removeCalls[0][0]).toContain("/root/.worktrees/orphan-1");
1011|    expect(removeCalls[1][0]).toContain("/root/.worktrees/orphan-2");
1012|  });
1013|
1014|  it("preserves registered orphaned worktrees that have uncommitted changes", async () => {
1015|    mockedReaddirSync.mockReturnValue([
1016|      makeDirEntry("dirty-wt"),
1017|    ] as any);
1018|    mockedExecSync.mockImplementation((cmd: any) => {
1019|      if (String(cmd) === "git worktree list --porcelain") {
1020|        return [
1021|          "worktree /root",
1022|          "HEAD abc123",
1023|          "branch refs/heads/main",
1024|          "",
1025|          "worktree /root/.worktrees/dirty-wt",
1026|          "HEAD def456",
1027|          "branch refs/heads/fusion/dirty-wt",
1028|          "",
1029|        ].join("\n") as any;
1030|      }
1031|      if (String(cmd).includes("status --porcelain")) {
1032|        return " M src/file.ts\n" as any;
1033|      }
1034|      return Buffer.from("");
1035|    });
1036|
1037|    const store = createMockStore([]);
1038|
1039|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1040|
1041|    expect(cleaned).toBe(0);
1042|    const removeCalls = mockedExecSync.mock.calls.filter(
1043|      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
1044|    );
1045|    expect(removeCalls).toHaveLength(0);
1046|  });
1047|
1048|  it("removes registered orphaned worktrees when status probe is clean", async () => {
1049|    mockedReaddirSync.mockReturnValue([
1050|      makeDirEntry("clean-wt"),
1051|    ] as any);
1052|    mockedExecSync.mockImplementation((cmd: any) => {
1053|      if (String(cmd) === "git worktree list --porcelain") {
1054|        return [
1055|          "worktree /root",
1056|          "HEAD abc123",
1057|          "branch refs/heads/main",
1058|          "",
1059|          "worktree /root/.worktrees/clean-wt",
1060|          "HEAD def456",
1061|          "branch refs/heads/fusion/clean-wt",
1062|          "",
1063|        ].join("\n") as any;
1064|      }
1065|      if (String(cmd) === "git status --porcelain") {
1066|        return Buffer.from("");
1067|      }
1068|      return Buffer.from("");
1069|    });
1070|
1071|    const store = createMockStore([]);
1072|
1073|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1074|
1075|    expect(cleaned).toBe(1);
1076|    const removeCalls = mockedExecSync.mock.calls.filter(
1077|      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
1078|    );
1079|    expect(removeCalls).toHaveLength(1);
1080|    expect(removeCalls[0][0]).toContain("/root/.worktrees/clean-wt");
1081|  });
1082|
1083|  it("preserves worktrees assigned to in-progress/in-review tasks", async () => {
1084|    mockedReaddirSync.mockReturnValue([
1085|      makeDirEntry("active-wt"),
1086|      makeDirEntry("orphan-wt"),
1087|    ] as any);
1088|    mockRegisteredWorktrees("/root", ["active-wt", "orphan-wt"]);
1089|
1090|    const store = createMockStore([
1091|      makeTask("FN-001", "in-progress", "/root/.worktrees/active-wt"),
1092|    ]);
1093|
1094|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1095|
1096|    expect(cleaned).toBe(1);
1097|    const removeCalls = mockedExecSync.mock.calls.filter(
1098|      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
1099|    );
1100|    expect(removeCalls).toHaveLength(1);
1101|    expect(removeCalls[0][0]).toContain("orphan-wt");
1102|    expect(removeCalls[0][0]).not.toContain("active-wt");
1103|  });
1104|
1105|
1106|  it("handles git worktree remove failures gracefully (non-fatal)", async () => {
1107|    mockedReaddirSync.mockReturnValue([
1108|      makeDirEntry("fail-wt"),
1109|      makeDirEntry("ok-wt"),
1110|    ] as any);
1111|
1112|    mockedExecSync.mockImplementation((cmd: any) => {
1113|      if (String(cmd) === "git worktree list --porcelain") {
1114|        return [
1115|          "worktree /root",
1116|          "HEAD abc123",
1117|          "branch refs/heads/main",
1118|          "",
1119|          "worktree /root/.worktrees/fail-wt",
1120|          "HEAD def456",
1121|          "branch refs/heads/fusion/fail-wt",
1122|          "",
1123|          "worktree /root/.worktrees/ok-wt",
1124|          "HEAD def456",
1125|          "branch refs/heads/fusion/ok-wt",
1126|          "",
1127|        ].join("\n") as any;
1128|      }
1129|      if (typeof cmd === "string" && cmd.includes("fail-wt")) {
1130|        throw new Error("worktree locked");
1131|      }
1132|      return Buffer.from("");
1133|    });
1134|
1135|    const store = createMockStore([]);
1136|
1137|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1138|
1139|    // Only 1 cleaned (the other failed), but no throw
1140|    expect(cleaned).toBe(1);
1141|  });
1142|
1143|  it("no-ops when .worktrees/ doesn't exist", async () => {
1144|    mockedExistsSync.mockReturnValue(false);
1145|    const store = createMockStore([]);
1146|
1147|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1148|    expect(cleaned).toBe(0);
1149|    const removeCalls = mockedExecSync.mock.calls.filter(
1150|      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
1151|    );
1152|    expect(removeCalls).toHaveLength(0);
1153|  });
1154|
1155|  it("logs warning when readdirSync fails for cleanup scan", async () => {
1156|    let readdirCalls = 0;
1157|    mockedReaddirSync.mockImplementation(() => {
1158|      readdirCalls += 1;
1159|      if (readdirCalls === 1) {
1160|        return [] as any;
1161|      }
1162|      throw new Error("cleanup permission denied");
1163|    });
1164|
1165|    const store = createMockStore([]);
1166|
1167|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1168|
1169|    expect(cleaned).toBe(0);
1170|    expect(warnSpy).toHaveBeenCalledWith(
1171|      expect.stringContaining("[worktree-pool] reapOrphanWorktrees: failed to read .worktrees/ — cleanup permission denied"),
1172|    );
1173|  });
1174|
1175|  it("returns 0 when all worktrees are assigned to active tasks", async () => {
1176|    mockedReaddirSync.mockReturnValue([
1177|      makeDirEntry("active-1"),
1178|      makeDirEntry("active-2"),
1179|    ] as any);
1180|    mockRegisteredWorktrees("/root", ["active-1", "active-2"]);
1181|
1182|    const store = createMockStore([
1183|      makeTask("FN-001", "in-progress", "/root/.worktrees/active-1"),
1184|      makeTask("FN-002", "in-review", "/root/.worktrees/active-2"),
1185|    ]);
1186|
1187|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1188|    expect(cleaned).toBe(0);
1189|    const removeCalls = mockedExecSync.mock.calls.filter(
1190|      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
1191|    );
1192|    expect(removeCalls).toHaveLength(0);
1193|  });
1194|
1195|  it("excludes internal containers while still removing genuine unregistered orphans", async () => {
1196|    mockedReaddirSync.mockReturnValue([
1197|      makeDirEntry(".ai-merge"),
1198|      makeDirEntry(".fusion-recovery"),
1199|      makeDirEntry("broken-wt"),
1200|    ] as any);
1201|    mockRegisteredWorktrees("/root", []);
1202|    mockedExistsSync.mockImplementation((path) => !String(path).endsWith("/.git"));
1203|
1204|    const store = createMockStore([]);
1205|
1206|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1207|
1208|    expect(cleaned).toBe(1);
1209|    expect(mockedRmdirSync).toHaveBeenCalledWith("/root/.worktrees/broken-wt");
1210|    expect(mockedRmdirSync).not.toHaveBeenCalledWith("/root/.worktrees/.ai-merge");
1211|    expect(mockedRmdirSync).not.toHaveBeenCalledWith("/root/.worktrees/.fusion-recovery");
1212|  });
1213|
1214|  it("removes unregistered directories even when stale active task metadata references them", async () => {
1215|    mockedReaddirSync.mockReturnValue([
1216|      makeDirEntry("broken-wt"),
1217|    ] as any);
1218|    mockRegisteredWorktrees("/root", []);
1219|    mockedExistsSync.mockImplementation((path) => !String(path).endsWith("/.git"));
1220|
1221|    const store = createMockStore([
1222|      makeTask("FN-001", "in-progress", "/root/.worktrees/broken-wt"),
1223|    ]);
1224|
1225|    const cleaned = await cleanupOrphanedWorktrees("/root", store);
1226|
1227|    expect(cleaned).toBe(1);
1228|    expect(mockedRmdirSync).toHaveBeenCalledWith("/root/.worktrees/broken-wt");
1229|    expect(mockedPruneWorktreeAdminEntries).toHaveBeenCalledWith(
1230|      expect.objectContaining({ reason: "pool-reap-orphan", target: "/root/.worktrees/broken-wt" }),
1231|    );
1232|  });
1233|});
1234|
1235|describe("reapOrphanWorktrees", () => {
1236|  beforeEach(() => {
1237|    vi.clearAllMocks();
1238|    mockRegisteredWorktrees("/root", []);
1239|    mockedExistsSync.mockImplementation((path) => {
1240|      const value = String(path);
1241|      return value === "/root/.worktrees" || (value.startsWith("/root/.worktrees/") && !value.endsWith("/.git"));
1242|    });
1243|    mockedLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false } as any);
1244|  });
1245|
1246|  it("excludes internal containers while removing half-initialized task worktrees", async () => {
1247|    mockedReaddirSync.mockImplementation((path: any) =>
1248|      String(path) === "/root/.worktrees"
1249|        ? [makeDirEntry(".ai-merge"), makeDirEntry(".fusion-recovery"), makeDirEntry("half-built")] as any
1250|        : [] as any,
1251|    );
1252|    const removed = await reapOrphanWorktrees("/root");
1253|
1254|    expect(removed).toBe(1);
1255|    expect(mockedRmdirSync).toHaveBeenCalledWith("/root/.worktrees/half-built");
1256|    expect(mockedRmdirSync).not.toHaveBeenCalledWith("/root/.worktrees/.ai-merge");
1257|    expect(mockedRmdirSync).not.toHaveBeenCalledWith("/root/.worktrees/.fusion-recovery");
1258|  });
1259|
1260|  it("preserves a dirty half-initialized worktree", async () => {
1261|    mockedReaddirSync.mockReturnValue([makeDirEntry("dirty-half-built")] as any);
1262|    mockedRmdirSync.mockImplementationOnce(() => {
1263|      throw new Error("ENOTEMPTY");
1264|    });
1265|
1266|    const removed = await reapOrphanWorktrees("/root");
1267|
1268|    expect(removed).toBe(0);
1269|    expect(mockedPruneWorktreeAdminEntries).not.toHaveBeenCalled();
1270|  });
1271|
1272|  // FN-6782 follow-up: a directory whose `.git` points to a missing admin entry is leak
1273|  // residue (invisible to `git worktree list`/`prune`), not "partially registered". It
1274|  // must be reaped — otherwise it collides with freshly generated worktree names and
1275|  // breaks `execute`. Previously the reaper skipped on mere `.git` presence.
1276|  it("reaps a dir with a dangling .git pointer (admin gitdir missing)", async () => {
1277|    mockedReaddirSync.mockImplementation((path: any) =>
1278|      String(path) === "/root/.worktrees"
1279|        ? [makeDirEntry("leaked-wt")] as any
1280|        : [".git"] as any,
1281|    );
1282|
1283|    // `.git` is a link FILE (not a dir); the worktree dir itself is a dir.
1284|    mockedLstatSync.mockImplementation((p: any) =>
1285|      (String(p).endsWith("/.git")
1286|        ? { isDirectory: () => false, isSymbolicLink: () => false }
1287|        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
1288|    );
1289|    mockedReadFileSync.mockReturnValue("gitdir: /root/.git/worktrees/leaked-wt\n" as any);
1290|    mockedExistsSync.mockImplementation((p) => {
1291|      const s = String(p);
1292|      // .worktrees root exists; the .git link file exists; the gitdir target does NOT.
1293|      return s === "/root/.worktrees" || s === "/root/.worktrees/leaked-wt/.git";
1294|    });
1295|
1296|    const removed = await reapOrphanWorktrees("/root");
1297|
1298|    expect(removed).toBe(1);
1299|    expect(mockedUnlinkSync).toHaveBeenCalledWith("/root/.worktrees/leaked-wt/.git");
1300|    expect(mockedRmdirSync).toHaveBeenCalledWith("/root/.worktrees/leaked-wt");
1301|  });
1302|
1303|  it("preserves a dangling .git pointer when the orphan contains user files", async () => {
1304|    mockedReaddirSync.mockImplementation((path: any) =>
1305|      String(path) === "/root/.worktrees"
1306|        ? [makeDirEntry("dirty-leaked-wt")] as any
1307|        : [".git", "notes.txt"] as any,
1308|    );
1309|    mockedLstatSync.mockImplementation((p: any) =>
1310|      (String(p).endsWith("/.git")
1311|        ? { isDirectory: () => false, isSymbolicLink: () => false }
1312|        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
1313|    );
1314|    mockedReadFileSync.mockReturnValue("gitdir: /root/.git/worktrees/dirty-leaked-wt\n" as any);
1315|    mockedExistsSync.mockImplementation((p) => {
1316|      const value = String(p);
1317|      return value === "/root/.worktrees" || value === "/root/.worktrees/dirty-leaked-wt/.git";
1318|    });
1319|
1320|    const removed = await reapOrphanWorktrees("/root");
1321|
1322|    expect(removed).toBe(0);
1323|    expect(mockedUnlinkSync).not.toHaveBeenCalled();
1324|    expect(mockedRmdirSync).not.toHaveBeenCalled();
1325|  });
1326|
1327|  it("skips a dir with a valid .git pointer (admin gitdir exists)", async () => {
1328|    mockedReaddirSync.mockReturnValue([makeDirEntry("live-wt")] as any);
1329|    mockedLstatSync.mockImplementation((p: any) =>
1330|      (String(p).endsWith("/.git")
1331|        ? { isDirectory: () => false, isSymbolicLink: () => false }
1332|        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
1333|    );
1334|    mockedReadFileSync.mockReturnValue("gitdir: /root/.git/worktrees/live-wt\n" as any);
1335|    mockedExistsSync.mockImplementation((p) => {
1336|      const s = String(p);
1337|      // The gitdir target exists too → treat as (maybe) registered, leave it alone.
1338|      return s === "/root/.worktrees" || s === "/root/.worktrees/live-wt/.git" || s === "/root/.git/worktrees/live-wt";
1339|    });
1340|
1341|    const removed = await reapOrphanWorktrees("/root");
1342|
1343|    expect(removed).toBe(0);
1344|    expect(mockedRmdirSync).not.toHaveBeenCalledWith("/root/.worktrees/live-wt");
1345|  });
1346|
1347|  it("does NOT reap a dir whose .git is unparseable (conservative — only confirmed-dangling pointers)", async () => {
1348|    // A transient read error or a garbage .git (no `gitdir:` line) must not be treated as
1349|    // dangling — reaping on uncertainty could delete a genuinely-live worktree.
1350|    mockedReaddirSync.mockReturnValue([makeDirEntry("maybe-wt")] as any);
1351|    mockedLstatSync.mockImplementation((p: any) =>
1352|      (String(p).endsWith("/.git")
1353|        ? { isDirectory: () => false, isSymbolicLink: () => false }
1354|        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
1355|    );
1356|    mockedReadFileSync.mockReturnValue("not a gitdir pointer at all\n" as any);
1357|    mockedExistsSync.mockImplementation((p) => {
1358|      const s = String(p);
1359|      return s === "/root/.worktrees" || s === "/root/.worktrees/maybe-wt/.git";
1360|    });
1361|
1362|    const removed = await reapOrphanWorktrees("/root");
1363|
1364|    expect(removed).toBe(0);
1365|    expect(mockedRmdirSync).not.toHaveBeenCalledWith("/root/.worktrees/maybe-wt");
1366|  });
1367|});
1368|
1369|