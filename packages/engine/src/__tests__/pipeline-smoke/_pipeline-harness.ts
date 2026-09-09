import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getBuiltinWorkflow,
  resolveCompleteColumn,
  resolveCreationColumn,
  resolveReviewColumns,
  columnHasFlag,
  AgentStore,
  CentralCore,
  type MergeResult,
  type Settings,
  TaskStore,
  type Task,
  type WorkflowDefinitionInput,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";
import type { SharedPgTaskStoreHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { ProjectEngine } from "../../project-engine.js";
import { TaskExecutor } from "../../executor.js";
import { activeSessionRegistry, executingTaskLock } from "../../agents/active-session-registry.js";
import { resetMockScripts } from "../../providers/mock-provider.js";
import { WorktreePool } from "../../worktree/worktree-pool.js";
import { acquireTaskWorktree, type AcquireTaskWorktreeResult } from "../../worktree/worktree-acquisition.js";
import { runHoldReleaseSweep } from "../../execution/hold-release.js";
import { SelfHealingManager } from "../../self-healing.js";
import { Scheduler } from "../../scheduler.js";
import { reconcileRecovery } from "../../recovery-reconciler.js";
import { createPipelineClock, type PipelineClock } from "./_pipeline-clock.js";
import { createPipelineGitFixture, createPipelineWorkspaceFixture, type PipelineGitFixture } from "./_pipeline-git-fixture.js";
import { createPipelineNoAiGuard, type PipelineNoAiGuard } from "./_pipeline-no-ai-guard.js";
import {
  installPipelineMockScripts,
  type PipelineMockScriptState,
  type PipelineScriptedMergeBehavior,
} from "./_pipeline-mock-scripts.js";
import {
  classifyTerminalState,
  detectPipelineWedge,
  driveToQuiescence,
  observePipelineTerminalState,
  type PipelineObservedState,
  type PipelineTerminalState,
} from "./_pipeline-terminal-state.js";

export type PipelineBuiltinWorkflow = "builtin:coding-ideas-v2" | "builtin:coding";
export type PipelineWorkflowId = PipelineBuiltinWorkflow | string;

export type PipelineTaskSeed = {
  readonly id: string;
  readonly workflowId: PipelineWorkflowId;
  readonly ir: WorkflowIr;
  readonly holdColumn: string;
  readonly wipColumn: string;
  readonly reviewColumn: string;
  readonly completeColumn: string;
};

export type PipelineMergeOutcome = {
  readonly admitted: boolean;
  readonly result?: MergeResult;
  readonly error?: Error;
};

export type PipelineWorktreeRecoveryVariant = "pool-saturated" | "recycled" | "absent" | "vanished-mid-step";

export type PipelineRestartObservation = {
  readonly before: Task;
  readonly after: Task;
  readonly workItemSignatureBefore: string;
  readonly workItemSignatureAfter: string;
};

export type PipelineScenarioResult = {
  readonly taskId: string;
  readonly expectedTerminal: PipelineTerminalState;
  readonly observedTerminal: PipelineTerminalState;
  readonly observed: PipelineObservedState;
  readonly wedge?: string;
};

/*
FNXC:PipelineSmoke 2026-08-23-20:23:
The smoke lane must invoke TaskExecutor's production graph entry without replacing its store,
seams, or dependencies; this narrow subclass exposes only that protected entry for the harness.
*/
class PipelineGraphExecutor extends TaskExecutor {
  async executeAuthoritativeGraph(task: Task): Promise<void> {
    await this.executeWorkflowGraph(task);
  }

  async declareExternalObstacle(task: Task, reason: string): Promise<void> {
    if (!task.worktree) throw new Error(`Pipeline smoke task ${task.id} has no worktree for fn_task_done.`);
    const tool = this.createTaskDoneTool(
      task.id,
      task.worktree,
      task.prompt ?? "",
      new Map(),
      () => undefined,
    );
    const result = await tool.execute("pipeline-s21-external-block", {
      outcome: "blocked",
      obstacle: "outside-worktree",
      blockedBy: [],
      reason,
    } as never);
    const text = result.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n");
    if (!text.includes("frozen as Blocked")) {
      throw new Error(`S21: production fn_task_done did not freeze the external obstacle: ${text}`);
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let fixtureEnvironmentTail: Promise<void> = Promise.resolve();

type FixtureEnvironmentRelease = () => void;

/*
FNXC:PipelineSmoke 2026-08-25-06:40:
Task ids are unique per PROCESS, not per harness. The counter used to live on the instance and reset
with it, so every test's first task was `FN-182-S05-1` — and the engine's process-wide state
(`executingTaskLock`, `activeSessionRegistry.pathsForTask`, worktree registrations) is keyed by task
id. A straggler from the previous test therefore answered for the NEXT test's identically-named
task, handing it a worktree under the previous fixture. The executor correctly refused that path
(`outside_worktrees_dir`) and failed a task that had done nothing wrong. Colliding ids also defeat
the teardown drain, which can only wait for ids it can tell apart.
*/
let pipelineTaskSerial = 0;

async function acquireFixtureGlobalHome(fixture: PipelineGitFixture): Promise<FixtureEnvironmentRelease> {
  let releaseQueue: (() => void) | undefined;
  const previous = fixtureEnvironmentTail;
  fixtureEnvironmentTail = new Promise<void>((resolve) => { releaseQueue = resolve; });
  await previous;

  const previousHome = process.env.HOME;
  const previousVitest = process.env.VITEST;
  /*
  FNXC:PipelineSmoke 2026-08-23-16:34:
  Real runtime sessions open global secret/settings stores, whose Vitest guard correctly
  rejects an implicit operator home. A harness holds an exclusive worker-scoped fixture HOME
  for its complete lifetime so background engine work cannot observe a restored operator path.
  */
  process.env.HOME = fixture.rootDir;
  delete process.env.VITEST;
  return () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = previousVitest;
    releaseQueue?.();
  };
}

function resolvedColumns(ir: WorkflowIr): Pick<PipelineTaskSeed, "holdColumn" | "wipColumn" | "reviewColumn" | "completeColumn"> {
  const columns = ir.version === "v2" ? ir.columns : [];
  const holdColumn = columns.find((column) => columnHasFlag(ir, column.id, "hold"))?.id;
  const wipColumn = columns.find((column) => columnHasFlag(ir, column.id, "countsTowardWip"))?.id
    ?? columns.find((column) => columnHasFlag(ir, column.id, "wip"))?.id;
  const reviewColumn = resolveReviewColumns(ir)[0];
  const completeColumn = resolveCompleteColumn(ir);
  if (!holdColumn || !wipColumn || !reviewColumn || !completeColumn) {
    throw new Error("Pipeline smoke requires built-in workflows with hold, wip, review, and complete traits.");
  }
  return { holdColumn, wipColumn, reviewColumn, completeColumn };
}

function reviewResult(
  workflowStepId: string,
  status: "passed" | "failed" | "pending",
  verdict?: "APPROVE" | "REVISE",
  fingerprint?: string,
): WorkflowStepResult {
  return {
    workflowStepId,
    workflowStepName: workflowStepId === "code-review" ? "Code Review" : "Plan Review",
    source: "optional-group",
    phase: "pre-merge",
    reviewKind: workflowStepId === "code-review" ? "code" : "plan",
    status,
    ...(verdict ? { verdict } : {}),
    ...(fingerprint ? { reviewInputFingerprint: fingerprint } : {}),
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: status === "pending" ? undefined : "2026-08-23T00:00:01.000Z",
  };
}

/**
 * FNXC:PipelineSmoke 2026-08-23-14:56:
 * The smoke composition deliberately imports only stable entry points that existed at
 * 95ea06b48. FN-180 behavior is observed through those public paths, so the differential
 * run fails on its behavioral assertion rather than module resolution before any scenario runs.
 */
export class PipelineSmokeHarness {
  readonly fixture: PipelineGitFixture;
  readonly clock: PipelineClock;
  readonly guard: PipelineNoAiGuard;
  readonly pool = new WorktreePool();
  engine: ProjectEngine;
  readonly agentStore: AgentStore;
  readonly centralCore: CentralCore;
  private executor: PipelineGraphExecutor | undefined;
  private authoritativeSeamsObserved = false;
  /* Serial lives on the module, not the instance — see `pipelineTaskSerial`. */
  private manualHoldTaskIds = new Set<string>();
  private readonly promptRevisions = new Map<string, number>();
  private readonly mockScriptStates = new Map<string, { behavior: PipelineScriptedMergeBehavior; state: PipelineMockScriptState }>();
  /** Every task this harness created, so teardown can wait for their execution to actually stop. */
  private readonly createdTaskIds = new Set<string>();
  /** Newest non-empty branch per task; a workspace row only gains one at acquisition. */
  private readonly scriptedBranches = new Map<string, string>();

  private constructor(
    readonly pg: SharedPgTaskStoreHarness,
    readonly taskStore: TaskStore,
    readonly settings: Settings,
    fixture: PipelineGitFixture,
    clock: PipelineClock,
    guard: PipelineNoAiGuard,
    agentStore: AgentStore,
    centralCore: CentralCore,
    private readonly releaseFixtureEnvironment: FixtureEnvironmentRelease,
  ) {
    this.fixture = fixture;
    this.clock = clock;
    this.guard = guard;
    this.agentStore = agentStore;
    this.centralCore = centralCore;
    this.engine = this.createProjectEngine();
    // FNXC:PipelineSmoke 2026-08-23-15:18: Wire the executor lazily after a task reaches review; constructing it before fixture user moves races its real task:moved listener and would test setup timing rather than merge behavior.
  }

  private createProjectEngine(): ProjectEngine {
    return new ProjectEngine(
      {
        projectId: "pipeline-smoke",
        workingDirectory: this.fixture.repoDir,
        isolationMode: "in-process",
        maxConcurrent: 2,
        maxWorktrees: 2,
      },
      this.centralCore,
      { externalTaskStore: this.store, skipNotifier: true },
    );
  }

  private async startProjectEngine(): Promise<void> {
    await this.engine.start();
    /*
    FNXC:PipelineSmoke 2026-08-23-21:45:
    The harness owns each dispatch so scenario interleavings stay deterministic. This removes only
    background event handoffs after the real engine has installed its production merge lane; every
    explicit graph and merge call below still uses that live engine and PostgreSQL store.
    */
    for (const event of ["task:created", "task:updated", "task:moved", "settings:updated"] as const) {
      this.store.removeAllListeners(event);
    }
  }

  /*
  FNXC:PipelineSmoke 2026-08-24-11:05:
  `workspace: true` swaps in a real multi-repository project. Everything downstream is unchanged
  because the fixture, not the harness, decides which directory integration git runs in.
  */
  static async create(
    pg: SharedPgTaskStoreHarness,
    options: { autoMerge?: boolean; workspace?: boolean } = {},
  ): Promise<PipelineSmokeHarness> {
    const fixture = options.workspace ? createPipelineWorkspaceFixture() : createPipelineGitFixture();
    const releaseFixtureEnvironment = await acquireFixtureGlobalHome(fixture);
    try {
      const taskStore = new TaskStore(fixture.repoDir, undefined, { asyncLayer: pg.layer() });
      await taskStore.init();
      const settings = await taskStore.updateSettings({
        testMode: true,
        autoMerge: options.autoMerge ?? true,
        maxConcurrent: 2,
        maxWorktrees: 2,
        merger: { maxReviewPasses: 3 },
      });
      const clock = createPipelineClock(Date.parse("2026-08-23T00:00:00.000Z"));
      const guard = createPipelineNoAiGuard(pg.testUrl());
      guard.assertTestMode(settings);
      guard.assertLocalGitRemotes(fixture);
      guard.installNetworkTripwire();
      const agentStore = new AgentStore({
        rootDir: join(fixture.repoDir, ".fusion"),
        taskStore,
        asyncLayer: pg.layer(),
        projectId: "pipeline-smoke",
      });
      await agentStore.init();
      const centralCore = new CentralCore(join(fixture.rootDir, "global"), { asyncLayer: pg.layer() });
      await centralCore.init();
      resetMockScripts();
      activeSessionRegistry.clear();
      const harness = new PipelineSmokeHarness(pg, taskStore, settings, fixture, clock, guard, agentStore, centralCore, releaseFixtureEnvironment);
      await harness.startProjectEngine();
      return harness;
    } catch (error) {
      releaseFixtureEnvironment();
      fixture.cleanup();
      throw error;
    }
  }

  get store(): TaskStore {
    return this.taskStore;
  }

  async createRenamedWorkflow(baseWorkflowId: PipelineBuiltinWorkflow): Promise<{ workflowId: string; ir: WorkflowIr; legacyColumns: ReadonlySet<string> }> {
    const base = getBuiltinWorkflow(baseWorkflowId)?.ir;
    if (!base || base.version !== "v2") throw new Error(`S19 requires a v2 built-in workflow: ${baseWorkflowId}`);
    const ir = JSON.parse(JSON.stringify(base)) as WorkflowIr;
    if (ir.version !== "v2") throw new Error(`S19 clone unexpectedly lost v2 columns: ${baseWorkflowId}`);
    const legacyColumns = new Set(ir.columns.map((column) => column.id));
    const replacements = new Map(ir.columns.map((column, index) => [column.id, `smoke-${baseWorkflowId.replace(/[^a-z]+/gi, "-")}-${index + 1}`]));
    ir.name = `pipeline-smoke-${baseWorkflowId}-renamed`;
    ir.columns = ir.columns.map((column) => ({ ...column, id: replacements.get(column.id)! }));
    ir.nodes = ir.nodes.map((node) => node.column ? { ...node, column: replacements.get(node.column) ?? node.column } : node);
    const input: WorkflowDefinitionInput = {
      name: `Pipeline smoke renamed ${baseWorkflowId}`,
      kind: "workflow",
      ir,
    };
    const created = await this.store.createWorkflowDefinition(input);
    return { workflowId: created.id, ir, legacyColumns };
  }

  async restartComposition(
    taskId: string,
    options: { readonly restartEngine?: boolean } = {},
  ): Promise<PipelineRestartObservation> {
    const before = await this.freshTask(taskId);
    const workItemSignatureBefore = await this.workflowWorkItemSignature(taskId);
    /*
    FNXC:PipelineSmoke 2026-08-23-21:45:
    S17 must restart an actual ProjectEngine at merge and post-merge boundaries rather than only
    replacing an executor reference. Recreate the production engine over the same durable store,
    then run its real recovery seams before a fresh graph or merge admission resumes the row.
    */
    this.executor = undefined;
    if (options.restartEngine) {
      await this.engine.stop();
      this.engine = this.createProjectEngine();
      await this.startProjectEngine();
    }
    await reconcileRecovery(this.store, [before], { now: this.clock.now });
    const manager = new SelfHealingManager(this.store, {
      rootDir: this.fixture.repoDir,
      getExecutingTaskIds: () => new Set<string>(),
    });
    await manager.recoverStaleMergingStatus();
    const after = await this.freshTask(taskId);
    if (after.id !== before.id) throw new Error(`S17: restart did not retain durable task ${taskId}.`);
    return {
      before,
      after,
      workItemSignatureBefore,
      workItemSignatureAfter: await this.workflowWorkItemSignature(taskId),
    };
  }

  private wireExecutor(): PipelineGraphExecutor {
    if (this.executor) return this.executor;
    const eventedStore = this.store as TaskStore & { on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown };
    const originalOn = eventedStore.on;
    /*
    The smoke runner owns dispatch synchronously and must not start production polling/listener
    loops. Construct the real executor only to wire its real merge requester, while suppressing
    task-event subscription during this controlled composition seam.
    */
    if (originalOn) eventedStore.on = () => eventedStore;
    let executor: PipelineGraphExecutor;
    try {
      executor = new PipelineGraphExecutor(this.store, this.fixture.repoDir, { pool: this.pool, agentStore: this.agentStore });
    } finally {
      if (originalOn) eventedStore.on = originalOn;
    }
    executor!.setMergeRequester((taskId, options) => this.engine.requestInterpreterMerge(taskId, options));
    this.executor = executor!;
    return executor!;
  }

  async dispose(): Promise<void> {
    try {
      /*
      FNXC:PipelineSmoke 2026-08-24-23:10:
      Stop the engine BEFORE clearing the shared registries. Resetting the mock registry while
      sessions are still in flight strands them on default scripts mid-teardown, and clearing
      `activeSessionRegistry` first hides those sessions from the liveness checks the stop path
      consults. Both are process-global, so the damage lands on whichever file runs next.
      */
      await this.engine.stop();
      await this.drainInFlightExecution();
      activeSessionRegistry.clear();
      this.mockScriptStates.clear();
      this.scriptedBranches.clear();
      resetMockScripts();
      this.guard.restore();
      await this.centralCore.close();
      // The shared PG harness owns taskStore.asyncLayer and closes it after this file.
      this.fixture.cleanup();
    } finally {
      this.releaseFixtureEnvironment();
    }
  }

  /*
  FNXC:PipelineSmoke 2026-08-25-06:05:
  WAIT for in-flight execution to stop before tearing the fixture down; do not merely forget it.
  `ProjectEngine.stop()` clears timers but does not await a task execution already in progress, and
  teardown then called `activeSessionRegistry.clear()`, which HIDES a live session rather than
  ending it. The surviving execution keeps a reference to THIS fixture's directory, so when the next
  test in the file installs a fresh fixture the straggler creates a worktree under the OLD one and
  writes that path onto the new test's task row. The next executor correctly refuses it
  (`outside_worktrees_dir`), retries, exhausts its budget, and fails a task that never did anything
  wrong — a failure that reproduced only under full-lane timing, which is what made it look flaky.
  `executingTaskLock` is the process-wide truth for "this task is inside execute()", so drain it.
  The wait is bounded and throws on expiry rather than proceeding: a straggler that outlives the
  budget is a real defect, and a silent continue would restore exactly the leak this removes.
  */
  private async drainInFlightExecution(): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      /*
      FNXC:PipelineSmoke 2026-08-25-08:55:
      Drain `executingTaskLock` ONLY. It means "this task is inside execute() right now", which is
      the condition teardown must outlive. `activeSessionRegistry` is deliberately NOT consulted:
      S09 registers a path itself to simulate a live executor holding a worktree, so waiting on the
      registry waits for a fixture that the scenario never intends to release, and teardown hangs.
      */
      const busy = [...this.createdTaskIds].filter((taskId) => executingTaskLock.has(taskId));
      if (busy.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`Pipeline smoke teardown timed out waiting for in-flight execution: ${busy.join(", ")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async freshTask(taskId: string): Promise<Task> {
    (this.store as TaskStore & { taskCache?: Map<string, unknown> }).taskCache?.delete(taskId);
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Pipeline smoke task ${taskId} disappeared.`);
    return task;
  }

  /** Stable persisted work-item evidence used to detect a restart replaying an already-terminal seam. */
  async workflowWorkItemSignature(taskId: string): Promise<string> {
    const rows = await this.store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    return JSON.stringify(rows
      .map((row) => ({ id: row.id, nodeId: row.nodeId, nodeInstanceId: row.nodeInstanceId, state: row.state }))
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  /**
   * FNXC:PipelineSmoke 2026-08-23-21:45:
   * Graph column-boundary audits intentionally do not cover direct confirmed-merge finalization.
   * The TaskStore's persisted task:merged activity is the real once-per-finalizer signal for S16
   * and S17, so a restarted fast path cannot look green merely because no graph node ran.
   */
  async mergedActivityCount(taskId: string): Promise<number> {
    return (await this.store.getActivityLog({ taskId, type: "task:merged", limit: 50 })).length;
  }

  /**
   * FNXC:PipelineSmoke 2026-08-23-19:31:
   * Normal smoke scenarios start as ordinary selected-workflow cards. The harness may provide
   * the planned PROMPT.md fixture that production triage would have written, but it never seeds
   * implementation progress, review verdicts, a branch, or a review-column move. Those facts
   * must be produced by the real graph, scheduler, worktree acquisition, mock sessions, and
   * merge lane before a scenario can assert them.
   */
  async createPipelineTask(
    workflowId: PipelineWorkflowId,
    options: {
      readonly idPrefix?: string;
      readonly codeReview?: boolean;
      readonly initialColumn?: "creation" | "hold";
      readonly noCommitsExpected?: boolean;
      /*
      FNXC:PipelineSmoke 2026-08-24-11:05:
      A workspace task must carry a CONFIRMED repository scope before any write-capable node runs:
      acquisition refuses without it, and the session boundary is derived from exactly these
      repositories. Planning normally confirms it; the fixture states it directly so the scenario
      measures execution rather than re-testing scope confirmation.
      */
      readonly repositoryScope?: readonly string[];
    } = {},
  ): Promise<PipelineTaskSeed> {
    const ir = getBuiltinWorkflow(workflowId)?.ir
      ?? (await this.store.getWorkflowDefinition(workflowId))?.ir;
    if (!ir) throw new Error(`Missing workflow ${workflowId}`);
    const creation = resolveCreationColumn(ir)?.id;
    const { holdColumn, wipColumn, reviewColumn, completeColumn } = resolvedColumns(ir);
    const taskId = `FN-182-${options.idPrefix ?? "SMOKE"}-${++pipelineTaskSerial}`.replace(/[^A-Za-z0-9-]/g, "-");
    this.createdTaskIds.add(taskId);
    const column = options.initialColumn === "creation" ? creation : holdColumn;
    if (!column) throw new Error(`${workflowId} has no creation column`);

    await this.store.createTaskWithReservedId(
      {
        description: `Pipeline smoke ${taskId}`,
        workflowId,
        column,
        ...(options.noCommitsExpected ? { noCommitsExpected: true } : {}),
      },
      { taskId, applyDefaultWorkflowSteps: true },
    );
    const selected = await this.store.getTaskWorkflowSelectionAsync(taskId);
    if (selected?.workflowId !== workflowId) {
      throw new Error(`Pipeline smoke task ${taskId} did not retain selected workflow ${workflowId}.`);
    }
    if (options.repositoryScope?.length) {
      await this.store.updateTask(taskId, {
        repositoryScope: {
          state: "confirmed",
          repositories: [...options.repositoryScope],
          revision: 1,
        } as never,
      });
    }

    /*
    FNXC:PipelineSmoke 2026-08-23-20:23:
    Built-in planning is a graph no-op only after triage authored PROMPT.md. Publish the fixture
    through the authoritative prompt mutation, never a raw file write, so current-plan evidence
    and the planning lifecycle lock match the real Plan Review terminal writer.
    */
    await this.publishPlannedPrompt(taskId);

    if (options.codeReview === false) {
      const task = await this.freshTask(taskId);
      await this.store.updateTask(taskId, {
        enabledWorkflowSteps: (task.enabledWorkflowSteps ?? []).filter((stepId) => stepId !== "code-review"),
      });
    }

    return { id: taskId, workflowId, ir, holdColumn, wipColumn, reviewColumn, completeColumn };
  }

  /*
  FNXC:PipelineSmoke 2026-08-23-20:23:
  Replan drives need an authoritative planner-shaped artifact, not synthetic steps or review
  results. The task store writer preserves the same lock/evidence contract as triage.
  */
  private async publishPlannedPrompt(taskId: string): Promise<void> {
    const revision = (this.promptRevisions.get(taskId) ?? 0) + 1;
    this.promptRevisions.set(taskId, revision);
    const plannedPrompt = `# ${taskId}\n\n## Mission\nExercise the deterministic local pipeline fixture from planning through merge (revision ${revision}).\n\n## File Scope\n- pipeline-smoke-output.txt\n\n## Steps\n### Step 0: Implement deterministic pipeline output\n- Make the local fixture change.\n\n## Completion Criteria\n- The local fixture change is committed and reviewable.\n\n## Do Not\n- Contact a network service.\n`;
    await this.store.updateTask(taskId, { prompt: plannedPrompt, status: null, error: null });
  }

  async requireTaskWorktree(taskId: string): Promise<string> {
    const task = await this.freshTask(taskId);
    if (!task.worktree || !existsSync(task.worktree)) {
      throw new Error(`Pipeline smoke task ${taskId} has no usable production-acquired worktree.`);
    }
    return task.worktree;
  }

  /*
  FNXC:ExternalBlockPipeline 2026-08-28-05:33:
  S21 must reproduce the reported MRG-058 path through the production fn_task_done tool, then run
  real scheduler and self-healing passes. Directly seeding externalBlock would hide regressions in
  obstacle classification, lifecycle routing, dispatch refusal, and resource-retention recovery.
  */
  async arrangeExternalBlockReplay(task: PipelineTaskSeed): Promise<void> {
    const acquisition = await this.acquirePipelineTaskWorktree(task.id);
    for (let index = 1; index <= 5; index += 1) {
      const path = join(acquisition.worktreePath, `fn-209-proof-${index}.txt`);
      writeFileSync(path, `FN-209 external block proof ${index}\n`, "utf8");
      git(acquisition.worktreePath, ["add", `fn-209-proof-${index}.txt`]);
      git(acquisition.worktreePath, ["commit", "-m", `test: S21 proof commit ${index}`]);
    }
    await this.store.moveTask(task.id, task.wipColumn as never, {
      preserveProgress: true,
      preserveWorktree: true,
      moveSource: "engine",
    });
    const steps = Array.from({ length: 7 }, (_, index) => ({
      name: index === 6 ? "Testing & Verification" : `Completed step ${index}`,
      status: index === 6 ? "in-progress" as const : "done" as const,
    }));
    await this.store.updateTask(task.id, {
      steps,
      currentStep: 6,
      effectiveNodeId: "steps#6:step-execute",
      modifiedFiles: Array.from({ length: 5 }, (_, index) => `fn-209-proof-${index + 1}.txt`),
    });
    const live = await this.freshTask(task.id);
    await this.wireExecutor().declareExternalObstacle(
      live,
      "Vitest cannot start: ENOSPC: no space left on device, write",
    );
  }

  async driveExternalBlockRecoveryCycles(taskId: string, options: { startup?: boolean } = {}): Promise<void> {
    let dispatchCount = 0;
    const scheduler = new Scheduler(this.store, {
      maxConcurrent: 2,
      maxWorktrees: 2,
      onSchedule: (task) => {
        if (task.id === taskId) dispatchCount += 1;
      },
    });
    (scheduler as unknown as { running: boolean }).running = true;
    try {
      await scheduler.schedule();
    } finally {
      scheduler.stop();
    }
    if (dispatchCount !== 0) throw new Error("S21: scheduler dispatched the externally blocked task.");

    const manager = new SelfHealingManager(this.store, {
      rootDir: this.fixture.repoDir,
      getExecutingTaskIds: () => new Set<string>(),
      listWorktreeHolders: () => [...this.pool.getLeasedPaths()].map(([worktreePath, holderTaskId]) => ({
        taskId: holderTaskId,
        worktreePath,
      })),
      clearPhantomExecutorBinding: (holderTaskId) => {
        for (const [worktreePath, currentHolder] of this.pool.getLeasedPaths()) {
          if (currentHolder === holderTaskId) this.pool.release(worktreePath, holderTaskId);
        }
        return true;
      },
    });
    try {
      if (options.startup) await manager.runStartupRecovery();
      await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    } finally {
      manager.stop();
    }
  }

  async assertExternalBlockReplay(task: PipelineTaskSeed, expectedStatus: "blocked" | "resumed"): Promise<void> {
    const live = await this.freshTask(task.id);
    const worktree = await this.requireTaskWorktree(task.id);
    if (!live.baseCommitSha) throw new Error("S21: production acquisition did not persist its base commit.");
    const commitCount = Number(git(worktree, ["rev-list", "--count", `${live.baseCommitSha}..HEAD`]));
    if (commitCount !== 5) throw new Error(`S21: expected five retained commits, observed ${commitCount}.`);
    if (live.steps.slice(0, 6).some((step) => step.status !== "done") || live.steps[6]?.status !== "in-progress" || live.currentStep !== 6) {
      throw new Error("S21: completed or interrupted step progress changed across external block recovery.");
    }
    if (this.pool.getLeasedPaths().get(worktree) !== task.id) {
      throw new Error("S21: the production worktree pool released the blocked task lease.");
    }
    if (expectedStatus === "blocked") {
      if (live.status !== "blocked" || live.externalBlock?.code !== "ENOSPC") throw new Error("S21: external obstacle is not durably readable.");
    } else if (live.status === "blocked" || live.externalBlock) {
      throw new Error("S21: dashboard Retry did not clear the external block.");
    }
  }

  async resumeExternalBlockReplay(taskId: string): Promise<void> {
    const { resumeExternallyBlockedTask } = await import("../../../../dashboard/src/routes/task-external-block-resume.js");
    const result = await resumeExternallyBlockedTask({ store: this.store, taskId });
    if (result.kind !== "resumed" || result.nodeId !== "steps#6:step-execute") {
      throw new Error("S21: dashboard Retry did not arm the interrupted verification node.");
    }
  }

  private async acquirePipelineTaskWorktree(taskId: string): Promise<AcquireTaskWorktreeResult> {
    const task = await this.freshTask(taskId);
    return acquireTaskWorktree({
      task,
      rootDir: this.fixture.repoDir,
      store: this.store,
      settings: await this.store.getSettings(),
      pool: this.pool,
      runInitCommand: false,
    });
  }

  private async assertDurableAcquisition(
    taskId: string,
    acquisition: AcquireTaskWorktreeResult,
    expectedSource: AcquireTaskWorktreeResult["source"],
  ): Promise<Task> {
    if (acquisition.source !== expectedSource) {
      throw new Error(`S11: ${taskId} acquired from ${acquisition.source}, expected ${expectedSource}.`);
    }
    const persisted = await this.freshTask(taskId);
    if (
      persisted.worktree !== acquisition.worktreePath
      || persisted.branch !== acquisition.branch
      || !existsSync(acquisition.worktreePath)
    ) {
      throw new Error(`S11: ${taskId} did not persist its ${expectedSource} worktree acquisition.`);
    }
    return persisted;
  }

  private async createPoolOccupant(workflowId: PipelineWorkflowId): Promise<{ task: PipelineTaskSeed; acquisition: AcquireTaskWorktreeResult }> {
    const holder = await this.createPipelineTask(workflowId, {
      idPrefix: "S11-POOL-HOLDER",
      codeReview: false,
    });
    const acquisition = await this.acquirePipelineTaskWorktree(holder.id);
    await this.assertDurableAcquisition(holder.id, acquisition, "fresh");
    return { task: holder, acquisition };
  }

  private leasePoolOccupant(path: string, holderTaskId: string): void {
    this.pool.rehydrate([path]);
    if (!this.pool.has(path)) throw new Error(`S11: real pool did not retain ${path} as an idle worktree.`);
    if (this.pool.acquire(holderTaskId) !== path) {
      throw new Error(`S11: real pool did not lease its prepared occupant ${path}.`);
    }
  }

  /**
   * FNXC:PipelineSmoke 2026-08-23-21:45:
   * S11 acquires every disruption through the production WorktreePool and acquisition primitive.
   * A fresh durable task-row assignment is the observable contract: pool saturation falls back to
   * a distinct checkout, while recycling rebinds the exact released checkout to the successor.
   */
  async arrangeWorktreeRecoveryVariant(taskId: string, variant: PipelineWorktreeRecoveryVariant): Promise<void> {
    if (variant === "pool-saturated" || variant === "recycled") {
      await this.store.updateSettings({ recycleWorktrees: true });
      const task = await this.freshTask(taskId);
      const selected = await this.store.getTaskWorkflowSelectionAsync(taskId);
      if (!selected?.workflowId) throw new Error(`S11: ${taskId} has no selected workflow for pool setup.`);
      const holder = await this.createPoolOccupant(selected.workflowId);
      this.leasePoolOccupant(holder.acquisition.worktreePath, holder.task.id);

      if (variant === "pool-saturated") {
        const acquisition = await this.acquirePipelineTaskWorktree(task.id);
        const persisted = await this.assertDurableAcquisition(task.id, acquisition, "fresh");
        if (
          persisted.worktree === holder.acquisition.worktreePath
          || this.pool.getLeasedPaths().get(holder.acquisition.worktreePath) !== holder.task.id
        ) {
          throw new Error("S11: a saturated real pool reused its still-leased worktree.");
        }
        return;
      }

      this.pool.release(holder.acquisition.worktreePath, holder.task.id);
      if (!this.pool.has(holder.acquisition.worktreePath)) {
        throw new Error("S11: released real pool worktree was not available for recycling.");
      }
      const acquisition = await this.acquirePipelineTaskWorktree(task.id);
      const persisted = await this.assertDurableAcquisition(task.id, acquisition, "pool");
      if (
        persisted.worktree !== holder.acquisition.worktreePath
        || this.pool.getLeasedPaths().get(holder.acquisition.worktreePath) !== task.id
      ) {
        throw new Error("S11: recycled acquisition did not durably rebind the released checkout.");
      }
      return;
    }

    await this.store.updateSettings({ recycleWorktrees: false });
    if (variant === "absent") {
      const initial = await this.acquirePipelineTaskWorktree(taskId);
      await this.assertDurableAcquisition(taskId, initial, "fresh");
      await this.recoverMissingWorktree(taskId, "fresh");
      return;
    }

    await this.runProductionTurn(taskId);
    const before = await this.freshTask(taskId);
    const priorWorktree = before.worktree ?? (await this.acquirePipelineTaskWorktree(taskId)).worktreePath;
    const recovered = await this.recoverMissingWorktree(taskId, "fresh");
    if (recovered.worktree === priorWorktree) {
      throw new Error("S11: vanished in-step worktree was not replaced by a new durable acquisition.");
    }
  }

  /*
  FNXC:PipelineSmoke 2026-08-24-15:40:
  The scripted merger squashes the branch it is handed. A WORKSPACE task legitimately has no
  task-level `branch`: each repository owns its own under `workspaceWorktrees[repo].branch`.
  `task.branch ?? ""` therefore handed the mock an EMPTY ref, and the land failed with
  `git merge --squash` on nothing ("merge:  - not something we can merge"), surfacing as the
  generic "Workspace repository repo1 could not land". Resolve the per-repository branch for a
  workspace row; single-repository rows keep `task.branch` unchanged.
  */
  private static scriptedMergeBranch(task: { branch?: string; workspaceWorktrees?: Record<string, { branch?: string }> }): string {
    if (task.branch) return task.branch;
    const workspaceBranch = Object.values(task.workspaceWorktrees ?? {})
      .map((entry) => entry?.branch)
      .find((branch): branch is string => typeof branch === "string" && branch.length > 0);
    return workspaceBranch ?? "";
  }

  private installScriptedAgents(taskId: string, branch: string, behavior: PipelineScriptedMergeBehavior): void {
    /*
    FNXC:PipelineSmoke 2026-08-24-15:40:
    Remember the newest non-empty branch and hand the scripts a GETTER. Installation happens before
    a workspace task owns any branch, so a captured value stayed empty for the whole run even though
    later installs resolved it correctly.
    */
    if (branch) this.scriptedBranches.set(taskId, branch);
    let entry = this.mockScriptStates.get(taskId);
    if (!entry || entry.behavior !== behavior) {
      entry = {
        behavior,
        state: { planReviewIndex: 0, codeReviewIndex: 0, implementationCommitted: false },
      };
      this.mockScriptStates.set(taskId, entry);
    }
    installPipelineMockScripts({
      taskId,
      branch: async () => {
        const live = await this.freshTask(taskId).catch(() => undefined);
        const resolved = live ? PipelineSmokeHarness.scriptedMergeBranch(live) : "";
        if (resolved) this.scriptedBranches.set(taskId, resolved);
        return resolved || this.scriptedBranches.get(taskId) || "";
      },
      behavior,
      state: entry.state,
      observeMockRuntime: () => this.guard.assertMockRuntime("mock/scripted"),
      readTaskSteps: async () => (await this.freshTask(taskId).catch(() => undefined))?.steps?.map((step) => step.status) ?? [],
    });
  }

  async tryEnqueueAutomaticMerge(taskId: string, behavior: PipelineScriptedMergeBehavior = {}): Promise<boolean> {
    const task = await this.freshTask(taskId);
    this.installScriptedAgents(taskId, PipelineSmokeHarness.scriptedMergeBranch(task), behavior);
    const accepted = this.engine.enqueueMerge(taskId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return accepted;
  }

  async enqueueAutomaticMerge(taskId: string, behavior: PipelineScriptedMergeBehavior = {}): Promise<void> {
    if (!await this.tryEnqueueAutomaticMerge(taskId, behavior)) {
      throw new Error(`Pipeline automatic merge enqueue was rejected for ${taskId}.`);
    }
  }

  async waitForTaskComplete(taskId: string): Promise<void> {
    const selected = await this.store.getTaskWorkflowSelectionAsync(taskId);
    const ir = selected?.workflowId
      ? getBuiltinWorkflow(selected.workflowId)?.ir ?? (await this.store.getWorkflowDefinition(selected.workflowId))?.ir
      : undefined;
    const completeColumn = ir ? resolveCompleteColumn(ir) : undefined;
    if (!completeColumn) throw new Error(`Pipeline automatic merge cannot resolve complete lane for ${taskId}.`);
    if ((await this.freshTask(taskId)).column === completeColumn) return;
    await new Promise<void>((resolve) => {
      const onMoved = ({ task: moved, to }: { task: Task; to: string }) => {
        if (moved.id !== taskId || to !== completeColumn) return;
        this.store.off("task:moved", onMoved);
        resolve();
      };
      this.store.on("task:moved", onMoved);
    });
  }

  async enqueueAndWaitForAutomaticMerge(taskId: string, behavior: PipelineScriptedMergeBehavior = {}): Promise<void> {
    const task = await this.freshTask(taskId);
    const selected = await this.store.getTaskWorkflowSelectionAsync(taskId);
    const ir = selected?.workflowId
      ? getBuiltinWorkflow(selected.workflowId)?.ir ?? (await this.store.getWorkflowDefinition(selected.workflowId))?.ir
      : undefined;
    const completeColumn = ir ? resolveCompleteColumn(ir) : undefined;
    if (!completeColumn) throw new Error(`Pipeline automatic merge cannot resolve complete lane for ${taskId}.`);
    this.installScriptedAgents(taskId, PipelineSmokeHarness.scriptedMergeBranch(task), behavior);
    await new Promise<void>((resolve, reject) => {
      const onMoved = ({ task: moved, to }: { task: Task; to: string }) => {
        if (moved.id !== taskId || to !== completeColumn) return;
        this.store.off("task:moved", onMoved);
        resolve();
      };
      this.store.on("task:moved", onMoved);
      if (!this.engine.enqueueMerge(taskId)) {
        this.store.off("task:moved", onMoved);
        reject(new Error(`Pipeline automatic merge enqueue was rejected for ${taskId}.`));
      }
    });
  }

  /** Wait for the exact task's merge finalizer to complete or visibly park, never for a generic queue idle signal. */
  async enqueueAndObserveMergeFinalization(taskId: string): Promise<Task> {
    const selected = await this.store.getTaskWorkflowSelectionAsync(taskId);
    const ir = selected?.workflowId
      ? getBuiltinWorkflow(selected.workflowId)?.ir ?? (await this.store.getWorkflowDefinition(selected.workflowId))?.ir
      : undefined;
    const completeColumn = ir ? resolveCompleteColumn(ir) : undefined;
    if (!completeColumn) throw new Error(`Pipeline merge finalization cannot resolve complete lane for ${taskId}.`);
    return new Promise<Task>((resolve, reject) => {
      let settled = false;
      const finish = (task: Task) => {
        if (settled) return;
        settled = true;
        this.store.off("task:updated", onUpdated);
        this.store.off("task:moved", onMoved);
        resolve(task);
      };
      const observe = () => {
        void this.freshTask(taskId).then((task) => {
          if (task.column === completeColumn || task.status === "failed") finish(task);
        }, reject);
      };
      const onUpdated = (task: Task) => {
        if (task.id === taskId) observe();
      };
      const onMoved = ({ task }: { task: Task }) => {
        if (task.id === taskId) observe();
      };
      this.store.on("task:updated", onUpdated);
      this.store.on("task:moved", onMoved);
      if (!this.engine.enqueueMerge(taskId)) {
        this.store.off("task:updated", onUpdated);
        this.store.off("task:moved", onMoved);
        reject(new Error(`Pipeline automatic merge enqueue was rejected for ${taskId}.`));
        return;
      }
      observe();
    });
  }

  async admitAndMerge(taskId: string, options: { signal?: AbortSignal; behavior?: PipelineScriptedMergeBehavior; manual?: boolean } = {}): Promise<PipelineMergeOutcome> {
    const task = await this.freshTask(taskId);
    this.installScriptedAgents(taskId, PipelineSmokeHarness.scriptedMergeBranch(task), options.behavior ?? {});
    try {
      const result = options.manual
        ? await this.engine.onMerge(taskId, { signal: options.signal })
        : await this.engine.requestInterpreterMerge(taskId, { signal: options.signal });
      if (!result.merged && !options.manual) this.manualHoldTaskIds.add(taskId);
      if (result.merged) this.manualHoldTaskIds.delete(taskId);
      return { admitted: result.merged === true, result };
    } catch (error) {
      return { admitted: true, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async integrationSha(): Promise<string> {
    return git(this.fixture.integrationRepoDir, ["rev-parse", "main"]);
  }

  async observe(taskId: string): Promise<PipelineObservedState> {
    const task = await this.freshTask(taskId);
    const selectedWorkflowId = (await this.store.getTaskWorkflowSelectionAsync(taskId))?.workflowId;
    const ir = selectedWorkflowId
      ? getBuiltinWorkflow(selectedWorkflowId)?.ir ?? (await this.store.getWorkflowDefinition(selectedWorkflowId))?.ir
      : undefined;
    const completeColumn = ir ? resolveCompleteColumn(ir) : "done";
    const creation = ir ? resolveCreationColumn(ir)?.id : undefined;
    const creationColumn = ir?.version === "v2" ? ir.columns.find((column) => column.id === creation) : undefined;
    const manualIntake = creationColumn?.traits.some((trait) => trait.trait === "intake" && trait.config?.autoTriage === false) === true;
    const [workItems, audits, settings] = await Promise.all([
      this.store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] }),
      this.store.getRunAuditEventsAsync({ taskId }),
      this.store.getSettings(),
    ]);
    const effectiveAutoMergeOff = task.autoMerge === false || (settings.autoMerge === false && task.autoMerge !== true);
    const branchReachableFromIntegration = task.mergeDetails?.commitSha
      ? (() => { try { git(this.fixture.integrationRepoDir, ["merge-base", "--is-ancestor", task.mergeDetails!.commitSha!, "main"]); return true; } catch { return false; } })()
      : false;
    const emptyTaskDiff = (() => {
      if (task.noCommitsExpected !== true || !task.branch) return false;
      const base = task.baseCommitSha ?? "main";
      try {
        git(this.fixture.integrationRepoDir, ["diff", "--quiet", `${base}...${task.branch}`]);
        return true;
      } catch {
        return false;
      }
    })();
    const sessions = activeSessionRegistry.pathsForTask(taskId).map((sessionPath) => ({
      path: sessionPath,
      available: activeSessionRegistry.isPathActive(sessionPath) && existsSync(sessionPath),
    }));
    const repeated = new Map<string, number>();
    for (const item of workItems) {
      const key = `${item.nodeId}\u0000${item.state}`;
      repeated.set(key, (repeated.get(key) ?? 0) + 1);
    }
    const state = await observePipelineTerminalState({
      store: {
        readFreshTask: async () => ({
          column: task.column,
          status: task.status ?? undefined,
          mergeConfirmed: task.mergeDetails?.mergeConfirmed === true,
          intake: task.column === creation && manualIntake,
          manualHold: this.manualHoldTaskIds.has(taskId)
            || workItems.some((item) => item.state === "manual-required" || item.nodeId === "merge-manual-hold")
            || (effectiveAutoMergeOff && task.column !== completeColumn && (task.workflowStepResults ?? []).some((result) => result.status === "passed")),
          done: task.column === completeColumn,
        }),
        readActiveWorkItems: async () => workItems.filter((item) => item.state !== "completed").map((item) => ({ nodeId: item.nodeId, state: item.state })),
        readFinalizationPasses: async () => audits.filter((event) => event.mutationType === "merge:ai-landed").length,
        readRepeatedWorkItemPairs: async () => [...repeated.entries()].map(([key, count]) => {
          const [nodeId, state] = key.split("\u0000");
          return { nodeId, state, count };
        }),
        readNoReleaser: async () => false,
        readNoProgress: async () => false,
      },
      git: {
        isBranchReachableFromIntegration: async () => branchReachableFromIntegration,
        hasEmptyDiff: async () => emptyTaskDiff,
      },
      registry: { readLiveSessions: async () => sessions },
    });
    return {
      ...state,
      stepSignature: task.steps.map((step) => `${step.name}:${step.status}`).join("|"),
      reviewSignature: (task.workflowStepResults ?? [])
        .map((result) => `${result.workflowStepId}:${result.status}:${result.verdict ?? ""}:${result.reviewInputFingerprint ?? ""}:${result.priorAttempts?.length ?? 0}`)
        .join("|"),
    };
  }

  /** Run one production graph dispatch and its real capacity-release counterpart. */
  /*
  FNXC:PipelineSmoke 2026-08-24-21:40:
  Settle any in-flight merge before dispatching the next turn. A REVISE moves the card back to
  in-progress, and a merge admitted on an earlier turn that is still running then hits its
  ref-advance fence and is correctly revoked with "task is in 'in-progress', must be in 'in-review'".
  That is the ENGINE behaving properly — it is the driver that was racing it, and the race only
  surfaced once the lane grew to 89 tests, appearing as an intermittent S05 failure.
  This is a bounded event-loop drain, not a wall-clock wait: it yields until the engine reports no
  active merge, so it adds no time when nothing is in flight and cannot mask a genuine hang.
  */
  private async settleActiveMerge(): Promise<void> {
    const engine = this.engine as unknown as { activeMergeTaskId?: string | null };
    for (let tick = 0; tick < 200 && engine.activeMergeTaskId; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async runProductionTurn(taskId: string, behavior: PipelineScriptedMergeBehavior = {}): Promise<void> {
    await this.settleActiveMerge();
    const before = await this.freshTask(taskId);
    if (before.status === "needs-replan" && behavior.planReviewModes !== undefined) {
      /*
      FNXC:PipelineSmoke 2026-08-23-20:12:
      A real Plan Review REVISE routes the card to the planner-owned replan state. Publish the
      next planned artifact through TaskStore's authoritative prompt writer before redispatching;
      this models the real triage handoff without fabricating steps or review results.
      */
      await this.publishPlannedPrompt(taskId);
    }
    await this.executeProductionGraph(taskId, behavior);
    await runHoldReleaseSweep(this.store, { now: this.clock.now });
  }

  async driveToDeclaredTerminal(
    taskId: string,
    expectedTerminal: PipelineTerminalState,
    behavior: PipelineScriptedMergeBehavior = {},
  ): Promise<PipelineScenarioResult> {
    const result = await driveToQuiescence(
      () => this.observe(taskId),
      () => this.runProductionTurn(taskId, behavior),
      {
        /*
        FNXC:PipelineSmoke 2026-08-24-20:10:
        A turn budget, not a timeout: it bounds how many explicit graph dispatches a scenario may
        take before it is called wedged. A review-column workflow adds verification, documentation
        and summary nodes to every rework cycle, so S05 ("REVISE twice, then approve") needs roughly
        nine more dispatches than the same scenario on the base graph. Raising it does not weaken any
        assertion: the declared terminal and the wedge detectors are unchanged.
        */
        maxIterations: 32,
        signature: (state) => JSON.stringify({
          column: state.column,
          status: state.status,
          mergeConfirmed: state.mergeConfirmed,
          steps: state.stepSignature,
          reviews: state.reviewSignature,
          active: state.activeWorkItems.map((item) => `${item.nodeId}:${item.state}`),
          finalizationPasses: state.finalizationPasses,
        }),
      },
    );
    if (result.terminal === "wedge") {
      const observed = await this.observe(taskId);
      const items = await this.store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
      const task = await this.freshTask(taskId);
      throw new Error(`${result.wedge ?? "W5 quiescence violation"}: ${taskId} did not converge (${JSON.stringify({ column: observed.column, status: observed.status, active: observed.activeWorkItems, items: items.map((item) => ({ node: item.nodeId, state: item.state, error: item.lastError })), reviews: task.workflowStepResults?.map((step) => ({ id: step.workflowStepId, status: step.status, verdict: step.verdict, output: step.output })), lastLogs: task.log?.slice(-4).map((entry) => entry.action) })}).`);
    }
    return this.assertTerminal(taskId, expectedTerminal);
  }

  async assertTerminal(taskId: string, expectedTerminal: PipelineTerminalState): Promise<PipelineScenarioResult> {
    const observed = await this.observe(taskId);
    const wedge = detectPipelineWedge(observed);
    const observedTerminal = classifyTerminalState(observed);
    if (wedge) throw new Error(`${wedge}: ${taskId} reached an invalid pipeline terminal state.`);
    if (observedTerminal !== expectedTerminal) {
      throw new Error(`${taskId} observed terminal ${observedTerminal}; expected declared ${expectedTerminal}.`);
    }
    return { taskId, expectedTerminal, observedTerminal, observed, wedge };
  }

  /**
   * FNXC:PipelineSmoke 2026-08-23-19:31:
   * Scenario lifecycle evidence comes from fresh task rows, workflow work items, and durable
   * transition audit rows. It cannot be replaced by a mock-call assertion.
   */
  async assertProductionStageEvidence(
    taskId: string,
    requirements: { readonly planReview?: boolean; readonly codeReview?: boolean; readonly implementation?: boolean } = {},
  ): Promise<Task> {
    const task = await this.freshTask(taskId);
    const results = task.workflowStepResults ?? [];
    const workItems = await this.store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    const audits = await this.store.getRunAuditEventsAsync({ taskId });
    const plan = results.find((result) => result.workflowStepId === "plan-review");
    const code = results.find((result) => result.workflowStepId === "code-review");
    if (requirements.planReview && (plan?.status !== "passed" || plan.verdict !== "APPROVE")) {
      throw new Error(`${taskId} did not persist a production Plan Review approval.`);
    }
    if (requirements.codeReview && (code?.status !== "passed" || code.verdict !== "APPROVE")) {
      throw new Error(`${taskId} did not persist a production Code Review approval.`);
    }
    if (requirements.implementation && (task.steps.length === 0 || task.steps.some((step) => step.status !== "done" && step.status !== "skipped"))) {
      throw new Error(`${taskId} did not persist completed implementation-step projection.`);
    }
    if (!workItems.length || !audits.some((event) => event.mutationType === "task:column-transition")) {
      throw new Error(`${taskId} lacks persisted workflow work-item or column-transition evidence.`);
    }
    return task;
  }

  /**
   * Drive the selected task through real Planning, Plan Review, scheduler release, execution,
   * and Code Review, then stop at the graph's manual-merge hold rather than pre-seeding review.
   */
  /*
  FNXC:PipelineSmoke 2026-08-25-04:20:
  Return only once the graph has QUIESCED at the hold, never on the first turn that merely LOOKS
  parked. The old exit condition `column === "in-review" && reviewPassed` is a snapshot, and a
  review-column workflow invalidates it one turn later: a Code Review REVISE appends remediation
  steps and sends the card back to in-progress, so the caller's merge then hit the engine's correct
  refusal ("task is in 'in-progress', must be in 'in-review'"). That is a REAL engine verdict, and
  suppressing it would have reproduced FN-175; the driver was wrong, not the engine.
  A `manual-required` work item is authoritative and returns immediately. Absent one, the loop keeps
  turning until the observable state stops changing across consecutive turns, which is a property of
  the graph rather than of how fast the suite happens to run — the reason this scenario was
  intermittent only under full-lane load.
  */
  async driveToManualMergeHold(taskId: string, behavior: PipelineScriptedMergeBehavior = {}): Promise<Task> {
    await this.store.updateSettings({ autoMerge: false });
    const signature = (task: Task): string => JSON.stringify({
      column: task.column,
      status: task.status ?? null,
      steps: (task.steps ?? []).map((step) => `${step.id}:${step.status}`),
      reviews: (task.workflowStepResults ?? []).map((result) => `${result.workflowStepId}:${result.status}`),
    });
    let stableSignature: string | undefined;
    let stableTurns = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await this.runProductionTurn(taskId, behavior);
      const current = await this.freshTask(taskId);
      if (current.column === "done" || current.mergeDetails?.mergeConfirmed) {
        throw new Error(`${taskId} merged before its reviewed branch reached the manual hold.`);
      }
      const active = await this.store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
      const manualHeld = active.some((item) => item.state === "manual-required" || item.nodeId === "merge-manual-hold");
      const reviewPassed = (current.workflowStepResults ?? []).some((result) => result.workflowStepId === "code-review" && result.status === "passed")
        || !(current.enabledWorkflowSteps ?? []).includes("code-review");

      const currentSignature = signature(current);
      stableTurns = currentSignature === stableSignature ? stableTurns + 1 : 0;
      stableSignature = currentSignature;

      // Two unchanged turns means the graph has nothing left to advance on its own.
      const settled = current.column === "in-review" && reviewPassed && stableTurns >= 2;
      if (manualHeld || settled) {
        await this.assertProductionStageEvidence(taskId, {
          planReview: (current.enabledWorkflowSteps ?? []).includes("plan-review"),
          codeReview: (current.enabledWorkflowSteps ?? []).includes("code-review"),
          implementation: !current.noCommitsExpected,
        });
        return current;
      }
    }
    const finalTask = await this.freshTask(taskId);
    throw new Error(`${taskId} did not reach the production manual-merge hold: ${JSON.stringify({ column: finalTask.column, status: finalTask.status, steps: finalTask.steps, reviews: finalTask.workflowStepResults, logs: finalTask.log?.slice(-6).map((entry) => entry.action) })}`);
  }

  /**
   * FNXC:PipelineSmoke 2026-08-23-19:31:
   * S05 alone reconstructs the documented FN-175 result-only row. It does so only after the
   * graph produced a real reviewed branch and persisted approvals; normal scenarios never write
   * workflow step results themselves.
   */
  async arrangeFn175MissingVerdictRow(taskId: string): Promise<readonly WorkflowStepResult[]> {
    const reviewed = await this.assertProductionStageEvidence(taskId, {
      planReview: true,
      codeReview: true,
      implementation: true,
    });
    const original = reviewed.workflowStepResults ?? [];
    await this.store.updateTask(taskId, {
      workflowStepResults: [
        reviewResult("plan-review", "passed", "APPROVE"),
        reviewResult("code-review", "passed"),
      ],
      status: null,
      error: null,
    });
    const incident = await this.freshTask(taskId);
    if (incident.workflowStepResults?.some((result) => result.workflowStepId === "code-review" && result.verdict)) {
      throw new Error(`${taskId} did not persist the FN-175 missing-verdict incident row.`);
    }
    return original;
  }

  /** Restore the graph-produced approval that S05 deliberately replaced with its incident row. */
  async restoreProductionReviewResults(taskId: string, results: readonly WorkflowStepResult[]): Promise<void> {
    await this.store.updateTask(taskId, { workflowStepResults: [...results], status: null, error: null });
    await this.assertProductionStageEvidence(taskId, { planReview: true, codeReview: true, implementation: true });
  }

  /**
   * FNXC:PipelineSmoke 2026-08-23-19:31:
   * S06 needs a review callback to race an already-entered merger. The normal graph path has
   * already produced the approval this method snapshots; this narrow durable callback injection
   * models only the concurrent REVISE delivery and never substitutes for earlier graph stages.
   */
  async recordInFlightCodeReviewRevise(taskId: string): Promise<readonly WorkflowStepResult[]> {
    const reviewed = await this.assertProductionStageEvidence(taskId, {
      planReview: true,
      codeReview: true,
      implementation: true,
    });
    const original = reviewed.workflowStepResults ?? [];
    await this.store.updateTask(taskId, {
      workflowStepResults: [
        ...original.filter((result) => result.workflowStepId !== "code-review"),
        reviewResult("code-review", "failed", "REVISE"),
      ],
    });
    const revoked = await this.freshTask(taskId);
    if (revoked.workflowStepResults?.find((result) => result.workflowStepId === "code-review")?.verdict !== "REVISE") {
      throw new Error(`${taskId} did not persist the in-flight Code Review revocation.`);
    }
    return original;
  }

  async runNoOpScenario(taskId: string): Promise<PipelineScenarioResult> {
    const before = await this.integrationSha();
    const result = await this.driveToDeclaredTerminal(taskId, "no-op-merge", { commitImplementation: false });
    const after = await this.integrationSha();
    if (before !== after) throw new Error(`S14: ${taskId} advanced integration for an empty task branch.`);
    return result;
  }

  private async stageConfirmedMergeForFinalization(
    task: PipelineTaskSeed,
    options: { readonly status?: string | null } = {},
  ): Promise<{ mergedActivities: number; workItemSignature: string }> {
    await this.driveToDeclaredTerminal(task.id, "merged-done");
    const landed = await this.freshTask(task.id);
    if (landed.mergeDetails?.mergeConfirmed !== true) {
      throw new Error("S16: the production merge lane did not persist confirmed merge proof.");
    }

    /*
    FNXC:PipelineSmoke 2026-08-23-21:45:
    S16 and S17 reconstruct the real durable post-land row only after the same task's local Git
    merge has completed. The row keeps its confirmed merge proof while a stale checklist returns
    it to review, which is the production recovery boundary FN-180 must reconcile exactly once.
    */
    await this.store.moveTask(task.id, task.holdColumn, {
      moveSource: "engine",
      preserveProgress: true,
      bypassGuards: true,
    });
    await this.store.moveTask(task.id, task.wipColumn, {
      moveSource: "engine",
      preserveProgress: true,
      bypassGuards: true,
    });
    await this.store.moveTask(task.id, task.reviewColumn, {
      moveSource: "engine",
      preserveProgress: true,
      bypassGuards: true,
    });
    await this.store.updateTask(task.id, {
      steps: [{ name: "stale implementation", status: "pending" }],
      workflowStepResults: [reviewResult("code-review", "pending")],
      status: options.status ?? null,
      error: null,
      priority: "urgent",
    });
    const staged = await this.freshTask(task.id);
    if (
      staged.column !== task.reviewColumn
      || staged.mergeDetails?.mergeConfirmed !== true
      || staged.steps.some((step) => step.status !== "pending")
    ) {
      throw new Error(`S16 did not persist the stale confirmed-merge checklist before queue admission: ${JSON.stringify({ column: staged.column, steps: staged.steps, status: staged.status })}`);
    }
    return {
      mergedActivities: await this.mergedActivityCount(task.id),
      workItemSignature: await this.workflowWorkItemSignature(task.id),
    };
  }

  async runStaleFinalizationScenario(task: PipelineTaskSeed): Promise<PipelineScenarioResult> {
    const staged = await this.stageConfirmedMergeForFinalization(task);
    const before = await this.observe(task.id);
    const finalization = await this.enqueueAndObserveMergeFinalization(task.id);
    if (finalization.status === "failed") {
      throw new Error("S16: confirmed merge parked instead of reconciling its stale checklist.");
    }
    const after = await this.assertTerminal(task.id, "merged-done");
    const mergedActivities = await this.mergedActivityCount(task.id);
    if (
      before.finalizationPasses > 1
      || after.observed.finalizationPasses !== 1
      || mergedActivities !== staged.mergedActivities + 1
    ) {
      throw new Error(`S16: confirmed-merge reconciliation repeated or skipped finalization (${JSON.stringify({ beforeFinalizationPasses: before.finalizationPasses, afterFinalizationPasses: after.observed.finalizationPasses, stagedActivities: staged.mergedActivities, mergedActivities })}).`);
    }
    return after;
  }

  /**
   * Restart the real engine from a confirmed-but-not-finalized durable row and prove that exactly
   * one fast-path finalization resumes without replaying any graph work item or merge body.
   */
  /*
  FNXC:PipelineSmoke 2026-08-26-07:52:
  SETTLE AFTER A RESTART, NEVER SNAPSHOT IT.

  A restarted engine finalizes a merge-confirmed row through its own asynchronous startup recovery.
  Reading the row once, immediately, asks "has recovery finished?" at an arbitrary instant and treats
  "not yet" as "never" — which sends the caller down the `admitAndMerge` fallback. That fallback
  cannot succeed here BY CONSTRUCTION: staging deliberately replaced the row's step results with a
  single PENDING code-review row and its steps with a pending stale step, so merge admission is
  correctly refused and the scenario fails with "post-merge restart parked finalization".

  So the test's outcome depended on whether recovery beat a single read — passing in isolation (19/19
  across 8 runs) and failing intermittently under full-lane load, where the machine is busy. That is a
  property of how fast the suite happens to run, not of the product. `builtin:coding-ideas-v2` is the
  variant that surfaced it because its extra in-review milestone lands the restart in the racy window
  more often.

  Same remedy and same shape as `settleActiveMerge` and FN-WF's earlier `driveToManualMergeHold` fix:
  a BOUNDED event-loop drain, not a wall-clock wait. It costs nothing when recovery has already
  finished, and it cannot mask a genuine hang — exhausting the budget still falls through to the
  fallback, which reports the real refusal.
  */
  private async settleRestartFinalization(task: PipelineTaskSeed): Promise<Task> {
    let current = await this.freshTask(task.id);
    for (let tick = 0; tick < 200 && current.column !== task.completeColumn; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      current = await this.freshTask(task.id);
    }
    return current;
  }

  async restartPostMergeFinalization(task: PipelineTaskSeed): Promise<PipelineScenarioResult> {
    const staged = await this.stageConfirmedMergeForFinalization(task, { status: "merging" });
    const restarted = await this.restartComposition(task.id, { restartEngine: true });
    const afterRestart = await this.settleRestartFinalization(task);
    if (afterRestart.mergeDetails?.mergeConfirmed !== true) {
      throw new Error("S17: restart lost durable post-merge proof before finalization.");
    }

    if (afterRestart.column !== task.completeColumn) {
      /*
      FNXC:PipelineSmoke 2026-08-23-21:45:
      A restarted engine can already own the durable merge queue entry seeded at startup. Route the
      recovery through its real onMerge admission instead of requiring a second raw enqueue; this
      waits for the existing production queue owner and still executes the merge-confirmed fast path.
      */
      const settled = await this.admitAndMerge(task.id, { manual: true });
      if (!settled.result?.merged) {
        throw settled.error ?? new Error("S17: post-merge restart parked finalization.");
      }
    }
    const once = await this.assertTerminal(task.id, "merged-done");
    const mergedActivities = await this.mergedActivityCount(task.id);
    const workItemsAfterFinalization = await this.workflowWorkItemSignature(task.id);
    if (
      mergedActivities !== staged.mergedActivities + 1
      || workItemsAfterFinalization !== restarted.workItemSignatureAfter
      || (await this.store.getRunAuditEventsAsync({ taskId: task.id }))
        .filter((event) => event.mutationType === "merge:ai-landed").length !== 1
    ) {
      throw new Error("S17: post-merge restart replayed a completed seam or finalization.");
    }

    await this.restartComposition(task.id, { restartEngine: true });
    if (
      await this.mergedActivityCount(task.id) !== mergedActivities
      || await this.workflowWorkItemSignature(task.id) !== workItemsAfterFinalization
    ) {
      throw new Error("S17: a second restart repeated post-merge finalization.");
    }
    return once;
  }

  /** Recreate a disappeared task worktree through the production acquisition path, then publish fresh review evidence. */
  async recoverMissingWorktree(
    taskId: string,
    expectedSource: AcquireTaskWorktreeResult["source"] = "fresh",
  ): Promise<Task> {
    const before = await this.freshTask(taskId);
    if (before.worktree) rmSync(before.worktree, { recursive: true, force: true });
    git(this.fixture.integrationRepoDir, ["worktree", "prune"]);
    if (before.branch) {
      try { git(this.fixture.integrationRepoDir, ["branch", "-D", before.branch]); } catch { /* stale branch is already absent */ }
    }
    await this.store.updateTask(taskId, {
      worktree: null,
      branch: null,
      branchWriteOrigin: "engine",
      baseCommitSha: null,
    });
    const acquisition = await this.acquirePipelineTaskWorktree(taskId);
    const recovered = await this.assertDurableAcquisition(taskId, acquisition, expectedSource);
    const baseCommitSha = git(acquisition.worktreePath, ["merge-base", "HEAD", "main"]);
    await this.store.updateTask(taskId, { baseCommitSha });
    /*
    FNXC:PipelineSmoke 2026-08-23-21:45:
    Missing-worktree recovery asserts the fresh durable assignment before the graph resumes. That
    prevents an apparently green S11 from skipping acquisition and manufacturing only downstream
    review evidence after the checkout disappeared.
    */
    const rootStatus = git(this.fixture.integrationRepoDir, ["status", "--porcelain"]);
    if (rootStatus) throw new Error(`S11: recovery left integration checkout dirty: ${rootStatus}`);
    // Planning evidence is still current because this scenario removes the execution checkout,
    // not PROMPT.md. Preserve its real Plan Review approval and let the resumed graph create fresh
    // implementation and Code Review evidence on the reacquired branch.
    return recovered;
  }

  async exerciseSchedulerAndRecovery(taskId: string): Promise<void> {
    await runHoldReleaseSweep(this.store, { now: this.clock.now });
    const task = await this.freshTask(taskId);
    await reconcileRecovery(this.store, [task], { now: this.clock.now });
    const manager = new SelfHealingManager(this.store, { rootDir: this.fixture.repoDir, getExecutingTaskIds: () => new Set<string>() });
    await manager.recoverStaleMergingStatus();
  }

  hasAuthoritativeSeams(): boolean {
    return this.authoritativeSeamsObserved;
  }

  async executeProductionGraph(
    taskId: string,
    behavior: PipelineScriptedMergeBehavior = {},
  ): Promise<Task> {
    const task = await this.freshTask(taskId);
    this.installScriptedAgents(taskId, PipelineSmokeHarness.scriptedMergeBranch(task), behavior);
    const executor = this.wireExecutor();
    const seams = executor.createAuthoritativeWorkflowSeams(await this.store.getSettings());
    if (typeof seams.planning !== "function" || typeof seams.execute !== "function" || typeof seams.merge !== "function") {
      throw new Error("Pipeline smoke did not resolve the executor's authoritative workflow seams.");
    }
    this.authoritativeSeamsObserved = true;
    /*
    FNXC:PipelineSmoke 2026-08-24-23:10:
    A revoked merge gate is a DEFERRAL, not a failure. That is FN-180's own contract and the reason
    it carries a dedicated error type, so callers cannot convert a gate lost mid-merge into a retry
    or a failed park. It surfaces here when a merge admitted on an earlier turn reaches its
    ref-advance fence after a REVISE has already returned the card to in-progress: the engine is
    refusing correctly, and the driver must simply take another turn. Swallowing ONLY this type
    keeps every other merge failure fatal to the scenario.
    */
    try {
      await executor.executeAuthoritativeGraph(task);
    } catch (error) {
      /* Detected by NAME: importing merger-errors.js would break the pre-FN-180 differential run. */
      if ((error as { name?: string } | undefined)?.name !== "MergeGateRevokedError") throw error;
    }
    const after = await this.freshTask(taskId);
    if (after.mergeDetails?.mergeConfirmed === true) this.manualHoldTaskIds.delete(taskId);
    return after;
  }
}
