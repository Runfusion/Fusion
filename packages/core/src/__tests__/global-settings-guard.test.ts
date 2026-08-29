import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGlobalDir } from "../config/global-settings.js";

function withTempHome<T>(fn: (homeDir: string) => T): T {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "kb-global-dir-guard-"));
  process.env.HOME = homeDir;

  try {
    return fn(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function withVitestEnv<T>(value: string | undefined, fn: () => T): T {
  const originalVitest = process.env.VITEST;

  if (value === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = value;
  }

  try {
    return fn();
  } finally {
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
  }
}

describe("resolveGlobalDir() VITEST guard", () => {
  it("throws without explicit dir during test execution", () => {
    withVitestEnv("true", () => {
      withTempHome(() => {
        expect(() => resolveGlobalDir()).toThrow(
          "resolveGlobalDir() called without explicit dir during test execution. Pass a temp directory to avoid writing to real ~/.fusion/",
        );
      });
    });
  });

  it("allows explicit dir during test execution", () => {
    withVitestEnv("true", () => {
      const explicitPath = "/some/explicit/path";

      expect(resolveGlobalDir(explicitPath)).toBe(explicitPath);
    });
  });

  it("preserves production behavior when VITEST is not set", () => {
    withVitestEnv(undefined, () => {
      withTempHome((homeDir) => {
        expect(resolveGlobalDir()).toBe(join(homeDir, ".fusion"));
      });
    });
  });
});

/*
FNXC:GlobalDirGuard 2026-06-25-22:30:
Regression for the "all my global settings reset" bug: production code that passed a project's `.fusion/` dir (e.g. store.getFusionDir()) to CentralCore/global stores spun up stray per-project central DBs seeded with default global settings that shadowed ~/.fusion. resolveGlobalDir() must refuse a project-local `.fusion/` dir (named `.fusion` inside a git repo) while still accepting the real home global dir and arbitrary non-repo custom dirs. Guard is intentionally inert under VITEST, so these tests clear VITEST to exercise it.
*/
describe("resolveGlobalDir() project-local .fusion guard", () => {
  it("throws when handed a project-local .fusion dir inside a git repo", () => {
    withVitestEnv(undefined, () => {
      withTempHome((homeDir) => {
        const projectRoot = join(homeDir, "code", "my-project");
        mkdirSync(join(projectRoot, ".git"), { recursive: true });
        const projectFusionDir = join(projectRoot, ".fusion");
        mkdirSync(projectFusionDir, { recursive: true });

        expect(() => resolveGlobalDir(projectFusionDir)).toThrow(
          /refusing project-local '\.fusion' directory/,
        );
      });
    });
  });

  it("also catches a git-worktree project (.git file, not dir)", () => {
    withVitestEnv(undefined, () => {
      withTempHome((homeDir) => {
        const worktreeRoot = join(homeDir, "worktrees", "feature");
        mkdirSync(worktreeRoot, { recursive: true });
        writeFileSync(join(worktreeRoot, ".git"), "gitdir: /somewhere/.git/worktrees/feature\n");
        const worktreeFusionDir = join(worktreeRoot, ".fusion");
        mkdirSync(worktreeFusionDir, { recursive: true });

        expect(() => resolveGlobalDir(worktreeFusionDir)).toThrow(
          /refusing project-local '\.fusion' directory/,
        );
      });
    });
  });

  it("allows the real home global dir", () => {
    withVitestEnv(undefined, () => {
      withTempHome((homeDir) => {
        const homeGlobal = join(homeDir, ".fusion");
        expect(resolveGlobalDir(homeGlobal)).toBe(homeGlobal);
      });
    });
  });

  it("allows a custom non-repo global dir (no .git parent)", () => {
    withVitestEnv(undefined, () => {
      withTempHome((homeDir) => {
        const customDir = join(homeDir, "custom-global", ".fusion");
        mkdirSync(customDir, { recursive: true });
        // Parent has no `.git`, so it is not a project worktree.
        expect(resolveGlobalDir(customDir)).toBe(customDir);
      });
    });
  });
});
