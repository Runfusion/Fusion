import { drizzleSql, type Goal, type MilestoneStatus, type SliceStatus, type FeatureStatus } from "@fusion/core";
import { createInterface } from "node:readline/promises";
import { getStore } from "../project-resolver.js";

// ── Status Labels for Display ───────────────────────────────────────────────

const MISSION_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  blocked: "Blocked",
  complete: "Complete",
  archived: "Archived",
};

const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  planning: "Planning",
  active: "Active",
  blocked: "Blocked",
  complete: "Complete",
};

const SLICE_STATUS_LABELS: Record<SliceStatus, string> = {
  pending: "Pending",
  active: "Active",
  complete: "Complete",
};

const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  defined: "Defined",
  triaged: "Triaged",
  "in-progress": "In Progress",
  done: "Done",
  blocked: "Blocked",
};

async function resolveLinkedGoals(store: Awaited<ReturnType<typeof getStore>>, missionId: string): Promise<Array<Goal | { id: string; missing: true }>> {
  // FNXC:MissionStore 2026-06-27-15:55: getMissionStore() returns
  // MissionStore | AsyncMissionStore; await listGoalIdsForMission so the `fn mission`
  // CLI works against both SQLite and PG backends.
  const goalIds = await store.getMissionStore().listGoalIdsForMission(missionId);
  // FNXC:GoalStore 2026-06-27-18:20: GoalStore is now ported to PG
  // (AsyncGoalStore); getGoalStore() returns GoalStore | AsyncGoalStore. await
  // getGoal so `fn mission` resolves real goals against both SQLite and PG (the
  // interim PG id-only degradation is removed).
  const goalStore = store.getGoalStore();
  const resolved = await Promise.all(goalIds.map((goalId) => goalStore.getGoal(goalId)));
  return goalIds.map((goalId, i) => resolved[i] ?? { id: goalId, missing: true as const });
}

async function promptForTitleAndDescription(
  titleArg: string | undefined,
  titlePrompt: string,
  descriptionPrompt: string,
): Promise<{ title: string; description?: string }> {
  let title = titleArg;
  let description: string | undefined;

  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question(titlePrompt);

    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = await rl.question(descriptionPrompt);
    rl.close();
  }

  return {
    title: title.trim(),
    description: description?.trim() || undefined,
  };
}

// ── Mission Commands ─────────────────────────────────────────────────────────

/**
 * Create a new mission with optional title and description.
 * If arguments are omitted, prompts interactively.
 */
async function requireCliLinkableGoal(store: Awaited<ReturnType<typeof getStore>>, goalId: string): Promise<Goal> {
  const goal = await store.getGoalStore().getGoal(goalId);
  if (!goal) {
    console.error(`✗ Goal ${goalId} not found`);
    process.exit(1);
  }
  if (goal.status === "archived") {
    console.error(`✗ Goal ${goalId} is archived and cannot be linked`);
    process.exit(1);
  }
  return goal;
}

export async function runMissionCreate(
  titleArg?: string,
  descriptionArg?: string,
  projectName?: string,
  baseBranch?: string,
  goalIds?: string[],
) {
  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const uniqueGoalIds = Array.from(new Set(goalIds ?? []));
  const linkableGoals = await Promise.all(uniqueGoalIds.map((goalId) => requireCliLinkableGoal(store, goalId)));

  const { title, description } = titleArg
    ? { title: titleArg.trim(), description: descriptionArg?.trim() || undefined }
    : await promptForTitleAndDescription(
      titleArg,
      "Mission title: ",
      "Mission description (optional): ",
    );

  const mission = await missionStore.createMission({
    title,
    description,
    baseBranch: baseBranch?.trim() || undefined,
  });

  for (const goal of linkableGoals) {
    await missionStore.linkGoal(mission.id, goal.id);
  }

  console.log();
  console.log(`  ✓ Created ${mission.id}: ${mission.title}`);
  console.log(`    Status: ${MISSION_STATUS_LABELS[mission.status]}`);
  if (mission.description) {
    console.log(`    Description: ${mission.description.slice(0, 80)}${mission.description.length > 80 ? "…" : ""}`);
  }
  if (linkableGoals.length > 0) {
    console.log(`    Linked goals: ${linkableGoals.length}`);
  }
  console.log();
}

interface RunMissionListOptions {
  includeDrafts?: boolean;
}

function formatMissionInterviewDraftStatus(
  status: "generating" | "awaiting_input" | "error" | "complete",
): string {
  switch (status) {
    case "complete":
      return "plan ready";
    default:
      return status;
  }
}

/**
 * List all missions with status summary.
 */
