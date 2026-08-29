import type { BranchGroup, ExperimentSession, ExperimentSessionRecord, Task } from "@fusion/core";
import {
  ExperimentFinalizePlanError,
  type FinalizeGroup,
  type FinalizePlan,
  type FinalizePlanOverride,
  getRunRecordById,
} from "./finalize-types.js";

export function slugifyGroupTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "group";
}

function normalizeGroupLabel(record: Extract<ExperimentSessionRecord, { type: "run" }>): { groupKey: string; title: string } {
  const asi = record.payload.asi as Record<string, unknown> | undefined;
  const group = typeof asi?.group === "string" && asi.group.trim() ? asi.group.trim() : null;
  if (group) {
    return { groupKey: `asi:${group}`, title: group };
  }
  return { groupKey: `segment:${record.segment}`, title: `Segment ${record.segment}` };
}

function resolveBaselineCommit(session: ExperimentSession, records: ExperimentSessionRecord[], mergeBaseCommit: string, warnings: string[]): string {
  const metadataBaseline = session.metadata?.baselineCommit;
  if (typeof metadataBaseline === "string" && metadataBaseline.trim()) {
    return metadataBaseline.trim();
  }
  if (session.baselineRunId) {
    const baselineRun = getRunRecordById(records, session.baselineRunId);
    if (baselineRun?.payload.commit) {
      return baselineRun.payload.commit;
    }
  }
  warnings.push("no baseline commit; using merge-base as degenerate baseline");
  return mergeBaseCommit;
}

function buildBranchName(prefix: string, baseId: string, title: string, groupIndex: number, seenBranchNames: Set<string>): string {
  const slug = slugifyGroupTitle(title);
  let candidate = `${prefix}/${baseId.toLowerCase()}/${slug}-${groupIndex}`;
  let bump = 2;
  while (seenBranchNames.has(candidate)) {
    candidate = `${prefix}/${baseId.toLowerCase()}/${slug}-${groupIndex}-${bump}`;
    bump += 1;
  }
  seenBranchNames.add(candidate);
  return candidate;
}

export function buildDefaultPlan(opts: {
  session: ExperimentSession;
  records: ExperimentSessionRecord[];
  integrationBranch: string;
  mergeBaseCommit: string;
}): FinalizePlan {
  const warnings: string[] = [];
  const orphanedRunRecordIds: string[] = [];

  const keptRuns = opts.records
    .filter((record): record is Extract<ExperimentSessionRecord, { type: "run" }> => record.type === "run" && opts.session.keptRunIds.includes(record.id))
    .filter((record) => {
      if (record.payload.status !== "keep") return false;
      if (!record.payload.commit) {
        orphanedRunRecordIds.push(record.id);
        warnings.push(`kept run ${record.id} has no commit and was skipped`);
        return false;
      }
      return true;
    });

  const grouped = new Map<string, { title: string; runs: Extract<ExperimentSessionRecord, { type: "run" }>[] }>();
  for (const run of keptRuns) {
    const { groupKey, title } = normalizeGroupLabel(run);
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    grouped.set(groupKey, { title, runs: [run] });
  }

  const groups: FinalizeGroup[] = [];
  const seenBranchNames = new Set<string>();

  let groupIndex = 1;
  for (const [groupKey, group] of grouped.entries()) {
    const runs = group.runs.sort((a, b) => a.seq - b.seq);

    groups.push({
      id: groupKey,
      title: group.title,
      runRecordIds: runs.map((run) => run.id),
      commits: runs.map((run) => run.payload.commit!).filter(Boolean),
      suggestedBranchName: buildBranchName("experiment", opts.session.id, group.title, groupIndex, seenBranchNames),
    });
    groupIndex += 1;
  }

  return {
    sessionId: opts.session.id,
    baselineCommit: resolveBaselineCommit(opts.session, opts.records, opts.mergeBaseCommit, warnings),
    integrationBranch: opts.integrationBranch,
    mergeBaseCommit: opts.mergeBaseCommit,
    groups,
    orphanedRunRecordIds,
    warnings,
  };
}

export function buildTaskGroupPlan(opts: {
  branchGroup: BranchGroup;
  memberTasks: Pick<Task, "id" | "createdAt" | "mergeDetails">[];
  integrationBranch: string;
  mergeBaseCommit: string;
}): FinalizePlan {
  const warnings: string[] = [];
  const orphanedRunRecordIds: string[] = [];
  const sortedMembers = [...opts.memberTasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const commits = sortedMembers.flatMap((member) => {
    const commit = member.mergeDetails?.commitSha?.trim();
    if (!commit) {
      orphanedRunRecordIds.push(member.id);
      warnings.push(`group member ${member.id} has no merge commit and was skipped`);
      return [];
    }
    return [commit];
  });

  return {
    sessionId: opts.branchGroup.id,
    baselineCommit: opts.mergeBaseCommit,
    integrationBranch: opts.integrationBranch,
    mergeBaseCommit: opts.mergeBaseCommit,
    groups: [{
      id: opts.branchGroup.id,
      title: opts.branchGroup.sourceId,
      runRecordIds: sortedMembers.map((member) => member.id),
      commits,
      suggestedBranchName: opts.branchGroup.branchName,
    }],
    orphanedRunRecordIds,
    warnings,
  };
}

export function mergePlanWithUserOverrides(defaultPlan: FinalizePlan, override?: FinalizePlanOverride): FinalizePlan {
  if (!override) return defaultPlan;

  const runToCommit = new Map<string, string>();
  const defaultGroupById = new Map(defaultPlan.groups.map((group) => [group.id, group]));
  for (const group of defaultPlan.groups) {
    for (let i = 0; i < group.runRecordIds.length; i += 1) {
      runToCommit.set(group.runRecordIds[i], group.commits[i]);
    }
  }

  const groups: FinalizeGroup[] = override.groups.map((group, idx) => {
    if (!group.runRecordIds.length) {
      throw new ExperimentFinalizePlanError(`Group ${group.id ?? idx + 1} has no run records`);
    }

    const source = group.id ? defaultGroupById.get(group.id) : undefined;
    const commits = group.runRecordIds.map((runRecordId) => {
      const commit = runToCommit.get(runRecordId);
      if (!commit) {
        throw new ExperimentFinalizePlanError(`Unknown or missing commit for run record ${runRecordId}`);
      }
      return commit;
    });

    if (!commits.length) {
      throw new ExperimentFinalizePlanError(`Group ${group.id ?? idx + 1} has zero commits`);
    }

    return {
      id: group.id ?? `custom:${idx + 1}`,
      title: group.title ?? source?.title ?? `Group ${idx + 1}`,
      description: group.description ?? source?.description,
      suggestedBranchName: group.suggestedBranchName ?? source?.suggestedBranchName ?? `experiment/${defaultPlan.sessionId.toLowerCase()}/group-${idx + 1}`,
      runRecordIds: [...group.runRecordIds],
      commits,
    };
  });

  const duplicateBranch = groups.find((group, index) => groups.findIndex((g) => g.suggestedBranchName === group.suggestedBranchName) !== index);
  if (duplicateBranch) {
    throw new ExperimentFinalizePlanError(`Duplicate suggested branch name: ${duplicateBranch.suggestedBranchName}`);
  }

  return {
    ...defaultPlan,
    groups,
  };
}
