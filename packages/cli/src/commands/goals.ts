import { createInterface } from "node:readline/promises";
import { getStore } from "../project-resolver.js";

type GoalStatusFilter = "active" | "archived" | "all";

interface RunGoalsListOptions {
  status?: GoalStatusFilter;
}

const ACTIVE_SOFT_WARNING_THRESHOLD = 3;
const ACTIVE_HARD_LIMIT = 5;

function truncateDescription(description: string, max = 60): string {
  return description.length > max ? `${description.slice(0, max)}…` : description;
}

function printActiveSoftWarning(activeCount: number): void {
  if (activeCount >= ACTIVE_SOFT_WARNING_THRESHOLD) {
    console.log(`  ⚠  ${activeCount}/${ACTIVE_HARD_LIMIT} active goals — soft warning at 3, hard cap at 5`);
  }
}

async function promptForTitleAndDescription(
  titleArg: string | undefined,
): Promise<{ title: string; description?: string }> {
  let title = titleArg;
  let description: string | undefined;

  if (!title) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    title = await rl.question("Goal title: ");

    if (!title?.trim()) {
      rl.close();
      console.error("Title is required");
      process.exit(1);
    }

    description = await rl.question("Goal description (optional): ");
    rl.close();
  }

  return {
    title: title.trim(),
    description: description?.trim() || undefined,
  };
}

export async function runGoalsList(projectName?: string, opts: RunGoalsListOptions = {}): Promise<void> {
  const store = await getStore({ project: projectName });
  const goalStore = store.getGoalStore();

  const status = opts.status ?? "active";
  const goals = status === "all" ? goalStore.listGoals() : goalStore.listGoals({ status });

  if (goals.length === 0) {
    console.log("\n  No goals yet. Create one with: fn goals create\n");
    process.exit(0);
  }

  const activeCount = goalStore.listGoals({ status: "active" }).length;

  console.log();
  for (const goal of goals) {
    const statusBadge = goal.status === "active" ? "● active" : "○ archived";
    const desc = goal.description ? ` — ${truncateDescription(goal.description)}` : "";
    console.log(`  ${goal.id}  [${statusBadge}]  ${goal.title}${desc}`);
  }
  console.log();

  printActiveSoftWarning(activeCount);
  if (activeCount >= ACTIVE_SOFT_WARNING_THRESHOLD) {
    console.log();
  }

  process.exit(0);
}

export async function runGoalsCreate(
  titleArg?: string,
  descriptionArg?: string,
  projectName?: string,
): Promise<void> {
  const store = await getStore({ project: projectName });
  const goalStore = store.getGoalStore();

  const { title, description } = titleArg
    ? { title: titleArg.trim(), description: descriptionArg?.trim() || undefined }
    : await promptForTitleAndDescription(titleArg);

  try {
    const goal = goalStore.createGoal({ title, description });
    const activeCount = goalStore.listGoals({ status: "active" }).length;

    console.log();
    console.log(`  ✓ Created ${goal.id}: ${goal.title}`);
    console.log(`    Status: ${goal.status}`);
    printActiveSoftWarning(activeCount);
    console.log();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ACTIVE_GOAL_LIMIT_EXCEEDED"
    ) {
      const limit = (error as { limit?: number }).limit ?? ACTIVE_HARD_LIMIT;
      const currentActive = (error as { currentActive?: number }).currentActive ?? ACTIVE_HARD_LIMIT;
      console.error(
        `Error: Cannot create goal — already at the hard cap of ${limit} active goals (currently ${currentActive}). Archive one with 'fn goals archive <id>' first.`,
      );
      process.exit(1);
    }
    throw error;
  }
}

export async function runGoalsArchive(idArg: string | undefined, projectName?: string): Promise<void> {
  if (!idArg) {
    console.error("Usage: fn goals archive <id>");
    process.exit(1);
  }

  const store = await getStore({ project: projectName });
  const goalStore = store.getGoalStore();
  const existing = goalStore.getGoal(idArg);

  if (!existing) {
    console.error(`Goal ${idArg} not found`);
    process.exit(1);
  }

  if (existing.status === "archived") {
    console.log(`Goal ${idArg} is already archived`);
    process.exit(0);
  }

  const archived = goalStore.archiveGoal(idArg);

  console.log();
  console.log(`  ✓ Archived ${archived.id}: ${archived.title}`);
  console.log();
}
