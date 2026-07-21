import { describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in traits the column boundary resolves against
import type {
  Settings,
  Task,
  TaskDetail,
  TaskStep,
  WorkflowIr,
  WorkflowIrNode,
  WorkflowStepResult,
} from "@fusion/core";
import {
  BUILTIN_WORKFLOWS,
  columnHasFlag,
  parseWorkflowIr,
  resolveCompleteColumn,
  resolveCreationColumn,
  serializeWorkflowIr,
} from "@fusion/core";

import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import {
  createWorkflowColumnBoundary,
  type WorkflowColumnBoundary,
} from "../workflow-column-boundary.js";
import { isUnplannedForExecution } from "../hold-release.js";
import type { WorkflowNodeHandler } from "../workflow-graph-executor.js";
import type { WorkflowRuntimePrimitives } from "../runtime-primitives.js";

/*
FNXC:WorkflowBuiltins 2026-07-19-11:30:
Lifecycle acceptance for EVERY built-in workflow under the IR-driven runtime.

The U11 benchmark proves ONE operator-authored graph walks its own columns. This
file proves the same contract for the graphs we ship, because the cutover made a
node's `column` the card's real lifecycle position: a built-in that mis-columns a
node no longer merely looks wrong on the board, it moves the card. That is not
hypothetical — this suite found `builtin:review-heavy` bouncing a card
in-review -> todo -> in-review at its `security` gate and `builtin:design` doing
in-progress -> todo at `design-review`, both because unseamed linear-spec nodes
defaulted to the capacity-hold column (fixed in builtin-workflows.ts).

Per built-in it asserts:
 (1) the IR parses under U2's hardened rules and every node names a declared
     column; the creation column resolves; a merge-blocker column has a
     reachable merge-class node (parse enforces, we assert the shape);
 (2) a lifecycle smoke drives a card through the workflow's OWN column trail —
     ordered, contiguous, never a column the workflow does not declare, and the
     hold->wip seam crossed only by the scheduler (KTD-2);
 (3) failure parks the card IN PLACE (KTD-1);
 (4) review gates record graph-authored, lease-stamped step results.

The harness is modeled on benchmark-six-column-workflow.test.ts: injected
primitives, a real `createWorkflowColumnBoundary`, and a wrapper that plays the
scheduler when the boundary refuses a hold->wip move.
*/

const PROMPT = `# Task: FN-BUILTIN Built-in lifecycle smoke

## Steps

### Step 1: Drive the card through every column by workflow alone
- one step keeps the foreach trail short and deterministic
`;

const SETTINGS = { experimentalFeatures: {} } as Pick<Settings, "experimentalFeatures">;

/** Every optional-group node id in an IR — the "all gates on" enablement list. */
function optionalGroupIds(ir: WorkflowIr): string[] {
  return ir.nodes.filter((n) => n.kind === "optional-group").map((n) => n.id);
}

/** The brainstorming exit-gate only routes to `plan` once the user's answer
 *  contains this phrase, so the harness has to actually "say" it. */
const BRAINSTORM_APPROVAL = "looks good";

interface TransitionRecord {
  from: string;
  to: string;
  nodeId: string;
  by: "graph" | "scheduler";
}

interface DriveOptions {
  /** Force a node to fail, to exercise the park-in-place contract. */
  failNodeId?: string;
  /** Seed `ask-user` answers, keyed by node id (published as `input:<nodeId>`). */
  askUserAnswers?: Record<string, string>;
}

interface DriveResult {
  ir: WorkflowIr;
  task: TaskDetail;
  transitions: TransitionRecord[];
  stepResults: WorkflowStepResult[];
  leaseOwners: Array<string | undefined>;
  disposition: string;
  outcome: string;
  visitedNodeIds: string[];
  finalColumn: string;
}

/**
 * Drive one built-in workflow end to end with everything stubbed to succeed.
 *
 * The store reports the built-in id as the task's selection, so IR resolution
 * runs through the real catalog path rather than a hand-fed IR — a built-in that
 * the resolver cannot load fails here rather than silently using a test fixture.
 */
async function drive(workflowId: string, ir: WorkflowIr, options: DriveOptions = {}): Promise<DriveResult> {
  const entryColumn = resolveCreationColumn(ir)!.id;
  const task = {
    id: "FN-BUILTIN",
    title: "Built-in lifecycle smoke",
    description: "Drive a card through a built-in workflow's own columns.",
    column: entryColumn,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: PROMPT,
    workflowStepResults: [],
    /* Every optional group ON. An ABSENT list lets each group's `defaultOn`
       decide, but it also leaves `enabledWorkflowSteps` unset — and the
       pre-release Plan Review gate (isPlanReviewPreReleaseGateUnpassed) only
       arms when the list explicitly names `plan-review`. Naming every group
       arms the gate without silently disabling anything. */
    enabledWorkflowSteps: optionalGroupIds(ir),
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  } as unknown as TaskDetail;

  const transitions: TransitionRecord[] = [];
  const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];
  const stepResults: WorkflowStepResult[] = [];
  const leaseOwners: Array<string | undefined> = [];

  const makeBoundary = (initialColumn: string) =>
    createWorkflowColumnBoundary({
      taskId: task.id,
      workflowId,
      ir,
      initialColumn,
      moveTask: async (toColumn) => {
        task.column = toColumn;
      },
      emitAudit: (event) => {
        if (event.type === "task:column-transition") {
          transitions.push({ from: event.fromColumn, to: event.toColumn, nodeId: event.nodeId, by: "graph" });
        }
      },
      onWarn: (message, detail) => warnings.push({ message, detail }),
    });

  /* The node the card most recently ENTERED. Tracked here so `failNodeId` can
     fail a seam node too — seam nodes run through `primitives`, which receive no
     node argument. */
  let currentNodeId: string | undefined;
  let inner = makeBoundary(entryColumn);
  const parkCount = () => warnings.filter((w) => w.message.includes("hold→wip")).length;

  /* The scheduler stand-in: the graph refuses the hold→wip boundary (KTD-2), so
     the release sweep is the only actor allowed to cross it — and only once the
     pre-release plan-review gate clears. */
  const boundary: WorkflowColumnBoundary = {
    currentColumn: () => inner.currentColumn(),
    detectDrift: () => inner.detectDrift(),
    onNodeEntry: async (node) => {
      currentNodeId = node.id;
      const before = parkCount();
      await inner.onNodeEntry(node);
      if (parkCount() === before) return;
      const park = warnings[warnings.length - 1]!;
      const from = String(park.detail.fromColumn);
      const to = String(park.detail.toColumn);
      const nodeId = String(park.detail.nodeId);
      if (await isUnplannedForExecution({} as never, task as unknown as Task, ir)) return;
      transitions.push({ from, to, nodeId, by: "scheduler" });
      task.column = to;
      inner = makeBoundary(to);
      await inner.onNodeEntry(node);
    },
  };

  const fail = (node?: WorkflowIrNode) =>
    options.failNodeId !== undefined && (node?.id ?? currentNodeId) === options.failNodeId;
  const failed = { outcome: "failure" as const, value: "forced" };

  const primitives: WorkflowRuntimePrimitives = {
    prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/memory/worktree" } }),
    readArtifact: async (_ctx, _t, key) => (key === "PROMPT.md" ? PROMPT : undefined),
    writeArtifact: async (_ctx, _t, key) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async () => (fail() ? failed : { outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } }),
    runCodingSession: async () => (fail() ? failed : { outcome: "success", data: { taskDone: true, modifiedFiles: ["src/a.ts"] } }),
    runTaskStep: async () => (fail() ? failed : { outcome: "success", baselineSha: "baseline", checkpointId: "checkpoint" }),
    resetTaskStep: async () => ({ ok: true }),
    runReview: async () => (fail() ? failed : { outcome: "success", data: { verdict: "APPROVE" } }),
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    updateSteps: async (_ctx, target, steps: TaskStep[]) => {
      if (fail()) return failed;
      target.steps = steps;
      return { outcome: "success", data: { count: steps.length } };
    },
    transitionTask: async () => ({ outcome: "success" }),
    requestMerge: async () => (fail() ? failed : { outcome: "success", value: "merged", data: { status: "merged" } }),
    abortRun: async () => ({ outcome: "success" }),
    audit: () => undefined,
  };

  /* PR nodes fail closed without GitHub wiring by design, and `ask-user` parks
     on the executor's await-input path. Both are replaced here so the smoke
     measures the workflow's COLUMN behavior rather than absent infrastructure. */
  /* Each pr-* node routes on a LABELLED outcome (`outcome:open`, `outcome:fixed`,
     `outcome:merged-requested`); an unlabelled value matches no edge and would
     end the walk early with a misleading "completed". */
  const PR_OUTCOMES: Record<string, string> = {
    "pr-create": "open",
    "pr-respond": "fixed",
    "pr-merge": "merged-requested",
  };
  const prSuccess: WorkflowNodeHandler = async (node) =>
    fail(node) ? failed : { outcome: "success", value: PR_OUTCOMES[node.id] ?? "open" };
  const askUser: WorkflowNodeHandler = async (node, ctx) => {
    const answer = options.askUserAnswers?.[node.id];
    if (answer !== undefined) ctx.context[`input:${node.id}`] = answer;
    return fail(node) ? failed : { outcome: "success" };
  };

  const runtime = new WorkflowTaskRuntime({
    store: {
      getTaskWorkflowSelection: () => ({ workflowId, stepIds: [] }),
      getWorkflowDefinition: async () => undefined,
      getTaskDocument: async (_taskId, key) => (key === "PROMPT.md" ? { key, content: PROMPT } : null),
    },
    primitives,
    columnBoundary: boundary,
    handlers: {
      "pr-create": prSuccess,
      "pr-respond": prSuccess,
      "pr-merge": prSuccess,
      "ask-user": askUser,
    },
    recordWorkflowStepResult: (_taskId: string, result: WorkflowStepResult) => {
      stepResults.push(result);
      if (result.status === "pending") leaseOwners.push(result.leaseOwner);
      const existing = (task.workflowStepResults ?? []) as WorkflowStepResult[];
      const at = existing.findIndex((r) => r.workflowStepId === result.workflowStepId);
      if (at >= 0) existing[at] = result;
      else existing.push(result);
      (task as { workflowStepResults?: WorkflowStepResult[] }).workflowStepResults = existing;
    },
    runCustomNode: async (node) => (fail(node) ? failed : { outcome: "success" }),
    parseStepsDeps: {
      readArtifact: async (_target, key) => (key === "PROMPT.md" ? PROMPT : undefined),
      writeSteps: async (target, steps) => {
        target.steps = steps;
      },
    },
  });

  const result = await runtime.run(task, SETTINGS);
  return {
    ir,
    task,
    transitions,
    stepResults,
    leaseOwners,
    disposition: result.disposition,
    outcome: result.outcome,
    visitedNodeIds: result.visitedNodeIds,
    finalColumn: task.column,
  };
}

