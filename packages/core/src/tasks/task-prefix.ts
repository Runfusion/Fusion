/**
 * FNXC:TaskPrefix 2026-06-24-18:00:
 * Derive a task prefix from a project name. Strips non-alpha characters, uppercases,
 * and takes the first 2-4 characters. Falls back to "FN" for names with fewer than
 * 2 letters. Used during project onboarding (CLI and dashboard) so each project gets
 * a recognizable prefix for task IDs (e.g. "MYPR" for "my-project").
 *
 * Note: the result is the first 2-4 letters of the cleaned (alpha-only, uppercased)
 * name, NOT the initials of each word. For "my-project" the result is "MYPR"
 * (first 4 of "MYPROJECT"), not "MP".
 */
export function suggestTaskPrefix(projectName: string): string {
  const cleaned = projectName.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (cleaned.length >= 2 && cleaned.length <= 4) return cleaned;
  if (cleaned.length > 4) return cleaned.slice(0, 4);
  return "FN";
}
