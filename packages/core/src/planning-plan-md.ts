import type { PlanningSummary } from "./types.js";

/*
FNXC:PlanningMode 2026-07-20-12:00:
FN-8441 makes plan.md Planning Mode's lean, durable operator product. Triage alone
expands it into PROMPT.md; priority remains a task-row field and is never serialized here.
*/
export function formatPlanningPlanMd(summary: PlanningSummary): string {
  const dependencies = summary.suggestedDependencies.length > 0
    ? summary.suggestedDependencies.map((dependency) => `- ${dependency}`).join("\n")
    : "_None_";
  const deliverables = summary.keyDeliverables.length > 0
    ? summary.keyDeliverables.map((deliverable) => `- ${deliverable}`).join("\n")
    : "_None_";

  return `# ${summary.title}\n\n${summary.description}\n\n## Size\n${summary.suggestedSize}\n\n## Suggested dependencies\n${dependencies}\n\n## Key deliverables\n${deliverables}\n`;
}

/*
FNXC:PlanningMode 2026-07-20-16:00:
A plan description may itself mention plan.md headings. Parse only the final, exact
canonical section sequence emitted by formatPlanningPlanMd so user prose cannot truncate
round trips or the fail-soft original-description body.
*/
export function parsePlanningPlanMd(text: string): Partial<PlanningSummary> | null {
  const canonical = text.match(
    /^#\s+(.+)\n\n([\s\S]*)\n\n## Size\n([SML])\n\n## Suggested dependencies\n([\s\S]*?)\n\n## Key deliverables\n([\s\S]*?)\n?$/,
  );
  if (!canonical) return null;

  const [, rawTitle, description, rawSize, dependencies, deliverables] = canonical;
  const list = (value: string) => value.trim() === "_None_"
    ? []
    : value.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  return {
    title: rawTitle!.trim(),
    description: description!.trim(),
    suggestedSize: rawSize as PlanningSummary["suggestedSize"],
    suggestedDependencies: list(dependencies!),
    keyDeliverables: list(deliverables!),
  };
}
