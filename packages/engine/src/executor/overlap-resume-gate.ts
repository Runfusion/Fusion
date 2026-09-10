import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { OverlapWaitExecutionIdentity, Task, TaskOverlapWait, TaskStore } from "@fusion/core";
import { analyzeOverlapResume, deliveryEvidenceFromTask, type OverlapDeliveryEvidence, type OverlapLandedPath, type OverlapResumeAnalysis } from "../execution/overlap-resume-analysis.js";
import { buildOverlapResumeContext } from "../execution/overlap-resume-context.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";

const execFileAsync = promisify(execFile);

export class OverlapResumeSynchronizationError extends Error {
  constructor(readonly reason: "delivery-unavailable" | "stale-dirty-worktree" | "freshness-unproven" | "superseded", message: string) {
    super(message);
    this.name = "OverlapResumeSynchronizationError";
  }
}

async function includesCommit(worktreePath: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: worktreePath });
    return true;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1) return false;
    throw new OverlapResumeSynchronizationError("freshness-unproven", `Unable to prove delivered commit ${sha} in the execution checkout`);
  }
}

async function recaptureLandedPaths(worktreePath: string, repository: string, sha: string): Promise<OverlapLandedPath[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", sha], { cwd: worktreePath, encoding: "utf8", maxBuffer: 4_000_000 });
    const fields = stdout.split("\0").filter(Boolean);
    const paths: OverlapLandedPath[] = [];
    for (let index = 0; index < fields.length;) {
      const statusToken = fields[index++]!;
      const statusCode = statusToken[0];
      if (statusCode === "R" || statusCode === "C") {
        const previousPath = fields[index++];
        const path = fields[index++];
        if (previousPath && path) paths.push({ repository, previousPath, path, status: "renamed" });
        continue;
      }
      const path = fields[index++];
      if (!path) continue;
      const status = statusCode === "A" ? "added" : statusCode === "D" ? "deleted" : "modified";
      paths.push({ repository, path, status });
    }
    return paths;
  } catch {
    return undefined;
  }
}

function deliveriesFromObservation(episode: TaskOverlapWait): OverlapDeliveryEvidence[] {
  const value = episode.observation?.deliveries;
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is OverlapDeliveryEvidence => Boolean(candidate && typeof candidate === "object" && typeof (candidate as OverlapDeliveryEvidence).repository === "string"))
    .map((candidate) => ({ ...candidate, blockerTaskId: episode.blockerTaskId, blockerLineageId: episode.blockerLineageId ?? candidate.blockerLineageId }));
}

async function isDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktreePath });
  return stdout.length > 0;
}

export interface OverlapResumeGateResult {
  analysis?: OverlapResumeAnalysis;
  context?: string;
  episodeIds: string[];
}

