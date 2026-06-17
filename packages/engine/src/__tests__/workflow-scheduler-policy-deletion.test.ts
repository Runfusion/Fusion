import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WORKFLOW_SCHEDULER_PATH = resolve(__dirname, "../workflow-work-scheduler.ts");

describe("workflow scheduler policy deletion guard", () => {
  it("keeps generic workflow work claiming independent of task lifecycle columns", () => {
    const source = readFileSync(WORKFLOW_SCHEDULER_PATH, "utf8");

    expect(source).toContain("listDueWorkflowWorkItems");
    expect(source).toContain("acquireWorkflowWorkItemLease");
    expect(source).not.toMatch(/\bgetTask\b/);
    expect(source).not.toMatch(/\bmoveTask\b/);
    expect(source).not.toMatch(/["']in-review["']/);
    expect(source).not.toMatch(/\bmergeRetries\b/);
    expect(source).not.toMatch(/\bretryAfter\b/);
  });
});
