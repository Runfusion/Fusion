import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceIntegrationTarget =
  | { kind: "local" }
  | { kind: "remote"; remote: string };

export class WorkspaceEnvironmentError extends Error {
  constructor(
    readonly repository: string,
    readonly resource: string,
    readonly action: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceEnvironmentError";
  }
}

export class WorkspaceIntegrationTargetError extends WorkspaceEnvironmentError {
  constructor(
    readonly repository: string,
    readonly resource: string,
    readonly action: string,
    message: string,
  ) {
    super(repository, resource, action, message);
    this.name = "WorkspaceIntegrationTargetError";
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/**
 * FNXC:WorkspaceIntegration 2026-08-21-21:46:
 * FN-122 chooses protections from each repository's actual write target. A repository with no
 * remote lands locally under its durable lease and local ref CAS; it must never probe or invent
 * `origin`. Configured/default remote selection is fail-closed when it cannot identify one remote.
 *
 * FNXC:WorkspaceIntegration 2026-08-30-09:14:
 * FN-263 requires an operator who disables publication to avoid every remote operation. Return the
 * local-only contract before probing, validating, or writing a remote, including a malformed
 * configured/default remote that would otherwise correctly fail closed.
 */
export async function resolveWorkspaceIntegrationTarget(input: {
  repository: string;
  cwd: string;
  integrationBranch: string;
  worktreeRebaseRemote?: string;
  publishToRemote?: boolean;
}): Promise<WorkspaceIntegrationTarget> {
  if (input.publishToRemote === false) return { kind: "local" };
  const remotes = (await git(["remote"], input.cwd)).split(/\s+/).filter(Boolean).sort();
  const configured = input.worktreeRebaseRemote?.trim();
  if (configured) {
    if (!remotes.includes(configured)) {
      throw new WorkspaceIntegrationTargetError(
        input.repository,
        `remote '${configured}'`,
        `configure remote '${configured}' or select an available integration remote`,
        `Workspace repository ${input.repository} has no configured integration remote '${configured}'`,
      );
    }
    return { kind: "remote", remote: configured };
  }

  const branchRemote = await git(["config", "--get", `branch.${input.integrationBranch}.remote`], input.cwd)
    .catch(() => "");
  if (branchRemote) {
    if (!remotes.includes(branchRemote)) {
      throw new WorkspaceIntegrationTargetError(
        input.repository,
        `branch remote '${branchRemote}'`,
        `configure remote '${branchRemote}' or choose an available integration remote`,
        `Workspace repository ${input.repository} references missing branch remote '${branchRemote}'`,
      );
    }
    return { kind: "remote", remote: branchRemote };
  }
  if (remotes.length === 0) return { kind: "local" };
  if (remotes.length === 1) return { kind: "remote", remote: remotes[0]! };
  if (remotes.includes("origin")) return { kind: "remote", remote: "origin" };
  throw new WorkspaceIntegrationTargetError(
    input.repository,
    "integration remote",
    "configure worktreeRebaseRemote or set the integration branch remote",
    `Workspace repository ${input.repository} has ambiguous integration remotes: ${remotes.join(", ")}`,
  );
}
