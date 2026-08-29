import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings, TaskStore } from "@fusion/core";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure } from "../healing/auto-recovery.js";
import type { Logger } from "../logger.js";
import type { RunAuditor } from "../util/run-audit.js";

const execAsync = promisify(exec);

export type ExecutorSpawnAgentSurface = (params: {
  name: string;
  role: "triage" | "executor" | "reviewer" | "merger" | "engineer" | "custom";
  task: string;
}) => Promise<{ agentId: string }>;

export type PatchIdClassifier = (args: {
  repoDir: string;
  branchName: string;
  integrationBranch?: string;
}) => Promise<{
  unique: Array<{ sha: string }>;
  alreadyUpstream: Array<{ sha: string }>;
}>;

export interface FileScopeRecoveryDeps {
  taskStore: TaskStore;
  runAudit: RunAuditor;
  logger: Logger;
  exec: typeof execAsync;
  spawnAgent: ExecutorSpawnAgentSurface;
  classifyPatchIds: PatchIdClassifier;
  settings: () => ProjectSettings;
  now?: () => Date;
}

export interface FileScopeClassificationResult {
  kind: "all-in-scope" | "all-off-scope" | "unambiguous-split" | "ambiguous" | "destructive-ambiguity";
  inScope: string[];
  offScope: string[];
  ambiguousFiles?: string[];
}

export interface FileScopeSplitPlan {
  keep: string[];
  defer: string[];
  deferDiff: string;
}

export function classifyStagedSet(
  staged: readonly string[],
  declaredScope: readonly string[],
  branchRangeDiff: Readonly<Record<string, "in-scope" | "off-scope" | "ambiguous">>,
): FileScopeClassificationResult {
  const inScope = staged.filter((file) => branchRangeDiff[file] === "in-scope");
  const offScope = staged.filter((file) => branchRangeDiff[file] === "off-scope");
  const ambiguousFiles = staged.filter((file) => branchRangeDiff[file] === "ambiguous");

  if (staged.length > 0 && inScope.length === staged.length) {
    return { kind: "all-in-scope", inScope, offScope: [] };
  }
  if (staged.length > 0 && offScope.length === staged.length) {
    return { kind: "all-off-scope", inScope: [], offScope };
  }
  if (inScope.length > 0 && offScope.length > 0 && ambiguousFiles.length === 0) {
    return { kind: "unambiguous-split", inScope, offScope };
  }
  if (ambiguousFiles.length > 0 && inScope.length === 0) {
    return { kind: "destructive-ambiguity", inScope, offScope, ambiguousFiles };
  }
  if (declaredScope.length === 0) {
    return { kind: "ambiguous", inScope, offScope, ambiguousFiles };
  }
  return { kind: "ambiguous", inScope, offScope, ambiguousFiles };
}

export function computeSplitPlan(
  commits: readonly string[],
  patchIds: readonly string[],
  classification: FileScopeClassificationResult,
): FileScopeSplitPlan {
  void commits;
  void patchIds;
  return {
    keep: classification.inScope,
    defer: classification.offScope,
    deferDiff: "",
  };
}

export class FileScopeAutoRecoveryHandler {
  constructor(private readonly deps: FileScopeRecoveryDeps) {}

  async issueRetry(_failure: AutoRecoveryFailure, _decision: AutoRecoveryDecision, _ctx: AutoRecoveryContext): Promise<void> {
    // Implemented in FN-4535 steps 2/4.
  }

  async spawnAiRecovery(_failure: AutoRecoveryFailure, _decision: AutoRecoveryDecision, _ctx: AutoRecoveryContext): Promise<void> {
    // Implemented in FN-4535 step 3.
  }
}

export function createFileScopeAutoRecoveryHandler(deps: Omit<FileScopeRecoveryDeps, "exec"> & { exec?: typeof execAsync }): FileScopeAutoRecoveryHandler {
  return new FileScopeAutoRecoveryHandler({
    ...deps,
    exec: deps.exec ?? execAsync,
  });
}
