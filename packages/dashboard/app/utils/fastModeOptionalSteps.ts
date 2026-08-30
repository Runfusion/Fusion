/*
 * FNXC:FastOptionalSteps 2026-08-29-12:08:
 * Fast is a reversible composer preference. Leaving Fast restores the captured pre-Fast selection
 * merged with steps explicitly enabled while Fast was active, so neither direction of operator
 * intent is destroyed. A null baseline falls back to the workflow defaultOn seed because standard
 * mode would have produced that selection.
 */

/** Restores optional workflow steps after a composer leaves Fast mode without mutating its inputs. */
export function restoreOptionalStepsOnFastExit(
  baseline: readonly string[] | null,
  currentEnabledIds: readonly string[],
  defaultOnIds: readonly string[],
): string[] {
  const restored: string[] = [];
  const seen = new Set<string>();

  for (const id of baseline ?? defaultOnIds) {
    if (!seen.has(id)) {
      seen.add(id);
      restored.push(id);
    }
  }

  for (const id of currentEnabledIds) {
    if (!seen.has(id)) {
      seen.add(id);
      restored.push(id);
    }
  }

  return restored;
}
