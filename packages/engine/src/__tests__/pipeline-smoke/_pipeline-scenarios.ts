import type { PipelineScenarioResult, PipelineSmokeHarness, PipelineTaskSeed, PipelineWorkflowId } from "./_pipeline-harness.js";
import type { PipelineTerminalState } from "./_pipeline-terminal-state.js";
import { PIPELINE_SCENARIO_DRIVERS } from "./_pipeline-drivers.js";

export type PipelineWorkflowId = "builtin:coding-ideas-v2" | "builtin:coding" | "renamed-clone";

export interface PipelineScenarioContext {
  readonly harness: PipelineSmokeHarness;
  workflowId: PipelineWorkflowId;
  readonly variant?: string;
  task?: PipelineTaskSeed;
  initialIntegrationSha?: string;
  result?: PipelineScenarioResult;
}

export interface PipelineScenarioDriver {
  readonly label: string;
  run(context: PipelineScenarioContext): Promise<void>;
}

export interface PipelineScenario {
  readonly id: `S${number}`;
  readonly title: string;
  readonly workflows: readonly PipelineWorkflowId[];
  readonly expectedTerminal: PipelineTerminalState;
  readonly variants?: readonly string[];
  readonly arrange: PipelineScenarioDriver;
  readonly act: PipelineScenarioDriver;
  readonly recovery?: PipelineScenarioDriver;
  readonly recoveryExpectedTerminal?: PipelineTerminalState;
  readonly invariants: readonly string[];
  readonly codingFloorReason?: string;
}

export const CODING_NON_REGRESSION_FLOOR = [
  "S02", "S04", "S05", "S06", "S08", "S09", "S10", "S12", "S16", "S17",
] as const;

