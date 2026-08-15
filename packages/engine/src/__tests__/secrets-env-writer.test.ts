1|import { createHash } from "node:crypto";
2|import { execFileSync } from "node:child_process";
3|import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, rmSync, renameSync, promises as fsPromises } from "node:fs";
4|import { rm } from "node:fs/promises";
5|import { join } from "node:path";
6|import { tmpdir } from "node:os";
7|import { describe, it, expect, vi, afterEach } from "vitest";
8|import { cleanupSecretsEnvFile, reconcileSecretsEnvFingerprint, writeSecretsEnvFile } from "../worktree/secrets-env-writer.js";
9|
10|const dirs: string[] = [];
11|
12|function tmpWorktree(): string {
13|  const dir = mkdtempSync(join(tmpdir(), "secrets-env-"));
14|  execFileSync("git", ["init", "-q"], { cwd: dir });
15|  dirs.push(dir);
16|  return dir;
17|}
18|
19|afterEach(async () => {
20|  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
21|});
22|
23|describe("secrets-env-writer", () => {
24|  it("skips silently when disabled", async () => {
25|    const filesystem = vi.fn();
26|    const result = await writeSecretsEnvFile({
27|      rootDir: process.cwd(),
28|      worktreePath: tmpWorktree(),
29|      taskId: "FN-1",
30|      settings: { secretsEnv: { enabled: false } },
31|      worktreeSource: "fresh",
32|      audit: { filesystem },
33|    });
34|    expect(result).toEqual({ outcome: "skipped", filename: ".env", reason: "disabled" });
35|    expect(filesystem).not.toHaveBeenCalled();
36|  });
37|
38|  it("skips when no store", async () => {
39|    const filesystem = vi.fn();
40|    const result = await writeSecretsEnvFile({
41|      rootDir: process.cwd(),
42|      worktreePath: tmpWorktree(),
43|      taskId: "FN-1",
44|      settings: { secretsEnv: { enabled: true } },
45|      worktreeSource: "fresh",
46|      audit: { filesystem },
47|      execFileImpl: ((_f: string, _a: string[], _o: any, cb: any) => cb(null)) as any,
48|    });
49|    expect(result.reason).toBe("no-store");
50|    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({ type: "secret:env-write-skipped" }));
51|  });
52|
53|  it("writes managed env and sidecar without plaintext in audit/logs", async () => {
54|    const dir = tmpWorktree();
55|    const filesystem = vi.fn();
56|    const log = vi.fn();
57|    const warn = vi.fn();
58|    const secretValue = "SUPER_SECRET_VALUE";
59|
60|    const result = await writeSecretsEnvFile({
61|      rootDir: process.cwd(),
62|      worktreePath: dir,
63|      taskId: "FN-1",
64|      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
65|      worktreeSource: "fresh",
66|      audit: { filesystem },
67|      logger: { log, warn },
68|      secretsStore: {
69|        listEnvExportable: vi.fn().mockResolvedValue([
70|          { id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: secretValue },
71|          { id: "2", key: "B", exportKey: "BETA", scope: "global", plaintextValue: "x" },
72|        ]),
73|      } as any,
74|    });
75|
76|    expect(result.outcome).toBe("written");
77|    const env = readFileSync(join(dir, ".env"), "utf8");
78|    expect(env).toContain("ALPHA=");
79|    expect(env).toContain("BETA=");
80|    const sidecar = readFileSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"), "utf8");
81|    expect(sidecar).toContain(".env");
82|    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(false);
83|    if (process.platform !== "win32") {
84|      expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
85|      expect(statSync(join(dir, ".git", ".fusion-secrets-env.fingerprint")).mode & 0o777).toBe(0o600);
86|    }
87|
88|    const outputBlob = JSON.stringify({ calls: filesystem.mock.calls, logs: log.mock.calls, warns: warn.mock.calls });
89|    expect(outputBlob).not.toContain(secretValue);
90|  });
91|
92|  it("writes an ignored configured file and records a redacted production audit", async () => {
93|    const dir = tmpWorktree();
94|    const filesystem = vi.fn();
95|    const secretValue = "runtime-materialized-secret";
96|    execFileSync("git", ["init", "-q"], { cwd: dir });
97|    writeFileSync(join(dir, ".gitignore"), ".secrets.env\n");
98|
99|    const result = await writeSecretsEnvFile({
100|      rootDir: dir,
101|      worktreePath: dir,
102|      taskId: "FN-8810",
103|      settings: { secretsEnv: { enabled: true, filename: ".secrets.env" } },
104|      worktreeSource: "fresh",
105|      audit: { filesystem },
106|      secretsStore: {
107|        listEnvExportable: vi.fn().mockResolvedValue([
108|          { id: "1", key: "runtime-key", exportKey: "RUNTIME_SECRET", scope: "project", plaintextValue: secretValue },
109|        ]),
110|      } as any,
111|    });
112|
113|    expect(result).toMatchObject({ outcome: "written", filename: ".secrets.env", keyCount: 1 });
114|    const exportedKeys = readFileSync(join(dir, ".secrets.env"), "utf8")
115|      .split("\n")
116|      .filter(Boolean)
117|      .map((line) => line.split("=", 1)[0]);
118|    expect(exportedKeys).toContain("RUNTIME_SECRET");
119|    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({
120|      type: "secret:env-write",
121|      metadata: expect.objectContaining({ keyCount: 1, fingerprint: expect.any(String) }),
122|    }));
123|    expect(JSON.stringify(filesystem.mock.calls)).not.toContain(secretValue);
124|  });
125|
126|  it("merge is idempotent", async () => {
127|    const dir = tmpWorktree();
128|    writeFileSync(join(dir, ".env"), "EXISTING=1\n");
129|    const secretsStore = {
130|      listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]),
131|    } as any;
132|
133|    await writeSecretsEnvFile({
134|      rootDir: process.cwd(),
135|      worktreePath: dir,
136|      taskId: "FN-1",
137|      settings: { secretsEnv: { enabled: true, requireGitignored: false, overwritePolicy: "merge" } },
138|      worktreeSource: "fresh",
139|      secretsStore,
140|    });
141|    const once = readFileSync(join(dir, ".env"), "utf8");
142|
143|    await writeSecretsEnvFile({
144|      rootDir: process.cwd(),
145|      worktreePath: dir,
146|      taskId: "FN-1",
147|      settings: { secretsEnv: { enabled: true, requireGitignored: false, overwritePolicy: "merge" } },
148|      worktreeSource: "fresh",
149|      secretsStore,
150|    });
151|    const twice = readFileSync(join(dir, ".env"), "utf8");
152|    expect(twice).toBe(once);
153|  });
154|
155|  it("rejects invalid filename and symlink", async () => {
156|    const dir = tmpWorktree();
157|    const filesystem = vi.fn();
158|    const a = await writeSecretsEnvFile({
159|      rootDir: process.cwd(),
160|      worktreePath: dir,
161|      taskId: "FN-1",
162|      settings: { secretsEnv: { enabled: true, filename: "../x" } },
163|      worktreeSource: "fresh",
164|      audit: { filesystem },
165|      secretsStore: { listEnvExportable: vi.fn() } as any,
166|    });
167|    expect(a.reason).toBe("invalid-filename");
168|
169|    writeFileSync(join(dir, "real.env"), "SAFE=1\n");
170|    symlinkSync(join(dir, "real.env"), join(dir, ".env"));
171|    const b = await writeSecretsEnvFile({
172|      rootDir: process.cwd(),
173|      worktreePath: dir,
174|      taskId: "FN-1",
175|      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
176|      worktreeSource: "fresh",
177|      audit: { filesystem },
178|      secretsStore: { listEnvExportable: vi.fn() } as any,
179|    });
180|    expect(b.reason).toBe("invalid-filename");
181|  });
182|
183|  it("adopts a valid legacy record before strict porcelain and preserves ambiguous records", async () => {
184|    const dir = tmpWorktree();
185|    const fingerprint = "a".repeat(64);
186|    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
187|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
188|    writeFileSync(legacy, `${fingerprint}\n.env\n`);
189|
190|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "adopted-legacy" });
191|    expect(readFileSync(privateRecord, "utf8")).toBe(`${fingerprint}\n.env\n`);
192|    expect(existsSync(legacy)).toBe(false);
193|    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
194|
195|    writeFileSync(legacy, `${"b".repeat(64)}\n.env\n`);
196|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "conflict" });
197|    expect(readFileSync(privateRecord, "utf8")).toBe(`${fingerprint}\n.env\n`);
198|    expect(readFileSync(legacy, "utf8")).toBe(`${"b".repeat(64)}\n.env\n`);
199|  });
200|
201|  it("refuses materialization when record reconciliation is malformed or conflicting", async () => {
202|    const dir = tmpWorktree();
203|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
204|    const legacyRecord = join(dir, ".fusion-secrets-env.fingerprint");
205|    const env = join(dir, ".env");
206|    const filesystem = vi.fn();
207|    const secretValue = "must-not-replace-existing-authority";
208|    const originalEnv = "PRESERVE=1\n";
209|    writeFileSync(env, originalEnv);
210|    writeFileSync(privateRecord, `${"a".repeat(64)}\n.env\n`);
211|    writeFileSync(legacyRecord, `${"b".repeat(64)}\n.env\n`);
212|
213|    const result = await writeSecretsEnvFile({
214|      rootDir: dir,
215|      worktreePath: dir,
216|      taskId: "FN-8825",
217|      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
218|      worktreeSource: "fresh",
219|      audit: { filesystem },
220|      secretsStore: {
221|        listEnvExportable: vi.fn().mockResolvedValue([
222|          { id: "1", key: "SECRET", exportKey: "SECRET", scope: "project", plaintextValue: secretValue },
223|        ]),
224|      } as any,
225|    });
226|
227|    expect(result).toEqual({ outcome: "skipped", filename: ".env", reason: "record-reconciliation-failed" });
228|    expect(readFileSync(env, "utf8")).toBe(originalEnv);
229|    expect(readFileSync(privateRecord, "utf8")).toBe(`${"a".repeat(64)}\n.env\n`);
230|    expect(readFileSync(legacyRecord, "utf8")).toBe(`${"b".repeat(64)}\n.env\n`);
231|    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({
232|      type: "secret:env-write-skipped",
233|      metadata: { reason: "record-reconciliation-failed", reconciliationOutcome: "conflict" },
234|    }));
235|    expect(JSON.stringify(filesystem.mock.calls)).not.toContain(secretValue);
236|  });
237|
238|  it("does not replace a sole malformed record during materialization", async () => {
239|    const dir = tmpWorktree();
240|    const legacyRecord = join(dir, ".fusion-secrets-env.fingerprint");
241|    const env = join(dir, ".env");
242|    writeFileSync(legacyRecord, "not-a-fingerprint\n.env\n");
243|    writeFileSync(env, "PRESERVE=1\n");
244|
245|    const result = await writeSecretsEnvFile({
246|      rootDir: dir,
247|      worktreePath: dir,
248|      taskId: "FN-8825",
249|      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
250|      worktreeSource: "fresh",
251|      secretsStore: {
252|        listEnvExportable: vi.fn().mockResolvedValue([
253|          { id: "1", key: "SECRET", exportKey: "SECRET", scope: "project", plaintextValue: "new-value" },
254|        ]),
255|      } as any,
256|    });
257|
258|    expect(result.reason).toBe("record-reconciliation-failed");
259|    expect(readFileSync(env, "utf8")).toBe("PRESERVE=1\n");
260|    expect(readFileSync(legacyRecord, "utf8")).toBe("not-a-fingerprint\n.env\n");
261|  });
262|
263|  it("preserves legacy authority and converges after private durable replacement fails", async () => {
264|    const dir = tmpWorktree();
265|    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
266|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
267|    const contents = `${"a".repeat(64)}\n.env\n`;
268|    writeFileSync(legacy, contents);
269|    // A directory at the destination makes the atomic rename fail after the temporary record sync.
270|    mkdirSync(privateRecord);
271|
272|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "private-record-write-failed" });
273|    expect(readFileSync(legacy, "utf8")).toBe(contents);
274|    expect(existsSync(privateRecord)).toBe(true);
275|
276|    rmSync(privateRecord, { recursive: true });
277|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:30: A failed private durability barrier retains legacy authority so the next acquisition can safely converge.
278|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "adopted-legacy" });
279|    expect(existsSync(legacy)).toBe(false);
280|    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
281|  });
282|
283|  it("re-establishes private durability before removing an equal legacy record on retry", async () => {
284|    const dir = tmpWorktree();
285|    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
286|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
287|    const contents = `${"a".repeat(64)}\n.env\n`;
288|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:42: Simulate interruption after rename before private-directory durability completes.
289|    writeFileSync(privateRecord, contents);
290|    writeFileSync(legacy, contents);
291|
292|    await expect(reconcileSecretsEnvFingerprint(dir, {
293|      writePrivateRecord: async () => { throw new Error("private-directory-sync-failed"); },
294|    })).resolves.toEqual({ executionSafe: false, outcome: "private-record-write-failed" });
295|    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
296|    expect(readFileSync(legacy, "utf8")).toBe(contents);
297|
298|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "removed-legacy" });
299|    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
300|    expect(existsSync(legacy)).toBe(false);
301|  });
302|
303|  it("re-establishes private durability before private-only retry can authorize refresh", async () => {
304|    const dir = tmpWorktree();
305|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
306|    const contents = `${"a".repeat(64)}\n.secrets.env\n`;
307|    // FNXC:SecretsEnvMaterialization 2026-08-08-04:06: Model a failed write after rename when only its readable private artifact survived.
308|    writeFileSync(privateRecord, contents);
309|
310|    await expect(reconcileSecretsEnvFingerprint(dir, {
311|      writePrivateRecord: async () => { throw new Error("private-directory-sync-failed"); },
312|    })).resolves.toEqual({ executionSafe: false, outcome: "private-record-write-failed" });
313|    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
314|
315|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "clean" });
316|    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
317|  });
318|
319|  it("fails closed and converges after every private and root durability boundary interruption", async () => {
320|    const boundaries = ["temporary-file-synced", "private-record-renamed", "private-directory-synced", "legacy-unlinked", "root-directory-synced"] as const;
321|    for (const boundary of boundaries) {
322|      const dir = tmpWorktree();
323|      const legacy = join(dir, ".fusion-secrets-env.fingerprint");
324|      const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
325|      const contents = `${"a".repeat(64)}\n.secrets.env\n`;
326|      writeFileSync(legacy, contents);
327|      const observed: string[] = [];
328|
329|      const blocked = await reconcileSecretsEnvFingerprint(dir, {
330|        durabilityBoundary: async (stage) => {
331|          observed.push(stage);
332|          if (stage === boundary) throw new Error(`interrupted-${stage}`);
333|        },
334|      });
335|
336|      expect(observed).toContain(boundary);
337|      expect(blocked.executionSafe).toBe(false);
338|      if (boundary === "legacy-unlinked" || boundary === "root-directory-synced") {
339|        expect(existsSync(privateRecord)).toBe(true);
340|        expect(existsSync(legacy)).toBe(false);
341|      } else {
342|        // FNXC:SecretsEnvMaterialization 2026-08-08-03:51: No private barrier failure may discard the only v0.75.1 root authority.
343|        expect(readFileSync(legacy, "utf8")).toBe(contents);
344|      }
345|      await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toMatchObject({ executionSafe: true });
346|      expect(readFileSync(privateRecord, "utf8")).toBe(contents);
347|      expect(existsSync(legacy)).toBe(false);
348|    }
349|  });
350|
351|  it("records the complete durable adoption order before porcelain may run", async () => {
352|    const dir = tmpWorktree();
353|    writeFileSync(join(dir, ".fusion-secrets-env.fingerprint"), `${"a".repeat(64)}\n.secrets.env\n`);
354|    const observed: string[] = [];
355|
356|    await expect(reconcileSecretsEnvFingerprint(dir, {
357|      durabilityBoundary: async (boundary) => { observed.push(boundary); },
358|    })).resolves.toMatchObject({ executionSafe: true, outcome: "adopted-legacy" });
359|
360|    expect(observed).toEqual([
361|      "temporary-file-synced",
362|      "private-record-renamed",
363|      "private-directory-synced",
364|      "legacy-unlinked",
365|      "root-directory-synced",
366|    ]);
367|  });
368|
369|  it("fails closed for a sole malformed record without deleting it", async () => {
370|    const dir = tmpWorktree();
371|    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
372|    writeFileSync(legacy, "malformed\n.env\n");
373|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "invalid-record" });
374|    expect(readFileSync(legacy, "utf8")).toBe("malformed\n.env\n");
375|  });
376|
377|  it("never adopts or removes a tracked root record", async () => {
378|    const dir = tmpWorktree();
379|    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
380|    const contents = `${"a".repeat(64)}\n.env\n`;
381|    writeFileSync(legacy, contents);
382|    execFileSync("git", ["add", ".fusion-secrets-env.fingerprint"], { cwd: dir });
383|    execFileSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked root record"], { cwd: dir });
384|
385|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "tracked-record" });
386|    expect(readFileSync(legacy, "utf8")).toBe(contents);
387|    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
388|  });
389|
390|  it("reconciles every unambiguous private and legacy record pairing", async () => {
391|    const dir = tmpWorktree();
392|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
393|    const legacyRecord = join(dir, ".fusion-secrets-env.fingerprint");
394|    const first = `${"a".repeat(64)}\n.env\n`;
395|    const second = `${"b".repeat(64)}\n.secrets.env\n`;
396|
397|    writeFileSync(privateRecord, first);
398|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: v0.75.1 emitted the terminal LF, but legacy compatibility tolerates its missing final LF when both fields remain exact.
399|    writeFileSync(legacyRecord, first.trimEnd());
400|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "removed-legacy" });
401|    expect(existsSync(legacyRecord)).toBe(false);
402|
403|    writeFileSync(privateRecord, first.trimEnd());
404|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "invalid-record" });
405|    writeFileSync(privateRecord, first);
406|
407|    writeFileSync(privateRecord, "broken\n.env\n");
408|    writeFileSync(legacyRecord, second);
409|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "recovered-private" });
410|    expect(readFileSync(privateRecord, "utf8")).toBe(second);
411|    expect(existsSync(legacyRecord)).toBe(false);
412|
413|    writeFileSync(legacyRecord, "broken\n.env\n");
414|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "removed-legacy" });
415|    expect(readFileSync(privateRecord, "utf8")).toBe(second);
416|    expect(existsSync(legacyRecord)).toBe(false);
417|
418|    writeFileSync(privateRecord, "broken\n.env\n");
419|    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "invalid-record" });
420|    expect(readFileSync(privateRecord, "utf8")).toBe("broken\n.env\n");
421|  });
422|
423|  it("reconciles invalid legacy metadata to a valid private record before cleanup", async () => {
424|    const dir = tmpWorktree();
425|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
426|    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
427|    writeFileSync(join(dir, ".fusion-secrets-env.fingerprint"), "broken\n.env\n");
428|    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "cleaned" });
429|    expect(existsSync(join(dir, ".env"))).toBe(false);
430|    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(false);
431|  });
432|
433|  it("fails closed rather than using legacy orphan cleanup when a Git worktree cannot resolve its private dir", async () => {
434|    const dir = tmpWorktree();
435|    const body = "A=1\n";
436|    writeFileSync(join(dir, ".env"), body);
437|    writeFileSync(join(dir, ".fusion-secrets-env.fingerprint"), `${createHash("sha256").update(body).digest("hex")}\n.env\n`);
438|    renameSync(join(dir, ".git"), join(dir, ".git-unavailable"));
439|    writeFileSync(join(dir, ".git"), "gitdir: /missing-private-git-dir\n");
440|
441|    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toEqual({ outcome: "skipped", reason: "invalid-record" });
442|    expect(existsSync(join(dir, ".env"))).toBe(true);
443|    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(true);
444|  });
445|
446|  it("cleanup safely handles missing, repeated, and non-Git legacy records", async () => {
447|    const dir = tmpWorktree();
448|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
449|    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
450|    rmSync(join(dir, ".env"));
451|    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "skipped", reason: "file-missing" });
452|    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
453|    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "skipped", reason: "no-record" });
454|
455|    const orphan = mkdtempSync(join(tmpdir(), "secrets-env-orphan-"));
456|    dirs.push(orphan);
457|    const body = "A=1\n";
458|    writeFileSync(join(orphan, ".env"), body);
459|    writeFileSync(join(orphan, ".fusion-secrets-env.fingerprint"), `${createHash("sha256").update(body).digest("hex")}\n.env\n`);
460|    await expect(cleanupSecretsEnvFile({ worktreePath: orphan, taskId: "orphan", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "cleaned", reason: "fingerprint-match" });
461|    expect(existsSync(join(orphan, ".env"))).toBe(false);
462|    expect(existsSync(join(orphan, ".fusion-secrets-env.fingerprint"))).toBe(false);
463|  });
464|
465|  it("removes metadata when the managed env disappears before unlink", async () => {
466|    const dir = tmpWorktree();
467|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
468|    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
469|    const envPath = join(dir, ".env");
470|    const unlinkSpy = vi.spyOn(fsPromises, "unlink").mockImplementationOnce(async () => {
471|      rmSync(envPath);
472|      throw Object.assign(new Error("already removed"), { code: "ENOENT" });
473|    });
474|
475|    try {
476|      await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toEqual({ outcome: "cleaned", reason: "fingerprint-match" });
477|      expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
478|    } finally {
479|      unlinkSpy.mockRestore();
480|    }
481|  });
482|
483|  it("preserves metadata when managed env removal fails", async () => {
484|    const dir = tmpWorktree();
485|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
486|    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
487|    const unlinkSpy = vi.spyOn(fsPromises, "unlink").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
488|
489|    try {
490|      await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toEqual({ outcome: "skipped", reason: "record-remove-failed" });
491|      expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(true);
492|    } finally {
493|      unlinkSpy.mockRestore();
494|    }
495|  });
496|
497|  it("does not report cleanup success when private metadata removal fails", async () => {
498|    const dir = tmpWorktree();
499|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
500|    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
501|    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
502|    // FNXC:SecretsEnvMaterialization 2026-08-08-03:30: A failed bookkeeping removal is retryable but must never be published as successful cleanup.
503|    await expect(cleanupSecretsEnvFile({
504|      worktreePath: dir,
505|      taskId: "FN-1",
506|      expectedFingerprint: null,
507|      filename: ".env",
508|      removeRecordPaths: async () => { throw new Error("metadata removal failed"); },
509|    })).resolves.toEqual({ outcome: "skipped", reason: "record-remove-failed" });
510|    expect(existsSync(privateRecord)).toBe(true);
511|  });
512|
513|  it("cleanup removes only fingerprint-matching env", async () => {
514|    const dir = tmpWorktree();
515|    const filesystem = vi.fn();
516|    const secretsStore = {
517|      listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]),
518|    } as any;
519|
520|    await writeSecretsEnvFile({
521|      rootDir: process.cwd(),
522|      worktreePath: dir,
523|      taskId: "FN-1",
524|      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
525|      worktreeSource: "fresh",
526|      secretsStore,
527|    });
528|
529|    const cleaned = await cleanupSecretsEnvFile({
530|      worktreePath: dir,
531|      taskId: "FN-1",
532|      expectedFingerprint: null,
533|      filename: ".env",
534|      audit: { filesystem },
535|    });
536|    expect(cleaned.outcome).toBe("cleaned");
537|    expect(existsSync(join(dir, ".env"))).toBe(false);
538|    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
539|
540|    await writeSecretsEnvFile({
541|      rootDir: process.cwd(),
542|      worktreePath: dir,
543|      taskId: "FN-1",
544|      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
545|      worktreeSource: "fresh",
546|      secretsStore,
547|    });
548|    writeFileSync(join(dir, ".env"), "MUTATED=1\n");
549|    const skipped = await cleanupSecretsEnvFile({
550|      worktreePath: dir,
551|      taskId: "FN-1",
552|      expectedFingerprint: null,
553|      filename: ".env",
554|      audit: { filesystem },
555|    });
556|    expect(skipped.reason).toBe("fingerprint-mismatch");
557|    expect(existsSync(join(dir, ".env"))).toBe(true);
558|    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
559|  });
560|
561|  it("never deletes a tracked env even when its fingerprint matches", async () => {
562|    const dir = tmpWorktree();
563|    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
564|    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
565|    execFileSync("git", ["add", ".env"], { cwd: dir });
566|    execFileSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked environment"], { cwd: dir });
567|
568|    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toEqual({ outcome: "skipped", reason: "tracked-file" });
569|    expect(existsSync(join(dir, ".env"))).toBe(true);
570|    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(true);
571|  });
572|});
573|