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
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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

  it("the PRIMITIVES handler dispatches every seam name the seams handler can", () => {
    const primitive = bodyOf("createPrimitivePromptLikeHandler");
    const missing = SEAM_NAMES.filter((seam) => !primitive.includes(`seam === "${seam}"`));
    expect(
      missing,
      "these seams would fall through to the custom-node runner on the LIVE handler",
    ).toEqual([]);
  });

  it("review-handoff is handled on the live path — the pending-review park depends on it", () => {
    expect(bodyOf("createPrimitivePromptLikeHandler")).toContain('seam === "review-handoff"');
  });

  it("dispatch prefers the primitives handler, which is why parity is required", () => {
    expect(bodyOf("createDefaultNodeHandlers")).toMatch(
      /deps\?\.primitives\s*\?\s*createPrimitivePromptLikeHandler/,
    );
  });
});
