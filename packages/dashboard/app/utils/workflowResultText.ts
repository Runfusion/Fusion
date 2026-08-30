/*
FNXC:WorkflowResultText 2026-08-28-13:46:
Structured verdicts from parseWorkflowStepOutput and plan-review satisfaction results deliberately mirror one human-readable report into output and notes. Preserve that producer contract for downstream consumers and collapse equivalent or contained copies only in presentation helpers so operators never see duplicated review prose.
*/
export function normalizeWorkflowResultText(value?: string): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

export function workflowResultTextsAreEquivalent(a?: string, b?: string): boolean {
  const normalizedA = normalizeWorkflowResultText(a);
  const normalizedB = normalizeWorkflowResultText(b);
  return normalizedA.length > 0 && normalizedA === normalizedB;
}

export function workflowResultBodyParts(output?: string, notes?: string): string[] {
  const trimmedOutput = output?.trim() ?? "";
  const trimmedNotes = notes?.trim() ?? "";
  if (!trimmedOutput && !trimmedNotes) return [];
  if (!trimmedOutput) return [trimmedNotes];
  if (!trimmedNotes) return [trimmedOutput];

  const normalizedOutput = normalizeWorkflowResultText(trimmedOutput);
  const normalizedNotes = normalizeWorkflowResultText(trimmedNotes);
  if (normalizedOutput.includes(normalizedNotes)) return [trimmedOutput];
  if (normalizedNotes.includes(normalizedOutput)) return [trimmedNotes];
  return [trimmedOutput, trimmedNotes];
}
