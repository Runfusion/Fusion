/*
FNXC:StandingInstructionsTemplate 2026-07-13-12:30:
Permanent agents need a consistent standing-instructions skeleton (Description / Expertise / Priorities / Boundaries / Communication / Collaboration).
Seed instructionsText only for blank custom creates and empty-state insert — never silently rewrite existing agents.
*/

/** Six-section standing instructions skeleton for permanent agents. */
export const STANDING_INSTRUCTIONS_TEMPLATE = `## Description


## Expertise


## Priorities


## Boundaries


## Communication


## Collaboration & Escalation

`;

const SECTION_HEADINGS = [
  "## Description",
  "## Expertise",
  "## Priorities",
  "## Boundaries",
  "## Communication",
  "## Collaboration & Escalation",
] as const;

/** True when instructions are empty or whitespace-only. */
export function isStandingInstructionsEmpty(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Return the template when body is empty; otherwise return the existing body unchanged.
 */
export function withStandingInstructionsTemplate(body?: string | null): string {
  if (isStandingInstructionsEmpty(body)) {
    return STANDING_INSTRUCTIONS_TEMPLATE;
  }
  return body!.trimEnd() + (body!.endsWith("\n") ? "" : "");
}

/** Whether text already contains the six section headings. */
export function hasStandingInstructionsStructure(value: string | null | undefined): boolean {
  if (!value) return false;
  return SECTION_HEADINGS.every((heading) => value.includes(heading));
}
