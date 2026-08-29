import { describe, it, expect, vi, beforeEach } from "vitest";

// FNXC:Verification 2026-06-25-00:00:
// Unit coverage for diff-proportional verification scoping. We mock node:fs
// (existsSync/readFileSync/readdirSync) and node:child_process.execSync the same
// way merger-verification.test.ts does, so we can drive `git diff` output and
// on-disk test-file presence deterministically without a real repo.
// merger.ts (and its transitive imports) reference exec/execFile/spawn at module
// load via promisify, so the mock must provide them even though these tests only
// exercise the synchronous `git diff` path through execSync.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

import {
  deriveFileScopedPnpmTestCommand,
  inferDefaultTestCommand,
} from "../merger.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);

/**
 * Wire a single-package ("packages/engine" → "@fusion/engine") workspace, with
 * a configurable git-diff output and a set of test files that "exist" on disk.
 */
function setupSinglePackageWorkspace(opts: {
  diff: string;
  existingTestFiles: string[];
  packages?: Array<{ dir: string; name: string }>;
}): void {
  const packages = opts.packages ?? [{ dir: "engine", name: "@fusion/engine" }];
  const existing = new Set(opts.existingTestFiles.map((p) => `/tmp/root/${p}`));

  mockedExistsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith("pnpm-workspace.yaml")) return true;
    if (path.endsWith("pnpm-lock.yaml")) return true;
    // package.json existence for resolveWorkspacePackageRoots + name reads
    if (path.endsWith("package.json")) return true;
    return existing.has(path);
  });
  mockedReaddirSync.mockReturnValue(
    packages.map((pkg) => ({ name: pkg.dir, isDirectory: () => true })) as any,
  );
  mockedReadFileSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith("pnpm-workspace.yaml")) return `packages:\n  - "packages/*"\n`;
    for (const pkg of packages) {
      if (path.endsWith(`packages/${pkg.dir}/package.json`)) {
        return JSON.stringify({ name: pkg.name });
      }
    }
    return JSON.stringify({ name: "unknown" });
  });
  mockedExecSync.mockImplementation((cmd: any) => {
    if (String(cmd).includes("git diff --name-only")) return opts.diff;
    return "";
  });
}

describe("deriveFileScopedPnpmTestCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedReaddirSync.mockReturnValue([] as any);
  });

  it("includes a changed test file directly", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/__tests__/foo.test.ts\n",
      existingTestFiles: [],
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    expect(result).toBe(
      `pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts' --silent=passed-only --reporter=dot`,
    );
  });

  it("maps a changed source file to its co-located __tests__ test", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/foo.ts\n",
      existingTestFiles: ["packages/engine/src/__tests__/foo.test.ts"],
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    expect(result).toContain(`--filter '@fusion/engine'`);
    expect(result).toContain(`'src/__tests__/foo.test.ts'`);
  });

  it("maps a changed source file to a sibling .test file", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/bar.ts\n",
      existingTestFiles: ["packages/engine/src/bar.test.ts"],
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    expect(result).toContain(`'src/bar.test.ts'`);
  });

  it("excludes a changed source file with no co-located test", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/no-test.ts\n",
      existingTestFiles: [], // no test exists on disk
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    expect(result).toBeNull();
  });

  it("returns null when the diff resolves to no test files at all", () => {
    setupSinglePackageWorkspace({
      diff: "README.md\npackages/engine/src/untested.ts\n",
      existingTestFiles: [],
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    expect(result).toBeNull();
  });

  it("joins multiple packages with ` && ` and quotes names + paths", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/__tests__/a.test.ts\npackages/dashboard/src/__tests__/b.test.ts\n",
      existingTestFiles: [],
      packages: [
        { dir: "engine", name: "@fusion/engine" },
        { dir: "dashboard", name: "@fusion/dashboard" },
      ],
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    expect(result).not.toBeNull();
    expect(result).toContain(" && ");
    // Package roots are sorted, so dashboard precedes engine.
    expect(result).toBe(
      `pnpm --filter '@fusion/dashboard' exec vitest run 'src/__tests__/b.test.ts' --silent=passed-only --reporter=dot` +
        ` && ` +
        `pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/a.test.ts' --silent=passed-only --reporter=dot`,
    );
  });

  it("dedupes when a source file and its test both change", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/foo.ts\npackages/engine/src/__tests__/foo.test.ts\n",
      existingTestFiles: ["packages/engine/src/__tests__/foo.test.ts"],
    });
    const result = deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1");
    const occurrences = (result ?? "").split(`'src/__tests__/foo.test.ts'`).length - 1;
    expect(occurrences).toBe(1);
  });

  it("returns null when git diff fails", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/__tests__/foo.test.ts\n",
      existingTestFiles: [],
    });
    mockedExecSync.mockImplementation(() => {
      throw new Error("git failure");
    });
    expect(deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1")).toBeNull();
  });

  it("returns null when there is no pnpm-workspace.yaml", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(deriveFileScopedPnpmTestCommand("/tmp/root", "main", "fusion/fn-1")).toBeNull();
  });
});

describe("inferDefaultTestCommand — scopeToChangedFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedReaddirSync.mockReturnValue([] as any);
  });

  it("overrides an explicit command with the file-scoped command when tests resolve", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/__tests__/foo.test.ts\n",
      existingTestFiles: [],
    });
    const result = inferDefaultTestCommand(
      "/tmp/root",
      "pnpm -r test", // explicit whole-repo command
      undefined,
      "main",
      "fusion/fn-1",
      true, // scopeToChangedFiles
    );
    expect(result?.testSource).toBe("inferred-scoped");
    expect(result?.command).toBe(
      `pnpm --filter '@fusion/engine' exec vitest run 'src/__tests__/foo.test.ts' --silent=passed-only --reporter=dot`,
    );
  });

  it("falls back to the explicit command when no test files resolve", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/untested.ts\n",
      existingTestFiles: [],
    });
    const result = inferDefaultTestCommand(
      "/tmp/root",
      "pnpm -r test",
      undefined,
      "main",
      "fusion/fn-1",
      true,
    );
    expect(result?.testSource).toBe("explicit");
    expect(result?.command).toBe("pnpm -r test");
  });

  it("preserves existing behavior when scopeToChangedFiles is false", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/__tests__/foo.test.ts\n",
      existingTestFiles: [],
    });
    const result = inferDefaultTestCommand(
      "/tmp/root",
      "pnpm -r test",
      undefined,
      "main",
      "fusion/fn-1",
      false, // disabled
    );
    expect(result?.testSource).toBe("explicit");
    expect(result?.command).toBe("pnpm -r test");
  });

  it("file-scopes even an inferred (non-explicit) command when tests resolve", () => {
    setupSinglePackageWorkspace({
      diff: "packages/engine/src/foo.ts\n",
      existingTestFiles: ["packages/engine/src/__tests__/foo.test.ts"],
    });
    const result = inferDefaultTestCommand(
      "/tmp/root",
      undefined,
      undefined,
      "main",
      "fusion/fn-1",
      true,
    );
    expect(result?.testSource).toBe("inferred-scoped");
    expect(result?.command).toContain(`exec vitest run 'src/__tests__/foo.test.ts'`);
  });
});
