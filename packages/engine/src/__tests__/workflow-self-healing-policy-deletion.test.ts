import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RECOVERY_EVENTS_PATH = resolve(__dirname, "../workflow-recovery-events.ts");
const SELF_HEALING_PATH = resolve(__dirname, "../self-healing.ts");

describe("workflow self-healing policy deletion guard", () => {
  it("records recovery facts as workflow work while keeping event publication mutation-free", () => {
    const recoveryEventsSource = readFileSync(RECOVERY_EVENTS_PATH, "utf8");
    const selfHealingSource = readFileSync(SELF_HEALING_PATH, "utf8");

    expect(selfHealingSource).toContain("publishWorkflowRecoveryEvent");
    expect(selfHealingSource).toContain("\"transient-merge-failure\"");
    expect(selfHealingSource).toContain("\"completion-handoff-limbo\"");
    expect(recoveryEventsSource).toContain("upsertWorkflowWorkItem");
    expect(recoveryEventsSource).toContain("recovery-router");
    expect(recoveryEventsSource).not.toContain("moveTask");
    expect(recoveryEventsSource).not.toContain("updateTask");
    expect(recoveryEventsSource).not.toContain("enqueueMerge");
    expect(recoveryEventsSource).not.toContain("transitionMergeRequestState");
  });
});
