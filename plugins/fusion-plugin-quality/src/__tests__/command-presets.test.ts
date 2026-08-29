import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QUALITY_PRESET_IDS,
  isQualityPresetId,
  isSafeFilePathToken,
  resolvePresetCommand,
} from "../runner/command-presets.js";

const ENGINE_TEST = "packages/engine/src/__tests__/foo.test.ts";

function writePackage(root: string, packageRoot: string, packageName: string): void {
  mkdirSync(join(root, packageRoot, "src", "__tests__"), { recursive: true });
  writeFileSync(join(root, packageRoot, "package.json"), JSON.stringify({ name: packageName }));
}

function writeWorkspace(root: string, enginePackageName: string, includeWorkspace = true): void {
  if (includeWorkspace) {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'plugins/*'\n");
  }
  writePackage(root, "packages/engine", enginePackageName);
}

function expectDefaultReporter(command: string): void {
  expect(command).not.toContain("--reporter");
  expect(command).not.toContain("--reporter=basic");
}

describe("command-presets", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(name: string, enginePackageName: string, includeWorkspace = true): string {
    const root = mkdtempSync(join(tmpdir(), `quality-command-presets-${name}-`));
    tempDirs.push(root);
    writeWorkspace(root, enginePackageName, includeWorkspace);
    return root;
  }

  it("accepts known preset ids only", () => {
    expect(isQualityPresetId("verify-fast")).toBe(true);
    expect(isQualityPresetId("evil")).toBe(false);
  });

  it("resolves verify-fast and test-gate", () => {
    expect(resolvePresetCommand({ preset: "verify-fast", projectRoot: "/repo" })).toEqual({
      ok: true,
      command: "pnpm verify:fast",
      label: "Verify fast (test-free)",
    });
    expect(resolvePresetCommand({ preset: "test-gate", projectRoot: "/repo" }).ok).toBe(true);
  });

  it("disables project-test without testCommand", () => {
    const r = resolvePresetCommand({ preset: "project-test", projectRoot: "/repo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("disabled");
  });

  it("requires confirm for full-suite", () => {
    const denied = resolvePresetCommand({ preset: "full-suite", projectRoot: "/repo" });
    expect(denied.ok).toBe(false);
    const ok = resolvePresetCommand({
      preset: "full-suite",
      projectRoot: "/repo",
      confirmFullSuite: true,
    });
    expect(ok.ok).toBe(true);
  });

  describe("file-scoped execution-cwd resolution", () => {
    it("uses projectRoot when cwd is omitted", () => {
      const projectRoot = createWorkspace("project", "@fusion/engine");
      const result = resolvePresetCommand({ preset: "file-scoped", projectRoot, filePaths: [ENGINE_TEST] });

      expect(result).toMatchObject({
        ok: true,
        command: "pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts'",
      });
      if (result.ok) expectDefaultReporter(result.command);
    });

    it("uses projectRoot when cwd equals projectRoot", () => {
      const projectRoot = createWorkspace("project-cwd", "@fusion/engine");
      const result = resolvePresetCommand({
        preset: "file-scoped",
        projectRoot,
        cwd: projectRoot,
        filePaths: [ENGINE_TEST],
      });

      expect(result).toMatchObject({
        ok: true,
        command: "pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts'",
      });
      if (result.ok) expectDefaultReporter(result.command);
    });

    it("uses a divergent task worktree as the workspace resolution root", () => {
      const projectRoot = createWorkspace("project-root", "@fusion/engine");
      const worktree = createWorkspace("task-worktree", "@fusion/engine-worktree");
      const result = resolvePresetCommand({
        preset: "file-scoped",
        projectRoot,
        cwd: worktree,
        filePaths: [ENGINE_TEST],
      });

      expect(result).toMatchObject({
        ok: true,
        command: "pnpm --filter '@fusion/engine-worktree' exec vitest run 'src/__tests__/foo.test.ts'",
      });
      if (result.ok) {
        expect(result.command).not.toContain("@fusion/engine'");
        expectDefaultReporter(result.command);
      }
    });

    it("does not fall back to projectRoot workspace metadata for a QA worktree without pnpm-workspace.yaml", () => {
      const projectRoot = createWorkspace("project-with-workspace", "@fusion/engine");
      const qaWorktree = createWorkspace("qa-worktree", "@fusion/engine-qa", false);
      const result = resolvePresetCommand({
        preset: "file-scoped",
        projectRoot,
        cwd: qaWorktree,
        filePaths: [ENGINE_TEST],
      });

      expect(result).toMatchObject({
        ok: true,
        command: "pnpm exec vitest run 'packages/engine/src/__tests__/foo.test.ts'",
      });
      if (result.ok) {
        expect(result.command).not.toContain("--filter");
        expectDefaultReporter(result.command);
      }
    });

    it("falls back without throwing when cwd is unreadable or missing", () => {
      const projectRoot = createWorkspace("project-missing-cwd", "@fusion/engine");
      const result = resolvePresetCommand({
        preset: "file-scoped",
        projectRoot,
        cwd: join(projectRoot, "does-not-exist"),
        filePaths: [ENGINE_TEST],
      });

      expect(result).toMatchObject({
        ok: true,
        command: "pnpm exec vitest run 'packages/engine/src/__tests__/foo.test.ts'",
      });
      if (result.ok) expectDefaultReporter(result.command);
    });
  });

  it("emits sorted package-local segments for multiple packages and plugins", () => {
    const projectRoot = createWorkspace("multi-package", "@fusion/engine");
    writePackage(projectRoot, "packages/core", "@fusion/core");
    writePackage(projectRoot, "plugins/quality", "@fusion-plugin-examples/quality");
    const result = resolvePresetCommand({
      preset: "file-scoped",
      projectRoot,
      filePaths: [
        "plugins/quality/src/__tests__/quality.test.ts",
        ENGINE_TEST,
        "packages/core/src/__tests__/core.test.ts",
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      command:
        "pnpm --filter '@fusion/core' exec vitest run 'src/__tests__/core.test.ts' && pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts' && pnpm --filter '@fusion-plugin-examples/quality' exec vitest run 'src/__tests__/quality.test.ts'",
    });
    if (result.ok) expectDefaultReporter(result.command);
  });

  it("excludes unresolved paths and uses the root-local form when none resolve", () => {
    const projectRoot = createWorkspace("unresolved", "@fusion/engine");
    const mixed = resolvePresetCommand({
      preset: "file-scoped",
      projectRoot,
      filePaths: [ENGINE_TEST, "docs/testing.md"],
    });
    expect(mixed).toMatchObject({
      ok: true,
      command: "pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts'",
    });

    const unresolved = resolvePresetCommand({
      preset: "file-scoped",
      projectRoot,
      filePaths: ["docs/testing.md", "scripts/foo.test.mjs"],
    });
    expect(unresolved).toMatchObject({
      ok: true,
      command: "pnpm exec vitest run 'docs/testing.md' 'scripts/foo.test.mjs'",
    });
    if (unresolved.ok) expectDefaultReporter(unresolved.command);
  });

  it("deduplicates paths and never emits unsafe tokens", () => {
    const projectRoot = createWorkspace("safe-paths", "@fusion/engine");
    const result = resolvePresetCommand({
      preset: "file-scoped",
      projectRoot,
      filePaths: [ENGINE_TEST, ENGINE_TEST, "../etc/passwd", "a;rm -rf /", "/abs/path", "bad\npath"],
    });
    expect(result).toMatchObject({
      ok: true,
      command: "pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts'",
    });
    if (result.ok) {
      expect(result.command).not.toContain("passwd");
      expect(result.command).not.toContain("rm -rf");
      expect(result.command).not.toContain("abs/path");
      expectDefaultReporter(result.command);
    }
  });

  it("rejects empty and all-unsafe file paths", () => {
    const empty = resolvePresetCommand({ preset: "file-scoped", projectRoot: "/repo", filePaths: [] });
    const unsafe = resolvePresetCommand({
      preset: "file-scoped",
      projectRoot: "/repo",
      filePaths: ["../etc/passwd", "a;rm -rf /", "/abs/path", "bad\0path", "bad\npath"],
    });
    expect(empty).toMatchObject({ ok: false, code: "empty_files" });
    expect(unsafe).toMatchObject({ ok: false, code: "empty_files" });
  });

  it("never emits the removed basic reporter for any resolved preset command", () => {
    const projectRoot = createWorkspace("reporters", "@fusion/engine");
    const results = QUALITY_PRESET_IDS.map((preset) =>
      resolvePresetCommand({
        preset,
        projectRoot,
        filePaths: [ENGINE_TEST],
        testCommand: "pnpm test",
        confirmFullSuite: true,
      }),
    );
    for (const result of results) {
      if (result.ok) expect(result.command).not.toContain("--reporter=basic");
    }
  });

  it("rejects unsafe path tokens", () => {
    expect(isSafeFilePathToken("../x")).toBe(false);
    expect(isSafeFilePathToken("a;rm -rf /")).toBe(false);
    expect(isSafeFilePathToken("src/ok.ts")).toBe(true);
  });
});
