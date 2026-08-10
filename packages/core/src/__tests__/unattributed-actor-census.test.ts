/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 — the unattributed-marker ratchet):

U18 made the mutation-context parameter required across the mutating store surface. Most converted
call sites had no authenticated actor to supply, because the units that produce one have not landed:
HTTP routes get theirs in U9, the CLI in U11, and engine sweeps/schedulers/self-healing in U13. Those
sites pass `UNATTRIBUTED_MUTATION_CONTEXT`, which is honest but is still debt.

Debt that is only honest is still invisible. Without this test the marker would spread — every new
mutation added between now and U13 would reach for it, because it is the path of least resistance and
it compiles. This test converts it into an ENFORCED, SHRINKING obligation: the count may fall, and it
may never rise. It must reach ZERO as U9/U11/U13 land; a unit that lands without lowering it has not
actually wired its surface.

If this test fails because the count GREW: do not raise the baseline. Derive a real actor instead —
`mutationContextForAgent` exists for the case where an agent id is already in scope, and any surface
with an authenticated session or an inbound run context should carry that through rather than mint a
marker. Raising the baseline is how a ratchet becomes a rubber stamp.

If it fails because the count SHRANK: lower `BASELINE` in the same commit that removed the usages.
That is the intended direction and the assertion says so explicitly.

Scope note: only `@fusion/core` production source is counted. `identity/mutation-context.ts` defines
the marker, `identity/actor.ts` documents it, the two index barrels re-export it, and the test-utils
fixture references it in prose — none of those are call sites, so all five are excluded. `__tests__`
is excluded because a test asserting the unattributed path is coverage, not debt.
*/

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_SRC = join(fileURLToPath(new URL("../", import.meta.url)));
const ENGINE_SRC = join(fileURLToPath(new URL("../../../engine/src/", import.meta.url)));

/*
FNXC:Identity 2026-08-09-03:04 (U18 step 2 — the census roots are per-PACKAGE, not per-file):
The ratchet scans every package U18 converts, not just the one that owns the marker. A root-per-
package census is the whole mechanism: if `@fusion/engine` were left unscanned it could accumulate
markers freely while this test reported core's 33 and stayed green, which is precisely the
"resolved seam nobody wired" failure the marker exists to prevent.

Rows are keyed `"<package>/<path>"` so a distribution dump names its package, and each root carries
its own baseline so a regression points at the package that caused it rather than at a single number
nobody can attribute.

Add a root here the moment a package starts converting. `@fusion/dashboard` and `@runfusion/fusion`
are U18's step 3; they are deliberately absent until then, because a root asserting a baseline of 0
over an unconverted package is a claim the package has no debt rather than a claim it has not
started.
*/
const CENSUS_ROOTS: readonly { pkg: string; dir: string }[] = [
  { pkg: "core", dir: CORE_SRC },
  { pkg: "engine", dir: ENGINE_SRC },
];

const MARKER = "UNATTRIBUTED_MUTATION_CONTEXT";

/** Files that mention the marker without being call sites, keyed `"<package>/<path>"`. */
const EXCLUDED_FILES = new Set([
  "core/identity/mutation-context.ts",
  "core/identity/actor.ts",
  "core/index.ts",
  "core/index.gate.ts",
  "core/__test-utils__/mutation-context-fixture.ts",
]);