/*
FNXC:PipelineSmoke 2026-08-23-16:58:
FN-182 keeps one closed, executable contract for all nineteen pipeline outcomes. Every arrange,
act, and recovery entry invokes the shared PostgreSQL/local-Git harness; labels are report text,
not a second inert description of behavior.
*/
export const PIPELINE_SCENARIOS: readonly PipelineScenario[] = [
  {
    id: "S01",
    /*
    FNXC:PipelineSmoke 2026-08-24-07:10:
    coding-ideas-v2 is covered here because a review-column workflow exercises merge admission that
    the base graph never reaches: its required pre-merge set includes gates that record no diff
    fingerprint. Topology assertions cannot see that — four separate defects (an unsupported plan
    seam, a self-contradicting planner prompt, a missing workspace session boundary, and an
    unsatisfiable approval evaluation) all passed structural review and were only caught by driving
    a card to `merged-done` here.
    */
    title: "Ideas promotion completes the coding pipeline",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s01Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s01Act,
    invariants: ["manual Ideas intake remains inert until promotion", "approved tree lands on integration"],
    codingFloorReason: "Coding has a merged intake/hold column, so this Ideas-only promotion path has no equivalent.",
  },
  {
    id: "S02",
    title: "Planning-column creation completes the coding pipeline",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s02Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s02Act,
    invariants: ["trait-resolved hold column releases into implementation", "persisted task reaches complete"],
  },
  {
    id: "S03",
    title: "Unpromoted Ideas intake remains inert",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "inert-intake",
    arrange: PIPELINE_SCENARIO_DRIVERS.s03Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s03Act,
    invariants: ["autoTriage false prevents planning", "no work item advances"],
    codingFloorReason: "Coding deliberately merges intake and hold, so it must auto-admit its Planning column.",
  },
  {
    id: "S04",
    title: "Plan review revisions converge",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    variants: ["revise-twice"],
    arrange: PIPELINE_SCENARIO_DRIVERS.s04Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s04Act,
    invariants: ["plan-review rework count is observed", "approved retry continues"],
  },
  {
    id: "S05",
    title: "Code review revisions require a current approval",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    variants: ["revise-twice"],
    arrange: PIPELINE_SCENARIO_DRIVERS.s05Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s05Act,
    invariants: ["no merge before current approve", "landed tree equals reviewed tree"],
  },
  {
    id: "S06",
    title: "In-flight merge is revoked by a code-review revise",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s06Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s06Act,
    invariants: ["revoked attempt leaves integration unchanged", "remediation then approval converges"],
  },
  {
    id: "S07",
    title: "Unactionable review rejection parks then recovers",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "parked",
    arrange: PIPELINE_SCENARIO_DRIVERS.s07Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s07Act,
    recovery: PIPELINE_SCENARIO_DRIVERS.s07Recovery,
    invariants: ["park is readable and operator-actionable", "recovery reaches merge"],
  },
  {
    id: "S08",
    title: "Disabled code review does not block merge",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s08Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s08Act,
    invariants: ["disabled optional group is not treated as missing approval"],
  },
  {
    id: "S09",
    title: "Live executor excludes merge admission",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s09Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s09Act,
    invariants: ["integration ref remains unchanged during executor session", "release permits later merge"],
  },
  {
    id: "S10",
    title: "Merge cleanup preserves a live worktree",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s10Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s10Act,
    invariants: ["active session remains registered", "cleanup refusal is audited"],
  },
  {
    id: "S11",
    title: "Worktree acquisition disruptions recover",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "merged-done",
    variants: ["pool-saturated", "recycled", "absent", "vanished-mid-step"],
    arrange: PIPELINE_SCENARIO_DRIVERS.s11Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s11Act,
    invariants: ["each acquisition variant converges without wedge"],
  },
  {
    id: "S12",
    title: "Capacity return after revision waits then recovers",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s12Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s12Act,
    invariants: ["fixes remain visible while capacity is unavailable", "no failed park"],
  },
  {
    id: "S13",
    title: "Scripted merger resolves a conflict",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s13Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s13Act,
    invariants: ["local conflict is resolved in the disposable clean room"],
  },
  {
    id: "S14",
    title: "Empty branch has explicit no-op outcome",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "no-op-merge",
    arrange: PIPELINE_SCENARIO_DRIVERS.s14Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s14Act,
    invariants: ["integration SHA is unchanged", "empty branch is not reported as ordinary completion"],
  },
  {
    id: "S15",
    title: "Auto-merge off waits for human release",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "manual-hold",
    arrange: PIPELINE_SCENARIO_DRIVERS.s15Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s15Act,
    recovery: PIPELINE_SCENARIO_DRIVERS.s15Recovery,
    invariants: ["automatic path stays in review", "manual release converges"],
  },
  {
    id: "S16",
    title: "Confirmed merge reconciles a stale checklist",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s16Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s16Act,
    invariants: ["no failed finalization park", "finalization is observed exactly once"],
  },
  {
    id: "S17",
    title: "Restart recovery resumes each recorded stage exactly once",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    variants: ["planning", "execution", "review", "merge-in-flight", "post-merge"],
    arrange: PIPELINE_SCENARIO_DRIVERS.s17Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s17Act,
    invariants: ["terminal seams are not replayed"],
  },
  {
    id: "S18",
    title: "Provider error parks then resolves after restoration",
    workflows: ["builtin:coding-ideas-v2"],
    expectedTerminal: "parked",
    arrange: PIPELINE_SCENARIO_DRIVERS.s18Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s18Act,
    recovery: PIPELINE_SCENARIO_DRIVERS.s18Recovery,
    invariants: ["provider failure is readable", "restored scripted provider converges"],
  },
  {
    id: "S19",
    title: "Renamed built-in vocabulary preserves pipeline behavior",
    workflows: ["renamed-clone"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s19Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s19Act,
    invariants: ["no legacy column id appears in persisted trail", "both cloned built-ins converge"],
  },
  /*
  FNXC:PipelineSmoke 2026-08-26-10:11:
  The journal an operator reads is a deliverable, and until now nothing asserted it. Every anomaly
  reported from a live board this week was plainly visible there and invisible to this lane: an abort
  breadcrumb on a card that was never interrupted, a line written twice, and an approval whose own
  text admitted it had verified nothing. Each was the observable trace of a real defect — a lying
  provenance label, a duplicated invocation, a merge approved without checks — and each was dismissed
  as noise until traced. Running on both offered coding built-ins because the defects are not specific
  to one lane.
  */
  {
    id: "S20",
    title: "A completed task leaves a journal with no anomalies",
    workflows: ["builtin:coding-ideas-v2", "builtin:coding"],
    expectedTerminal: "merged-done",
    arrange: PIPELINE_SCENARIO_DRIVERS.s20Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s20Act,
    invariants: [
      "no abort is claimed on an uninterrupted card",
      "no journal line is written twice in a row",
      "no approval records that it verified nothing",
    ],
  },
  {
    id: "S21",
    title: "MRG-058 external disk exhaustion freezes and resumes exact work",
    workflows: ["builtin:coding"],
    expectedTerminal: "blocked",
    arrange: PIPELINE_SCENARIO_DRIVERS.s21Arrange,
    act: PIPELINE_SCENARIO_DRIVERS.s21Act,
    recovery: PIPELINE_SCENARIO_DRIVERS.s21Recovery,
    recoveryExpectedTerminal: "parked",
    invariants: [
      "five commits and completed steps remain retained while blocked",
      "worktree capacity remains leased across repeated observations",
      "Retry resumes the interrupted Testing and Verification node",
    ],
  },
] as const;

export function assertPipelineScenarioTable(scenarios: readonly PipelineScenario[] = PIPELINE_SCENARIOS): void {
  if (scenarios.length !== 21) {
    throw new Error(`Pipeline smoke requires exactly 21 scenarios; received ${scenarios.length}.`);
  }
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  if (ids.size !== scenarios.length || [...ids].some((id, index) => id !== `S${String(index + 1).padStart(2, "0")}`)) {
    throw new Error("Pipeline smoke scenario ids must be the distinct contiguous range S01 through S21.");
  }
  for (const scenario of scenarios) {
    if ((scenario.expectedTerminal === "parked" || scenario.expectedTerminal === "manual-hold") && !scenario.recovery) {
      throw new Error(`${scenario.id} declares ${scenario.expectedTerminal} and must declare a recovery that converges to merged-done.`);
    }
    for (const phase of [scenario.arrange, scenario.act, scenario.recovery]) {
      if (phase && typeof phase.run !== "function") {
        throw new Error(`${scenario.id} has a non-executable scenario driver.`);
      }
    }
  }
  for (const id of CODING_NON_REGRESSION_FLOOR) {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    if (!scenario?.workflows.includes("builtin:coding")) {
      throw new Error(`${id} is in the Coding non-regression floor but does not declare builtin:coding.`);
    }
  }
}
