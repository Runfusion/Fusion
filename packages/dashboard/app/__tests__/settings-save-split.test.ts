/**
 * Characterization of SettingsModal's save-split (U9 / KTD-10).
 *
 * Pins the regression-critical behavior the redesign must preserve byte-for-byte:
 *   - one global + one project edit in a single session produce the expected
 *     `updateGlobalSettings` / `updateSettings` patches with strict scope routing;
 *   - clearing a project override emits null-as-delete;
 *   - untouched inherited project values are NOT written (changed-only gate);
 *   - explicit clears of global keys emit null, plain undefined is dropped.
 *
 * The split logic was lifted out of the modal into the pure `splitSettingsSave`
 * helper; this test exercises it against the real `@fusion/core` key predicates
 * so it stays honest about which keys land in which scope.
 */
import { describe, it, expect } from "vitest";
import { isGlobalSettingsKey, isProjectSettingsKey } from "@fusion/core";
import { splitSettingsSave, MODEL_LANE_KEYS } from "../components/settings/save-split";

// Sanity-anchor the scope of the concrete keys this test relies on, so the
// assertions below remain meaningful if core's catalog ever shifts.
describe("scope anchors", () => {
  it("language and ntfyTopic are global; maxConcurrent and integrationBranch are project", () => {
    expect(isGlobalSettingsKey("language")).toBe(true);
    expect(isGlobalSettingsKey("ntfyTopic")).toBe(true);
    expect(isProjectSettingsKey("maxConcurrent")).toBe(true);
    expect(isProjectSettingsKey("integrationBranch")).toBe(true);
    expect(isProjectSettingsKey("enabledBuiltinWorkflowIds")).toBe(true);
  });

  it("every MODEL_LANE_KEYS entry is a project settings key", () => {
    // MODEL_LANE_KEYS only gates project-branch behavior, which is reached only
    // for keys that pass isProjectSettingsKey. Any entry that fails this check is
    // dead (e.g. a per-phase model lane that moved to workflow settings).
    expect(MODEL_LANE_KEYS.length).toBeGreaterThan(0);
    for (const key of MODEL_LANE_KEYS) {
      expect(isProjectSettingsKey(key)).toBe(true);
    }
  });
});

describe("splitSettingsSave", () => {
  it("routes one global + one project edit into the right patches", () => {
    const initialValues = { language: "en", maxConcurrent: 2 } as never;
    const initialScopedValues = {
      global: { language: "en" },
      project: { maxConcurrent: 2 },
    } as never;

    const payload: Record<string, unknown> = {
      language: "fr", // global edit
      maxConcurrent: 5, // project edit
    };

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload,
      initialValues,
      initialScopedValues,
      activeSection: "global-general",
    });

    expect(globalPatch).toEqual({ language: "fr" });
    expect(projectPatch).toEqual({ maxConcurrent: 5 });
  });

  it("does not write project values that match the initial project-scoped value (changed-only gate)", () => {
    // The gate compares the payload value against the initial *project-scoped*
    // value: a value equal to its initial override is not re-written. This is
    // what prevents every save from re-persisting unchanged overrides.
    const initialScopedValues = {
      global: {},
      project: { maxConcurrent: 3, integrationBranch: "main" },
    } as never;

    const payload: Record<string, unknown> = {
      maxConcurrent: 3, // unchanged override → skip
      integrationBranch: "main", // unchanged override → skip
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({});
  });

  it("writes a project value that differs from the initial project-scoped value", () => {
    const initialScopedValues = {
      global: {},
      project: { maxConcurrent: 3 },
    } as never;

    const payload: Record<string, unknown> = {
      maxConcurrent: 7, // changed from the initial override
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({ maxConcurrent: 7 });
  });

  it("routes enabled built-in workflow ids as a changed project setting", () => {
    const { projectPatch } = splitSettingsSave({
      payload: { enabledBuiltinWorkflowIds: ["builtin:coding"] },
      initialValues: null,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({ enabledBuiltinWorkflowIds: ["builtin:coding"] });
  });

  it("excludes customProviders from both global and project patches", () => {
    expect(isGlobalSettingsKey("customProviders")).toBe(true);

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload: {
        customProviders: [
          {
            id: "x",
            name: "Provider X",
            baseUrl: "https://example.test/v1",
            apiKey: "secret",
            models: [{ id: "model-x", name: "Model X" }],
          },
        ],
      },
      initialValues: { customProviders: [] } as never,
      initialScopedValues: { global: { customProviders: [] }, project: {} } as never,
      activeSection: "authentication",
    });

    expect("customProviders" in globalPatch).toBe(false);
    expect("customProviders" in projectPatch).toBe(false);
  });

  it("emits null-as-delete when a project override is cleared", () => {
    const initialScopedValues = {
      global: {},
      project: { integrationBranch: "release" },
    } as never;

    const payload: Record<string, unknown> = {
      integrationBranch: undefined, // user cleared the pinned branch
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({ integrationBranch: null });
  });

  it("emits null-as-delete for an explicit clear of a global key", () => {
    const initialValues = { ntfyTopic: "alerts" } as never;

    const payload: Record<string, unknown> = {
      ntfyTopic: undefined, // cleared; initial was defined → null
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "notifications",
    });

    expect(globalPatch).toEqual({ ntfyTopic: null });
  });

  it("drops plain-undefined global keys that were never set", () => {
    const payload: Record<string, unknown> = {
      ntfyTopic: undefined, // never had a value → passed through as undefined
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "notifications",
    });

    // undefined survives the object but is dropped by JSON.stringify on the wire;
    // the patch must not coerce it to null when there was nothing to clear.
    expect(globalPatch.ntfyTopic).toBeUndefined();
  });

  it("routes githubTrackingDefaultRepo to global only on the global-general section", () => {
    const payloadGlobal: Record<string, unknown> = { githubTrackingDefaultRepo: "org/repo" };
    const onGlobal = splitSettingsSave({
      payload: payloadGlobal,
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "global-general",
    });
    expect(onGlobal.globalPatch).toMatchObject({ githubTrackingDefaultRepo: "org/repo" });
    expect("githubTrackingDefaultRepo" in onGlobal.projectPatch).toBe(false);

    const onProject = splitSettingsSave({
      payload: { githubTrackingDefaultRepo: "org/repo" },
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "general",
    });
    expect("githubTrackingDefaultRepo" in onProject.globalPatch).toBe(false);
    // ...and is instead routed to the project patch on the project-scoped
    // "general" section, rather than being dropped or erroring.
    expect(onProject.projectPatch).toMatchObject({ githubTrackingDefaultRepo: "org/repo" });
  });
});
