/**
 * FNXC:PlannerOversight 2026-07-13-22:55:
 * Discover OVERSEER.md / WATCHDOG.md review-priority files for the session
 * advisor system prompt (OMP WATCHDOG.md parity). Walks user agent dir +
 * project ancestors to repo root; never throws — missing/unreadable files
 * are skipped so a bad project config cannot kill the engine.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";

const log = createLogger("overseer-watchdog");

const WATCHDOG_FILENAMES = ["OVERSEER.md", "WATCHDOG.md"] as const;

export interface OverseerWatchdogCandidate {
  path: string;
  content: string;
  level: "user" | "project";
  /** Depth from cwd (0 = cwd). Higher depth = farther ancestor. */
  depth: number;
}

export interface DiscoverOverseerWatchdogOptions {
  cwd: string;
  /** User-level agent config dir (e.g. ~/.fusion or ~/.omp/agent). */
  agentDir?: string;
  /** Optional git root; when omitted, walks until home or filesystem root. */
  repoRoot?: string | null;
  /** Injected read for tests. */
  readText?: (path: string) => string | null;
}

function defaultReadText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Collect readable OVERSEER.md / WATCHDOG.md candidates, sorted user-first
 * then project ancestor→leaf (leaf last / most prominent).
 */
export function discoverOverseerWatchdogFiles(options: DiscoverOverseerWatchdogOptions): OverseerWatchdogCandidate[] {
  try {
    const cwd = resolve(options.cwd);
    const home = homedir();
    const agentDir = options.agentDir ? resolve(options.agentDir) : undefined;
    const repoRoot = options.repoRoot ? resolve(options.repoRoot) : null;
    const readText = options.readText ?? defaultReadText;

    const items: OverseerWatchdogCandidate[] = [];
    const seen = new Set<string>();

    const tryAdd = (filePath: string, level: "user" | "project", depth: number) => {
      const resolved = resolve(filePath);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      const content = readText(resolved);
      if (content == null || !content.trim()) return;
      items.push({ path: resolved, content, level, depth });
    };

    if (agentDir) {
      for (const name of WATCHDOG_FILENAMES) {
        tryAdd(join(agentDir, name), "user", 999);
      }
    }

    let current = cwd;
    const stopAt = repoRoot ?? home;
    // Safety bound: max 64 parent hops
    for (let hop = 0; hop < 64; hop++) {
      const depth =
        relative(cwd, current) === ""
          ? 0
          : relative(cwd, current).split(sep).filter(Boolean).length;
      for (const name of WATCHDOG_FILENAMES) {
        tryAdd(join(current, name), "project", depth);
        tryAdd(join(current, ".fusion", name), "project", depth);
        tryAdd(join(current, ".omp", name), "project", depth);
      }
      if (current === stopAt) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    items.sort((a, b) => {
      if (a.level !== b.level) return a.level === "user" ? -1 : 1;
      return b.depth - a.depth; // ancestor first, leaf last
    });

    return items;
  } catch (err) {
    log.warn(`discoverOverseerWatchdogFiles failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Format discovered files as prompt blocks appended to the advisor system prompt.
 */
export function formatOverseerWatchdogPromptBlocks(candidates: ReadonlyArray<OverseerWatchdogCandidate>): string[] {
  return candidates.map(
    (item) =>
      `Especially pay attention to:\n<attention source="${item.path}">\n${item.content.trim()}\n</attention>`,
  );
}
