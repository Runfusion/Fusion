import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTaskStoreForBackend } from "@fusion/core";
import {
  defaultGitOps,
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeMergeBaseError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizePlanError,
  ExperimentFinalizeService,
  ExperimentFinalizeStateError,
  type FinalizePlanOverride,
} from "@fusion/engine";
import { closeProjectStore, resolveProject, type ProjectContext } from "../project-context.js";

interface ExperimentFinalizeOptions {
  sessionId: string;
  integrationBranch?: string;
  dryRun?: boolean;
  json?: boolean;
  summary?: string;
  planFile?: string;
  projectName?: string;
}

const EXIT_CODES = new Map<string, number>([
  ["state_error", 2],
  ["no_kept_runs", 3],
  ["plan_error", 4],
  ["merge_base_error", 5],
  ["cherry_pick_conflict", 6],
  ["branch_exists", 7],
]);

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printPlan(plan: Awaited<ReturnType<ExperimentFinalizeService["previewPlan"]>>): void {
  console.log(`Session: ${plan.sessionId}`);
  console.log(`Merge base: ${plan.mergeBaseCommit}`);
  for (const group of plan.groups) {
    console.log(`- ${group.title} -> ${group.suggestedBranchName} (${group.commits.length} commits)`);
  }
}

async function parsePlanOverride(path: string): Promise<FinalizePlanOverride> {
  const content = await readFile(resolve(path), "utf8");
  return JSON.parse(content) as FinalizePlanOverride;
}

async function exitWithError(error: unknown, shutdown?: () => Promise<void>): Promise<never> {
  /* FNXC:PostgresCliLifecycle 2026-07-14-22:55: Experiment-finalize must attempt backend teardown before exit without allowing a shutdown rejection to replace its established typed error code. */
  await shutdown?.().catch((cleanupError) => {
    console.error(`Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  });
  if (error instanceof ExperimentFinalizeCherryPickConflictError) {
    console.error(`Error: ${error.message}`);
    console.error(JSON.stringify({ groupId: error.groupId, commit: error.commit, stderr: error.stderr }));
    process.exit(6);
  }
  const code = (error as { code?: string })?.code;
  if (code && EXIT_CODES.has(code)) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_CODES.get(code)!);
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export async function runExperimentFinalize(options: ExperimentFinalizeOptions): Promise<void> {
  let backendShutdown: (() => Promise<void>) | undefined;
  const shutdownBackend = async (): Promise<void> => {
    const shutdown = backendShutdown;
    backendShutdown = undefined;
    await shutdown?.();
  };
  try {
    let project: ProjectContext | undefined;
    let projectRoot = process.cwd();
    try {
      project = options.projectName ? await resolveProject(options.projectName) : undefined;
      projectRoot = project?.projectPath ?? projectRoot;
    } finally {
      /* FNXC:PostgresCliLifecycle 2026-07-14-21:20: Experiment finalization boots its own backend after path resolution, so always close and evict the resolver-owned project context before parsing or Git work can succeed or fail. */
      if (project) await closeProjectStore(project);
    }
    // FNXC:PostgresFinalCutover 2026-07-14-17:20: Experiment finalization has one
    // authoritative PostgreSQL store path; the startup factory is non-nullable.
    const boot = await createTaskStoreForBackend({ rootDir: projectRoot });
    backendShutdown = boot.shutdown;
    const taskStore = boot.taskStore;
    const sessionStore = taskStore.getExperimentSessionStore();
    const service = new ExperimentFinalizeService({
      store: sessionStore,
      git: defaultGitOps(projectRoot),
    });

    const planOverride = options.planFile ? await parsePlanOverride(options.planFile) : undefined;

    if (options.dryRun) {
      const plan = await service.previewPlan({
        sessionId: options.sessionId,
        integrationBranch: options.integrationBranch,
      });
      if (options.json) {
        printJson({ plan });
      } else {
        printPlan(plan);
      }
      await shutdownBackend();
      return;
    }

    const result = await service.finalize({
      sessionId: options.sessionId,
      integrationBranch: options.integrationBranch,
      planOverride,
      summary: options.summary,
    });

    if (options.json) {
      printJson({ result });
      await shutdownBackend();
      return;
    }

    console.log(`Finalized session ${result.sessionId}`);
    for (const branch of result.branches) {
      console.log(`- ${branch.name} (${branch.tipCommit})`);
    }
    await shutdownBackend();
  } catch (error) {
    if (
      error instanceof ExperimentFinalizeStateError
      || error instanceof ExperimentFinalizeNoKeptRunsError
      || error instanceof ExperimentFinalizePlanError
      || error instanceof ExperimentFinalizeMergeBaseError
      || error instanceof ExperimentFinalizeBranchExistsError
      || error instanceof ExperimentFinalizeCherryPickConflictError
    ) {
      await exitWithError(error, shutdownBackend);
    }
    await exitWithError(error, shutdownBackend);
  }
}
