/**
 * Seeds a .kb board with realistic tasks across all columns.
 * Run from a git repo: `npx tsx demo/seed.ts [dir]`
 *
 * Creates a board that looks like an active project mid-flight:
 * - Done: shipped features
 * - In Review: finished work waiting for merge
 * - In Progress: agents actively executing (with steps partially done)
 * - Todo: specified and queued
 * - Triage: raw ideas just landing
 */
import { TaskStore } from "../packages/core/src/index.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2] || process.cwd();

async function main() {
  const store = new TaskStore(root);
  await store.init();

  // ── Done ──────────────────────────────────────────────────────────

  const done = [
    {
      title: "Project scaffolding and CI setup",
      desc: "Set up monorepo structure, TypeScript config, CI pipeline, and initial package layout.",
      size: "S" as const,
      reviewLevel: 0,
    },
    {
      title: "User authentication with JWT",
      desc: "Implement signup, login, and token refresh endpoints with bcrypt password hashing and JWT access/refresh tokens.",
      size: "M" as const,
      reviewLevel: 1,
    },
    {
      title: "Database schema and migrations",
      desc: "Design and implement the core PostgreSQL schema — users, workspaces, projects, tasks. Include migration tooling with up/down support.",
      size: "M" as const,
      reviewLevel: 1,
    },
    {
      title: "REST API endpoints",
      desc: "Implement CRUD endpoints for workspaces, projects, and tasks with input validation and proper error responses.",
      size: "L" as const,
      reviewLevel: 2,
    },
    {
      title: "Rate limiting middleware",
      desc: "Add token-bucket rate limiting per API key with configurable limits and proper 429 responses.",
      size: "S" as const,
      reviewLevel: 0,
    },
    {
      title: "Add pagination to list endpoints",
      desc: "Implement cursor-based pagination for all list endpoints. Return next/prev links in response headers.",
      size: "S" as const,
      reviewLevel: 1,
    },
  ];

  const doneIds: string[] = [];
  for (const t of done) {
    const task = await store.createTask({ description: t.desc, title: t.title });
    doneIds.push(task.id);
    await store.updateTask(task.id, { size: t.size, reviewLevel: t.reviewLevel });

    // Move through the pipeline: triage → todo → in-progress → in-review → done
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");

    // Add some steps and mark them done
    const steps = generateSteps(t.title);
    await writePrompt(store, task.id, t.title, t.desc, steps);
    for (let i = 0; i < steps.length; i++) {
      await store.updateStep(task.id, i, "done");
    }

    await store.moveTask(task.id, "in-review");
    await store.moveTask(task.id, "done");

    await addLogs(store, task.id, "done");
  }

  // ── In Review ─────────────────────────────────────────────────────

  const inReview = [
    {
      title: "WebSocket real-time notifications",
      desc: "Add WebSocket support for pushing live task updates, mentions, and status changes to connected clients.",
      size: "M" as const,
      reviewLevel: 2,
      deps: [doneIds[1]], // depends on auth
    },
    {
      title: "Full-text search with PostgreSQL tsvector",
      desc: "Implement search across tasks and comments using PostgreSQL full-text indexing. Support phrase queries and ranking.",
      size: "L" as const,
      reviewLevel: 2,
      deps: [doneIds[2]], // depends on db schema
    },
  ];

  const reviewIds: string[] = [];
  for (const t of inReview) {
    const task = await store.createTask({ description: t.desc, title: t.title, dependencies: t.deps });
    reviewIds.push(task.id);
    await store.updateTask(task.id, { size: t.size, reviewLevel: t.reviewLevel });

    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");

    const steps = generateSteps(t.title);
    await writePrompt(store, task.id, t.title, t.desc, steps, t.deps);
    for (let i = 0; i < steps.length; i++) {
      await store.updateStep(task.id, i, "done");
    }

    await store.moveTask(task.id, "in-review");
    await addLogs(store, task.id, "in-review");
  }

  // ── In Progress ───────────────────────────────────────────────────

  const inProgress = [
    {
      title: "Dark mode with system preference detection",
      desc: "Add dark mode theme with CSS custom properties. Detect system preference via prefers-color-scheme and allow manual toggle. Persist preference in localStorage.",
      size: "M" as const,
      reviewLevel: 1,
      currentStep: 1,
      totalSteps: 4,
    },
    {
      title: "File upload with S3 storage",
      desc: "Implement file upload endpoints with presigned S3 URLs. Support drag-and-drop in the UI, progress tracking, and file type validation.",
      size: "M" as const,
      reviewLevel: 2,
      deps: [doneIds[3]], // depends on REST API
      currentStep: 0,
      totalSteps: 3,
    },
    {
      title: "Export to CSV and PDF",
      desc: "Add export functionality for task lists and project reports. CSV for data, PDF for formatted reports with charts.",
      size: "S" as const,
      reviewLevel: 1,
      currentStep: 2,
      totalSteps: 4,
    },
  ];

  const inProgressIds: string[] = [];
  for (const t of inProgress) {
    const task = await store.createTask({ description: t.desc, title: t.title, dependencies: t.deps });
    inProgressIds.push(task.id);
    await store.updateTask(task.id, { size: t.size, reviewLevel: t.reviewLevel });

    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");

    const steps = generateStepsDetailed(t.title, t.totalSteps);
    await writePrompt(store, task.id, t.title, t.desc, steps, t.deps);

    // Mark steps up to currentStep as done, currentStep as in-progress
    for (let i = 0; i < t.currentStep; i++) {
      await store.updateStep(task.id, i, "done");
    }
    await store.updateStep(task.id, t.currentStep, "in-progress");

    await addLogs(store, task.id, "in-progress");
  }

  // ── Todo ──────────────────────────────────────────────────────────

  const todo = [
    {
      title: "OAuth2 social login (Google, GitHub)",
      desc: "Add OAuth2 login flow for Google and GitHub. Link social accounts to existing users by email. Support account unlinking.",
      size: "M" as const,
      reviewLevel: 2,
      deps: [doneIds[1]], // depends on auth
    },
    {
      title: "Audit logging for admin actions",
      desc: "Log all admin actions (user management, settings changes, permission grants) to an append-only audit table with actor, action, target, and timestamp.",
      size: "S" as const,
      reviewLevel: 1,
      blockedBy: () => inProgressIds[2], // implicit dep — file scope overlap with Export to CSV
    },
    {
      title: "Email notification preferences",
      desc: "Add per-user notification preferences — which events trigger emails, digest frequency, quiet hours. Integrate with the WebSocket notification system.",
      size: "S" as const,
      reviewLevel: 1,
      deps: [reviewIds[0]], // depends on WebSocket notifications
    },
    {
      title: "Multi-tenant workspace isolation",
      desc: "Implement row-level security for workspace isolation. All queries scoped to the active workspace. Cross-workspace data sharing via explicit grants.",
      size: "L" as const,
      reviewLevel: 3,
      deps: [doneIds[2]], // depends on db schema
    },
  ];

  for (const t of todo) {
    const task = await store.createTask({ description: t.desc, title: t.title, dependencies: t.deps });
    await store.updateTask(task.id, { size: t.size, reviewLevel: t.reviewLevel });
    await store.moveTask(task.id, "todo");

    const blockedBy = "blockedBy" in t && typeof t.blockedBy === "function" ? t.blockedBy() : undefined;
    if (blockedBy) {
      await store.updateTask(task.id, { status: "queued", blockedBy });
    } else if (t.deps?.length) {
      await store.updateTask(task.id, { status: "queued" });
    }

    const steps = generateSteps(t.title);
    await writePrompt(store, task.id, t.title, t.desc, steps, t.deps);
  }

  // ── Triage ────────────────────────────────────────────────────────

  const triage = [
    {
      desc: "Users are reporting slow page loads on the dashboard when they have more than 200 tasks. Probably need virtual scrolling or pagination in the UI.",
    },
    {
      desc: "Add ability to invite team members via email link with a 72-hour expiry. Should work even if they don't have an account yet.",
    },
    {
      desc: "Support markdown rendering in task descriptions and comments. Need to handle XSS — sanitize on render.",
    },
    {
      desc: "Mobile responsive layout for the main views. At minimum: task list, task detail, and the board view.",
    },
    {
      desc: "Add keyboard shortcuts for power users — j/k navigation, enter to open, x to close, / to search.",
    },
  ];

  for (const t of triage) {
    await store.createTask({ description: t.desc });
  }

  const tasks = await store.listTasks();
  const byColumn: Record<string, number> = {};
  for (const t of tasks) {
    byColumn[t.column] = (byColumn[t.column] || 0) + 1;
  }

  console.log(`\nSeeded ${tasks.length} tasks:`);
  console.log(`  Triage:      ${byColumn["triage"] || 0}`);
  console.log(`  Todo:        ${byColumn["todo"] || 0}`);
  console.log(`  In Progress: ${byColumn["in-progress"] || 0}`);
  console.log(`  In Review:   ${byColumn["in-review"] || 0}`);
  console.log(`  Done:        ${byColumn["done"] || 0}`);
  console.log(`\nRun "kb dashboard" to see the board.`);
}

