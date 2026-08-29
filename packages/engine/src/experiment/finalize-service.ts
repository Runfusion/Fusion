import type { ExperimentSessionRecord, ExperimentSessionStore } from "@fusion/core";
import { buildDefaultPlan, mergePlanWithUserOverrides } from "./finalize-plan.js";
import {
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizeStateError,
  type FinalizePlan,
  type FinalizePlanOverride,
  type FinalizeResult,
} from "./finalize-types.js";
import type { GitOps } from "./git-ops.js";
import { createLogger, formatError } from "../logger.js";

const ACTIVE_FINALIZE_LOCKS = new Set<string>();
export const __activeFinalizeLocksForTesting = ACTIVE_FINALIZE_LOCKS;

interface FinalizeServiceOptions {
  store: ExperimentSessionStore;
  git: GitOps;
  logger?: ReturnType<typeof createLogger>;
}

export class ExperimentFinalizeService {
  private readonly logger;

  constructor(private readonly options: FinalizeServiceOptions) {
    this.logger = options.logger ?? createLogger("experiment-finalize");
  }

  async previewPlan(input: { sessionId: string; integrationBranch?: string }): Promise<FinalizePlan> {
    const integrationBranch = input.integrationBranch ?? "main";
    const session = await this.options.store.getSession(input.sessionId);
    if (!session) throw new ExperimentFinalizeStateError(`Experiment session not found: ${input.sessionId}`);
    if (session.status !== "active") {
      throw new ExperimentFinalizeStateError(`Session ${input.sessionId} is not active (status: ${session.status})`);
    }
    if (!session.keptRunIds.length) throw new ExperimentFinalizeNoKeptRunsError(`Session ${input.sessionId} has no kept runs`);

    const records = await this.options.store.listRecords(input.sessionId);
    const baselineRef = this.resolveBaselineRef(session.baselineRunId, session.metadata?.baselineCommit, records, integrationBranch);
    const mergeBaseCommit = await this.options.git.mergeBase(baselineRef, integrationBranch);

    return buildDefaultPlan({
      session,
      records,
      integrationBranch,
      mergeBaseCommit,
    });
  }

  async finalize(input: {
    sessionId: string;
    integrationBranch?: string;
    planOverride?: FinalizePlanOverride;
    summary?: string;
    allowEmptyDiscarded?: boolean;
  }): Promise<FinalizeResult> {
    const integrationBranch = input.integrationBranch ?? "main";
    if (ACTIVE_FINALIZE_LOCKS.has(input.sessionId)) {
      throw new ExperimentFinalizeStateError(`Finalize already in progress for session ${input.sessionId}`);
    }

    ACTIVE_FINALIZE_LOCKS.add(input.sessionId);
    this.logger.log(`finalize start: ${input.sessionId}`);

    let originalRef = "";
    let createdBranches: string[] = [];
    try {
      const session = await this.options.store.getSession(input.sessionId);
      if (!session) throw new ExperimentFinalizeStateError(`Experiment session not found: ${input.sessionId}`);
      if (session.status !== "active") {
        throw new ExperimentFinalizeStateError(`Session ${input.sessionId} is not active (status: ${session.status})`);
      }
      if (!session.keptRunIds.length && !input.allowEmptyDiscarded) {
        throw new ExperimentFinalizeNoKeptRunsError(`Session ${input.sessionId} has no kept runs`);
      }

      await this.options.store.updateSession(input.sessionId, { status: "finalizing" });

      const branch = await this.options.git.currentBranch();
      originalRef = branch ?? await this.options.git.head();

      const records = await this.options.store.listRecords(input.sessionId);
      const baselineRef = this.resolveBaselineRef(session.baselineRunId, session.metadata?.baselineCommit, records, integrationBranch);
      const mergeBaseCommit = await this.options.git.mergeBase(baselineRef, integrationBranch);
      const defaultPlan = buildDefaultPlan({ session, records, integrationBranch, mergeBaseCommit });
      const plan = mergePlanWithUserOverrides(defaultPlan, input.planOverride);

      const branchResults: FinalizeResult["branches"] = [];
      createdBranches = [];

      for (const group of plan.groups) {
        if (await this.options.git.branchExists(group.suggestedBranchName)) {
          throw new ExperimentFinalizeBranchExistsError(`Branch already exists: ${group.suggestedBranchName}`);
        }

        await this.options.git.createBranch(group.suggestedBranchName, plan.mergeBaseCommit);
        createdBranches.push(group.suggestedBranchName);
        this.logger.log(`created branch ${group.suggestedBranchName}`);

        await this.options.git.checkout(group.suggestedBranchName);
        for (const commit of group.commits) {
          await this.options.git.cherryPick(commit);
        }
        const tipCommit = await this.options.git.head();
        branchResults.push({
          name: group.suggestedBranchName,
          baseCommit: plan.mergeBaseCommit,
          tipCommit,
          runRecordIds: group.runRecordIds,
          commits: group.commits,
        });
      }

      await this.options.git.checkout(originalRef);
      const discardedRunIds = (await this.options.store
        .listRecords(input.sessionId))
        .filter((record) => record.type === "run" && record.payload.status !== "keep")
        .map((record) => record.id);

      const finalizeRecord = await this.options.store.appendRecord(input.sessionId, {
        type: "finalize",
        payload: {
          keptRunIds: session.keptRunIds,
          discardedRunIds,
          branches: branchResults.map((branchResult) => ({
            name: branchResult.name,
            baseCommit: branchResult.baseCommit,
            tipCommit: branchResult.tipCommit,
          })),
          summary: input.summary,
        },
      });

      await this.options.store.updateSession(input.sessionId, { status: "finalized" });
      this.logger.log(`finalize complete: ${input.sessionId}`);
      return {
        sessionId: input.sessionId,
        mergeBaseCommit: plan.mergeBaseCommit,
        branches: branchResults,
        warnings: plan.warnings,
        finalizeRecordId: finalizeRecord.id,
      };
    } catch (error) {
      if (originalRef) {
        try {
          await this.options.git.checkout(originalRef);
        } catch (checkoutError) {
          this.logger.error(`rollback checkout failed: ${formatError(checkoutError)}`);
        }
      }
      for (const branchName of createdBranches) {
        try {
          await this.options.git.deleteBranch(branchName, { force: true });
        } catch (deleteError) {
          this.logger.error(`rollback delete failed for ${branchName}: ${formatError(deleteError)}`);
        }
      }
      this.logger.error(`finalize failed: ${formatError(error)}`);
      throw error;
    } finally {
      ACTIVE_FINALIZE_LOCKS.delete(input.sessionId);
    }
  }

  private resolveBaselineRef(
    baselineRunId: string | undefined,
    metadataBaselineCommit: unknown,
    records: ExperimentSessionRecord[],
    integrationBranch: string,
  ): string {
    if (typeof metadataBaselineCommit === "string" && metadataBaselineCommit.trim()) {
      return metadataBaselineCommit.trim();
    }

    if (baselineRunId) {
      const baselineRun = records.find((record) => record.id === baselineRunId && record.type === "run");
      if (baselineRun?.type === "run" && baselineRun.payload.commit) {
        return baselineRun.payload.commit;
      }
    }

    return integrationBranch;
  }
}
