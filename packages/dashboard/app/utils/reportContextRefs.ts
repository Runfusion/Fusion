/**
 * FNXC:ReportPipeline 2026-08-02-00:00:
 * FN-8348 moves report entry points from Header into Settings General and Command
 * Center. Resolve task and agent context in this shared helper so each home keeps
 * the same deep-link behavior without duplicating route parsing.
 */
export function resolveReportContextRefs(location: Pick<Location, "hash" | "search">): { taskId?: string; agentId?: string } | undefined {
  const params = new URLSearchParams(location.search);
  const hashTaskMatch = location.hash.match(/^#\/tasks\/([^/?#]+)/);
  const taskId = hashTaskMatch?.[1] ? decodeURIComponent(hashTaskMatch[1]) : params.get("taskId") ?? undefined;
  const agentId = params.get("agentId") ?? undefined;
  return taskId || agentId ? { taskId, agentId } : undefined;
}
