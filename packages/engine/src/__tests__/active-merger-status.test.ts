import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readActiveMergerStatus } from "../merger.js";

describe("readActiveMergerStatus", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-merger-status-"));
    execSync("git init -q", { cwd: rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns null when no advisory file exists", () => {
    expect(readActiveMergerStatus(rootDir)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const path = join(rootDir, ".git", ".fusion-merger-active.json");
    require("node:fs").writeFileSync(path, "not json");
    expect(readActiveMergerStatus(rootDir)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const path = join(rootDir, ".git", ".fusion-merger-active.json");
    require("node:fs").writeFileSync(path, JSON.stringify({ taskId: "FN-1" }));
    // pid missing → null
    expect(readActiveMergerStatus(rootDir)).toBeNull();
  });

  it("returns the parsed status when the file is valid", () => {
    const path = join(rootDir, ".git", ".fusion-merger-active.json");
    const payload = {
      taskId: "FN-9999",
      pid: 12345,
      hostname: "test-host",
      startedAt: "2026-05-06T16:00:00.000Z",
    };
    require("node:fs").writeFileSync(path, JSON.stringify(payload));
    const got = readActiveMergerStatus(rootDir);
    expect(got).toEqual(payload);
  });

  it("ignores .git/<file> when .git is not a directory (worktree linked file)", () => {
    // Even if .git is a file (linked worktree), read should fail safely.
    rmSync(join(rootDir, ".git"), { recursive: true, force: true });
    require("node:fs").writeFileSync(join(rootDir, ".git"), "gitdir: /elsewhere\n");
    expect(readActiveMergerStatus(rootDir)).toBeNull();
    // sanity: cleanup wouldn't leave a stray status file behind
    expect(
      existsSync(join(rootDir, ".git", ".fusion-merger-active.json")),
    ).toBe(false);
    // and the .git file we wrote is still readable
    expect(readFileSync(join(rootDir, ".git"), "utf-8")).toContain("gitdir:");
  });
});
