/*
FNXC:Workspace 2026-06-22-00:30:
Minimal shared repo-prefix-derivation helper for workspace mode (Phase B U2; master U5 reuses it). A workspace task's File Scope, modified-file list, and review/scope-leak findings are all repo-prefixed (`<repoRel>/<file>`). Per-repo review and per-repo scope-leak need to map a path → its owning sub-repo, and to derive each repo's File-Scope subset (so a reviewer at `cwd = repo.worktreePath` and a per-repo scope-leak check evaluate only that repo's declared paths).

NO lease logic lives here (file-scope leases are Phase C / master U7). This module is intentionally dependency-light (pure string/path math) so it can be reused across the executor, reviewer callers, and the later merge loop without pulling in executor state.

Matching rule: canonicalize the path to forward-slash relative segments, then pick the LONGEST configured repo key that is a path-segment prefix of the file path. Longest-prefix (not naive first-segment) correctly handles nested repo keys like `apps/web` while still satisfying the simple `wolf-server/src/** → wolf-server` case. A path that matches no configured repo (absolute paths outside the workspace, root-level files like `.changeset/x.md`, or a first segment that is not a repo) derives to the `UNSCOPED` sentinel.
*/

/** Sentinel returned when a path does not belong to any configured sub-repo. */
export const UNSCOPED_REPO = "unscoped" as const;

/*
FNXC:Workspace 2026-06-21-15:00:
F8 — single normalize helper. The executor previously kept its own `normalizeWorkflowScopePath` that was a near-duplicate of this function, differing only in leading-slash stripping (`/^\/+/` here vs none there) and trailing-slash greediness (`/\/+$/` here vs `/\/$/` there). Two slightly-different normalizers meant an absolute or trailing-slash-laden path could derive a different scope key in the two code paths. We promote THIS (more aggressive: strips leading slash + collapses repeated trailing slashes) to the single exported normalizer and have the executor import it for scope-path normalization, so workspace and non-workspace scope matching canonicalize identically. workspace-paths.ts stays dependency-light (imports nothing), so executor→workspace-paths is a one-way, acyclic edge.
*/
export function normalizeRepoRelPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Split a normalized path into non-empty segments. */
function segmentsOf(value: string): string[] {
  const normalized = normalizeRepoRelPath(value);
  return normalized ? normalized.split("/") : [];
}

/**
 * Return true when `repoSegs` is a leading segment-prefix of `pathSegs`.
 * Segment-wise (not substring) so `repo-a` does NOT match `repo-ab/...`.
 */
function isSegmentPrefix(repoSegs: string[], pathSegs: string[]): boolean {
  if (repoSegs.length === 0 || repoSegs.length > pathSegs.length) return false;
  for (let i = 0; i < repoSegs.length; i++) {
    if (repoSegs[i] !== pathSegs[i]) return false;
  }
  return true;
}

/**
 * Derive the configured sub-repo that owns `filePath`, or {@link UNSCOPED_REPO}.
 *
 * `repos` are the configured workspace sub-repo relative keys (from
 * `workspaceConfig.repos` or `Object.keys(task.workspaceWorktrees)`). The LONGEST
 * matching repo key wins so nested repos (`apps/web` vs `apps`) resolve to the
 * most specific owner.
 */
export function deriveRepoForPath(filePath: string, repos: readonly string[]): string {
  const pathSegs = segmentsOf(filePath);
  if (pathSegs.length === 0) return UNSCOPED_REPO;
  let best: string | null = null;
  let bestLen = 0;
  for (const repo of repos) {
    const repoSegs = segmentsOf(repo);
    if (repoSegs.length === 0) continue;
    if (isSegmentPrefix(repoSegs, pathSegs) && repoSegs.length > bestLen) {
      best = normalizeRepoRelPath(repo);
      bestLen = repoSegs.length;
    }
  }
  return best ?? UNSCOPED_REPO;
}

/**
 * Result of splitting a repo-prefixed File-Scope entry into its owning repo and
 * the repo-relative remainder (the path AS the reviewer at `cwd = repo` sees it).
 */
export interface RepoScopedPath {
  /** Owning sub-repo key, or {@link UNSCOPED_REPO}. */
  repo: string;
  /** The path with the repo prefix stripped (repo-local). Equals `path` when unscoped. */
  relativePath: string;
}

/**
 * Split a repo-prefixed path into `{ repo, relativePath }`. For `repo-a/src/x.ts`
 * with `repos=["repo-a"]` → `{ repo:"repo-a", relativePath:"src/x.ts" }`. An
 * unscoped path returns the whole normalized path as `relativePath`.
 */
export function splitRepoScopedPath(filePath: string, repos: readonly string[]): RepoScopedPath {
  const repo = deriveRepoForPath(filePath, repos);
  const normalized = normalizeRepoRelPath(filePath);
  if (repo === UNSCOPED_REPO) {
    return { repo, relativePath: normalized };
  }
  const repoNormalized = normalizeRepoRelPath(repo);
  const remainder = normalized.slice(repoNormalized.length).replace(/^\/+/, "");
  return { repo, relativePath: remainder };
}

/**
 * Derive a single sub-repo's File-Scope subset from the task's full (repo-prefixed)
 * declared scope. Returns the repo-LOCAL scope patterns (prefix stripped) so a
 * per-repo reviewer or per-repo scope-leak check — operating with `cwd = repo` —
 * can compare repo-local paths directly. Entries owned by other repos (or unscoped)
 * are excluded. A scope entry whose prefix-stripped remainder is empty (the repo
 * root itself, e.g. `repo-a` or `repo-a/`) maps to `**` (whole-repo scope).
 */
export function deriveRepoScopeSubset(declaredScope: readonly string[], repoRel: string): string[] {
  const repoSegs = segmentsOf(repoRel);
  if (repoSegs.length === 0) return [];
  const subset: string[] = [];
  for (const entry of declaredScope) {
    const entrySegs = segmentsOf(entry);
    if (!isSegmentPrefix(repoSegs, entrySegs)) continue;
    const remainder = entrySegs.slice(repoSegs.length).join("/");
    subset.push(remainder === "" ? "**" : remainder);
  }
  return subset;
}
