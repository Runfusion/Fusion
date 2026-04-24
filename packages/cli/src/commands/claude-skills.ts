/**
 * Claude Code skill installation for Fusion projects.
 *
 * When pi-claude-cli routes the model through Claude Code, pi's own skill
 * injection is bypassed (pi-claude-cli only forwards systemPrompt + AGENTS.md).
 * Claude Code instead auto-loads skills from `<project>/.claude/skills/<name>/`
 * and `~/.claude/skills/<name>/`. To make the fusion skill available inside
 * Claude Code sessions, we symlink the shipped `skill/fusion` directory into
 * each project's `.claude/skills/fusion/`.
 *
 * Entry points that call installFusionSkillIntoProject:
 *   - `fn init` (packages/cli/src/commands/init.ts)
 *   - `fn project add` (packages/cli/src/commands/project.ts)
 *   - POST /api/projects (packages/dashboard/src/routes.ts)
 *   - serve.ts startup reconciliation (packages/cli/src/commands/serve.ts)
 *
 * All call sites are guarded by isPiClaudeCliConfigured() so users who don't
 * route through Claude Code never see `.claude/skills/` appear in their repos.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The skill directory name under `.claude/skills/`. The shipped source at
 * `packages/cli/skill/fusion/` is symlinked in at this path.
 */
export const FUSION_SKILL_NAME = "fusion";

/**
 * Result of an install attempt.
 *
 * - "installed": created a new symlink (or copy fallback)
 * - "already-installed": correct link/copy already present, nothing to do
 * - "skipped": pi-claude-cli not configured, intentionally did nothing
 * - "replaced": an existing incorrect entry was replaced
 * - "failed": error occurred; reason populated
 */
export type InstallOutcome =
  | "installed"
  | "already-installed"
  | "skipped"
  | "replaced"
  | "failed";

export interface InstallResult {
  outcome: InstallOutcome;
  target: string;
  source?: string;
  reason?: string;
}

/**
 * Check whether the user has pi-claude-cli configured, meaning pi should route
 * model calls through Claude Code and we should mirror the fusion skill into
 * each project's `.claude/skills/`.
 *
 * Detection order:
 *  1. Explicit `useClaudeCli` boolean in global settings (either value wins)
 *  2. Legacy signal: `packages` array contains `"npm:pi-claude-cli"`
 */
export function isPiClaudeCliConfigured(
  globalSettings: Record<string, unknown> | null | undefined,
): boolean {
  if (!globalSettings || typeof globalSettings !== "object") {
    return false;
  }
  const toggle = (globalSettings as { useClaudeCli?: unknown }).useClaudeCli;
  if (typeof toggle === "boolean") {
    return toggle;
  }
  const packages = (globalSettings as { packages?: unknown }).packages;
  if (Array.isArray(packages)) {
    return packages.some(
      (entry) =>
        typeof entry === "string" &&
        /(^|[:/])pi-claude-cli(@|$)/.test(entry.trim()),
    );
  }
  return false;
}

/**
 * Resolve the path to the shipped fusion skill directory.
 *
 * At runtime this file lives at `<cli-pkg>/dist/commands/claude-skills.js`
 * when published, and `<cli-pkg>/src/commands/claude-skills.ts` in dev under
 * tsx. Either way, `../../skill/fusion` points at the packaged skill.
 *
 * Returns null if the directory is missing (e.g. broken install).
 */
export function resolveFusionSkillSource(): string | null {
  const here = fileURLToPath(import.meta.url);
  const candidate = resolve(dirname(here), "..", "..", "skill", FUSION_SKILL_NAME);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Install the fusion skill into `<projectPath>/.claude/skills/fusion`.
 *
 * Idempotent:
 *  - If the target is already a symlink to the current source, no-op.
 *  - If it's a stale symlink or a foreign file/dir, it's replaced.
 *  - Prefers symlinks so skill updates flow automatically when the fusion
 *    package is upgraded; falls back to a copy on platforms where symlinks
 *    aren't allowed (typically Windows without developer mode).
 *
 * Never throws: errors are captured and returned as {outcome: "failed", reason}.
 */
export function installFusionSkillIntoProject(
  projectPath: string,
  options: { source?: string | null; enabled?: boolean } = {},
): InstallResult {
  const target = join(projectPath, ".claude", "skills", FUSION_SKILL_NAME);

  if (options.enabled === false) {
    return { outcome: "skipped", target, reason: "pi-claude-cli not configured" };
  }

  const source = options.source ?? resolveFusionSkillSource();
  if (!source) {
    return {
      outcome: "failed",
      target,
      reason: "fusion skill source directory not found in installed package",
    };
  }

  try {
    mkdirSync(dirname(target), { recursive: true });

    let replaced = false;
    if (existsSync(target) || isBrokenSymlink(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        const current = safeReadlink(target);
        if (current && resolve(dirname(target), current) === resolve(source)) {
          return { outcome: "already-installed", target, source };
        }
        unlinkSync(target);
        replaced = true;
      } else {
        // A directory or file occupies the slot — don't blow it away unless
        // it looks like something we created. Check for a SKILL.md to reduce
        // the odds of clobbering a user's hand-authored skill.
        const skillMd = join(target, "SKILL.md");
        if (!existsSync(skillMd)) {
          return {
            outcome: "failed",
            target,
            reason: "target exists and does not look like a fusion skill install",
          };
        }
        // Replace: a plain copy from a prior install. Delete and re-symlink.
        removeRecursive(target);
        replaced = true;
      }
    }

    try {
      symlinkSync(source, target, "dir");
    } catch (err) {
      // Windows / restricted FS — copy instead.
      const reason = err instanceof Error ? err.message : String(err);
      try {
        cpSync(source, target, { recursive: true });
        return {
          outcome: replaced ? "replaced" : "installed",
          target,
          source,
          reason: `symlink failed (${reason}); copied files instead`,
        };
      } catch (copyErr) {
        return {
          outcome: "failed",
          target,
          source,
          reason: copyErr instanceof Error ? copyErr.message : String(copyErr),
        };
      }
    }

    return { outcome: replaced ? "replaced" : "installed", target, source };
  } catch (err) {
    return {
      outcome: "failed",
      target,
      source,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Install the fusion skill into every project in a list. Used at server
 * startup to self-heal any projects whose `.claude/skills/fusion` was removed
 * or never installed (e.g. projects registered before this feature landed).
 *
 * Failures are collected but never thrown — startup must not be blocked by
 * filesystem quirks on a single project.
 */
export function ensureFusionSkillForProjects(
  projects: Array<{ id: string; name: string; path: string }>,
  options: { enabled: boolean; source?: string | null } = { enabled: false },
): InstallResult[] {
  if (!options.enabled) {
    return projects.map((p) => ({
      outcome: "skipped" as const,
      target: join(p.path, ".claude", "skills", FUSION_SKILL_NAME),
      reason: "pi-claude-cli not configured",
    }));
  }
  const source = options.source ?? resolveFusionSkillSource();
  return projects.map((p) =>
    installFusionSkillIntoProject(p.path, { source, enabled: true }),
  );
}

function isBrokenSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    return !existsSync(path);
  } catch {
    return false;
  }
}

function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function removeRecursive(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
