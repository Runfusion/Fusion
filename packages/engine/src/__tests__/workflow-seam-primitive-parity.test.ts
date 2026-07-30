/*
FNXC:WorkflowExecutionOwnership 2026-07-29-17:20 (U8 / R4, R12):

Two prompt-node handlers exist and only one runs. `createDefaultNodeHandlers` prefers
`createPrimitivePromptLikeHandler` whenever `deps.primitives` is set, and `executeWorkflowGraph`
always sets it — so `createPromptLikeHandler`, the legacy-seams variant, is unreachable for prompt
nodes. That already cost one shipped behavior that never executed (the exit announcement).

The invariant that makes the preference SAFE is parity: every seam name the seams handler can
dispatch must also be handled by the primitives handler. If the primitives handler is missing one,
a node declaring that seam does not fail loudly — it falls through to the custom-node runner and
is treated as a custom node, or throws `No custom-node runner registered`. Either way the workflow
author gets a nonsense result from a seam the IR is entitled to declare.

`review-handoff` is called out separately because it is now load-bearing: the pending-review park
node added to the built-in coding IRs declares it, so a parity gap there would mean a card that
should be handed to review is not.
*/
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { WorkflowIrNode } from "@fusion/core";
import { createDefaultNodeHandlers, FOREACH_ACTIVE_CONTEXT_KEY } from "../workflow-node-handlers.js";

const SOURCE = readFileSync(new URL("../workflow-node-handlers.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/** The seam names `resolveSeamName` accepts — the whole surface an IR may declare. */
const SEAM_NAMES = [
  "planning",
  "execute",
  "review",
  "review-handoff",
  "merge",
  "schedule",
  "step-execute",
] as const;

function bodyOf(fnName: string): string {
  const start = SOURCE.indexOf(`export function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  const next = SOURCE.indexOf("\nexport function ", start + 1);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe("prompt-node handler parity", () => {
  it("resolveSeamName's accepted names are exactly the list under test", () => {
    /* Guards the guard: a new seam name added to the resolver must be added here, or the parity
       assertion below would silently stop covering it. */
    const resolver = bodyOf("resolveSeamName");
    for (const seam of SEAM_NAMES) {
      expect(resolver, `resolveSeamName should accept ${seam}`).toContain(`seam === "${seam}"`);
    }
    const accepted = [...resolver.matchAll(/seam === "([a-z-]+)"/g)].map((m) => m[1]);
    expect([...new Set(accepted)].sort()).toEqual([...SEAM_NAMES].sort());
  });

  /*
  FNXC:WorkflowExecutionOwnership 2026-07-29-22:10 (PR #2580 review — greptile):
  BEHAVIOURAL parity, replacing two assertions that matched exact `seam === "..."` source
  strings. Those inferred support from SYNTAX: a switch, a lookup table, or an extracted
  dispatch helper would fail the suite while every seam remained supported — and, worse in
  the other direction, the strings could survive a reordered condition that stopped
  selecting them. Syntax-shaped assertions are what let a shipped behaviour sit on a dead
  seam in the first place, which is the finding this file records.

  The property under test is stated in the header: a seam the primitives handler does not
  handle "falls through to the custom-node runner". So invoke the LIVE handler per seam and
  assert the custom-node runner was NOT reached. That is the actual invariant, and it holds
  across any refactor that keeps the seams dispatched.
  */
  function liveHandlerWithSpies() {
    const customNode = vi.fn(async () => ({ outcome: "success" as const }));
    const primitiveCalls: string[] = [];
    /* A Proxy so the assertion does not depend on WHICH primitive each seam calls — only
       that a primitive, rather than the custom-node runner, handled it. Method names are
       free to change; the routing property is what is pinned. */
    const primitives = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => async () => {
        primitiveCalls.push(prop);
        return { outcome: "success" as const };
      },
    });
    const handlers = createDefaultNodeHandlers(
      {} as never,
      customNode as never,
      { primitives: primitives as never },
    );
    return { handlers, customNode, primitiveCalls };
  }

  it.each(SEAM_NAMES)("the LIVE handler dispatches the %s seam without falling through to custom-node", async (seam) => {
    const { handlers, customNode, primitiveCalls } = liveHandlerWithSpies();
    const node = { id: `${seam}-node`, kind: "prompt", column: "in-progress", config: { seam } } as WorkflowIrNode;
    /* step-execute carries an active-instance precondition; supply it so this case tests
       DISPATCH rather than that precondition. */
    const ctx = {
      task: { id: "FN-PARITY" },
      context: seam === "step-execute" ? { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 0 } } : {},
    } as never;

    await handlers.prompt!(node, ctx);

    expect(
      customNode,
      `the ${seam} seam fell through to the custom-node runner on the LIVE handler`,
    ).not.toHaveBeenCalled();
    expect(primitiveCalls.length, `no primitive ran for the ${seam} seam`).toBeGreaterThan(0);
  });

  it("review-handoff is handled on the live path — the pending-review park depends on it", async () => {
    /* Called out separately because it is load-bearing: the pending-review park node in the
       built-in coding IRs declares it, so a parity gap here means a card that should be
       handed to review is not. */
    const { handlers, customNode } = liveHandlerWithSpies();
    const node = { id: "handoff", kind: "prompt", column: "in-review", config: { seam: "review-handoff" } } as WorkflowIrNode;

    await handlers.prompt!(node, { task: { id: "FN-PARITY" }, context: {} } as never);

    expect(customNode).not.toHaveBeenCalled();
  });

  it("dispatch prefers the primitives handler, which is why parity is required", () => {
    expect(bodyOf("createDefaultNodeHandlers")).toMatch(
      /deps\?\.primitives\s*\?\s*createPrimitivePromptLikeHandler/,
    );
  });
});
