import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * FNXC:RunAudit 2026-08-20-07:16:
 * FN-9178 makes every direct awaited core audit writer a named decision rather than an implicit
 * exception. Class C retains its ordering claim while transactional/sink writers remain permanent
 * atomicity boundaries. FN-9180 routed class-A outbox rows and FN-9182 routed class-B sites
 * through bounded seams, so neither class remains in this direct-await inventory.
 */
const awaitedClassifications = {
  "store.ts:task:bypass-review": "C",
  "store.ts:task:resume-step": "C",
  "task-store/task-creation.ts:intake:resurrection-blocked": "C",
  "task-store/task-id-integrity.ts:task:resurrection-blocked": "C",
  "task-store/project-store-ops.ts:recordRunAuditEventImpl": "permanent-sink",
} as const;

const transactionalSourceBoundaries = [
  "task-store/moves.ts", "task-store/symbol-locks.ts", "task-store/async/async-merge-coordination.ts",
  "task-store/lifecycle-ops.ts", "task-store/task-creation.ts", "task-store/project-store-ops.ts",
  "task-store/task-artifacts-ops.ts", "task-store/task-lifecycle-consumer-registry.ts",
  "task-store/async/async-comments-attachments.ts", "task-store/async/async-workflow-workitems.ts",
  "task-store/archive-lifecycle-2.ts",
] as const;

const files = [
  "../planner/planner-intervention.ts", "../task-store/audit-ops.ts", "../task-store/branch-group-ops.ts",
  "../task-store/merge-queue-ops-2.ts", "../task-store/task-mutation-ops.ts", "../task-store/workflow-integrity.ts",
  "../task-store/workflow-workitems-ops.ts", "../task-store/workflow-workitems-ops-2.ts", "../task-store/task-artifacts-ops.ts",
  "../task-store/lifecycle-ops.ts", "../task-store/task-id-integrity.ts", "../task-store/workflow-definitions.ts",
  "../task-store/async/async-phantom-reservations.ts", "../task-store/task-deleted-outbox-consumer.ts",
  "../task-store/task-lifecycle-event-retention.ts", "../memory/recall-capture.ts",
];

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(`${directory}/${entry.name}`, `${relative}/`);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative] : [];
  });
}

function awaitedAuditInventory() {
  const call = /await\s+(?:(?:this|store)\.)?recordRunAuditEvent(?:Async)?\s*\(/g;
  return sourceFiles(sourceRoot).flatMap((relative) => {
    const source = readFileSync(`${sourceRoot}/${relative}`, "utf8");
    return [...source.matchAll(call)].map((match) => {
      const body = source.slice(match.index, match.index! + 1_600);
      const mutation = body.match(/mutationType:\s*(?:"([^"]+)"|type)/)?.[1]
        ?? (relative === "memory/recall-capture.ts" ? "memory:capture-recorded|memory:capture-failed" : undefined);
      return `${relative}:${mutation ?? "recordRunAuditEventImpl"}`;
    });
  }).sort();
}

function transactionalAuditInventory() {
  const call = /await\s+(?:(?:store\.)?recordRunAuditEventWithinTransaction|store\.recordRunAuditEventBackend)\s*\(/g;
  return sourceFiles(sourceRoot).flatMap((relative) => {
    const source = readFileSync(`${sourceRoot}/${relative}`, "utf8");
    return [...source.matchAll(call)].map(() => relative);
  }).sort();
}

describe("core run-audit emitter isolation", () => {
  it("fails closed when a direct awaited non-transactional audit emitter lacks a classification", () => {
    expect(awaitedAuditInventory()).toEqual(Object.keys(awaitedClassifications).sort());
  });

  it("keeps transactional awaited writers as named atomicity boundaries", () => {
    const inventory = new Set(transactionalAuditInventory());
    expect([...inventory].sort()).toEqual([...transactionalSourceBoundaries].sort());
  });

  it("routes every best-effort core emitter through the bounded seam", () => {
    for (const relative of files) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      expect(source, relative).toContain("emitBoundedRunAudit");
      // Interface fields and host adapters may retain this identifier; only direct void/await calls are forbidden.
      expect(source.match(/(?:await|void)\s+(?:\([^)]*\)\.)?recordRunAuditEvent\??\s*\(/g), relative).toBeNull();
    }
  });
});
