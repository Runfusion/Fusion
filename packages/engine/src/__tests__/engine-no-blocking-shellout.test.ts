import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceFile, forEachChild, isCallExpression, isIdentifier, ScriptTarget } from "typescript";

/*
FNXC:EngineAsyncInvariant 2026-07-29-00:00:
The engine's executor, scheduler, merger, self-healing, and dashboard activity
share one Node event loop. User-configured and potentially long-running work
must therefore stay async and bounded. This guard covers execSync, spawnSync,
and execFileSync across production source.

The allowlist is call-site-level (path, line, and signature), not file-level,
and is the single enforced source of truth for sanctioned short git plumbing.
Data-dependent git diff calls are present only after proving timeout and
maxBuffer bounds in their production modules; new or unbounded sync shellouts
must migrate to bounded async execution instead.
*/

type SyncPrimitive = "execSync" | "spawnSync" | "execFileSync";
type ShelloutSite = {
  file: string;
  line: number;
  primitive: SyncPrimitive;
  signature: string;
};
type AllowlistEntry = ShelloutSite & { reason: string };

const SHORT_GIT_PLUMBING = "short deterministic git plumbing";
const BOUNDED_GIT_DIFF = "bounded data-dependent git diff plumbing";

const allowlist: AllowlistEntry[] = [
  // FNXC:FullSuiteBookkeeping 2026-08-05-00:25: Re-pin after code-organization peels moved git plumbing under merge/, worktree/, execution/ and shifted self-healing/executor line numbers. Identity remains file+primitive+signature; lines are documentation only.
  { file: "src/execution/review-checkout.ts", line: 35, primitive: "execFileSync", signature: "const topLevel = execFileSync(\"git\", [\"rev-parse\", \"--show-toplevel\"], {", reason: SHORT_GIT_PLUMBING },
  { file: "src/executor.ts", line: 18450, primitive: "execSync", signature: "execSync(`git merge-base --is-ancestor ${task.baseCommitSha} HEAD`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/already-merged-detector.ts", line: 204, primitive: "execSync", signature: "branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/already-merged-detector.ts", line: 223, primitive: "execSync", signature: "execSync(`git merge-base --is-ancestor ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/already-merged-detector.ts", line: 270, primitive: "execSync", signature: "branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/already-merged-detector.ts", line: 345, primitive: "execSync", signature: "execSync(`git rev-parse --verify ${shellQuote(treeBranchName)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/integration-branch.ts", line: 71, primitive: "execSync", signature: "const stdout = execSync(\"git symbolic-ref --short refs/remotes/origin/HEAD\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/integration-branch.ts", line: 107, primitive: "execSync", signature: "const stdout = execSync(\"git remote\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merge/merger-git-parse.ts", line: 102, primitive: "execFileSync", signature: "const output = execFileSync(", reason: BOUNDED_GIT_DIFF },
  { file: "src/merge/merger-workspace-test-commands.ts", line: 204, primitive: "execSync", signature: "changedFilesOutput = execSync(", reason: BOUNDED_GIT_DIFF },
  { file: "src/merge/merger-workspace-test-commands.ts", line: 301, primitive: "execSync", signature: "changedFilesOutput = execSync(", reason: BOUNDED_GIT_DIFF },
  { file: "src/merger.ts", line: 753, primitive: "execSync", signature: "const output = execSync(command, options);", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 800, primitive: "execSync", signature: "treeSha = execSync(\"git rev-parse HEAD^{tree}\", { cwd: rootDir, stdio: \"pipe\" })", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 1409, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 1621, primitive: "execSync", signature: "beforeRaw = execSync(\"git status -z --porcelain\", { cwd: rootDir, stdio: [\"ignore\", \"pipe\", \"ignore\"] }).toString(\"utf-8\");", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 1633, primitive: "execSync", signature: "afterRaw = execSync(\"git status -z --porcelain\", { cwd: rootDir, stdio: [\"ignore\", \"pipe\", \"ignore\"] }).toString(\"utf-8\");", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 7722, primitive: "execSync", signature: "execSync(`git rev-parse --verify \"${branch}\"`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8677, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8690, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8702, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9040, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9060, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9069, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9159, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9734, primitive: "execSync", signature: "const postPushSha = execSync(\"git rev-parse HEAD\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 10293, primitive: "execSync", signature: "const squashIsEmpty = execSync(", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 10327, primitive: "execSync", signature: "const squashIsEmpty = execSync(", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 10514, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 4640, primitive: "execSync", signature: "const tipSha = String(execSync(`git rev-parse --verify ${shellQuote(branch)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 4646, primitive: "execSync", signature: "const uniqueCommitCount = Number.parseInt(String(execSync(`git rev-list --count ${shellQuote(branch)} --not ${shellQuote(\"main\")}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 4691, primitive: "execSync", signature: "const branchesRaw = String(execSync(\"git branch --list 'fusion/*'\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 15113, primitive: "execSync", signature: "execSync(`git branch -d ${shellQuote(branch)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/worktree/worktree-prune.ts", line: 69, primitive: "execSync", signature: "execSync(\"git worktree prune\", {", reason: SHORT_GIT_PLUMBING },
];

function scanSource(file: string, source: string): ShelloutSite[] {
  // The TypeScript parser excludes comments and quoted literals from call
  // expressions, avoiding false positives from documentation or examples.
  const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, false);
  const sites: ShelloutSite[] = [];
  const visit = (node: Parameters<typeof forEachChild>[0]): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      const primitive = node.expression.text;
      if (primitive === "execSync" || primitive === "spawnSync" || primitive === "execFileSync") {
        const offset = node.expression.getStart(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(offset);
        sites.push({
          file,
          line: line + 1,
          primitive,
          signature: source.split("\n")[line].trim(),
        });
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function listProductionSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : listProductionSource(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts") ? [path] : [];
  });
}

function scanEngineSource(): ShelloutSite[] {
  const root = join(process.cwd(), "src");
  return listProductionSource(root).flatMap((path) => scanSource(relative(process.cwd(), path), readFileSync(path, "utf-8")));
}

/*
FNXC:EngineProcessRules 2026-07-30-12:20:
Identity is file + primitive + SIGNATURE, with a per-key COUNT. The line number is documentation.

The key used to include `entry.line`, so ANY edit above an audited call site broke this guard even
though the call itself was untouched. That is not a hypothetical: it has now produced three false
failures and been re-pinned twice by hand, most recently when unrelated fleet conversions shifted
`executor.ts` and `self-healing.ts` (5 sites drifted at once). A guard that fails on edits it does not
care about trains people to re-pin it without reading it, which is how a real new shellout would slip
through in the same commit.

The count preserves what the line number was actually buying: a SECOND identical shellout added to the
same file is still unmatched, because the allowlist declares how many of that exact call it audits.
What is deliberately given up is distinguishing "the audited call moved" from "the audited call stayed
put" — which this guard has no reason to care about.
*/
function keyOf(entry: { file: string; primitive: string; signature: string }): string {
  return `${entry.file}:${entry.primitive}:${entry.signature}`;
}

function classifySites(
  sites: ShelloutSite[],
  entries: AllowlistEntry[] = allowlist,
): { unmatched: ShelloutSite[]; stale: AllowlistEntry[] } {
  const budget = new Map<string, number>();
  for (const entry of entries) budget.set(keyOf(entry), (budget.get(keyOf(entry)) ?? 0) + 1);

  const unmatched = sites.filter((site) => {
    const remainingForKey = budget.get(keyOf(site)) ?? 0;
    if (remainingForKey === 0) return true;
    budget.set(keyOf(site), remainingForKey - 1);
    return false;
  });

  // Anything still holding budget is an allowlist entry with no matching call site left in source.
  const stale = entries.filter((entry) => {
    const left = budget.get(keyOf(entry)) ?? 0;
    if (left === 0) return false;
    budget.set(keyOf(entry), left - 1);
    return true;
  });
  return { unmatched, stale };
}

/*
FNXC:EngineProcessRules 2026-07-30-13:20 (greptile P2 — the count semantics had no direct coverage):
The two invariants that replaced line coupling were verified by MUTATION while writing the change,
which proves nothing once the mutation is reverted. Pinned here directly, so a later edit cannot
restore line coupling or weaken duplicate detection without a red test.
*/
describe("shellout allowlist matching semantics", () => {
  const AUDITED: AllowlistEntry = {
    file: "src/example.ts",
    line: 10,
    primitive: "execSync",
    signature: 'execSync("git worktree prune", {',
    reason: "test fixture",
  };
  const siteAt = (line: number): ShelloutSite => ({
    file: AUDITED.file,
    line,
    primitive: AUDITED.primitive,
    signature: AUDITED.signature,
  });

  it("accepts an audited call that has MOVED — line drift alone is not a violation", () => {
    // The false failure this replaced: an edit ABOVE the call site broke the guard three times.
    const { unmatched, stale } = classifySites([siteAt(9_999)], [AUDITED]);

    expect(unmatched).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("rejects a SECOND identical shellout — the count is what line numbers were buying", () => {
    // One audited entry, two identical calls: the extra one is unmatched even though its
    // file+primitive+signature match, because the allowlist audits exactly one of them.
    const { unmatched } = classifySites([siteAt(10), siteAt(40)], [AUDITED]);

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ file: AUDITED.file, signature: AUDITED.signature });
  });

  it("reports an audited entry with no call site left as STALE", () => {
    const { unmatched, stale } = classifySites([], [AUDITED]);

    expect(unmatched).toEqual([]);
    expect(stale).toEqual([AUDITED]);
  });

  it("still distinguishes a DIFFERENT shellout in the same file", () => {
    const other: ShelloutSite = { ...siteAt(12), signature: 'execSync("git gc --prune=now", {' };
    const { unmatched } = classifySites([siteAt(10), other], [AUDITED]);

    expect(unmatched).toEqual([other]);
  });
});

describe("engine blocking-shellout static guard", () => {
  it("confines every production synchronous shellout to an audited call-site allowlist", () => {
    const { unmatched, stale } = classifySites(scanEngineSource());
    expect(unmatched).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("flags a synchronous call in a non-allowlisted file", () => {
    const { unmatched } = classifySites(scanSource("src/fake-runner.ts", 'const child = execSync("git status");'));
    expect(unmatched).toHaveLength(1);
  });

  it("flags an extra synchronous call in an allowlisted file", () => {
    const source = readFileSync(join(process.cwd(), "src", "worktree", "worktree-prune.ts"), "utf-8") + '\nconst child = execSync("git status");\n';
    const { unmatched } = classifySites(scanSource("src/worktree/worktree-prune.ts", source));
    expect(unmatched).toHaveLength(1);
  });
});
