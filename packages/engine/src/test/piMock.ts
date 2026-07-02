import { vi } from "vitest";

/**
 * FNXC:EngineTests 2026-07-02-11:28:
 * Build the common pi.js mock entries shared across engine test suites
 * (reviewer-prompt-single-source, plan-review-unavailable-recovery,
 * triage-fast-mode-workflow-variant, triage-stuck-requeue-preserve-draft,
 * restart.integration). formatModelMarkerDetails is consumed by triage.ts
 * and executor.ts to build the model-marker log line after resolving an
 * agent session, and describeModel resolves the display model id. Both
 * exports MUST be present on every pi.js mock so the planning/execution
 * paths can reach finalization instead of throwing on a missing mock
 * member. Previously each suite redeclared the same vi.fn(...) bodies,
 * which made the mock drift across files (see CodeRabbit nitpick on PR #1874).
 *
 * Callers spread this base inside their `vi.mock("../pi.js", ...)`
 * factory and layer file-specific entries (createFnAgent,
 * promptWithFallback, compactSessionContext, ...) on top. The factory
 * MUST dynamic-import this helper to stay compatible with vitest's mock
 * hoisting, which lifts `vi.mock` above static `import` statements:
 *
 *   vi.mock("../pi.js", async () => {
 *     const { createPiMockBase } = await import("../test/piMock.js");
 *     return { ...createPiMockBase(), createFnAgent: vi.fn() };
 *   });
 *
 * @param modelMarker - return value of describeModel; defaults to
 *   "mock-provider/mock-model". Some suites assert on the bare
 *   "mock-model" marker form, so the override is supported.
 */
export function createPiMockBase(
  modelMarker = "mock-provider/mock-model",
): {
  describeModel: ReturnType<typeof vi.fn>;
  formatModelMarkerDetails: ReturnType<typeof vi.fn>;
} {
  return {
    describeModel: vi.fn().mockReturnValue(modelMarker),
    formatModelMarkerDetails: vi.fn((model: string) => model),
  };
}
