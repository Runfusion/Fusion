import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBootstrapPrompt, buildRefinementSeedPrompt, isUnplannedSeedPrompt } from "@fusion/core";
import { afterEach, describe, expect, it } from "vitest";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:20:
Ratchet for the shared release-leg fixture. The fixture's whole value is its self-check, so that
check must be shown FAILING on the defect it exists to catch — a fixture that silently writes a
bootstrap seed, which is the state that produced the same three-times-diagnosed "the release sweep
is broken" symptom (#2634, #2643, workflow-planning-lane).

The two seed shapes are built with the PRODUCTION builders rather than restated here; a local
imitation would keep passing if the real seed shape changed, which is exactly the drift the
fixture is meant to absorb.
*/

const dirs: string[] = [];
function makeStore(): { getTasksDir(): string; taskCache: { delete(id: string): void } } {
  const root = mkdtempSync(join(tmpdir(), "fusion-planned-spec-fixture-"));
  dirs.push(root);
  return { getTasksDir: () => root, taskCache: { delete: () => {} } };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("seedPlannedSpec", () => {
  it("writes a spec the release gate's own predicate accepts as planned", () => {
    const store = makeStore();
    seedPlannedSpec(store, "FN-1001", { title: "a title", description: "a description" });

    const written = readFileSync(join(store.getTasksDir(), "FN-1001", "PROMPT.md"), "utf-8");
    expect(isUnplannedSeedPrompt(written, "FN-1001", "a title", "a description")).toBe(false);
  });

  it("RATCHET: throws when the spec it would write is a bootstrap seed", () => {
    const store = makeStore();
    // The exact content `createTaskWithReservedId` leaves behind — the original defect.
    const seed = buildBootstrapPrompt("FN-1002", "a title", "a description");

    expect(() => seedPlannedSpec(store, "FN-1002", { title: "a title", description: "a description", content: seed }))
      .toThrow(/still classified as an unplanned bootstrap seed/);
  });

  it("RATCHET: throws for the refineTask seed shape too", () => {
    const store = makeStore();
    // hold-release.ts:265 notes this second shape is also held; the fixture must reject it as well.
    const seed = buildRefinementSeedPrompt("a title", "a description");

    expect(() => seedPlannedSpec(store, "FN-1003", { title: "a title", description: "a description", content: seed }))
      .toThrow(/FIXTURE defect, not a scheduler defect/);
  });

  it("names the fixture and the task in the failure so the diagnosis does not restart", () => {
    const store = makeStore();
    const seed = buildBootstrapPrompt("FN-1004", undefined, "a description");

    expect(() => seedPlannedSpec(store, "FN-1004", { description: "a description", content: seed }))
      .toThrow(/seedPlannedSpec\(FN-1004\)[\s\S]*_planned-spec-fixture\.ts/);
  });

  it("works without title/description — the check is shape-based, so omitting them cannot mask a seed", () => {
    const store = makeStore();
    expect(() => seedPlannedSpec(store, "FN-1005")).not.toThrow();

    // And the omission genuinely does not weaken it: a seed still throws with no title/description.
    const seed = buildBootstrapPrompt("FN-1006", undefined, "");
    expect(() => seedPlannedSpec(store, "FN-1006", { content: seed })).toThrow(/unplanned bootstrap seed/);
  });
});
