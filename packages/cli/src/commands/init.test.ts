/**
 * Tests for the init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";

const mockCentralInit = vi.fn();
const mockCentralClose = vi.fn();
const mockGetProjectByPath = vi.fn();
const mockRegisterProject = vi.fn();
const mockUpdateProject = vi.fn().mockResolvedValue({});

vi.mock("@fusion/core", () => ({
  CentralCore: vi.fn().mockImplementation(() => ({
    init: mockCentralInit,
    close: mockCentralClose,
    getProjectByPath: mockGetProjectByPath,
    registerProject: mockRegisterProject,
    updateProject: mockUpdateProject,
  })),
  resolveGlobalDir: vi.fn(),
}));

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("init command", () => {
  let tempProjectDir: string;

  beforeEach(() => {
    tempProjectDir = tempDir("fn-init-test-");
    mockCentralInit.mockResolvedValue(undefined);
    mockCentralClose.mockResolvedValue(undefined);
    mockGetProjectByPath.mockResolvedValue(undefined);
    mockRegisterProject.mockResolvedValue({
      id: "proj_test",
      name: "test-project",
      path: tempProjectDir,
      isolationMode: "in-process",
    });
  });

  afterEach(() => {
    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });

  it("should create .fusion/ directory when initializing", async () => {
    const fusionDir = join(tempProjectDir, ".fusion");
    expect(existsSync(fusionDir)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(fusionDir)).toBe(true);
  });

  it("should create fusion.db when initializing", async () => {
    const dbPath = join(tempProjectDir, ".fusion", "fusion.db");
    expect(existsSync(dbPath)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(dbPath)).toBe(true);
  });

  it("should be idempotent - report already initialized", async () => {
    // First init
    await runInit({ path: tempProjectDir });
    mockGetProjectByPath.mockResolvedValue({
      id: "proj_test",
      name: "registered-project",
      path: tempProjectDir,
      isolationMode: "in-process",
    });

    // Capture console output for second run
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      // Second init - should report already initialized
      await runInit({ path: tempProjectDir });

      const logString = logs.join("\n");
      expect(logString).toContain("already initialized");
    } finally {
      console.log = originalLog;
    }
  });

  it("should use provided name option", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runInit({ path: tempProjectDir, name: "custom-name" });

      const logString = logs.join("\n");
      expect(logString).toContain("custom-name");
    } finally {
      console.log = originalLog;
    }
  });

  it("should not require .fusion directory to exist before init", async () => {
    const fusionDir = join(tempProjectDir, ".fusion");
    expect(existsSync(fusionDir)).toBe(false);

    await runInit({ path: tempProjectDir });

    expect(existsSync(fusionDir)).toBe(true);
    expect(existsSync(join(fusionDir, "fusion.db"))).toBe(true);
  });
});
