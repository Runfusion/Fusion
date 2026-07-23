/*
FNXC:Onboarding 2026-07-18-03:20:
Field report: a user installed git DURING first-time setup, but project
creation kept failing with spawn git ENOENT until Fusion was restarted. The
running server's PATH snapshot predates the install (on Windows the installer
updates the registry PATH, which running processes never see), so bare
execFile("git", ...) cannot find a just-installed git. Resolve git once via
PATH and, on ENOENT, fall back to the platform's well-known install
locations; cache the winner and invalidate the cache on a later ENOENT so an
install or uninstall mid-session is picked up without a restart.
*/

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedGitBinary: string | null = null;

/** Well-known absolute git locations checked when PATH resolution fails. */
export function wellKnownGitBinaryPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : undefined,
    ].filter((root): root is string => Boolean(root));
    return roots.map((root) => join(root, "Git", "cmd", "git.exe"));
  }
  if (platform === "darwin") {
    return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
  }
  return ["/usr/bin/git", "/usr/local/bin/git"];
}

/** True when the error is a spawn-level "binary not found". */
export function isSpawnGitEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

/**
 * Resolve the git binary to spawn: "git" (PATH) when it works, otherwise the
 * first existing well-known install location. Returns "git" as the final
 * fallback so callers surface the ordinary ENOENT when git is truly absent.
 */
export async function resolveGitBinary(): Promise<string> {
  if (cachedGitBinary) return cachedGitBinary;
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000, windowsHide: true });
    cachedGitBinary = "git";
    return cachedGitBinary;
  } catch (error) {
    if (!isSpawnGitEnoent(error)) {
      // git exists but errored (e.g. timeout) — PATH resolution itself works.
      cachedGitBinary = "git";
      return cachedGitBinary;
    }
  }
  for (const candidate of wellKnownGitBinaryPaths()) {
    if (existsSync(candidate)) {
      cachedGitBinary = candidate;
      return cachedGitBinary;
    }
  }
  return "git";
}

/** Drop the cached resolution (call on a later ENOENT so installs/uninstalls mid-session are re-probed). */
export function invalidateGitBinaryCache(): void {
  cachedGitBinary = null;
}
