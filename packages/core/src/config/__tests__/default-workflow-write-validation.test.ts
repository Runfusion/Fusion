// @vitest-environment node
//
/*
FNXC:DefaultWorkflowWriteValidation 2026-10-14-23:58 (RUFU-391):
`settings.defaultWorkflowId` could be PERSISTED by four surfaces but validated by only one —
`TaskStore.setDefaultWorkflowId()` (`PUT /project/default-workflow`). A settings import, a generic
`PUT /api/settings`, and (once the CLI learns the key) `fn settings set` all wrote it straight through
`store.updateSettings`, and because `resolveEffectiveDefaultWorkflowId` applies NO fallback to a custom
id, a mistyped id silently routed every new card into a workflow that does not resolve.

This file pins the shared write-side predicate (`validateProjectDefaultWorkflowRef`) at the store seam,
which every one of those surfaces now consumes. It runs on the REAL PostgreSQL TaskStore on purpose: the
verdict depends on the real built-in catalog (deprecation, fragment membership, plugin gating) and on
real custom-definition reads, and neither can be proven through a mock that merely resembles them.

The invariant is one-directional and that direction is the whole point: the GATE may refuse an id the
read side would still resolve (a deprecated built-in), but it may never refuse an id the read side
needs, and it may never add a fallback to the read side. The last case is the control that proves that
half — a legacy junk id written around the gate must still read back unchanged.
*/

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { validateProjectDefaultWorkflowRef } from "../../task-store/workflow-ops.js";
import { exportSettings, importSettings, type SettingsExportData } from "../settings-export.js";
import { stepsToWorkflowIr } from "../../workflows/workflow-steps-to-ir.js";
import { resolveEffectiveDefaultWorkflowId } from "../../workflows/builtin-workflows.js";

const pgTest = pgDescribe;

/** A real, storable custom workflow definition — the ids the gate must wave through. */
function customIr(name: string) {
  return stepsToWorkflowIr(
    [{ name: "Execute", mode: "prompt", prompt: `Do the work for ${name}`, gateMode: "advisory" }],
    name,
  ) as never;
}

