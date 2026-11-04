import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";
import type { OverlapWaitExecutionIdentity, Task, TaskOverlapWait, TaskStore } from "@fusion/core";
import { analyzeOverlapResume, deliveryEvidenceFromTask, type OverlapDeliveryEvidence, type OverlapLandedPath, type OverlapResumeAnalysis } from "../execution/overlap-resume-analysis.js";
import { buildOverlapResumeContext } from "../execution/overlap-resume-context.js";
import { reconcileRewrittenDelivery } from "../execution/rewritten-delivery-reconciliation.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";

const execFileAsync = promisify(execFile);

/*
FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
FN-429. Diagnostic dedup for stale delivery evidence. FN-428 showed the operator-visible failure mode is
repetition: the same unresolved delivery was re-examined on every dispatch, so the useful line (WHICH
remembered SHA is stale and what happened to it) must be written once per outcome, not per attempt.
*/
const reconciliationDiagnosticDedup = new Set<string>();
const RECONCILIATION_DIAGNOSTIC_DEDUP_LIMIT = 500;

function claimReconciliationDiagnostic(key: string): boolean {
  if (reconciliationDiagnosticDedup.has(key)) return false;
  if (reconciliationDiagnosticDedup.size >= RECONCILIATION_DIAGNOSTIC_DEDUP_LIMIT) reconciliationDiagnosticDedup.clear();
  reconciliationDiagnosticDedup.add(key);
  return true;
}

/** Test-only reset of the bounded diagnostic dedup set. */
export function __resetOverlapReconciliationDiagnosticDedup(): void {
  reconciliationDiagnosticDedup.clear();
}

/*
FNXC:OverlapAcquisitionPark 2026-11-04-01:05 (RUFU-373):
A refusal of worktree acquisition by overlap synchronization used to carry only its sentence, so the
caller could not tell WHICH artifact was missing and the operator could not see who was being waited
for. SANE-436 read `Delivered file evidence is not yet available for overlap synchronization` and
nothing named the predecessor; ROZV-197 repeated that 6 939 times. The payload is therefore fixed-shape
and ids-only — episode ids, blocker task ids, repositories, and one closed reason — so a heartbeat or
the run-audit row can name the missing artifact without ever copying prose into telemetry.

Messages are unchanged: `isRecoverableOverlapWaitFailure` and every existing consumer matches on the
sentence, and widening the error type must not break that string contract.
*/
export type OverlapMissingEvidence =
  | "delivery-evidence-unavailable"
  | "checkout-freshness-unproven"
  | "checkout-dirty"
  | "episode-superseded";

export interface OverlapRefusalArtifacts {
  episodeIds: string[];
  blockerTaskIds: string[];
  repositories: string[];
  missingEvidence: OverlapMissingEvidence;
}

/** Used before any episode is in scope (and by doubles that never reach the analysis phase). */
export const EMPTY_OVERLAP_REFUSAL_ARTIFACTS: OverlapRefusalArtifacts = {
  episodeIds: [], blockerTaskIds: [], repositories: [], missingEvidence: "episode-superseded",
};

export class OverlapResumeSynchronizationError extends Error {
  constructor(
    readonly reason: "delivery-unavailable" | "stale-dirty-worktree" | "freshness-unproven" | "superseded",
    message: string,
    readonly artifacts: OverlapRefusalArtifacts = EMPTY_OVERLAP_REFUSAL_ARTIFACTS,
  ) {
    super(message);
    this.name = "OverlapResumeSynchronizationError";
  }
}

async function includesCommit(worktreePath: string, sha: string, artifacts: OverlapRefusalArtifacts): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: worktreePath });
    return true;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1) return false;
    throw new OverlapResumeSynchronizationError("freshness-unproven", `Unable to prove delivered commit ${sha} in the execution checkout`, artifacts);
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

/** Ancestry probe that never escalates an unreadable object into a refusal of its own. */
async function containsCommitSafely(worktreePath: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: worktreePath });
    return true;
  } catch {
    return false;
  }
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

