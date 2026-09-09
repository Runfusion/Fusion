/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:30 (batch-cli-plugins: packages/cli/src/commands/pr.ts 1 → 0):

THE INVARIANT: `fn pr create` accepts a card sitting in ITS OWN review lane.

Gated on the literal `in-review`, the command refused every card on a renamed board and printed an
error naming a column that board does not have — the operator is told to move the task somewhere that
cannot exist. There is no way to satisfy it short of renaming the workflow back.

Two lanes are asserted, not one: `resolveReviewColumns` unions `mergeOrchestration`, `mergeBlocker`
and `humanReview`, and a card parked in a human-review-only lane is still a card you can open a PR
from. Resolving `lifecycle.review` instead would answer with a single id and keep refusing those —
the exact narrowing PR #2728's review caught in the CLI retry gate, which is why this file pins the
SET rather than one id.

REVERT PROOF, measured: restore `if (task.column !== "in-review")` and the two renamed-lane cases
fail with `process.exit:1`, while the default-board and wrong-column cases keep passing — so the
negative cases alone do not pin the fix, and all four are required.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn(),
  closeProjectStore: vi.fn(async () => undefined),
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
}));

vi.mock("@fusion/engine", () => ({ releaseHeldTaskByEvent: vi.fn() }));

const createPr = vi.fn();
vi.mock("@fusion/dashboard", () => ({
  GitHubClient: class {
    createPr(...args: unknown[]) {
      return createPr(...args);
    }
  },
  generatePrMetadata: vi.fn(),
}));

vi.mock("@fusion/core/gh-cli", () => ({
  classifyGhError: vi.fn(() => ({ message: "err" })),
  getGhErrorMessage: vi.fn(() => "err"),
  getCurrentRepo: vi.fn(() => ({ owner: "owner", repo: "repo" })),
  isGhAuthenticated: vi.fn(() => true),
  isGhAvailable: vi.fn(() => true),
}));

const { resolveProject } = await import("../project-context.js");
const { runPrCreate } = await import("../commands/pr.js");

