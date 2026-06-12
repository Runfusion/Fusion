import { describe, expect, it } from "vitest";
import {
  FRONTEND_UX_CRITERIA_SECTION,
  applyFrontendUxCriteria,
  matchesFrontendUxPath,
} from "../frontend-ux-policy.js";
import { WORKFLOW_STEP_TEMPLATES } from "../types.js";

const EXACT_FRONTEND_UX_CRITERIA = `## Frontend UX Criteria

- [ ] **Design tokens only** — no hardcoded \`px\` values except \`0\`, no hardcoded hex/rgb colors; use CSS custom properties (\`--color-*\`, \`--spacing-*\`, etc.)
- [ ] **Icon sizing** — match the surrounding component's icon size convention (default lucide size unless the local pattern already uses an explicit \`size={N}\`)
- [ ] **Semantic color tokens for status** — use \`--color-error\` for stderr/error states, \`--color-warning\` for starting/pending states; never hardcode status colors
- [ ] **Component reuse** — reach for existing classes (\`.btn\`, \`.btn-icon\`, \`.card\`, \`.input\`) before writing one-off styles
- [ ] **Responsive scaffolding** — add \`@media (max-width: 768px)\` overrides for any new layout; verify mobile usability
- [ ] **Single canonical nav destination** — each route must appear in exactly one of: Header primary nav, Header overflow menu, or MobileNavBar More; no duplicates across all three
- [ ] **Status-indicator dot convention** — use the existing \`.status-dot\` pattern (size, border, animation) rather than custom dot styling
- [ ] **Visual hierarchy preserved** — new elements must not disrupt heading levels, content flow, or information architecture established in the surrounding page
`;

function promptWithFileScope(paths: string[]): string {
  return `# Task: FN-0000 - Example

## Mission

Implement the requested change without disturbing surrounding behavior.

## File Scope

${paths.map((path) => `- \`${path}\``).join("\n")}

## Acceptance Criteria

- Works as expected
`;
}

function extractInsertedCriteria(prompt: string): string {
  const start = prompt.indexOf("## Frontend UX Criteria");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = prompt.slice(start);
  expect(rest.slice(FRONTEND_UX_CRITERIA_SECTION.length)).toMatch(/^\n## File Scope/);
  return rest.slice(0, FRONTEND_UX_CRITERIA_SECTION.length);
}

describe("frontend UX policy", () => {
  it("preserves the byte-exact criteria section fixture", () => {
    expect(FRONTEND_UX_CRITERIA_SECTION).toBe(EXACT_FRONTEND_UX_CRITERIA);
    expect(FRONTEND_UX_CRITERIA_SECTION.endsWith("\n")).toBe(true);
    expect(FRONTEND_UX_CRITERIA_SECTION.endsWith("\n\n")).toBe(false);
  });

  it.each([
    ["dashboard package", "packages/dashboard/src/server.ts"],
    ["app components", "packages/plugin/app/components/Button.tsx"],
    ["app hooks", "packages/plugin/app/hooks/useThing.ts"],
    ["app css", "packages/plugin/app/layout.css"],
    ["app tsx", "packages/plugin/app/routes.tsx"],
  ])("injects exactly once after Mission for %s scope", (_label, path) => {
    const original = promptWithFileScope([path]);
    const injected = applyFrontendUxCriteria(original);

    expect(injected).toContain(FRONTEND_UX_CRITERIA_SECTION);
    expect(extractInsertedCriteria(injected)).toBe(FRONTEND_UX_CRITERIA_SECTION);
    expect(injected.match(/## Frontend UX Criteria/g)).toHaveLength(1);
    expect(injected).toMatch(/## Mission\n\nImplement the requested change without disturbing surrounding behavior\.\n\n## Frontend UX Criteria\n\n- \[ \] \*\*Design tokens only\*\*/);
    expect(applyFrontendUxCriteria(injected)).toBe(injected);
  });

  it.each([
    ["backend", "packages/engine/src/triage.ts"],
    ["config json", "package.json"],
    ["eslint config", "eslint.config.mjs"],
    ["docs", "docs/dashboard-guide.md"],
    ["dashboard src css excluded from rule 4 but matched by dashboard package", "packages/dashboard/src/styles.css", true],
    ["component css covered by component rule, not rule 4", "packages/plugin/app/components/Button.css", true],
  ])("matches the expected frontend classification for %s", (_label, path, expected = false) => {
    expect(matchesFrontendUxPath(path)).toBe(expected);
  });

  it("does not inject for backend-only, config-only, or docs-only file scopes", () => {
    for (const path of ["packages/engine/src/triage.ts", "package.json", "eslint.config.mjs", "docs/testing.md"]) {
      const original = promptWithFileScope([path]);
      expect(applyFrontendUxCriteria(original)).toBe(original);
    }
  });

  it("uses caller-provided file scope paths without reparsing prompt markdown", () => {
    const promptWithoutFileScope = `# Task: FN-0000 - Example

## Mission

Implement dashboard UI.

## Acceptance Criteria

- Works as expected
`;

    const injected = applyFrontendUxCriteria(promptWithoutFileScope, ["packages/dashboard/app/routes.tsx"]);

    expect(injected).toContain(FRONTEND_UX_CRITERIA_SECTION);
    expect(injected.match(/## Frontend UX Criteria/g)).toHaveLength(1);
  });

  it("keeps checklist tokens aligned with the frontend UX design persona", () => {
    const persona = WORKFLOW_STEP_TEMPLATES.find((template) => template.id === "frontend-ux-design");
    expect(persona?.name).toBe("Frontend UX Design");
    expect(persona?.prompt).toContain("design tokens");
    expect(persona?.prompt).toContain("Component Reuse");
    expect(persona?.prompt).toContain("Responsive Behavior");
    expect(persona?.prompt).toContain("Visual Hierarchy");

    expect(FRONTEND_UX_CRITERIA_SECTION).toContain("Design tokens only");
    expect(FRONTEND_UX_CRITERIA_SECTION).toContain("Component reuse");
    expect(FRONTEND_UX_CRITERIA_SECTION).toContain("Responsive scaffolding");
    expect(FRONTEND_UX_CRITERIA_SECTION).toContain("Visual hierarchy preserved");
  });
});
