1|import { exec, execFile } from "node:child_process";
2|import { existsSync, realpathSync } from "node:fs";
3|import { access, rm } from "node:fs/promises";
4|import { basename, resolve } from "node:path";
5|import { promisify } from "node:util";
6|import type { Settings } from "@fusion/core";
7|import {
8|  activeSessionRegistry,
9|  reconcileSelfOwnedActiveSessionForRemoval,
10|  type LiveBindingProbe,
11|  type ProcessActiveProbe,
12|} from "../agents/active-session-registry.js";
13|import type { RunAuditor } from "../util/run-audit.js";
14|import { resolveTaskWorktreePath } from "./worktree-paths.js";
15|import { inspectBareBranchCollision, inspectBranchConflict } from "../execution/branch-conflicts.js";
16|import { resolveIntegrationBranch } from "../merge/integration-branch.js";
17|import { formatError } from "../logger.js";
18|import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
19|import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
20|import {
21|  StaleWorktreeIndexLockError,
22|  classifyStaleLock,
23|  parseIndexLockPath,
24|  tryRemoveStaleLock,
25|} from "./worktree-stale-lock.js";
26|import { parseStaleRegistrationPath, recoverStaleRegistration } from "./worktree-stale-registration.js";
27|
28|const execAsync = promisify(exec);
29|const execFileAsync = promisify(execFile);
30|const NATIVE_TIMEOUT_MS = 120_000;
31|const REMOVE_TIMEOUT_MS = 60_000;
32|const MAX_BUFFER = 10 * 1024 * 1024;
33|
34|function canonicalWorktreePath(path: string): string {
35|  try {
36|    return realpathSync(path);
37|  } catch {
38|    return resolve(path);
39|  }
40|}
41|
42|
43|export type WorktreeRemoveOutcome =
44|  | { removed: true; classification: "removed" }
45|  | {
46|      removed: false;
47|      harmless: true;
48|      classification: "not-registered-after-prune";
49|      message: string;
50|      stderrPreview: string;
51|      pathExists: boolean;
52|      gitFileExists: boolean;
53|    };
54|
55|const HARMLESS_MERGE_REMOVE_ERROR_PATTERNS = [
56|  /validation failed, cannot remove working tree/i,
57|  /is not a \.git file/i,
58|  /is not a working tree/i,
59|  /not a git repository/i,
60|  /No such file or directory/i,
61|] as const;
62|
63|function previewError(error: unknown): string {
64|  const stderr = getErrorStderr(error);
65|  const message = error instanceof Error ? error.message : String(error);
66|  return (stderr || message).slice(0, 4096);
67|}
68|
69|function normalizeComparablePath(value: string): string {
70|  const resolved = resolve(value);
71|  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
72|}
73|
74|function porcelainContainsWorktree(stdout: string, worktreePath: string): boolean {
75|  const target = normalizeComparablePath(worktreePath);
76|  const privateTarget = target.startsWith("/var/") ? `/private${target}` : target;
77|  for (const line of stdout.split("\n")) {
78|    if (!line.startsWith("worktree ")) continue;
79|    const candidate = normalizeComparablePath(line.slice("worktree ".length).trim());
80|    if (candidate === target || candidate === privateTarget) return true;
81|  }
82|  return false;
83|}
84|
85|function isMergeTempCleanupCandidate(input: { worktreePath: string; reason: RemovalReason }, error: unknown): boolean {
86|  if (input.reason !== RemovalReason.MergerCleanup && input.reason !== RemovalReason.MergerPostMerge) return false;
87|  const base = basename(input.worktreePath);
88|  const looksLikeFusionMergeTemp = base.startsWith("fusion-ai-merge-") || base.startsWith("post-merge-");
89|  if (!looksLikeFusionMergeTemp) return false;
90|  const detail = previewError(error);
91|  return HARMLESS_MERGE_REMOVE_ERROR_PATTERNS.some((pattern) => pattern.test(detail));
92|}
93|
94|async function classifyHarmlessMergeRemoveFailure(input: {
95|  rootDir: string;
96|  worktreePath: string;
97|  reason: RemovalReason;
98|  taskId?: string;
99|  audit?: RunAuditor;
100|}, error: unknown): Promise<WorktreeRemoveOutcome | null> {
101|  if (!isMergeTempCleanupCandidate(input, error)) return null;
102|
103|  const stderrPreview = previewError(error);
104|  const pathExists = existsSync(input.worktreePath);
105|  const gitFileExists = existsSync(resolve(input.worktreePath, ".git"));
106|
107|  let stdout: string;
108|  try {
109|    await execAsync("git worktree prune", {
110|      cwd: input.rootDir,
111|      encoding: "utf-8",
112|      timeout: NATIVE_TIMEOUT_MS,
113|      maxBuffer: MAX_BUFFER,
114|    });
115|
116|    const listResult = await execAsync("git worktree list --porcelain", {
117|      cwd: input.rootDir,
118|      encoding: "utf-8",
119|      timeout: 10_000,
120|      maxBuffer: MAX_BUFFER,
121|    });
122|    stdout = typeof listResult === "string" ? listResult : String(listResult.stdout ?? "");
123|  } catch (probeError) {
124|    await input.audit?.git({
125|      type: "worktree:remove-classification-probe-failed",
126|      target: input.worktreePath,
127|      metadata: {
128|        taskId: input.taskId,
129|        reason: input.reason,
130|        stderrPreview,
131|        probeError: previewError(probeError),
132|        pathExists,
133|        gitFileExists,
134|      },
135|    });
136|    return null;
137|  }
138|  const registeredAfterPrune = porcelainContainsWorktree(stdout, input.worktreePath);
139|
140|  if (registeredAfterPrune) {
141|    await input.audit?.git({
142|      type: "worktree:remove-leaked-registered-worktree",
143|      target: input.worktreePath,
144|      metadata: {
145|        taskId: input.taskId,
146|        reason: input.reason,
147|        registeredAfterPrune: true,
148|        stderrPreview,
149|        pathExists,
150|        gitFileExists,
151|      },
152|    });
153|    return null;
154|  }
155|
156|  const message = pathExists
157|    ? "cleanup remove failed, but no registered worktree remains after prune; leftover directory was not deleted automatically"
158|    : "cleanup remove failed, but no registered worktree remains after prune";
159|  await input.audit?.git({
160|    type: "worktree:remove-classified-harmless",
161|    target: input.worktreePath,
162|    metadata: {
163|      taskId: input.taskId,
164|      reason: input.reason,
165|      classification: "not-registered-after-prune",
166|      registeredAfterPrune: false,
167|      stderrPreview,
168|      pathExists,
169|      gitFileExists,
170|      nextAction: pathExists
171|        ? "inspect the leftover temp directory before deleting filesystem residue"
172|        : "no operator action required",
173|    },
174|  });
175|
176|  return {
177|    removed: false,
178|    harmless: true,
179|    classification: "not-registered-after-prune",
180|    message,
181|    stderrPreview,
182|    pathExists,
183|    gitFileExists,
184|  };
185|}
186|
187|/**
188| * worktrunk CLI mapping (verified 2026-05-15 from README + worktrunk.dev docs):
189| * - create -> `wt switch --create <branch> [--base <startPoint>]`
190| * - remove -> `wt remove <branch> --foreground`
191| * - sync -> no dedicated `wt sync/rebase` primitive; fallback to git fetch+rebase
192| * - prune -> no dedicated `wt prune` primitive; backend-owned prune implementation
193| * - layout -> no dedicated path-query command; derive from worktrunk template/config
194| */
195|const WORKTRUNK_TIMEOUTS_MS = {
196|  create: 120_000,
197|  sync: 180_000,
198|  prune: 60_000,
199|  remove: 60_000,
200|  layout: 5_000,
201|} as const;
202|
203|export type WorktreeBackendKind = "native" | "worktrunk";
204|export type WorktreeOperation = "create" | "remove" | "sync" | "prune";
205|
206|export interface WorktreeCreateInput {
207|  rootDir: string;
208|  branch: string;
209|  worktreePath: string;
210|  startPoint?: string;
211|  taskId: string;
212|  allowSiblingBranchRename?: boolean;
213|}
214|
215|export interface WorktreeCreateResult {
216|  path: string;
217|  branch: string;
218|}
219|
220|export interface WorktreeRemoveInput {
221|  rootDir: string;
222|  worktreePath: string;
223|  branch?: string;
224|  taskId?: string;
225|  force?: boolean;
226|}
227|
228|export interface WorktreeSyncInput {
229|  rootDir: string;
230|  worktreePath: string;
231|  branch: string;
232|  trunk?: string;
233|  taskId?: string;
234|}
235|
236|export interface WorktreePruneInput {
237|  rootDir: string;
238|}
239|
240|export interface WorktreeBackend {
241|  readonly kind: WorktreeBackendKind;
242|  create(input: WorktreeCreateInput): Promise<WorktreeCreateResult>;
243|  remove(input: WorktreeRemoveInput): Promise<void>;
244|  sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }>;
245|  prune(input: WorktreePruneInput): Promise<void>;
246|  resolveWorktreePath(input: { rootDir: string; worktreeName: string; branch: string }): Promise<string>;
247|}
248|
249|export type WorktrunkOperationCode =
250|  | "worktrunk_operation_failed"
251|  | "worktrunk_binary_missing"
252|  | "worktrunk_timeout"
253|  | "worktrunk_sync_conflict"
254|  | "worktrunk_unsupported_operation";
255|
256|export class WorktrunkOperationError extends Error {
257|  readonly code: WorktrunkOperationCode;
258|  readonly operation: WorktreeOperation;
259|  readonly stderr?: string;
260|  readonly exitCode?: number | null;
261|
262|  constructor(input: {
263|    operation: WorktreeOperation;
264|    code: WorktrunkOperationCode;
265|    stderr?: string;
266|    exitCode?: number | null;
267|  }) {
268|    super(`worktrunk ${input.operation} failed`);
269|    this.name = "WorktrunkOperationError";
270|    this.operation = input.operation;
271|    this.code = input.code;
272|    this.stderr = input.stderr;
273|    this.exitCode = input.exitCode;
274|  }
275|}
276|
277|function quoteShellArg(value: string): string {
278|  return JSON.stringify(value);
279|}
280|
281|function getErrorStderr(error: unknown): string | undefined {
282|  if (!error || typeof error !== "object" || !("stderr" in error)) return undefined;
283|  const stderr = (error as { stderr?: unknown }).stderr;
284|  return stderr == null ? undefined : String(stderr);
285|}
286|
287|function getErrorExitCode(error: unknown): number | null {
288|  if (!error || typeof error !== "object") return null;
289|  const value = error as Record<string, unknown>;
290|  if (typeof value.status === "number") return value.status;
291|  if (typeof value.code === "number") return value.code;
292|  return null;
293|}
294|
295|function getErrorMessageWithStderr(error: unknown): string {
296|  const message =
297|    error instanceof Error
298|      ? error.message
299|      : error && typeof error === "object" && "message" in error
300|        ? String((error as { message?: unknown }).message)
301|        : String(error);
302|  const stderr = getErrorStderr(error);
303|  return stderr ? `${message}\n${stderr}` : message;
304|}
305|
306|function isRecoverableNativeWorktreeRemoveError(error: unknown): boolean {
307|  const message = getErrorMessageWithStderr(error);
308|  return /Directory not empty/i.test(message) || /failed to delete/i.test(message) || /contains modified or untracked files/i.test(message);
309|}
310|
311|function findStringByKey(value: unknown, key: string): string | null {
312|  if (!value || typeof value !== "object") return null;
313|  if (Array.isArray(value)) {
314|    for (const item of value) {
315|      const found = findStringByKey(item, key);
316|      if (found) return found;
317|    }
318|    return null;
319|  }
320|  const record = value as Record<string, unknown>;
321|  if (typeof record[key] === "string") return record[key] as string;
322|  for (const nested of Object.values(record)) {
323|    const found = findStringByKey(nested, key);
324|    if (found) return found;
325|  }
326|  return null;
327|}
328|
329|function parseWorktreesFromPorcelain(porcelain: string): Array<{ path: string; branch?: string }> {
330|  const lines = porcelain.split("\n");
331|  const rows: Array<{ path: string; branch?: string }> = [];
332|  let current: { path?: string; branch?: string } = {};
333|  for (const line of lines) {
334|    if (!line.trim()) {
335|      if (current.path) rows.push({ path: current.path, branch: current.branch });
336|      current = {};
337|      continue;
338|    }
339|    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length).trim();
340|    if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length).trim();
341|  }
342|  if (current.path) rows.push({ path: current.path, branch: current.branch });
343|  return rows;
344|}
345|
346|export class NativeWorktreeBackend implements WorktreeBackend {
347|  readonly kind: WorktreeBackendKind = "native";
348|
349|  constructor(
350|    private readonly deps: {
351|      logger?: { log: (m: string) => void; warn: (m: string) => void };
352|      settings?: Partial<Pick<Settings, "worktreesDir" | "commitMsgHookEnabled" | "taskPrefix" | "taskAttributionTrailerNames" | "commitAuthorEnabled" | "commitAuthorName" | "commitAuthorEmail">>;
353|      audit?: Pick<RunAuditor, "git">;
354|    } = {},
355|  ) {}
356|
357|  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
358|    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
359|    const installGuardOrCleanup = async (worktreePath: string) => {
360|      try {
361|        await installTaskWorktreeIdentityGuard({
362|          worktreePath,
363|          taskId: input.taskId,
364|          commitMsgHookEnabled: this.deps.settings?.commitMsgHookEnabled,
365|          taskPrefix: this.deps.settings?.taskPrefix,
366|          taskAttributionTrailerName: this.deps.settings?.taskAttributionTrailerNames?.[0],
367|          commitAuthorEnabled: this.deps.settings?.commitAuthorEnabled,
368|          commitAuthorName: this.deps.settings?.commitAuthorName,
369|          commitAuthorEmail: this.deps.settings?.commitAuthorEmail,
370|        });
371|      } catch (error) {
372|        await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
373|        await pruneWorktreeAdminEntries({
374|          rootDir: input.rootDir,
375|          auditor: this.deps.audit,
376|          reason: "backend-guard-failed",
377|          target: worktreePath,
378|          logger: this.deps.logger,
379|        }).catch(() => undefined);
380|        throw error;
381|      }
382|    };
383|    const createWithBranch = async (branchName: string): Promise<WorktreeCreateResult> => {
384|      await execAsync(
385|        `git worktree add -b ${quoteShellArg(branchName)} ${quoteShellArg(input.worktreePath)}${startArg}`,
386|        {
387|          cwd: input.rootDir,
388|          encoding: "utf-8",
389|          timeout: NATIVE_TIMEOUT_MS,
390|          maxBuffer: MAX_BUFFER,
391|        },
392|      );
393|      return { path: input.worktreePath, branch: branchName };
394|    };
395|
396|    const createWithBranchForce = async (branchName: string): Promise<WorktreeCreateResult> => {
397|      await execAsync(`git worktree add -f ${quoteShellArg(input.worktreePath)} ${quoteShellArg(branchName)}`, {
398|        cwd: input.rootDir,
399|        encoding: "utf-8",
400|        timeout: NATIVE_TIMEOUT_MS,
401|        maxBuffer: MAX_BUFFER,
402|      });
403|      return { path: input.worktreePath, branch: branchName };
404|    };
405|    const attachExistingBranch = async (): Promise<WorktreeCreateResult> => {
406|      await execAsync(`git worktree add ${quoteShellArg(input.worktreePath)} ${quoteShellArg(input.branch)}`, {
407|        cwd: input.rootDir,
408|        encoding: "utf-8",
409|        timeout: NATIVE_TIMEOUT_MS,
410|        maxBuffer: MAX_BUFFER,
411|      });
412|      return { path: input.worktreePath, branch: input.branch };
413|    };
414|    const cleanupPartialCollisionRecovery = async () => {
415|      await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
416|      await pruneWorktreeAdminEntries({
417|        rootDir: input.rootDir,
418|        auditor: this.deps.audit,
419|        reason: "backend-branch-collision-recovery-failed",
420|        target: input.worktreePath,
421|        logger: this.deps.logger,
422|      }).catch(() => undefined);
423|    };
424|
425|    let staleLockRecoveryAttempted = false;
426|    let staleRegistrationRecoveryAttempted = false;
427|    try {
428|      const created = await createWithBranch(input.branch);
429|      await installGuardOrCleanup(created.path);
430|      return created;
431|    } catch (error) {
432|      const lockPath = parseIndexLockPath(`${(error as { message?: string })?.message ?? ""}\n${getErrorStderr(error) ?? ""}`);
433|      if (lockPath && !staleLockRecoveryAttempted) {
434|        staleLockRecoveryAttempted = true;
435|        const classification = await classifyStaleLock({
436|          rootDir: input.rootDir,
437|          lockPath,
438|          activeSessionRegistry,
439|        });
440|        await this.deps.audit?.git({
441|          type: "worktree:stale-lock-detected",
442|          target: input.worktreePath,
443|          metadata: {
444|            lockPath,
445|            classification: classification.kind,
446|            reason: classification.reason,
447|            ageMs: classification.ageMs ?? null,
448|            owningWorktreePath: classification.owningWorktreePath ?? null,
449|          },
450|        });
451|        if (classification.kind === "stale") {
452|          try {
453|            const removed = await tryRemoveStaleLock({ lockPath: resolve(input.rootDir, lockPath) });
454|            if (removed.removed) {
455|              await this.deps.audit?.git({
456|                type: "worktree:stale-lock-recovered",
457|                target: input.worktreePath,
458|                metadata: { lockPath },
459|              });
460|              const created = await createWithBranch(input.branch);
461|              await installGuardOrCleanup(created.path);
462|              return created;
463|            }
464|            await this.deps.audit?.git({
465|              type: "worktree:stale-lock-recovery-failed",
466|              target: input.worktreePath,
467|              metadata: { lockPath, reason: removed.reason ?? "not-removed" },
468|            });
469|          } catch (removeError) {
470|            await this.deps.audit?.git({
471|              type: "worktree:stale-lock-recovery-failed",
472|              target: input.worktreePath,
473|              metadata: { lockPath, reason: formatError(removeError).detail },
474|            });
475|          }
476|        } else {
477|          await this.deps.audit?.git({
478|            type: "worktree:stale-lock-refused",
479|            target: input.worktreePath,
480|            metadata: {
481|              lockPath,
482|              classification: classification.kind,
483|              reason: classification.reason,
484|              ageMs: classification.ageMs ?? null,
485|              owningWorktreePath: classification.owningWorktreePath ?? null,
486|            },
487|          });
488|          throw new StaleWorktreeIndexLockError({
489|            message: `Worktree creation blocked: index.lock at ${resolve(input.rootDir, lockPath)} is held by another git process (reason: ${classification.reason}). Resolve manually before retrying.`,
490|            lockPath: resolve(input.rootDir, lockPath),
491|            classification: classification.kind,
492|            reason: classification.reason,
493|          });
494|        }
495|      }
496|
497|      const combinedErrorOutput = `${(error as { message?: string })?.message ?? ""}\n${getErrorStderr(error) ?? ""}`;
498|      const staleRegistrationPath = parseStaleRegistrationPath(combinedErrorOutput);
499|      if (staleRegistrationPath && !staleRegistrationRecoveryAttempted) {
500|        staleRegistrationRecoveryAttempted = true;
501|        await this.deps.audit?.git({
502|          type: "worktree:stale-registration-detected",
503|          target: input.worktreePath,
504|          metadata: { staleRegistrationPath, worktreePath: input.worktreePath },
505|        });
506|        const recovery = await recoverStaleRegistration({
507|          rootDir: input.rootDir,
508|          worktreePath: input.worktreePath,
509|          logger: this.deps.logger,
510|        });
511|        if (recovery.recovered) {
512|          try {
513|            const created = await createWithBranch(input.branch);
514|            await this.deps.audit?.git({
515|              type: "worktree:stale-registration-recovered",
516|              target: input.worktreePath,
517|              metadata: { actions: recovery.actions },
518|            });
519|            await installGuardOrCleanup(created.path);
520|            return created;
521|          } catch (retryError) {
522|            const actionsWithForce = [...recovery.actions, "add-force-retry"];
523|            try {
524|              const created = await createWithBranchForce(input.branch);
525|              await this.deps.audit?.git({
526|                type: "worktree:stale-registration-recovered",
527|                target: input.worktreePath,
528|                metadata: { actions: actionsWithForce },
529|              });
530|              await installGuardOrCleanup(created.path);
531|              return created;
532|            } catch (forceError) {
533|              await this.deps.audit?.git({
534|                type: "worktree:stale-registration-recovery-failed",
535|                target: input.worktreePath,
536|                metadata: {
537|                  actions: actionsWithForce,
538|                  reason: `${formatError(retryError).detail}; force-retry: ${formatError(forceError).detail}`,
539|                },
540|              });
541|              throw error;
542|            }
543|          }
544|        }
545|        await this.deps.audit?.git({
546|          type: "worktree:stale-registration-recovery-failed",
547|          target: input.worktreePath,
548|          metadata: { actions: recovery.actions, reason: recovery.reason ?? "unknown" },
549|        });
550|      }
551|
552|      const isBareBranchCollision = /(?:a\s+)?branch named ["']?.+["']? already exists|branch ["']?.+["']? already exists/i.test(combinedErrorOutput);
553|      if (isBareBranchCollision) {
554|          /*
555|           * FNXC:WorktreeAcquisition 2026-07-16-00:00:
556|           * FN-8132 / #2232 recovers only a bare branch-name collision after the
557|           * stale-lock and stale-registration ladder. A live foreign checkout still
558|           * fails even when this target path is absent. Unregistered branches are
559|           * attached only when every unique commit belongs to this task; merged or
560|           * empty branches are recreated from the caller-pinned startPoint, while
561|           * any foreign/unattributed (including mixed) history is never deleted.
562|           */
563|          const inspection = await inspectBareBranchCollision({
564|            repoDir: input.rootDir,
565|            branchName: input.branch,
566|            conflictingWorktreePath: input.worktreePath,
567|            requestingTaskId: input.taskId,
568|            startPoint: input.startPoint,
569|            integrationRef: await resolveIntegrationBranch(input.rootDir, undefined),
570|          });
571|          if (inspection.kind === "live-foreign") {
572|            await this.deps.audit?.git({
573|              type: "worktree:branch-collision-recovery",
574|              target: input.worktreePath,
575|              metadata: { taskId: input.taskId, disposition: "threw-live-foreign" },
576|            });
577|            throw inspection.error;
578|          }
579|          if (inspection.kind === "foreign-unmerged") {
580|            await this.deps.audit?.git({
581|              type: "worktree:branch-collision-recovery",
582|              target: input.worktreePath,
583|              metadata: { taskId: input.taskId, disposition: "refused-foreign-unmerged", uniqueCommitCount: inspection.uniqueCommitCount },
584|            });
585|            throw inspection.error;
586|          }
587|          if (inspection.kind === "reclaimable") {
588|            try {
589|              const created = await attachExistingBranch();
590|              await installGuardOrCleanup(created.path);
591|              await this.deps.audit?.git({
592|                type: "worktree:branch-collision-recovery",
593|                target: input.worktreePath,
594|                metadata: { taskId: input.taskId, disposition: "reuse-existing-branch", uniqueCommitCount: inspection.uniqueCommitCount },
595|              });
596|              return created;
597|            } catch (recoveryError) {
598|              await cleanupPartialCollisionRecovery();
599|              throw recoveryError;
600|            }
601|          }
602|          if (inspection.kind === "tip-already-merged" || inspection.kind === "fully-subsumed") {
603|            try {
604|              await execAsync(`git branch -D ${quoteShellArg(input.branch)}`, {
605|                cwd: input.rootDir,
606|                encoding: "utf-8",
607|                timeout: NATIVE_TIMEOUT_MS,
608|                maxBuffer: MAX_BUFFER,
609|              });
610|              const created = await createWithBranch(input.branch);
611|              await installGuardOrCleanup(created.path);
612|              await this.deps.audit?.git({
613|                type: "worktree:branch-collision-recovery",
614|                target: input.worktreePath,
615|                metadata: { taskId: input.taskId, disposition: "recreate-from-startpoint" },
616|              });
617|              return created;
618|            } catch (recoveryError) {
619|              await cleanupPartialCollisionRecovery();
620|              throw recoveryError;
621|            }
622|          }
623|      }
624|
625|      if (!input.allowSiblingBranchRename) {
626|        throw error;
627|      }
628|
629|      for (let suffix = 2; suffix <= 50; suffix += 1) {
630|        const candidateBranch = `${input.branch}-${suffix}`;
631|        try {
632|          const created = await createWithBranch(candidateBranch);
633|          await installGuardOrCleanup(created.path);
634|          return created;
635|        } catch {
636|          // continue probing suffixes
637|        }
638|      }
639|
640|      let inspection: Awaited<ReturnType<typeof inspectBranchConflict>> | null = null;
641|      try {
642|        inspection = await inspectBranchConflict({
643|          repoDir: input.rootDir,
644|          branchName: input.branch,
645|          conflictingWorktreePath: input.worktreePath,
646|          requestingTaskId: input.taskId,
647|          startPoint: input.startPoint,
648|          integrationRef: await resolveIntegrationBranch(input.rootDir, undefined),
649|        });
650|      } catch (inspectError) {
651|        this.deps.logger?.warn?.(
652|          `[worktree-backend] ${input.taskId}: failed to inspect branch conflict: ${formatError(inspectError).detail}`,
653|        );
654|      }
655|
656|      if (inspection?.kind === "live-foreign") {
657|        throw inspection.error;
658|      }
659|
660|      throw error;
661|    }
662|  }
663|
664|  async remove(input: WorktreeRemoveInput): Promise<void> {
665|    // FNXC:WorktreeCleanup 2026-08-15-13:45: explicit false lets Git revalidate
666|    // cleanliness; omission preserves the backend's legacy forced removal.
667|    const force = input.force !== false;
668|    try {
669|      await execAsync(`git worktree remove${force ? " --force" : ""} ${quoteShellArg(input.worktreePath)}`, {
670|        cwd: input.rootDir,
671|        encoding: "utf-8",
672|        timeout: REMOVE_TIMEOUT_MS,
673|        maxBuffer: MAX_BUFFER,
674|      });
675|      return;
676|    } catch (error) {
677|      if (!force) {
678|        const missingPathError = /is not a working tree|no such file or directory|does not exist/i.test(getErrorMessageWithStderr(error));
679|        if (!existsSync(input.worktreePath) && missingPathError) {
680|          await pruneWorktreeAdminEntries({
681|            rootDir: input.rootDir,
682|            auditor: this.deps.audit,
683|            reason: "remove-missing-fallback",
684|            target: input.worktreePath,
685|            logger: this.deps.logger,
686|          });
687|          return;
688|        }
689|        throw error;
690|      }
691|      if (!isRecoverableNativeWorktreeRemoveError(error)) {
692|        throw error;
693|      }
694|
695|      const errorMessage = getErrorMessageWithStderr(error);
696|      this.deps.logger?.warn?.(
697|        `[worktree-backend] git worktree remove failed for ${input.worktreePath}: ${errorMessage} — falling back to filesystem removal`,
698|      );
699|      await this.deps.audit?.git({
700|        type: "worktree:remove-fallback",
701|        target: input.worktreePath,
702|        metadata: {
703|          fallback: "filesystem-non-empty",
704|          error: errorMessage,
705|        },
706|      });
707|
708|      await rm(input.worktreePath, { recursive: true, force: true });
709|      await pruneWorktreeAdminEntries({
710|        rootDir: input.rootDir,
711|        auditor: this.deps.audit,
712|        reason: "remove-non-empty-fallback",
713|        target: input.worktreePath,
714|        logger: this.deps.logger,
715|      });
716|    }
717|  }
718|
719|  async sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
720|    await execAsync("git fetch --all --prune", {
721|      cwd: input.worktreePath,
722|      encoding: "utf-8",
723|      timeout: NATIVE_TIMEOUT_MS,
724|      maxBuffer: MAX_BUFFER,
725|    });
726|
727|    await execAsync(`git rebase ${quoteShellArg(input.trunk ? input.trunk : `origin/${input.branch}`)}`, {
728|      cwd: input.worktreePath,
729|      encoding: "utf-8",
730|      timeout: NATIVE_TIMEOUT_MS,
731|      maxBuffer: MAX_BUFFER,
732|    });
733|
734|    return { skipped: false };
735|  }
736|
737|  async prune(input: WorktreePruneInput): Promise<void> {
738|    await execAsync("git worktree prune", {
739|      cwd: input.rootDir,
740|      encoding: "utf-8",
741|      timeout: NATIVE_TIMEOUT_MS,
742|      maxBuffer: MAX_BUFFER,
743|    });
744|  }
745|
746|  async resolveWorktreePath(input: { rootDir: string; worktreeName: string; branch: string }): Promise<string> {
747|    return resolveTaskWorktreePath(input.rootDir, this.deps.settings, input.worktreeName);
748|  }
749|}
750|
751|type WorktrunkOperation = keyof typeof WORKTRUNK_TIMEOUTS_MS;
752|
753|export class WorktrunkWorktreeBackend implements WorktreeBackend {
754|  readonly kind: WorktreeBackendKind = "worktrunk";
755|  private resolvedBinaryPath: string | null = null;
756|
757|  constructor(
758|    private readonly deps: {
759|      binaryPath: string | (() => Promise<string | null>) | null;
760|      logger?: { log: (m: string) => void; warn: (m: string) => void };
761|      audit?: Pick<RunAuditor, "git">;
762|      settings?: Partial<Pick<Settings, "commitMsgHookEnabled" | "taskPrefix" | "taskAttributionTrailerNames" | "commitAuthorEnabled" | "commitAuthorName" | "commitAuthorEmail">>;
763|    },
764|  ) {}
765|
766|  private async resolveBinaryPathFromDeps(operation: WorktrunkOperation): Promise<string> {
767|    if (typeof this.deps.binaryPath === "string") {
768|      const literalPath = this.deps.binaryPath.trim();
769|      if (literalPath) return literalPath;
770|    }
771|
772|    if (typeof this.deps.binaryPath === "function") {
773|      if (this.resolvedBinaryPath) return this.resolvedBinaryPath;
774|      const resolvedPath = (await this.deps.binaryPath())?.trim() ?? "";
775|      if (!resolvedPath) {
776|        throw new WorktrunkOperationError({
777|          operation: operation === "layout" ? "create" : operation,
778|          code: "worktrunk_binary_missing",
779|          stderr: "worktrunk binary not configured",
780|          exitCode: null,
781|        });
782|      }
783|      this.resolvedBinaryPath = resolvedPath;
784|      return resolvedPath;
785|    }
786|
787|    throw new WorktrunkOperationError({
788|      operation: operation === "layout" ? "create" : operation,
789|      code: "worktrunk_binary_missing",
790|      stderr: "worktrunk binary not configured",
791|      exitCode: null,
792|    });
793|  }
794|
795|  private async getBinaryPath(operation: WorktrunkOperation): Promise<string> {
796|    const binaryPath = await this.resolveBinaryPathFromDeps(operation);
797|    try {
798|      await access(binaryPath);
799|    } catch {
800|      if (binaryPath.includes("/") || binaryPath.includes("\\")) {
801|        throw new WorktrunkOperationError({
802|          operation: operation === "layout" ? "create" : operation,
803|          code: "worktrunk_binary_missing",
804|          stderr: `worktrunk binary not found at path: ${binaryPath}`,
805|          exitCode: null,
806|        });
807|      }
808|    }
809|    return binaryPath;
810|  }
811|
812|  private async runWorktrunk(
813|    args: string[],
814|    opts: { cwd: string; operation: WorktrunkOperation; signal?: AbortSignal },
815|  ): Promise<{ stdout: string; stderr: string }> {
816|    const binaryPath = await this.getBinaryPath(opts.operation);
817|    this.deps.logger?.log?.(`[worktree-backend] running worktrunk command: ${binaryPath} ${args.join(" ")}`);
818|
819|    try {
820|      const command = `${quoteShellArg(binaryPath)} ${args.map((arg) => quoteShellArg(arg)).join(" ")}`;
821|      return await execAsync(command, {
822|        cwd: opts.cwd,
823|        encoding: "utf-8",
824|        timeout: WORKTRUNK_TIMEOUTS_MS[opts.operation],
825|        maxBuffer: MAX_BUFFER,
826|        signal: opts.signal,
827|      });
828|    } catch (error) {
829|      const stderr = getErrorStderr(error) ?? String(error);
830|      const signal =
831|        error && typeof error === "object" && "signal" in error
832|          ? ((error as { signal?: unknown }).signal as string | null | undefined)
833|          : undefined;
834|      const syscallCode =
835|        error && typeof error === "object" && "code" in error
836|          ? ((error as { code?: unknown }).code as string | number | undefined)
837|          : undefined;
838|      const exitCode = getErrorExitCode(error);
839|      const op = opts.operation === "layout" ? "create" : opts.operation;
840|      let code: WorktrunkOperationCode = "worktrunk_operation_failed";
841|      if (syscallCode === "ENOENT") {
842|        code = "worktrunk_binary_missing";
843|      } else if (signal === "SIGTERM") {
844|        code = "worktrunk_timeout";
845|      }
846|      this.deps.logger?.warn?.(`[worktree-backend] worktrunk ${opts.operation} failed: ${stderr}`);
847|      throw new WorktrunkOperationError({ operation: op, code, stderr, exitCode });
848|    }
849|  }
850|
851|  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
852|    const args = ["switch", "--create", input.branch, "--no-hooks", "--no-cd"];
853|    if (input.startPoint) args.push("--base", input.startPoint);
854|    await this.runWorktrunk(args, { cwd: input.rootDir, operation: "create" });
855|
856|    const resolvedPath = await this.resolveCreatedWorktreePath({
857|      rootDir: input.rootDir,
858|      branch: input.branch,
859|    });
860|    if (resolvedPath !== input.worktreePath) {
861|      this.deps.logger?.warn?.(
862|        `[worktree-backend] worktrunk created branch ${input.branch} at ${resolvedPath} (fusion assumed ${input.worktreePath}); using worktrunk-assigned path`,
863|      );
864|    }
865|
866|    try {
867|      await installTaskWorktreeIdentityGuard({
868|        worktreePath: resolvedPath,
869|        taskId: input.taskId,
870|        commitMsgHookEnabled: this.deps.settings?.commitMsgHookEnabled,
871|        taskPrefix: this.deps.settings?.taskPrefix,
872|        taskAttributionTrailerName: this.deps.settings?.taskAttributionTrailerNames?.[0],
873|        commitAuthorEnabled: this.deps.settings?.commitAuthorEnabled,
874|        commitAuthorName: this.deps.settings?.commitAuthorName,
875|        commitAuthorEmail: this.deps.settings?.commitAuthorEmail,
876|      });
877|    } catch (error) {
878|      await rm(resolvedPath, { recursive: true, force: true }).catch(() => undefined);
879|      await pruneWorktreeAdminEntries({
880|        rootDir: input.rootDir,
881|        auditor: this.deps.audit,
882|        reason: "backend-guard-failed",
883|        target: resolvedPath,
884|        logger: this.deps.logger,
885|      }).catch(() => undefined);
886|      throw error;
887|    }
888|    return { path: resolvedPath, branch: input.branch };
889|  }
890|
891|  private async resolveCreatedWorktreePath(input: { rootDir: string; branch: string }): Promise<string> {
892|    let rows: Array<{ path: string; branch?: string }>;
893|    try {
894|      const { stdout } = await execAsync("git worktree list --porcelain", {
895|        cwd: input.rootDir,
896|        encoding: "utf-8",
897|        timeout: 30_000,
898|        maxBuffer: MAX_BUFFER,
899|      });
900|      rows = parseWorktreesFromPorcelain(stdout);
901|    } catch (error) {
902|      throw new WorktrunkOperationError({
903|        operation: "create",
904|        code: "worktrunk_operation_failed",
905|        stderr: getErrorStderr(error) ?? String(error),
906|        exitCode: getErrorExitCode(error),
907|      });
908|    }
909|
910|    const matches = rows.filter((row) => row.branch === input.branch);
911|    if (matches.length === 0) {
912|      throw new WorktrunkOperationError({
913|        operation: "create",
914|        code: "worktrunk_operation_failed",
915|        stderr: `worktrunk created branch ${input.branch} but no registered worktree was found`,
916|        exitCode: null,
917|      });
918|    }
919|    if (matches.length > 1) {
920|      throw new WorktrunkOperationError({
921|        operation: "create",
922|        code: "worktrunk_operation_failed",
923|        stderr: `worktrunk created branch ${input.branch} but multiple registered worktrees claim it: ${matches.map((match) => match.path).join(", ")}`,
924|        exitCode: null,
925|      });
926|    }
927|
928|    const resolvedPath = matches[0]?.path;
929|    if (!resolvedPath || !existsSync(resolvedPath)) {
930|      throw new WorktrunkOperationError({
931|        operation: "create",
932|        code: "worktrunk_operation_failed",
933|        stderr: `worktrunk reported worktree at ${resolvedPath ?? "<unknown>"} but the path does not exist`,
934|        exitCode: null,
935|      });
936|    }
937|
938|    return resolvedPath;
939|  }
940|
941|  async remove(input: WorktreeRemoveInput): Promise<void> {
942|    const target = input.branch ?? input.worktreePath;
943|    const args = ["remove", "--foreground", ...(input.force ? ["--force"] : []), target];
944|    try {
945|      await this.runWorktrunk(args, {
946|        cwd: input.rootDir,
947|        operation: "remove",
948|      });
949|    } catch (error) {
950|      if (
951|        error instanceof WorktrunkOperationError &&
952|        error.code === "worktrunk_operation_failed" &&
953|        /(not managed|not found|already removed)/i.test(error.stderr ?? "")
954|      ) {
955|        return;
956|      }
957|      throw error;
958|    }
959|  }
960|
961|  async sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
962|    try {
963|      const trunk = input.trunk ?? await resolveIntegrationBranch(input.rootDir, undefined);
964|      await execAsync(`git fetch origin ${quoteShellArg(trunk)}`, {
965|        cwd: input.worktreePath,
966|        encoding: "utf-8",
967|        timeout: WORKTRUNK_TIMEOUTS_MS.sync,
968|        maxBuffer: MAX_BUFFER,
969|      });
970|      await execAsync(`git rebase ${quoteShellArg(trunk)}`, {
971|        cwd: input.worktreePath,
972|        encoding: "utf-8",
973|        timeout: WORKTRUNK_TIMEOUTS_MS.sync,
974|        maxBuffer: MAX_BUFFER,
975|      });
976|      return { skipped: false };
977|    } catch (error) {
978|      const stderr = getErrorStderr(error) ?? String(error);
979|      if (/conflict|could not apply|resolve all conflicts/i.test(stderr)) {
980|        throw new WorktrunkOperationError({
981|          operation: "sync",
982|          code: "worktrunk_sync_conflict",
983|          stderr,
984|          exitCode: getErrorExitCode(error),
985|        });
986|      }
987|      throw new WorktrunkOperationError({
988|        operation: "sync",
989|        code: "worktrunk_operation_failed",
990|        stderr,
991|        exitCode: getErrorExitCode(error),
992|      });
993|    }
994|  }
995|
996|  async prune(input: WorktreePruneInput): Promise<void> {
997|    const { stdout } = await execAsync("git worktree list --porcelain", {
998|      cwd: input.rootDir,
999|      encoding: "utf-8",
1000|      timeout: WORKTRUNK_TIMEOUTS_MS.prune,
1001|      maxBuffer: MAX_BUFFER,
1002|    });
1003|    const rows = parseWorktreesFromPorcelain(stdout).filter(
1004|      (row) => row.path !== input.rootDir && row.path.includes(".worktrees") && row.branch,
1005|    );
1006|    for (const row of rows) {
1007|      await this.remove({ rootDir: input.rootDir, worktreePath: row.path, branch: row.branch });
1008|    }
1009|  }
1010|
1011|  async resolveWorktreePath(input: { rootDir: string; worktreeName: string; branch: string }): Promise<string> {
1012|    const template = await this.resolveWorktrunkTemplate(input.rootDir);
1013|    const sanitizedBranch = input.branch.replace(/[\\/]/g, "-");
1014|    const expanded = template
1015|      .replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~")
1016|      .replace(/\{\{\s*repo_path\s*\}\}/g, input.rootDir)
1017|      .replace(/\{\{\s*repo\s*\}\}/g, basename(input.rootDir))
1018|      .replace(/\{\{\s*branch\s*\|\s*sanitize\s*\}\}/g, sanitizedBranch)
1019|      .replace(/\{\{\s*branch\s*\}\}/g, input.branch);
1020|    return resolve(input.rootDir, expanded);
1021|  }
1022|
1023|  private async resolveWorktrunkTemplate(rootDir: string): Promise<string> {
1024|    try {
1025|      const { stdout } = await this.runWorktrunk(["config", "show", "--format", "json"], {
1026|        cwd: rootDir,
1027|        operation: "layout",
1028|      });
1029|      const parsed = JSON.parse(stdout) as Record<string, unknown>;
1030|      const fromJson = findStringByKey(parsed, "worktree-path");
1031|      if (fromJson) return fromJson;
1032|    } catch {
1033|      // fall back to documented default template when config cannot be read.
1034|    }
1035|    return "{{ repo_path }}/.worktrees/{{ branch | sanitize }}";
1036|  }
1037|}
1038|
1039|export const RemovalReason = {
1040|  HardCancel: "hard-cancel",
1041|  ExecutorTransientRetry: "executor-transient-retry",
1042|  ExecutorStuckKilled: "executor-stuck-killed",
1043|  ExecutorDispose: "executor-dispose",
1044|  StepSessionCleanup: "step-session-cleanup",
1045|  MergerPostMerge: "merger-post-merge",
1046|  MergerCleanup: "merger-cleanup",
1047|  SelfHealingReclaim: "self-healing-reclaim",
1048|  SelfHealingStaleActiveBranch: "self-healing-stale-active-branch",
1049|  SelfHealingBranchConflict: "self-healing-branch-conflict",
1050|  SelfHealingIdleSweep: "self-healing-idle-sweep",
1051|  PoolPrune: "pool-prune",
1052|} as const;
1053|
1054|export type RemovalReason = typeof RemovalReason[keyof typeof RemovalReason];
1055|
1056|const ALLOWED_FORCE_REASONS = new Set<RemovalReason>([
1057|  RemovalReason.HardCancel,
1058|  RemovalReason.ExecutorDispose,
1059|  RemovalReason.ExecutorTransientRetry,
1060|  RemovalReason.ExecutorStuckKilled,
1061|]);
1062|
1063|export class InvalidForceUsageError extends Error {
1064|  constructor(reason: RemovalReason) {
1065|    super(`force=true is not allowed for removal reason '${reason}'`);
1066|    this.name = "InvalidForceUsageError";
1067|  }
1068|}
1069|
1070|export class ActiveSessionWorktreeRemovalError extends Error {
1071|  constructor(public readonly details: {
1072|    worktreePath: string;
1073|    taskId: string;
1074|    kind: string;
1075|    ownerKey: string;
1076|    reason: RemovalReason;
1077|  }) {
1078|    super(`cannot remove active-session worktree ${details.worktreePath} (${details.taskId}/${details.kind})`);
1079|    this.name = "ActiveSessionWorktreeRemovalError";
1080|  }
1081|}
1082|
1083|/**
1084| * Remove a worktree via configured backend.
1085| * Only executor-owned hard-cancel/dispose paths may use force=true.
1086| */
1087|export async function removeWorktree(input: {
1088|  worktreePath: string;
1089|  rootDir: string;
1090|  settings: Partial<Settings>;
1091|  reason: RemovalReason;
1092|  taskId?: string;
1093|  allowDirtyReclaim?: boolean;
1094|  audit?: RunAuditor;
1095|  force?: boolean;
1096|  timeout?: number;
1097|  expectedOwnerTaskId?: string;
1098|  liveOwnerProbe?: LiveBindingProbe;
1099|  processActiveProbe?: ProcessActiveProbe;
1100|  reconcileMinIdleMs?: number;
1101|}): Promise<WorktreeRemoveOutcome> {
1102|  const logger = {
1103|    log: (_message: string): void => {},
1104|    warn: (_message: string): void => {},
1105|  };
1106|
1107|  if (input.force === true && !ALLOWED_FORCE_REASONS.has(input.reason)) {
1108|    throw new InvalidForceUsageError(input.reason);
1109|  }
1110|
1111|  if (input.expectedOwnerTaskId && input.liveOwnerProbe) {
1112|    const reconciled = reconcileSelfOwnedActiveSessionForRemoval(
1113|      activeSessionRegistry,
1114|      input.worktreePath,
1115|      input.expectedOwnerTaskId,
1116|      input.liveOwnerProbe,
1117|      {
1118|        processActiveProbe: input.processActiveProbe,
1119|        minIdleMs: input.reconcileMinIdleMs,
1120|      },
1121|    );
1122|    if (reconciled.action === "reconciled") {
1123|      await input.audit?.git({
1124|        type: "worktree:active-session-reconciled",
1125|        target: input.worktreePath,
1126|        metadata: { taskId: input.expectedOwnerTaskId, source: "removeWorktree-defensive" },
1127|      });
1128|    }
1129|  }
1130|
1131|  const active = activeSessionRegistry.lookupByPath(input.worktreePath);
1132|  if (active && input.force !== true) {
1133|    await input.audit?.git({
1134|      type: "worktree:removal-refused-active-session",
1135|      target: input.worktreePath,
1136|      metadata: { taskId: active.taskId, reason: input.reason, kind: active.kind },
1137|    });
1138|    throw new ActiveSessionWorktreeRemovalError({
1139|      worktreePath: input.worktreePath,
1140|      taskId: active.taskId,
1141|      kind: active.kind,
1142|      ownerKey: active.ownerKey,
1143|      reason: input.reason,
1144|    });
1145|  }
1146|
1147|  if (active && input.force === true) {
1148|    await input.audit?.git({
1149|      type: "worktree:removal-forced-over-active-session",
1150|      target: input.worktreePath,
1151|      metadata: { taskId: active.taskId, reason: input.reason, kind: active.kind },
1152|    });
1153|  }
1154|
1155|  const requiresDirtyRevalidation = input.reason === RemovalReason.SelfHealingIdleSweep || (input.reason === RemovalReason.PoolPrune && input.allowDirtyReclaim !== true);
1156|  if (requiresDirtyRevalidation) {
1157|    let rootOutput = "";
1158|    try {
1159|      ({ stdout: rootOutput } = await execFileAsync("git", ["-C", input.worktreePath, "rev-parse", "--show-toplevel"], {
1160|        cwd: input.rootDir,
1161|        timeout: 15_000,
1162|        maxBuffer: MAX_BUFFER,
1163|      }));
1164|    } catch {
1165|      if (existsSync(input.worktreePath)) {
1166|        throw new Error(`refusing to remove worktree with unverifiable root: ${input.worktreePath}`);
1167|      }
1168|    }
1169|    if (rootOutput && canonicalWorktreePath(rootOutput.trim()) !== canonicalWorktreePath(input.worktreePath)) {
1170|      throw new Error(`refusing to remove worktree with unverifiable root: ${input.worktreePath}`);
1171|    }
1172|    if (rootOutput) {
1173|      const { stdout: statusOutput } = await execFileAsync("git", ["-C", input.worktreePath, "status", "--porcelain", "--untracked-files=all", "--ignored"], {
1174|        cwd: input.rootDir,
1175|        timeout: 15_000,
1176|        maxBuffer: MAX_BUFFER,
1177|      });
1178|      if (statusOutput.trim().length > 0) {
1179|        throw new Error(`refusing to remove dirty worktree: ${input.worktreePath}`);
1180|      }
1181|    }
1182|  }
1183|
1184|  const backend = resolveWorktreeBackend(input.settings, { logger, audit: input.audit });
1185|  const removeInput: WorktreeRemoveInput = {
1186|    rootDir: input.rootDir,
1187|    worktreePath: input.worktreePath,
1188|    taskId: input.taskId,
1189|    force: input.force === true || !requiresDirtyRevalidation,
1190|  };
1191|
1192|  if (input.force === false || typeof input.timeout === "number") {
1193|    // Backwards-compatible helper signature for callers that carried raw git flags/timeouts.
1194|    // Current backend remove implementations are forceful and use backend-owned timeouts.
1195|  }
1196|
1197|  try {
1198|    await backend.remove(removeInput);
1199|    if (input.audit) {
1200|      await input.audit.git({
1201|        type: backend.kind === "worktrunk" ? "worktree:worktrunk-remove" : "worktree:remove",
1202|        target: input.worktreePath,
1203|      });
1204|    }
1205|    return { removed: true, classification: "removed" };
1206|  } catch (error) {
1207|    const classified = await classifyHarmlessMergeRemoveFailure(input, error);
1208|    if (classified) return classified;
1209|
1210|    if (!(error instanceof WorktrunkOperationError) || input.settings.worktrunk?.onFailure !== "fallback-native") {
1211|      throw error;
1212|    }
1213|
1214|    logger.warn(`[worktree-backend] falling back to native remove for ${input.worktreePath}`);
1215|
1216|    await input.audit?.git({
1217|      type: "worktree:worktrunk-fallback",
1218|      target: input.worktreePath,
1219|      metadata: {
1220|        op: "fallback-native",
1221|        stderrPreview: error.stderr?.slice(0, 4096),
1222|        exitCode: error.exitCode ?? null,
1223|      },
1224|    });
1225|
1226|    const native = new NativeWorktreeBackend({ logger, settings: input.settings });
1227|    try {
1228|      await native.remove(removeInput);
1229|      await input.audit?.git({ type: "worktree:remove", target: input.worktreePath });
1230|      return { removed: true, classification: "removed" };
1231|    } catch (nativeError) {
1232|      const classified = await classifyHarmlessMergeRemoveFailure(input, nativeError);
1233|      if (classified) return classified;
1234|      throw nativeError;
1235|    }
1236|  }
1237|}
1238|
1239|export function resolveWorktreeBackend(
1240|  settings: Partial<Settings>,
1241|  deps: {
1242|    logger?: { log: (m: string) => void; warn: (m: string) => void };
1243|    binaryPathResolver?: () => Promise<string | null>;
1244|    audit?: Pick<RunAuditor, "git">;
1245|  } = {},
1246|): WorktreeBackend {
1247|  if (settings.worktrunk?.enabled === true) {
1248|    // FN-4681 wires binaryPathResolver from worktree-acquisition; precedence is literal setting > resolver > null.
1249|    const configuredBinaryPath = settings.worktrunk.binaryPath?.trim() ?? "";
1250|    const binaryPath = configuredBinaryPath ? configuredBinaryPath : deps.binaryPathResolver ?? null;
1251|    return new WorktrunkWorktreeBackend({
1252|      binaryPath,
1253|      logger: deps.logger,
1254|      settings,
1255|    });
1256|  }
1257|
1258|  return new NativeWorktreeBackend({ logger: deps.logger, settings, audit: deps.audit });
1259|}
1260|