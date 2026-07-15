import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CeOrchestrator, type CeSessionExecutor } from "../session/orchestrator.js";
import { makeHarness, pgDescribe, type TestHarness } from "./_harness.js";

/**
 * U9 CE executor seam contract.
 *
 * Proves the `executor` option threads end-to-end on a REAL orchestrator (not a
 * scripted fake): the option set on deps is what `resolveExecutor()` returns,
 * and it defaults to the model backend. The cli-agent one-shot wiring itself is
 * engine-side (`@fusion/engine` runOneShotSession); this asserts the plugin
 * carries the choice through, per the plugin-skills option-threading learning.
 */
let h: TestHarness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => {
  h.close();
});

function makeOrch(executor?: CeSessionExecutor) {
  return new CeOrchestrator({
    ctx: h.ctx,
    createInteractiveAiSession: vi.fn(async () => ({ session: {} as never })),
    projectRoot: h.projectRoot,
    executor,
  });
}

pgDescribe("CE executor seam (U9)", () => {
  it("defaults to the model backend when no executor option is supplied", () => {
    expect(makeOrch().resolveExecutor()).toEqual({ kind: "model" });
  });

  it("threads a cli-agent executor selection through deps → resolver", () => {
    const orch = makeOrch({ kind: "cli-agent", adapterId: "claude-code" });
    expect(orch.resolveExecutor()).toEqual({ kind: "cli-agent", adapterId: "claude-code" });
  });
});
