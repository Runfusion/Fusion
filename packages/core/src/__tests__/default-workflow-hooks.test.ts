// @vitest-environment node
//
// U4: the default-workflow side effects are resolved THROUGH the trait registry
// (the DI seam, KTD-2/U2). This pins:
//   - registerDefaultWorkflowHooks() wires the impls so resolution finds them
//     (no missing-hook-impl warning on the happy path);
//   - a missing registration degrades to a no-op + audit warning (not a crash);
//   - applyDefaultWorkflowMoveEffects mutates the task per the legacy contract.

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetTraitRegistryForTests,
  getTraitRegistry,
} from "../trait-registry.js";
import { registerBuiltinTraits } from "../builtin-traits.js";
import {
  __resetDefaultWorkflowHooksForTests,
  applyDefaultWorkflowMoveEffects,
  registerDefaultWorkflowHooks,
  type DefaultWorkflowMoveContext,
} from "../default-workflow-hooks.js";
import type { Task } from "../types.js";

function makeCtx(overrides: Partial<DefaultWorkflowMoveContext> = {}): DefaultWorkflowMoveContext {
  const task = {
    id: "FN-1",
    column: "in-progress",
    columnMovedAt: new Date().toISOString(),
    steps: [],
    dependencies: [],
  } as unknown as Task;
  return {
    task,
    fromColumn: "todo",
    toColumn: "in-progress",
    moveSource: "user",
    bypassGuards: false,
    movedAt: new Date().toISOString(),
    settings: undefined,
    options: {},
    resetSteps: () => {},
    ...overrides,
  };
}

describe("default-workflow-hooks registry wiring", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
  });

  it("resolves all default-workflow hooks without a missing-impl warning once registered", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    expect(warnings).toHaveLength(0);
    // timing.onEnter stamped cumulativeActiveMs on entry to in-progress.
    expect(ctx.task.cumulativeActiveMs).toBe(0);
  });

  it("degrades to a no-op + audit warning when a hook impl is not registered", () => {
    // Built-in DEFINITIONS are registered (so the trait declares the hook) but
    // we deliberately do NOT call registerDefaultWorkflowHooks() — no impls.
    const registry = getTraitRegistry();
    // sanity: the trait declares the hook descriptor
    expect(registry.getTrait("timing")?.hooks?.onEnter).toBe(true);
    const ctx = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    // Every declared hook with no impl yields a degraded-no-op warning.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.kind === "missing-hook-impl")).toBe(true);
    // No crash; task unmutated by the (no-op) hooks.
    expect(ctx.task.cumulativeActiveMs).toBeUndefined();
  });

  it("applies userPaused only for user-source reopen to todo", () => {
    registerDefaultWorkflowHooks();
    const userCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "user" });
    applyDefaultWorkflowMoveEffects(userCtx);
    expect(userCtx.task.userPaused).toBe(true);

    const engineCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    applyDefaultWorkflowMoveEffects(engineCtx);
    expect(engineCtx.task.userPaused).toBeUndefined();
  });
});
