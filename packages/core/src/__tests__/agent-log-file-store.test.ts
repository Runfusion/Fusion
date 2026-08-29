import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendAgentLogEntriesSync,
  countAgentLogEntries,
  getAgentLogFilePath,
  readAgentLogEntries,
  readAgentLogEntriesByTimeRange,
} from "../agents/agent-log-file-store.js";
import { AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE } from "../agents/agent-log-constants.js";

const tempDirs: string[] = [];

function createTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-agent-log-file-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent-log-file-store", () => {
  it("appends and reads entries with stable line-number source refs", () => {
    const taskDir = createTaskDir();

    const appended = appendAgentLogEntriesSync(taskDir, [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId: "FN-1", text: "first", type: "text" },
      { timestamp: "2026-01-01T00:01:00.000Z", taskId: "FN-1", text: "second", type: "tool", detail: "readme.md", agent: "executor" },
    ]);

    expect(appended.map((entry) => entry.sourceRef)).toEqual([
      "agentLog:FN-1:1",
      "agentLog:FN-1:2",
    ]);
    expect(readAgentLogEntries(taskDir)).toEqual(appended);
  });

  it("round-trips optional timing metadata while legacy rows can omit it", () => {
    const taskDir = createTaskDir();
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId: "FN-1", text: "legacy", type: "text" },
      { timestamp: "2026-01-01T00:00:01.000Z", taskId: "FN-1", text: "first", type: "text", timeToFirstTokenMs: 1234.4 },
      { timestamp: "2026-01-01T00:00:02.000Z", taskId: "FN-1", text: "Bash", type: "tool_result", durationMs: 842.2 },
    ]);

    const entries = readAgentLogEntries(taskDir);
    expect(entries).toMatchObject([
      { text: "legacy" },
      { text: "first", timeToFirstTokenMs: 1234 },
      { text: "Bash", durationMs: 842 },
    ]);
    expect(entries[0]).not.toHaveProperty("timeToFirstTokenMs");
    expect(entries[0]).not.toHaveProperty("durationMs");
    expect(entries[1]).not.toHaveProperty("durationMs");
    expect(entries[2]).not.toHaveProperty("timeToFirstTokenMs");
  });

  it("ignores invalid legacy timing fields", () => {
    const taskDir = createTaskDir();
    const filePath = getAgentLogFilePath(taskDir);
    writeFileSync(
      filePath,
      `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", taskId: "FN-1", text: "bad timing", type: "text", durationMs: -1, timeToFirstTokenMs: "secret" })}\n`,
      "utf8",
    );

    const [entry] = readAgentLogEntries(taskDir);
    expect(entry).toMatchObject({ text: "bad timing" });
    expect(entry).not.toHaveProperty("durationMs");
    expect(entry).not.toHaveProperty("timeToFirstTokenMs");
  });

  it("supports most-recent tail pagination with offset", () => {
    const taskDir = createTaskDir();
    appendAgentLogEntriesSync(
      taskDir,
      Array.from({ length: 5 }, (_, index) => ({
        timestamp: `2026-01-01T00:0${index}:00.000Z`,
        taskId: "FN-1",
        text: `entry-${index}`,
        type: "text" as const,
      })),
    );

    expect(readAgentLogEntries(taskDir, { limit: 2 }).map((entry) => entry.text)).toEqual(["entry-3", "entry-4"]);
    expect(readAgentLogEntries(taskDir, { limit: 2, offset: 2 }).map((entry) => entry.text)).toEqual(["entry-1", "entry-2"]);
    expect(readAgentLogEntries(taskDir, { limit: 2, offset: 5 })).toEqual([]);
  });

  it("filters by type and inclusive time range", () => {
    const taskDir = createTaskDir();
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId: "FN-1", text: "before", type: "text" },
      { timestamp: "2026-01-01T01:00:00.000Z", taskId: "FN-1", text: "tool", type: "tool", detail: "ls" },
      { timestamp: "2026-01-01T02:00:00.000Z", taskId: "FN-1", text: "thinking", type: "thinking" },
      { timestamp: "2026-01-01T03:00:00.000Z", taskId: "FN-1", text: "after", type: "text" },
    ]);

    expect(readAgentLogEntries(taskDir, { type: "text" }).map((entry) => entry.text)).toEqual(["before", "after"]);
    expect(
      readAgentLogEntriesByTimeRange(taskDir, "2026-01-01T01:00:00.000Z", "2026-01-01T02:00:00.000Z").map((entry) => entry.text),
    ).toEqual(["tool", "thinking"]);
    expect(countAgentLogEntries(taskDir, { type: "text" })).toBe(2);
  });

  it("truncates oversized tool detail on append and on read of legacy oversized rows", () => {
    const taskDir = createTaskDir();
    const oversized = "X".repeat(5_000);
    appendAgentLogEntriesSync(taskDir, [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId: "FN-1", text: "Bash", type: "tool_result", detail: oversized },
    ]);

    const filePath = getAgentLogFilePath(taskDir);
    writeFileSync(
      filePath,
      `${JSON.stringify({ timestamp: "2026-01-01T01:00:00.000Z", taskId: "FN-1", text: "legacy", type: "tool_error", detail: oversized })}\n`,
      "utf8",
    );

    const [legacy] = readAgentLogEntries(taskDir);
    expect(legacy.detail).toContain(AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE.trim());
    expect(legacy.detail!.length).toBeLessThan(oversized.length);
  });

  it("skips malformed and partial lines with a warning", () => {
    const taskDir = createTaskDir();
    const filePath = getAgentLogFilePath(taskDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      filePath,
      [
        JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", taskId: "FN-1", text: "good", type: "text" }),
        "{bad-json",
        JSON.stringify({ taskId: "FN-1", text: "missing timestamp", type: "text" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const entries = readAgentLogEntries(taskDir);
    expect(entries.map((entry) => entry.text)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("treats a missing file as empty", () => {
    const taskDir = createTaskDir();
    expect(readAgentLogEntries(taskDir)).toEqual([]);
    expect(countAgentLogEntries(taskDir)).toBe(0);
  });
});
