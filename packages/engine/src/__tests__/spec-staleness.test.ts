import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateSpecStaleness, getPromptPath } from "../spec-staleness.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "@fusion/core";

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
}));

const mockStat = vi.mocked(stat);

function createMockSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    specStalenessEnabled: false,
    specStalenessMaxAgeMs: 6 * 60 * 60 * 1000,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: true,
    autoMerge: true,
    ...overrides,
  } as Settings;
}

describe("getPromptPath", () => {
  it("returns absolute path to PROMPT.md for a task", () => {
    const tasksDir = "/project/.fusion/tasks";
    const taskId = "FN-001";
    expect(getPromptPath(tasksDir, taskId)).toBe(
      "/project/.fusion/tasks/FN-001/PROMPT.md",
    );
  });

  it("handles task IDs with different formats", () => {
    const tasksDir = "/project/.fusion/tasks";
    expect(getPromptPath(tasksDir, "KB-042")).toBe(
      "/project/.fusion/tasks/KB-042/PROMPT.md",
    );
    expect(getPromptPath(tasksDir, "TASK-999")).toBe(
      "/project/.fusion/tasks/TASK-999/PROMPT.md",
    );
  });
});

describe("evaluateSpecStaleness", () => {
  const promptPath = "/project/.fusion/tasks/FN-001/PROMPT.md";
  const defaultMaxAgeMs = 6 * 60 * 60 * 1000; // 6 hours

  describe("disabled mode", () => {
    it("returns isStale=false with no file access when specStalenessEnabled is false", async () => {
      const settings = createMockSettings({ specStalenessEnabled: false });

      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("");
      expect(result.ageMs).toBeUndefined();
      expect(result.maxAgeMs).toBeUndefined();
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("returns isStale=false with no file access when specStalenessEnabled is undefined", async () => {
      const settings = createMockSettings({ specStalenessEnabled: undefined });

      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("returns isStale=false with no file access when specStalenessEnabled is null", async () => {
      const settings = createMockSettings({ specStalenessEnabled: null as unknown as undefined });

      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });
  });

  describe("enabled mode", () => {
    beforeEach(() => {
      mockStat.mockReset();
    });

    it("returns isStale=false when spec is fresh (ageMs < maxAgeMs)", async () => {
      const now = 100_000_000_000;
      const mtime = now - (defaultMaxAgeMs - 1000); // 1 second younger than max
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.ageMs).toBeLessThan(defaultMaxAgeMs);
      expect(result.reason).toBe("");
    });

    it("returns isStale=false when ageMs === maxAgeMs (boundary is NOT stale)", async () => {
      const now = 100_000_000_000;
      const mtime = now - defaultMaxAgeMs; // exactly at boundary
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(false);
      expect(result.reason).toBe("");
    });

    it("returns isStale=true when spec is stale (ageMs > maxAgeMs)", async () => {
      const now = 100_000_000_000;
      const mtime = now - defaultMaxAgeMs - 1000; // 1 second older than max
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.ageMs).toBe(defaultMaxAgeMs + 1000);
      expect(result.maxAgeMs).toBe(defaultMaxAgeMs);
      expect(result.reason).toContain("Specification stale");
      expect(result.reason).toContain(`age=${defaultMaxAgeMs + 1000}ms`);
      expect(result.reason).toContain(`max=${defaultMaxAgeMs}ms`);
      expect(result.reason).toContain("moved to triage for re-planning");
    });

    it("uses custom specStalenessMaxAgeMs when set and valid", async () => {
      const now = 100_000_000_000;
      const customMaxAge = 60 * 60 * 1000; // 1 hour
      const mtime = now - customMaxAge - 1000; // 1 second older than custom max
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({
        specStalenessEnabled: true,
        specStalenessMaxAgeMs: customMaxAge,
      });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(true);
      expect(result.maxAgeMs).toBe(customMaxAge);
    });

    it("falls back to default max age when specStalenessMaxAgeMs is undefined", async () => {
      const now = 100_000_000_000;
      const mtime = now - defaultMaxAgeMs - 1000;
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({
        specStalenessEnabled: true,
        specStalenessMaxAgeMs: undefined,
      });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(true);
      expect(result.maxAgeMs).toBe(defaultMaxAgeMs);
    });

    it("falls back to default max age when specStalenessMaxAgeMs is negative", async () => {
      const now = 100_000_000_000;
      const mtime = now - defaultMaxAgeMs - 1000;
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({
        specStalenessEnabled: true,
        specStalenessMaxAgeMs: -1000,
      });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(true);
      expect(result.maxAgeMs).toBe(defaultMaxAgeMs);
    });

    it("falls back to default max age when specStalenessMaxAgeMs is zero", async () => {
      const now = 100_000_000_000;
      const mtime = now - defaultMaxAgeMs - 1000;
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({
        specStalenessEnabled: true,
        specStalenessMaxAgeMs: 0,
      });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(true);
      expect(result.maxAgeMs).toBe(defaultMaxAgeMs);
    });

    it("falls back to default max age when specStalenessMaxAgeMs is NaN", async () => {
      const now = 100_000_000_000;
      const mtime = now - defaultMaxAgeMs - 1000;
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({
        specStalenessEnabled: true,
        specStalenessMaxAgeMs: NaN,
      });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: now });

      expect(result.isStale).toBe(true);
      expect(result.maxAgeMs).toBe(defaultMaxAgeMs);
    });
  });

  describe("skipped behavior (missing/unreadable file)", () => {
    beforeEach(() => {
      mockStat.mockReset();
    });

    it("skips when PROMPT.md does not exist (ENOENT)", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT: no such file or directory"));

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("");
      expect(result.ageMs).toBeUndefined();
      expect(result.maxAgeMs).toBeUndefined();
    });

    it("skips when PROMPT.md is unreadable (EACCES)", async () => {
      mockStat.mockRejectedValue(new Error("EACCES: permission denied"));

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(true);
    });

    it("skips on any stat error without throwing", async () => {
      mockStat.mockRejectedValue(new Error("Unknown error"));

      const settings = createMockSettings({ specStalenessEnabled: true });
      // Should not throw
      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.isStale).toBe(false);
      expect(result.skipped).toBe(true);
    });

    it("does not set reason when skipped", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath });

      expect(result.reason).toBe("");
    });
  });

  describe("nowMs parameter (deterministic testing)", () => {
    it("uses provided nowMs instead of Date.now()", async () => {
      const fixedNow = 100_000_000_000;
      const mtime = fixedNow - 1000; // 1 second old
      mockStat.mockResolvedValue({ mtimeMs: mtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: fixedNow });

      expect(result.ageMs).toBe(1000);
    });

    it("handles very old files correctly with fixed nowMs", async () => {
      const fixedNow = 100_000_000_000;
      const oldMtime = 0; // Unix epoch
      mockStat.mockResolvedValue({ mtimeMs: oldMtime } as Awaited<ReturnType<typeof stat>>);

      const settings = createMockSettings({ specStalenessEnabled: true });
      const result = await evaluateSpecStaleness({ settings, promptPath, nowMs: fixedNow });

      expect(result.isStale).toBe(true);
      expect(result.ageMs).toBe(fixedNow);
    });
  });
});
