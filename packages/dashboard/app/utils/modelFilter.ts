import type { ModelInfo } from "../api";

/**
 * Filter models by search terms matching provider, id, or name.
 * Supports multi-word filters (space-separated AND logic).
 * Case-insensitive substring matching.
 */
export function filterModels(models: ModelInfo[], filter: string): ModelInfo[] {
  const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;
  return models.filter((m) => {
    const haystack = `${m.provider} ${m.id} ${m.name}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
