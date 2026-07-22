import { describe, expect, it, vi } from "vitest";
import type { TaskStore, RunAuditEventInput } from "@fusion/core";
import {
  SquashAuditError,
  handleDirtyPostMergeAuditOutcome,
} from "../merger.js";
import { createRunAuditor, type RunAuditor } from "../util/run-audit.js";
import type {
  SquashAuditDuplicateSubjectFinding,
  SquashAuditFindings,
  SquashAuditTouchedFileOverlapFinding,
} from "../merge/merger-squash-audit.js";

function overlap(file: string): SquashAuditTouchedFileOverlapFinding {
  return {
    type: "touched-file-overlap",
    file,
    recentMainCommits: [{ sha: "abcdef12", subject: "chore: recent main edit" }],
  };
}

function duplicateSubject(subject: string): SquashAuditDuplicateSubjectFinding {
  return { type: "duplicate-subject", subject };
}

function findings(opts: {
  strategy: "squash" | "rebase";
  duplicates?: SquashAuditDuplicateSubjectFinding[];
  overlaps?: SquashAuditTouchedFileOverlapFinding[];
}): SquashAuditFindings {
  const duplicates = opts.duplicates ?? [];
  const overlaps = opts.overlaps ?? [];
  const all = [...duplicates, ...overlaps];
  const base = {
    parentSha: "0".repeat(40),
    lookback: 30,
    branchSubjects: [],
    recentMainSubjects: [],
    duplicateSubjects: duplicates,
    touchedFiles: overlaps.map((o) => o.file),
    touchedFileOverlaps: overlaps,
    findings: all,
    issueCount: all.length,
    clean: all.length === 0,
  };
  if (opts.strategy === "rebase") {
    return {
      ...base,
      strategy: "rebase",
      rangeBaseSha: "1".repeat(40),
      rangeHeadSha: "2".repeat(40),
      auditTargetLabel: "11111111..22222222",
    };
  }
  return {
    ...base,
    strategy: "squash",
    squashSha: "3".repeat(40),
    squashSubject: "feat: squash",
    auditTargetLabel: "33333333",
  };
}

function createStore(recordImpl?: (input: RunAuditEventInput) => Promise<void>) {
  const recordRunAuditEvent = vi.fn(recordImpl ?? (async () => {}));
  const appendAgentLog = vi.fn(async () => {});
  const updateTask = vi.fn(async () => {});
  const store = {
    recordRunAuditEvent,
    appendAgentLog,
    updateTask,
  } as unknown as TaskStore;
  return { store, recordRunAuditEvent, appendAgentLog, updateTask };
}

function createAudit(store: TaskStore): RunAuditor {
  return createRunAuditor(store, {
    runId: "run-1",
    agentId: "agent-1",
    taskId: "FN-4432",
    phase: "merge-attempt-1",
  });
}

async function dispatchLikeMerger(opts: {
  mode: "block" | "warn" | "off";
  dirtyFindings: SquashAuditFindings;
  audit: RunAuditor;
  store: TaskStore;
  verificationPassed: boolean;
}) {
  if (opts.mode === "off") return;
  if (opts.dirtyFindings.clean) return;
  await handleDirtyPostMergeAuditOutcome({
    taskId: "FN-4432",
    auditSha: "a".repeat(40),
    mode: opts.mode,
    strategy: opts.dirtyFindings.strategy,
    findings: opts.dirtyFindings,
    verificationPassed: opts.verificationPassed,
    audit: opts.audit,
    store: opts.store,
    mergerLog: { warn: vi.fn(), log: vi.fn() },
  });
}

describe("post-merge audit failure run_audit emission (FN-4432)", () => {
  it("emits merge:audit-failure in block mode and still throws SquashAuditError", async () => {
    const { store, recordRunAuditEvent } = createStore();
    const audit = createAudit(store);

    await expect(
      handleDirtyPostMergeAuditOutcome({
        taskId: "FN-4432",
        auditSha: "a".repeat(40),
        mode: "block",
        strategy: "squash",
        findings: findings({ strategy: "squash", duplicates: [duplicateSubject("feat: collide")] }),
        verificationPassed: false,
        audit,
        store,
        mergerLog: { warn: vi.fn(), log: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(SquashAuditError);

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0][0].mutationType).toBe("merge:audit-failure");
    expect(recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({
      mode: "block",
      action: "block",
      reason: "mode-block",
      strategy: "squash",
    });
  });

  it("emits once in warn mode with pass/mode-warn and does not throw", async () => {
    const { store, recordRunAuditEvent } = createStore();
    const audit = createAudit(store);

    await expect(
      handleDirtyPostMergeAuditOutcome({
        taskId: "FN-4432",
        auditSha: "a".repeat(40),
        mode: "warn",
        strategy: "squash",
        findings: findings({ strategy: "squash", duplicates: [duplicateSubject("feat: collide")] }),
        verificationPassed: false,
        audit,
        store,
        mergerLog: { warn: vi.fn(), log: vi.fn() },
      }),
    ).resolves.toMatchObject({ action: "pass", reason: "mode-warn" });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({ mode: "warn", action: "pass", reason: "mode-warn" });
  });

  it("emits verified-short-circuit for rebase overlap-only findings", async () => {
    const { store, recordRunAuditEvent } = createStore();
    const audit = createAudit(store);

    await expect(
      handleDirtyPostMergeAuditOutcome({
        taskId: "FN-4432",
        auditSha: "a".repeat(40),
        mode: "block",
        strategy: "rebase",
        findings: findings({ strategy: "rebase", overlaps: [overlap("docs/README.md")] }),
        verificationPassed: true,
        audit,
        store,
        mergerLog: { warn: vi.fn(), log: vi.fn() },
      }),
    ).resolves.toMatchObject({ action: "pass", reason: "verified-short-circuit" });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0][0].metadata).toMatchObject({
      strategy: "rebase",
      action: "pass",
      reason: "verified-short-circuit",
    });
  });

  it("skips emission for clean audits", async () => {
    const { store, recordRunAuditEvent } = createStore();
    const audit = createAudit(store);

    await dispatchLikeMerger({
      mode: "block",
      dirtyFindings: findings({ strategy: "squash" }),
      audit,
      store,
      verificationPassed: false,
    });

    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("skips emission when mode=off", async () => {
    const { store, recordRunAuditEvent } = createStore();
    const audit = createAudit(store);

    await dispatchLikeMerger({
      mode: "off",
      dirtyFindings: findings({ strategy: "squash", duplicates: [duplicateSubject("feat: collide")] }),
      audit,
      store,
      verificationPassed: false,
    });

    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("swallows recording failures and still throws block-mode SquashAuditError", async () => {
    const { store, recordRunAuditEvent } = createStore(async () => {
      throw new Error("db unavailable");
    });
    const audit = createAudit(store);

    await expect(
      handleDirtyPostMergeAuditOutcome({
        taskId: "FN-4432",
        auditSha: "a".repeat(40),
        mode: "block",
        strategy: "squash",
        findings: findings({ strategy: "squash", duplicates: [duplicateSubject("feat: collide")] }),
        verificationPassed: false,
        audit,
        store,
        mergerLog: { warn: vi.fn(), log: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(SquashAuditError);

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });
});
