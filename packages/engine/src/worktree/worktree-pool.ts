1|import { exec, execFile } from "node:child_process";
2|import { promisify } from "node:util";
3|import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
4|import { mkdir } from "node:fs/promises";
5|import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
6|import type { SecretsStore, Settings, TaskStore, WorktrunkSettings } from "@fusion/core";
7|import { assertCleanBranchAtBase, inspectBranchConflict } from "../execution/branch-conflicts.js";
8|import { worktreePoolLog } from "../logger.js";
9|/*
10|*/
11|import { isInsideConfiguredWorktreesDir, isWorktreeContainerDir, resolveWorktreesDir } from "./worktree-paths.js";
12|import { canonicalFusionBranchName } from "./worktree-names.js";
13|import {
14|  resolveWorktrunkBinary,
15|} from "./worktrunk-installer.js";
16|import {
17|  RemovalReason,
18|  removeWorktree as removeWorktreeViaBackend,
19|  resolveWorktreeBackend as resolveWorktreeBackendViaSettings,
20|} from "./worktree-backend.js";
21|import { cleanupSecretsEnvFile } from "./secrets-env-writer.js";
22|import { removeDesktopBuildArtifacts } from "./worktree-desktop-artifacts.js";
23|import { resolveIntegrationBranch } from "../merge/integration-branch.js";
24|import type { RunAuditor } from "../util/run-audit.js";
25|import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
26|import { resolveWorkflowIrForTask, columnsWithFlag } from "@fusion/core";
27|
28|export {
29|  NativeWorktreeBackend,
30|  WorktrunkOperationError,
31|  WorktrunkWorktreeBackend,
32|  removeWorktree,
33|  resolveWorktreeBackend,
34|} from "./worktree-backend.js";
35|export type { WorktreeBackend, WorktreeBackendKind } from "./worktree-backend.js";
36|export { RemovalReason } from "./worktree-backend.js";
37|
38|// Re-export worktrunk installer types for convenience.
39|export {
40|  resolveWorktrunkBinary as resolveWorktrunkBinaryOriginal,
41|  WorktrunkBinaryUnavailableError,
42|  WorktrunkInstallDeniedError,
43|  WorktrunkInstallFailedError,
44|} from "./worktrunk-installer.js";
45|
46|const execAsync = promisify(exec);
47|const execFileAsync = promisify(execFile);
48|
49|// ── Worktrunk binary lazy resolver ─────────────────────────────────────────────
50|// Memoizes per (homedir, settings.binaryPath) so the resolution+install flow
51|// runs at most once per unique settings combination per process.
52|const _worktrunkBinaryCache = new Map<string, { binaryPath: string; resolvedAt: number }>();
53|
54|export async function getWorktrunkBinary(
55|  settings: WorktrunkSettings,
56|): Promise<{
57|  binaryPath: string;
58|  source: "override" | "path" | "cached" | "installed-release" | "installed-cargo";
59|}> {
60|  const cacheKey = `${process.env.HOME ?? ""}::${settings.binaryPath ?? ""}`;
61|  const cached = _worktrunkBinaryCache.get(cacheKey);
62|  if (cached) {
63|    return { binaryPath: cached.binaryPath, source: "cached" };
64|  }
65|  const result = await resolveWorktrunkBinary({ settings });
66|  _worktrunkBinaryCache.set(cacheKey, { binaryPath: result.binaryPath, resolvedAt: Date.now() });
67|  return result;
68|}
69|
70|export function clearWorktrunkBinaryCache(): void {
71|  _worktrunkBinaryCache.clear();
72|}
73|
74|export function canonicalizePath(path: string): string {
75|  /*
76|  FNXC:WorktreeLiveness 2026-07-15-11:55:
77|  On macOS, /tmp is a symlink to /private/tmp. realpathSync of an existing worktrees
78|  root yields /private/tmp/... while resolve() of a not-yet-created child stays under
79|  /tmp/... — relative() then looks like a path escape and isInsideConfiguredWorktreesDir
80|  falsely reports outside_worktrees_dir (restart.integration resumeOrphaned).
81|  When the leaf is missing, realpath the nearest existing ancestor and rejoin the suffix.
82|  */
83|  try {
84|    return realpathSync(path);
85|  } catch {
86|    let dir = resolve(path);
87|    const suffix: string[] = [];
88|    while (true) {
89|      try {
90|        return resolve(realpathSync(dir), ...suffix.reverse());
91|      } catch {
92|        const parent = dirname(dir);
93|        if (parent === dir) break;
94|        suffix.push(basename(dir));
95|        dir = parent;
96|      }
97|    }
98|    return resolve(path);
99|  }
100|}
101|
102|export function isRepoRootPath(rootDir: string, candidate: string): boolean {
103|  return canonicalizePath(rootDir) === canonicalizePath(candidate);
104|}
105|
106|function getExecStdout(result: unknown): string {
107|  if (typeof result === "string") return result;
108|  if (result && typeof result === "object" && "stdout" in result) {
109|    const stdout = (result as { stdout?: unknown }).stdout;
110|    return typeof stdout === "string" ? stdout : String(stdout ?? "");
111|  }
112|  return "";
113|}
114|
115|function stringifyExecOutput(value: unknown): string {
116|  if (Buffer.isBuffer(value)) return value.toString("utf-8");
117|  return typeof value === "string" ? value : String(value ?? "");
118|}
119|
120|function getExecErrorOutput(error: unknown): string {
121|  if (!error || typeof error !== "object") return String(error ?? "");
122|  const record = error as { stderr?: unknown; message?: unknown };
123|  const stderr = stringifyExecOutput(record.stderr).trim();
124|  if (stderr) return stderr;
125|  return stringifyExecOutput(record.message).trim();
126|}
127|
128|export type GitRepoDetection =
129|  | { status: "repo" }
130|  | { status: "not-repo"; stderr: string }
131|  | { status: "error"; reason: "dubious-ownership" | "git-missing" | "timeout" | "unknown"; stderr: string };
132|
133|function classifyGitRepoDetectionError(error: unknown): GitRepoDetection {
134|  const stderr = getExecErrorOutput(error);
135|  const output = stderr || String(error ?? "");
136|  const errorRecord = (error && typeof error === "object") ? error as { code?: unknown; killed?: unknown; signal?: unknown } : {};
137|
138|  if (/not a git repo(sitory)?/i.test(output)) {
139|    return { status: "not-repo", stderr: output };
140|  }
141|
142|  if (/detected dubious ownership/i.test(output)) {
143|    return { status: "error", reason: "dubious-ownership", stderr: output };
144|  }
145|
146|  if (errorRecord.code === "ENOENT" || /(?:spawn\s+)?ENOENT/i.test(output) || /command not found/i.test(output)) {
147|    return { status: "error", reason: "git-missing", stderr: output };
148|  }
149|
150|  if (errorRecord.code === "ETIMEDOUT" || errorRecord.killed === true || /timed out|timeout/i.test(output)) {
151|    return { status: "error", reason: "timeout", stderr: output };
152|  }
153|
154|  return { status: "error", reason: "unknown", stderr: output };
155|}
156|
157|/*
158|FNXC:Worktree 2026-07-10-00:00:
159|FN-7799 requires Git repository detection to distinguish a positive non-repo verdict from environmental Git failures. Dubious ownership on OneDrive-backed Windows Documents paths, git-not-on-PATH, index locks, and timeouts must never be reported as "not a Git repository", because that false negative permanently blocks valid repos across engine restarts.
160|*/
161|export async function detectGitRepository(dir: string): Promise<GitRepoDetection> {
162|  try {
163|    await execAsync("git rev-parse --git-dir", {
164|      cwd: dir,
165|      encoding: "utf-8",
166|      timeout: 10_000,
167|      maxBuffer: 10 * 1024 * 1024,
168|    });
169|    return { status: "repo" };
170|  } catch (err: unknown) {
171|    const detection = classifyGitRepoDetectionError(err);
172|    const reasonText = detection.status === "error" ? ` reason=${detection.reason}` : "";
173|    const stderrText = detection.status === "repo" ? "" : detection.stderr;
174|    worktreePoolLog.log(
175|      `detectGitRepository check failed for ${dir}: status=${detection.status}${reasonText} stderr=${stderrText}`,
176|    );
177|    return detection;
178|  }
179|}
180|
181|export async function isGitRepository(dir: string): Promise<boolean> {
182|  return (await detectGitRepository(dir)).status === "repo";
183|}
184|
185|export async function describeRegisteredWorktrees(rootDir: string): Promise<{ rawOutput: string; canonicalized: string[] }> {
186|  try {
187|    const result = await execAsync("git worktree list --porcelain", {
188|      cwd: rootDir,
189|      encoding: "utf-8",
190|      timeout: 10_000,
191|      maxBuffer: 10 * 1024 * 1024,
192|    });
193|    const stdout = getExecStdout(result);
194|
195|    const canonicalized: string[] = [];
196|    for (const line of stdout.split("\n")) {
197|      if (line.startsWith("worktree ")) {
198|        canonicalized.push(canonicalizePath(line.slice("worktree ".length)));
199|      }
200|    }
201|
202|    return { rawOutput: stdout, canonicalized };
203|  } catch (err: unknown) {
204|    const errorMessage = err instanceof Error ? err.message : String(err);
205|    worktreePoolLog.warn(`[worktree-pool] Failed to list registered worktrees: ${errorMessage}`);
206|    return { rawOutput: "", canonicalized: [] };
207|  }
208|}
209|
210|export async function getRegisteredWorktreePaths(rootDir: string): Promise<Set<string>> {
211|  const { canonicalized } = await describeRegisteredWorktrees(rootDir);
212|  return new Set(canonicalized);
213|}
214|
215|export async function getRegisteredWorktreeBranchMap(rootDir: string): Promise<Map<string, string>> {
216|  const branchMap = new Map<string, string>();
217|  for (const entry of await getRegisteredWorktreeBranches(rootDir)) {
218|    branchMap.set(entry.branch, entry.worktreePath);
219|  }
220|  return branchMap;
221|}
222|
223|/**
224| * Same source as `getRegisteredWorktreeBranchMap` but returns ALL
225| * (branch, worktreePath) pairs rather than collapsing duplicates by branch.
226| * Multiple worktrees can legitimately share a branch when the user has
227| * created secondary checkouts via `git worktree add --force -b <branch>`;
228| * callers that need to act on every such worktree (e.g. the merger's
229| * post-advance auto-sync) must use this array form to avoid silently
230| * skipping all but the last-iterated checkout.
231| */
232|export async function getRegisteredWorktreeBranches(rootDir: string): Promise<Array<{ branch: string; worktreePath: string }>> {
233|  const { rawOutput } = await describeRegisteredWorktrees(rootDir);
234|  const entries: Array<{ branch: string; worktreePath: string }> = [];
235|  let currentWorktree: string | null = null;
236|
237|  for (const line of rawOutput.split("\n")) {
238|    if (line.startsWith("worktree ")) {
239|      currentWorktree = canonicalizePath(line.slice("worktree ".length));
240|      continue;
241|    }
242|
243|    if (line.startsWith("branch ") && currentWorktree) {
244|      const branchRef = line.slice("branch ".length).trim();
245|      const branchName = branchRef.startsWith("refs/heads/")
246|        ? branchRef.slice("refs/heads/".length)
247|        : branchRef;
248|      if (branchName) {
249|        entries.push({ branch: branchName, worktreePath: currentWorktree });
250|      }
251|    }
252|  }
253|
254|  return entries;
255|}
256|
257|export async function isRegisteredGitWorktree(rootDir: string, worktreePath: string): Promise<boolean> {
258|  return (await getRegisteredWorktreePaths(rootDir)).has(canonicalizePath(worktreePath));
259|}
260|
261|export function hasRequiredWorktreeFiles(worktreePath: string): boolean {
262|  return existsSync(join(worktreePath, ".git"));
263|}
264|
265|/*
266|FNXC:WorktreeLiveness 2026-07-26-08:20:
267|SYNC, NON-SPAWNING liveness probe for callers that must not run git — specifically failure/recovery
268|paths, where spawning git to decide how to recover from a git failure is both slow and fragile.
269|`classifyTaskWorktree` stays the canonical classifier and MUST be preferred wherever an await and a
270|subprocess are acceptable (see docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md
271|→ Prevention: new worktree-liveness paths should call the shared classifier).
272|
273|This probe covers the classifier's filesystem gate (the path exists and carries `.git`) plus its
274|`repo-root` gate when `rootDir` is supplied. It does NOT cover `unregistered` or
275|`outside-work-tree`, so a directory whose `.git` pointer is stale but present still reads as usable
276|here. Callers that treat "usable" as permission to reuse a checkout must tolerate that narrower
277|guarantee; callers needing the full verdict must await `classifyTaskWorktree`. Keeping the fast
278|probe HERE, beside the classifier, is what makes the difference between the two auditable instead
279|of a duplicate check growing in an unrelated module.
280|
281|Pass `rootDir` whenever the caller has it. The project root is a registered git worktree carrying
282|`.git`, so without that gate the main checkout reads as a usable TASK worktree — the FN-6861
283|acquisition→gate→requeue loop in
284|docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md.
285|*/
286|export function hasUsableWorktreeShape(
287|  worktreePath: string | undefined | null,
288|  rootDir?: string,
289|): boolean {
290|  if (!worktreePath) return false;
291|  // `.git` under a path that does not exist (or is a file) cannot exist either, so this single
292|  // filesystem probe subsumes the directory-existence check.
293|  if (!hasRequiredWorktreeFiles(worktreePath)) return false;
294|  if (rootDir && isRepoRootPath(rootDir, worktreePath)) return false;
295|  return true;
296|}
297|
298|export async function isInsideGitWorkTree(worktreePath: string): Promise<boolean> {
299|  try {
300|    const result = await execAsync("git rev-parse --is-inside-work-tree", {
301|      cwd: worktreePath,
302|      encoding: "utf-8",
303|    });
304|    return getExecStdout(result).trim() === "true";
305|  } catch (err: unknown) {
306|    const errorMessage = err instanceof Error ? err.message : String(err);
307|    worktreePoolLog.debug(`isInsideGitWorkTree check failed for ${worktreePath}: ${errorMessage}`);
308|    return false;
309|  }
310|}
311|
312|export type TaskWorktreeClassification = "missing" | "incomplete" | "repo-root" | "unregistered" | "outside-work-tree";
313|
314|export type TaskWorktreeClassificationResult =
315|  | { ok: true }
316|  | { ok: false; classification: TaskWorktreeClassification; reason: string };
317|
318|export type NestedWorktreeRootDetectionResult =
319|  | { reanchored: true; root: string }
320|  | { reanchored: false; reason: string };
321|
322|export async function detectNestedWorktreeRoot(
323|  rootDir: string,
324|  worktreePath: string,
325|  settings?: Pick<Settings, "worktreesDir">,
326|): Promise<NestedWorktreeRootDetectionResult> {
327|  if (!existsSync(worktreePath)) {
328|    return { reanchored: false, reason: "worktree_missing" };
329|  }
330|
331|  if (!isInsideWorktreesDir(rootDir, worktreePath, settings)) {
332|    return { reanchored: false, reason: "worktree_outside_configured_dir" };
333|  }
334|
335|  const canonicalRootDir = canonicalizePath(rootDir);
336|  const canonicalWorktreePath = canonicalizePath(worktreePath);
337|
338|  let topLevelRaw = "";
339|  try {
340|    const result = await execAsync("git rev-parse --show-toplevel", {
341|      cwd: worktreePath,
342|      encoding: "utf-8",
343|      timeout: 10_000,
344|      maxBuffer: 1024 * 1024,
345|    });
346|    topLevelRaw = getExecStdout(result).trim();
347|  } catch (error) {
348|    return { reanchored: false, reason: `top_level_probe_failed:${error instanceof Error ? error.message : String(error)}` };
349|  }
350|
351|  if (!topLevelRaw) {
352|    return { reanchored: false, reason: "top_level_empty" };
353|  }
354|
355|  const canonicalTopLevel = canonicalizePath(topLevelRaw);
356|  if (canonicalTopLevel === canonicalWorktreePath) {
357|    return { reanchored: false, reason: "already_at_toplevel" };
358|  }
359|
360|  if (canonicalTopLevel === canonicalRootDir) {
361|    return { reanchored: false, reason: "toplevel_is_repo_root" };
362|  }
363|
364|  if (!isInsideWorktreesDir(rootDir, canonicalTopLevel, settings)) {
365|    return { reanchored: false, reason: "toplevel_outside_configured_dir" };
366|  }
367|
368|  const relFromTopLevel = relative(canonicalTopLevel, canonicalWorktreePath);
369|  const nestedUnderTopLevel = relFromTopLevel !== "" && !relFromTopLevel.startsWith("..") && !isAbsolute(relFromTopLevel);
370|  if (!nestedUnderTopLevel) {
371|    return { reanchored: false, reason: "not_nested_under_toplevel" };
372|  }
373|
374|  if (!await isRegisteredGitWorktree(rootDir, canonicalTopLevel)) {
375|    return { reanchored: false, reason: "toplevel_not_registered_worktree" };
376|  }
377|
378|  return { reanchored: true, root: canonicalTopLevel };
379|}
380|
381|/**
382| * Language-agnostic liveness/classification gate for task worktrees.
383| */
384|export async function classifyTaskWorktree(rootDir: string, worktreePath: string): Promise<TaskWorktreeClassificationResult> {
385|  if (!existsSync(worktreePath)) {
386|    return { ok: false, classification: "missing", reason: "worktree directory does not exist" };
387|  }
388|
389|  /*
390|   * FNXC:WorktreeLiveness 2026-06-21-11:10:
391|   * The project root is a legitimately registered git worktree, but it is never a usable task worktree. Tasks must execute inside the configured worktrees directory, so classification rejects root-equal paths here to stop the resume↔executor-gate requeue loop observed in FN-6861/FN-6709.
392|   */
393|  if (isRepoRootPath(rootDir, worktreePath)) {
394|    return { ok: false, classification: "repo-root", reason: "worktree path is the project root, not a task worktree" };
395|  }
396|
397|  if (!hasRequiredWorktreeFiles(worktreePath)) {
398|    return { ok: false, classification: "incomplete", reason: "missing .git metadata" };
399|  }
400|  if (!await isRegisteredGitWorktree(rootDir, worktreePath)) {
401|    return { ok: false, classification: "unregistered", reason: "not registered in git worktree list" };
402|  }
403|  if (!await isInsideGitWorkTree(worktreePath)) {
404|    return { ok: false, classification: "outside-work-tree", reason: "git rev-parse --is-inside-work-tree returned false" };
405|  }
406|  return { ok: true };
407|}
408|
409|/**
410| * Language-agnostic liveness gate for task worktrees.
411| */
412|export async function isUsableTaskWorktree(rootDir: string, worktreePath: string): Promise<boolean> {
413|  const result = await classifyTaskWorktree(rootDir, worktreePath);
414|  return result.ok;
415|}
416|
417|export function isInsideWorktreesDir(
418|  rootDir: string,
419|  worktreePath: string,
420|  settings?: Pick<Settings, "worktreesDir">,
421|): boolean {
422|  return isInsideConfiguredWorktreesDir(rootDir, settings, worktreePath);
423|}
424|
425|export type ReclaimableWorktreePlacement =
426|  | { kind: "ready"; path: string; relocated: boolean }
427|  | { kind: "deferred-live"; path: string };
428|
429|export interface RelocateReclaimableWorktreeInput {
430|  rootDir: string;
431|  sourcePath: string;
432|  targetPath: string;
433|  taskId: string;
434|  settings?: Pick<Settings, "worktreeNaming" | "worktreesDir" | "worktrunk">;
435|  isPathActive: (path: string) => boolean | Promise<boolean>;
436|}
437|
438|/**
439| * Put a preserved, registered native checkout under the configured worktree
440| * root. Worktrunk-assigned paths remain backend-owned. The exact source path
441| * must be idle before it can move; callers treat a live result as deferred
442| * recovery rather than invalidating a running process cwd.
443| */
444|export async function relocateReclaimableWorktreeIntoRoot(
445|  input: RelocateReclaimableWorktreeInput,
446|): Promise<ReclaimableWorktreePlacement> {
447|  const { rootDir, sourcePath, targetPath, taskId, settings, isPathActive } = input;
448|  if (settings?.worktrunk?.enabled === true) {
449|    return { kind: "ready", path: sourcePath, relocated: false };
450|  }
451|  if (isInsideWorktreesDir(rootDir, sourcePath, settings)) {
452|    return { kind: "ready", path: sourcePath, relocated: false };
453|  }
454|  if (await isPathActive(sourcePath)) {
455|    return { kind: "deferred-live", path: sourcePath };
456|  }
457|  if (!isInsideWorktreesDir(rootDir, targetPath, settings)) {
458|    throw new Error(
459|      `Refusing to relocate ${taskId} worktree to path outside configured worktrees directory: ${targetPath}`,
460|    );
461|  }
462|
463|  let resolvedTargetPath = targetPath;
464|  if (existsSync(resolvedTargetPath) && settings?.worktreeNaming !== "task-id") {
465|    const taskSuffix = taskId.toLowerCase();
466|    const candidates = [
467|      `${targetPath}-${taskSuffix}`,
468|      ...Array.from({ length: 5 }, (_, index) => `${targetPath}-${taskSuffix}-${index + 2}`),
469|    ];
470|    const available = candidates.find((candidate) => !existsSync(candidate));
471|    if (!available) {
472|      throw new Error(`No available relocation target for ${taskId} worktree near ${targetPath}`);
473|    }
474|    resolvedTargetPath = available;
475|  }
476|
477|  await mkdir(dirname(resolvedTargetPath), { recursive: true });
478|  await execFileAsync("git", ["worktree", "move", sourcePath, resolvedTargetPath], {
479|    cwd: rootDir,
480|    timeout: 120_000,
481|    maxBuffer: 10 * 1024 * 1024,
482|  });
483|
484|  return { kind: "ready", path: resolvedTargetPath, relocated: true };
485|}
486|
487|/**
488| * A pool of idle git worktrees that can be recycled across tasks.
489| *
490| * When `recycleWorktrees` is enabled, completed task worktrees are returned
491| * to this pool instead of being deleted. New tasks acquire a warm worktree
492| * from the pool, preserving build caches (node_modules, target/, dist/).
493| *
494| * The pool only tracks *idle* worktrees — those not currently assigned to
495| * any active task. The scheduler's `maxWorktrees` setting still governs
496| * the total number of worktrees (active + idle).
497| *
498| * **Lifecycle across restarts:** The pool is in-memory only, but on engine
499| * startup it can be rehydrated from disk state via {@link rehydrate} and
500| * {@link scanIdleWorktrees}. When `recycleWorktrees` is true, the startup
501| * sequence scans the `.worktrees/` directory, identifies idle worktrees
502| * (those not assigned to any active task), and bulk-loads them into the
503| * pool. When `recycleWorktrees` is false, orphaned worktrees are cleaned
504| * up via {@link cleanupOrphanedWorktrees}.
505| */
506|function deriveTaskIdFromBranch(branchName: string): string {
507|  const match = branchName.match(/^fusion\/(fn-\d+)(?:-\d+)?(?:-[a-z0-9._-]+)*$/i);
508|  return match ? match[1].toUpperCase() : branchName.toUpperCase();
509|}
510|
511|export type PrepareForTaskResult = {
512|  branch: string;
513|  worktreePath: string;
514|  reclaimed: boolean;
515|  existingTipSha?: string;
516|  strandedCommitCount?: number;
517|};
518|
519|export type PoolInvariantPhase = "acquire" | "rehydrate" | "release";
520|
521|export type PoolInvariantViolation = {
522|  path: string;
523|  existingHolder: string;
524|  requestingTaskId: string;
525|  phase: PoolInvariantPhase;
526|};
527|
528|export class PoolDoubleLeaseError extends Error {
529|  constructor(
530|    public readonly path: string,
531|    public readonly existingHolder: string,
532|    public readonly requestingTaskId: string,
533|    public readonly phase: PoolInvariantPhase,
534|  ) {
535|    super(`Pool double lease detected for ${path}: held by ${existingHolder}, requested by ${requestingTaskId} during ${phase}`);
536|    this.name = "PoolDoubleLeaseError";
537|  }
538|}
539|
540|export interface WorktreePoolOptions {
541|  auditFactory?: (taskId: string) => Pick<RunAuditor, "filesystem">;
542|  secretsStore?: Pick<SecretsStore, "listEnvExportable">;
543|}
544|
545|export class WorktreePool {
546|  private idle = new Set<string>();
547|  private leased = new Map<string, string>();
548|  private invariantViolationHandler?: (violation: PoolInvariantViolation) => void;
549|
550|  constructor(_options: WorktreePoolOptions = {}) {}
551|
552|  /**
553|   * Acquire an idle worktree from the pool.
554|   *
555|   * Returns the absolute path of an idle worktree, or `null` if the pool
556|   * is empty. Before returning, verifies the directory still exists on disk
557|   * and prunes any stale entries.
558|   */
559|  acquire(taskId: string): string | null {
560|    for (const path of this.idle) {
561|      this.assertNotDoubleLeased(path, taskId, "acquire");
562|      this.idle.delete(path);
563|      this.leased.set(path, taskId);
564|      if (existsSync(path)) {
565|        return path;
566|      }
567|      this.leased.delete(path);
568|      worktreePoolLog.debug(`Pruned stale entry: ${path}`);
569|    }
570|    return null;
571|  }
572|
573|  /**
574|   * Return a worktree to the idle pool after a task completes.
575|   *
576|   * The worktree directory is retained on disk with its build caches intact.
577|   * Call this instead of `git worktree remove` when recycling is enabled.
578|   *
579|   * @param worktreePath — Absolute path to the worktree directory
580|   */
581|  release(worktreePath: string, releasingTaskId?: string): void {
582|    const existingHolder = this.leased.get(worktreePath);
583|    if (!existingHolder) {
584|      worktreePoolLog.warn(`release called for non-leased worktree: ${worktreePath}`);
585|    } else if (releasingTaskId && existingHolder !== releasingTaskId) {
586|      this.notifyInvariantViolation({
587|        path: worktreePath,
588|        existingHolder,
589|        requestingTaskId: releasingTaskId,
590|        phase: "release",
591|      });
592|      worktreePoolLog.warn(
593|        `release task mismatch for ${worktreePath}: leased holder=${existingHolder}, releasingTaskId=${releasingTaskId}`,
594|      );
595|    }
596|    this.leased.delete(worktreePath);
597|    this.idle.add(worktreePath);
598|  }
599|
600|  /** Number of idle worktrees currently in the pool. */
601|  get size(): number {
602|    return this.idle.size;
603|  }
604|
605|  /** Check whether a specific path is in the idle pool. */
606|  has(path: string): boolean {
607|    return this.idle.has(path);
608|  }
609|
610|  setInvariantViolationHandler(handler: (violation: PoolInvariantViolation) => void): void {
611|    this.invariantViolationHandler = handler;
612|  }
613|
614|  /** @internal test-only visibility */
615|  getLeasedPaths(): ReadonlyMap<string, string> {
616|    return this.leased;
617|  }
618|
619|  private notifyInvariantViolation(violation: PoolInvariantViolation): void {
620|    try {
621|      this.invariantViolationHandler?.(violation);
622|    } catch (error) {
623|      worktreePoolLog.warn(`Invariant violation handler failed: ${error instanceof Error ? error.message : String(error)}`);
624|    }
625|  }
626|
627|  private assertNotDoubleLeased(path: string, requestingTaskId: string, phase: PoolInvariantPhase): void {
628|    const existingHolder = this.leased.get(path);
629|    if (!existingHolder || existingHolder === requestingTaskId) {
630|      return;
631|    }
632|    const violation: PoolInvariantViolation = { path, existingHolder, requestingTaskId, phase };
633|    this.notifyInvariantViolation(violation);
634|    throw new PoolDoubleLeaseError(path, existingHolder, requestingTaskId, phase);
635|  }
636|
637|  /**
638|   * Remove and return all idle worktree paths.
639|   *
640|   * Useful for shutdown/cleanup — the caller is responsible for
641|   * running `git worktree remove` on each returned path.
642|   */
643|  drain(): string[] {
644|    const paths = Array.from(this.idle);
645|    this.idle.clear();
646|    this.leased.clear();
647|    return paths;
648|  }
649|
650|  /**
651|   * Bulk-load known idle worktree paths into the pool.
652|   *
653|   * Called at engine startup to restore the pool from disk state.
654|   * Paths that no longer exist on disk are silently skipped.
655|   *
656|   * @param idlePaths — Absolute paths to idle worktree directories
657|   */
658|  rehydrate(idlePaths: string[]): void {
659|    for (const path of idlePaths) {
660|      if (!existsSync(path)) {
661|        worktreePoolLog.debug(`Rehydrate skipped (not on disk): ${path}`);
662|        continue;
663|      }
664|      const existingHolder = this.leased.get(path);
665|      if (existingHolder) {
666|        this.notifyInvariantViolation({
667|          path,
668|          existingHolder,
669|          requestingTaskId: existingHolder,
670|          phase: "rehydrate",
671|        });
672|        worktreePoolLog.warn(`Rehydrate skipped leased worktree ${path} (holder=${existingHolder})`);
673|        continue;
674|      }
675|      this.idle.add(path);
676|    }
677|  }
678|
679|  /**
680|   * Prepare a recycled worktree for a new task.
681|   *
682|   * Resets the working tree to a clean state, then creates (or force-resets)
683|   * the task's branch based on the given start point (or `main` by default).
684|   * This ensures the new task starts from the correct base with a clean
685|   * working directory, while preserving untracked build caches
686|   * (node_modules, target/, dist/). As an explicit carve-out, this
687|   * preparation removes `packages/desktop/dist` and
688|   * `packages/desktop/dist-electron`.
689|   *
690|   * Steps performed:
691|   * 1. `git checkout -- .` — discard tracked file modifications
692|   * 2. `git clean -fd` — remove untracked files (but not .gitignore'd caches)
693|   * 3. Remove `packages/desktop/dist` + `packages/desktop/dist-electron` if present
694|   * 4. `git checkout --detach <startPoint>` — move HEAD to the latest base commit
695|   * 5. `git checkout -B <branchName> <startPoint>` — create/reset branch from start point
696|   *
697|   * Returns the actual branch name used. This may differ from `branchName`
698|   * when legacy conflict recovery is explicitly enabled and generates a suffixed
699|   * name (e.g., `fusion/fn-042-2`).
700|   *
701|   * @param worktreePath — Absolute path to the recycled worktree
702|   * @param branchName — Branch name for the new task (e.g., `fusion/fn-042`)
703|   * @param startPoint — Git ref to branch from (e.g., `fusion/fn-041`). Defaults to `main`.
704|   * @returns The actual branch name checked out in the worktree
705|   */
706|  async prepareForTask(
707|    worktreePath: string,
708|    branchName: string,
709|    startPoint?: string,
710|    options?: { allowSiblingBranchRename?: boolean; repoDir?: string; requestingTaskId?: string },
711|  ): Promise<PrepareForTaskResult> {
712|    // Clean tracked modifications
713|    try {
714|      await execAsync("git checkout -- .", { cwd: worktreePath });
715|    } catch (err: unknown) {
716|      const errorMessage = err instanceof Error ? err.message : String(err);
717|      worktreePoolLog.debug(`git checkout -- . failed (may be clean): ${errorMessage}`);
718|      // May fail if worktree is already clean — that's fine
719|    }
720|
721|    // Remove untracked files (but not .gitignore'd build caches)
722|    await execAsync("git clean -fd", { cwd: worktreePath });
723|    await removeDesktopBuildArtifacts(worktreePath, worktreePoolLog);
724|
725|    const base = startPoint || await resolveIntegrationBranch(options?.repoDir ?? worktreePath, undefined);
726|    // Reject base values that would cause the new branch to inherit the
727|    // worktree's current HEAD instead of the intended start point. Historical
728|    // contamination ("branch: Created from HEAD") landed FN-5472's tip on
729|    // freshly-created fn-5432/fn-5255 branches because the recycled worktree
730|    // was still pointing at the previous occupant's commit and base silently
731|    // collapsed onto HEAD.
732|    const trimmedBase = base?.trim() ?? "";
733|    if (!trimmedBase || trimmedBase.toUpperCase() === "HEAD") {
734|      throw new Error(
735|        `prepareForTask: refusing to create branch ${branchName} from base ${JSON.stringify(base)} (worktree=${worktreePath}, startPoint=${String(startPoint)})`,
736|      );
737|    }
738|
739|    await execAsync(`git checkout --detach ${base}`, {
740|      cwd: worktreePath,
741|    });
742|
743|    // Create or force-reset the branch from the start point (or main)
744|    const checkoutCmd = `git checkout -B "${branchName}" ${base}`;
745|    const resolvedBase = (await execAsync(`git rev-parse --verify "${base}^{commit}"`, { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
746|
747|    // Verify HEAD actually landed at the resolved base after --detach. If
748|    // detach silently leaves HEAD elsewhere (e.g. the base ref didn't exist
749|    // and git fell through to current HEAD), creating the branch now would
750|    // pin it to the wrong tip — exactly the FN-5432 / FN-5255 contamination
751|    // pattern ("branch: Created from HEAD" pointing at the previous occupant's
752|    // tip). Only enforced when we have real SHAs to compare; mock-driven
753|    // unit tests that return empty buffers fall through harmlessly.
754|    if (/^[0-9a-f]{40}$/i.test(resolvedBase)) {
755|      const detachedHead = (await execAsync("git rev-parse HEAD", { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
756|      if (detachedHead !== resolvedBase) {
757|        throw new Error(
758|          `prepareForTask: post-detach HEAD ${detachedHead} does not match resolved base ${resolvedBase} (${base}) for ${branchName} — refusing to create branch`,
759|        );
760|      }
761|    }
762|    const taskId = deriveTaskIdFromBranch(branchName);
763|    try {
764|      await execAsync(checkoutCmd, {
765|        cwd: worktreePath,
766|      });
767|      await assertCleanBranchAtBase(worktreePath, branchName, resolvedBase, taskId);
768|      return { branch: branchName, worktreePath, reclaimed: false };
769|    } catch (err: unknown) {
770|      const execError = err instanceof Error ? err : new Error(String(err));
771|      const stderr = "stderr" in execError
772|        ? String((execError as { stderr?: unknown }).stderr ?? execError.message)
773|        : execError.message;
774|      const match = stderr.match(/already used by worktree at '([^']+)'/);
775|      if (!match) {
776|        throw err;
777|      }
778|
779|      // The branch is checked out in a different worktree. Keep stale-conflict
780|      // cleanup behavior for missing paths; otherwise either surface a typed
781|      // conflict or, when explicitly enabled, fall back to the legacy sibling
782|      // suffix flow.
783|      const conflictingPath = match[1];
784|      const repoDir = options?.repoDir ?? worktreePath;
785|      const inspection = await inspectBranchConflict({
786|        repoDir,
787|        branchName,
788|        conflictingWorktreePath: conflictingPath,
789|        requestingTaskId: options?.requestingTaskId ?? taskId,
790|        ownerTaskId: taskId,
791|        startPoint: base,
792|        integrationRef: await resolveIntegrationBranch(repoDir, undefined),
793|      });
794|      if (inspection.kind === "stale" || inspection.kind === "stale-resolved" || inspection.kind === "tip-already-merged") {
795|        const backend = resolveWorktreeBackendViaSettings({}, { logger: worktreePoolLog });
796|        await backend.prune({ rootDir: options?.repoDir ?? worktreePath });
797|        if (inspection.kind === "tip-already-merged") {
798|          try {
799|            await execAsync(`git branch -D "${branchName}"`, { cwd: worktreePath });
800|          } catch {
801|            // best-effort
802|          }
803|        }
804|        await execAsync(checkoutCmd, { cwd: worktreePath });
805|        await assertCleanBranchAtBase(worktreePath, branchName, resolvedBase, taskId);
806|        return { branch: branchName, worktreePath, reclaimed: false };
807|      }
808|
809|      if (inspection.kind === "reclaimable") {
810|        worktreePoolLog.log(
811|          `reclaimed self-owned branch conflict for ${branchName}: tip=${inspection.tipSha} strandedSince${base}=${inspection.strandedCommits.length}`,
812|        );
813|        return {
814|          branch: branchName,
815|          worktreePath: inspection.livePath,
816|          reclaimed: true,
817|          existingTipSha: inspection.tipSha,
818|          strandedCommitCount: inspection.strandedCommits.length,
819|        };
820|      }
821|
822|      if (inspection.kind === "fully-subsumed") {
823|        worktreePoolLog.log(
824|          `reclaimed fully-subsumed branch conflict for ${branchName}: tip=${inspection.tipSha} strandedSince${base}=0`,
825|        );
826|        return {
827|          branch: branchName,
828|          worktreePath: inspection.livePath,
829|          reclaimed: true,
830|          existingTipSha: inspection.tipSha,
831|          strandedCommitCount: 0,
832|        };
833|      }
834|
835|      if (!options?.allowSiblingBranchRename) {
836|        if (inspection.kind === "live-foreign") {
837|          throw inspection.error;
838|        }
839|        throw new Error(`Branch ${branchName} is already in use at ${conflictingPath}`);
840|      }
841|
842|      const conflictBase = branchName;
843|      for (let suffix = 2; suffix <= 6; suffix++) {
844|        const suffixedName = `${branchName}-${suffix}`;
845|        const suffixedCmd = `git checkout -B "${suffixedName}" ${conflictBase}`;
846|        try {
847|          await execAsync(suffixedCmd, { cwd: worktreePath });
848|          await assertCleanBranchAtBase(worktreePath, suffixedName, resolvedBase, taskId);
849|          return { branch: suffixedName, worktreePath, reclaimed: false };
850|        } catch (suffixErr: unknown) {
851|          const suffixExecError = suffixErr instanceof Error ? suffixErr : new Error(String(suffixErr));
852|          const suffixStderr = "stderr" in suffixExecError && typeof suffixExecError.stderr === "string"
853|            ? suffixExecError.stderr.toString()
854|            : "";
855|          if (!suffixStderr.includes("already used by worktree")) {
856|            throw suffixErr;
857|          }
858|        }
859|      }
860|
861|      throw new Error(
862|        `Cannot create branch for task: "${branchName}" and suffixes -2 through -6 are all in use by other worktrees`,
863|      );
864|    }
865|  }
866|}
867|
868|/**
869| * Scan the `.worktrees/` directory to find idle worktrees that can be
870| * loaded into the pool on startup.
871| *
872| * A worktree is considered "idle" if it exists on disk under
873| * `<rootDir>/.worktrees/` but is NOT assigned (via `task.worktree`) to
874| * any non-done task.
875| *
876| * @param rootDir — Project root directory (parent of `.worktrees/`)
877| * @param store — Task store for listing tasks and their worktree assignments
878| * @returns Absolute paths of idle worktree directories
879| */
880|export async function scanIdleWorktrees(
881|  rootDir: string,
882|  store: TaskStore,
883|  settings?: Pick<Settings, "worktreesDir">,
884|): Promise<string[]> {
885|  const worktreesDir = resolveWorktreesDir(rootDir, settings);
886|
887|  if (!existsSync(worktreesDir)) {
888|    return [];
889|  }
890|
891|  // List all subdirectories under .worktrees/
892|  let dirs: string[];
893|  try {
894|    const entries = readdirSync(worktreesDir, { withFileTypes: true });
895|    dirs = entries
896|      .filter((e) => e.isDirectory() && !isWorktreeContainerDir(e.name))
897|      .map((e) => join(worktreesDir, e.name));
898|  } catch (err: unknown) {
899|    const errorMessage = err instanceof Error ? err.message : String(err);
900|    worktreePoolLog.warn(`Failed to read .worktrees/ directory: ${errorMessage}`);
901|    return [];
902|  }
903|
904|  if (dirs.length === 0) {
905|    return [];
906|  }
907|
908|  const registeredWorktrees = await getRegisteredWorktreePaths(rootDir);
909|  const registeredDirs = dirs.filter((dir) => registeredWorktrees.has(resolve(dir)));
910|
911|  // Find worktree paths assigned to non-done tasks (active worktrees)
912|  const tasks = await store.listTasks({ slim: true, includeArchived: false, startupMemo: true });
913|  const activeWorktrees = new Set<string>();
914|  /*
915|  FNXC:WorkflowResolvedColumns 2026-07-30-14:05 (batch-engine tail):
916|  "Still holding its worktree" excludes tasks that have FINISHED. Keyed on the id, a renamed complete
917|  lane kept every shipped task's worktree in the ACTIVE set, so this reclaim pass never returned it and
918|  the board walked into worktree exhaustion — a stall whose cause is invisible from the symptom.
919|
920|  NOT the query-filter class: this listTasks call passes no `column`.
921|
922|  Resolved per TASK (each may run its own workflow) and ONLY for tasks that actually record a worktree,
923|  with one IR cache for the pass. Unioned with the legacy id because `resolveWorkflowIrForTask` degrades
924|  to the BUILT-IN IR rather than throwing — without the union a degraded board would hold every worktree
925|  forever, which is this bug.
926|  */
927|  const reclaimIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
928|  const completeByTaskId = new Map<string, ReadonlySet<string>>();
929|  for (const task of tasks) {
930|    if (!task.worktree) continue;
931|    const columns = new Set<string>(["done"]);
932|    try {
933|      const ir = await resolveWorkflowIrForTask(store, task.id, reclaimIrCache);
934|      if (ir) for (const id of columnsWithFlag(ir, "complete")) columns.add(id);
935|    } catch { /* degraded: legacy id only */ }
936|    completeByTaskId.set(task.id, columns);
937|  }
938|  const isUnfinished = (task: { id: string; column: string }) =>
939|    completeByTaskId.get(task.id)?.has(task.column) !== true;
940|  for (const task of tasks) {
941|    if (task.worktree && isUnfinished(task) && registeredWorktrees.has(resolve(task.worktree))) {
942|      activeWorktrees.add(resolve(task.worktree));
943|    } else if (task.worktree && isUnfinished(task)) {
944|      worktreePoolLog.debug(`Ignoring task ${task.id} worktree metadata because it is not a registered git worktree: ${task.worktree}`);
945|    }
946|  }
947|
948|  // Return registered worktrees on disk that are NOT active. Unregistered
949|  // directories are intentionally excluded here so recycle mode never adds a
950|  // broken directory to the warm pool; cleanup handles those separately.
951|  return registeredDirs.filter((dir) => !activeWorktrees.has(resolve(dir)));
952|}
953|
954|/**
955| * Clean up orphaned worktrees left behind from previous engine runs.
956| *
957| * Removes registered worktrees not assigned to unfinished tasks and empty
958| * unregistered residue. Used on startup when `recycleWorktrees` is false.
959| *
960| * Failures on individual worktree removals are logged but not fatal.
961| *
962| * @param rootDir — Project root directory (parent of `.worktrees/`)
963| * @param store — Task store for listing tasks and their worktree assignments
964| * @returns Number of worktrees cleaned up
965| */
966|export async function cleanupOrphanedWorktrees(
967|  rootDir: string,
968|  store: TaskStore,
969|  settings?: Pick<Settings, "worktreesDir">,
970|): Promise<number> {
971|  const worktreesDir = resolveWorktreesDir(rootDir, settings);
972|  if (!existsSync(worktreesDir)) {
973|    return 0;
974|  }
975|
976|  const orphaned = await scanIdleWorktrees(rootDir, store, settings);
977|  const registeredWorktrees = await getRegisteredWorktreePaths(rootDir);
978|
979|  let cleaned = 0;
980|
981|  for (const worktreePath of orphaned) {
982|    try {
983|      if (registeredWorktrees.has(resolve(worktreePath))) {
984|        // FNXC:WorktreeCleanup 2026-08-15-19:00:
985|        // Never probe a missing directory; prune its stale admin entry instead.
986|        // The shared removal path revalidates tracked, untracked, and ignored content
987|        // after cleaning only fingerprint-owned Fusion secrets.
988|        if (!existsSync(worktreePath)) {
989|          await pruneWorktreeAdminEntries({ rootDir, reason: "pool-cleanup-missing-orphan", target: worktreePath, logger: worktreePoolLog }).catch(() => undefined);
990|          cleaned++;
991|          continue;
992|        }
993|        const orphanTaskId = `orphan:${basename(worktreePath)}`;
994|        try {
995|          await cleanupSecretsEnvFile({
996|            worktreePath,
997|            taskId: orphanTaskId,
998|            expectedFingerprint: null,
999|            filename: ".env",
1000|            audit: undefined,
1001|            logger: worktreePoolLog,
1002|          });
1003|        } catch (error) {
1004|          worktreePoolLog.warn(
1005|            `secrets-env cleanup failed for registered orphan ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
1006|          );
1007|        }
1008|
1009|        await removeWorktreeViaBackend({
1010|          rootDir,
1011|          worktreePath,
1012|          settings: settings ?? {},
1013|          reason: RemovalReason.SelfHealingIdleSweep,
1014|          allowDirtyReclaim: false,
1015|        });
1016|      } else {
1017|        continue;
1018|      }
1019|      worktreePoolLog.log(`Cleaned up orphaned worktree: ${worktreePath}`);
1020|      cleaned++;
1021|    } catch (err: unknown) {
1022|      const errorMessage = err instanceof Error ? err.message : String(err);
1023|      worktreePoolLog.log(`Failed to remove orphaned worktree ${worktreePath}: ${errorMessage}`);
1024|    }
1025|  }
1026|
1027|  return cleaned + await reapOrphanWorktrees(rootDir, settings);
1028|}
1029|
1030|/**
1031| * Remove "half-initialized" worktree directories — directories that exist under
1032| * `<projectRoot>/.worktrees/` on disk but were never fully registered with git
1033| * (i.e., `git worktree add` never completed successfully for them).
1034| *
1035| * This is the housekeeping path; it runs once at engine startup and is safe to
1036| * call repeatedly.  The hot path (`assertValidWorktreeSession`) is deliberately
1037| * left untouched.
1038| *
1039| * Safety invariants enforced before any removal:
1040| * - Only removes direct children of `<projectRoot>/.worktrees/` — never the
1041| *   project root itself, a parent, or an arbitrary path.
1042| * - Skips symlinks (only removes real directories).
1043| * - Never removes a directory that is a registered git worktree.
1044| * - Never removes a directory that has a valid `.git` file pointing to an
1045| *   existing gitdir (belt-and-suspenders: git would list it anyway, but guards
1046| *   against stale porcelain output on broken repos).
1047| *
1048| * @param projectRoot - Absolute path to the project root (parent of `.worktrees/`)
1049| * @returns Number of orphan directories removed
1050| */
1051|/**
1052| * Decide whether a worktree's `.git` pointer is *dangling* — present on disk but
1053| * referencing a `.git/worktrees/<name>` admin entry that no longer exists. A
1054| * dangling pointer is FN-6782 leak residue: invisible to `git worktree list` /
1055| * `prune`, yet it collides with freshly generated worktree names.
1056| *
1057| * Returns `true` ONLY when the pointer is confidently classifiable as dangling:
1058| * a `gitdir: <path>` link file (relative targets resolved against the worktree
1059| * dir) whose target is confirmed missing. Returns `false` for everything else —
1060| * a real `.git` directory, a live gitdir target, an unparseable pointer, OR any
1061| * read/stat failure. The conservative default matters: callers reap on `true`,
1062| * so a transient read error (EACCES/EBUSY) on a genuinely-live worktree's `.git`
1063| * must never be misread as dangling and force-removed.
1064| */
1065|function dotGitPointerIsDangling(dotGitPath: string): boolean {
1066|  try {
1067|    if (lstatSync(dotGitPath).isDirectory()) return false;
1068|    const raw = readFileSync(dotGitPath, "utf8").trim();
1069|    const match = /^gitdir:\s*(.+)$/.exec(raw);
1070|    if (!match) return false;
1071|    const target = match[1].trim();
1072|    const resolved = isAbsolute(target) ? target : resolve(dirname(dotGitPath), target);
1073|    return !existsSync(resolved);
1074|  } catch {
1075|    return false;
1076|  }
1077|}
1078|
1079|export async function reapOrphanWorktrees(
1080|  projectRoot: string,
1081|  settings?: Pick<Settings, "worktreesDir">,
1082|): Promise<number> {
1083|  const worktreesDir = resolveWorktreesDir(projectRoot, settings);
1084|
1085|  if (!existsSync(worktreesDir)) {
1086|    return 0;
1087|  }
1088|
1089|  // List direct children of .worktrees/
1090|  let entries: { name: string; fullPath: string }[];
1091|  try {
1092|    entries = readdirSync(worktreesDir, { withFileTypes: true })
1093|      .filter((e) => {
1094|        // Only real directories — never symlinks or internal worktree containers.
1095|        if (!e.isDirectory() || isWorktreeContainerDir(e.name)) return false;
1096|        try {
1097|          return lstatSync(join(worktreesDir, e.name)).isDirectory() && !lstatSync(join(worktreesDir, e.name)).isSymbolicLink();
1098|        } catch {
1099|          return false;
1100|        }
1101|      })
1102|      .map((e) => ({ name: e.name, fullPath: join(worktreesDir, e.name) }));
1103|  } catch (err: unknown) {
1104|    const msg = err instanceof Error ? err.message : String(err);
1105|    worktreePoolLog.warn(`reapOrphanWorktrees: failed to read .worktrees/ — ${msg}`);
1106|    return 0;
1107|  }
1108|
1109|  if (entries.length === 0) return 0;
1110|
1111|  // Get the set of paths registered with git
1112|  const registered = await getRegisteredWorktreePaths(projectRoot);
1113|
1114|  let removed = 0;
1115|  for (const { name, fullPath } of entries) {
1116|    const resolvedFull = resolve(fullPath);
1117|
1118|    // Safety: only operate on paths directly under .worktrees/
1119|    const rel = relative(resolve(worktreesDir), resolvedFull);
1120|    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
1121|      worktreePoolLog.warn(`reapOrphanWorktrees: skipping out-of-bounds path ${fullPath}`);
1122|      continue;
1123|    }
1124|
1125|    // Skip registered worktrees — those are managed by the normal lifecycle
1126|    if (registered.has(resolvedFull)) {
1127|      continue;
1128|    }
1129|
1130|    // Belt-and-suspenders: skip if a .git file exists AND points to an existing gitdir.
1131|    // This guards against races where git registered the worktree between our list
1132|    // call and now, or against a broken repo whose porcelain is unreliable.
1133|    //
1134|    // FN-6782 follow-up: a *dangling* `.git` (file present, but the admin entry it
1135|    // points to is gone) is NOT "partially registered" — it is leak residue from a
1136|    // worktree whose admin entry was pruned while the directory survived. Such a dir
1137|    // is invisible to `git worktree list`/`prune` yet collides with freshly generated
1138|    // worktree names and breaks `execute` (cleanup can't `git worktree remove` a path
1139|    // git never registered). Only skip when the gitdir target actually exists; reap
1140|    // dangling pointers like any other half-initialized orphan.
1141|    const dotGit = join(resolvedFull, ".git");
1142|    const danglingDotGit = existsSync(dotGit) && dotGitPointerIsDangling(dotGit);
1143|    if (existsSync(dotGit)) {
1144|      if (!danglingDotGit) {
1145|        // Valid registration, a real .git dir, or a pointer we couldn't positively classify as
1146|        // dangling — leave it; assertValidWorktreeSession handles it on the next agent start.
1147|        worktreePoolLog.debug(`reapOrphanWorktrees: skipping ${name} (has .git entry but not in registered list — may be partially registered)`);
1148|        continue;
1149|      }
1150|      worktreePoolLog.debug(`reapOrphanWorktrees: ${name} has a dangling .git pointer (admin entry missing) — treating as orphan`);
1151|    }
1152|
1153|    // FNXC:WorktreeCleanup 2026-08-15-20:40: clean Fusion-owned secret residue before removing an empty orphan.
1154|    try {
1155|      try {
1156|        await cleanupSecretsEnvFile({
1157|          worktreePath: resolvedFull,
1158|          taskId: `orphan:${name}`,
1159|          expectedFingerprint: null,
1160|          filename: ".env",
1161|          logger: worktreePoolLog,
1162|        });
1163|      } catch (error) {
1164|        worktreePoolLog.warn(`secrets-env cleanup failed for orphan ${name}: ${error instanceof Error ? error.message : String(error)}`);
1165|      }
1166|      if (danglingDotGit) {
1167|        const remainingEntries = readdirSync(resolvedFull);
1168|        if (remainingEntries.some((entry) => entry !== ".git")) {
1169|          worktreePoolLog.warn(`Preserving orphan worktree with uncommitted content: ${resolvedFull}`);
1170|          continue;
1171|        }
1172|        unlinkSync(dotGit);
1173|      }
1174|      rmdirSync(resolvedFull);
1175|      await pruneWorktreeAdminEntries({
1176|        rootDir: projectRoot,
1177|        reason: "pool-reap-orphan",
1178|        target: resolvedFull,
1179|        logger: worktreePoolLog,
1180|      }).catch(() => undefined);
1181|      worktreePoolLog.log(`reapOrphanWorktrees: removed half-initialized orphan ${name}`);
1182|      removed++;
1183|    } catch (err: unknown) {
1184|      const msg = err instanceof Error ? err.message : String(err);
1185|      worktreePoolLog.warn(`reapOrphanWorktrees: failed to remove ${name} — ${msg}`);
1186|    }
1187|  }
1188|
1189|  return removed;
1190|}
1191|
1192|/** Columns where merger/finalization owns branch lifecycle. */
1193|
1194|/**
1195| * Return local `fusion/*` branches not associated with any active task.
1196| * Branches tied to merger-managed or archived tasks are excluded.
1197| */
1198|export async function scanOrphanedBranches(rootDir: string, store: TaskStore): Promise<string[]> {
1199|  let allBranches: string[];
1200|  try {
1201|    const result = await execAsync("git branch --list 'fusion/*'", {
1202|      cwd: rootDir,
1203|      encoding: "utf-8",
1204|    });
1205|    const stdout = getExecStdout(result);
1206|    allBranches = stdout
1207|      .split("\n")
1208|      .map((line) => line.trim().replace(/^\*?\s*/, ""))
1209|      .filter((line) => line.startsWith("fusion/"));
1210|  } catch (err: unknown) {
1211|    const errorMessage = err instanceof Error ? err.message : String(err);
1212|    worktreePoolLog.warn(`Failed to list fusion/* branches: ${errorMessage}`);
1213|    return [];
1214|  }
1215|
1216|  if (allBranches.length === 0) return [];
1217|
1218|  const tasks = await store.listTasks({ slim: true, includeArchived: false });
1219|  /*
1220|  FNXC:WorkflowResolvedColumns 2026-07-31-08:20 (batch-engine — census-invisible membership, #2763 class):
1221|  A branch is "active" (and so must not be reclaimed) unless the merger owns the card or it is archived.
1222|  Both tests were hardcoded, so on a renamed board a card in review or complete was NOT recognised as
1223|  merger-managed and its branch was treated as reclaimable — deleting a branch out from under an in-flight
1224|  merge. One IR cache for the pass; the predicates below stay synchronous.
1225|  */
1226|  const poolIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
1227|  const poolLanes = new Map<string, { managed: Set<string>; archived: Set<string> }>();
1228|  for (const task of tasks) {
1229|    if (poolLanes.has(task.id)) continue;
1230|    const managed = new Set<string>(["in-review", "done"]);
1231|    const archived = new Set<string>(["archived"]);
1232|    try {
1233|      const ir = await resolveWorkflowIrForTask(store, task.id, poolIrCache);
1234|      if (ir) {
1235|        for (const flag of ["mergeOrchestration", "mergeBlocker", "humanReview", "complete"] as const) {
1236|          for (const id of columnsWithFlag(ir, flag)) managed.add(id);
1237|        }
1238|        for (const id of columnsWithFlag(ir, "archived")) archived.add(id);
1239|      }
1240|    } catch { /* degraded: legacy ids */ }
1241|    poolLanes.set(task.id, { managed, archived });
1242|  }
1243|  const activeBranches = new Set<string>();
1244|  for (const task of tasks) {
1245|    if (poolLanes.get(task.id)?.managed.has(task.column) === true) continue;
1246|    if (poolLanes.get(task.id)?.archived.has(task.column) === true) continue;
1247|    if (task.branch) activeBranches.add(task.branch);
1248|    activeBranches.add(canonicalFusionBranchName(task.id));
1249|  }
1250|
1251|  return allBranches.filter((branch) => !activeBranches.has(branch));
1252|}
1253|