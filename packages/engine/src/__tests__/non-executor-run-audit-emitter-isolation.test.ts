import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modules = [
  "util/run-audit.ts",
  "self-healing.ts",
  "merger.ts",
  "merge/merger-ai.ts",
  "merge/pr-reconcile.ts",
  "scheduler.ts",
  "project-engine.ts",
  "plugins/plugin-runner.ts",
  "missions/mission-execution-loop.ts",
  "execution/hold-release.ts",
  "goals/goal-injection-diagnostics.ts",
  "goals/goal-anchoring-audit.ts",
  "overseer/overseer-advisor-service.ts",
  "project/mesh-lease-manager.ts",
  "runtimes/in-process-runtime.ts",
  "credential-instance-rotation.ts",
  "workflow-column-boundary-hooks.ts",
] as const;

/**
 * FNXC:RunAudit 2026-08-20-04:15:
 * FN-9175 keeps this small routing ratchet alongside behavioral sink tests. Direct sink calls in
 * engine lifecycle lanes bypass the bound and can turn optional telemetry into a recovery failure.
 */
describe("FN-9175 non-executor run-audit routing", () => {
  it.each(modules)("routes %s through the bounded seam", (modulePath) => {
    const source = readFileSync(resolve(import.meta.dirname, "..", modulePath), "utf8");
    expect(source).toContain("emitBoundedRunAudit");
    const directCalls = source.match(/(?:await|void)\s+(?:\([^)]*\)\.)?recordRunAuditEvent\??\s*\(/g) ?? [];
    expect(directCalls).toEqual([]);
  });
});
