1|import { describe, it, expect, vi, beforeEach } from "vitest";
2|import {
3|  ActiveSessionWorktreeRemovalError,
4|  NativeWorktreeBackend,
5|  WorktrunkOperationError,
6|  WorktrunkWorktreeBackend,
7|  removeWorktree,
8|  resolveWorktreeBackend,
9|  RemovalReason,
10|} from "../worktree/worktree-backend.js";
11|import { activeSessionRegistry } from "../agents/active-session-registry.js";
12|
13|const {
14|  execMock,
15|  accessMock,
16|  rmMock,
17|  existsSyncMock,
18|  parseIndexLockPathMock,
19|  classifyStaleLockMock,
20|  tryRemoveStaleLockMock,
21|  parseStaleRegistrationPathMock,
22|  recoverStaleRegistrationMock,
23|  installGuardMock,
24|  pruneWorktreeAdminEntriesMock,
25|} = vi.hoisted(() => {
26|  const mock = vi.fn();
27|  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
28|  return {
29|    execMock: mock,
30|    accessMock: vi.fn(),
31|    rmMock: vi.fn(),
32|    existsSyncMock: vi.fn(),
33|    parseIndexLockPathMock: vi.fn(),
34|    classifyStaleLockMock: vi.fn(),
35|    tryRemoveStaleLockMock: vi.fn(),
36|    parseStaleRegistrationPathMock: vi.fn(),
37|    recoverStaleRegistrationMock: vi.fn(),
38|    installGuardMock: vi.fn(),
39|    pruneWorktreeAdminEntriesMock: vi.fn(),
40|  };
41|});
42|
43|vi.mock("node:child_process", () => ({ exec: execMock, execFile: vi.fn() }));
44|vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
45|vi.mock("node:fs/promises", () => ({ access: accessMock, rm: rmMock }));
46|vi.mock("../execution/branch-conflicts.js", () => ({
47|  inspectBranchConflict: vi.fn().mockResolvedValue({ kind: "stale" }),
48|}));
49|vi.mock("../worktree/worktree-hooks.js", () => ({
50|  installTaskWorktreeIdentityGuard: installGuardMock,
51|  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
52|}));
53|vi.mock("../worktree/worktree-stale-lock.js", () => ({
54|  StaleWorktreeIndexLockError: class StaleWorktreeIndexLockError extends Error {
55|    lockPath: string;
56|    classification: string;
57|    reason: string;
58|    constructor(input: { message: string; lockPath: string; classification: string; reason: string }) {
59|      super(input.message);
60|      this.name = "StaleWorktreeIndexLockError";
61|      this.lockPath = input.lockPath;
62|      this.classification = input.classification;
63|      this.reason = input.reason;
64|    }
65|  },
66|  parseIndexLockPath: parseIndexLockPathMock,
67|  classifyStaleLock: classifyStaleLockMock,
68|  tryRemoveStaleLock: tryRemoveStaleLockMock,
69|}));
70|vi.mock("../worktree/worktree-stale-registration.js", () => ({
71|  parseStaleRegistrationPath: parseStaleRegistrationPathMock,
72|  recoverStaleRegistration: recoverStaleRegistrationMock,
73|}));
74|vi.mock("../worktree/worktree-prune.js", () => ({
75|  pruneWorktreeAdminEntries: pruneWorktreeAdminEntriesMock,
76|}));
77|
78|beforeEach(() => {
79|  execMock.mockReset();
80|  accessMock.mockReset();
81|  rmMock.mockReset();
82|  rmMock.mockResolvedValue(undefined as never);
83|  existsSyncMock.mockReset();
84|  accessMock.mockResolvedValue(undefined);
85|  existsSyncMock.mockReturnValue(true);
86|  parseIndexLockPathMock.mockReset();
87|  classifyStaleLockMock.mockReset();
88|  tryRemoveStaleLockMock.mockReset();
89|  installGuardMock.mockReset();
90|  installGuardMock.mockResolvedValue(undefined);
91|  pruneWorktreeAdminEntriesMock.mockReset();
92|  pruneWorktreeAdminEntriesMock.mockResolvedValue(undefined);
93|  parseIndexLockPathMock.mockReturnValue(null);
94|  parseStaleRegistrationPathMock.mockReset();
95|  parseStaleRegistrationPathMock.mockReturnValue(null);
96|  recoverStaleRegistrationMock.mockReset();
97|  recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune"] });
98|  classifyStaleLockMock.mockResolvedValue({ kind: "fresh", reason: "fresh" });
99|  tryRemoveStaleLockMock.mockResolvedValue({ removed: true });
100|  activeSessionRegistry.clear();
101|});
102|
103|describe("NativeWorktreeBackend", () => {
104|  it("creates worktree with expected command", async () => {
105|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
106|    const backend = new NativeWorktreeBackend();
107|
108|    const result = await backend.create({
109|      rootDir: "/repo",
110|      worktreePath: "/repo/.worktrees/fn-1",
111|      branch: "fusion/fn-1",
112|      startPoint: "main",
113|      taskId: "FN-1",
114|    });
115|
116|    expect(result).toEqual({ path: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });
117|    expect(execMock).toHaveBeenCalledWith(
118|      'git worktree add -b "fusion/fn-1" "/repo/.worktrees/fn-1" "main"',
119|      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
120|    );
121|    expect(installGuardMock).toHaveBeenCalledWith({ worktreePath: "/repo/.worktrees/fn-1", taskId: "FN-1" });
122|  });
123|
124|  it("propagates installer failure after cleanup", async () => {
125|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
126|    installGuardMock.mockRejectedValueOnce(new Error("guard failed"));
127|
128|    await expect(
129|      new NativeWorktreeBackend().create({
130|        rootDir: "/repo",
131|        worktreePath: "/repo/.worktrees/fn-1",
132|        branch: "fusion/fn-1",
133|        taskId: "FN-1",
134|      }),
135|    ).rejects.toThrow("guard failed");
136|
137|    expect(rmMock).toHaveBeenCalledWith("/repo/.worktrees/fn-1", { recursive: true, force: true });
138|  });
139|
140|  it("retries with suffix and resolves", async () => {
141|    execMock.mockRejectedValueOnce(new Error("exists")).mockResolvedValueOnce({ stdout: "", stderr: "" });
142|
143|    const result = await new NativeWorktreeBackend().create({
144|      rootDir: "/repo",
145|      worktreePath: "/repo/.worktrees/fn-1",
146|      branch: "fusion/fn-1",
147|      taskId: "FN-1",
148|      allowSiblingBranchRename: true,
149|    });
150|
151|    expect(result.branch).toBe("fusion/fn-1-2");
152|    expect(execMock).toHaveBeenNthCalledWith(
153|      2,
154|      'git worktree add -b "fusion/fn-1-2" "/repo/.worktrees/fn-1"',
155|      expect.any(Object),
156|    );
157|  });
158|
159|  it("removes worktree with expected command", async () => {
160|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
161|
162|    await new NativeWorktreeBackend().remove({
163|      rootDir: "/repo",
164|      worktreePath: "/repo/.worktrees/fn-1",
165|    });
166|
167|    expect(execMock).toHaveBeenCalledWith(
168|      'git worktree remove --force "/repo/.worktrees/fn-1"',
169|      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
170|    );
171|    expect(rmMock).not.toHaveBeenCalled();
172|    expect(pruneWorktreeAdminEntriesMock).not.toHaveBeenCalled();
173|  });
174|
175|  it("prunes a missing path when non-force removal fails", async () => {
176|    const error = { message: "fatal: is not a working tree", stderr: "fatal: is not a working tree" };
177|    existsSyncMock.mockReturnValue(false);
178|    execMock.mockRejectedValueOnce(error);
179|
180|    await new NativeWorktreeBackend().remove({
181|      rootDir: "/repo",
182|      worktreePath: "/repo/.worktrees/fn-missing",
183|      force: false,
184|    });
185|
186|    expect(rmMock).not.toHaveBeenCalled();
187|    expect(pruneWorktreeAdminEntriesMock).toHaveBeenCalledWith(
188|      expect.objectContaining({
189|        rootDir: "/repo",
190|        reason: "remove-missing-fallback",
191|        target: "/repo/.worktrees/fn-missing",
192|      }),
193|    );
194|  });
195|
196|  it("falls back to filesystem removal and prunes admin entries when native remove leaves a non-empty directory", async () => {
197|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
198|    execMock.mockRejectedValueOnce({
199|      message: "Command failed: git worktree remove --force /repo/.worktrees/fn-1",
200|      stderr: "error: failed to delete '/repo/.worktrees/fn-1': Directory not empty",
201|    });
202|
203|    await new NativeWorktreeBackend({ audit }).remove({
204|      rootDir: "/repo",
205|      worktreePath: "/repo/.worktrees/fn-1",
206|    });
207|
208|    expect(rmMock).toHaveBeenCalledWith("/repo/.worktrees/fn-1", { recursive: true, force: true });
209|    expect(pruneWorktreeAdminEntriesMock).toHaveBeenCalledWith({
210|      rootDir: "/repo",
211|      auditor: audit,
212|      reason: "remove-non-empty-fallback",
213|      target: "/repo/.worktrees/fn-1",
214|      logger: undefined,
215|    });
216|    expect(audit.git).toHaveBeenCalledWith({
217|      type: "worktree:remove-fallback",
218|      target: "/repo/.worktrees/fn-1",
219|      metadata: expect.objectContaining({ fallback: "filesystem-non-empty", error: expect.stringContaining("Directory not empty") }),
220|    });
221|  });
222|
223|  it("falls back for modified or untracked file native remove failures", async () => {
224|    execMock.mockRejectedValueOnce({
225|      message: "fatal: '/repo/.worktrees/fn-1' contains modified or untracked files, use --force to delete it",
226|      stderr: "",
227|    });
228|
229|    await new NativeWorktreeBackend().remove({
230|      rootDir: "/repo",
231|      worktreePath: "/repo/.worktrees/fn-1",
232|    });
233|
234|    expect(rmMock).toHaveBeenCalledWith("/repo/.worktrees/fn-1", { recursive: true, force: true });
235|    expect(pruneWorktreeAdminEntriesMock).toHaveBeenCalledWith(
236|      expect.objectContaining({ rootDir: "/repo", reason: "remove-non-empty-fallback", target: "/repo/.worktrees/fn-1" }),
237|    );
238|  });
239|
240|  it("falls back for failed-to-delete native remove failures without a directory-not-empty suffix", async () => {
241|    execMock.mockRejectedValueOnce({
242|      message: "Command failed: git worktree remove --force /repo/.worktrees/fn-1",
243|      stderr: "error: failed to delete '/repo/.worktrees/fn-1'",
244|    });
245|
246|    await new NativeWorktreeBackend().remove({
247|      rootDir: "/repo",
248|      worktreePath: "/repo/.worktrees/fn-1",
249|    });
250|
251|    expect(rmMock).toHaveBeenCalledWith("/repo/.worktrees/fn-1", { recursive: true, force: true });
252|    expect(pruneWorktreeAdminEntriesMock).toHaveBeenCalledWith(
253|      expect.objectContaining({ rootDir: "/repo", reason: "remove-non-empty-fallback", target: "/repo/.worktrees/fn-1" }),
254|    );
255|  });
256|
257|  it("rethrows non-recoverable native remove failures without filesystem fallback", async () => {
258|    const error = { message: "fatal: not a git repository", stderr: "fatal: not a git repository" };
259|    execMock.mockRejectedValueOnce(error);
260|
261|    await expect(
262|      new NativeWorktreeBackend().remove({
263|        rootDir: "/repo",
264|        worktreePath: "/repo/.worktrees/fn-1",
265|      }),
266|    ).rejects.toBe(error);
267|
268|    expect(rmMock).not.toHaveBeenCalled();
269|    expect(pruneWorktreeAdminEntriesMock).not.toHaveBeenCalled();
270|  });
271|
272|  it("rethrows filesystem removal failure after recoverable native remove failure", async () => {
273|    const rmError = new Error("EACCES: permission denied");
274|    execMock.mockRejectedValueOnce({ stderr: "error: failed to delete '/repo/.worktrees/fn-1': Directory not empty" });
275|    rmMock.mockRejectedValueOnce(rmError as never);
276|
277|    await expect(
278|      new NativeWorktreeBackend().remove({
279|        rootDir: "/repo",
280|        worktreePath: "/repo/.worktrees/fn-1",
281|      }),
282|    ).rejects.toBe(rmError);
283|
284|    expect(pruneWorktreeAdminEntriesMock).not.toHaveBeenCalled();
285|  });
286|
287|  it("syncs by fetching then rebasing", async () => {
288|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
289|
290|    const result = await new NativeWorktreeBackend().sync({
291|      rootDir: "/repo",
292|      worktreePath: "/repo/.worktrees/fn-1",
293|      branch: "main",
294|    });
295|
296|    expect(result).toEqual({ skipped: false });
297|    expect(execMock).toHaveBeenNthCalledWith(
298|      1,
299|      "git fetch --all --prune",
300|      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 120000, maxBuffer: 10485760 }),
301|    );
302|    expect(execMock).toHaveBeenNthCalledWith(
303|      2,
304|      'git rebase "origin/main"',
305|      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 120000, maxBuffer: 10485760 }),
306|    );
307|  });
308|
309|  it("prunes worktrees with expected command", async () => {
310|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
311|
312|    await new NativeWorktreeBackend().prune({ rootDir: "/repo" });
313|
314|    expect(execMock).toHaveBeenCalledWith(
315|      "git worktree prune",
316|      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
317|    );
318|  });
319|
320|  it("resolves stale index.lock and retries create once", async () => {
321|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
322|    parseIndexLockPathMock.mockReturnValue("/repo/.git/worktrees/fn-1/index.lock");
323|    classifyStaleLockMock.mockResolvedValue({ kind: "stale", reason: "old-lock", ageMs: 60000 });
324|    tryRemoveStaleLockMock.mockResolvedValue({ removed: true });
325|    execMock
326|      .mockRejectedValueOnce({ message: "fatal", stderr: "fatal: unable to create '/repo/.git/worktrees/fn-1/index.lock': File exists" })
327|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
328|
329|    const result = await new NativeWorktreeBackend({ audit }).create({
330|      rootDir: "/repo",
331|      worktreePath: "/repo/.worktrees/fn-1",
332|      branch: "fusion/fn-1",
333|      taskId: "FN-1",
334|    });
335|
336|    expect(result).toEqual({ path: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });
337|    expect(tryRemoveStaleLockMock).toHaveBeenCalledWith({ lockPath: "/repo/.git/worktrees/fn-1/index.lock" });
338|    expect(audit.git).toHaveBeenNthCalledWith(
339|      1,
340|      expect.objectContaining({ type: "worktree:stale-lock-detected" }),
341|    );
342|    expect(audit.git).toHaveBeenNthCalledWith(
343|      2,
344|      expect.objectContaining({ type: "worktree:stale-lock-recovered" }),
345|    );
346|  });
347|
348|  it("throws StaleWorktreeIndexLockError when lock is non-stale", async () => {
349|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
350|    parseIndexLockPathMock.mockReturnValue("/repo/.git/worktrees/fn-1/index.lock");
351|    classifyStaleLockMock.mockResolvedValue({ kind: "fresh", reason: "lock-younger-than-threshold", ageMs: 1000 });
352|    execMock.mockRejectedValueOnce({
353|      message: "fatal",
354|      stderr: "fatal: unable to create '/repo/.git/worktrees/fn-1/index.lock': File exists",
355|    });
356|
357|    await expect(
358|      new NativeWorktreeBackend({ audit }).create({
359|        rootDir: "/repo",
360|        worktreePath: "/repo/.worktrees/fn-1",
361|        branch: "fusion/fn-1",
362|        taskId: "FN-1",
363|      }),
364|    ).rejects.toMatchObject({ name: "StaleWorktreeIndexLockError" });
365|
366|    expect(tryRemoveStaleLockMock).not.toHaveBeenCalled();
367|    expect(audit.git).toHaveBeenNthCalledWith(
368|      1,
369|      expect.objectContaining({ type: "worktree:stale-lock-detected" }),
370|    );
371|    expect(audit.git).toHaveBeenNthCalledWith(
372|      2,
373|      expect.objectContaining({ type: "worktree:stale-lock-refused" }),
374|    );
375|  });
376|
377|  it("recovers stale registration and retries add", async () => {
378|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
379|    const stalePath = "/repo/.worktrees/fn-1";
380|    parseStaleRegistrationPathMock
381|      .mockReturnValueOnce(stalePath)
382|      .mockReturnValueOnce(null);
383|    recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune", "remove-force"] });
384|    execMock
385|      .mockRejectedValueOnce({ message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` })
386|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
387|
388|    const result = await new NativeWorktreeBackend({ audit }).create({
389|      rootDir: "/repo",
390|      worktreePath: stalePath,
391|      branch: "fusion/fn-1",
392|      taskId: "FN-1",
393|    });
394|
395|    expect(result).toEqual({ path: stalePath, branch: "fusion/fn-1" });
396|    expect(recoverStaleRegistrationMock).toHaveBeenCalledWith({
397|      rootDir: "/repo",
398|      worktreePath: stalePath,
399|      logger: undefined,
400|    });
401|    expect(audit.git).toHaveBeenNthCalledWith(
402|      1,
403|      expect.objectContaining({ type: "worktree:stale-registration-detected" }),
404|    );
405|    expect(audit.git).toHaveBeenNthCalledWith(
406|      2,
407|      expect.objectContaining({ type: "worktree:stale-registration-recovered", metadata: { actions: ["prune", "remove-force"] } }),
408|    );
409|    expect(installGuardMock).toHaveBeenCalledTimes(1);
410|  });
411|
412|  it("uses add -f retry when stale registration persists", async () => {
413|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
414|    const stalePath = "/repo/.worktrees/fn-1";
415|    parseStaleRegistrationPathMock.mockReturnValue(stalePath);
416|    recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune"] });
417|    execMock
418|      .mockRejectedValueOnce({ message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` })
419|      .mockRejectedValueOnce({ message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` })
420|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
421|
422|    const result = await new NativeWorktreeBackend({ audit }).create({
423|      rootDir: "/repo",
424|      worktreePath: stalePath,
425|      branch: "fusion/fn-1",
426|      taskId: "FN-1",
427|    });
428|
429|    expect(result).toEqual({ path: stalePath, branch: "fusion/fn-1" });
430|    expect(execMock).toHaveBeenNthCalledWith(
431|      3,
432|      'git worktree add -f "/repo/.worktrees/fn-1" "fusion/fn-1"',
433|      expect.any(Object),
434|    );
435|    expect(audit.git).toHaveBeenNthCalledWith(
436|      2,
437|      expect.objectContaining({
438|        type: "worktree:stale-registration-recovered",
439|        metadata: { actions: ["prune", "add-force-retry"] },
440|      }),
441|    );
442|  });
443|
444|  it("emits recovery failed and throws when add -f also fails", async () => {
445|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
446|    const stalePath = "/repo/.worktrees/fn-1";
447|    parseStaleRegistrationPathMock.mockReturnValue(stalePath);
448|    recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune"] });
449|    const staleError = { message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` };
450|    execMock.mockRejectedValueOnce(staleError).mockRejectedValueOnce(staleError).mockRejectedValueOnce(staleError);
451|
452|    await expect(
453|      new NativeWorktreeBackend({ audit }).create({
454|        rootDir: "/repo",
455|        worktreePath: stalePath,
456|        branch: "fusion/fn-1",
457|        taskId: "FN-1",
458|      }),
459|    ).rejects.toMatchObject({ stderr: expect.stringContaining("missing but already registered worktree") });
460|
461|    expect(audit.git).toHaveBeenLastCalledWith(
462|      expect.objectContaining({ type: "worktree:stale-registration-recovery-failed" }),
463|    );
464|  });
465|
466|  it("does not emit stale-registration events on healthy create", async () => {
467|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
468|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
469|
470|    await new NativeWorktreeBackend({ audit }).create({
471|      rootDir: "/repo",
472|      worktreePath: "/repo/.worktrees/fn-1",
473|      branch: "fusion/fn-1",
474|      taskId: "FN-1",
475|    });
476|
477|    expect(recoverStaleRegistrationMock).not.toHaveBeenCalled();
478|    expect(audit.git).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^worktree:stale-registration-/) }));
479|  });
480|
481|  it("prefers stale-lock recovery when both stale-lock and stale-registration signatures appear", async () => {
482|    const audit = { git: vi.fn().mockResolvedValue(undefined) };
483|    parseIndexLockPathMock.mockReturnValue("/repo/.git/worktrees/fn-1/index.lock");
484|    classifyStaleLockMock.mockResolvedValue({ kind: "stale", reason: "old-lock", ageMs: 60000 });
485|    tryRemoveStaleLockMock.mockResolvedValue({ removed: true });
486|    parseStaleRegistrationPathMock.mockReturnValue("/repo/.worktrees/fn-1");
487|    execMock
488|      .mockRejectedValueOnce({
489|        message: "fatal",
490|        stderr:
491|          "fatal: unable to create '/repo/.git/worktrees/fn-1/index.lock': File exists\nfatal: '/repo/.worktrees/fn-1' is a missing but already registered worktree",
492|      })
493|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
494|
495|    await new NativeWorktreeBackend({ audit }).create({
496|      rootDir: "/repo",
497|      worktreePath: "/repo/.worktrees/fn-1",
498|      branch: "fusion/fn-1",
499|      taskId: "FN-1",
500|    });
501|
502|    expect(tryRemoveStaleLockMock).toHaveBeenCalledTimes(1);
503|    expect(recoverStaleRegistrationMock).not.toHaveBeenCalled();
504|    expect(audit.git).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "worktree:stale-lock-detected" }));
505|  });
506|
507|  it("resolves native worktree path via configured worktreesDir", async () => {
508|    const backend = new NativeWorktreeBackend({ settings: { worktreesDir: "../{repo}.worktrees" } as any });
509|    await expect(
510|      backend.resolveWorktreePath({ rootDir: "/repo/project", worktreeName: "fn-1", branch: "fusion/fn-1" }),
511|    ).resolves.toBe("/repo/project.worktrees/fn-1");
512|  });
513|});
514|
515|describe("WorktrunkWorktreeBackend", () => {
516|  it("throws missing binary error", async () => {
517|    const backend = new WorktrunkWorktreeBackend({ binaryPath: null });
518|
519|    await expect(
520|      backend.create({
521|        rootDir: "/repo",
522|        worktreePath: "/repo/.worktrees/fn-1",
523|        branch: "fusion/fn-1",
524|        taskId: "FN-1",
525|      }),
526|    ).rejects.toMatchObject({
527|      name: "WorktrunkOperationError",
528|      code: "worktrunk_binary_missing",
529|      operation: "create",
530|      stderr: "worktrunk binary not configured",
531|      exitCode: null,
532|    });
533|  });
534|
535|  it("memoizes successful binary path resolver results", async () => {
536|    const binaryPathResolver = vi.fn().mockResolvedValue("/p");
537|    execMock
538|      .mockResolvedValueOnce({ stdout: "", stderr: "" })
539|      .mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/fn-1\nbranch refs/heads/fusion/fn-1\n", stderr: "" })
540|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
541|    const backend = new WorktrunkWorktreeBackend({ binaryPath: binaryPathResolver });
542|
543|    await backend.create({
544|      rootDir: "/repo",
545|      worktreePath: "/repo/.worktrees/fn-1",
546|      branch: "fusion/fn-1",
547|      taskId: "FN-1",
548|    });
549|    await backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });
550|
551|    expect(binaryPathResolver).toHaveBeenCalledTimes(1);
552|    expect(execMock).toHaveBeenNthCalledWith(
553|      1,
554|      '"/p" "switch" "--create" "fusion/fn-1" "--no-hooks" "--no-cd"',
555|      expect.objectContaining({ cwd: "/repo" }),
556|    );
557|    expect(execMock).toHaveBeenNthCalledWith(
558|      3,
559|      '"/p" "remove" "--foreground" "fusion/fn-1"',
560|      expect.objectContaining({ cwd: "/repo" }),
561|    );
562|  });
563|
564|  it("does not negative-cache null resolver results", async () => {
565|    const binaryPathResolver = vi.fn().mockResolvedValue(null);
566|    const backend = new WorktrunkWorktreeBackend({ binaryPath: binaryPathResolver });
567|
568|    await expect(
569|      backend.create({
570|        rootDir: "/repo",
571|        worktreePath: "/repo/.worktrees/fn-1",
572|        branch: "fusion/fn-1",
573|        taskId: "FN-1",
574|      }),
575|    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "create" });
576|
577|    await expect(
578|      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
579|    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "remove" });
580|
581|    expect(binaryPathResolver).toHaveBeenCalledTimes(2);
582|  });
583|
584|  it("propagates WorktrunkOperationError thrown by resolver", async () => {
585|    const resolverError = new WorktrunkOperationError({
586|      operation: "remove",
587|      code: "worktrunk_timeout",
588|      stderr: "timed out",
589|      exitCode: null,
590|    });
591|    const binaryPathResolver = vi.fn().mockRejectedValue(resolverError);
592|    const backend = new WorktrunkWorktreeBackend({ binaryPath: binaryPathResolver });
593|
594|    await expect(
595|      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
596|    ).rejects.toBe(resolverError);
597|  });
598|
599|  it("throws operation failed with stderr/exitCode", async () => {
600|    execMock.mockRejectedValue({ stderr: "bad news", status: 7 });
601|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
602|
603|    await expect(
604|      backend.create({
605|        rootDir: "/repo",
606|        worktreePath: "/repo/.worktrees/fn-1",
607|        branch: "fusion/fn-1",
608|        taskId: "FN-1",
609|      }),
610|    ).rejects.toMatchObject({ code: "worktrunk_operation_failed", stderr: "bad news", exitCode: 7 });
611|  });
612|
613|  it("invokes create mapping with timeout/maxBuffer and cwd", async () => {
614|    execMock
615|      .mockResolvedValueOnce({ stdout: "", stderr: "" })
616|      .mockResolvedValueOnce({
617|        stdout: "worktree /repo/.worktrees/fusion/fn-1\nbranch refs/heads/fusion/fn-1\n",
618|        stderr: "",
619|      });
620|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
621|
622|    await backend.create({
623|      rootDir: "/repo",
624|      worktreePath: "/repo/.worktrees/fn-1",
625|      branch: "fusion/fn-1",
626|      startPoint: "main",
627|      taskId: "FN-1",
628|    });
629|
630|    expect(execMock).toHaveBeenNthCalledWith(
631|      1,
632|      '"worktrunk" "switch" "--create" "fusion/fn-1" "--no-hooks" "--no-cd" "--base" "main"',
633|      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
634|    );
635|  });
636|
637|  describe("create() — path resolution", () => {
638|    it("returns porcelain-resolved path and warns on drift", async () => {
639|      const logger = { log: vi.fn(), warn: vi.fn() };
640|      execMock
641|        .mockResolvedValueOnce({ stdout: "", stderr: "" })
642|        .mockResolvedValueOnce({
643|          stdout:
644|            "worktree /repo/.worktrees/custom/fusion-fn-1\nbranch refs/heads/fusion/fn-1\n\nworktree /repo\nbranch refs/heads/main\n",
645|          stderr: "",
646|        });
647|      existsSyncMock.mockImplementation((path: string) => path === "/repo/.worktrees/custom/fusion-fn-1");
648|
649|      const result = await new WorktrunkWorktreeBackend({ binaryPath: "worktrunk", logger }).create({
650|        rootDir: "/repo",
651|        worktreePath: "/repo/.worktrees/fn-1",
652|        branch: "fusion/fn-1",
653|        taskId: "FN-1",
654|      });
655|
656|      expect(result).toEqual({ path: "/repo/.worktrees/custom/fusion-fn-1", branch: "fusion/fn-1" });
657|      expect(logger.warn).toHaveBeenCalledTimes(1);
658|      expect(logger.warn).toHaveBeenCalledWith(
659|        "[worktree-backend] worktrunk created branch fusion/fn-1 at /repo/.worktrees/custom/fusion-fn-1 (fusion assumed /repo/.worktrees/fn-1); using worktrunk-assigned path",
660|      );
661|    });
662|
663|    it("fails when no branch match exists", async () => {
664|      execMock
665|        .mockResolvedValueOnce({ stdout: "", stderr: "" })
666|        .mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/other\nbranch refs/heads/other\n", stderr: "" });
667|
668|      await expect(
669|        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
670|          rootDir: "/repo",
671|          worktreePath: "/repo/.worktrees/fn-1",
672|          branch: "fusion/fn-1",
673|          taskId: "FN-1",
674|        }),
675|      ).rejects.toMatchObject({
676|        name: "WorktrunkOperationError",
677|        code: "worktrunk_operation_failed",
678|        stderr: expect.stringContaining("fusion/fn-1"),
679|      });
680|    });
681|
682|    it("fails when multiple branch matches exist", async () => {
683|      execMock
684|        .mockResolvedValueOnce({ stdout: "", stderr: "" })
685|        .mockResolvedValueOnce({
686|          stdout:
687|            "worktree /repo/.worktrees/a\nbranch refs/heads/fusion/fn-1\n\nworktree /repo/.worktrees/b\nbranch refs/heads/fusion/fn-1\n",
688|          stderr: "",
689|        });
690|
691|      await expect(
692|        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
693|          rootDir: "/repo",
694|          worktreePath: "/repo/.worktrees/fn-1",
695|          branch: "fusion/fn-1",
696|          taskId: "FN-1",
697|        }),
698|      ).rejects.toMatchObject({
699|        name: "WorktrunkOperationError",
700|        code: "worktrunk_operation_failed",
701|        stderr: expect.stringContaining("/repo/.worktrees/a, /repo/.worktrees/b"),
702|      });
703|    });
704|
705|    it("fails when resolved path does not exist on disk", async () => {
706|      existsSyncMock.mockReturnValue(false);
707|      execMock
708|        .mockResolvedValueOnce({ stdout: "", stderr: "" })
709|        .mockResolvedValueOnce({
710|          stdout: "worktree /repo/.worktrees/missing\nbranch refs/heads/fusion/fn-1\n",
711|          stderr: "",
712|        });
713|
714|      await expect(
715|        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
716|          rootDir: "/repo",
717|          worktreePath: "/repo/.worktrees/fn-1",
718|          branch: "fusion/fn-1",
719|          taskId: "FN-1",
720|        }),
721|      ).rejects.toMatchObject({
722|        name: "WorktrunkOperationError",
723|        code: "worktrunk_operation_failed",
724|        stderr: "worktrunk reported worktree at /repo/.worktrees/missing but the path does not exist",
725|      });
726|    });
727|
728|    it("wraps porcelain command failures as worktrunk operation errors", async () => {
729|      execMock
730|        .mockResolvedValueOnce({ stdout: "", stderr: "" })
731|        .mockRejectedValueOnce({ stderr: "porcelain failed", status: 2 });
732|
733|      await expect(
734|        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
735|          rootDir: "/repo",
736|          worktreePath: "/repo/.worktrees/fn-1",
737|          branch: "fusion/fn-1",
738|          taskId: "FN-1",
739|        }),
740|      ).rejects.toMatchObject({
741|        name: "WorktrunkOperationError",
742|        code: "worktrunk_operation_failed",
743|        stderr: "porcelain failed",
744|        exitCode: 2,
745|      });
746|    });
747|  });
748|
749|  it("invokes remove mapping", async () => {
750|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
751|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
752|
753|    await backend.remove({
754|      rootDir: "/repo",
755|      worktreePath: "/repo/.worktrees/fn-1",
756|      branch: "fusion/fn-1",
757|    });
758|
759|    expect(execMock).toHaveBeenCalledWith(
760|      '"worktrunk" "remove" "--foreground" "fusion/fn-1"',
761|      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
762|    );
763|  });
764|
765|  it("treats remove not-found style failures as idempotent success", async () => {
766|    execMock.mockRejectedValue({ stderr: "branch not found", status: 1 });
767|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
768|
769|    await expect(
770|      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
771|    ).resolves.toBeUndefined();
772|  });
773|
774|  it("maps ENOENT to worktrunk_binary_missing", async () => {
775|    execMock.mockRejectedValue({ code: "ENOENT", stderr: "not found" });
776|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
777|
778|    await expect(
779|      backend.create({
780|        rootDir: "/repo",
781|        worktreePath: "/repo/.worktrees/fn-1",
782|        branch: "fusion/fn-1",
783|        taskId: "FN-1",
784|      }),
785|    ).rejects.toMatchObject({ code: "worktrunk_binary_missing" });
786|  });
787|
788|  it("maps SIGTERM timeout to worktrunk_timeout", async () => {
789|    execMock.mockRejectedValue({ signal: "SIGTERM", stderr: "timed out" });
790|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
791|
792|    await expect(
793|      backend.create({
794|        rootDir: "/repo",
795|        worktreePath: "/repo/.worktrees/fn-1",
796|        branch: "fusion/fn-1",
797|        taskId: "FN-1",
798|      }),
799|    ).rejects.toMatchObject({ code: "worktrunk_timeout" });
800|  });
801|
802|  it("syncs by fetching then rebasing resolved integration branch", async () => {
803|    execMock.mockResolvedValue({ stdout: "origin/main\n", stderr: "" });
804|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
805|
806|    await expect(
807|      backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "main" }),
808|    ).resolves.toEqual({ skipped: false });
809|
810|    expect(execMock).toHaveBeenNthCalledWith(
811|      1,
812|      "git symbolic-ref --short refs/remotes/origin/HEAD",
813|      expect.objectContaining({ cwd: "/repo", timeout: 5000, maxBuffer: 1048576 }),
814|    );
815|    expect(execMock).toHaveBeenNthCalledWith(
816|      2,
817|      'git fetch origin "main"',
818|      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 180000, maxBuffer: 10485760 }),
819|    );
820|    expect(execMock).toHaveBeenNthCalledWith(
821|      3,
822|      'git rebase "main"',
823|      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 180000, maxBuffer: 10485760 }),
824|    );
825|  });
826|
827|  it("sync supports explicit trunk target", async () => {
828|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
829|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
830|
831|    await backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1", trunk: "release" });
832|    expect(execMock).toHaveBeenNthCalledWith(
833|      1,
834|      'git fetch origin "release"',
835|      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1" }),
836|    );
837|    expect(execMock).toHaveBeenNthCalledWith(
838|      2,
839|      'git rebase "release"',
840|      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1" }),
841|    );
842|  });
843|
844|  it("maps rebase conflicts to worktrunk_sync_conflict", async () => {
845|    // FN-7438 (aa8f1f32e): resolveIntegrationBranch now does symbolic-ref + `git remote`
846|    // before fetch+rebase when no trunk is given, which would consume this mock queue.
847|    // Pass an explicit trunk to isolate the rebase-conflict mapping path under test.
848|    execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockRejectedValueOnce({ stderr: "CONFLICT" });
849|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
850|
851|    await expect(
852|      backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "main", trunk: "main" }),
853|    ).rejects.toMatchObject({ code: "worktrunk_sync_conflict", operation: "sync" });
854|  });
855|
856|  it("resolves worktrunk path from wt config show template", async () => {
857|    execMock.mockResolvedValue({ stdout: '{"config":{"worktree-path":"{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"}}', stderr: "" });
858|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
859|
860|    await expect(
861|      backend.resolveWorktreePath({ rootDir: "/repo/project", worktreeName: "ignored", branch: "fusion/fn-1" }),
862|    ).resolves.toBe("/repo/project.fusion-fn-1");
863|    expect(execMock).toHaveBeenCalledWith(
864|      '"worktrunk" "config" "show" "--format" "json"',
865|      expect.objectContaining({ cwd: "/repo/project", timeout: 5000, maxBuffer: 10485760 }),
866|    );
867|  });
868|
869|  it("falls back to default layout template when config cannot be read", async () => {
870|    execMock.mockRejectedValue(new Error("missing config"));
871|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
872|
873|    await expect(
874|      backend.resolveWorktreePath({ rootDir: "/repo/project", worktreeName: "ignored", branch: "fusion/fn-1" }),
875|    ).resolves.toBe("/repo/project/.worktrees/fusion-fn-1");
876|  });
877|
878|  it("prunes by listing worktrees and removing worktrunk managed entries", async () => {
879|    execMock
880|      .mockResolvedValueOnce({
881|        stdout:
882|          "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.worktrees/fusion-fn-1\nbranch refs/heads/fusion/fn-1\n\n",
883|        stderr: "",
884|      })
885|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
886|    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });
887|
888|    await expect(backend.prune({ rootDir: "/repo" })).resolves.toBeUndefined();
889|    expect(execMock).toHaveBeenNthCalledWith(
890|      1,
891|      "git worktree list --porcelain",
892|      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
893|    );
894|    expect(execMock).toHaveBeenNthCalledWith(
895|      2,
896|      '"worktrunk" "remove" "--foreground" "fusion/fn-1"',
897|      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
898|    );
899|  });
900|});
901|
902|describe("WorktrunkOperationError", () => {
903|  it("preserves shape", () => {
904|    const error = new WorktrunkOperationError({
905|      operation: "create",
906|      code: "worktrunk_operation_failed",
907|      stderr: "stderr",
908|      exitCode: 2,
909|    });
910|    expect(error.name).toBe("WorktrunkOperationError");
911|    expect(error.operation).toBe("create");
912|    expect(error.code).toBe("worktrunk_operation_failed");
913|    expect(error.stderr).toBe("stderr");
914|    expect(error.exitCode).toBe(2);
915|  });
916|});
917|
918|describe("removeWorktree", () => {
919|  it("uses native remove and emits worktree:remove audit", async () => {
920|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
921|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
922|
923|    await removeWorktree({
924|      rootDir: "/repo",
925|      worktreePath: "/repo/.worktrees/fn-1",
926|      settings: {},
927|      audit,
928|      reason: RemovalReason.SelfHealingReclaim,
929|    });
930|
931|    expect(execMock).toHaveBeenCalledWith(
932|      'git worktree remove --force "/repo/.worktrees/fn-1"',
933|      expect.objectContaining({ cwd: "/repo", timeout: 60000 }),
934|    );
935|    expect(audit.git).toHaveBeenCalledWith({ type: "worktree:remove", target: "/repo/.worktrees/fn-1" });
936|  });
937|
938|  it("classifies FN-343 nonstandard temp merge worktree remove failures as harmless when porcelain is absent after prune", async () => {
939|    const tempPath = "/var/folders/demo/T/fusion-ai-merge-fn-327-A5uY3j";
940|    const validationError = {
941|      message: `Command failed: git worktree remove --force ${tempPath}`,
942|      stderr: `fatal: validation failed, cannot remove working tree: '${tempPath}/.git' is not a .git file, error code 2`,
943|      status: 2,
944|    };
945|    execMock
946|      .mockRejectedValueOnce(validationError)
947|      .mockResolvedValueOnce({ stdout: "", stderr: "" })
948|      .mockResolvedValueOnce({ stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "" });
949|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
950|
951|    // A real-git fixture for this exact macOS temp shape is git-version sensitive:
952|    // some versions prune the malformed admin entry before emitting the validation
953|    // string. Keep the classifier deterministic by simulating the exact FN-327
954|    // command stderr, then assert the porcelain proof that no registered worktree
955|    // remains for the temp path.
956|    await expect(
957|      removeWorktree({
958|        rootDir: "/repo",
959|        worktreePath: tempPath,
960|        settings: {},
961|        audit,
962|        taskId: "FN-327",
963|        reason: RemovalReason.MergerCleanup,
964|      }),
965|    ).resolves.toMatchObject({
966|      removed: false,
967|      harmless: true,
968|      classification: "not-registered-after-prune",
969|      message: expect.stringContaining("no registered worktree remains after prune"),
970|    });
971|
972|    expect(execMock).toHaveBeenNthCalledWith(
973|      2,
974|      "git worktree prune",
975|      expect.objectContaining({ cwd: "/repo" }),
976|    );
977|    expect(execMock).toHaveBeenNthCalledWith(
978|      3,
979|      "git worktree list --porcelain",
980|      expect.objectContaining({ cwd: "/repo" }),
981|    );
982|    expect(audit.git).toHaveBeenCalledWith(
983|      expect.objectContaining({
984|        type: "worktree:remove-classified-harmless",
985|        target: tempPath,
986|        metadata: expect.objectContaining({
987|          reason: RemovalReason.MergerCleanup,
988|          classification: "not-registered-after-prune",
989|          registeredAfterPrune: false,
990|          stderrPreview: expect.stringContaining("is not a .git file"),
991|        }),
992|      }),
993|    );
994|  });
995|
996|  it("does not downgrade non-temp merger cleanup failures even when porcelain would be absent", async () => {
997|    const worktreePath = "/repo/.worktrees/fn-327";
998|    const validationError = {
999|      message: `Command failed: git worktree remove --force ${worktreePath}`,
1000|      stderr: `fatal: validation failed, cannot remove working tree: '${worktreePath}/.git' is not a .git file, error code 2`,
1001|      status: 2,
1002|    };
1003|    execMock.mockRejectedValueOnce(validationError);
1004|
1005|    await expect(
1006|      removeWorktree({
1007|        rootDir: "/repo",
1008|        worktreePath,
1009|        settings: {},
1010|        taskId: "FN-327",
1011|        reason: RemovalReason.MergerCleanup,
1012|      }),
1013|    ).rejects.toBe(validationError);
1014|
1015|    expect(execMock).toHaveBeenCalledTimes(1);
1016|  });
1017|
1018|  it("keeps FN-343 remove failures visible when the temp path remains registered after prune", async () => {
1019|    const tempPath = "/var/folders/demo/T/fusion-ai-merge-fn-327-A5uY3j";
1020|    const validationError = {
1021|      message: `Command failed: git worktree remove --force ${tempPath}`,
1022|      stderr: `fatal: validation failed, cannot remove working tree: '${tempPath}/.git' is not a .git file, error code 2`,
1023|      status: 2,
1024|    };
1025|    execMock
1026|      .mockRejectedValueOnce(validationError)
1027|      .mockResolvedValueOnce({ stdout: "", stderr: "" })
1028|      .mockResolvedValueOnce({
1029|        stdout: `worktree /repo\nbranch refs/heads/main\n\nworktree ${tempPath}\nbranch refs/heads/fusion/fn-327\n`,
1030|        stderr: "",
1031|      });
1032|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
1033|
1034|    await expect(
1035|      removeWorktree({
1036|        rootDir: "/repo",
1037|        worktreePath: tempPath,
1038|        settings: {},
1039|        audit,
1040|        taskId: "FN-327",
1041|        reason: RemovalReason.MergerCleanup,
1042|      }),
1043|    ).rejects.toMatchObject({ stderr: expect.stringContaining("is not a .git file") });
1044|
1045|    expect(execMock).toHaveBeenNthCalledWith(2, "git worktree prune", expect.objectContaining({ cwd: "/repo" }));
1046|    expect(execMock).toHaveBeenNthCalledWith(3, "git worktree list --porcelain", expect.objectContaining({ cwd: "/repo" }));
1047|    expect(audit.git).toHaveBeenCalledWith(
1048|      expect.objectContaining({
1049|        type: "worktree:remove-leaked-registered-worktree",
1050|        target: tempPath,
1051|        metadata: expect.objectContaining({
1052|          reason: RemovalReason.MergerCleanup,
1053|          registeredAfterPrune: true,
1054|        }),
1055|      }),
1056|    );
1057|  });
1058|
1059|
1060|  it("preserves the original remove failure when classification probes fail", async () => {
1061|    const tempPath = "/var/folders/demo/T/fusion-ai-merge-fn-327-A5uY3j";
1062|    const validationError = {
1063|      message: `Command failed: git worktree remove --force ${tempPath}`,
1064|      stderr: `fatal: validation failed, cannot remove working tree: '${tempPath}/.git' is not a .git file, error code 2`,
1065|      status: 2,
1066|    };
1067|    const probeError = new Error("git worktree prune failed");
1068|    execMock
1069|      .mockRejectedValueOnce(validationError)
1070|      .mockRejectedValueOnce(probeError);
1071|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
1072|
1073|    await expect(
1074|      removeWorktree({
1075|        rootDir: "/repo",
1076|        worktreePath: tempPath,
1077|        settings: {},
1078|        audit,
1079|        taskId: "FN-327",
1080|        reason: RemovalReason.MergerCleanup,
1081|      }),
1082|    ).rejects.toBe(validationError);
1083|
1084|    expect(execMock).toHaveBeenNthCalledWith(2, "git worktree prune", expect.objectContaining({ cwd: "/repo" }));
1085|    expect(audit.git).toHaveBeenCalledWith(
1086|      expect.objectContaining({
1087|        type: "worktree:remove-classification-probe-failed",
1088|        target: tempPath,
1089|        metadata: expect.objectContaining({
1090|          reason: RemovalReason.MergerCleanup,
1091|          stderrPreview: expect.stringContaining("is not a .git file"),
1092|          probeError: expect.stringContaining("git worktree prune failed"),
1093|        }),
1094|      }),
1095|    );
1096|  });
1097|
1098|  it("uses worktrunk remove and emits worktree:worktrunk-remove", async () => {
1099|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
1100|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
1101|
1102|    await removeWorktree({
1103|      rootDir: "/repo",
1104|      worktreePath: "/repo/.worktrees/fn-1",
1105|      settings: { worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } as any },
1106|      audit,
1107|      taskId: "FN-1",
1108|      reason: RemovalReason.SelfHealingReclaim,
1109|    });
1110|
1111|    expect(audit.git).toHaveBeenCalledWith({ type: "worktree:worktrunk-remove", target: "/repo/.worktrees/fn-1" });
1112|  });
1113|
1114|  it("falls back to native when worktrunk remove fails and onFailure=fallback-native", async () => {
1115|    execMock
1116|      .mockRejectedValueOnce(new WorktrunkOperationError({ operation: "remove", code: "worktrunk_operation_failed", stderr: "boom", exitCode: 1 }))
1117|      .mockResolvedValueOnce({ stdout: "", stderr: "" });
1118|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
1119|
1120|    await removeWorktree({
1121|      rootDir: "/repo",
1122|      worktreePath: "/repo/.worktrees/fn-1",
1123|      settings: { worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fallback-native" } as any },
1124|      audit,
1125|      reason: RemovalReason.SelfHealingReclaim,
1126|    });
1127|
1128|    expect(audit.git).toHaveBeenCalledWith(
1129|      expect.objectContaining({ type: "worktree:worktrunk-fallback", target: "/repo/.worktrees/fn-1" }),
1130|    );
1131|    expect(audit.git).toHaveBeenCalledWith({ type: "worktree:remove", target: "/repo/.worktrees/fn-1" });
1132|  });
1133|
1134|  it("rethrows worktrunk remove failure when onFailure=fail", async () => {
1135|    execMock.mockRejectedValue(
1136|      new WorktrunkOperationError({ operation: "remove", code: "worktrunk_operation_failed", stderr: "boom", exitCode: 1 }),
1137|    );
1138|
1139|    await expect(
1140|      removeWorktree({
1141|        rootDir: "/repo",
1142|        worktreePath: "/repo/.worktrees/fn-1",
1143|        settings: { worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } as any },
1144|        reason: RemovalReason.SelfHealingReclaim,
1145|      }),
1146|    ).rejects.toMatchObject({ code: "worktrunk_operation_failed", operation: "remove" });
1147|  });
1148|
1149|  it("surfaces missing worktrunk binary errors", async () => {
1150|    await expect(
1151|      removeWorktree({
1152|        rootDir: "/repo",
1153|        worktreePath: "/repo/.worktrees/fn-1",
1154|        settings: { worktrunk: { enabled: true, onFailure: "fail" } as any },
1155|        reason: RemovalReason.SelfHealingReclaim,
1156|      }),
1157|    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "remove" });
1158|  });
1159|
1160|  it("reconciles same-task stale active session when defensive owner probe says not live", async () => {
1161|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
1162|    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;
1163|    activeSessionRegistry.registerPath("/repo/.worktrees/fn-1", {
1164|      taskId: "FN-1",
1165|      kind: "executor",
1166|      ownerKey: "FN-1/executor",
1167|    });
1168|
1169|    await removeWorktree({
1170|      rootDir: "/repo",
1171|      worktreePath: "/repo/.worktrees/fn-1",
1172|      settings: {},
1173|      audit,
1174|      reason: RemovalReason.ExecutorDispose,
1175|      expectedOwnerTaskId: "FN-1",
1176|      liveOwnerProbe: () => false,
1177|      // FN-5256: opt out of the min-idle window so this defensive-reconcile test
1178|      // is unaffected by the new warm-up gate.
1179|      reconcileMinIdleMs: 0,
1180|    });
1181|
1182|    expect(activeSessionRegistry.lookupByPath("/repo/.worktrees/fn-1")).toBeNull();
1183|    expect(audit.git).toHaveBeenCalledWith(
1184|      expect.objectContaining({
1185|        type: "worktree:active-session-reconciled",
1186|        target: "/repo/.worktrees/fn-1",
1187|        metadata: { taskId: "FN-1", source: "removeWorktree-defensive" },
1188|      }),
1189|    );
1190|  });
1191|
1192|  it("preserves refusal when same-task owner is still live", async () => {
1193|    activeSessionRegistry.registerPath("/repo/.worktrees/fn-1", {
1194|      taskId: "FN-1",
1195|      kind: "executor",
1196|      ownerKey: "FN-1/executor",
1197|    });
1198|
1199|    await expect(
1200|      removeWorktree({
1201|        rootDir: "/repo",
1202|        worktreePath: "/repo/.worktrees/fn-1",
1203|        settings: {},
1204|        reason: RemovalReason.ExecutorDispose,
1205|        expectedOwnerTaskId: "FN-1",
1206|        liveOwnerProbe: () => true,
1207|      }),
1208|    ).rejects.toBeInstanceOf(ActiveSessionWorktreeRemovalError);
1209|  });
1210|
1211|  it("preserves foreign-owner refusal with defensive owner hints", async () => {
1212|    activeSessionRegistry.registerPath("/repo/.worktrees/fn-1", {
1213|      taskId: "FN-2",
1214|      kind: "executor",
1215|      ownerKey: "FN-2/executor",
1216|    });
1217|
1218|    await expect(
1219|      removeWorktree({
1220|        rootDir: "/repo",
1221|        worktreePath: "/repo/.worktrees/fn-1",
1222|        settings: {},
1223|        reason: RemovalReason.ExecutorDispose,
1224|        expectedOwnerTaskId: "FN-1",
1225|        liveOwnerProbe: () => false,
1226|      }),
1227|    ).rejects.toMatchObject({
1228|      name: "ActiveSessionWorktreeRemovalError",
1229|      details: expect.objectContaining({ taskId: "FN-2" }),
1230|    });
1231|  });
1232|
1233|  it("keeps pre-FN-5346 behavior when defensive owner hints are omitted", async () => {
1234|    activeSessionRegistry.registerPath("/repo/.worktrees/fn-1", {
1235|      taskId: "FN-1",
1236|      kind: "executor",
1237|      ownerKey: "FN-1/executor",
1238|    });
1239|
1240|    await expect(
1241|      removeWorktree({
1242|        rootDir: "/repo",
1243|        worktreePath: "/repo/.worktrees/fn-1",
1244|        settings: {},
1245|        reason: RemovalReason.ExecutorDispose,
1246|      }),
1247|    ).rejects.toBeInstanceOf(ActiveSessionWorktreeRemovalError);
1248|  });
1249|});
1250|
1251|describe("resolveWorktreeBackend", () => {
1252|  it("uses native for undefined worktrunk", () => {
1253|    expect(resolveWorktreeBackend({}).kind).toBe("native");
1254|  });
1255|
1256|  it("uses native when disabled", () => {
1257|    expect(resolveWorktreeBackend({ worktrunk: { enabled: false } as any }).kind).toBe("native");
1258|  });
1259|
1260|  it("uses worktrunk when enabled with binaryPath", () => {
1261|    expect(resolveWorktreeBackend({ worktrunk: { enabled: true, binaryPath: "worktrunk" } as any }).kind).toBe("worktrunk");
1262|  });
1263|
1264|  it("uses literal binaryPath over resolver when both are provided", async () => {
1265|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
1266|    const resolver = vi.fn().mockResolvedValue("/resolved");
1267|    const backend = resolveWorktreeBackend(
1268|      { worktrunk: { enabled: true, binaryPath: " /literal " } as any },
1269|      { binaryPathResolver: resolver },
1270|    );
1271|
1272|    await (backend as WorktrunkWorktreeBackend).remove({
1273|      rootDir: "/repo",
1274|      worktreePath: "/repo/.worktrees/fn-1",
1275|      branch: "fusion/fn-1",
1276|    });
1277|
1278|    expect(resolver).not.toHaveBeenCalled();
1279|    expect(execMock).toHaveBeenCalledWith(
1280|      '"/literal" "remove" "--foreground" "fusion/fn-1"',
1281|      expect.objectContaining({ cwd: "/repo" }),
1282|    );
1283|  });
1284|
1285|  it("wires binaryPathResolver when literal is absent", async () => {
1286|    execMock.mockResolvedValue({ stdout: "", stderr: "" });
1287|    const resolver = vi.fn().mockResolvedValue("/resolved");
1288|    const backend = resolveWorktreeBackend({ worktrunk: { enabled: true } as any }, { binaryPathResolver: resolver });
1289|
1290|    await (backend as WorktrunkWorktreeBackend).remove({
1291|      rootDir: "/repo",
1292|      worktreePath: "/repo/.worktrees/fn-1",
1293|      branch: "fusion/fn-1",
1294|    });
1295|
1296|    expect(resolver).toHaveBeenCalledTimes(1);
1297|    expect(execMock).toHaveBeenCalledWith(
1298|      '"/resolved" "remove" "--foreground" "fusion/fn-1"',
1299|      expect.objectContaining({ cwd: "/repo" }),
1300|    );
1301|  });
1302|
1303|  it("preserves null behavior when literal and resolver are absent", async () => {
1304|    const backend = resolveWorktreeBackend({ worktrunk: { enabled: true } as any });
1305|
1306|    await expect(
1307|      (backend as WorktrunkWorktreeBackend).remove({
1308|        rootDir: "/repo",
1309|        worktreePath: "/repo/.worktrees/fn-1",
1310|        branch: "fusion/fn-1",
1311|      }),
1312|    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "remove" });
1313|  });
1314|
1315|  it("uses worktrunk when enabled without binaryPath", () => {
1316|    expect(resolveWorktreeBackend({ worktrunk: { enabled: true } as any }).kind).toBe("worktrunk");
1317|  });
1318|});
1319|