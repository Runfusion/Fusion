import { TaskStore, COLUMNS, COLUMN_LABELS, type Column, type MergeResult } from "@hai/core";
import { aiMergeTask } from "@hai/engine";
import { createInterface } from "node:readline/promises";

async function getStore(): Promise<TaskStore> {
  const store = new TaskStore(process.cwd());
  await store.init();
  return store;
}

export async function runTaskCreate(descriptionArg?: string) {
  let description = descriptionArg;

  if (!description) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    description = await rl.question("Task description: ");
    rl.close();
  }

  if (!description?.trim()) {
    console.error("Description is required");
    process.exit(1);
  }

  const store = await getStore();
  const task = await store.createTask({ description: description.trim() });

  const label = task.description.length > 60
    ? task.description.slice(0, 60) + "…"
    : task.description;

  console.log();
  console.log(`  ✓ Created ${task.id}: ${label}`);
  console.log(`    Column: triage`);
  console.log(`    Path:   .hai/tasks/${task.id}/`);
  console.log();
}

export async function runTaskList() {
  const store = await getStore();
  const tasks = await store.listTasks();

  if (tasks.length === 0) {
    console.log("\n  No tasks yet. Create one with: hai task create\n");
    return;
  }

  console.log();

  for (const col of COLUMNS) {
    const colTasks = tasks.filter((t) => t.column === col);
    if (colTasks.length === 0) continue;

    const label = COLUMN_LABELS[col];
    const dot =
      col === "triage" ? "●" :
      col === "todo" ? "●" :
      col === "in-progress" ? "●" :
      col === "in-review" ? "●" : "○";

    console.log(`  ${dot} ${label} (${colTasks.length})`);
    for (const t of colTasks) {
      const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
      const label = t.title || t.description.slice(0, 60) + (t.description.length > 60 ? "…" : "");
      console.log(`    ${t.id}  ${label}${deps}`);
    }
    console.log();
  }
}

export async function runTaskMerge(id: string) {
  const cwd = process.cwd();
  const store = await getStore();

  console.log(`\n  Merging ${id} with AI...\n`);

  try {
    const result = await aiMergeTask(store, cwd, id, {
      onAgentText: (delta) => process.stdout.write(delta),
      onAgentTool: (name) => console.log(`  [merge] tool: ${name}`),
    });

    console.log();
    if (result.merged) {
      console.log(`  ✓ Merged ${result.task.id}`);
      console.log(`    Branch:   ${result.branch}`);
      console.log(`    Worktree: ${result.worktreeRemoved ? "removed" : "not found"}`);
      console.log(`    Branch:   ${result.branchDeleted ? "deleted" : "kept"}`);
    } else {
      console.log(`  ✓ Closed ${result.task.id} (${result.error})`);
    }
    console.log(`    Status:   done`);
    console.log();
  } catch (err: any) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }
}

export async function runTaskMove(id: string, column: string) {
  if (!COLUMNS.includes(column as Column)) {
    console.error(`Invalid column: ${column}`);
    console.error(`Valid columns: ${COLUMNS.join(", ")}`);
    process.exit(1);
  }

  const store = await getStore();
  const task = await store.moveTask(id, column as Column);

  console.log();
  console.log(`  ✓ Moved ${task.id} → ${COLUMN_LABELS[task.column as Column]}`);
  console.log();
}
