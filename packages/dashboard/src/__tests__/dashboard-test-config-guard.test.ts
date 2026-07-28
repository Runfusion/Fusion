// @vitest-environment node

import { globSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { dashboardQualityProjectGlobs } from "../../vitest.config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(__dirname, "..", "..");
const dashboardPackageJsonPath = join(dashboardRoot, "package.json");
const vitestConfigPath = join(dashboardRoot, "vitest.config.ts");
const dashboardQualityScriptPath = join(dashboardRoot, "scripts", "run-quality-tests.mjs");
const touchGeometrySpec = "src/__tests__/task-modal-touch-resize-browser.test.ts";
const touchGeometrySpecPath = join(dashboardRoot, touchGeometrySpec);
const testingGuidePath = join(dashboardRoot, "..", "..", "docs", "testing.md");
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

function listTouchGeometryProjectsWithDeepEnv(): string[] {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "list",
      touchGeometrySpec,
      "--project",
      "dashboard-browser-touch",
      "--project",
      "dashboard-api",
      "--json",
    ],
    {
      cwd: dashboardRoot,
      encoding: "utf8",
      env: { ...process.env, FUSION_DASHBOARD_DEEP: "1" },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as { file: string; projectName: string }[];
  return [...new Set(rows.filter((row) => row.file === touchGeometrySpecPath).map((row) => row.projectName))];
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
      "app:backfill-1",
      "app:backfill-2",
      "app:backfill-3",
      "app:backfill-4",
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
      "test:quality:app:backfill-1",
      "test:quality:app:backfill-2",
      "test:quality:app:backfill-3",
      "test:quality:app:backfill-4",
      "test:quality:api:curated",
      "test:quality:api:backfill-1",
      "test:quality:api:backfill-2",
    ]) {
      expect(scripts[key]).toContain("node scripts/run-vitest-with-heap.mjs --heap=6144");
    }
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
    const knownProjects = Object.keys(dashboardQualityProjectGlobs).filter(
      (projectName) => projectName !== "dashboard-browser-touch",
    );

    expect([...laneProjects].sort()).toEqual([...knownProjects].sort());
    expect(laneProjects).not.toContain("dashboard-browser-touch");

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

  it("keeps Chromium touch geometry as a documented single-collection opt-in lane", () => {
    const { scripts } = readDashboardPackageJson();
    const testingGuide = readFileSync(testingGuidePath, "utf8");
    const specSource = readFileSync(touchGeometrySpecPath, "utf8");
    const vitestConfig = readFileSync(vitestConfigPath, "utf8");
    const touchProject = dashboardQualityProjectGlobs["dashboard-browser-touch"];

    // Project contract: the browser-dependent spec must have a dedicated node project.
    expect(touchProject).toBeDefined();
    expect(vitestConfig).toContain('name: "dashboard-browser-touch"');
    expect(expandDashboardGlobs(touchProject.include)).toContain(touchGeometrySpec);

    // Script contract: the underlying command is intentionally distinct from the docs invocation.
    expect(scripts["test:touch-geometry"]).toContain("--project dashboard-browser-touch");
    expect(scripts["test:touch-geometry"]).not.toContain("FUSION_DASHBOARD_DEEP");

    // Docs contract: assert operator guidance independently from the package script body.
    expect(testingGuide).toContain("pnpm --filter @fusion/dashboard test:touch-geometry");
    expect(testingGuide).toContain("dashboard-browser-touch");

    // Single-collection contract: the broad API backfill must not re-collect this dedicated lane.
    const collectingProjects = Object.entries(dashboardQualityProjectGlobs)
      .filter(([projectName]) => projectName !== "dashboard-api-quality-backfill")
      .filter(([, project]) => expandDashboardGlobs(project.include).has(touchGeometrySpec))
      .filter(([, project]) => !expandDashboardGlobs(project.exclude).has(touchGeometrySpec))
      .map(([projectName]) => projectName);
    expect(collectingProjects).toEqual(["dashboard-browser-touch"]);
    expect(expandProjectFiles("dashboard-api-quality-backfill")).not.toContain(touchGeometrySpec);

    // Deep-env contract: the deep API escape hatch must still leave one collection owner.
    expect(listTouchGeometryProjectsWithDeepEnv()).toEqual(["dashboard-browser-touch"]);

    // Port contract: the browser fixture requests an OS-selected port and never names the production port.
    expect(specSource).toContain("port: 0");
    expect(specSource).not.toContain("4040");
  });
});
