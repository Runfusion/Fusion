import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillsRoot = fileURLToPath(new URL("../skills/", import.meta.url));

function readSkill(relativePath: string): string {
  return readFileSync(join(skillsRoot, relativePath), "utf8");
}

function expectNoLegacyHtmlSkipLanguage(surfaces: Record<string, string>): void {
  const forbidden = [
    /ce-doc-review is markdown-only today/i,
    /Requirements review unavailable in output:html mode/i,
    /review unavailable for HTML/i,
    /ce-doc-review is skipped/i,
    /skipped_reason:\s*output_format_html/i,
    /not currently an HTML consumer/i,
    /not a current HTML consumer/i,
    /skips? (?:the )?(?:5\.3\.8 )?(?:doc-review|document-review|ce-doc-review)[^\n.]*HTML/i,
    /HTML[^\n.]*skips? (?:the )?(?:doc-review|document-review|ce-doc-review)/i,
  ];

  for (const [name, content] of Object.entries(surfaces)) {
    for (const pattern of forbidden) {
      expect(content, `${name} must not contain legacy HTML-skip language matching ${pattern}`).not.toMatch(pattern);
    }
  }
}

/*
FNXC:CompoundEngineering 2026-06-27-18:31:
FN-7147 replaces the CE document-review HTML skip with a report-only fallback path. FN-7149 permits only proven DOM-safe HTML mutations, so this guard reads the prompt-executed bundled skill text directly to prevent future upstream refreshes from reintroducing markdown mutation or HTML skip language.
*/
describe("ce-doc-review HTML report-only mode", () => {
  const docReviewSkill = readSkill("ce-doc-review/SKILL.md");
  const planSkill = readSkill("ce-plan/SKILL.md");
  const planHandoff = readSkill("ce-plan/references/plan-handoff.md");
  const brainstormHandoff = readSkill("ce-brainstorm/references/handoff.md");

  it("documents that HTML doc review is DOM-safe with report-only fallback", () => {
    expect(docReviewSkill).toMatch(/HTML artifacts may receive only the DOM-safe mutations/i);
    expect(docReviewSkill).toMatch(/same document-quality and persona-lens checks/i);
    expect(docReviewSkill).toMatch(/fall back to report-only \(`fixes_applied = 0`\)/i);
    expect(docReviewSkill).toMatch(/Append-to-Open-Questions write-back that inserts markdown/i);
    expect(docReviewSkill).toMatch(/Malformed-checklist HTML repair remains report-only/i);
    expect(docReviewSkill).toMatch(/successful DOM-safe helper fixes may increment `fixes_applied` only for the allowlisted operations/i);
  });

  it("routes ce-plan HTML artifacts through report-only review instead of a skipped envelope", () => {
    expect(planHandoff).toMatch(/HTML plans use `ce-doc-review` with DOM-safe mutation enabled only when/i);
    expect(planHandoff).toMatch(/applied_fixes_count = 0` when the helper refuses/i);
    expect(planHandoff).toMatch(/no `skipped_reason` field/i);
    expect(planHandoff).toMatch(/Free-form requests for review[^\n]*HTML plan in DOM-safe-or-report-only mode/i);
  });

  it("keeps ce-plan SKILL.md aligned with report-only HTML review", () => {
    expect(planSkill).toMatch(/For HTML plans \(`OUTPUT_FORMAT=html`\)[^\n]*still runs ce-doc-review/i);
    expect(planSkill).toMatch(/HTML reviews only apply proven DOM-safe helper fixes/i);
    expect(planSkill).toMatch(/Document review is mandatory for markdown plans and DOM-safe-or-report-only for HTML plans/i);
  });

  it("shows ce-brainstorm requirements review for HTML in report-only mode", () => {
    expect(brainstormHandoff).toMatch(/Shown when a unified plan artifact exists/i);
    expect(brainstormHandoff).toMatch(/Under `OUTPUT_FORMAT=html`, run `ce-doc-review` in DOM-safe-or-report-only mode/i);
    expect(brainstormHandoff).toMatch(/This nudge applies to markdown and HTML artifacts/i);
    expect(brainstormHandoff).toMatch(/For `\.html` artifacts, state that the review is DOM-safe-or-report-only/i);
  });


  it("keeps HTML rendering references aligned with DOM-safe fallback", () => {
    for (const [name, content] of Object.entries({
      "ce-plan/references/html-rendering.md": readSkill("ce-plan/references/html-rendering.md"),
      "ce-brainstorm/references/html-rendering.md": readSkill("ce-brainstorm/references/html-rendering.md"),
      "ce-ideate/references/html-rendering.md": readSkill("ce-ideate/references/html-rendering.md"),
    })) {
      expect(content, name).toMatch(/ce-doc-review` DOM-safe-or-report-only mode/i);
      expect(content, name).toMatch(/parse5-backed DOM-safe helper mutations/i);
      expect(content, name).toMatch(/helper refusal falls back to report-only/i);
    }
  });

  it("removes old HTML markdown-only skip language from all edited review surfaces", () => {
    expectNoLegacyHtmlSkipLanguage({
      "ce-doc-review/SKILL.md": docReviewSkill,
      "ce-plan/SKILL.md": planSkill,
      "ce-plan/references/plan-handoff.md": planHandoff,
      "ce-brainstorm/references/handoff.md": brainstormHandoff,
      "ce-brainstorm/references/html-rendering.md": readSkill("ce-brainstorm/references/html-rendering.md"),
      "ce-ideate/references/html-rendering.md": readSkill("ce-ideate/references/html-rendering.md"),
      "ce-plan/references/html-rendering.md": readSkill("ce-plan/references/html-rendering.md"),
    });
  });
});
