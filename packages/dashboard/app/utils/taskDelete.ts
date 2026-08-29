export interface DependencyDeleteConflict {
  dependentIds: string[];
}

export interface LineageDeleteConflict {
  lineageChildIds: string[];
}

export function extractDependencyDeleteConflict(err: unknown): DependencyDeleteConflict | null {
  if (!(err instanceof Error)) {
    return null;
  }

  const details = (err as { details?: { code?: string; dependentIds?: unknown } }).details;
  if (details?.code === "TASK_HAS_DEPENDENTS" && Array.isArray(details.dependentIds)) {
    return { dependentIds: details.dependentIds.filter((id): id is string => typeof id === "string") };
  }

  const idsInMessage = err.message.match(/[A-Z]+-\d+/g) ?? [];
  if (idsInMessage.length > 1) {
    return { dependentIds: [...new Set(idsInMessage.slice(1))] };
  }

  return null;
}

export function extractLineageDeleteConflict(err: unknown): LineageDeleteConflict | null {
  if (!(err instanceof Error)) {
    return null;
  }

  const details = (err as { details?: { code?: string; lineageChildIds?: unknown } }).details;
  if (details?.code !== "TASK_HAS_LINEAGE_CHILDREN" || !Array.isArray(details.lineageChildIds)) {
    return null;
  }

  return {
    lineageChildIds: details.lineageChildIds.filter((id): id is string => typeof id === "string"),
  };
}