/*
FNXC:Identity 2026-08-09-03:04:
THE RATCHET. 33 call sites in `@fusion/core` were converted to the marker by U18 because no real
actor was derivable at them. Ownership of the remaining work, so the number is a work list and not
just a number:

  - store.ts (4), task-store/* (10), duplicates/* (9), missions + async mission stores (4)
      -> store-side sweeps, intake, and recovery paths. Actor arrives with U13 (engine lanes) or
         U9/U11 (the dashboard/CLI entry points that call create and mission triage).
  - agents/agent-store.ts (3)
      -> deleteAgent and forceReleaseTask, where the only agent id in scope names the TARGET of the
         write rather than its author. Every other checkout path in that file already derives a real
         actor via `mutationContextForAgent`.
  - board/board-action-services.ts (2)
      -> the structural board-store seam consumed by dashboard routes. U9.

This must reach 0. It must never grow.

FNXC:Identity 2026-08-09-03:04 (U18 step 2, Stage A — engine baseline is 292, and it is a WORK LIST):
`@fusion/engine` held ~1,134 unconverted mutating call sites across 49 production files when Stage A
started. Stage A converted the genuinely ACTORLESS sweeps and closed the structural seams; Stages B
and C own the rest. Ownership of the 292, so the number names work rather than sitting as a total:

  - self-healing.ts (229), scheduler.ts (40), scheduling/cron-runner.ts (1)
      -> unattended system sweeps: a timer reconciling rows nobody asked it to touch. No session, no
         request, no acting agent, so there is nothing to derive FROM — the only agent ids in scope
         name the SUBJECT of a repair, and attributing to those would produce audit rows claiming a
         task rebounded or unblocked itself. Whether these lanes get a real system actor is U13's
         design decision; Stage A deliberately did not make it, so U13 inherits this list.
  - healing/restart-recovery-coordinator.ts (3), surfacing-sweeps.ts (1), healing/stale-task-reporter.ts
    (1), healing/stuck-task-detector.ts (1), scheduling/routine-runner.ts (1),
    scheduling/backlog-pressure-reporter.ts (1), missions/unlinked-missions-advisory-reporter.ts (1),
    execution/hold-release.ts (1), execution/replan-target.ts (1)
      -> the same sweeps, extracted into helper modules. They are listed separately only because the
         census is per file; they are not a separate decision. Converting the three sweep entry points
         while leaving their own extracted helpers unconverted would have left the sweep half-marked.
  - executor.ts (4), workflows/workflow-task-runtime.ts (2), workflows/workflow-work-scheduler.ts (2),
    workflows/workflow-work-processor.ts (1), overseer/planner-overseer.ts (1),
    missions/mission-execution-loop.ts (1)
      -> the fallback path at each seam Stage A closed. Every one of these sits where the lane has a
         run id but no actor (graph completion summaries, lease-renewal loss, the records-only
         planner monitor), or where the executor's `currentRunContexts` has no live entry. U13 again.

Stage A produced NO marker in merger.ts, triage.ts, or the executor's fallback-observer and column
boundary: those lanes already carry a real `runId`/`agentId`, so they were converted with
`toRunMutationContext` / `mutationContextForAgent`. That asymmetry is the point — the marker is for
sites with no actor available, not for sites where deriving one was more work.

FNXC:Identity 2026-08-09-03:04 (Stage A — the nine structural seams are CLOSED):
Nine engine seams re-declared the mutating store methods with their own narrow signatures and no
context parameter, so they did not inherit the deprecated/canonical overload pair and would have
kept accepting unattributed writes even after every call site was converted — a sweep reporting done
over holes the census cannot see. All nine now restate the requirement, each mirroring the CANONICAL
store arity (which is also what keeps a real `TaskStore` structurally assignable, since the
deprecated overload cannot absorb a `RunMutationContext` in an `outcome`/`options` slot):
`auth/fallback-model-observer.ts`, `overseer/planner-overseer.ts`,
`workflows/workflow-work-scheduler.ts`, `workflows/workflow-column-boundary.ts`,
`workflows/workflow-task-runtime.ts`, `workflows/workflow-completion-summary.ts`,
`workflows/workflow-graph-task-runner.ts` (restated on the hooks BUNDLE — the move hook is a
callback the boundary controller invokes with a column and a node, never an actor),
`execution/task-revert.ts`, and the inline widening at `executor.ts`'s workflow merge boundary.
Do not reopen one by relaxing a signature back to the old arity to quiet a caller.
*/
/*
FNXC:Identity 2026-08-09-03:04 (U18 step 2, Stage B — engine 292 -> 322, +30 markers over 379 converted sites):

Stage B converted the 379 remaining unconverted mutating call sites in every engine lane EXCEPT
`executor.ts` (Stage C, which needs a run carrier threaded through hundreds of helper frames rather
than edited call by call). 349 of those 379 derived a REAL actor; 30 took the marker. The lopsided
ratio is the point of the stage: merger, triage, project-engine, merger-ai, the reviewer and the
heartbeat all already carried a `runId`/`agentId`, so they were converted with `toRunMutationContext`
off a hoisted `EngineRunContext` or with `mutationContextForAgent` off an agent id already in scope.
Where a lane's run context existed but did not reach a helper, the context was THREADED (a required
parameter, or a required field on an existing params object) rather than marked — nineteen helpers in
`merger.ts`, five in `merge/merger-ai.ts`, plus `maybeRetryTransientMerge`, `refreshReusedWorktreeBase`
and the worktrunk failure handler.

Three lane labels are used as derived actors and none of them are invented by U18 — each is the exact
`agentId` the same code path already stamps on its own run-audit rows: `"merger"`/`"auto-merge"` in the
merge lanes, `"triage"` in the planner, `"planner-overseer"` in the recovery handlers, `"chat"` on the
chat-only task tools, and `"mesh-lease-manager"` on lease recovery. Converting them made the task log
agree with the audit stream instead of leaving one of the pair anonymous.

The +30 markers Stage B added, each with the unit that owns it:

  - agent-tools.ts (8)
      -> tool FACTORIES whose only context-less caller is `executor.ts`: `createTaskLogTool`,
         `createTaskPromptWriteTool`, `createTaskFileScopeAddTool`, `createTaskUpdateTool`,
         `createTaskAddDepTool`, `createTaskAssignTool`, `createAcquireRepoWorktreeTool`, plus
         `createAgentTask` for a create with no `source.sourceAgentId`. Each resolves ONCE at the top
         of the factory, so the debt is one line per tool rather than one per store call inside it.
         Heartbeat, triage and the step-session executor were wired to pass real contexts; STAGE C
         (executor) and U9/U11 (the actor-less create) clear the rest.
  - recovery/foreign-only-contamination.ts (4), auto-recovery-handlers/branch-worktree.ts (2),
    auto-recovery-handlers/contamination.ts (2), execution/step-runner.ts (2)
      -> the auto-recovery family. `AutoRecoveryFailure` carries a `runId` and no agent, and the only
         agent id anywhere near these repairs names the task being repaired — attributing to it would
         produce a row claiming a task un-stuck itself. Same category and same owner (U13) as Stage A's
         self-healing sweeps. `step-runner`'s pair is the RETHINK rewind, reached only from
         `executor.ts`, so it is Stage C's.
  - merger.ts (2), worktree/worktree-acquisition.ts (2)
      -> single resolution points on helpers with TWO callers of different actors. `dropAutostashHandle`
         and `restoreUnrelatedRootDirChanges` are also called by the dashboard's stash-recovery git
         routes, whose actor is the human who clicked; `acquireTaskWorktree` /
         `acquireWorkspaceRepoWorktree` are also called by `executor.ts`, which misses its own
         `currentRunContexts` entry. Filing either under "merger" would be a false attribution, so the
         engine path derives and the foreign path stays honest. U9 and Stage C.
  - project-engine.ts (2)
      -> `stopOverseerTask` (an operator API with no actor until U9/U11) and the
         `clearStaleMergingStatuses` startup sweep (U13). The other 57 sites in that file derived.
  - runtimes/in-process-runtime.ts (2)
      -> runtime startup: a mission-task requeue after error and the worktree-pool double-lease record.
         The adjacent audit row uses `agentId: "system"`, which is the marker's OWN synthetic agent id,
         so deriving from it would have manufactured an actor out of the absence of one. U13.
  - plan-artifact-writeback.ts (1), goals/goal-injection-diagnostics.ts (1),
    execution/session-token-usage.ts (1), errors/usage-limit-detector.ts (1)
      -> residual fallbacks on paths that DO derive when the caller supplies anything: the goal
         diagnostic derives from `input.agentId`, token accounting from `options.agentId ?? role`, and
         the usage-limit park from `agentType` — only `onProviderAvailable`, a provider-health sweep
         over every parked task, has no actor at all. U13/U9.

Import hygiene note for whoever moves this number next: `isCountedLine` only skips a line that STARTS
with `import`, so a marker named on its own line inside a multi-line import block, or spelled out in
prose, scores as debt it is not. Import the marker with a dedicated one-line `import { ... }` and keep
the literal off comment lines that do not start with `*`.
*/
const BASELINE_BY_PACKAGE: Readonly<Record<string, number>> = {
  core: 33,
  engine: 322,
};
const BASELINE = Object.values(BASELINE_BY_PACKAGE).reduce((sum, n) => sum + n, 0);