/*
Per-built-in expectations. The trail is PINNED rather than derived so a silent
re-columning shows up as a diff a human reads, not as a tautology. `by` records
which actor crossed each boundary, so the KTD-2 single-mover rule is visible.
*/
interface BuiltinExpectation {
  id: string;
  entryColumn: string;
  trail: Array<[from: string, to: string, by: "graph" | "scheduler"]>;
  /** Column the card rests in when the run completes. */
  finalColumn: string;
  /** Review-gate node ids expected to record a lease-stamped pending result. */
  leasedGates: string[];
  /* A workflow whose happy path ENDS on a park (a `hold` node awaiting an
     external release) does not "complete" — it stops, in place, waiting. */
  parksAt?: string;
  driveOptions?: DriveOptions;
}

const EXPECTATIONS: BuiltinExpectation[] = [
  {
    id: "builtin:coding",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    /* Plan-in-place: the only built-in whose planning nodes live in the HOLD
       column. It must plan AND review in `todo` and then be released by the
       scheduler — the bootstrap-stub deadlock shows up here as a card that
       never leaves `todo`. */
    id: "builtin:coding-ideas",
    entryColumn: "ideas",
    trail: [
      ["ideas", "todo", "graph"],
      ["todo", "in-progress", "scheduler"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    id: "builtin:legacy-coding",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    id: "builtin:stepwise-coding",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    id: "builtin:quick-fix",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: [],
  },
  {
    /* The `security` gate carries no seam. Before the linear column-defaulting
       fix it inherited `todo` and dragged the card in-review -> todo -> in-review. */
    id: "builtin:review-heavy",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    /* Same defect at `design-review`: in-progress -> todo mid-implementation. */
    id: "builtin:design",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    /* Plan-in-place via the linear helper: `plan` follows intake, so it lands in
       the hold column and the scheduler owns the release. */
    id: "builtin:compound-engineering",
    entryColumn: "triage",
    trail: [
      ["triage", "todo", "graph"],
      ["todo", "in-progress", "scheduler"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
  },
  {
    /* Fully non-default column ids — the strongest evidence that nothing in the
       runtime still reaches for the literal `in-progress`/`in-review`/`done`. */
    id: "builtin:marketing",
    entryColumn: "ideation",
    trail: [
      ["ideation", "drafting", "graph"],
      ["drafting", "editorial-review", "graph"],
      ["editorial-review", "published", "graph"],
    ],
    finalColumn: "published",
    leasedGates: [],
  },
  {
    /* No merge region and no hold column: a pure linear walk across five
       columns, which must complete with zero merge-blocker interference. */
    id: "builtin:lead-generation",
    entryColumn: "triage",
    trail: [
      ["triage", "sourcing", "graph"],
      ["sourcing", "qualification", "graph"],
      ["qualification", "enrichment", "graph"],
      ["enrichment", "outreach", "graph"],
    ],
    finalColumn: "outreach",
    leasedGates: [],
  },
  {
    /* PR lifecycle: no capacity-hold column at all; the await-review holds are
       external-event parks, so the card rests in `await-review`. */
    id: "builtin:pr-workflow",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "await-review", "graph"],
    ],
    finalColumn: "await-review",
    leasedGates: [],
    parksAt: "await-review",
  },
  {
    /* The brainstorm loop only exits once the user's answer carries the approval
       phrase; after that it is the stepwise-final-review pipeline. */
    id: "builtin:brainstorming",
    entryColumn: "triage",
    trail: [
      ["triage", "in-progress", "graph"],
      ["in-progress", "in-review", "graph"],
      ["in-review", "done", "graph"],
    ],
    finalColumn: "done",
    leasedGates: ["plan-review", "code-review"],
    driveOptions: { askUserAnswers: { "brainstorm-ask": `Looks good — ${BRAINSTORM_APPROVAL}.` } },
  },
];

function builtinIr(id: string): WorkflowIr {
  const entry = BUILTIN_WORKFLOWS.find((wf) => wf.id === id);
  if (!entry) throw new Error(`built-in workflow '${id}' is missing from the catalog`);
  return parseWorkflowIr(entry.ir as never);
}

/** Every catalog id must be covered — a new built-in cannot ship untested. */
it("covers every built-in workflow in the catalog", () => {
  expect(EXPECTATIONS.map((e) => e.id).sort()).toEqual(BUILTIN_WORKFLOWS.map((wf) => wf.id).sort());
});

describe("built-in workflow IR validation (U2)", () => {
  for (const wf of BUILTIN_WORKFLOWS) {
    describe(wf.id, () => {
      it("parses under the hardened rules and round-trips", () => {
        const ir = parseWorkflowIr(wf.ir as never);
        // Re-parsing the serialization is the save-time path a workflow takes on
        // its way into the store; a rule that only holds for the in-memory
        // literal would pass a naive `not.toThrow()` and fail on save.
        expect(() => parseWorkflowIr(serializeWorkflowIr(ir))).not.toThrow();
      });

      it("declares a column for every node, and only declared columns", () => {
        const ir = builtinIr(wf.id);
        const declared = new Set(ir.version === "v2" ? ir.columns.map((c) => c.id) : []);
        expect(declared.size).toBeGreaterThan(0);
        for (const node of ir.nodes) {
          expect(node.column, `node '${node.id}' has no column`).toBeDefined();
          expect(declared, `node '${node.id}' names undeclared column '${node.column}'`).toContain(node.column);
        }
      });

      it("resolves a creation column and a complete column", () => {
        const ir = builtinIr(wf.id);
        const creation = resolveCreationColumn(ir);
        expect(creation).toBeDefined();
        // R11: cards land on the intake column, which must not also be terminal.
        expect(columnHasFlag(ir, creation!.id, "complete")).toBe(false);
        expect(resolveCompleteColumn(ir)).toBeDefined();
      });

      it("backs any merge-blocker column with a reachable merge-class node", () => {
        const ir = builtinIr(wf.id);
        const columns = ir.version === "v2" ? ir.columns : [];
        const blocker = columns.find((c) => columnHasFlag(ir, c.id, "mergeBlocker"));
        if (!blocker) return; // a no-merge workflow is a legal shape (R7b).
        const mergeKinds = new Set([
          "merge-gate",
          "merge-attempt",
          "manual-merge-hold",
          "retry-backoff",
          "recovery-router",
          "branch-group-member-integration",
          "branch-group-promotion",
          "pr-merge",
        ]);
        const hasMerge = ir.nodes.some((n) => mergeKinds.has(n.kind) || n.config?.seam === "merge");
        expect(hasMerge, `'${wf.id}' declares merge-blocker '${blocker.id}' with no merge-class node`).toBe(true);
      });
    });
  }
});

describe("built-in workflow lifecycle smoke", () => {
  for (const spec of EXPECTATIONS) {
    describe(spec.id, () => {
      it("walks its own ordered column trail with no skipped or foreign columns", async () => {
        const ir = builtinIr(spec.id);
        expect(resolveCreationColumn(ir)!.id).toBe(spec.entryColumn);

        const run = await drive(spec.id, ir, spec.driveOptions);
        const trace = `run reason: ${run.visitedNodeIds.join(" -> ")}`;
        if (spec.parksAt) {
          // The run stops ON the hold node — it is the last node entered, and no
          // release edge was traversed by the run that parked.
          expect(run.visitedNodeIds[run.visitedNodeIds.length - 1], trace).toBe(spec.parksAt);
        } else {
          expect(run.disposition, trace).toBe("completed");
        }
        expect(run.transitions.map((t) => [t.from, t.to, t.by])).toEqual(spec.trail);
        expect(run.finalColumn).toBe(spec.finalColumn);

        // Contiguity: each hop starts where the last one ended, beginning at the
        // creation column. A skipped column shows up as a gap here even if the
        // pinned trail above were updated carelessly.
        let cursor = spec.entryColumn;
        for (const t of run.transitions) {
          expect(t.from).toBe(cursor);
          cursor = t.to;
        }

        // R1/R2: no destination outside the workflow's own declared columns.
        const declared = new Set(ir.version === "v2" ? ir.columns.map((c) => c.id) : []);
        for (const t of run.transitions) expect(declared).toContain(t.to);
      });

      it("leaves the hold→wip seam to the scheduler alone (KTD-2)", async () => {
        const ir = builtinIr(spec.id);
        const run = await drive(spec.id, ir, spec.driveOptions);
        const holdColumns = new Set(
          (ir.version === "v2" ? ir.columns : []).filter((c) => columnHasFlag(ir, c.id, "hold")).map((c) => c.id),
        );
        for (const t of run.transitions) {
          // A move OUT of a hold column into a wip column is the scheduler's
          // exclusive seam; the graph must never author it.
          if (holdColumns.has(t.from) && columnHasFlag(ir, t.to, "countsTowardWip")) {
            expect(t.by, `graph crossed the hold→wip seam ${t.from}→${t.to}`).toBe("scheduler");
          }
        }
        expect(run.transitions.filter((t) => t.by === "scheduler")).toHaveLength(
          spec.trail.filter(([, , by]) => by === "scheduler").length,
        );
      });

      it("records lease-stamped, graph-authored results for its review gates", async () => {
        if (spec.leasedGates.length === 0) return;
        const run = await drive(spec.id, ir_(spec.id), spec.driveOptions);
        for (const gate of spec.leasedGates) {
          const forGate = run.stepResults.filter((r) => r.workflowStepId === gate);
          expect(forGate.map((r) => r.status), `gate '${gate}'`).toEqual(["pending", "passed"]);
          // KTD-4: the pending record IS the lease — it must name its owner, and
          // the terminal record must NOT (a lease only exists while pending).
          expect(forGate[0]!.leaseOwner, `gate '${gate}' pending result carries no lease owner`).toBeTruthy();
          expect(forGate[1]!.leaseOwner).toBeUndefined();
        }
      });
    });
  }
});

/** Small indirection so the lease test reads the same as the others. */
function ir_(id: string): WorkflowIr {
  return builtinIr(id);
}

describe("failure parks the card in place (KTD-1)", () => {
  /*
  A failed node must NOT move the card. The boundary crosses on node ENTRY, so
  the card rests in the column of the node that failed — never in a downstream
  column it never reached, and never back in a hold column.
  */
  const cases: Array<{ id: string; failNodeId: string; expectedColumn: string }> = [
    { id: "builtin:coding", failNodeId: "plan", expectedColumn: "in-progress" },
    { id: "builtin:coding-ideas", failNodeId: "plan", expectedColumn: "todo" },
    { id: "builtin:marketing", failNodeId: "draft", expectedColumn: "drafting" },
    { id: "builtin:lead-generation", failNodeId: "enrich-lead", expectedColumn: "enrichment" },
    { id: "builtin:pr-workflow", failNodeId: "pr-create", expectedColumn: "in-progress" },
  ];

  for (const c of cases) {
    it(`${c.id}: a failed '${c.failNodeId}' parks in '${c.expectedColumn}'`, async () => {
      const ir = builtinIr(c.id);
      const run = await drive(c.id, ir, { failNodeId: c.failNodeId });
      expect(run.finalColumn).toBe(c.expectedColumn);
      // The card entered the failing node's column and stopped there — nothing
      // downstream of the failure was entered.
      const last = run.transitions[run.transitions.length - 1];
      expect(last?.to ?? resolveCreationColumn(ir)!.id).toBe(c.expectedColumn);
    });
  }
});

describe("no-merge-region built-ins complete without merge-blocker interference (R7b)", () => {
  /*
  `builtin:lead-generation` declares no merge-blocker column and no merge-class
  node. It must therefore walk to the end of its graph with the merge machinery
  entirely absent — no merge column synthesized, no merge seam invoked, and no
  merge-blocker gate to clear.
  */
  it("lead-generation walks five columns with no merge column and no merge node", async () => {
    const ir = builtinIr("builtin:lead-generation");
    const columns = ir.version === "v2" ? ir.columns : [];
    expect(columns.some((c) => columnHasFlag(ir, c.id, "mergeBlocker"))).toBe(false);
    expect(ir.nodes.some((n) => n.config?.seam === "merge")).toBe(false);

    const run = await drive("builtin:lead-generation", ir);
    expect(run.disposition).toBe("completed");
    expect(run.outcome).toBe("success");
    expect(run.visitedNodeIds).not.toContain("merge");
    expect(run.transitions.map((t) => t.to)).toEqual(["sourcing", "qualification", "enrichment", "outreach"]);
  });

  /*
  FNXC:WorkflowBuiltins 2026-07-19-12:55:
  `end` is a graph terminal, not a column destination (workflow-graph-executor.ts,
  KTD-1), so a card only reaches the `complete` column when a REAL node lives
  there. Every merge-bearing built-in has one (`post-merge-verification` in
  `done`/`published`); `builtin:lead-generation` has none, which is why the GRAPH
  run below correctly stops in `outreach`. The card is filed into `converted` one
  layer up, by the executor's trait-keyed no-merge completion mover — see
  no-merge-workflow-completion.test.ts. This assertion pins the IR shape that
  makes that mover necessary, so putting a node in `converted` (which would make
  the graph land the card itself) cannot happen unnoticed.
  */
  it("lead-generation's complete column holds no node but `end`", () => {
    const ir = builtinIr("builtin:lead-generation");
    const complete = resolveCompleteColumn(ir)!;
    const inComplete = ir.nodes.filter((n) => n.column === complete);
    expect(inComplete.map((n) => n.kind)).toEqual(["end"]);
  });

  it("marketing keeps its merge inside its own review column, never `in-review`", async () => {
    const ir = builtinIr("builtin:marketing");
    const run = await drive("builtin:marketing", ir);
    expect(run.disposition).toBe("completed");
    expect(run.transitions.map((t) => t.to)).not.toContain("in-review");
    expect(run.visitedNodeIds).toContain("merge");
    // The merge resolved to the column the card was already in (editorial-review).
    expect(run.transitions.filter((t) => t.to === "editorial-review")).toHaveLength(1);
  });
});

describe("plan-in-place built-ins plan and review inside the hold column", () => {
  /*
  `builtin:coding-ideas` is the plan-in-place shape: `plan` and `plan-review` sit
  in `todo` (the capacity-hold column), not in the wip column. The deadlock this
  guards is a card that plans in `todo` but is never released because the
  pre-release plan-review gate cannot see a passed result.
  */
  it("coding-ideas plans and reviews in `todo`, then the scheduler releases it", async () => {
    const ir = builtinIr("builtin:coding-ideas");
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    expect(byId.get("plan")?.column).toBe("todo");
    expect(byId.get("plan-review")?.column).toBe("todo");
    expect(byId.get("start")?.column).toBe("ideas");

    // Negative control: with no passed plan-review, the release gate holds.
    const unplanned = { id: "FN-HOLD", column: "todo", workflowStepResults: [], enabledWorkflowSteps: optionalGroupIds(ir) } as unknown as Task;
    await expect(isUnplannedForExecution({} as never, unplanned, ir)).resolves.toBe(true);

    const run = await drive("builtin:coding-ideas", ir);
    expect(run.disposition).toBe("completed");
    // Exactly one scheduler release, out of `todo`, and it happened AFTER the
    // plan-review passed (otherwise the harness's gate check would have held it).
    const scheduled = run.transitions.filter((t) => t.by === "scheduler");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.from).toBe("todo");
    expect(
      run.stepResults.some((r) => r.workflowStepId === "plan-review" && r.status === "passed"),
    ).toBe(true);
    expect(run.finalColumn).toBe("done");
  });
});
