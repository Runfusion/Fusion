import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
FNXC:AgentSettingsTheming 2026-07-23-13:01:
Agent Settings is composed from local and portaled controls, so its theme contract must guard every control family and state rather than relying on a screenshot of one populated dark-theme form. These source-level assertions keep surfaces, text, borders, focus, disabled, selected, validation, and responsive layouts token-driven across themes.
*/
const APP = resolve(__dirname, "..");
const css = {
  detail: readFileSync(resolve(APP, "components/AgentDetailView.css"), "utf8"),
  model: readFileSync(resolve(APP, "components/CustomModelDropdown.css"), "utf8"),
  skills: readFileSync(resolve(APP, "components/SkillMultiselect.css"), "utf8"),
  policy: readFileSync(resolve(APP, "components/AgentPermissionPolicyEditor.css"), "utf8"),
};

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `Missing ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
    end += 1;
  }
  return source.slice(start, end);
}

function mediaBlock(source: string, query: string): string {
  return block(source, `@media (max-width: ${query})`);
}

function expectsTokenizedControl(source: string, selector: string) {
  const rule = block(source, selector);
  expect(rule).toMatch(/(?:background|color|border(?:-color)?|box-shadow):\s*(?:var\(|color-mix\()/);
}

describe("agent Settings theme styling", () => {
  it("keeps each Settings control family and state theme-token driven", () => {
    const inventory: Array<[string, string]> = [
      [css.detail, ".config-section"],
      [css.detail, ".config-section .input,"],
      [css.detail, ".agent-avatar-editor-actions .agent-avatar-editor-action"],
      [css.detail, ".config-runtime-tab"],
      [css.detail, ".config-runtime-tab:focus-visible"],
      [css.detail, ".config-runtime-tab.active"],
      [css.model, ".model-combobox-trigger"],
      [css.model, ".model-combobox-dropdown"],
      [css.model, ".model-combobox-search"],
      [css.model, ".model-combobox-option--selected"],
      [css.skills, ".skill-multiselect"],
      [css.skills, ".skill-multiselect-dropdown"],
      [css.skills, ".skill-chip"],
      [css.skills, ".skill-chip-remove:focus-visible"],
      [css.skills, ".skill-multiselect-loading,"],
      [css.policy, ".agent-policy-editor"],
      [css.policy, ".agent-policy-row"],
      [css.policy, ".agent-policy-tool-row,"],
    ];
    inventory.forEach(([source, selector]) => expectsTokenizedControl(source, selector));

    expect(css.detail).toContain(".config-section .input::placeholder");
    expect(css.detail).toContain(".config-section .input:disabled");
    expect(block(css.detail, ".input--error")).toContain("var(--color-error)");
    expect(block(css.detail, ".config-saved-indicator")).toContain("var(--color-success)");
    expect(block(css.skills, ".skill-chip-remove:disabled")).toContain("var(--opacity-disabled");
    expect(block(css.model, ".model-combobox-trigger:disabled")).toContain("var(--opacity-disabled");
  });

  it("uses no raw colors or nonzero pixel declarations in scoped Settings rules", () => {
    const scopedRules = [
      block(css.detail, ".config-section .input,"), block(css.detail, ".agent-avatar-editor-actions"), block(css.detail, ".config-runtime-tab"),
      block(css.model, ".model-combobox-trigger"), block(css.model, ".model-combobox-dropdown"), block(css.skills, ".skill-multiselect"), block(css.skills, ".skill-chip"), block(css.policy, ".agent-policy-editor"),
    ].join("\n");
    expect(scopedRules).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(scopedRules).not.toMatch(/(?<![\w-])(?:[1-9]\d*)px\b/);
  });

  it("keeps desktop and compact Settings controls mechanically responsive", () => {
    const detailMobile = mediaBlock(css.detail, "768px");
    [".config-tab", ".config-section", ".config-section .input", ".config-actions", ".config-actions .btn", ".agent-avatar-editor-actions", ".config-runtime-tabs", ".config-runtime-tab"].forEach((selector) => expect(detailMobile).toContain(selector));
    expect(detailMobile).toMatch(/\.config-actions\s*\{[\s\S]*flex-direction:\s*column/);
    expect(detailMobile).toMatch(/\.config-actions \.btn\s*\{[\s\S]*width:\s*100%/);
    expect(detailMobile).toMatch(/\.config-runtime-tabs\s*\{[\s\S]*grid-template-columns:\s*1fr/);

    const compact = mediaBlock(css.detail, "480px");
    expect(compact).toContain(".config-actions");
    expect(compact).toContain(".agent-avatar-editor-actions");
    expect(compact).toContain(".config-runtime-tabs");
    expect(compact).toContain(".skill-multiselect");

    const modelMobile = mediaBlock(css.model, "768px");
    expect(modelMobile).toContain(".model-combobox-dropdown");
    const policyMobile = mediaBlock(css.policy, "768px");
    expect(policyMobile).toContain(".agent-policy-row");
    expect(policyMobile).toContain(".agent-policy-tool-row");
    const skillsMobile = mediaBlock(css.skills, "768px");
    expect(skillsMobile).toContain(".skill-multiselect");
    expect(skillsMobile).toContain(".skill-chip");
  });
});
