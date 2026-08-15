1|import { createHash } from "node:crypto";
2|import { execFile } from "node:child_process";
3|import { promises as fs } from "node:fs";
4|import path from "node:path";
5|import { promisify } from "node:util";
6|import type { ProjectSettings, SecretsStore } from "@fusion/core";
7|import type { RunAuditor } from "../util/run-audit.js";
8|
9|export const FINGERPRINT_FILE = ".fusion-secrets-env.fingerprint";
10|const HEADER_PREFIX = "# Managed by Fusion — do not edit by hand.";
11|const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
12|const VALID_FINGERPRINT = /^[0-9a-f]{64}$/;
13|const execFileAsync = promisify(execFile);
14|
15|export type WriteSkipReason = "disabled" | "no-secrets" | "not-gitignored" | "skip-existing" | "invalid-filename" | "no-store" | "list-failed" | "record-reconciliation-failed";
16|export type CleanupSkipReason = "fingerprint-mismatch" | "file-missing" | "no-record" | "disabled" | "stat-failed" | "ambiguous-record" | "invalid-record" | "tracked-file" | "record-remove-failed";
17|export type FingerprintReconciliationOutcome = "clean" | "adopted-legacy" | "removed-legacy" | "recovered-private" | "conflict" | "invalid-record" | "tracked-record" | "git-dir-unavailable" | "private-record-write-failed" | "legacy-remove-failed";
18|
19|export interface WriteSecretsEnvFileOptions {
20|  rootDir: string;
21|  worktreePath: string;
22|  taskId: string;
23|  settings: Pick<ProjectSettings, "secretsEnv">;
24|  worktreeSource: "pool" | "fresh";
25|  secretsStore?: Pick<SecretsStore, "listEnvExportable">;
26|  audit?: Pick<RunAuditor, "filesystem">;
27|  logger?: { log: (m: string) => void; warn: (m: string) => void; error?: (m: string) => void };
28|  execFileImpl?: typeof execFile;
29|}
30|
31|export interface WriteSecretsEnvFileResult {
32|  outcome: "written" | "skipped";
33|  filename: string;
34|  reason?: WriteSkipReason;
35|  keyCount?: number;
36|  fingerprint?: string;
37|}
38|
39|export interface CleanupSecretsEnvFileOptions {
40|  worktreePath: string;
41|  taskId: string;
42|  expectedFingerprint: string | null;
43|  filename: string;
44|  audit?: Pick<RunAuditor, "filesystem">;
45|  logger?: { log: (m: string) => void; warn: (m: string) => void };
46|  /** Test seam for proving cleanup never converts metadata-removal failures into success. */
47|  removeRecordPaths?: (recordPaths: string[]) => Promise<void>;
48|}
49|
50|export interface CleanupSecretsEnvFileResult {
51|  outcome: "cleaned" | "skipped";
52|  reason?: CleanupSkipReason | "fingerprint-match" | "directory-missing";
53|}
54|
55|export interface ReconcileSecretsEnvFingerprintResult {
56|  executionSafe: boolean;
57|  outcome: FingerprintReconciliationOutcome;
58|}
59|
60|interface ReconcileSecretsEnvFingerprintOptions {
61|  /** Test seam for proving a legacy record survives every private durability barrier failure. */
62|  writePrivateRecord?: (recordPath: string, fingerprint: string, filename: string) => Promise<void>;
63|  /** Test seam that models an interruption at each durable migration boundary. */
64|  durabilityBoundary?: (boundary: "temporary-file-synced" | "private-record-renamed" | "private-directory-synced" | "legacy-unlinked" | "root-directory-synced") => Promise<void>;
65|}
66|
67|interface FingerprintRecord {
68|  fingerprint: string;
69|  filename: string;
70|  raw: string;
71|  path: string;
72|}
73|
74|type RecordState = { kind: "absent" } | { kind: "invalid"; path: string } | { kind: "valid"; record: FingerprintRecord };
75|
76|function isValidFilename(filename: string): boolean {
77|  return !!filename && !filename.includes("/") && !filename.includes("\\") && !filename.includes("..") && !filename.includes("\0") && filename !== FINGERPRINT_FILE;
78|}
79|
80|function sha256(content: string): string {
81|  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
82|}
83|
84|function quote(value: string): string {
85|  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
86|}
87|
88|function toManagedBody(taskId: string, entries: Array<{ exportKey: string; plaintextValue: string }>): string {
89|  const header = `${HEADER_PREFIX} (task: ${taskId})\n`;
90|  const body = entries.sort((a, b) => a.exportKey.localeCompare(b.exportKey)).map((item) => `${item.exportKey}=${quote(item.plaintextValue)}`).join("\n");
91|  return `${header}${body}\n`;
92|}
93|
94|function removeManagedBlock(input: string): string {
95|  const idx = input.indexOf(HEADER_PREFIX);
96|  if (idx === -1) return input;
97|  return input.slice(0, idx).replace(/\n+$/u, "\n");
98|}
99|
100|type RecordFormat = "private" | "legacy";
101|
102|function parseRecord(raw: string, recordPath: string, format: RecordFormat): FingerprintRecord | undefined {
103|  // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: v0.75.1 wrote root metadata without a marker; private records require a terminal LF so partial bookkeeping cannot authorize deletion.
104|  const match = (format === "private"
105|    ? /^([0-9a-f]{64})\n([^\n]+)\n$/u
106|    : /^([0-9a-f]{64})\n([^\n]+)\n?$/u).exec(raw);
107|  if (!match || !VALID_FINGERPRINT.test(match[1]) || !isValidFilename(match[2])) return undefined;
108|  return { fingerprint: match[1], filename: match[2], raw, path: recordPath };
109|}
110|
111|async function readRecord(recordPath: string, format: RecordFormat): Promise<RecordState> {
112|  try {
113|    const raw = await fs.readFile(recordPath, "utf8");
114|    const record = parseRecord(raw, recordPath, format);
115|    return record ? { kind: "valid", record } : { kind: "invalid", path: recordPath };
116|  } catch (error) {
117|    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "invalid", path: recordPath };
118|  }
119|}
120|
121|/**
122| * FNXC:SecretsEnvMaterialization 2026-08-07-23:13:
123| * Fingerprint metadata is Fusion bookkeeping, not project content. Resolve the linked worktree's private
124| * Git directory asynchronously so secret materialization cannot create an untracked root sidecar that blocks
125| * the next strict worktree base refresh.
126| */
127|async function resolvePrivateRecordPath(worktreePath: string): Promise<string> {
128|  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: worktreePath, encoding: "utf8", timeout: 10_000 });
129|  const gitDir = stdout.trim();
130|  if (!gitDir) throw new Error("git-dir-empty");
131|  return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir), FINGERPRINT_FILE);
132|}
133|
134|function recordsMatch(left: FingerprintRecord, right: FingerprintRecord): boolean {
135|  return left.fingerprint === right.fingerprint && left.filename === right.filename;
136|}
137|
138|function directorySyncUnsupported(error: unknown): boolean {
139|  // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: Windows cannot fsync directory handles. This narrow portability exception never conceals ordinary I/O errors.
140|  return process.platform === "win32" && ["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "");
141|}
142|
143|async function syncParentDirectory(filePath: string): Promise<void> {
144|  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
145|  try {
146|    handle = await fs.open(path.dirname(filePath), "r");
147|    await handle.sync();
148|  } catch (error) {
149|    if (!directorySyncUnsupported(error)) throw error;
150|  } finally {
151|    await handle?.close();
152|  }
153|}
154|
155|/**
156| * FNXC:SecretsEnvMaterialization 2026-08-08-03:02:
157| * A renamed record is not crash-durable until the private Git directory is synced. The legacy root
158| * authority must survive every failure before this barrier, so callers unlink it only after this returns.
159| */
160|async function atomicWriteRecord(
161|  recordPath: string,
162|  fingerprint: string,
163|  filename: string,
164|  durabilityBoundary?: ReconcileSecretsEnvFingerprintOptions["durabilityBoundary"],
165|): Promise<void> {
166|  const tmpPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
167|  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
168|  try {
169|    handle = await fs.open(tmpPath, "w", 0o600);
170|    await handle.writeFile(`${fingerprint}\n${filename}\n`, "utf8");
171|    await handle.sync();
172|    await durabilityBoundary?.("temporary-file-synced");
173|    await handle.close();
174|    handle = undefined;
175|    await fs.rename(tmpPath, recordPath);
176|    await durabilityBoundary?.("private-record-renamed");
177|    await syncParentDirectory(recordPath);
178|    await durabilityBoundary?.("private-directory-synced");
179|  } catch (error) {
180|    await handle?.close().catch(() => undefined);
181|    await fs.unlink(tmpPath).catch(() => undefined);
182|    throw error;
183|  }
184|}
185|
186|/**
187| * FNXC:SecretsEnvMaterialization 2026-08-08-03:15:
188| * Root records from v0.75.1 are Fusion-owned only while untracked. Never adopt or remove a tracked
189| * lookalike: a project may intentionally version that path, and fingerprint equality is not authority to delete it.
190| */
191|async function isTrackedWorktreeFile(worktreePath: string, filename: string): Promise<boolean> {
192|  try {
193|    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", filename], { cwd: worktreePath, encoding: "utf8", timeout: 10_000 });
194|    return true;
195|  } catch (error) {
196|    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
197|    throw error;
198|  }
199|}
200|
201|async function removeLegacyRecord(
202|  worktreePath: string,
203|  legacyPath: string,
204|  durabilityBoundary?: ReconcileSecretsEnvFingerprintOptions["durabilityBoundary"],
205|): Promise<void> {
206|  if (await isTrackedWorktreeFile(worktreePath, FINGERPRINT_FILE)) throw new Error("legacy-record-tracked");
207|  try {
208|    await fs.unlink(legacyPath);
209|  } catch (error) {
210|    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
211|  }
212|  await durabilityBoundary?.("legacy-unlinked");
213|  await syncParentDirectory(legacyPath);
214|  await durabilityBoundary?.("root-directory-synced");
215|}
216|
217|/**
218| * FNXC:SecretsEnvMaterialization 2026-08-08-03:30:
219| * Cleanup may report a fingerprint match only after its bookkeeping is removed. Suppressing a metadata
220| * removal error makes a later reuse look clean while retaining stale authority, so callers receive a fixed
221| * non-success result and can safely retry instead.
222| */
223|async function removeRecordPaths(recordPaths: string[]): Promise<void> {
224|  for (const recordPath of recordPaths) {
225|    try {
226|      await fs.unlink(recordPath);
227|    } catch (error) {
228|      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
229|      throw error;
230|    }
231|    await syncParentDirectory(recordPath);
232|  }
233|}
234|
235|/**
236| * FNXC:SecretsEnvMaterialization 2026-08-08-01:54:
237| * Root legacy metadata must be removed before strict porcelain proceeds. A failed removal is not benign:
238| * leaving Fusion's root file behind would recreate the dirty-worktree dispatch failure, so reconciliation
239| * remains closed until the record can be safely reconciled.
240| */
241|/** Reconcile v0.75.1 root metadata before porcelain is consulted. */
242|export async function reconcileSecretsEnvFingerprint(
243|  worktreePath: string,
244|  options: ReconcileSecretsEnvFingerprintOptions = {},
245|): Promise<ReconcileSecretsEnvFingerprintResult> {
246|  const legacyPath = path.join(worktreePath, FINGERPRINT_FILE);
247|  let privatePath: string;
248|  try {
249|    privatePath = await resolvePrivateRecordPath(worktreePath);
250|  } catch {
251|    return { executionSafe: false, outcome: "git-dir-unavailable" };
252|  }
253|  const [privateState, legacyState] = await Promise.all([readRecord(privatePath, "private"), readRecord(legacyPath, "legacy")]);
254|  if (privateState.kind === "absent" && legacyState.kind === "absent") return { executionSafe: true, outcome: "clean" };
255|  try {
256|    if (legacyState.kind !== "absent" && await isTrackedWorktreeFile(worktreePath, FINGERPRINT_FILE)) {
257|      return { executionSafe: false, outcome: "tracked-record" };
258|    }
259|  } catch {
260|    return { executionSafe: false, outcome: "git-dir-unavailable" };
261|  }
262|  if (privateState.kind === "invalid" && legacyState.kind !== "valid") return { executionSafe: false, outcome: "invalid-record" };
263|  if (legacyState.kind === "invalid" && privateState.kind !== "valid") return { executionSafe: false, outcome: "invalid-record" };
264|  if (privateState.kind === "valid" && legacyState.kind === "valid" && !recordsMatch(privateState.record, legacyState.record)) {
265|    return { executionSafe: false, outcome: "conflict" };
266|  }
267|  if (privateState.kind === "valid") {
268|    /*
269|     * FNXC:SecretsEnvMaterialization 2026-08-08-04:06:
270|     * A readable private record may have survived a failed write after rename but before its parent directory
271|     * was synced. Re-establish its file and directory durability on every private-record reconciliation,
272|     * including private-only retry, so a prior failed write cannot authorize refresh without that barrier.
273|     */
274|    try {
275|      await (options.writePrivateRecord
276|        ? options.writePrivateRecord(privatePath, privateState.record.fingerprint, privateState.record.filename)
277|        : atomicWriteRecord(privatePath, privateState.record.fingerprint, privateState.record.filename, options.durabilityBoundary));
278|    } catch {
279|      return { executionSafe: false, outcome: "private-record-write-failed" };
280|    }
281|    if (legacyState.kind !== "absent") {
282|      try {
283|        await removeLegacyRecord(worktreePath, legacyPath, options.durabilityBoundary);
284|      } catch {
285|        return { executionSafe: false, outcome: "legacy-remove-failed" };
286|      }
287|    }
288|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:51: A crash after unlink but before root-directory sync leaves only private metadata. Re-sync the root on retry before this state can authorize refresh.
289|    if (legacyState.kind === "absent") {
290|      try {
291|        await syncParentDirectory(legacyPath);
292|      } catch {
293|        return { executionSafe: false, outcome: "legacy-remove-failed" };
294|      }
295|    }
296|    return { executionSafe: true, outcome: legacyState.kind === "absent" ? "clean" : "removed-legacy" };
297|  }
298|  /*
299|   * FNXC:SecretsEnvMaterialization 2026-08-08-03:02:
300|   * v0.75.1 root bytes remain cleanup authority until the replacement record and its private Git-directory
301|   * entry are durable. Only then may the root unlink occur; its directory sync is the final safe-to-refresh barrier.
302|   */
303|  if (legacyState.kind !== "valid") return { executionSafe: false, outcome: "invalid-record" };
304|  try {
305|    await (options.writePrivateRecord
306|      ? options.writePrivateRecord(privatePath, legacyState.record.fingerprint, legacyState.record.filename)
307|      : atomicWriteRecord(privatePath, legacyState.record.fingerprint, legacyState.record.filename, options.durabilityBoundary));
308|  } catch {
309|    return { executionSafe: false, outcome: "private-record-write-failed" };
310|  }
311|  try {
312|    await removeLegacyRecord(worktreePath, legacyPath, options.durabilityBoundary);
313|  } catch {
314|    return { executionSafe: false, outcome: "legacy-remove-failed" };
315|  }
316|  return { executionSafe: true, outcome: privateState.kind === "invalid" ? "recovered-private" : "adopted-legacy" };
317|}
318|
319|async function checkIgnored(execImpl: typeof execFile, worktreePath: string, filename: string): Promise<{ ignored: boolean; error?: string }> {
320|  return await new Promise((resolve) => {
321|    execImpl("git", ["check-ignore", "--", filename], { cwd: worktreePath, timeout: 10_000 }, (error) => {
322|      if (!error) return resolve({ ignored: true });
323|      const anyErr = error as NodeJS.ErrnoException & { code?: number };
324|      if (anyErr.code === 1) return resolve({ ignored: false });
325|      return resolve({ ignored: false, error: anyErr.message });
326|    });
327|  });
328|}
329|
330|export async function writeSecretsEnvFile(opts: WriteSecretsEnvFileOptions): Promise<WriteSecretsEnvFileResult> {
331|  const cfg = opts.settings.secretsEnv;
332|  const filename = cfg?.filename ?? ".env";
333|  const overwritePolicy = cfg?.overwritePolicy ?? "merge";
334|  if (cfg?.enabled !== true) return { outcome: "skipped", filename, reason: "disabled" };
335|  if (!opts.secretsStore) {
336|    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "no-store" } });
337|    return { outcome: "skipped", filename, reason: "no-store" };
338|  }
339|  if (!isValidFilename(filename)) {
340|    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "invalid-filename", overwritePolicy } });
341|    return { outcome: "skipped", filename, reason: "invalid-filename" };
342|  }
343|  const envPath = path.join(opts.worktreePath, filename);
344|  try { if ((await fs.lstat(envPath)).isSymbolicLink()) return { outcome: "skipped", filename, reason: "invalid-filename" }; } catch { /* absent is safe */ }
345|  if (cfg?.requireGitignored !== false) {
346|    const check = await checkIgnored(opts.execFileImpl ?? execFile, opts.worktreePath, filename);
347|    if (!check.ignored) {
348|      await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "not-gitignored", overwritePolicy, checkIgnoreError: check.error } });
349|      return { outcome: "skipped", filename, reason: "not-gitignored" };
350|    }
351|  }
352|  let listed: Awaited<ReturnType<NonNullable<typeof opts.secretsStore>["listEnvExportable"]>>;
353|  try { listed = await opts.secretsStore.listEnvExportable({ keyPrefix: cfg?.keyPrefix }); } catch {
354|    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "list-failed", overwritePolicy } });
355|    return { outcome: "skipped", filename, reason: "list-failed" };
356|  }
357|  const valid = listed.filter((entry) => VALID_ENV_KEY.test(entry.exportKey));
358|  if (valid.length === 0) {
359|    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "no-secrets", overwritePolicy } });
360|    return { outcome: "skipped", filename, reason: "no-secrets" };
361|  }
362|  /*
363|   * FNXC:SecretsEnvMaterialization 2026-08-08-03:59:
364|   * A materialization write must not bypass the same record matrix that protects refresh and cleanup.
365|   * Preserve malformed or conflicting bookkeeping and its existing env authority rather than replacing it
366|   * with a new private record; only an unambiguous, durably reconciled state may receive new metadata.
367|   */
368|  const reconciliation = await reconcileSecretsEnvFingerprint(opts.worktreePath);
369|  if (!reconciliation.executionSafe) {
370|    await opts.audit?.filesystem({
371|      type: "secret:env-write-skipped",
372|      target: opts.taskId,
373|      metadata: { reason: "record-reconciliation-failed", reconciliationOutcome: reconciliation.outcome },
374|    });
375|    return { outcome: "skipped", filename, reason: "record-reconciliation-failed" };
376|  }
377|  let nextBody = toManagedBody(opts.taskId, valid);
378|  if (overwritePolicy === "skip") {
379|    try { await fs.access(envPath); return { outcome: "skipped", filename, reason: "skip-existing" }; } catch { /* absent */ }
380|  } else if (overwritePolicy === "merge") {
381|    try { const preserved = removeManagedBlock(await fs.readFile(envPath, "utf8")); nextBody = `${preserved.replace(/\n*$/u, "")}${preserved.length ? "\n" : ""}${nextBody}`; } catch { /* absent */ }
382|  }
383|  const tmpPath = `${envPath}.fusion-tmp`;
384|  await fs.writeFile(tmpPath, nextBody, { mode: 0o600, encoding: "utf8" });
385|  await fs.rename(tmpPath, envPath);
386|  await fs.chmod(envPath, 0o600).catch(() => undefined);
387|  const fingerprint = sha256(nextBody);
388|  const privatePath = await resolvePrivateRecordPath(opts.worktreePath);
389|  await atomicWriteRecord(privatePath, fingerprint, filename);
390|  /*
391|   * FNXC:SecretsEnvMaterialization 2026-08-08-02:00:
392|   * A current private record supersedes root metadata only after it is durable. Do not swallow a legacy
393|   * removal failure: preserving that untracked root file would deterministically poison the next strict
394|   * refresh, so callers must observe the failed materialization rather than report a false clean write.
395|   */
396|  try {
397|    await removeLegacyRecord(opts.worktreePath, path.join(opts.worktreePath, FINGERPRINT_FILE));
398|  } catch {
399|    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "legacy-remove-failed" } });
400|    throw new Error("secrets-env legacy record removal failed");
401|  }
402|  const keys = valid.map((entry) => entry.exportKey).sort((a, b) => a.localeCompare(b));
403|  await opts.audit?.filesystem({ type: "secret:env-write", target: opts.taskId, metadata: { filename, keyCount: keys.length, fingerprint, overwritePolicy, keys } });
404|  opts.logger?.log(`secrets-env: wrote ${filename} (${keys.length} keys)`);
405|  return { outcome: "written", filename, keyCount: keys.length, fingerprint };
406|}
407|
408|export async function cleanupSecretsEnvFile(opts: CleanupSecretsEnvFileOptions): Promise<CleanupSecretsEnvFileResult> {
409|  const removeRecords = opts.removeRecordPaths ?? removeRecordPaths;
410|  try { await fs.access(opts.worktreePath); } catch { return { outcome: "cleaned", reason: "directory-missing" }; }
411|  const legacyPath = path.join(opts.worktreePath, FINGERPRINT_FILE);
412|  let privatePath: string | undefined;
413|  try {
414|    privatePath = await resolvePrivateRecordPath(opts.worktreePath);
415|  } catch {
416|    /*
417|     * FNXC:SecretsEnvMaterialization 2026-08-08-03:23:
418|     * A Git worktree whose private-dir lookup fails is not an orphan. Fail closed rather than treating its
419|     * root record as orphan metadata, because that fallback could delete a tracked project file on a transient
420|     * Git failure. Only a path with no .git entry can use legacy orphan cleanup.
421|     */
422|    try {
423|      await fs.lstat(path.join(opts.worktreePath, ".git"));
424|      return { outcome: "skipped", reason: "invalid-record" };
425|    } catch (error) {
426|      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { outcome: "skipped", reason: "invalid-record" };
427|    }
428|  }
429|  if (privatePath) {
430|    try {
431|      const reconciliation = await reconcileSecretsEnvFingerprint(opts.worktreePath);
432|      if (!reconciliation.executionSafe) return { outcome: "skipped", reason: reconciliation.outcome === "conflict" ? "ambiguous-record" : "invalid-record" };
433|    } catch {
434|      // A Git-backed cleanup must never downgrade a failed reconciliation into legacy-only cleanup.
435|      return { outcome: "skipped", reason: "invalid-record" };
436|    }
437|  }
438|  const [privateState, legacyState] = await Promise.all([privatePath ? readRecord(privatePath, "private") : Promise.resolve({ kind: "absent" } as RecordState), readRecord(legacyPath, "legacy")]);
439|  if (privateState.kind === "invalid" || legacyState.kind === "invalid") return { outcome: "skipped", reason: "invalid-record" };
440|  if (privateState.kind === "valid" && legacyState.kind === "valid" && !recordsMatch(privateState.record, legacyState.record)) return { outcome: "skipped", reason: "ambiguous-record" };
441|  const record = privateState.kind === "valid" ? privateState.record : legacyState.kind === "valid" ? legacyState.record : undefined;
442|  if (!record) return { outcome: "skipped", reason: "no-record" };
443|  const recordPaths = [privateState, legacyState].flatMap((state) => state.kind === "valid" && recordsMatch(state.record, record) ? [state.record.path] : []);
444|  let body: string;
445|  try { body = await fs.readFile(path.join(opts.worktreePath, record.filename), "utf8"); } catch {
446|    try {
447|      await removeRecords(recordPaths);
448|    } catch {
449|      return { outcome: "skipped", reason: "record-remove-failed" };
450|    }
451|    return { outcome: "skipped", reason: "file-missing" };
452|  }
453|  if (sha256(body) !== record.fingerprint) {
454|    try {
455|      await removeRecords(recordPaths);
456|    } catch {
457|      return { outcome: "skipped", reason: "record-remove-failed" };
458|    }
459|    return { outcome: "skipped", reason: "fingerprint-mismatch" };
460|  }
461|  try {
462|    if (privatePath && await isTrackedWorktreeFile(opts.worktreePath, record.filename)) {
463|      return { outcome: "skipped", reason: "tracked-file" };
464|    }
465|  } catch {
466|    // Cleanup cannot prove ownership when Git cannot answer; preserve both content and record for retry.
467|    return { outcome: "skipped", reason: "tracked-file" };
468|  }
469|  try {
470|    await fs.unlink(path.join(opts.worktreePath, record.filename));
471|  } catch (error) {
472|    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
473|      return { outcome: "skipped", reason: "record-remove-failed" };
474|    }
475|  }
476|  try {
477|    await removeRecords(recordPaths);
478|  } catch {
479|    return { outcome: "skipped", reason: "record-remove-failed" };
480|  }
481|  await opts.audit?.filesystem({ type: "secret:env-cleanup", target: opts.taskId, metadata: { filename: record.filename, fingerprint: record.fingerprint, reason: "fingerprint-match" } });
482|  return { outcome: "cleaned", reason: "fingerprint-match" };
483|}
484|