import { describe, it, expect, vi, beforeEach } from "vitest";
import { ANY_MUTATION_CONTEXT, UNATTRIBUTED_CONTEXT_MATCHER } from "./mutation-context-matchers.js";
import { isUsageLimitError, UsageLimitPauser, checkSessionError } from "../errors/usage-limit-detector.js";
import { CredentialInstanceRotator } from "../credential-instance-rotation.js";

// ── isUsageLimitError classification tests ───────────────────────────

describe("isUsageLimitError", () => {
  describe("should match usage-limit errors", () => {
    const usageLimitMessages = [
      // Anthropic overloaded
      "overloaded_error: Overloaded",
      "API is overloaded",
      // Rate limiting
      "rate_limit_error: Rate limit exceeded",
      "rate limit exceeded",
      "Rate Limit Reached",
      "Too many requests",
      "too many requests, please retry after 60s",
      // HTTP status codes
      "Request failed with status 429",
      "HTTP 429: Too Many Requests",
      "529 overloaded",
      "Status 529",
      // Quota / billing
      "quota exceeded for this billing period",
      "Quota limit reached",
      "billing account is inactive",
      "Billing issue detected",
      "insufficient credit balance",
      "Insufficient credits",
      "credit balance too low",
    ];

    for (const msg of usageLimitMessages) {
      it(`matches: "${msg}"`, () => {
        expect(isUsageLimitError(msg)).toBe(true);
      });
    }
  });

  describe("should NOT match transient server errors", () => {
    const transientMessages = [
      "Internal Server Error",
      "Request failed with status 500",
      "HTTP 502: Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "connection refused",
      "Connection reset by peer",
      "ECONNREFUSED",
      "timeout exceeded",
      "request timed out",
      "socket hang up",
      "network error",
      "ETIMEDOUT",
      "DNS lookup failed",
      "getaddrinfo ENOTFOUND",
    ];

    for (const msg of transientMessages) {
      it(`does not match: "${msg}"`, () => {
        expect(isUsageLimitError(msg)).toBe(false);
      });
    }
  });

  it("returns false for empty string", () => {
    expect(isUsageLimitError("")).toBe(false);
  });

  it("returns false for generic error messages", () => {
    expect(isUsageLimitError("Something went wrong")).toBe(false);
    expect(isUsageLimitError("Unexpected token in JSON")).toBe(false);
  });
});

// ── checkSessionError tests ──────────────────────────────────────────

