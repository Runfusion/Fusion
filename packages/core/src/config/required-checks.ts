/**
 * FNXC:PrMergeRequiredChecks 2026-08-09-06:39:
 * Fusion-side PR check names are shared by CLI, dashboard, routes, and settings UI.
 * Keep normalization in core because the CLI deliberately has no dashboard dependency;
 * empty input preserves GitHub's legacy required-check policy while absent names block.
 */
export function resolveRequiredCheckNames(settings?: { requiredChecks?: unknown }): string[] {
  if (!Array.isArray(settings?.requiredChecks)) return [];
  const names = new Set<string>();
  for (const value of settings.requiredChecks) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (name) names.add(name);
  }
  return [...names];
}
