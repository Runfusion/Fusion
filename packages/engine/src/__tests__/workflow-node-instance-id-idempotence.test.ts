import { describe, expect, it } from "vitest";
import { materializedTemplateNodeId } from "../workflows/workflow-graph-executor.js";

/*
FNXC:WorkflowAgentRouting 2026-08-10-08:20:
A resume seeds `workflow:node-instance-id` from the persisted continuation, which holds the node's OWN
materialized id. Treating that as the enclosing container re-wrapped it on every dispatch, so FN-8869 —
re-dispatching every ~15 minutes while its executor node held — grew a ~1.8 KB run_id of ~30 repeated
`:step-execute#4` segments on a hot indexed column, and every retry read as a distinct run.

Two properties together, because either alone is satisfiable by a wrong fix: materializing an already
materialized id must be a FIXED POINT, and it must still track the container's current iteration.
*/

const node = { id: "step-execute", kind: "prompt", config: {} } as never;

const foreachContext = (stepIndex: number, seeded?: string) => ({
  "foreach:active": { foreachNodeId: "steps", stepIndex },
  ...(seeded ? { "workflow:node-instance-id": seeded } : {}),
});

describe("materializedTemplateNodeId", () => {
  it("is a fixed point once materialized", () => {
    const first = materializedTemplateNodeId(node, foreachContext(4));
    expect(first).toBe("steps#4:step-execute");

    let id = first;
    for (let dispatch = 0; dispatch < 30; dispatch += 1) {
      id = materializedTemplateNodeId(node, foreachContext(4, id));
    }
    expect(id).toBe(first);
  });

  it("still advances with the container iteration", () => {
    expect(materializedTemplateNodeId(node, foreachContext(5, "steps#4:step-execute"))).toBe("steps#5:step-execute");
  });

  it("keeps a genuinely nested container as the prefix", () => {
    const inner = { id: "leaf", kind: "prompt", config: {} } as never;
    const nested = {
      "foreach:active": { foreachNodeId: "inner", stepIndex: 2 },
      "workflow:node-instance-id": "outer#1:inner",
    };
    expect(materializedTemplateNodeId(inner, nested)).toBe("outer#1:inner#2:leaf");
    // And that nested identity is itself a fixed point.
    expect(materializedTemplateNodeId(inner, { ...nested, "workflow:node-instance-id": "outer#1:inner#2:leaf" }))
      .toBe("outer#1:inner#2:leaf");
  });

  it("is a fixed point for loop and optional-group instances too", () => {
    const loop = (seeded?: string) => ({
      "loop:active": { loopNodeId: "retry", iteration: 3 },
      ...(seeded ? { "workflow:node-instance-id": seeded } : {}),
    });
    expect(materializedTemplateNodeId(node, loop())).toBe("retry#3:step-execute");
    expect(materializedTemplateNodeId(node, loop("retry#3:step-execute"))).toBe("retry#3:step-execute");

    const optional = (seeded?: string) => ({
      "optional-group:active": "plan-review",
      ...(seeded ? { "workflow:node-instance-id": seeded } : {}),
    });
    expect(materializedTemplateNodeId(node, optional())).toBe("plan-review::step-execute");
    expect(materializedTemplateNodeId(node, optional("plan-review::step-execute"))).toBe("plan-review::step-execute");
  });

  /*
  FNXC:WorkflowAgentRouting 2026-08-10-08:35:
  The RESUME shape, which is the only one that actually accretes. `workflow-graph-loop.ts` copies
  `workflow:node-instance-id` into `optional-group:active` verbatim, and on resume that key already holds the
  CHILD's materialized id — so the group marker itself arrives pre-wrapped. The first version of this suite
  hand-wrote `optional-group:active: "plan-review"`, a value only the FIRST dispatch ever produces, and passed
  against code that still grew one `::step-execute` segment per dispatch.
  */
  it("is a fixed point when the optional-group marker itself arrives pre-wrapped on resume", () => {
    const resumed = (seeded: string) => ({
      // Exactly what workflow-graph-loop.ts seeds: the group marker copied from the node-instance-id.
      "optional-group:active": seeded,
      "workflow:node-instance-id": seeded,
    });
    let id = materializedTemplateNodeId(node, { "optional-group:active": "plan-review" });
    expect(id).toBe("plan-review::step-execute");
    for (let dispatch = 0; dispatch < 30; dispatch += 1) {
      id = materializedTemplateNodeId(node, resumed(id));
    }
    expect(id).toBe("plan-review::step-execute");
  });

  it("leaves a plain non-template node alone", () => {
    expect(materializedTemplateNodeId(node, {})).toBe("step-execute");
    expect(materializedTemplateNodeId(node, { "workflow:node-instance-id": "step-execute" })).toBe("step-execute");
  });
});
