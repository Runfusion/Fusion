// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's retirement census across the SERVER-side write contracts.

These are code-construct assertions over real entry points, not prose checks. The point is that a
task-priority parameter cannot come back through ANY door: the CLI extension schema, the engine and
triage creation tools, the plugin route, or an automatic producer that used to project an incident
severity onto the created card. A single surviving door silently reintroduces a hidden ordering
input that nothing else in the system honours.
*/

const read = (repoRelative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${repoRelative}`, import.meta.url)), "utf8");

describe("task-creation tool schemas expose no priority parameter", () => {
  it.each([
    ["packages/cli/src/extension.ts", "fn_task_create / fn_task_update"],
    ["packages/engine/src/agent-tools.ts", "engine task-create tool"],
    ["packages/engine/src/triage.ts", "triage subtask tool"],
  ])("%s (%s) declares no priority field", (path) => {
    const source = read(path);
    expect(source).not.toContain(`priority: Type.Optional(`);
    expect(source).not.toContain("TASK_PRIORITY_VALUES");
    expect(source).not.toContain("taskCreatePriorityValues");
  });

  it("the CLI extension no longer reports a priority on task reads or updates", () => {
    const source = read("packages/cli/src/extension.ts");
    expect(source).not.toContain("Priority: ${task.priority}");
    expect(source).not.toContain("priority: task.priority");
    expect(source).not.toContain("updates.priority");
  });

  it("the generated skill reference carries no priority parameter row", () => {
    const reference = read("packages/cli/skill/fusion/references/extension-tools.md");
    expect(reference).not.toContain("| `priority` |");
  });
});

describe("explicit priority in a NEW request is refused, not silently dropped", () => {
  const REFUSAL = "priority is no longer supported";

  it.each([
    ["packages/dashboard/src/routes/register-task-workflow-routes.ts", "task create + PATCH"],
    ["packages/dashboard/src/research-routes.ts", "research finding promotion"],
    ["plugins/fusion-plugin-todos/src/todo-routes.ts", "todo promotion"],
  ])("%s (%s) rejects it with a clear message", (path) => {
    expect(read(path)).toContain(REFUSAL);
  });

  it("no write path silently forwards a priority into createTask", () => {
    for (const path of [
      "packages/dashboard/src/routes/register-task-workflow-routes.ts",
      "packages/dashboard/src/research-routes.ts",
      "packages/dashboard/src/routes/register-signal-routes.ts",
      "packages/dashboard/src/monitor-trait.ts",
      "packages/dashboard/src/triage-trait.ts",
      "packages/dashboard/src/routes/register-messaging-scripts.ts",
      "packages/engine/src/eval/eval-followups.ts",
      "packages/engine/src/execution/task-revert.ts",
    ]) {
      const source = read(path);
      expect(source, path).not.toMatch(/^\s*priority: (params|input|followUp|sourceTask|classification|proposal)/m);
    }
  });
});

describe("automatic producers no longer convert their own severity into a task rank", () => {
  it("the triage classifier's severity inference is deleted, not merely unused", () => {
    const source = read("packages/dashboard/src/triage-trait.ts");
    expect(source).not.toContain("function inferPriority");
  });

  it("a promoted research finding, a signal, and a monitor alert create an ordinary task", () => {
    for (const path of [
      "packages/dashboard/src/research-routes.ts",
      "packages/dashboard/src/routes/register-signal-routes.ts",
      "packages/dashboard/src/monitor-trait.ts",
    ]) {
      expect(read(path), path).not.toMatch(/priority: (signal|input)\.severity/);
    }
  });

  it("a legacy planning summary's level is dropped rather than re-emitted onto the new task", () => {
    for (const path of [
      "packages/dashboard/src/planning.ts",
      "packages/dashboard/src/routes/register-planning-subtask-routes.ts",
    ]) {
      const source = read(path);
      expect(source, path).not.toContain("isTaskPriority(summary.priority)");
      expect(source, path).not.toContain("DEFAULT_TASK_PRIORITY");
    }
  });

  it("the glasses plugin card no longer announces a priority", () => {
    expect(read("plugins/fusion-plugin-even-realities-glasses/src/cards.ts")).not.toContain("Priority ${task.priority");
  });
});

describe("independent priority domains are deliberately preserved", () => {
  it("keeps the ntfy notification priority, which is not a task rank", () => {
    expect(read("packages/dashboard/src/planning.ts")).toContain('priority: "high"');
  });

  it("keeps the eval suggestion severity band that QUALIFIES follow-ups", () => {
    const source = read("packages/engine/src/eval/eval-followups.ts");
    expect(source).toContain("inferPriority");
    expect(source).toContain("suggestion.priority");
  });

  it("keeps InboxTask's routing reason, which names WHY a task was selected", () => {
    expect(read("packages/core/src/types/task/task-core.ts")).toContain(`priority: "in_progress" | "todo" | "blocked"`);
  });
});

describe("the retired ordering contract is gone from the live Done API", () => {
  it("refuses an explicit sort instead of honouring a mode the server dropped", () => {
    const source = read("packages/dashboard/src/routes/register-task-workflow-routes.ts");
    expect(source).toContain("sort is no longer supported");
  });
});