export async function runMissionList(projectName?: string, options: RunMissionListOptions = {}) {
  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const includeDrafts = options.includeDrafts ?? true;

  const missions = await missionStore.listMissions();
  // FNXC:PostgresCutover 2026-07-04: in backend mode read mission-interview
  // drafts from PostgreSQL via Drizzle (the SQLite getDatabase() runtime was
  // removed under VAL-REMOVAL-005). PG ai_sessions columns are snake_case, so
  // alias updated_at -> updatedAt to preserve the existing draft row shape.
  type MissionInterviewDraftStatus = "generating" | "awaiting_input" | "error" | "complete";
  type MissionInterviewDraft = {
    id: string;
    title: string;
    status: MissionInterviewDraftStatus;
    updatedAt: string;
  };
  let drafts: MissionInterviewDraft[] = [];
  if (includeDrafts) {
    const layer = store.getAsyncLayer();
    if (!layer) {
      throw new Error("PostgreSQL AsyncDataLayer unavailable for mission drafts");
    }
    /* FNXC:PostgresMissionDrafts 2026-07-14-18:24: Mission interview drafts have one authoritative PostgreSQL read path after the runtime cutover. */
    drafts = await layer.db.execute<MissionInterviewDraft>(
      drizzleSql`SELECT id, title, status, updated_at AS "updatedAt" FROM project.ai_sessions WHERE type = 'mission_interview' AND status IN ('generating', 'awaiting_input', 'error', 'complete') AND COALESCE(archived, 0) = 0 ORDER BY updated_at DESC`,
    );
  }

  if (missions.length === 0 && drafts.length === 0) {
    console.log("\n  No missions yet. Create one with: fn mission create\n");
    process.exit(0);
  }

  console.log();

  if (drafts.length > 0) {
    console.log(`  ◌ Drafts (${drafts.length})`);
    for (const draft of drafts) {
      console.log(`    ◌  ${draft.id}  ${draft.title} — (draft · interview ${formatMissionInterviewDraftStatus(draft.status)})`);
    }
    console.log();
  }

  // Group by status
  const byStatus: Record<string, typeof missions> = {};
  for (const mission of missions) {
    if (!byStatus[mission.status]) {
      byStatus[mission.status] = [];
    }
    byStatus[mission.status].push(mission);
  }

  // Display by status in order
  const statusOrder = ["planning", "active", "blocked", "complete", "archived"];
  for (const status of statusOrder) {
    const statusMissions = byStatus[status];
    if (!statusMissions || statusMissions.length === 0) continue;

    const label = MISSION_STATUS_LABELS[status];
    const dot = status === "active" ? "●" : status === "blocked" ? "⚠" : status === "complete" ? "✓" : "○";

    console.log(`  ${dot} ${label} (${statusMissions.length})`);
    for (const m of statusMissions) {
      const desc = m.description ? ` — ${m.description.slice(0, 50)}${m.description.length > 50 ? "…" : ""}` : "";
      console.log(`    ${m.id}  ${m.title}${desc}`);
    }
    console.log();
  }

  process.exit(0);
}

/**
 * Display mission details with full hierarchy:
 * Mission → Milestones → Slices → Features
 */