// ── Helpers ───────────────────────────────────────────────────────────

function generateSteps(title: string): string[] {
  return [
    "Analyze requirements and plan implementation",
    "Implement core logic",
    "Add tests",
    "Integration testing and cleanup",
  ];
}

function generateStepsDetailed(title: string, count: number): string[] {
  const pools: Record<number, string[]> = {
    3: [
      "Set up infrastructure and dependencies",
      "Implement core functionality",
      "Tests, error handling, and cleanup",
    ],
    4: [
      "Analyze codebase and plan approach",
      "Implement core logic",
      "Add tests and edge case handling",
      "Integration testing and documentation",
    ],
  };
  return pools[count] || pools[4];
}

async function writePrompt(
  store: TaskStore,
  id: string,
  title: string,
  desc: string,
  steps: string[],
  deps?: string[],
) {
  const depsSection = deps?.length
    ? deps.map((d) => `- **Task:** ${d}`).join("\n")
    : "- **None**";

  const stepsSection = steps
    .map(
      (s, i) => `### Step ${i + 1}: ${s}\n\n- [ ] Complete implementation\n- [ ] Verify correctness`,
    )
    .join("\n\n");

  const prompt = `# ${id}: ${title}

**Created:** ${new Date().toISOString().split("T")[0]}
**Size:** M

## Mission

${desc}

## Dependencies

${depsSection}

## File Scope

- \`src/\`

## Steps

${stepsSection}

## Acceptance Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] No regressions
`;

  const dir = join(store.getRootDir(), ".kb", "tasks", id);
  await writeFile(join(dir, "PROMPT.md"), prompt);
}

