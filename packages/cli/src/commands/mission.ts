import { MissionStore, type Mission, type Slice, type MissionWithHierarchy, type MilestoneWithSlices, type SliceWithFeatures, type MissionCreateInput, type MilestoneCreateInput, type SliceCreateInput, type FeatureCreateInput } from "@fusion/core";
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

const MILESTONE_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  blocked: "Blocked",
  complete: "Complete",
};

const SLICE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  active: "Active",
  complete: "Complete",
};

const FEATURE_STATUS_LABELS: Record<string, string> = {
  defined: "Defined",
  triaged: "Triaged",
  "in-progress": "In Progress",
  done: "Done",
};

// ── Mission Commands ─────────────────────────────────────────────────────────

/**
 * Create a new mission with optional title and description.
 * If arguments are omitted, prompts interactively.
 */
export async function runMissionCreate(titleArg?: string, descriptionArg?: string, projectName?: string) {
  let title = titleArg;
  let description = descriptionArg;

  // Interactive prompts if title not provided
  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question("Mission title: ");
    
    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = await rl.question("Mission description (optional): ");
    rl.close();
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  const mission = missionStore.createMission({
    title: title.trim(),
    description: description?.trim() || undefined,
  });

  console.log();
  console.log(`  ✓ Created ${mission.id}: ${mission.title}`);
  console.log(`    Status: ${MISSION_STATUS_LABELS[mission.status]}`);
  if (mission.description) {
    console.log(`    Description: ${mission.description.slice(0, 80)}${mission.description.length > 80 ? "…" : ""}`);
  }
  console.log();
}

/**
 * List all missions with status summary.
 */
export async function runMissionList(projectName?: string) {
  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  const missions = missionStore.listMissions();

  if (missions.length === 0) {
    console.log("\n  No missions yet. Create one with: fn mission create\n");
    process.exit(0);
  }

  console.log();

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

  const mission = missionStore.getMissionWithHierarchy(id);
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
  const mission = missionStore.getMission(id);
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

  missionStore.deleteMission(id);
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
  const slice = missionStore.getSlice(id);
  if (!slice) {
    console.error(`✗ Slice ${id} not found`);
    process.exit(1);
  }

  if (slice.status !== "pending") {
    console.error(`✗ Slice ${id} is not pending (status: ${slice.status})`);
    process.exit(1);
  }

  const activated = missionStore.activateSlice(id);
  console.log();
  console.log(`  ✓ Activated ${activated.id}: "${activated.title}"`);
  console.log(`    Status: ${SLICE_STATUS_LABELS[activated.status]}`);
  if (activated.activatedAt) {
    console.log(`    Activated at: ${new Date(activated.activatedAt).toLocaleString()}`);
  }
  console.log();
}

// ── Milestone Commands ──────────────────────────────────────────────────────

/**
 * Add a milestone to a mission.
 */
export async function runMilestoneAdd(
  missionId: string,
  titleArg?: string,
  descriptionArg?: string,
  projectName?: string
) {
  if (!missionId) {
    console.error("Usage: fn mission add-milestone <mission-id> [title] [description]");
    process.exit(1);
  }

  let title = titleArg;
  let description = descriptionArg;

  // Interactive prompts if title not provided
  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question("Milestone title: ");
    
    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = await rl.question("Milestone description (optional): ");
    rl.close();
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  // Check if mission exists
  const mission = missionStore.getMission(missionId);
  if (!mission) {
    console.error(`✗ Mission ${missionId} not found`);
    process.exit(1);
  }

  const milestone = missionStore.addMilestone(missionId, {
    title: title.trim(),
    description: description?.trim() || undefined,
  });

  console.log();
  console.log(`  ✓ Added ${milestone.id}: "${milestone.title}" to ${missionId}`);
  console.log(`    Status: ${MILESTONE_STATUS_LABELS[milestone.status]}`);
  console.log();
}

// ── Slice Commands ───────────────────────────────────────────────────────────

/**
 * Add a slice to a milestone.
 */
export async function runSliceAdd(
  milestoneId: string,
  titleArg?: string,
  descriptionArg?: string,
  projectName?: string
) {
  if (!milestoneId) {
    console.error("Usage: fn mission add-slice <milestone-id> [title] [description]");
    process.exit(1);
  }

  let title = titleArg;
  let description = descriptionArg;

  // Interactive prompts if title not provided
  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question("Slice title: ");
    
    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = await rl.question("Slice description (optional): ");
    rl.close();
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  // Check if milestone exists
  const milestone = missionStore.getMilestone(milestoneId);
  if (!milestone) {
    console.error(`✗ Milestone ${milestoneId} not found`);
    process.exit(1);
  }

  const slice = missionStore.addSlice(milestoneId, {
    title: title.trim(),
    description: description?.trim() || undefined,
  });

  console.log();
  console.log(`  ✓ Added ${slice.id}: "${slice.title}" to ${milestoneId}`);
  console.log(`    Status: ${SLICE_STATUS_LABELS[slice.status]}`);
  console.log();
}

// ── Feature Commands ─────────────────────────────────────────────────────────

/**
 * Add a feature to a slice.
 */
export async function runFeatureAdd(
  sliceId: string,
  titleArg?: string,
  descriptionArg?: string,
  acceptanceCriteriaArg?: string,
  projectName?: string
) {
  if (!sliceId) {
    console.error("Usage: fn mission add-feature <slice-id> [title] [description] [--acceptance-criteria <criteria>]");
    process.exit(1);
  }

  let title = titleArg;
  let description = descriptionArg;
  let acceptanceCriteria = acceptanceCriteriaArg;

  // Interactive prompts if title not provided
  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question("Feature title: ");
    
    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = await rl.question("Feature description (optional): ");
    acceptanceCriteria = await rl.question("Acceptance criteria (optional): ");
    rl.close();
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  // Check if slice exists
  const slice = missionStore.getSlice(sliceId);
  if (!slice) {
    console.error(`✗ Slice ${sliceId} not found`);
    process.exit(1);
  }

  const feature = missionStore.addFeature(sliceId, {
    title: title.trim(),
    description: description?.trim() || undefined,
    acceptanceCriteria: acceptanceCriteria?.trim() || undefined,
  });

  console.log();
  console.log(`  ✓ Added ${feature.id}: "${feature.title}" to ${sliceId}`);
  console.log(`    Status: ${FEATURE_STATUS_LABELS[feature.status]}`);
  if (feature.acceptanceCriteria) {
    console.log(`    Acceptance: ${feature.acceptanceCriteria.slice(0, 60)}${feature.acceptanceCriteria.length > 60 ? "…" : ""}`);
  }
  console.log();
}

/**
 * Link a feature to a task.
 */
export async function runFeatureLinkTask(featureId: string, taskId: string, projectName?: string) {
  if (!featureId || !taskId) {
    console.error("Usage: fn mission link-feature <feature-id> <task-id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const missionStore = store.getMissionStore();

  // Check if feature exists
  const feature = missionStore.getFeature(featureId);
  if (!feature) {
    console.error(`✗ Feature ${featureId} not found`);
    process.exit(1);
  }

  // Check if task exists
  try {
    await store.getTask(taskId);
  } catch {
    console.error(`✗ Task ${taskId} not found`);
    process.exit(1);
  }

  const updated = missionStore.linkFeatureToTask(featureId, taskId);
  console.log();
  console.log(`  ✓ Linked ${updated.id}: "${updated.title}" → ${taskId}`);
  console.log(`    Status: ${FEATURE_STATUS_LABELS[updated.status]}`);
  console.log();
}
