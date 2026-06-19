import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import packageJson from "../../package.json";
import plugin from "../index.js";
import { COMPOUND_ENGINEERING_SKILLS } from "../skills.js";
import { settingsSchema } from "../settings.js";

describe("compound engineering plugin manifest", () => {
  it("exports expected plugin id", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-compound-engineering");
  });

  it("keeps runtime manifest metadata aligned with manifest.json", () => {
    expect(plugin.manifest.id).toBe(manifest.id);
    expect(plugin.manifest.name).toBe(manifest.name);
    expect(plugin.manifest.version).toBe(manifest.version);
    expect(plugin.manifest.description).toBe(manifest.description);
    expect(plugin.manifest.author).toBe(manifest.author);
    expect(plugin.manifest.fusionVersion).toBe(manifest.fusionVersion);
  });

  it("registers a single dashboard view", () => {
    expect(plugin.dashboardViews).toEqual([
      {
        viewId: "compound-engineering",
        label: "Compound Engineering",
        componentPath: "./dashboard-view",
        icon: "Sparkles",
        placement: "primary",
        order: 36,
      },
    ]);
    expect(manifest.dashboardViews).toEqual(plugin.dashboardViews);
  });

  it("registers the session orchestration routes (U5)", () => {
    const paths = (plugin.routes ?? []).map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "POST /sessions",
        "POST /sessions/:id/answer",
        "POST /sessions/:id/resume",
        "GET /sessions/:id",
        "GET /sessions",
      ]),
    );
  });

  it("wires onSchemaInit for the plugin-local CE tables (U5)", () => {
    expect(typeof plugin.hooks.onSchemaInit).toBe("function");
  });

  it("registers the bundled CE pipeline-stage skills on plugin and manifest (U2)", () => {
    const expectedIds = [
      "ce-strategy",
      "ce-ideate",
      "ce-brainstorm",
      "ce-plan",
      "ce-work",
      "ce-code-review",
      "ce-debug",
      "ce-compound",
      "ce-commit",
      "ce-commit-push-pr",
      "ce-resolve-pr-feedback",
    ];
    expect(COMPOUND_ENGINEERING_SKILLS.map((s) => s.skillId)).toEqual(expectedIds);
    expect(plugin.skills).toBe(COMPOUND_ENGINEERING_SKILLS);
    // Manifest mirrors agent-browser: { skillId, name } projection.
    expect(plugin.manifest.skills).toEqual(
      COMPOUND_ENGINEERING_SKILLS.map((s) => ({ skillId: s.skillId, name: s.name })),
    );
    // Each contribution points at a plugin-root-relative bundled SKILL.md.
    for (const s of COMPOUND_ENGINEERING_SKILLS) {
      expect(s.skillFiles).toEqual([`skills/${s.skillId}/SKILL.md`]);
    }
  });

  it("registers an onLoad hook that installs bundled skills (U2)", () => {
    expect(typeof plugin.hooks?.onLoad).toBe("function");
  });

  it("copies dashboard CSS into dist during build", () => {
    expect(packageJson.scripts.build).toContain("tsc");
    expect(packageJson.scripts.build).toContain("node scripts/copy-css.mjs");
  });

  it("wires the settings schema onto the runtime manifest and manifest.json (U9)", () => {
    const expectedKeys = [
      "defaultProvider",
      "defaultModelId",
      "disabledStages",
      "reconcileOnHooks",
      "reconcileIntervalMinutes",
    ].sort();
    expect(plugin.manifest.settingsSchema).toBe(settingsSchema);
    expect(Object.keys(settingsSchema).sort()).toEqual(expectedKeys);
    // manifest.json mirrors the same keys (runtime/JSON alignment).
    expect(Object.keys(manifest.settingsSchema).sort()).toEqual(expectedKeys);
    // Spot-check one entry stays aligned between JSON and runtime.
    expect(manifest.settingsSchema.reconcileIntervalMinutes.defaultValue).toBe(
      settingsSchema.reconcileIntervalMinutes.defaultValue,
    );
  });
});
