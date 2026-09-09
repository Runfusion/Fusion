import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";

/*
FNXC:CapacityModel 2026-07-29-14:10 (two numbers — spawned agents count):
`fn_spawn_agent` now gates on the PROJECT agent count instead of two private
budgets (`maxSpawnedAgentsPerParent` 5, `maxSpawnedAgentsGlobal` 20, both deleted).

Why this is a hole being closed and not only knobs being removed: a spawned child
is an agent AND gets its own git worktree, but was counted by NEITHER capacity
gate. A fan-out could put up to 20 extra worktrees on disk while the scheduler
believed the project was at its configured limit — the operator's two numbers were
simply wrong about what was running.

The old caps also measured the wrong thing. `totalSpawnedCount` is decremented when
a child is cleaned up, but the per-parent set was only cleared when the PARENT task
ended, so `maxSpawnedAgentsPerParent` throttled cumulative spawns over a task's
life rather than concurrent ones — a long task could exhaust its budget with five
children that had all long since finished.
*/

function executorWithSpawnState(opts: {
  claimedTasks: unknown[];
  liveChildren: number;
  maxConcurrent: number;
}): { executor: TaskExecutor; listTasks: ReturnType<typeof vi.fn> } {
  const listTasks = vi.fn(async () => opts.claimedTasks);
  const executor = Object.create(TaskExecutor.prototype) as TaskExecutor;
  const priv = executor as unknown as Record<string, unknown>;
  priv.store = {
    listTasks,
    getTask: vi.fn(async (id: string) => ({ id, column: "in-progress" })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
  };
  priv.options = { agentStore: { createAgent: vi.fn() } };
  priv.spawnedAgents = new Map<string, Set<string>>();
  priv.totalSpawnedCount = opts.liveChildren;
  return { executor, listTasks };
}

/** Drive the tool's capacity branch without the agent-creation tail. */
async function trySpawn(executor: TaskExecutor, taskId: string, maxConcurrent: number) {
  const tool = (executor as unknown as {
    createSpawnAgentTool(taskId: string, worktreePath: string, settings: unknown): {
      execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }>; details: { state: string } }>;
    };
  }).createSpawnAgentTool(taskId, "/tmp/wt", { maxConcurrent });
  return tool.execute("call-1", { name: "child", role: "engineer", task: "do a thing" });
}

