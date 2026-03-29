/**
 * Simulates live board activity — tasks progressing, new ideas landing,
 * triage completing, reviews finishing. Run alongside `kb dashboard`.
 *
 * Usage: `npx tsx demo/simulate.ts [dir]`
 *
 * Expects a seeded board (run `demo/seed.ts` first).
 */
import { TaskStore } from "../packages/core/src/index.js";

const root = process.argv[2] || process.cwd();

const NEW_TASK_IDEAS = [
  "Add two-factor authentication with TOTP",
  "Implement webhook delivery for task events with retry and exponential backoff",
  "Add a CLI tool for bulk task import from CSV",
  "Support custom fields on tasks — text, number, date, dropdown",
  "Add a Gantt chart view for project timelines",
  "Implement role-based access control with custom roles",
  "Add Slack integration for task notifications",
  "Support task templates for recurring work",
  "Add time tracking per task with weekly summaries",
  "Implement API key rotation without downtime",
  "Add a public changelog page generated from done tasks",
  "Support file versioning on attachments",
];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  const store = new TaskStore(root);
  await store.init();

  let ideaIndex = 0;

  console.log("Simulating board activity... (Ctrl+C to stop)\n");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tasks = await store.listTasks();
    const triage = tasks.filter((t) => t.column === "triage" && !t.paused);
    const inProgress = tasks.filter((t) => t.column === "in-progress" && !t.paused);
    const inReview = tasks.filter((t) => t.column === "in-review" && !t.paused);
    const todo = tasks.filter((t) => t.column === "todo" && !t.paused);

    // Roll dice for what happens this tick
    const roll = Math.random();

    if (roll < 0.2 && ideaIndex < NEW_TASK_IDEAS.length) {
      // New task lands in triage
      const desc = NEW_TASK_IDEAS[ideaIndex++];
      const task = await store.createTask({ description: desc });
      console.log(`  + New task: ${task.id} — "${desc.slice(0, 50)}..."`);
      await sleep(2000 + Math.random() * 3000);
    } else if (roll < 0.4 && triage.length > 0) {
      // Triage completes — task gets spec'd and moves to todo
      const task = pick(triage);
      const title = task.description.slice(0, 60).replace(/\.$/, "");
      await store.updateTask(task.id, {
        title,
        size: pick(["S", "M", "L"] as const),
        reviewLevel: pick([0, 1, 1, 2, 2, 3]),
      });
      await store.logEntry(task.id, "Triage complete — spec written", "approved");
      await store.moveTask(task.id, "todo");
      console.log(`  ✓ Triaged: ${task.id} → todo`);
      await sleep(3000 + Math.random() * 4000);
    } else if (roll < 0.6 && todo.length > 0 && inProgress.length < 3) {
      // Scheduler picks up a todo task
      const task = pick(todo);
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { status: null });
      await store.logEntry(task.id, "Scheduled for execution", "worktree created");
      console.log(`  ▸ Started: ${task.id} — "${task.title || task.description.slice(0, 40)}"`);
      await sleep(2000 + Math.random() * 3000);
    } else if (roll < 0.85 && inProgress.length > 0) {
      // Step progress on an in-progress task
      const task = pick(inProgress);
      const detail = await store.getTask(task.id);

      // Initialize steps if needed
      if (detail.steps.length === 0) {
        const steps = [
          "Analyze codebase and plan approach",
          "Implement core logic",
          "Add tests and edge case handling",
          "Integration testing and documentation",
        ];
        // Write a prompt with steps so parseStepsFromPrompt works
        const stepsSection = steps
          .map((s, i) => `### Step ${i + 1}: ${s}\n\n- [ ] Complete`)
          .join("\n\n");
        await store.updateTask(task.id, {
          prompt: `# ${task.id}: ${task.title || "Task"}\n\n## Steps\n\n${stepsSection}\n`,
        });
      }

      // Re-read after potential prompt update
      const fresh = await store.getTask(task.id);
      if (fresh.steps.length > 0) {
        const currentIdx = fresh.currentStep;
        if (currentIdx < fresh.steps.length) {
          const step = fresh.steps[currentIdx];
          if (step.status === "pending") {
            await store.updateStep(task.id, currentIdx, "in-progress");
            await store.updateTask(task.id, { status: null });
            await store.logEntry(task.id, `Step ${currentIdx} started`, "in-progress");
            console.log(`  ▸ ${task.id} step ${currentIdx}: ${step.name}`);
          } else if (step.status === "in-progress") {
            // Review and complete step
            const verdict = Math.random() < 0.85 ? "approved" : "revise";
            if (verdict === "approved") {
              await store.updateStep(task.id, currentIdx, "done");
              await store.logEntry(task.id, `Review: step ${currentIdx}`, "approved");
              console.log(`  ✓ ${task.id} step ${currentIdx} approved`);

              // Check if all steps done
              const updated = await store.getTask(task.id);
              if (updated.currentStep >= updated.steps.length) {
                await store.moveTask(task.id, "in-review");
                await store.updateTask(task.id, { status: null });
                await store.logEntry(task.id, "All steps complete — moved to review");
                console.log(`  ★ ${task.id} → in-review`);
              }
            } else {
              await store.logEntry(task.id, `Review: step ${currentIdx}`, "revise — needs fixes");
              await store.updateTask(task.id, { status: null });
              console.log(`  ↻ ${task.id} step ${currentIdx} needs revision`);
            }
          }
        }
      }
      await sleep(3000 + Math.random() * 5000);
    } else if (roll < 0.95 && inReview.length > 0) {
      // Auto-merge a reviewed task
      const task = pick(inReview);
      await store.logEntry(task.id, "Auto-merged into main");
      // Can't use mergeTask (no real branch), so just move directly
      const dir = `${root}/.kb/tasks/${task.id}`;
      // Read, update, write manually to move to done
      const detail = await store.getTask(task.id);
      await store.updateTask(task.id, { status: undefined, worktree: undefined });
      // Use moveTask for the column transition
      await store.moveTask(task.id, "done");
      console.log(`  ✓ Merged: ${task.id} → done`);
      await sleep(4000 + Math.random() * 3000);
    } else {
      // Quiet tick
      await sleep(2000 + Math.random() * 2000);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
