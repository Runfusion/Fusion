import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vitestConfig from "../../vitest.config";

const cliRoot = join(__dirname, "..", "..");
const workspaceRoot = join(cliRoot, "..", "..");
const hiddenDistRootPrefix = ".tmp-fn-vitest-workspace-resolution-";
const hiddenDistRoot = join(workspaceRoot, `${hiddenDistRootPrefix}${process.pid}`);

const internalPackages = ["core", "engine", "dashboard"] as const;
const movedDistDirs: Array<{ from: string; to: string }> = [];

function rmSyncWithRetry(path: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EEXIST") {
        throw error;
      }
      if (attempt === 4) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

function cleanupStaleHiddenDistRoots() {
  for (const entry of readdirSync(workspaceRoot)) {
    if (!entry.startsWith(hiddenDistRootPrefix)) {
      continue;
    }

    const fullPath = join(workspaceRoot, entry);
    try {
      if (!lstatSync(fullPath).isDirectory()) {
        continue;
      }
      rmSyncWithRetry(fullPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function hideInternalPackageDistDirs() {
  cleanupStaleHiddenDistRoots();
  mkdirSync(hiddenDistRoot, { recursive: true });

  for (const pkg of internalPackages) {
    const distPath = join(workspaceRoot, "packages", pkg, "dist");
    if (!existsSync(distPath)) {
      continue;
    }

    const hiddenPath = join(hiddenDistRoot, `${pkg}-dist`);
    if (existsSync(hiddenPath)) {
      rmSyncWithRetry(hiddenPath);
    }
    renameSync(distPath, hiddenPath);
    movedDistDirs.push({ from: distPath, to: hiddenPath });
  }
}

function restoreInternalPackageDistDirs() {
  for (let i = movedDistDirs.length - 1; i >= 0; i--) {
    const { from, to } = movedDistDirs[i];
    if (!existsSync(to)) {
      continue;
    }

    if (existsSync(from)) {
      rmSyncWithRetry(from);
    }

    renameSync(to, from);
  }
  movedDistDirs.length = 0;
  rmSyncWithRetry(hiddenDistRoot);
}

describe("vitest workspace temp dir cleanup", () => {
  it("cleans stale workspace-resolution temp dirs without touching unrelated tmp dirs", () => {
    const staleDir = join(workspaceRoot, `${hiddenDistRootPrefix}stale-test`);
    const staleMarker = join(staleDir, "marker.txt");
    const unrelatedTmpDir = join(workspaceRoot, ".tmp-fn-other-marker-test");

    rmSyncWithRetry(staleDir);
    rmSyncWithRetry(unrelatedTmpDir);

    mkdirSync(staleDir, { recursive: true });
    writeFileSync(staleMarker, "stale");
    mkdirSync(unrelatedTmpDir, { recursive: true });

    cleanupStaleHiddenDistRoots();

    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(unrelatedTmpDir)).toBe(true);

    rmSyncWithRetry(unrelatedTmpDir);
  });
});

describe("CLI Vitest workspace resolution", () => {
  beforeAll(() => {
    hideInternalPackageDistDirs();
  });

  afterAll(() => {
    restoreInternalPackageDistDirs();
  });

  it("uses exact source-entry aliases for internal workspace packages", () => {
    const aliases = vitestConfig.resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);

    const normalized = (aliases ?? []).map((entry) => ({
      find: String(entry.find),
      replacement: String(entry.replacement),
    }));

    expect(normalized).toEqual(
      expect.arrayContaining([
        {
          find: String(/^@fusion\/core\/gh-cli$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "gh-cli.ts"),
        },
        {
          find: String(/^@fusion\/core$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "index.ts"),
        },
        {
          find: String(/^@fusion\/engine$/),
          replacement: join(workspaceRoot, "packages", "engine", "src", "index.ts"),
        },
        {
          find: String(/^@fusion\/dashboard\/planning$/),
          replacement: join(workspaceRoot, "packages", "dashboard", "src", "planning.ts"),
        },
        {
          find: String(/^@fusion\/dashboard$/),
          replacement: join(workspaceRoot, "packages", "dashboard", "src", "index.ts"),
        },
        {
          find: String(/^@fusion-plugin-examples\/droid-runtime\/probe$/),
          replacement: join(workspaceRoot, "plugins", "fusion-plugin-droid-runtime", "src", "probe.ts"),
        },
        {
          find: String(/^@fusion-plugin-examples\/droid-runtime$/),
          replacement: join(workspaceRoot, "plugins", "fusion-plugin-droid-runtime", "src", "index.ts"),
        },
        {
          find: String(/^@fusion\/test-utils$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "__test-utils__", "workspace.ts"),
        },
      ]),
    );

    for (const entry of normalized) {
      expect(
        entry.replacement.includes(`${join("packages", "")}`) ||
          entry.replacement.includes(`${join("plugins", "")}`),
      ).toBe(true);
      expect(entry.replacement).toContain(`${join("src", "")}`);
      expect(entry.replacement).not.toContain(`${join("dist", "")}`);
    }

    const coreGhCliIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/core\/gh-cli$/));
    const coreIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/core$/));
    const planningIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/dashboard\/planning$/));
    const dashboardIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/dashboard$/));

    expect(coreGhCliIndex).toBeGreaterThanOrEqual(0);
    expect(coreIndex).toBeGreaterThan(coreGhCliIndex);
    expect(planningIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardIndex).toBeGreaterThan(planningIndex);
  });

  it("resolves non-mocked symbols from internal workspace packages when dist outputs are absent", async () => {
    const [{ tempWorkspace }, { PRIORITY_EXECUTE }, { createRuntimeLogger }, { parseAgentResponse }] = await Promise.all([
      import("@fusion/test-utils"),
      import("@fusion/engine"),
      import("@fusion/dashboard"),
      import("@fusion/dashboard/planning"),
    ]);

    expect(typeof tempWorkspace).toBe("function");
    expect(typeof PRIORITY_EXECUTE).toBe("number");
    expect(typeof createRuntimeLogger).toBe("function");
    expect(parseAgentResponse('{"type":"question","data":{"id":"q","type":"confirm","question":"Ok?","description":"desc"}}')).toEqual({
      type: "question",
      data: {
        id: "q",
        type: "confirm",
        question: "Ok?",
        description: "desc",
      },
    });
  }, 30_000);
});
