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
  { file: "src/review-checkout.ts", line: 35, primitive: "execFileSync", signature: "const topLevel = execFileSync(\"git\", [\"rev-parse\", \"--show-toplevel\"], {", reason: SHORT_GIT_PLUMBING },
  { file: "src/worktree-prune.ts", line: 69, primitive: "execSync", signature: "execSync(\"git worktree prune\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger-git-parse.ts", line: 102, primitive: "execFileSync", signature: "const output = execFileSync(", reason: BOUNDED_GIT_DIFF },
  { file: "src/already-merged-detector.ts", line: 204, primitive: "execSync", signature: "branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/already-merged-detector.ts", line: 223, primitive: "execSync", signature: "execSync(`git merge-base --is-ancestor ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/already-merged-detector.ts", line: 270, primitive: "execSync", signature: "branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/already-merged-detector.ts", line: 345, primitive: "execSync", signature: "execSync(`git rev-parse --verify ${shellQuote(treeBranchName)}`, {", reason: SHORT_GIT_PLUMBING },
  // FNXC:EngineProcessRules 2026-07-22-17:30: refreshed drifted line numbers for these unchanged git-plumbing call-sites (self-healing.ts 4187/4193/4230/12705, executor.ts 15808) after FN-8490 + graph-owned-cutover follow-ups shifted lines above them. The call-site-level allowlist keys on file:line:signature, so a legitimate call moving lines reads as unmatched-site + stale-entry until the line is re-pinned here.
  { file: "src/self-healing.ts", line: 4215, primitive: "execSync", signature: "const tipSha = String(execSync(`git rev-parse --verify ${shellQuote(branch)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 4221, primitive: "execSync", signature: "const uniqueCommitCount = Number.parseInt(String(execSync(`git rev-list --count ${shellQuote(branch)} --not ${shellQuote(\"main\")}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 4258, primitive: "execSync", signature: "const branchesRaw = String(execSync(\"git branch --list 'fusion/*'\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/self-healing.ts", line: 12839, primitive: "execSync", signature: "execSync(`git branch -d ${shellQuote(branch)}`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger-workspace-test-commands.ts", line: 204, primitive: "execSync", signature: "changedFilesOutput = execSync(", reason: BOUNDED_GIT_DIFF },
  { file: "src/merger-workspace-test-commands.ts", line: 301, primitive: "execSync", signature: "changedFilesOutput = execSync(", reason: BOUNDED_GIT_DIFF },
  { file: "src/integration-branch.ts", line: 71, primitive: "execSync", signature: "const stdout = execSync(\"git symbolic-ref --short refs/remotes/origin/HEAD\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/integration-branch.ts", line: 107, primitive: "execSync", signature: "const stdout = execSync(\"git remote\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 734, primitive: "execSync", signature: "const output = execSync(command, options);", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 781, primitive: "execSync", signature: "treeSha = execSync(\"git rev-parse HEAD^{tree}\", { cwd: rootDir, stdio: \"pipe\" })", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 1388, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 1600, primitive: "execSync", signature: "beforeRaw = execSync(\"git status -z --porcelain\", { cwd: rootDir, stdio: [\"ignore\", \"pipe\", \"ignore\"] }).toString(\"utf-8\");", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 1612, primitive: "execSync", signature: "afterRaw = execSync(\"git status -z --porcelain\", { cwd: rootDir, stdio: [\"ignore\", \"pipe\", \"ignore\"] }).toString(\"utf-8\");", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 7640, primitive: "execSync", signature: "execSync(`git rev-parse --verify \"${branch}\"`, {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8595, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8608, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8620, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8958, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8978, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 8987, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9077, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 9652, primitive: "execSync", signature: "const postPushSha = execSync(\"git rev-parse HEAD\", {", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 10211, primitive: "execSync", signature: "const squashIsEmpty = execSync(", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 10245, primitive: "execSync", signature: "const squashIsEmpty = execSync(", reason: SHORT_GIT_PLUMBING },
  { file: "src/merger.ts", line: 10432, primitive: "execSync", signature: "execSync(\"git reset --merge\", { cwd: rootDir, stdio: \"pipe\" });", reason: SHORT_GIT_PLUMBING },
  { file: "src/executor.ts", line: 16296, primitive: "execSync", signature: "execSync(`git merge-base --is-ancestor ${task.baseCommitSha} HEAD`, {", reason: SHORT_GIT_PLUMBING },
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

function classifySites(sites: ShelloutSite[]): { unmatched: ShelloutSite[]; stale: AllowlistEntry[] } {
  const remaining = new Set(allowlist.map((entry) => `${entry.file}:${entry.line}:${entry.primitive}:${entry.signature}`));
  const unmatched = sites.filter((site) => {
    const key = `${site.file}:${site.line}:${site.primitive}:${site.signature}`;
    if (!remaining.has(key)) return true;
    remaining.delete(key);
    return false;
  });
  return { unmatched, stale: allowlist.filter((entry) => remaining.has(`${entry.file}:${entry.line}:${entry.primitive}:${entry.signature}`)) };
}

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
    const source = readFileSync(join(process.cwd(), "src", "worktree-prune.ts"), "utf-8") + '\nconst child = execSync("git status");\n';
    const { unmatched } = classifySites(scanSource("src/worktree-prune.ts", source));
    expect(unmatched).toHaveLength(1);
  });
});
