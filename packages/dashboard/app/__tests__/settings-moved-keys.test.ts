/**
 * Moved-key removal sweep (U9 / KTD-5, R10).
 *
 * After the hard-move (U4), every key in `MOVED_SETTINGS_KEYS` lives exclusively
 * as a workflow setting value. None of them may be renderable or savable from the
 * Settings modal anymore. A DOM sweep of every section is expensive and flaky, so
 * we use the consistency-test pattern instead: assert the modal's source (and its
 * extracted Project section components) never bind a moved key to a form
 * control — i.e. no `form.<movedKey>` read and no `<movedKey>:` write inside a
 * `setForm`/`setPresetDraft`-shaped object literal.
 *
 * The intentional exceptions are redirect stubs and descriptor tables, which
 * only NAME keys as string values. We therefore match precise form-binding
 * shapes (`form.<key>` and `<key>:`), not descriptive text.
 *
 * FNXC:ProjectModels 2026-09-14-19:24:
 * Pipeline role lanes are no longer moved keys: project Settings and workflow Values are separate authorities for the same role vocabulary. Keep the role-key assertion separate from the source census so adding legitimate project controls cannot be mistaken for resurrecting a retired moved setting.
 */
import { describe, it, expect } from "vitest";
import { MOVED_SETTINGS_KEYS } from "@fusion/core";
import { listComponentFiles, readAppFile } from "../test/cssFixture";

/**
 * Files that compose the modal's editable surface: the shell plus every
 * extracted section component. The sections are discovered by walking the
 * directory (not a hardcoded list) so a newly added section is swept
 * automatically and a moved-key binding cannot slip in unnoticed.
 */
const SURFACE_FILES = listComponentFiles().filter(
  (file) => file === "SettingsModal.tsx" || (file.startsWith("settings/sections/") && !file.includes("/__tests__/")),
);

/**
 * Keys that are also legitimately referenced as nested object properties on
 * non-settings shapes (e.g. `ModelPreset.validatorProvider`, a preset draft
 * field that is NOT the top-level project setting). For these we only forbid the
 * `form.<key>` read shape, which unambiguously binds the project setting.
 */
const PRESET_NESTED_KEYS = new Set<string>();

const PROJECT_ROLE_SETTING_KEYS = [
  "planningProvider", "planningModelId", "planningThinkingLevel", "planningCredentialInstanceId",
  "planningFallbackProvider", "planningFallbackModelId", "planningFallbackThinkingLevel", "planningFallbackCredentialInstanceId",
  "executionProvider", "executionModelId", "executionThinkingLevel", "executionCredentialInstanceId",
  "executionFallbackProvider", "executionFallbackModelId", "executionFallbackThinkingLevel", "executionFallbackCredentialInstanceId",
  "validatorProvider", "validatorModelId", "validatorThinkingLevel", "validatorCredentialInstanceId",
  "validatorFallbackProvider", "validatorFallbackModelId", "validatorFallbackThinkingLevel", "validatorFallbackCredentialInstanceId",
  "mergerProvider", "mergerModelId", "mergerThinkingLevel", "mergerCredentialInstanceId",
  "mergerFallbackProvider", "mergerFallbackModelId", "mergerFallbackThinkingLevel", "mergerFallbackCredentialInstanceId",
] as const;

describe("SettingsModal moved-key removal sweep", () => {
  it("contains no workflow-owned model persistence or residual project workflow-lane controls", () => {
    const removed = ["workflow-model-lane-", "project-models-workflow-lanes", "workflowLanesSubheading", "WORKFLOW_MODEL_PAIRS", "registerWorkflowLaneSaver", "WorkflowLaneFlushRejection", "onWorkflowLanesChange", "settings.movedStub.modelLanes", "theseProjectOverridesApplyToTheActiveDefault"];
    for (const file of listComponentFiles().filter((file) => !file.split("/").includes("__tests__"))) {
      const source = readAppFile(`components/${file}`);
      for (const token of removed) expect(source, `${file}: ${token}`).not.toContain(token);
    }
    const english = JSON.parse(readAppFile("../../i18n/locales/en/app.json"));
    expect(english.settings.movedStub.modelLanes).toBeUndefined();
    expect(english.settings.projectModels.workflowLanesSubheading).toBeUndefined();
    expect(english.settings.projectModels.theseProjectOverridesApplyToTheActiveDefault).toBeUndefined();
    expect(english.settings.models.roleFallbackHelp).toBeTruthy();
  });
  it("keeps project role model lanes out of the historical moved-key tombstone", () => {
    for (const key of PROJECT_ROLE_SETTING_KEYS) expect(MOVED_SETTINGS_KEYS).not.toContain(key);
  });

  for (const file of SURFACE_FILES) {
    const source = readAppFile(`components/${file}`);

    for (const key of MOVED_SETTINGS_KEYS) {
      it(`${file} does not read form.${key}`, () => {
        // The form-binding read shape: `form.<movedKey>` (word boundary).
        const formRead = new RegExp(`\\bform\\.${key}\\b`);
        expect(source).not.toMatch(formRead);
      });

      if (!PRESET_NESTED_KEYS.has(key)) {
        it(`${file} does not write ${key} into a form patch`, () => {
          // The form-write shape inside a setForm object literal: `<key>:`.
          // Allowed: descriptor table entries (`projectProviderKey: "<key>"`),
          // which quote the key as a value, never as an object KEY.
          const formWrite = new RegExp(`(^|[\\s{,])${key}\\s*:`, "m");
          expect(source).not.toMatch(formWrite);
        });
      }
    }
  }
});