/** A board with TWO review lanes and no id shared with the default lineage. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "waiting-on-a-human", name: "Waiting on a human", traits: [{ trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function mockBoard(column: string, ir: unknown) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const store = {
    getTask: vi.fn().mockResolvedValue({
      id: "FN-001",
      title: "Task one",
      description: "do a thing",
      column,
      branch: "fusion/fn-001",
      prInfo: undefined,
    }),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
    updatePrInfo: vi.fn(),
    ensurePrEntityForSource: vi.fn().mockReturnValue({ id: "PR-NEW" }),
    updatePrEntity: vi.fn().mockReturnValue({ id: "PR-NEW" }),
    logEntry: vi.fn(),
    close: vi.fn(),
  };
  vi.mocked(resolveProject).mockResolvedValue({
    store: store as never,
    projectPath: "/tmp/project",
    projectName: "proj",
  } as never);
  return store;
}

describe("fn pr create resolves the board's own review lane", () => {
  const originalExit = process.exit;
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    errors = [];
    delete process.env.GITHUB_REPOSITORY;
    createPr.mockResolvedValue({
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      status: "open",
      title: "T",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
    });
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it("accepts a card in a RENAMED merge lane", async () => {
    // Pre-fix: `signoff` !== "in-review" → refused with exit 1.
    const store = mockBoard("signoff", RENAMED_IR);

    await runPrCreate("FN-001", { ai: false });

    expect(store.updatePrInfo).toHaveBeenCalledTimes(1);
  });

  it("accepts a card in a human-review-only lane (the union, not a single id)", async () => {
    // Resolving `lifecycle.review` alone would answer `signoff` and refuse this card.
    const store = mockBoard("waiting-on-a-human", RENAMED_IR);

    await runPrCreate("FN-001", { ai: false });

    expect(store.updatePrInfo).toHaveBeenCalledTimes(1);
  });

  it("still refuses a card that is in no review lane, naming the resolved lanes", async () => {
    // The gate must still be a gate — and the message must not name a column this board lacks.
    const store = mockBoard("building", RENAMED_IR);

    await expect(runPrCreate("FN-001", { ai: false })).rejects.toThrow("process.exit:1");

    expect(store.updatePrInfo).not.toHaveBeenCalled();
    const refusal = errors.find((e) => e.includes("must be in"));
    expect(refusal).toContain("'signoff'");
    expect(refusal).toContain("'waiting-on-a-human'");
    expect(refusal).not.toContain("in-review");
  });

  it("takes the legacy fallback when the resolved workflow declares no review lane", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-03:10:
    THIS TEST ASSERTED A DECISION THAT WAS SUPERSEDED BEFORE #2775 LANDED, and it went red on main
    the moment it did.

    Two review rounds on #2775 pushed `pr.ts` in opposite directions and the SECOND one won:

      round 1 (greptile P2)  — a resolved workflow with no review-trait column is an ANSWER; do not
                               invent `'in-review'`, say "no review lane". That is what this test
                               was written against.
      round 2 (greptile)     — refusing on an empty set rejects EVERY v1 workflow, because
                               `synthesizeDefaultColumns` upgrades a v1 graph by emitting every
                               column with `traits: []`. So a v1 board whose `in-review` column
                               plainly exists resolves to an empty review set.

    Round 2 is decisive and is what shipped: an empty set is indistinguishable from a v1 upgrade, so
    it means UNEXPRESSED rather than absent and takes the same legacy fallback as an unreadable
    workflow. `pr.ts:206-207` implements exactly that. The round-1 assertion could not pass against
    it — there is no "no review lane" message in the shipped code at all, so `errors.find(...)`
    returned undefined.

      round 3 (greptile, #2801) — round 2 over-corrected. Falling back for EVERY empty set means a
                               native v2 board that expresses traits and declares no review lane is
                               told to move its card to `'in-review'` — a column it does not have.
                               An impossible instruction is the defect this conversion set out to
                               remove, reappearing inside its own fallback.

    Round 2's note claimed the distinction was "NOT recoverable ... which the IR does not currently
    carry". That was wrong, and this test asserted the wrong contract because of it: the IR DOES carry
    it. A v1 upgrade emits every column with `traits: []`, so NO column expresses any trait; a native
    v2 board that declares traits elsewhere expresses some. `workflowExpressesAnyTrait` in `pr.ts`
    separates them, and the three states now get three answers — legacy fallback for unresolvable and
    for v1, an explicit refusal naming no lane for a v2 board with no review column.
    */
    const noReviewIr = {
      ...RENAMED_IR,
      columns: RENAMED_IR.columns.filter((c) => c.id !== "signoff" && c.id !== "waiting-on-a-human"),
    };
    const store = mockBoard("building", noReviewIr);

    await expect(runPrCreate("FN-001", { ai: false })).rejects.toThrow("process.exit:1");

    expect(store.updatePrInfo).not.toHaveBeenCalled();
    /*
    A v2 board that expresses traits and has no review lane is told exactly that — not sent to a
    column it does not declare. Asserting the ABSENCE of `'in-review'` is the point of the case.
    */
    const refusal = errors.find((e) => e.includes("no review column"));
    expect(refusal).toBeDefined();
    expect(refusal).not.toContain("'in-review'");
    expect(refusal).not.toContain("signoff");
  });

  it("keeps the legacy fallback for a V1-UPGRADED board, whose columns express no traits at all", async () => {
    /*
    The other side of round 3, and the reason the predicate is trait-EXPRESSION rather than
    review-set-emptiness: both boards resolve an empty review set, and only one of them should refuse.
    `synthesizeDefaultColumns` emits every default column with `traits: []`, so `in-review` plainly
    exists and holds this board's cards.
    */
    const v1Ir = {
      ...RENAMED_IR,
      columns: ["todo", "in-progress", "in-review", "done"].map((id) => ({ id, name: id, traits: [] })),
    };
    const store = mockBoard("in-review", v1Ir);

    await runPrCreate("FN-001", { ai: false });

    expect(store.updatePrInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy literal when the workflow cannot be resolved", async () => {
    // The unresolvable-board fallback: today's behaviour, not "refuse everything".
    const store = mockBoard("in-review", undefined);

    await runPrCreate("FN-001", { ai: false });

    expect(store.updatePrInfo).toHaveBeenCalledTimes(1);
  });
});