export async function runMissionShow(id: string, projectName?: string) {
  if (!id) {
    console.error("Usage: fn mission show <id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  const mission = await missionStore.getMissionWithHierarchy(id);
  if (!mission) {
    console.error(`Mission ${id} not found`);
    process.exit(1);
  }

  console.log();
  console.log(`  ${mission.id}: ${mission.title}`);
  console.log(`  Status: ${MISSION_STATUS_LABELS[mission.status]}`);
  if (mission.description) {
    console.log(`  Description: ${mission.description}`);
  }
  console.log();

  if (mission.milestones.length === 0) {
    console.log("  No milestones yet.");
    console.log();
    return;
  }

  console.log("  Milestones:");
  for (const milestone of mission.milestones) {
    const statusIcon = milestone.status === "complete" ? "✓" : milestone.status === "active" ? "●" : "○";
    console.log(`    ${statusIcon} ${milestone.id}: ${milestone.title} (${MILESTONE_STATUS_LABELS[milestone.status]})`);
    
    if (milestone.slices.length === 0) {
      console.log("      No slices");
    } else {
      for (const slice of milestone.slices) {
        const sliceIcon = slice.status === "complete" ? "✓" : slice.status === "active" ? "●" : "○";
        const activated = slice.activatedAt ? ` [activated: ${new Date(slice.activatedAt).toLocaleDateString()}]` : "";
        console.log(`      ${sliceIcon} ${slice.id}: ${slice.title} (${SLICE_STATUS_LABELS[slice.status]})${activated}`);
        
        if (slice.features.length === 0) {
          console.log("        No features");
        } else {
          for (const feature of slice.features) {
            const featureIcon = feature.status === "done" ? "✓" : feature.status === "in-progress" ? "▸" : feature.status === "triaged" ? "●" : "○";
            const taskLink = feature.taskId ? ` → ${feature.taskId}` : "";
            console.log(`        ${featureIcon} ${feature.id}: ${feature.title} (${FEATURE_STATUS_LABELS[feature.status]})${taskLink}`);
          }
        }
      }
    }
    console.log();
  }

  console.log();
}

/**
 * Delete a mission with optional force flag to skip confirmation.
 */
export async function runMissionDelete(id: string, force?: boolean, projectName?: string) {
  if (!id) {
    console.error("Usage: fn mission delete <id> [--force]");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  // Check if mission exists
  const mission = await missionStore.getMission(id);
  if (!mission) {
    console.error(`✗ Mission ${id} not found`);
    process.exit(1);
  }

  // Prompt for confirmation unless force is used
  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Are you sure you want to delete ${id}: "${mission.title}"? [y/N] `);
    rl.close();

    const trimmed = answer.trim().toLowerCase();
    if (trimmed !== "y" && trimmed !== "yes") {
      console.log("Cancelled.");
      process.exit(0);
    }
  }

  await missionStore.deleteMission(id);
  console.log();
  console.log(`  ✓ Deleted ${id}: "${mission.title}"`);
  console.log();
}

/**
 * Activate a pending slice by ID.
 */
export async function runMissionActivateSlice(id: string, projectName?: string) {
  if (!id) {
    console.error("Usage: fn mission activate-slice <slice-id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  // Check if slice exists
  const slice = await missionStore.getSlice(id);
  if (!slice) {
    console.error(`✗ Slice ${id} not found`);
    process.exit(1);
  }

  if (slice.status !== "pending") {
    console.error(`✗ Slice ${id} is not pending (status: ${slice.status})`);
    process.exit(1);
  }

  const activated = await missionStore.activateSlice(id);
  console.log();
  console.log(`  ✓ Activated ${activated.id}: "${activated.title}"`);
  console.log(`    Status: ${SLICE_STATUS_LABELS[activated.status]}`);
  if (activated.activatedAt) {
    console.log(`    Activated at: ${new Date(activated.activatedAt).toLocaleString()}`);
  }
  console.log();
}

export async function runMilestoneAdd(
  missionId: string,
  titleArg?: string,
  descriptionArg?: string,
  projectName?: string,
) {
  if (!missionId) {
    console.error("Usage: fn mission add-milestone <mission-id> [title] [description]");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const mission = await missionStore.getMission(missionId);

  if (!mission) {
    console.error(`✗ Mission ${missionId} not found`);
    process.exit(1);
  }

  const { title, description } = titleArg
    ? { title: titleArg.trim(), description: descriptionArg?.trim() || undefined }
    : await promptForTitleAndDescription(
      titleArg,
      "Milestone title: ",
      "Milestone description (optional): ",
    );

  const milestone = await missionStore.addMilestone(missionId, { title, description });

  console.log();
  console.log(`  ✓ Added ${milestone.id}: "${milestone.title}" to ${missionId}`);
  console.log(`    Status: ${MILESTONE_STATUS_LABELS[milestone.status]}`);
  console.log();
}

export async function runSliceAdd(
  milestoneId: string,
  titleArg?: string,
  descriptionArg?: string,
  projectName?: string,
) {
  if (!milestoneId) {
    console.error("Usage: fn mission add-slice <milestone-id> [title] [description]");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const milestone = await missionStore.getMilestone(milestoneId);

  if (!milestone) {
    console.error(`✗ Milestone ${milestoneId} not found`);
    process.exit(1);
  }

  const { title, description } = titleArg
    ? { title: titleArg.trim(), description: descriptionArg?.trim() || undefined }
    : await promptForTitleAndDescription(
      titleArg,
      "Slice title: ",
      "Slice description (optional): ",
    );

  const slice = await missionStore.addSlice(milestoneId, { title, description });

  console.log();
  console.log(`  ✓ Added ${slice.id}: "${slice.title}" to ${milestoneId}`);
  console.log(`    Status: ${SLICE_STATUS_LABELS[slice.status]}`);
  console.log();
}

export async function runFeatureAdd(
  sliceId: string,
  titleArg?: string,
  descriptionArg?: string,
  acceptanceCriteriaArg?: string,
  projectName?: string,
) {
  if (!sliceId) {
    console.error("Usage: fn mission add-feature <slice-id> [title] [description] [--acceptance-criteria <criteria>]");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const slice = await missionStore.getSlice(sliceId);

  if (!slice) {
    console.error(`✗ Slice ${sliceId} not found`);
    process.exit(1);
  }

  let title = titleArg;
  let description = descriptionArg?.trim() || undefined;
  let acceptanceCriteria = acceptanceCriteriaArg?.trim() || undefined;

  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question("Feature title: ");

    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = (await rl.question("Feature description (optional): ")).trim() || undefined;
    acceptanceCriteria = (await rl.question("Acceptance criteria (optional): ")).trim() || undefined;
    rl.close();
  }

  const feature = await missionStore.addFeature(sliceId, {
    title: title.trim(),
    description,
    acceptanceCriteria,
  });

  console.log();
  console.log(`  ✓ Added ${feature.id}: "${feature.title}" to ${sliceId}`);
  console.log(`    Status: ${FEATURE_STATUS_LABELS[feature.status]}`);
  if (feature.acceptanceCriteria) {
    console.log(`    Acceptance: ${feature.acceptanceCriteria.slice(0, 60)}${feature.acceptanceCriteria.length > 60 ? "…" : ""}`);
  }
  console.log();
}

export async function runMissionLinkGoal(missionId: string, goalId: string, projectName?: string) {
  if (!missionId || !goalId) {
    console.error("Usage: fn mission link-goal <mission-id> <goal-id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  if (!await missionStore.getMission(missionId)) {
    console.error(`✗ Mission ${missionId} not found`);
    process.exit(1);
  }

  const goal = await requireCliLinkableGoal(store, goalId);

  await missionStore.linkGoal(missionId, goalId);

  console.log();
  console.log(`  ✓ Linked ${goal.id}: ${goal.title} → ${missionId}`);
  console.log(`    Linked goals: ${(await missionStore.listGoalIdsForMission(missionId)).length}`);
  console.log();
}

export async function runMissionUnlinkGoal(missionId: string, goalId: string, projectName?: string) {
  if (!missionId || !goalId) {
    console.error("Usage: fn mission unlink-goal <mission-id> <goal-id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  if (!await missionStore.getMission(missionId)) {
    console.error(`✗ Mission ${missionId} not found`);
    process.exit(1);
  }

  const goal = await store.getGoalStore().getGoal(goalId);
  if (!goal) {
    console.error(`✗ Goal ${goalId} not found`);
    process.exit(1);
  }

  await missionStore.unlinkGoal(missionId, goalId);

  console.log();
  console.log(`  ✓ Unlinked ${goal.id}: ${goal.title} from ${missionId}`);
  console.log(`    Linked goals: ${(await missionStore.listGoalIdsForMission(missionId)).length}`);
  console.log();
}

export async function runMissionGoals(missionId: string, projectName?: string) {
  if (!missionId) {
    console.error("Usage: fn mission goals <mission-id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const mission = await missionStore.getMission(missionId);

  if (!mission) {
    console.error(`✗ Mission ${missionId} not found`);
    process.exit(1);
  }

  const linkedGoals = await resolveLinkedGoals(store, missionId);

  console.log();
  console.log(`  Linked goals for ${mission.id}: ${mission.title}`);
  if (linkedGoals.length === 0) {
    console.log("    No linked goals.");
    console.log();
    process.exit(0);
  }

  for (const goal of linkedGoals) {
    if ("missing" in goal) {
      console.log(`    - ${goal.id} [missing]`);
      continue;
    }
    const description = goal.description ? ` — ${goal.description}` : "";
    console.log(`    - ${goal.id} [${goal.status}] ${goal.title}${description}`);
  }
  console.log();
}

export async function runFeatureLinkTask(featureId: string, taskId: string, projectName?: string) {
  if (!featureId || !taskId) {
    console.error("Usage: fn mission link-feature <feature-id> <task-id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();
  const feature = await missionStore.getFeature(featureId);

  if (!feature) {
    console.error(`✗ Feature ${featureId} not found`);
    process.exit(1);
  }

  try {
    await store.getTask(taskId);
  } catch {
    console.error(`✗ Task ${taskId} not found`);
    process.exit(1);
  }

  const updated = await missionStore.linkFeatureToTask(featureId, taskId);

  console.log();
  console.log(`  ✓ Linked ${updated.id}: "${updated.title}" → ${taskId}`);
  console.log(`    Status: ${FEATURE_STATUS_LABELS[updated.status]}`);
  console.log();
}
