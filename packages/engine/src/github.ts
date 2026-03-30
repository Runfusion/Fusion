import { execFileSync } from "node:child_process";

/**
 * Extract owner/repo from a GitHub remote URL or return null if not a GitHub remote.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // Handle HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = remoteUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // Handle SSH: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = remoteUrl.match(/github\.com:([^\/]+)\/([^\/\.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Get the current GitHub remote owner/repo from the git config.
 */
export function getCurrentGitHubRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return parseGitHubRemote(remoteUrl);
  } catch {
    return null;
  }
}
