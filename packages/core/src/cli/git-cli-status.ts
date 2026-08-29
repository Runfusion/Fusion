import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { wellKnownGitBinaryPaths } from "./git-binary.js";

export const GIT_INSTALL_URL = "https://git-scm.com/downloads";
export const DEFAULT_GIT_CLI_STATUS_TIMEOUT_MS = 2_500;

export interface GitCliStatus {
  available: boolean;
  version?: string;
  installUrl: string;
}

export interface ProbeGitCliStatusOptions {
  timeoutMs?: number;
  /**
   * FNXC:Onboarding 2026-07-18-03:20:
   * Absolute git candidates probed when the PATH lookup ENOENTs. Defaults to
   * the platform's existing well-known install locations. Injectable so tests
   * stay hermetic (the default probes the real filesystem).
   */
  fallbackGitPaths?: readonly string[];
}

function parseGitVersion(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/git version\s+(.+)/i);
  return match?.[1]?.trim() || trimmed;
}

type ProbeAttempt = { status: GitCliStatus } | "enoent" | "error";

function attemptGitVersion(binary: string, timeoutMs: number): Promise<ProbeAttempt> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      ["--version"],
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        if (error) {
          resolve(error.code === "ENOENT" ? "enoent" : "error");
          return;
        }
        resolve({
          status: {
            available: true,
            version: parseGitVersion(String(stdout)),
            installUrl: GIT_INSTALL_URL,
          },
        });
      },
    );

    child.stdin?.end();
  });
}

/**
 * FNXC:Onboarding 2026-07-03-00:00:
 * First-run GitHub onboarding must detect whether `git` is available on the Fusion server host before clone/init flows fail later.
 * Keep this probe bounded and argument-vector based so auth status can include prerequisite guidance without shell interpolation or long subprocess hangs.
 *
 * FNXC:Onboarding 2026-07-18-03:20:
 * Field report: git installed DURING first-run setup stayed "missing" (and project
 * setup kept failing spawn-git ENOENT) because the server's PATH snapshot predates
 * the install. On a PATH ENOENT, probe the platform's well-known install locations
 * so a just-installed git is detected without restarting Fusion.
 */
export async function probeGitCliStatus(options: ProbeGitCliStatusOptions = {}): Promise<GitCliStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_CLI_STATUS_TIMEOUT_MS;

  const first = await attemptGitVersion("git", timeoutMs);
  if (typeof first === "object") return first.status;
  if (first === "enoent") {
    /*
    FNXC:Onboarding 2026-07-18-06:00:
    Review finding: probing EVERY existing candidate could take (1+N) x
    timeoutMs on hosts littered with leftover git installs. Keep the probe
    bounded at two spawns: PATH plus the FIRST existing well-known location
    (if that one exists but cannot run, git is broken regardless).
    */
    const candidates = options.fallbackGitPaths ?? wellKnownGitBinaryPaths().filter((p) => existsSync(p));
    const candidate = candidates[0];
    if (candidate !== undefined) {
      const attempt = await attemptGitVersion(candidate, timeoutMs);
      if (typeof attempt === "object") return attempt.status;
    }
  }
  return { available: false, installUrl: GIT_INSTALL_URL };
}
