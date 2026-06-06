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
 * The intentional exceptions are the redirect stubs and the `MODEL_LANES`
 * descriptor table, which only NAMES the keys (as `projectProviderKey` /
 * `projectModelKey` string literals) so the surviving "default" lane can be
 * rendered — those are not form bindings. We therefore match the precise binding
 * shapes (`form.<key>` and `<key>:`) and explicitly allow descriptor mentions.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MOVED_SETTINGS_KEYS } from "@fusion/core";

const here = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(here, "..", "components");
const sectionsDir = join(componentsDir, "settings", "sections");

/**
 * Files that compose the modal's editable surface: the shell plus every
 * extracted section component. The sections are discovered by walking the
 * directory (not a hardcoded list) so a newly added section is swept
 * automatically and a moved-key binding cannot slip in unnoticed.
 */
const SURFACE_FILES = [
  { dir: componentsDir, file: "SettingsModal.tsx" },
  ...readdirSync(sectionsDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((file) => ({ dir: sectionsDir, file })),
];

/**
 * Keys that are also legitimately referenced as nested object properties on
 * non-settings shapes (e.g. `ModelPreset.validatorProvider`, a preset draft
 * field that is NOT the top-level project setting). For these we only forbid the
 * `form.<key>` read shape, which unambiguously binds the project setting.
 */
const PRESET_NESTED_KEYS = new Set([
  "validatorProvider",
  "validatorModelId",
]);

describe("SettingsModal moved-key removal sweep", () => {
  for (const { dir, file } of SURFACE_FILES) {
    const source = readFileSync(join(dir, file), "utf8");

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
