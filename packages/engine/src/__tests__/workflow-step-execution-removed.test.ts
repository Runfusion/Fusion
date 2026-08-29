// FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2) grep-guard.
// The legacy `runWorkflowSteps` execution path + the `workflow-step` seam /
// `runWorkflowStep` primitive were removed; the workflow graph is the sole
// workflow-step executor (results recorded into task.workflowStepResults, U2).
// This test fails loudly if a production caller of the deleted runner is
// reintroduced, or if the removed seam/primitive handlers come back.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listProductionTsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("U4: legacy workflow-step execution path removed", () => {
  const files = listProductionTsFiles(srcDir);

  it("has no production caller of the deleted runWorkflowSteps runner", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Match an actual call/seam-key, not the FNXC comments that reference the name.
      if (/this\.runWorkflowSteps\s*\(|[^.\w]runWorkflowStep\s*:/.test(text)) {
        offenders.push(file.replace(srcDir, "@fusion/engine/src"));
      }
    }
    expect(offenders, `unexpected runWorkflowSteps/runWorkflowStep usage in ${offenders.join(", ")}`).toEqual([]);
  });

  it("no production code declares a workflow-step seam handler", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/workflowStep\s*:\s*async|workflowStep\?\s*:/.test(text)) {
        offenders.push(file.replace(srcDir, "@fusion/engine/src"));
      }
    }
    expect(offenders, `unexpected workflowStep seam handler in ${offenders.join(", ")}`).toEqual([]);
  });
});