function isCountedLine(line: string): boolean {
  const trimmed = line.trim();
  // Imports and comments mention the marker without invoking it.
  return !(trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function censusUsages(): { total: number; byFile: Record<string, number>; byPackage: Record<string, number> } {
  const byFile: Record<string, number> = {};
  const byPackage: Record<string, number> = {};
  let total = 0;
  for (const { pkg, dir } of CENSUS_ROOTS) {
    byPackage[pkg] = 0;
    for (const file of collectTsFiles(dir)) {
      const rel = `${pkg}/${relative(dir, file).split(sep).join("/")}`;
      if (EXCLUDED_FILES.has(rel)) continue;
      let count = 0;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!isCountedLine(line)) continue;
        count += line.split(MARKER).length - 1;
      }
      if (count > 0) {
        byFile[rel] = count;
        byPackage[pkg] += count;
        total += count;
      }
    }
  }
  return { total, byFile, byPackage };
}

describe("unattributed actor census (U18 ratchet)", () => {
  it("never grows, and shrinks to zero as U9/U11/U13 wire real actors", () => {
    const { total, byFile } = censusUsages();
    expect(
      total,
      `Unattributed mutation-context usages GREW from ${BASELINE} to ${total}.\n`
      + "Do not raise BASELINE. Derive a real actor at the new call site instead "
      + "(mutationContextForAgent, or thread the caller's authenticated context).\n"
      + `Current distribution:\n${JSON.stringify(byFile, null, 2)}`,
    ).toBeLessThanOrEqual(BASELINE);

    expect(
      total,
      `Unattributed mutation-context usages SHRANK from ${BASELINE} to ${total}. `
      + "That is the intended direction — lower BASELINE to " + total + " in this same commit "
      + "so the ratchet keeps its new floor.",
    ).toBe(BASELINE);
  });

  /*
  FNXC:Identity 2026-08-09-03:04:
  The per-package assertion is not redundant with the total. A conversion that removed five markers
  in core while adding five in engine leaves the total at 33 and would pass the ratchet above while
  moving debt into the package that has the most real actors available to derive from — the exact
  regression this unit is trying to prevent.
  */
  it("holds each converted package to its own baseline", () => {
    const { byPackage, byFile } = censusUsages();
    for (const { pkg } of CENSUS_ROOTS) {
      expect(
        byPackage[pkg],
        `Unattributed mutation-context usages in @fusion/${pkg} moved from `
        + `${BASELINE_BY_PACKAGE[pkg]} to ${byPackage[pkg]}. If it GREW, derive a real actor instead `
        + "(mutationContextForAgent, or toRunMutationContext for an engine lane that already has a "
        + "run context). If it SHRANK, lower this package's entry in BASELINE_BY_PACKAGE in the same "
        + `commit.\nCurrent distribution:\n${JSON.stringify(byFile, null, 2)}`,
      ).toBe(BASELINE_BY_PACKAGE[pkg]);
    }
  });

  it("actually scans every converted package root", () => {
    // A mistyped root silently censuses nothing and reports a healthy zero forever.
    for (const { pkg, dir } of CENSUS_ROOTS) {
      expect(collectTsFiles(dir).length, `census root for @fusion/${pkg} resolved to no files`).toBeGreaterThan(0);
    }
  });

  it("counts real call sites, not imports or prose", () => {
    const { byFile } = censusUsages();
    // The definition module and the barrels mention the marker but are never call sites.
    for (const excluded of EXCLUDED_FILES) {
      expect(byFile[excluded]).toBeUndefined();
    }
    // A guard on the counter itself: a comment-only mention must not be counted.
    expect(isCountedLine(`  // pass ${MARKER} here`)).toBe(false);
    expect(isCountedLine(`  * ${MARKER} is the marker`)).toBe(false);
    expect(isCountedLine(`import { ${MARKER} } from "../identity/mutation-context.js";`)).toBe(false);
    expect(isCountedLine(`    await store.logEntry(id, "x", undefined, ${MARKER});`)).toBe(true);
  });

  it("the marker is reserved, so it can never become a real actor or hold a grant", async () => {
    const { RESERVED_ACTOR_IDS, UNATTRIBUTED_ACTOR_ID, isReservedActorId, BOOTSTRAP_ACTOR_ID } =
      await import("../identity/actor.js");
    expect(UNATTRIBUTED_ACTOR_ID).toBe("system:unattributed");
    expect(isReservedActorId(UNATTRIBUTED_ACTOR_ID)).toBe(true);
    expect(RESERVED_ACTOR_IDS).toContain(UNATTRIBUTED_ACTOR_ID);
    /*
    The distinction U18 exists to preserve: an unwired call site must NOT be indistinguishable from a
    pre-enablement bootstrap write, or the later units have no work list and the seam reports as
    fully attributed while attributing nothing.
    */
    expect(UNATTRIBUTED_ACTOR_ID).not.toBe(BOOTSTRAP_ACTOR_ID);
  });

  it("the marker carrier keeps the pre-existing synthetic run/agent audit values", async () => {
    const { UNATTRIBUTED_MUTATION_CONTEXT, mutationContextForAgent } =
      await import("../identity/mutation-context.js");
    const { UNATTRIBUTED_ACTOR_ID } = await import("../identity/actor.js");
    /*
    Converting a call site to the marker must change what the audit row says about the ACTOR and
    nothing else; "unknown"/"system" are the values the move and delete paths already fell back to.
    */
    expect(UNATTRIBUTED_MUTATION_CONTEXT.runId).toBe("unknown");
    expect(UNATTRIBUTED_MUTATION_CONTEXT.agentId).toBe("system");
    expect(UNATTRIBUTED_MUTATION_CONTEXT.actor.actor.id).toBe(UNATTRIBUTED_ACTOR_ID);

    // The derived form is NOT the marker: its actor is the real agent.
    const derived = mutationContextForAgent("agent-7");
    expect(derived.actor.actor.id).toBe("agent-7");
    expect(derived.actor.actor.kind).toBe("agent");
    expect(derived.actor.actingFor).toBeUndefined();
  });
});
