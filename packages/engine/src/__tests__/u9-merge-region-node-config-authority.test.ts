import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, type TaskDetail, type WorkflowIrNode } from "@fusion/core";

import { createDefaultNodeHandlers, createNoopLegacySeams } from "../workflow-node-handlers.js";
import type { WorkflowNodeExecutionContext } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowOwnedMerge 2026-07-28-09:40:
U9 characterization baseline. The built-in coding IR DECLARES merge-region policy
(`merge-retry.maxAttempts`, `merge-manual-hold.release`, the branch-group rework
budgets), but no engine code reads any of it: the handlers for those node kinds
return constants. Merge policy authority today lives in TWO other places —
`settings.maxAutoMergeRetries` (conflict retries, covered by
`auto-merge-retry-cap-settings.test.ts`) and `ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES`
(transient retries). The IR is a third, DEAD authority.

That matters because U9's acceptance criterion is "merge policy changes via IR config
alone, with no code change". A reader looking at the IR would reasonably conclude the
declared numbers are live. They are not, and nothing currently says so.

These tests pin the CURRENT (config-blind) behavior deliberately. When U9 wires a node
kind onto its IR config, the matching case here goes RED — that is the test doing its
job, and the U9 commit must move the kind from `CONFIG_BLIND_MERGE_REGION_KINDS` to a
real config-driven assertion. Do not "fix" a failure here by loosening the assertion.
*/

/** Node kinds in the merge region whose handlers ignore `node.config` today. */
const CONFIG_BLIND_MERGE_REGION_KINDS = [
  "retry-backoff",
  "manual-merge-hold",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
] as const;

function ctx(): WorkflowNodeExecutionContext {
  return {
    task: { id: "FN-U9", title: "merge region", description: "" } as TaskDetail,
    settings: undefined,
    context: {},
  };
}

function nodeOf(kind: string, config: Record<string, unknown> | undefined): WorkflowIrNode {
  return { id: `${kind}-probe`, kind, column: "in-review", config } as WorkflowIrNode;
}

describe("U9 baseline: built-in merge-region IR policy config", () => {
  it("declares merge policy the engine does not read", () => {
    const nodes = BUILTIN_CODING_WORKFLOW_IR.nodes;
    const byId = (id: string) => nodes.find((n) => n.id === id);

    // These declarations are the ones a reader would take as authoritative.
    expect(byId("merge-retry")).toMatchObject({
      kind: "retry-backoff",
      config: { policy: "merge", maxAttempts: 3 },
    });
    expect(byId("merge-manual-hold")).toMatchObject({
      kind: "manual-merge-hold",
      config: { release: "manual" },
    });
    expect(byId("branch-group-member-integration")).toMatchObject({
      config: { reworkRegion: true, maxReworkCycles: 3 },
    });
  });
});

describe("U9 baseline: merge-region handlers are config-blind", () => {
  const handlers = createDefaultNodeHandlers(createNoopLegacySeams());

  for (const kind of CONFIG_BLIND_MERGE_REGION_KINDS) {
    it(`\`${kind}\` returns an identical result for contradictory configs`, async () => {
      const handler = handlers[kind];

      // Two configs that a config-driven handler could not possibly treat alike:
      // opposite budgets, opposite release modes, disjoint surfaces.
      const withBuiltinConfig = await handler(
        nodeOf(kind, { policy: "merge", maxAttempts: 3, release: "manual", maxReworkCycles: 3, surfaces: ["merge", "retry"] }),
        ctx(),
      );
      const withContradictoryConfig = await handler(
        nodeOf(kind, { policy: "none", maxAttempts: 0, release: "external-event", maxReworkCycles: 999, surfaces: [] }),
        ctx(),
      );
      const withNoConfigAtAll = await handler(nodeOf(kind, undefined), ctx());

      expect(withContradictoryConfig).toEqual(withBuiltinConfig);
      expect(withNoConfigAtAll).toEqual(withBuiltinConfig);
    });
  }

  it("`retry-backoff` succeeds unconditionally, so it enforces no attempt budget", async () => {
    // maxAttempts: 0 should mean "never retry" to any config-driven implementation.
    // Today the node succeeds regardless, which is why the real budget has to live
    // in settings/ProjectEngine. Pinned so U9 cannot silently keep it that way.
    await expect(handlers["retry-backoff"](nodeOf("retry-backoff", { maxAttempts: 0 }), ctx())).resolves.toEqual({
      outcome: "success",
    });
  });

  it("`manual-merge-hold` parks regardless of its declared release mode", async () => {
    await expect(
      handlers["manual-merge-hold"](nodeOf("manual-merge-hold", { release: "external-event" }), ctx()),
    ).resolves.toEqual({ outcome: "failure", value: "manual-required" });
  });
});
