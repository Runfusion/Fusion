import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentLogEntry } from "../types.js";
import { AgentStore } from "../agents/agent-store.js";
import {
  AGENT_LOG_TOOL_DETAIL_LIMIT,
  AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE,
} from "../agents/agent-log-constants.js";

describe("AgentStore run-log detail bounds", () => {
  let rootDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-agent-run-log-"));
    await mkdir(join(rootDir, "agents"), { recursive: true });
    store = new AgentStore({ rootDir });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("uses the shared tool-detail bound for the durable row and matching run:log event", async () => {
    const agentId = "agent-001";
    const runId = "run-001";
    const detail = "x".repeat(AGENT_LOG_TOOL_DETAIL_LIMIT + 200);
    const emitted: AgentLogEntry[] = [];
    store.on("run:log", (_agentId, _runId, entry) => emitted.push(entry));

    await store.appendRunLog(agentId, runId, {
      timestamp: "2026-08-29T00:00:00.000Z",
      taskId: "FN-253",
      text: "fn_run_verification",
      type: "tool_result",
      detail,
    });

    const raw = await readFile(join(rootDir, "agents", `${agentId}-runlogs-${runId}.jsonl`), "utf8");
    const durableRow = JSON.parse(raw) as AgentLogEntry;
    const persisted = await store.getRunLogs(agentId, runId);

    expect(durableRow.detail).toBe(`${detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT)}${AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE}`);
    expect(persisted[0]?.detail).toBe(durableRow.detail);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.detail).toBe(durableRow.detail);
  });

  it("retains the existing 64 KB outer guard for non-tool text", async () => {
    const oversizedText = "t".repeat(64 * 1024 + 1);

    await store.appendRunLog("agent-002", "run-002", {
      timestamp: "2026-08-29T00:00:00.000Z",
      taskId: "FN-253",
      text: oversizedText,
      type: "text",
    });

    const [persisted] = await store.getRunLogs("agent-002", "run-002");
    expect(persisted?.text).toContain(`... (truncated, ${oversizedText.length} chars)`);
    expect(persisted?.text.length).toBeGreaterThan(64 * 1024);
  });
});
