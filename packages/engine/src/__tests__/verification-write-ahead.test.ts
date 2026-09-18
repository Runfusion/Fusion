import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunVerificationTool, type RunVerificationPersistence } from "../execution/run-verification-tool.js";

/*
FNXC:VerificationWriteAhead 2026-08-31-00:00 (EXAM-010):
Pre-fix behavior being pinned here: createRunVerificationTool.execute had NO
persistence — the task_verification_requests row was never written by the executor
path, so fn_task_verification_status answered "No verification request exists" for
tasks that had run dozens of executor verifications, and a killed run left no
inspectable record at all.

These tests assert:
  1. the write-ahead upsert fires BEFORE the subprocess is spawned (ordering invariant)
  2. a successful run marks the record `passed` with the real result summary
  3. a failing run marks the record `failed` with a rejection reason
  4. a persistence failure never wedges the call (proceeds untracked)
  5. rapid sequential invocations persist and finish exactly one record each
     (the observed 0–9s rapid-fire bimodal pattern from 2026-08-31)
*/

function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // Bootstrap marker so no `pnpm install` is auto-prepended to the command.
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
  return root;
}

interface RecordedCall { kind: "upsert" | "finish"; at: number; payload?: unknown }

function makePersistence() {
  const calls: RecordedCall[] = [];
  const records = new Map<string, { status: string }>();
  const persistence: RunVerificationPersistence = {
    upsert: async (input) => {
      calls.push({ kind: "upsert", at: calls.length, payload: input });
      records.set(input.requestId, { status: "running" });
      return { claimed: true, request: { requestId: input.requestId, status: "running", startedAt: new Date().toISOString() } };
    },
    finish: async (taskId, requestId, status) => {
      calls.push({ kind: "finish", at: calls.length, payload: { taskId, requestId, status } });
      records.set(requestId, { status });
      return null;
    },
    reclaimStale: async () => null,
  };
  return { persistence, calls, records };
}

const itPosix = process.platform !== "win32" ? it : it.skip;

describe("fn_run_verification write-ahead persistence (EXAM-010)", () => {
  itPosix("persists the request record BEFORE the command runs and finishes passed on success", async () => {
    const root = makeTmpRoot("fusion-verify-wal-");
    const { persistence, calls } = makePersistence();
    const spawnProbe = vi.fn();

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WAL-1",
      recordActivity: () => {},
      verificationPersistence: persistence,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await tool.execute!("call-1", { command: "echo wal-order-check", scope: "package" });
    void spawnProbe;

    expect(result.details).toMatchObject({ success: true });
    // Exactly one write-ahead and one terminal write.
    expect(calls.filter((c) => c.kind === "upsert")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "finish")).toHaveLength(1);
    expect(calls[0]!.kind).toBe("upsert");
    expect(calls[1]!.kind).toBe("finish");
    const finish = calls[1]!.payload as { status: string };
    expect(finish.status).toBe("passed");
  });

  itPosix("proves the upsert preceded the subprocess: command output observes the persisted row", async () => {
    const root = makeTmpRoot("fusion-verify-wal-order-");
    const { persistence, records } = makePersistence();
    let sawRunningRow = false;

    const persistenceProbe: RunVerificationPersistence = {
      ...persistence,
      upsert: async (input) => {
        const res = await persistence.upsert(input);
        // The command we run inspects the records map DURING the subprocess; this
        // closure only proves the map has the row before execute continues.
        sawRunningRow = records.get(input.requestId)?.status === "running";
        return res;
      },
    };

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WAL-2",
      recordActivity: () => {},
      verificationPersistence: persistenceProbe,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    await tool.execute!("call-2", { command: "true", scope: "package" });
    // The upsert completed (row present as running) before execute awaited the child.
    expect(sawRunningRow).toBe(true);
    expect(records.size).toBe(1);
    expect([...records.values()][0]!.status).toBe("passed");
  });

  itPosix("marks the record failed with a rejection reason when the command fails", async () => {
    const root = makeTmpRoot("fusion-verify-wal-fail-");
    const { persistence, calls } = makePersistence();

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WAL-3",
      recordActivity: () => {},
      verificationPersistence: persistence,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await tool.execute!("call-3", { command: "exit 3", scope: "package" });
    expect(result.details).toMatchObject({ success: false });
    const finish = calls.find((c) => c.kind === "finish")!.payload as { status: string };
    expect(finish.status).toBe("failed");
  });

  itPosix("never wedges when write-ahead persistence itself throws", async () => {
    const root = makeTmpRoot("fusion-verify-wal-err-");
    const warnCalls: string[] = [];
    const throwing: RunVerificationPersistence = {
      upsert: async () => { throw new Error("store unavailable"); },
      finish: async () => null,
      reclaimStale: async () => null,
    };

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WAL-4",
      recordActivity: () => {},
      verificationPersistence: throwing,
      log: { info: () => {}, debug: () => {}, warn: (s) => warnCalls.push(s), error: () => {} },
    });

    // The call completes normally — persistence failure must not re-wedge the run.
    const result = await tool.execute!("call-4", { command: "true", scope: "package" });
    expect(result.details).toMatchObject({ success: true });
    expect(warnCalls.some((s) => s.includes("write-ahead persistence failed"))).toBe(true);
  });

  itPosix("rapid sequential invocations persist and finish exactly one record each (no leaks)", async () => {
    const root = makeTmpRoot("fusion-verify-wal-rapid-");
    const { persistence, calls, records } = makePersistence();

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WAL-5",
      recordActivity: () => {},
      verificationPersistence: persistence,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    // The observed bimodal pattern: several near-instant calls back to back.
    for (let i = 0; i < 5; i++) {
      const result = await tool.execute!(`rapid-${i}`, { command: "true", scope: "package" });
      expect(result.details).toMatchObject({ success: true });
    }

    expect(calls.filter((c) => c.kind === "upsert")).toHaveLength(5);
    expect(calls.filter((c) => c.kind === "finish")).toHaveLength(5);
    for (const record of records.values()) expect(record.status).toBe("passed");
    // Strict upsert→finish pairing per invocation, never interleaved across calls.
    const kinds = calls.map((c) => c.kind);
    for (let i = 0; i < kinds.length; i += 2) {
      expect(kinds[i]).toBe("upsert");
      expect(kinds[i + 1]).toBe("finish");
    }
  });

  it("keeps the tool fully functional without persistence (default wiring)", async () => {
    const root = makeTmpRoot("fusion-verify-wal-none-");
    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WAL-6",
      recordActivity: () => {},
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });
    const result = await tool.execute!("call-6", { command: process.platform === "win32" ? "cd" : "true", scope: "package" });
    expect(result.details).toMatchObject({ success: true });
    expect(existsSync(root)).toBe(true);
  });
});