/*
FNXC:WorkspaceWorktree 2026-11-04-01:05 (RUFU-373, extends FN-9295):
The workspace per-repository acquisition callback already holds the task's non-reentrant advisory lock,
so `reconcileTaskOverlapWaits` / `claimTaskOverlapWait` / `completeTaskOverlapWait` cannot run inside it
— the lock-restricted store seam refuses them rather than dead-locking. Before this option, a workspace
card with ANY pending episode died on `Workspace acquisition cannot call unsupported TaskStore method
reconcileTaskOverlapWaits while the task lock is held` and never reached an analysis at all.

Deferring persistence keeps the ANALYSIS and every refusal identical — the gate still throws, so it can
never silently resume an unmet obligation — and simply leaves the durable writes to the enforcement point
that runs outside the lock: the executor gate entry in `run-implementation.ts`. Absence of the three
write methods is what signals the restricted seam; the store itself never has to announce it.
*/

/** Strict only when a durable overlap episode exists. It never changes ordinary optional refresh policy. */
export async function synchronizeOverlapWaitBeforeExecution(input: {
  task: Task;
  store: Pick<TaskStore, "listTaskOverlapWaits" | "getTask"> & Partial<Pick<TaskStore, "logEntry" | "reconcileTaskOverlapWaits" | "claimTaskOverlapWait" | "completeTaskOverlapWait">>;
  worktreePath: string;
  owner: string;
  checkoutEpoch?: string;
  refresh?: () => Promise<unknown>;
  repository?: string;
  nodeId?: string;
  nodeInstanceId?: string;
  deferPersistence?: boolean;
}): Promise<OverlapResumeGateResult> {
  const deferPersistence = input.deferPersistence === true;
  // The restricted seam simply omits the write methods; their absence is the signal, so no store has to announce it.
  const claimEpisode = input.store.claimTaskOverlapWait?.bind(input.store);
  const completeEpisode = input.store.completeTaskOverlapWait?.bind(input.store);
  if (typeof input.store.listTaskOverlapWaits !== "function") return { episodeIds: [] };
  let pending = await input.store.listTaskOverlapWaits(input.task.id, { pendingOnly: true });
  // Structural test doubles and legacy adapters may expose the method before wiring a value.
  if (!Array.isArray(pending) || pending.length === 0) return { episodeIds: [] };
  // FNXC:OverlapWaitRelease 2026-09-17-06:29: Reconcile abandoned predecessors at every entry, not only on the next maintenance sweep. Ordinary execution without a wait keeps its cheap read-only path.
  if (!deferPersistence && input.store.reconcileTaskOverlapWaits) {
    await input.store.reconcileTaskOverlapWaits(input.task.id);
    pending = await input.store.listTaskOverlapWaits(input.task.id, { pendingOnly: true });
    if (pending.length === 0) return { episodeIds: [] };
  }
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
  /*
  FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
  FN-429. A reconciliation already proven by an earlier owner is reused, but only after re-proving the
  reconciled SHA in the CURRENT checkout. Retry, engine restart, and worktree deletion therefore keep the
  progress, while a receipt inherited from a checkout that no longer contains that commit is ignored and
  re-derived instead of trusted.
  */
  const memorizedProofs = work.flatMap((episode) => episode.receipt?.deliveryProofs ?? []);
  for (const delivery of deliveries) {
    if (!delivery.landedSha) continue;
    const memorized = memorizedProofs.find((proof) => proof.repository === delivery.repository && proof.landedSha === delivery.landedSha && Boolean(proof.reconciledSha));
    if (!memorized?.reconciledSha) continue;
    if (!await containsCommitSafely(input.worktreePath, memorized.reconciledSha)) continue;
    delivery.reconciledSha = memorized.reconciledSha;
    if (memorized.reconciliationProof) delivery.reconciliationProof = memorized.reconciliationProof;
  }

  /** Effective delivered SHA: the proven rewrite when one exists, otherwise the SHA recorded at landing. */
  const effectiveSha = (delivery: OverlapDeliveryEvidence): string | undefined => delivery.reconciledSha ?? delivery.landedSha;
  let analysis: OverlapResumeAnalysis | undefined;
  const analyze = async (recaptureFrom?: Set<OverlapDeliveryEvidence>): Promise<OverlapResumeAnalysis> => {
    for (const delivery of deliveries) {
      const sha = effectiveSha(delivery);
      if (!sha) continue;
      if (delivery.paths === undefined || recaptureFrom?.has(delivery)) {
        delivery.paths = await recaptureLandedPaths(input.worktreePath, delivery.repository, sha);
        if (delivery.paths) delivery.evidence = "git-recapture";
      }
      if (!delivery.paths) continue;
      for (const path of delivery.paths) {
        if (path.diff !== undefined) continue;
        try {
          const { stdout } = await execFileAsync("git", ["show", "--format=", "--unified=0", sha, "--", path.path], { cwd: input.worktreePath, maxBuffer: 2_000_000 });
          path.diff = stdout;
        } catch {
          // Missing/unreadable contract evidence remains undefined and routes to targeted revalidation.
        }
      }
    }
    analysis = analyzeOverlapResume({ task: input.task, deliveries });
    return analysis;
  };
  const requiredRepositories = new Set(allCapturedDeliveries.map((delivery) => delivery.repository));
  if (requiredRepositories.size === 0) requiredRepositories.add(repository);
  /*
   * FNXC:OverlapAcquisitionPark 2026-11-04-01:05 (RUFU-373): the refusal payload, assembled once from the
   * analysis inputs and fixed-shape (ids + one closed reason), so the heartbeat park and its run-audit row
   * can name WHICH artifact is missing and WHO owns it without copying prose into telemetry.
   */
  const artifactEpisodeIds = [...new Set(work.map((episode) => episode.episodeId))];
  const artifactBlockerTaskIds = [...new Set([
    ...work.map((episode) => episode.blockerTaskId),
    ...deliveries.map((delivery) => delivery.blockerTaskId),
  ])];
  const artifactRepositories = [...new Set([...allCapturedDeliveries, ...deliveries].map((delivery) => delivery.repository))];
  const artifactsFor = (missingEvidence: OverlapMissingEvidence): OverlapRefusalArtifacts => ({
    episodeIds: [...artifactEpisodeIds],
    blockerTaskIds: [...artifactBlockerTaskIds],
    repositories: artifactRepositories.length > 0 ? [...artifactRepositories] : [repository],
    missingEvidence,
  });
  const previouslyFreshRepositories = new Set(work.flatMap((episode) => episode.receipt?.deliveryProofs ?? [])
    .filter((proof) => proof.freshness === "proven" || proof.freshness === "not-required")
    .map((proof) => proof.repository));
  let everyRepositoryFresh = false;
  const claims: TaskOverlapWait[] = [];
  let executionIdentity: OverlapWaitExecutionIdentity | undefined;
  const claimCurrentGeneration = async (): Promise<void> => {
    if (claims.length > 0) return;
    /*
     * FNXC:WorkspaceWorktree 2026-11-04-01:05 (RUFU-373): the restricted workspace seam holds the task's
     * non-reentrant advisory lock, so claim/complete are not callable here. Skipping the claim leaves
     * `claims` empty, which makes `persist` a no-op for free, and the analysis and every refusal below
     * stay byte-identical — a deferred gate can still only resume work it proved, never an unmet one.
     */
    if (deferPersistence || !claimEpisode) return;
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
      const claimed = await claimEpisode({ taskId: input.task.id, episodeId: episode.episodeId, expectedRevision: episode.revision, owner: input.owner, checkoutEpoch: input.checkoutEpoch, executionIdentity });
      if (!claimed) throw new OverlapResumeSynchronizationError("superseded", `Overlap synchronization episode ${episode.episodeId} changed before claim`, artifactsFor("episode-superseded"));
      claims.push(claimed);
    }
  };
  /*
  FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
  FN-429. Reconciliation of a rewritten delivery runs AFTER the dirty-worktree refusal and AFTER the
  ordinary refresh, never before. The dirty guard comes first because a stale checkout holding uncommitted
  work must be preserved byte for byte without any further inspection; the refresh comes next because the
  linear case (the remembered SHA simply not fetched yet) is the cheap and common one. Only a clean checkout
  whose refresh still cannot produce the remembered SHA may look for a proven rewrite, and any SHA left
  unproven keeps the pre-existing `freshness-unproven` refusal in the same phase.
  */
  const repositoryDeliveries = deliveries.filter((delivery) => delivery.repository === repository && Boolean(delivery.landedSha));
  const missingDeliveries = async (): Promise<OverlapDeliveryEvidence[]> => {
    const unproven: OverlapDeliveryEvidence[] = [];
    for (const delivery of repositoryDeliveries) {
      const sha = effectiveSha(delivery);
      if (sha && !await includesCommit(input.worktreePath, sha, artifactsFor("checkout-freshness-unproven"))) unproven.push(delivery);
    }
    return unproven;
  };
  let missing = await missingDeliveries();
  if (missing.length > 0) {
    if (await isDirty(input.worktreePath)) {
      await analyze();
      await persist(claims, "freshness-pending", "conflict");
      throw new OverlapResumeSynchronizationError("stale-dirty-worktree", "Execution checkout is stale and contains uncommitted work; synchronization preserved it in place", artifactsFor("checkout-dirty"));
    }
    if (input.refresh) await input.refresh();
    missing = await missingDeliveries();
  }
  const reconciledDeliveries = new Set<OverlapDeliveryEvidence>();
  for (const delivery of missing) {
    const landedSha = delivery.landedSha!;
    const outcome = await reconcileRewrittenDelivery({
      worktreePath: input.worktreePath,
      repository: delivery.repository,
      blockerTaskId: delivery.blockerTaskId,
      ...(delivery.blockerLineageId ? { blockerLineageId: delivery.blockerLineageId } : {}),
      ...(delivery.target ? { target: delivery.target } : {}),
      landedSha,
    });
    const scope = `${input.task.id}::${delivery.repository}::${delivery.blockerTaskId}::${landedSha}`;
    if (outcome.outcome === "reconciled") {
      delivery.reconciledSha = outcome.reconciledSha;
      delivery.reconciliationProof = outcome.proof;
      reconciledDeliveries.add(delivery);
      await logReconciliationDiagnostic(`${scope}::reconciled`, `[overlap-sync] stale delivery evidence for ${delivery.blockerTaskId} repository=${delivery.repository}${delivery.target ? ` target=${delivery.target}` : ""} landedSha=${landedSha.slice(0, 12)} reconciledSha=${outcome.reconciledSha.slice(0, 12)} proof=${outcome.proof}`);
      void emitBoundedRunAudit(input.store as TaskStore, {
        taskId: input.task.id,
        agentId: input.owner,
        runId: `overlap-delivery-reconciled:${input.task.id}:${delivery.blockerTaskId}:${outcome.reconciledSha}`,
        domain: "database",
        mutationType: "task:overlap-delivery-reconciled",
        target: input.task.id,
        metadata: {
          taskId: input.task.id,
          blockerTaskId: delivery.blockerTaskId,
          repository: delivery.repository,
          fromSha: landedSha,
          toSha: outcome.reconciledSha,
          proof: outcome.proof,
          episodeCount: work.length,
        },
      });
      continue;
    }
    await logReconciliationDiagnostic(`${scope}::${outcome.reason}`, `[overlap-sync] stale delivery evidence for ${delivery.blockerTaskId} repository=${delivery.repository}${delivery.target ? ` target=${delivery.target}` : ""} landedSha=${landedSha.slice(0, 12)} unresolved reason=${outcome.reason}`);
  }
  if (reconciledDeliveries.size > 0) missing = await missingDeliveries();
  await analyze(reconciledDeliveries);
  if (missing.length > 0) {
    await persist(claims, "freshness-pending", "unavailable");
    throw new OverlapResumeSynchronizationError("freshness-unproven", "Execution checkout does not contain every delivered predecessor commit", artifactsFor("checkout-freshness-unproven"));
  }
  if (analysis!.decision === "freshness-pending") {
    await persist(claims, "freshness-pending", "unavailable");
    throw new OverlapResumeSynchronizationError("delivery-unavailable", OVERLAP_DELIVERY_UNAVAILABLE_ERROR, artifactsFor("delivery-evidence-unavailable"));
  }
  const freshness = repositoryDeliveries.length ? "proven" : "not-required";
  previouslyFreshRepositories.add(repository);
  everyRepositoryFresh = [...requiredRepositories].every((required) => previouslyFreshRepositories.has(required));
  const finalPhase = everyRepositoryFresh ? "ready" : "freshness-pending";
  await persist(claims, finalPhase, freshness);
  if (finalPhase === "ready") {
    void emitBoundedRunAudit(input.store as TaskStore, {
      taskId: input.task.id,
      agentId: input.owner,
      runId: `overlap-wait-release:${input.task.id}:${analysis!.decisionFingerprint}`,
      domain: "database",
      mutationType: "task:overlap-wait-released",
      target: input.task.id,
      metadata: {
        taskId: input.task.id,
        blockerTaskIds: [...new Set(deliveries.map((delivery) => delivery.blockerTaskId))],
        episodeCount: claims.length,
        commonFileCount: analysis!.commonFiles.length,
        decision: analysis!.decision,
        freshness,
      },
    });
  }
  return { analysis: analysis!, context: buildOverlapResumeContext(analysis!), episodeIds: claims.length > 0 ? claims.map((claim) => claim.episodeId) : artifactEpisodeIds };

  async function logReconciliationDiagnostic(key: string, message: string): Promise<void> {
    if (typeof input.store.logEntry !== "function") return;
    if (!claimReconciliationDiagnostic(key)) return;
    await input.store.logEntry(input.task.id, message).catch(() => undefined);
  }

  async function persist(claimed: TaskOverlapWait[], phase: "ready" | "freshness-pending", freshness: "proven" | "not-required" | "conflict" | "unavailable") {
    if (!claimEpisode || !completeEpisode) return;
    await claimCurrentGeneration();
    for (const claim of claims) {
      const live = await input.store.getTask(input.task.id);
      if (!live || live.deletedAt || live.paused || live.userPaused) {
        throw new OverlapResumeSynchronizationError("superseded", `Overlap synchronization episode ${claim.episodeId} lost its task owner`, artifactsFor("episode-superseded"));
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
      const updated = await completeEpisode({
        executionIdentity: currentIdentity,
        taskId: input.task.id,
        episodeId: claim.episodeId,
        expectedRevision: claim.revision,
        owner: input.owner,
        phase,
        receipt: {
          decision: claim.receipt?.decision === "briefing" || analysis!.decision === "briefing" || analysis!.decision === "freshness-pending"
            ? "briefing"
            : "resume",
          freshness: everyRepositoryFresh ? freshness : freshness === "conflict" ? "conflict" : "pending",
          commonFiles: [...new Set([...(claim.receipt?.commonFiles ?? []), ...analysis!.commonFiles])],
          deliveryProofs: [
            ...claim.receipt?.deliveryProofs?.filter((proof) => proof.repository !== repository) ?? [],
            // A proven rewrite travels with the proof so Retry/restart/worktree deletion do not re-derive it.
            ...deliveries.map((delivery) => ({ repository: delivery.repository, target: delivery.target, landedSha: delivery.landedSha, ...(delivery.reconciledSha ? { reconciledSha: delivery.reconciledSha } : {}), ...(delivery.reconciliationProof ? { reconciliationProof: delivery.reconciliationProof } : {}), landedFiles: delivery.paths?.flatMap((path) => path.previousPath ? [path.previousPath, path.path] : [path.path]), noOp: delivery.noOp, evidence: delivery.evidence, freshness })),
          ],
          decisionFingerprint: createHash("sha256").update(`${claim.receipt?.decisionFingerprint ?? ""}\0${analysis!.decisionFingerprint}`).digest("hex"),
          briefing: [claim.receipt?.briefing, buildOverlapResumeContext(analysis!)].filter(Boolean).join("\n\n") || undefined,
          reason: analysis!.reason,
          decidedAt: new Date().toISOString(),
        },
      });
      if (!updated) throw new OverlapResumeSynchronizationError("superseded", `Overlap synchronization episode ${claim.episodeId} changed before publication`, artifactsFor("episode-superseded"));
    }
  }
}
