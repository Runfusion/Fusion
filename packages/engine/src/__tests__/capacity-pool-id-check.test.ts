/*
FNXC:WorkflowCapacity 2026-07-28-22:45 (PR #2488 review — ratchet regression suite):

THE ACCEPTANCE TEST FOR A GUARD IS NOT "IT PASSES ON MAIN".

The first version of `check-capacity-pool-id` passed on main and passed on the
REINTRODUCED ORIGINAL DEFECT, because it matched one spelling of the fallback
(`?? DEFAULT_WORKFLOW_POOL_ID`) and the real bug used another
(`?? "builtin:coding"`). Green on the bug it exists to prevent is worse than no
guard: it stops anyone looking.

So every form the guard must catch is pinned here as a case. The first fixture is
the ACTUAL PRE-FIX `moves.ts` shape, reduced — if this suite ever goes green on
that, the ratchet has silently narrowed again and this file is what says so.

The negative cases matter just as much: `?? "builtin:coding"` is the legitimate
default for a WORKFLOW id in about eight places (scheduler's IR-resolution key,
task creation, analytics). A guard that fired on those would be suppressed until
it rotted, so the rule is deliberately about what reaches a CAPACITY SINK, not
about a spelling.
*/
import { describe, expect, it } from "vitest";

import { findViolationsInSource } from "../../../../scripts/lib/capacity-pool-id-check.mjs";

const rules = (src: string): string[] =>
  (findViolationsInSource("packages/core/src/task-store/example.ts", src) as Array<{ rule: string }>).map(
    (v) => v.rule,
  );

describe("check-capacity-pool-id ratchet — forms it MUST catch", () => {
  it("catches the ORIGINAL DEFECT: a `?? \"builtin:coding\"` local reaching the counter", () => {
    /* The reduced pre-fix moves.ts. The previous regex version passed on this. */
    const src = `
      async function moveTaskInternalImpl(store: any, id: string) {
        const effectiveWorkflowIdForMove = useWorkflow
          ? (await store.getTaskWorkflowSelectionAsync(id))?.workflowId ?? "builtin:coding"
          : "builtin:coding";
        await store.countActiveInCapacitySlotAsync({
          tx, targetColumn: budgetColumn, workflowId: effectiveWorkflowIdForMove, countPending,
        });
      }
    `;
    expect(rules(src)).toContain("unresolved-pool-into-capacity-sink");
  });

  it("catches a bare literal passed inline to the counter", () => {
    const src = `
      async function f(store: any) {
        await store.countActiveInCapacitySlotAsync({ workflowId: "builtin:coding" });
      }
    `;
    expect(rules(src)).toContain("unresolved-pool-into-capacity-sink");
  });

  it("catches a MULTILINE fallback — the AST sees one node regardless of formatting", () => {
    const src = `
      const poolId =
        selection
          ?.workflowId
        ??
          DEFAULT_WORKFLOW_POOL_ID;
    `;
    expect(rules(src)).toContain("sentinel-fallback");
  });

  it("catches a DEEPLY QUALIFIED sentinel reference", () => {
    const src = `const poolId = selection?.workflowId ?? Foo.Bar.Baz.DEFAULT_WORKFLOW_POOL_ID;`;
    expect(rules(src)).toContain("sentinel-fallback");
  });

  it("catches the sentinel's RAW STRING VALUE, not just its constant name", () => {
    const src = `const poolId = selection?.workflowId ?? "__default-workflow__";`;
    expect(rules(src)).toContain("sentinel-fallback");
  });

  it("catches an underived POSITIONAL argument to countCapacitySlot", () => {
    const src = `
      const workflowId = byTask.get(task.id) ?? "builtin:coding";
      const n = countCapacitySlot(allTasks, byTask, budgetColumns, workflowId, countPending);
    `;
    expect(rules(src)).toContain("unresolved-pool-into-capacity-sink");
  });

  it("catches a sink fed by a local that is NOT resolver-derived", () => {
    const src = `
      const poolId = someOtherThing();
      await store.countActiveInCapacitySlotAsync({ workflowId: poolId });
    `;
    expect(rules(src)).toContain("unresolved-pool-into-capacity-sink");
  });
});