describe("fn_spawn_agent capacity", () => {
  /*
  Reverting to the private budgets makes this pass at 1/1: the old per-parent cap
  was 5 and the old global cap 20, so a project already at its agent limit could
  still spawn — which is the hole.
  */
  it("refuses to spawn when the project's agent count is already consumed", async () => {
    const { executor } = executorWithSpawnState({
      claimedTasks: [{ id: "FN-1", column: "in-progress" }],
      liveChildren: 0,
      maxConcurrent: 1,
    });

    const result = await trySpawn(executor, "FN-1", 1);

    expect(result.details.state).toBe("error");
    expect(result.content[0]?.text).toContain("Agent capacity reached");
    expect(result.content[0]?.text).toContain("1/1");
  });

  /*
  Live children count toward the SAME number, not a separate budget. Without this
  term a parent at the project limit could still fan out, which is exactly what the
  private global cap allowed.
  */
  it("counts live spawned children toward the project agent count", async () => {
    const { executor } = executorWithSpawnState({
      claimedTasks: [{ id: "FN-1", column: "in-progress" }],
      liveChildren: 1,
      maxConcurrent: 2,
    });

    const result = await trySpawn(executor, "FN-1", 2);

    expect(result.details.state).toBe("error");
    // 1 claimed task + 1 live child == the cap of 2.
    expect(result.content[0]?.text).toContain("2/2");
    expect(result.content[0]?.text).toContain("1 spawned child agent(s)");
  });

  it("permits a spawn while the project has agent headroom", async () => {
    const { executor } = executorWithSpawnState({
      claimedTasks: [{ id: "FN-1", column: "in-progress" }],
      liveChildren: 0,
      maxConcurrent: 4,
    });

    const result = await trySpawn(executor, "FN-1", 4);

    // Past the capacity branch: it proceeds into agent creation rather than
    // returning the capacity refusal.
    expect(result.content[0]?.text ?? "").not.toContain("Agent capacity reached");
  });

  /*
  The message names the knob an operator can actually change. The deleted caps
  pointed at settings that no longer exist, which is worse than no message: it sends
  someone hunting for a control that is not there.
  */
  it("names Max Concurrent Tasks in the refusal, not a deleted spawn cap", async () => {
    const { executor } = executorWithSpawnState({
      claimedTasks: [{ id: "FN-1", column: "in-progress" }],
      liveChildren: 0,
      maxConcurrent: 1,
    });

    const result = await trySpawn(executor, "FN-1", 1);

    expect(result.content[0]?.text).toContain("Max Concurrent Tasks");
    expect(result.content[0]?.text).not.toMatch(/spawn limit/i);
  });
  /*
  FNXC:CapacityModel 2026-07-29-19:20 (PR #2579 review — greptile P1, TOCTOU):
  Two parents with ONE slot left must not both spawn.

  The check read capacity, then several awaits followed (createAgent, createWorktree,
  updateAgentState) before the count was incremented — so both calls passed and both
  spawned, producing more agents and more worktrees than Max Concurrent Tasks
  permits. That is the very hole this change set out to close, reintroduced by the
  fix for it.
  */
  it("reserves the slot before awaiting, so two concurrent spawns cannot both pass", async () => {
    const { executor } = executorWithSpawnState({
      claimedTasks: [{ id: "FN-1", column: "in-progress" }],
      liveChildren: 0,
      maxConcurrent: 2, // 1 claimed task + 1 free slot
    });

    // Both callers race the same free slot without awaiting between them.
    const [first, second] = await Promise.all([
      trySpawn(executor, "FN-1", 2),
      trySpawn(executor, "FN-1", 2),
    ]);

    const refused = [first, second].filter((r) => r.content[0]?.text?.includes("Agent capacity reached"));
    expect(refused, "exactly one of two racing spawns must be refused").toHaveLength(1);
  });

  it("returns the reserved slot when the spawn fails", async () => {
    const { executor } = executorWithSpawnState({
      claimedTasks: [{ id: "FN-1", column: "in-progress" }],
      liveChildren: 0,
      maxConcurrent: 4,
    });
    (executor as unknown as { options: { agentStore: { createAgent: unknown } } }).options.agentStore.createAgent =
      vi.fn(async () => { throw new Error("agent store unavailable"); });

    const result = await trySpawn(executor, "FN-1", 4);
    expect(result.content[0]?.text).toContain("Failed to spawn agent");

    // A failed spawn must not permanently consume capacity.
    expect((executor as unknown as { totalSpawnedCount: number }).totalSpawnedCount).toBe(0);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-08-01-03:20:
THE SPAWN WORKTREE LEDGER EXCLUDES TERMINAL LANES BY ROLE, NOT BY NAME.

The maxWorktrees gate once used literal terminal column ids. On a renamed board the literal `done`
does not match, so every finished card still counts as
a live worktree holder, `heldWorktrees` only grows, and eventually EVERY spawn is refused on a board
with free slots. That is worse than the over-spawn the gate exists to prevent, because a permanent
refusal is silent — the operator sees children that never start and no capacity breach to explain it.

Measured before this case existed: blinding the resolver back to the two literals left all 19 tests
in the capacity suites green, so nothing in the tree could tell the conversion from what it replaced.

The fixture is built so the two answers DISAGREE, which is the whole point: one card sits in a
renamed COMPLETE lane holding a worktree, with `maxWorktrees: 1`. Resolved, it is terminal and
consumes nothing, so the spawn proceeds. Against the literals it is counted, `heldWorktrees` is 1,
and 1 + the reserved child exceeds the budget.
*/
describe("fn_spawn_agent worktree ledger on a renamed board", () => {
  /** Complete lane is `shipped`; the board declares no column called `done`. */
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };

  function executorOnRenamedBoard(tasks: unknown[]) {
    const executor = Object.create(TaskExecutor.prototype) as TaskExecutor;
    const priv = executor as unknown as Record<string, unknown>;
    priv.store = {
      listTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async (id: string) => ({ id, column: "building" })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      /* The only store read `resolveProjectColumnsForRoles` makes. */
      listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
    };
    priv.options = { agentStore: { createAgent: vi.fn() } };
    priv.spawnedAgents = new Map<string, Set<string>>();
    priv.totalSpawnedCount = 0;
    return executor;
  }

  async function spawnWith(executor: TaskExecutor, settings: unknown) {
    const tool = (executor as unknown as {
      createSpawnAgentTool(taskId: string, worktreePath: string, settings: unknown): {
        execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }>; details: { state: string } }>;
      };
    }).createSpawnAgentTool("FN-1", "/tmp/wt", settings);
    return tool.execute("call-1", { name: "child", role: "engineer", task: "do a thing" });
  }

  it("does not count a card in a RENAMED complete lane against the worktree budget", async () => {
    const executor = executorOnRenamedBoard([
      { id: "FN-1", column: "building" },
      /* Finished work whose worktree is cleanup-owned, not capacity. */
      { id: "FN-SHIPPED", column: "shipped", worktree: "/tmp/wt-shipped" },
    ]);

    const result = await spawnWith(executor, { maxConcurrent: 10, maxWorktrees: 1 });

    /* Against the literals `shipped` is counted, heldWorktrees is 1, and the spawn is refused. */
    expect(result.content[0]?.text ?? "").not.toContain("Worktree capacity reached");
  });

  /*
  THE PAIRED POSITIVE. The case above is a "does not refuse" assertion, which a gate that never
  refused would also satisfy — including one broken into ignoring maxWorktrees entirely. This pins
  that the SAME renamed board still refuses when a live card genuinely holds the last worktree.
  */
  it("still refuses when a card in a live RENAMED lane holds the last worktree", async () => {
    const executor = executorOnRenamedBoard([
      { id: "FN-1", column: "building" },
      { id: "FN-LIVE", column: "building", worktree: "/tmp/wt-live" },
    ]);

    const result = await spawnWith(executor, { maxConcurrent: 10, maxWorktrees: 1 });

    expect(result.content[0]?.text ?? "").toContain("Worktree capacity reached");
  });
});
