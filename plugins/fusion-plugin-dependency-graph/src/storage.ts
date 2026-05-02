const BASE_KEY = "dependency-graph-positions";

export function projectScopedKey(projectId?: string): string {
  const suffix = projectId ?? "default";
  return `kb:${suffix}:${BASE_KEY}`;
}

export function loadPositions(projectId?: string): Record<string, { x: number; y: number }> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(projectScopedKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function savePositions(projectId: string | undefined, positions: Record<string, { x: number; y: number }>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(projectScopedKey(projectId), JSON.stringify(positions));
}