/** Strict only when a durable overlap episode exists. It never changes ordinary optional refresh policy. */
export async function synchronizeOverlapWaitBeforeExecution(input: {
  task: Task;
  store: Pick<TaskStore, "listTaskOverlapWaits" | "claimTaskOverlapWait" | "completeTaskOverlapWait" | "getTask">;
  worktreePath: string;
  owner: string;
  checkoutEpoch?: string;
  refresh?: () => Promise<unknown>;
  repository?: string;
  nodeId?: string;
  nodeInstanceId?: string;
}): Promise<OverlapResumeGateResult> {
  if (typeof input.store.listTaskOverlapWaits !== "function") return { episodeIds: [] };
  const pending = await input.store.listTaskOverlapWaits(input.task.id, { pendingOnly: true });
  // Structural test doubles and legacy adapters may expose the method before wiring a value.
  if (!Array.isArray(pending) || pending.length === 0) return { episodeIds: [] };
  const alreadyReady = pending.filter((episode) => episode.phase === "ready");
  const work = pending.filter((episode) => episode.phase !== "ready");
  if (work.length === 0) {
    const contexts = [...new Set(alreadyReady.map((episode) => episode.receipt?.briefing).filter((value): value is string => Boolean(value)))];
    return { episodeIds: alreadyReady.map((episode) => episode.episodeId), context: contexts.length ? contexts.join("\n\n") : undefined };
  }
  const repository = input.repository ?? ".";
  const deliveries: OverlapDeliveryEvidence[] = [];
  const allCapturedDeliveries: OverlapDeliveryEvidence[] = [];
  for (const episode of work) {
    const captured = deliveriesFromObservation(episode);
    if (captured.length > 0) {
      allCapturedDeliveries.push(...captured);
      deliveries.push(...captured.filter((delivery) => delivery.repository === repository || (repository === "." && delivery.repository === ".")));
      continue;
    }
    // Legacy episodes may predate durable delivery snapshots. This fallback is never needed for new publications.
    const blocker = await input.store.getTask(episode.blockerTaskId).catch(() => undefined);
    deliveries.push(...(blocker
      ? deliveryEvidenceFromTask(blocker).filter((delivery) => delivery.repository === repository || (repository === "." && delivery.repository === "."))
      : [{ blockerTaskId: episode.blockerTaskId, repository, evidence: "unavailable" as const }]));
  }
  for (const delivery of deliveries) {
    if (delivery.landedSha && delivery.paths === undefined) {
      delivery.paths = await recaptureLandedPaths(input.worktreePath, delivery.repository, delivery.landedSha);
      if (delivery.paths) delivery.evidence = "git-recapture";
    }
    if (!delivery.landedSha || !delivery.paths) continue;
    for (const path of delivery.paths) {
      if (path.diff !== undefined) continue;
      try {
        const { stdout } = await execFileAsync("git", ["show", "--format=", "--unified=0", delivery.landedSha, "--", path.path], { cwd: input.worktreePath, maxBuffer: 2_000_000 });
        path.diff = stdout;
      } catch {
        // Missing/unreadable contract evidence remains undefined and routes to targeted revalidation.
      }
    }
  }
  const analysis = analyzeOverlapResume({ task: input.task, deliveries });
  const requiredRepositories = new Set(allCapturedDeliveries.map((delivery) => delivery.repository));
  if (requiredRepositories.size === 0) requiredRepositories.add(repository);
  const previouslyFreshRepositories = new Set(work.flatMap((episode) => episode.receipt?.deliveryProofs ?? [])
    .filter((proof) => proof.freshness === "proven" || proof.freshness === "not-required")
    .map((proof) => proof.repository));
  let everyRepositoryFresh = false;
  const claims: TaskOverlapWait[] = [];
  let executionIdentity: OverlapWaitExecutionIdentity | undefined;
  const claimCurrentGeneration = async (): Promise<void> => {
    if (claims.length > 0) return;
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.worktreePath, encoding: "utf8" })).stdout.trim();
    executionIdentity = {
      ...(input.task.lineageId ? { taskLineageId: input.task.lineageId } : {}),
      ...(input.task.prompt ? { planFingerprint: createHash("sha256").update(input.task.prompt).digest("hex") } : {}),
      ...(input.checkoutEpoch ? { checkoutEpoch: input.checkoutEpoch } : {}),
      ...(input.task.worktree ? { worktree: input.task.worktree } : {}),
      ...(input.task.branch ? { branch: input.task.branch } : {}),
      headSha,
      repository,
      ...(deliveries.find((delivery) => delivery.repository === repository)?.target ? { target: deliveries.find((delivery) => delivery.repository === repository)!.target } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.nodeInstanceId ? { nodeInstanceId: input.nodeInstanceId } : {}),
    };
    for (const episode of work) {
      const claimed = await input.store.claimTaskOverlapWait({ taskId: input.task.id, episodeId: episode.episodeId, expectedRevision: episode.revision, owner: input.owner, checkoutEpoch: input.checkoutEpoch, executionIdentity });
      if (!claimed) throw new OverlapResumeSynchronizationError("superseded", `Overlap synchronization episode ${episode.episodeId} changed before claim`);
      claims.push(claimed);
    }
  };
  if (analysis.decision === "freshness-pending") {
    await persist(claims, "freshness-pending", "unavailable");
    throw new OverlapResumeSynchronizationError("delivery-unavailable", "Delivered file evidence is not yet available for overlap synchronization");
  }

  const expectedShas = [...new Set(deliveries.filter((delivery) => delivery.repository === repository).map((delivery) => delivery.landedSha).filter((sha): sha is string => Boolean(sha)))];
  let missing: string[] = [];
  for (const sha of expectedShas) if (!await includesCommit(input.worktreePath, sha)) missing.push(sha);
  if (missing.length > 0) {
    if (await isDirty(input.worktreePath)) {
      await persist(claims, "freshness-pending", "conflict");
      throw new OverlapResumeSynchronizationError("stale-dirty-worktree", "Execution checkout is stale and contains uncommitted work; synchronization preserved it in place");
    }
    if (input.refresh) await input.refresh();
    missing = [];
    for (const sha of expectedShas) if (!await includesCommit(input.worktreePath, sha)) missing.push(sha);
  }
  if (missing.length > 0) {
    await persist(claims, "freshness-pending", "unavailable");
    throw new OverlapResumeSynchronizationError("freshness-unproven", "Execution checkout does not contain every delivered predecessor commit");
  }
  const freshness = expectedShas.length ? "proven" : "not-required";
  previouslyFreshRepositories.add(repository);
  everyRepositoryFresh = [...requiredRepositories].every((required) => previouslyFreshRepositories.has(required));
  const finalPhase = everyRepositoryFresh
    ? analysis.decision === "revalidate" || work.some((episode) => episode.receipt?.decision === "revalidate") ? "revalidation-pending" : "ready"
    : "freshness-pending";
  await persist(claims, finalPhase, freshness);
  if (finalPhase === "ready") {
    void emitBoundedRunAudit(input.store as TaskStore, {
      taskId: input.task.id,
      agentId: input.owner,
      runId: `overlap-wait-release:${input.task.id}:${analysis.decisionFingerprint}`,
      domain: "database",
      mutationType: "task:overlap-wait-released",
      target: input.task.id,
      metadata: {
        taskId: input.task.id,
        blockerTaskIds: [...new Set(deliveries.map((delivery) => delivery.blockerTaskId))],
        episodeCount: claims.length,
        commonFileCount: analysis.commonFiles.length,
        decision: analysis.decision,
        freshness,
      },
    });
  }
  return { analysis, context: buildOverlapResumeContext(analysis), episodeIds: claims.map((claim) => claim.episodeId) };

  async function persist(claimed: TaskOverlapWait[], phase: "ready" | "freshness-pending" | "revalidation-pending", freshness: "proven" | "not-required" | "conflict" | "unavailable") {
    await claimCurrentGeneration();
    for (const claim of claims) {
      const live = await input.store.getTask(input.task.id);
      if (!live || live.deletedAt || live.paused || live.userPaused) {
        throw new OverlapResumeSynchronizationError("superseded", `Overlap synchronization episode ${claim.episodeId} lost its task owner`);
      }
      const currentHeadSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.worktreePath, encoding: "utf8" })).stdout.trim();
      const currentIdentity: OverlapWaitExecutionIdentity = {
        ...(live.lineageId ? { taskLineageId: live.lineageId } : {}),
        ...(live.prompt ? { planFingerprint: createHash("sha256").update(live.prompt).digest("hex") } : {}),
        ...(live.checkoutLeaseEpoch != null ? { checkoutEpoch: String(live.checkoutLeaseEpoch) } : input.checkoutEpoch ? { checkoutEpoch: input.checkoutEpoch } : {}),
        ...(live.worktree ? { worktree: live.worktree } : {}),
        ...(live.branch ? { branch: live.branch } : {}),
        headSha: currentHeadSha,
        repository,
        ...(executionIdentity?.target ? { target: executionIdentity.target } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.nodeInstanceId ? { nodeInstanceId: input.nodeInstanceId } : {}),
      };
      const updated = await input.store.completeTaskOverlapWait({
        executionIdentity: currentIdentity,
        taskId: input.task.id,
        episodeId: claim.episodeId,
        expectedRevision: claim.revision,
        owner: input.owner,
        phase,
        receipt: {
          decision: claim.receipt?.decision === "revalidate" || analysis.decision === "revalidate" || analysis.decision === "freshness-pending"
            ? "revalidate"
            : claim.receipt?.decision === "briefing" || analysis.decision === "briefing" ? "briefing" : "resume",
          freshness: everyRepositoryFresh ? freshness : freshness === "conflict" ? "conflict" : "pending",
          commonFiles: [...new Set([...(claim.receipt?.commonFiles ?? []), ...analysis.commonFiles])],
          deliveryProofs: [
            ...claim.receipt?.deliveryProofs?.filter((proof) => proof.repository !== repository) ?? [],
            ...deliveries.map((delivery) => ({ repository: delivery.repository, target: delivery.target, landedSha: delivery.landedSha, landedFiles: delivery.paths?.flatMap((path) => path.previousPath ? [path.previousPath, path.path] : [path.path]), noOp: delivery.noOp, evidence: delivery.evidence, freshness })),
          ],
          decisionFingerprint: createHash("sha256").update(`${claim.receipt?.decisionFingerprint ?? ""}\0${analysis.decisionFingerprint}`).digest("hex"),
          briefing: [claim.receipt?.briefing, buildOverlapResumeContext(analysis)].filter(Boolean).join("\n\n") || undefined,
          reason: analysis.reason,
          decidedAt: new Date().toISOString(),
        },
      });
      if (!updated) throw new OverlapResumeSynchronizationError("superseded", `Overlap synchronization episode ${claim.episodeId} changed before publication`);
    }
  }
}
