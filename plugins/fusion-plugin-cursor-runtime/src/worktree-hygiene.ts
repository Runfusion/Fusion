/*
FNXC:CursorMcpBridge 2026-08-15-21:20:
Cursor loads project MCP configuration from the task worktree, while merger paths may use git add -A.
Keep every Fusion-owned Cursor file excluded before it exists; tracked operator configuration is refused instead of hidden.
*/
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const START = "# >>> fusion cursor-runtime >>>";
const END = "# <<< fusion cursor-runtime <<<";

export interface GitShape { topLevel: string; excludePath: string; gitDir: string; relativeWorktree: string; }
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const output = (cwd: string, ...args: string[]) => { const result = git(cwd, ...args); return result.status === 0 ? result.stdout.trim() : undefined; };
const atomic = (file: string, raw: string) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, raw, { mode: 0o600 }); renameSync(tmp, file); };

export function resolveGitShape(worktreePath: string): GitShape | undefined {
  const topLevel = output(worktreePath, "rev-parse", "--show-toplevel");
  const excludePath = output(worktreePath, "rev-parse", "--git-path", "info/exclude");
  const gitDir = output(worktreePath, "rev-parse", "--git-path", ".");
  if (!topLevel || !excludePath || !gitDir) return undefined;
  const rel = relative(topLevel, worktreePath).split(sep).filter(Boolean).join("/");
  /*
  FNXC:CursorMcpBridge 2026-08-15-21:26:
  Git may return absolute --git-path values, especially for linked worktrees. Preserve
  those paths; joining an absolute-looking result below the worktree creates a stray
  `Users/...` tree and leaves the real info/exclude unprotected from git add -A.
  */
  const fromGitPath = (value: string) => isAbsolute(value) ? value : join(worktreePath, value);
  return { topLevel, excludePath: fromGitPath(excludePath), gitDir: fromGitPath(gitDir), relativeWorktree: rel };
}

export function classifyCursorConfigTracking(worktreePath: string): "tracked" | "untracked" | "non-git" {
  const shape = resolveGitShape(worktreePath); if (!shape) return "non-git";
  const path = `${shape.relativeWorktree ? `${shape.relativeWorktree}/` : ""}.cursor/mcp.json`;
  return git(shape.topLevel, "ls-files", "--error-unmatch", "--", path).status === 0 ? "tracked" : "untracked";
}

const block = (shape: GitShape) => {
  const prefix = shape.relativeWorktree ? `/${shape.relativeWorktree}/` : "/";
  return `${START}\n${prefix}.cursor/mcp.json\n${prefix}.cursor/.fusion-mcp-state.json\n${prefix}.cursor/.fusion-mcp.lock/\n${END}\n`;
};
const withoutBlock = (raw: string) => raw.replace(new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), "");

const BOOTSTRAP_LOCK_TTL_MS = 10_000;
const BOOTSTRAP_LOCK_ATTEMPTS = 5;
const BOOTSTRAP_LOCK_RETRY_MS = 10;
const bootstrapLock = (shape: GitShape) => join(shape.gitDir, "fusion-cursor-exclude.lock");
const sleepSync = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const lockAgeMs = (lock: string) => {
  try { return Date.now() - statSync(lock).mtimeMs; } catch { return Number.POSITIVE_INFINITY; }
};

/*
FNXC:CursorMcpBridge 2026-08-15-21:36:
The main MCP lock lives under .cursor and cannot protect the exclusion that must
exist before .cursor is created. Bootstrap therefore serializes info/exclude with a
short git-dir lock; callers already holding the main lock pass lockHeld to avoid a
lock-order inversion.
*/
function withBootstrapLock<T>(shape: GitShape, fn: () => T): T {
  const lock = bootstrapLock(shape);
  const mine = { pid: process.pid, hostname: hostname(), acquiredAt: Date.now() };
  let acquired = false;
  for (let attempt = 0; attempt < BOOTSTRAP_LOCK_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify(mine), { mode: 0o600 });
      acquired = true;
      break;
    } catch {
      let owner: { pid?: number; hostname?: string; acquiredAt?: number } | undefined;
      try { owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); } catch { /* owner publication may still be in progress */ }
      const deadLocalOwner = owner?.hostname === mine.hostname && typeof owner.pid === "number" && (() => { try { process.kill(owner.pid!, 0); return false; } catch { return true; } })();
      /*
      FNXC:CursorMcpBridge 2026-08-15-21:46:
      mkdir is atomic but owner.json publication is a second operation. A fresh lock
      without metadata is an in-progress acquisition, not proof of abandonment;
      only its age may authorize reclamation, preventing two composers from entering.
      */
      const stale = lockAgeMs(lock) > BOOTSTRAP_LOCK_TTL_MS || deadLocalOwner || (owner !== undefined && Date.now() - (owner.acquiredAt ?? 0) > BOOTSTRAP_LOCK_TTL_MS);
      if (stale) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* contender owns the next retry */ } }
      if (attempt < BOOTSTRAP_LOCK_ATTEMPTS - 1) sleepSync(BOOTSTRAP_LOCK_RETRY_MS);
    }
  }
  if (!acquired) throw Object.assign(new Error("Cursor MCP exclude lock unavailable"), { code: "bridge-start-failed" });
  try { return fn(); } finally {
    try {
      const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as typeof mine;
      if (owner.pid === mine.pid && owner.hostname === mine.hostname) rmSync(lock, { recursive: true, force: true });
    } catch { /* a stale-lock reconciler owns recovery */ }
  }
}

export function ensureCursorConfigExcluded(worktreePath: string, options: { lockHeld?: boolean } = {}): { present: boolean; fusionAuthored: boolean; created: boolean } {
  const shape = resolveGitShape(worktreePath); if (!shape) return { present: false, fusionAuthored: false, created: false };
  const ensure = () => {
    const raw = existsSync(shape.excludePath) ? readFileSync(shape.excludePath, "utf8") : "";
    if (raw.includes(START) && raw.includes(END)) return { present: true, fusionAuthored: true, created: false };
    atomic(shape.excludePath, `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${block(shape)}`);
    return { present: true, fusionAuthored: true, created: true };
  };
  return options.lockHeld ? ensure() : withBootstrapLock(shape, ensure);
}

export function removeCursorConfigExclusion(worktreePath: string): void {
  const shape = resolveGitShape(worktreePath); if (!shape || !existsSync(shape.excludePath)) return;
  const raw = readFileSync(shape.excludePath, "utf8"); if (!raw.includes(START) || !raw.includes(END)) return;
  const next = withoutBlock(raw); if (next) atomic(shape.excludePath, next); else unlinkSync(shape.excludePath);
}

export function detectCursorResidue(worktreePath: string, _options: { preservedConfig?: "operator-edit" | "quarantined" } = {}): string[] {
  const cursor = join(worktreePath, ".cursor");
  return ["mcp.json", ".fusion-mcp-state.json", ".fusion-mcp.lock"].filter((name) => existsSync(join(cursor, name))).map((name) => join(cursor, name));
}