async function addLogs(store: TaskStore, id: string, targetColumn: string) {
  const actions: Record<string, string[][]> = {
    done: [
      ["Triage complete — spec written", "approved"],
      ["Scheduled for execution", "worktree created"],
      ["Step 0 started", "in-progress"],
      ["Review: step 0", "approved"],
      ["Step 1 started", "in-progress"],
      ["Review: step 1", "approved"],
      ["Step 2 started", "in-progress"],
      ["Review: step 2", "approved"],
      ["Step 3 started", "in-progress"],
      ["Review: step 3", "approved"],
      ["All steps complete — moved to review"],
      ["Auto-merged into main"],
    ],
    "in-review": [
      ["Triage complete — spec written", "approved"],
      ["Scheduled for execution", "worktree created"],
      ["Step 0 started", "in-progress"],
      ["Review: step 0", "approved"],
      ["Step 1 started", "in-progress"],
      ["Review: step 1", "approved"],
      ["Step 2 started", "in-progress"],
      ["Review: step 2", "approved — minor nits addressed"],
      ["Step 3 started", "in-progress"],
      ["Review: step 3", "approved"],
      ["All steps complete — moved to review"],
    ],
    "in-progress": [
      ["Triage complete — spec written", "approved"],
      ["Scheduled for execution", "worktree created"],
      ["Step 0 started", "in-progress"],
      ["Review: step 0", "approved"],
      ["Step 1 started", "in-progress"],
    ],
  };

  const entries = actions[targetColumn] || [];
  for (const [action, outcome] of entries) {
    await store.logEntry(id, action, outcome);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
