// @vitest-environment node

import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { dashboardQualityProjectGlobs } from "../../vitest.config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(__dirname, "..", "..");
const dashboardPackageJsonPath = join(dashboardRoot, "package.json");
const vitestConfigPath = join(dashboardRoot, "vitest.config.ts");
const dashboardQualityScriptPath = join(dashboardRoot, "scripts", "run-quality-tests.mjs");
const qualityParityBaselineFileCount = 726;

interface QualityLane {
  name: string;
  group: "app" | "api";
  args: string[];
}

function readDashboardPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(dashboardPackageJsonPath, "utf8"));
}

async function readQualityLanes(): Promise<QualityLane[]> {
  const module = (await import(pathToFileURL(dashboardQualityScriptPath).href)) as { qualityLanes: QualityLane[] };
  return module.qualityLanes;
}

function projectNameForLane(lane: QualityLane): string {
  const projectFlagIndex = lane.args.indexOf("--project");
  expect(projectFlagIndex).toBeGreaterThanOrEqual(0);
  const projectName = lane.args[projectFlagIndex + 1];
  expect(projectName).toBeTruthy();
  return projectName;
}

function expandDashboardGlobs(patterns: readonly string[]): Set<string> {
  return new Set(
    patterns.flatMap((pattern) =>
      globSync(pattern, { cwd: dashboardRoot, nodir: true }).map((file) =>
        relative(dashboardRoot, join(dashboardRoot, file)),
      ),
    ),
  );
}

function expandProjectFiles(projectName: keyof typeof dashboardQualityProjectGlobs): Set<string> {
  const project = dashboardQualityProjectGlobs[projectName];
  const included = expandDashboardGlobs(project.include);
  const excluded = expandDashboardGlobs(project.exclude);
  for (const file of excluded) {
    included.delete(file);
  }
  return included;
}

describe("dashboard test config guard", () => {
  it("routes the dashboard quality gate through the bounded orchestrator", async () => {
    const { scripts } = readDashboardPackageJson();
    const qualityLanes = await readQualityLanes();

    expect(scripts.pretest).toBe("node ../../scripts/ensure-test-artifacts.mjs");
    expect(scripts.test).toBe("node scripts/run-quality-tests.mjs");
    expect(scripts["test:quality:app"]).toBe("node scripts/run-quality-tests.mjs --group app");
    expect(scripts["test:quality:api"]).toBe("node scripts/run-quality-tests.mjs --group api");
    expect(qualityLanes).toHaveLength(15);
    expect(qualityLanes.map((lane) => lane.name)).toEqual([
      "app:foundation-api",
      "app:foundation-ui",
      "app:foundation-hooks-utils",
      "app:components-a",
      "app:components-b",
      "app:app",
      "app:chat",
      "app:settings",
      "app:backfill",
      "api:curated",
      "api:backfill-1",
      "api:backfill-2",
    ]);

    for (const lane of qualityLanes) {
      expect(lane.args[0]).toBe("--heap=6144");
      expect(lane.args).not.toContain("-t");
      expect(lane.args.join(" ")).not.toContain("ensure-test-artifacts");
    }
  });

  it("pins compatibility lane scripts to the heap wrapper", () => {
    const { scripts } = readDashboardPackageJson();

    for (const key of [
      "test:quality:app:foundation-api",
      "test:quality:app:foundation-ui",
      "test:quality:app:foundation-hooks-utils",
      "test:quality:app:components-a",
      "test:quality:app:components-b",
      "test:quality:app:app",
      "test:quality:app:chat",
      "test:quality:app:settings",
      "test:quality:app:backfill",
      "test:quality:api:curated",
      "test:quality:api:backfill-1",
      "test:quality:api:backfill-2",
    ]) {
      expect(scripts[key]).toContain("node scripts/run-vitest-with-heap.mjs --heap=6144");
    }
    // App backfill is unsharded so the Vitest --shard exit hang cannot wedge the quality runner.
    expect(scripts["test:quality:app:backfill"]).not.toContain("--shard=");
  });

  it("runs the settings lane unfiltered so no describe block can fall through a -t name filter", async () => {
    const { scripts } = readDashboardPackageJson();
    const qualityLanes = await readQualityLanes();
    const settingsLane = qualityLanes.find((lane) => lane.name === "app:settings");

    expect(scripts["test:quality:app:settings"]).toContain("--project dashboard-app-quality-settings");
    expect(scripts["test:quality:app:settings"]).not.toContain("-t ");
    expect(settingsLane?.args).toContain("--project");
    expect(settingsLane?.args).toContain("dashboard-app-quality-settings");
    expect(settingsLane?.args).not.toContain("-t");
    for (const removed of [
      "test:quality:app:settings-a1",
      "test:quality:app:settings-a2",
      "test:quality:app:settings-a3",
      "test:quality:app:settings-b",
      "test:quality:app:settings-c",
      "test:quality:app:settings-d",
    ]) {
      expect(scripts[removed]).toBeUndefined();
    }
  });

  it("keeps the split quality projects declared in vitest config", () => {
    const vitestConfig = readFileSync(vitestConfigPath, "utf8");

    for (const projectName of [
      "dashboard-app-quality-foundation-api",
      "dashboard-app-quality-foundation-ui",
      "dashboard-app-quality-foundation-hooks-utils",
      "dashboard-app-quality-components-a",
      "dashboard-app-quality-components-b",
      "dashboard-app-quality-app",
      "dashboard-app-quality-chat",
      "dashboard-app-quality-settings",
      "dashboard-app-quality-backfill",
      "dashboard-api-quality",
      "dashboard-api-quality-backfill",
    ]) {
      expect(vitestConfig).toContain(`name: \"${projectName}\"`);
    }

    expect(vitestConfig).toContain('"scripts/__tests__/{run-quality-tests,run-vitest-with-heap}.test.ts"');
  });

  it("keeps orchestrated quality project coverage at the measured baseline", async () => {
    const qualityLanes = await readQualityLanes();
    const laneProjects = new Set(qualityLanes.map(projectNameForLane));
    const knownProjects = Object.keys(dashboardQualityProjectGlobs);

    expect([...laneProjects].sort()).toEqual([...knownProjects].sort());

    const files = new Set<string>();
    for (const projectName of laneProjects) {
      const projectFiles = expandProjectFiles(projectName as keyof typeof dashboardQualityProjectGlobs);
      expect(projectFiles.size).toBeGreaterThan(0);
      for (const file of projectFiles) {
        files.add(file);
      }
    }

    expect(files.size).toBeGreaterThanOrEqual(qualityParityBaselineFileCount);
  });
});