describe("check-capacity-pool-id ratchet — forms it must NOT flag", () => {
  it("accepts a direct resolver call at the sink", () => {
    const src = `
      await store.countActiveInCapacitySlotAsync({
        workflowId: resolveCapacityPoolId(selection?.workflowId),
      });
    `;
    expect(rules(src)).toEqual([]);
  });

  it("accepts a local derived from the resolver, declared before OR after the sink", () => {
    const before = `
      const poolId = resolveCapacityPoolId(selection?.workflowId);
      await store.countActiveInCapacitySlotAsync({ workflowId: poolId });
    `;
    expect(rules(before)).toEqual([]);
  });

  it("accepts `?? \"builtin:coding\"` when it is a WORKFLOW id and never reaches a capacity sink", () => {
    /* scheduler.ts's IR-resolution key. Flagging this would make the guard noise
       that gets suppressed — the rule is about the sink, not the spelling. */
    const src = `
      const workflowIdByTaskId = new Map<string, string>();
      workflowIdByTaskId.set(task.id, selection?.workflowId ?? "builtin:coding");
      const ir = await resolveWorkflowIrById(store, workflowId, cache);
    `;
    expect(rules(src)).toEqual([]);
  });

  it("accepts naming the sentinel constant where nothing is derived from a selection", () => {
    /* scheduler's capacity DIAGNOSTIC label — no selection input, nothing to drift. */
    const src = `const perColumnGates = [{ workflowId: DEFAULT_WORKFLOW_POOL_ID, columnId: "in-progress" }];`;
    expect(rules(src)).toEqual([]);
  });
});

describe("check-capacity-pool-id ratchet — it fails CLOSED", () => {
  /*
  FNXC:WorkflowCapacity 2026-07-28-23:30 (PR #2488 review):
  These were ONE test titled "unparseable" that actually simulated a read()
  throw and asserted "unreadable" — it never reached the parse path at all. A
  test that misreports its own subject is this PR's entire failure mode in
  miniature, so they are split and each now exercises the path it names.

  Writing the second one surfaced a real defect: `ts.createSourceFile` is
  error-TOLERANT and does not throw on malformed syntax, so the try/catch it was
  meant to cover was unreachable and the "unparseable" rule could never fire.
  Detection now reads `parseDiagnostics`.
  */
  it("reports an UNREADABLE file rather than skipping it", async () => {
    const { findViolations } = await import("../../../../scripts/lib/capacity-pool-id-check.mjs");
    const out = (findViolations([
      {
        file: "packages/core/src/broken.ts",
        read: () => {
          throw new Error("EACCES");
        },
      },
    ]) as Array<{ rule: string }>).map((v) => v.rule);
    // "could not inspect" must never render as "inspected and clean".
    expect(out).toContain("unreadable");
  });

  it("reports an UNPARSEABLE file — real malformed syntax, reaching the parse check", () => {
    /* Genuinely malformed TypeScript. A partial AST can silently lack the `??`
       nodes and sink calls the rules look for, so "parsed badly" must not read
       as "inspected and clean". */
    const malformed = `
      const x = { unclosed: (((  ;
      function )( {
    `;
    const out = (findViolationsInSource("packages/core/src/malformed.ts", malformed) as Array<{ rule: string }>).map(
      (v) => v.rule,
    );
    expect(out).toContain("unparseable");
  });

  it("does NOT report well-formed source as unparseable", () => {
    /* The negative half: a diagnostics-based check that fired on valid syntax
       would be noise, and noise gets suppressed. */
    const fine = `const poolId = resolveCapacityPoolId(selection?.workflowId);`;
    expect(rules(fine)).toEqual([]);
  });
});
