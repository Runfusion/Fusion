import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const taskStore = join(here, "../task-store");
const workItemsSource = readFileSync(join(taskStore, "async-workflow-workitems.ts"), "utf8");
const workItemFacadeSource = readFileSync(join(taskStore, "workflow-workitems-ops-2.ts"), "utf8");
const auditedPersistenceSource = readFileSync(join(taskStore, "project-store-ops.ts"), "utf8");
const persistenceSource = readFileSync(join(taskStore, "workflow-task-create-ops.ts"), "utf8");
const coreSourceRoot = join(here, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function exportedBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} must remain an explicit protected writer`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("\nexport ", start + 1));
}

/*
FNXC:WorkflowSerialization 2026-07-27-00:15:
FN-8592 requires a static, complete protected-writer ratchet. It covers every
PostgreSQL route that can create an ACTIVE continuation (including lease claim)
and both generic task persistence routes that can publish plan-review:passed.
The conditional zero-row repair is sound only while all of these writers take
the same advisory transaction lock.
*/
describe("FN-8592 workflow task serialization protocol", () => {
  it("keeps every active-continuation writer behind the shared task lock", () => {
    for (const [source, writer] of [
      [workItemsSource, "upsertWorkflowWorkItem"],
      [workItemsSource, "replaceActiveTaskWorkflowContinuation"],
      [workItemsSource, "seedStrandedPlanReviewContinuation"],
      [workItemsSource, "transitionWorkflowWorkItem"],
      [workItemFacadeSource, "acquireWorkflowWorkItemLeaseImpl"],
    ] as const) {
      expect(exportedBody(source, writer), `${writer} must serialize task workflow writes`)
        .toContain("withTaskWorkflowSerialization");
    }
  });

  it("keeps both persisted plan-review passed writers behind the shared task lock", () => {
    for (const [source, writer] of [
      [auditedPersistenceSource, "atomicWriteTaskJsonWithAuditImpl"],
      [persistenceSource, "atomicWriteTaskJsonImpl2"],
    ] as const) {
      const body = exportedBody(source, writer);
      expect(body).toContain('workflowStepId === "plan-review"');
      expect(body).toContain('status === "passed"');
      expect(body).toContain("withTaskWorkflowSerialization");
    }
  });

  it("rejects plan-review passed persistence outside the enumerated protected writer set", () => {
    const allowed = new Set([
      join(taskStore, "async-workflow-workitems.ts"),
      // The embedded-store conditional fallback reads this same predicate in
      // one SQLite immediate transaction; it is not a PostgreSQL bypass.
      join(taskStore, "workflow-workitems-ops-2.ts"),
      join(taskStore, "project-store-ops.ts"),
      join(taskStore, "workflow-task-create-ops.ts"),
    ]);
    for (const path of sourceFiles(coreSourceRoot)) {
      const source = readFileSync(path, "utf8");
      if (/workflowStepId\s*===\s*["']plan-review["'][\s\S]{0,500}status\s*===\s*["']passed["']/.test(source)) {
        expect(allowed, `plan-review:passed persistence/check in ${path} must be added to the protocol set`)
          .toContain(path);
      }
    }
  });

  it("rejects unprotected PostgreSQL active-state mutation sites anywhere in core", () => {
    const allowed = new Set([
      join(taskStore, "async-workflow-workitems.ts"),
      join(taskStore, "workflow-workitems-ops-2.ts"),
    ]);
    const activeMutationMarkers = [
      ".insert(schema.project.workflowWorkItems)",
      ".update(schema.project.workflowWorkItems)",
    ];
    // Scan every core source file, not just today's two implementation files.
    // A future persistence route that writes an active continuation must join
    // the protected-writer set instead of silently bypassing the advisory lock.
    for (const path of sourceFiles(coreSourceRoot)) {
      const source = readFileSync(path, "utf8");
      for (const marker of activeMutationMarkers) {
        let offset = source.indexOf(marker);
        while (offset >= 0) {
          expect(allowed, `${marker} in ${path} must be added to the protocol set`).toContain(path);
          const preceding = source.slice(0, offset);
          const functionStart = preceding.lastIndexOf("export async function ");
          const body = source.slice(functionStart, source.indexOf("\nexport ", functionStart + 1));
          expect(body, `${marker} must remain inside a protected writer`).toContain("withTaskWorkflowSerialization");
          offset = source.indexOf(marker, offset + marker.length);
        }
      }
    }
  });

  it("uses an unfiltered active-state check in the conditional repair", () => {
    const body = exportedBody(workItemsSource, "seedStrandedPlanReviewContinuation");
    expect(body).toContain("ACTIVE_WORKFLOW_WORK_ITEM_STATES");
    expect(body).not.toContain("kind,");
    expect(body).toContain('workflowStepId === "plan-review"');
    expect(body).toContain('status === "passed"');
    // Task identifiers are project-local in embedded PostgreSQL. Both sides
    // of the conditional predicate must stay bound to the layer's project.
    expect(body).toContain("projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId)");
    expect(body).toContain("projectScopeFor(schema.project.tasks.projectId, layer.projectId)");
  });
});
