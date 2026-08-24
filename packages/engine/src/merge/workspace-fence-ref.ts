import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { WorkspaceLeaseClaimOutcome, WorkspaceLeaseHandle } from "@fusion/core";

const execFileAsync = promisify(execFile);

export class WorkspaceFenceRefError extends Error {
  constructor(
    message: string,
    readonly kind: "cas-rejected" | "transport",
  ) {
    super(message);
    this.name = "WorkspaceFenceRefError";
  }
}

interface WorkspaceLeaseFenceStore {
  recordWorkspaceLeaseFenceRef(input: {
    handle: WorkspaceLeaseHandle;
    fenceRefName: string;
    fenceRefSha: string;
  }): Promise<WorkspaceLeaseHandle>;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function remoteRefSha(remote: string, ref: string, cwd: string): Promise<string | undefined> {
  const output = await git(["ls-remote", remote, ref], cwd);
  const sha = output.split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/i.test(sha ?? "") ? sha : undefined;
}

/** Stable, collision-resistant slug without exposing a filesystem path as a ref hierarchy. */
export function workspaceLandFenceRef(repoRelPath: string): string {
  const slug = createHash("sha256").update(repoRelPath).digest("hex").slice(0, 24);
  return `refs/fusion/workspace-lease/${slug}`;
}

export function mergeDispatchFenceRef(taskId: string): string {
  // Task ids are server-generated restricted identifiers; still normalize the ref component.
  return `refs/fusion/merge-dispatch/${taskId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`;
}

async function createFenceObject(cwd: string, handle: WorkspaceLeaseHandle): Promise<string> {
  /*
  FNXC:WorkspaceMergeDispatch 2026-08-15-09:46:
  A merge-dispatch tenancy can land into several independent sub-repo remotes. Its fence object
  must therefore have the same object id in every clone. Pin both commit dates so this portable
  private-ref commit is deterministic across those clones.
  */
  const tree = await git(["hash-object", "-w", "-t", "tree", "/dev/null"], cwd);
  const message = `workspace lease ${handle.leaseKey} ${handle.owner.taskId} ${handle.owner.nodeId} ${handle.owner.incarnationId} ${handle.fenceToken}`;
  const { stdout } = await execFileAsync("git", [
    "-c", "user.name=Fusion", "-c", "user.email=fusion@localhost", "commit-tree", tree, "-m", message,
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  return stdout.trim();
}

/**
 * FNXC:Workspace 2026-08-15-08:30:
 * Fence refs are published once per tenancy, not once per claim call. A reentrant
 * claim must reuse its recorded pin: rotating it would reject this tenancy's own
 * prepared atomic push and orphan a pending land intent that names the old pin.
 */
export async function ensureTenancyFenceRef(input: {
  store: WorkspaceLeaseFenceStore;
  handle: WorkspaceLeaseHandle;
  claimOutcome: WorkspaceLeaseClaimOutcome;
  remote: string;
  cwd: string;
  fenceRefName: string;
}): Promise<WorkspaceLeaseHandle> {
  const { handle, claimOutcome } = input;
  const publishRequired = claimOutcome === "acquired"
    || claimOutcome === "reclaimed-expired"
    || (claimOutcome === "reentrant" && !handle.fenceRefSha);
  if (!publishRequired && (!handle.fenceRefName || !handle.fenceRefSha)) {
    throw new WorkspaceFenceRefError(`Workspace lease ${handle.leaseKey} has no recorded fence pin`, "transport");
  }

  /*
  FNXC:WorkspaceIntegration 2026-08-21-22:20:
  Remote discovery is itself a transport operation. Normalize its Git failure to the fence error
  contract so the workspace lander can surface a repository environment repair instead of burning
  the internal-technical retry budget before it reaches fence publication.
  */
  let observed: string | undefined;
  try {
    observed = await remoteRefSha(input.remote, input.fenceRefName, input.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspaceFenceRefError(
      `Unable to inspect required workspace fence ref ${input.fenceRefName}: ${message}`,
      "transport",
    );
  }
  // Reentrant callers normally find their pin already present. A workspace has one dispatch
  // tenancy but multiple remotes, so an absent/different remote must receive the same pin too.
  if (handle.fenceRefSha && observed === handle.fenceRefSha) return handle;
  const fenceSha = await createFenceObject(input.cwd, handle);
  if (handle.fenceRefSha && fenceSha !== handle.fenceRefSha) {
    throw new WorkspaceFenceRefError(`Workspace lease ${handle.leaseKey} fence object is not portable`, "transport");
  }
  const expected = observed ?? "";
  try {
    await git([
      "push",
      `--force-with-lease=${input.fenceRefName}:${expected}`,
      input.remote,
      `${fenceSha}:${input.fenceRefName}`,
    ], input.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = /stale info|rejected|lease|non-fast-forward/i.test(message) ? "cas-rejected" : "transport";
    throw new WorkspaceFenceRefError(
      `Unable to publish required workspace fence ref ${input.fenceRefName}: ${message}`,
      kind,
    );
  }

  // A stored pin identifies the tenancy. Publishing it to another sub-repo remote does not
  // rotate that durable pin or consume a new fence token.
  if (handle.fenceRefSha) return handle;
  try {
    return await input.store.recordWorkspaceLeaseFenceRef({
      handle,
      fenceRefName: input.fenceRefName,
      fenceRefSha: fenceSha,
    });
  } catch {
    throw new WorkspaceFenceRefError(`Workspace lease ${handle.leaseKey} was superseded while recording fence pin`, "cas-rejected");
  }
}

/** A single target+fence atomic CAS is the resource-level guard for shared git writes. */
export async function pushWithWorkspaceFence(input: {
  cwd: string;
  remote: string;
  sourceSha: string;
  targetRef: string;
  expectedTargetSha?: string;
  fenceRefName: string;
  fenceRefSha: string;
  /** Extra resource pins required by a caller's enclosing tenancy. */
  additionalFenceRefs?: Array<{ fenceRefName: string; fenceRefSha: string }>;
}): Promise<void> {
  const targetExpected = input.expectedTargetSha ?? "";
  const fenceRefs = [
    { fenceRefName: input.fenceRefName, fenceRefSha: input.fenceRefSha },
    ...(input.additionalFenceRefs ?? []),
  ];
  try {
    await git([
      "push",
      "--atomic",
      `--force-with-lease=${input.targetRef}:${targetExpected}`,
      ...fenceRefs.map((fence) => `--force-with-lease=${fence.fenceRefName}:${fence.fenceRefSha}`),
      input.remote,
      `${input.sourceSha}:${input.targetRef}`,
      ...fenceRefs.map((fence) => `${fence.fenceRefSha}:${fence.fenceRefName}`),
    ], input.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = /stale info|rejected|lease|non-fast-forward/i.test(message) ? "cas-rejected" : "transport";
    throw new WorkspaceFenceRefError(
      `Workspace fenced atomic push failed for ${input.targetRef} using ${input.fenceRefName}: ${message}`,
      kind,
    );
  }
}