describe("checkSessionError", () => {
  it("throws when session.state.error is set", () => {
    const session = { state: { error: "rate_limit_error: Rate limit exceeded" } };
    expect(() => checkSessionError(session)).toThrow("rate_limit_error: Rate limit exceeded");
  });

  it("does not throw when session.state.error is undefined", () => {
    const session = { state: { error: undefined } };
    expect(() => checkSessionError(session)).not.toThrow();
  });

  it("does not throw when session.state.error is empty string", () => {
    const session = { state: { error: "" } };
    expect(() => checkSessionError(session)).not.toThrow();
  });

  it("thrown error message matches session.state.error exactly", () => {
    const errorMessage = "overloaded_error: Overloaded";
    const session = { state: { error: errorMessage } };

    let thrownMessage: string | undefined;
    try {
      checkSessionError(session);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(thrownMessage).toBe(errorMessage);
    // Verify isUsageLimitError can classify it
    expect(isUsageLimitError(thrownMessage!)).toBe(true);
  });

  it("thrown error message for rate limit is classifiable by isUsageLimitError", () => {
    const session = { state: { error: "429 Too Many Requests" } };

    let thrownMessage: string | undefined;
    try {
      checkSessionError(session);
    } catch (err: any) {
      thrownMessage = err.message;
    }

    expect(isUsageLimitError(thrownMessage!)).toBe(true);
  });

  it("does not throw when state has no error property", () => {
    const session = { state: {} };
    expect(() => checkSessionError(session as any)).not.toThrow();
  });
});

// ── UsageLimitPauser tests ───────────────────────────────────────────

function createMockStore(tasks: any[] = []) {
  return {
    logEntry: vi.fn().mockResolvedValue(undefined),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn().mockImplementation(async (id: string) => tasks.find((task) => task.id === id) ?? {
      id,
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
    }),
    getSettings: vi.fn().mockResolvedValue({
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5",
    }),
  } as any;
}

describe("UsageLimitPauser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses only the affected task instead of activating global pause", async () => {
    const store = createMockStore([
      { id: "FN-001", column: "todo", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-002", column: "todo", modelProvider: "openai-codex", modelId: "gpt-5" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-001", "rate_limit_error: Rate limit exceeded", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, {
      pausedReason: "provider-rate-limit:anthropic",
    });
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-002", expect.anything(), expect.anything(), expect.anything());
    expect(store.updateSettings).toBeUndefined();
  });

  it("logs the triggering error on the task via store.logEntry", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("triage", "FN-002", "overloaded_error");

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      "Usage limit detected (triage/unknown): overloaded_error", undefined, ANY_MUTATION_CONTEXT);
  });

  it("parks active executor tasks on the unavailable provider while other lanes and providers continue", async () => {
    const store = createMockStore([
      { id: "FN-001", column: "in-progress", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-002", column: "in-progress", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-003", column: "in-progress", modelProvider: "openai-codex", modelId: "gpt-5" },
      { id: "FN-004", column: "triage", planningModelProvider: "anthropic", planningModelId: "claude-sonnet" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-001", "rate limit", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledTimes(2);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, { pausedReason: "provider-rate-limit:anthropic" });
    expect(store.pauseTask).toHaveBeenCalledWith("FN-002", true, undefined, { pausedReason: "provider-rate-limit:anthropic" });
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-003", expect.anything(), expect.anything(), expect.anything());
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-004", expect.anything(), expect.anything(), expect.anything());
  });

  it("parks only active triage tasks whose planning or validator lane uses the unavailable provider", async () => {
    const store = createMockStore([
      { id: "FN-010", column: "triage", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet" },
      { id: "FN-011", column: "triage", planningModelProvider: "openai-codex", planningModelId: "gpt-5", validatorModelProvider: "openai-codex", validatorModelId: "gpt-5" },
      { id: "FN-012", column: "in-progress", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("triage", "FN-010", "429", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledTimes(1);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-010", true, undefined, { pausedReason: "provider-rate-limit:anthropic" });
  });

  it("uses a recoverable qualified reason when the caller cannot identify the provider", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-001", "rate limit");
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true, undefined, {
      pausedReason: "provider-rate-limit:unknown",
    });
  });

  it("includes agent type in the log entry", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("merger", "FN-005", "quota exceeded", "Anthropic API");

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-005",
      expect.stringContaining("merger/anthropic-api"), undefined, ANY_MUTATION_CONTEXT);
  });

  it("resumes only exact provider-rate-limit parks after positive provider health", async () => {
    const store = createMockStore([
      { id: "FN-101", paused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-102", paused: true, pausedReason: "provider-rate-limit:openai-codex" },
      { id: "FN-103", paused: true, pausedReason: "manual" },
      { id: "FN-104", paused: true, userPaused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-105", paused: false, pausedReason: "provider-rate-limit:anthropic" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await expect(pauser.onProviderAvailable("Anthropic")).resolves.toBe(1);

    expect(store.pauseTask).toHaveBeenCalledTimes(1);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-101", false);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-101",
      "Provider anthropic is available again; resuming task", undefined, UNATTRIBUTED_CONTEXT_MATCHER);
  });

  it("does nothing when provider health has no matching persisted parks", async () => {
    const store = createMockStore([
      { id: "FN-201", paused: true, pausedReason: "provider-rate-limit:openai-codex" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await expect(pauser.onProviderAvailable("anthropic")).resolves.toBe(0);
    expect(store.pauseTask).not.toHaveBeenCalled();
  });

  it("clears the shared credential cooldown before resuming provider parks", async () => {
    const store = createMockStore();
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => [], getDefaultInstance: () => undefined },
    });
    const limited = { providerId: "anthropic", instanceId: "backup" };
    rotator.markLimited(limited);
    const pauser = new UsageLimitPauser(store, { credentialRotator: rotator });

    await pauser.onProviderAvailable("anthropic");
    expect(rotator.isCoolingDown(limited)).toBe(false);
  });
});

/*
FNXC:MergedPlanningColumn 2026-07-29-19:30 (U11 — SUPERSEDED, reduced to the surviving contribution):

This block originally carried a production fix of my own: pairing the planning lane's `triage`
literal with `todo`. Main landed a BETTER fix first (PR #2572) — a per-task, trait-resolved
`preImplementationColumns` set keyed on the INTAKE trait, with an explicit argument for excluding
`hold` because a hold column can be a mid-pipeline wait rather than a planning queue. My paired
literal is strictly worse and is dropped rather than defended.

Two of my original tests went with it, and one of them was asserting the WRONG thing: it expected a
`triage` bystander to be parked on a default-workflow board. Under the trait-resolved design that is
correct behavior to REFUSE — the default workflow's intake is `todo`, so a card in `triage` is not
in its planning lane at all. Keeping that assertion would have pinned my own narrower reading over
main's.

What survives is the round trip, which greptile asked for and which main's own tests do not cover:
parking without resuming would leave a card parked FOREVER — parked correctly, never resumed —
which reads to an operator as deliberately held rather than stuck. `onProviderAvailable` filters on
`pausedReason` and consults no column, so it is column-independent and was never broken; that is
exactly why it needs pinning, since nothing stops someone adding a lane check to recovery to
"match" the parking side.
*/
describe("usage-limit parking and recovery round trip (U11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parks a bystander on the rate-limited provider AND resumes it when the provider returns", async () => {
    const store = createMockStore([
      { id: "FN-103", column: "in-progress", modelProvider: "anthropic", modelId: "claude-sonnet" },
      { id: "FN-104", column: "in-progress", modelProvider: "anthropic", modelId: "claude-sonnet" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await pauser.onUsageLimitHit("executor", "FN-103", "rate limit", "anthropic");
    expect(store.pauseTask).toHaveBeenCalledWith("FN-104", true, undefined, {
      pausedReason: "provider-rate-limit:anthropic",
    });

    // Reflect the park into the rows recovery will read, then recover.
    store.listTasks.mockResolvedValue([
      { id: "FN-103", column: "in-progress", paused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-104", column: "in-progress", paused: true, pausedReason: "provider-rate-limit:anthropic" },
    ]);

    await expect(pauser.onProviderAvailable("anthropic")).resolves.toBe(2);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-104", false);
  });

  it("does not resume a card parked for an unrelated reason", async () => {
    /*
    Regression direction: recovery keys on the exact `pausedReason`, so a provider coming back must
    not clear an operator park or another provider's outage. Without this, widening recovery to
    "resume anything paused" would satisfy the round trip above.
    */
    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      { id: "FN-105", column: "in-progress", paused: true, pausedReason: "provider-rate-limit:openai-codex" },
      { id: "FN-106", column: "in-progress", paused: true, userPaused: true, pausedReason: "operator" },
    ]);
    const pauser = new UsageLimitPauser(store);

    await expect(pauser.onProviderAvailable("anthropic")).resolves.toBe(0);
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-105", false);
    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-106", false);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-22:35:

THE EXECUTOR AND MERGER LANES WERE STILL LITERALS. `taskUsesProvider` resolves a task's active lane to decide
which providers it is running on; the PLANNER lane was converted to traits (the note in that function
describes the exact failure and says it was fixed), and the executor/merger halves were left as
`task.column === "in-progress"` / `=== "in-review"`.

So on a renamed board an actively-executing card resolved NO providers, and a provider rate limit never
paused it — the engine kept hammering the limited provider with that card. Measured before the fix on a
renamed board (`building` = wip), executor limit triggered by a peer: only the TRIGGERING task was paused,
and only because of the always-include-the-trigger fallback. The peer running on the same rate-limited
provider was left going.

HOW THIS WAS FOUND, because the route matters more than the bug: a scan for "legacy literal within a few
lines of a role-resolved call" flagged this file. The FIRST thing I suspected there — the `done`/`archived`
terminal filter — turned out to be a FALSE POSITIVE: its revert stayed green, because the lane check already
excludes finished cards. Chasing why the revert would not go red is what surfaced the real defect one line
over. A revert proof that stays green is information, not a dead end.
*/
describe("a provider rate limit pauses every card actually running on that provider", () => {
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "queued", name: "Queued", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "checking", name: "Checking", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };

  const card = (id: string, column: string) => ({
    id, column, dependencies: [], steps: [], currentStep: 0, log: [],
    modelProvider: "openai-codex", modelId: "gpt-5",
  });

  function resolvingStore(tasks: any[], ir: unknown) {
    const store = createMockStore(tasks);
    const selection = { workflowId: "wf-renamed", stepIds: [] };
    store.getTaskWorkflowSelection = () => (ir ? selection : undefined);
    store.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
    store.getWorkflowDefinition = async () => (ir ? { id: "wf-renamed", ir } : undefined);
    return store;
  }

  async function pausedIds(store: any, agentType = "executor", trigger = "FN-TRIGGER"): Promise<string[]> {
    await new UsageLimitPauser(store).onUsageLimitHit(agentType, trigger, "rate_limit_error: Rate limit exceeded", "openai-codex");
    return (store.pauseTask.mock.calls as unknown[][]).map((call) => call[0] as string);
  }

  it("pauses a PEER executing in the renamed WIP column", async () => {
    // Pre-fix: only FN-TRIGGER, via the always-include fallback. FN-PEER kept running on the limited provider.
    const store = resolvingStore(
      [card("FN-TRIGGER", "building"), card("FN-PEER", "building"), card("FN-SHIPPED", "shipped")],
      RENAMED_IR,
    );

    const paused = await pausedIds(store);

    expect(paused).toContain("FN-PEER");
    // The terminal lane is still excluded — by the lane check itself, which is why the `done`/`archived`
    // filter above it did not need converting.
    expect(paused).not.toContain("FN-SHIPPED");
  });

  it("keeps the LEGACY wip id when a resolvable workflow declares no wip column", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-23:55 (PR #2672 review — greptile P1):
    THE FALLBACK IS PER ROLE, not per object, and nothing pinned that until now.

    A workflow that RESOLVES but declares no `wip` column previously suppressed the
    legacy id — because the fallback keyed on whether `activeLanes` existed at all —
    so a card in `in-progress` resolved no providers and kept running on the limited
    one. A missing ROLE is not the same fact as a missing WORKFLOW; only the second
    means "no basis to judge".

    Found by mutation: reverting to the per-object form left all 57 existing tests
    green, so the fix greptile asked for was unproven.
    */
    const NO_WIP_IR = {
      version: "v2", id: "wf-nowip", name: "no wip", nodes: [], edges: [],
      columns: [
        { id: "queued", name: "Queued", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "checking", name: "Checking", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };
    const store = resolvingStore(
      [card("FN-TRIGGER", "in-progress"), card("FN-LEGACY-WIP", "in-progress")],
      NO_WIP_IR,
    );

    const paused = await pausedIds(store);

    expect(paused).toContain("FN-LEGACY-WIP");
  });

  it("pauses a merger-lane peer in the renamed REVIEW column", async () => {
    const store = resolvingStore(
      [card("FN-TRIGGER", "checking"), card("FN-PEER", "checking"), card("FN-WIP", "building")],
      RENAMED_IR,
    );

    const paused = await pausedIds(store, "merger");

    expect(paused).toContain("FN-PEER");
    // A wip card is not on the merger lane, so a merger-provider limit must leave it alone.
    expect(paused).not.toContain("FN-WIP");
  });

  it("does NOT pause a card parked in the renamed planning lane on an executor limit", async () => {
    // The paired negative: "pause everything with that provider" must not pass for "resolve the lane".
    const store = resolvingStore([card("FN-TRIGGER", "building"), card("FN-PARKED", "queued")], RENAMED_IR);

    expect(await pausedIds(store)).not.toContain("FN-PARKED");
  });

  it("keeps the legacy literals when no workflow resolves", async () => {
    const store = resolvingStore([card("FN-TRIGGER", "in-progress"), card("FN-PEER", "in-progress")], undefined);

    expect(await pausedIds(store)).toContain("FN-PEER");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-23:35 (PR #2672 review, greptile P1 + P2):

TWO PROPERTIES MY FIRST VERSION GOT WRONG.

1. THE FALLBACK IS PER ROLE, NOT PER OBJECT. I keyed it on whether `activeLanes` existed at all, so a
   workflow that RESOLVES but declares no wip (or no review) column suppressed the legacy id and resolved no
   providers — reintroducing the exact bug this change fixes, for the partial-vocabulary case. A missing ROLE
   is not the same fact as a missing WORKFLOW; only the second means "no basis".

2. RESOLVE ONLY THE CANDIDATES. Resolving every task before filtering made a rate limit on a 400-card board
   pay 400 resolutions to pause a handful, including terminal and paused cards that can never be affected.
*/
describe("lane resolution degrades per role and costs only what it must", () => {
  /** Declares a wip lane but NO review lane — the partial vocabulary that broke the first version. */
  const NO_REVIEW_IR = {
    version: "v2", id: "wf-partial", name: "partial", nodes: [], edges: [],
    columns: [
      { id: "queued", name: "Queued", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
  };

  const card = (id: string, column: string) => ({
    id, column, dependencies: [], steps: [], currentStep: 0, log: [],
    modelProvider: "openai-codex", modelId: "gpt-5",
  });

  function storeFor(tasks: any[], ir: unknown, workflowId = "wf-partial") {
    const store = createMockStore(tasks);
    const selection = { workflowId, stepIds: [] };
    const reads = { definition: 0 };
    /*
    Records WHICH task ids were asked about, not how many reads happened. A read count is
    concurrency-dependent here — the shared IR cache fills after an await, so same-workflow tasks race and the
    number lands anywhere between 1 and N. Asking "was this task resolved at all?" is exact and race-free,
    which is what a filtering assertion actually needs.
    */
    const asked: string[] = [];
    store.getTaskWorkflowSelectionAsync = async (id: string) => {
      asked.push(id);
      return selection;
    };
    store.getTaskWorkflowSelection = (id: string) => {
      asked.push(id);
      return selection;
    };
    store.getWorkflowDefinition = async () => {
      reads.definition += 1;
      return ir ? { id: workflowId, ir } : undefined;
    };
    (store as any).reads = reads;
    (store as any).asked = asked;
    return store;
  }

  it("keeps the legacy REVIEW id when the workflow declares a wip lane but no review lane", async () => {
    // Pre-fix: `activeLanes` was truthy, `review` undefined, so an `in-review` card resolved no providers and
    // kept running on the rate-limited provider.
    const store = storeFor([card("FN-TRIGGER", "in-review"), card("FN-PEER", "in-review")], NO_REVIEW_IR);

    await new UsageLimitPauser(store).onUsageLimitHit("merger", "FN-TRIGGER", "rate_limit_error: Rate limit exceeded", "openai-codex");

    expect((store.pauseTask.mock.calls as unknown[][]).map((c) => c[0])).toContain("FN-PEER");
  });

  it("does not resolve a workflow for terminal or paused tasks", async () => {
    // Only FN-LIVE is a plausible candidate; the other three can never be affected, so paying a resolution
    // for them is cost with no possible outcome.
    const store = storeFor(
      [
        card("FN-LIVE", "in-progress"),
        card("FN-DONE", "done"),
        card("FN-ARCHIVED", "archived"),
        { ...card("FN-PAUSED", "in-progress"), paused: true },
      ],
      NO_REVIEW_IR,
    );

    await new UsageLimitPauser(store).onUsageLimitHit("executor", "FN-LIVE", "rate_limit_error: Rate limit exceeded", "openai-codex");

    // Exact, not a count: the three tasks that can never be affected are never resolved at all.
    const asked = (store as any).asked as string[];
    expect(asked).toContain("FN-LIVE");
    expect(asked).not.toContain("FN-DONE");
    expect(asked).not.toContain("FN-ARCHIVED");
    expect(asked).not.toContain("FN-PAUSED");
  });
});