pgTest("default-workflow write validation at the store seam", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dwf_write",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  /*
   * Non-vacuity control for the whole file: a known-good id must VALIDATE. Without this, every refusal
   * assertion below would also pass against a predicate that simply refuses everything.
   */
  it("accepts an existing custom workflow and persists it as the project default", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "custom default candidate",
      ir: customIr("custom default candidate"),
    });

    expect(await validateProjectDefaultWorkflowRef(store, definition.id)).toBeUndefined();

    await store.setDefaultWorkflowId(definition.id);
    expect(await store.getDefaultWorkflowId()).toBe(definition.id);
  });

  /*
   * Acceptance criterion: a value written through the validated seam is visible in
   * `fn settings export --scope project`. The export serializes the whole project section minus
   * `MOVED_SETTINGS_KEYS`, so this pins that `defaultWorkflowId` is not one of the moved keys — a key
   * stripped here would be invisible in a backup and silently lost on a round-trip.
   */
  it("survives the project export round-trip, and a clear removes it from the payload", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "exported default candidate",
      ir: customIr("exported default candidate"),
    });

    await store.setDefaultWorkflowId(definition.id);
    const exported = await exportSettings(store, { scope: "project" });
    expect(exported.project?.defaultWorkflowId).toBe(definition.id);

    await store.setDefaultWorkflowId(null);
    const cleared = await exportSettings(store, { scope: "project" });
    expect(cleared.project?.defaultWorkflowId).toBeUndefined();
  });

  it("accepts an enabled built-in workflow", async () => {
    const store = h.store();
    // `builtin:stepwise-coding` is a plain workflow entry: not a fragment, not deprecated, not plugin-gated.
    expect(await validateProjectDefaultWorkflowRef(store, "builtin:stepwise-coding")).toBeUndefined();

    await store.setDefaultWorkflowId("builtin:stepwise-coding");
    expect(await store.getDefaultWorkflowId()).toBe("builtin:stepwise-coding");
  });

  /*
   * The unknown-id sentence keeps its exact shape because `PUT /project/default-workflow` maps a
   * refusal to HTTP status by testing /not found/i — an unknown id must stay a 404, not a 400.
   * The prior value is seeded rather than asserting `undefined`, so a store that never writes
   * anything cannot pass this case.
   */
  it("refuses an unknown custom id, naming it, and writes nothing", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding");

    const refusal = await validateProjectDefaultWorkflowRef(store, "wf-typoed-by-hand");
    expect(refusal).toContain("'wf-typoed-by-hand'");
    expect(refusal).toMatch(/not found/i);

    await expect(store.setDefaultWorkflowId("wf-typoed-by-hand")).rejects.toThrow(/wf-typoed-by-hand/);
    expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
  });

  /*
   * `builtin:brainstorming` is shipped by the catalog, so answering "not found" about it is the
   * misleading 404 this task removes. The refusal must name the id and must NOT carry the substring
   * the route's 404 mapping keys off.
   */
  it("refuses a deprecated built-in as a not-allowed default rather than a not-found", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding");

    const refusal = await validateProjectDefaultWorkflowRef(store, "builtin:brainstorming");
    expect(refusal).toContain("'builtin:brainstorming'");
    expect(refusal).not.toMatch(/not found/i);

    await expect(store.setDefaultWorkflowId("builtin:brainstorming")).rejects.toThrow(
      /builtin:brainstorming/,
    );
    expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
  });

  it("refuses a built-in the project has disabled, naming the id", async () => {
    const store = h.store();
    await store.updateSettings({ enabledBuiltinWorkflowIds: ["builtin:coding"] });
    await store.setDefaultWorkflowId("builtin:coding");

    const refusal = await validateProjectDefaultWorkflowRef(store, "builtin:stepwise-coding");
    expect(refusal).toContain("'builtin:stepwise-coding'");
    expect(refusal).not.toMatch(/not found/i);

    await expect(store.setDefaultWorkflowId("builtin:stepwise-coding")).rejects.toThrow(
      /builtin:stepwise-coding/,
    );
    expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
  });

  /*
   * The tautology alone cannot see this case: a project that EXPLICITLY lists the plugin-gated id in
   * `enabledBuiltinWorkflowIds` passes it. So the gate re-checks the same
   * `getRequiredPluginIdForBuiltinWorkflow()` + `store.isPluginInstalled()` pair the
   * `enabledBuiltinWorkflowIds` sanitizer in `PUT /api/settings` uses.
   */
  it("refuses a plugin-gated built-in whose plugin is not installed", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding");

    /*
     * Why the premise is not "explicitly enabled but not installed": the settings seam already
     * REFUSES to persist such a list, so that state can only arrive from an older build's settings
     * row. Both halves are pinned — the sanitizer that makes the state unreachable going forward, and
     * the default-workflow gate that still refuses the id.
     */
    await expect(
      store.updateSettings({
        enabledBuiltinWorkflowIds: ["builtin:coding", "builtin:compound-engineering"],
      } as never),
    ).rejects.toThrow(/plugin-gated/);
    expect(await store.isPluginInstalled("fusion-plugin-compound-engineering")).toBe(false);

    const refusal = await validateProjectDefaultWorkflowRef(store, "builtin:compound-engineering");
    expect(refusal).toContain("'builtin:compound-engineering'");
    expect(refusal).not.toMatch(/not found/i);

    await expect(store.setDefaultWorkflowId("builtin:compound-engineering")).rejects.toThrow(
      /builtin:compound-engineering/,
    );
    expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
  });

  /*
   * Fragments were the ONE shape already refused before this task; the sentence is the shipped one and
   * is pinned verbatim so the new built-in branch cannot silently reword it.
   */
  it("still refuses a fragment with the pre-existing sentence", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding");

    expect(await validateProjectDefaultWorkflowRef(store, "builtin:pr-workflow")).toBe(
      "Workflow 'builtin:pr-workflow' is a fragment and cannot be set as the project default",
    );
    await expect(store.setDefaultWorkflowId("builtin:pr-workflow")).rejects.toThrow(
      /is a fragment and cannot be set as the project default/,
    );
    expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
  });

  it("clears the setting through the same seam (null is always legal)", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:marketing");
    expect(await store.getDefaultWorkflowId()).toBe("builtin:marketing");

    expect(await validateProjectDefaultWorkflowRef(store, null)).toBeUndefined();
    await store.setDefaultWorkflowId(null);

    /*
     * "Cleared" is proven on the stored key, not on the effective id: `resolveEffectiveDefaultWorkflowId`
     * answers an unset default with the first enabled catalog workflow, so asserting `undefined` here
     * would only restate a read-side rule this task must not change.
     */
    const { defaultWorkflowId } = await store.getSettings();
    expect(defaultWorkflowId ?? null).toBeNull();
    expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
  });

  /*
   * FNXC:DefaultWorkflowWriteValidation 2026-10-14-23:58 (RUFU-391):
   * The import surface is the one where the CHECK'S POSITION, not just its existence, is the bug: an
   * import applies GLOBAL settings before PROJECT settings, so a verdict taken mid-write would leave a
   * half-applied payload behind a failure. The payload below therefore carries a global key alongside the
   * bad default, and the case asserts that key is STILL UNCHANGED — proof the refusal happened before the
   * first write rather than after the global section landed.
   */
  describe("settings import", () => {
    it("imports a default workflow id that resolves", async () => {
      const store = h.store();
      const definition = await store.createWorkflowDefinition({
        name: "imported default",
        ir: customIr("imported default"),
      });

      const result = await importSettings(store, {
        version: 2,
        exportedAt: new Date().toISOString(),
        project: { defaultWorkflowId: definition.id },
      } as SettingsExportData, { scope: "project" });

      expect(result.success).toBe(true);
      expect(await store.getDefaultWorkflowId()).toBe(definition.id);
    });

    it("refuses an unresolvable default and writes nothing, not even the global section", async () => {
      const store = h.store();
      const before = await store.getGlobalSettingsStore().getSettings();
      await store.setDefaultWorkflowId("builtin:coding");

      const result = await importSettings(store, {
        version: 2,
        exportedAt: new Date().toISOString(),
        global: { theme: before.theme === "dark" ? "light" : "dark" },
        project: { defaultWorkflowId: "wf-from-a-different-machine" },
      } as SettingsExportData, { scope: "both" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("'wf-from-a-different-machine'");
      expect(await store.getGlobalSettingsStore().getSettings()).toEqual(before);
      expect(await store.getDefaultWorkflowId()).toBe("builtin:coding");
    });

    it("accepts a null default as a clear", async () => {
      const store = h.store();
      await store.setDefaultWorkflowId("builtin:marketing");

      const result = await importSettings(store, {
        version: 2,
        exportedAt: new Date().toISOString(),
        project: { defaultWorkflowId: null },
      } as SettingsExportData, { scope: "project" });

      expect(result.success).toBe(true);
      const { defaultWorkflowId } = await store.getSettings();
      expect(defaultWorkflowId ?? null).toBeNull();
    });
  });

  /*
   * The read half of the invariant, pinned as a control on the GATE test: tightening writes must not
   * smuggle in a read-side fallback. An id persisted BEFORE it became un-settable (here: written
   * around the gate, the way an older build or a direct settings file edit would) must keep reading
   * back exactly, and `resolveEffectiveDefaultWorkflowId` must still hand a custom id straight through
   * rather than substituting a fallback. If a future change "fixes" the read side to be defensive,
   * this case is what shows an existing project's routing changed underneath it.
   */
  it("leaves read-side resolution of an unresolvable legacy value untouched", async () => {
    const store = h.store();
    await store.updateSettings({ defaultWorkflowId: "wf-retained-from-an-older-build" } as never);

    expect(await store.getDefaultWorkflowId()).toBe("wf-retained-from-an-older-build");
    expect(resolveEffectiveDefaultWorkflowId("wf-retained-from-an-older-build", undefined)).toBe(
      "wf-retained-from-an-older-build",
    );
  });
});
