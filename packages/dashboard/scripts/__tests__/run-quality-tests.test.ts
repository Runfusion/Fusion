// @vitest-environment node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, "../../../..");
const fixtureRunnerPath = join(__dirname, "quality-runner-fixture.mjs");
const dashboardRoot = resolve(__dirname, "../..");
const orchestratorPath = join(dashboardRoot, "scripts/run-quality-tests.mjs");

/*
FNXC:QualityRunnerSelfTest 2026-08-23-19:35:
THE ORCHESTRATOR IS INVOKED DIRECTLY, NOT THROUGH `pnpm ... test`. These cases run inside the very
lane set they describe (`api:curated`), so spawning the package command re-entered the suite from
within itself. Under a full 15-lane run that child had to resolve pnpm through Corepack while other
lanes held the machine, and it intermittently produced NOTHING — an empty lane log read as "0 lanes
launched" and failed an assertion about the orchestrator, with no orchestrator defect involved.
Observed twice on 2026-08-23 in `--all --no-fail-fast` runs; both times the file passed alone.

Running `node scripts/run-quality-tests.mjs` keeps every assertion below (lane names, lane count,
fail-fast labelling, `--` passthrough — parseArgs is unit-tested above) while removing the pnpm
dependency and the recursion. The one thing the pnpm spawn additionally proved, that the package
script actually points at this orchestrator, is asserted directly in "package.json wires…" below.
*/

interface QualityLane {
  name: string;
  group: "app" | "api";
  args: string[];
}

interface LaneResult {
  lane: QualityLane;
  ok: boolean;
  code?: number;
  signal?: NodeJS.Signals;
}

interface RunQualityTestsModule {
  qualityLanes: QualityLane[];
  parseArgs(argv: string[]): { group: "all" | "app" | "api"; list: boolean; allLanes: boolean };
  resolveConcurrency(env?: Record<string, string | undefined>): number;
  runQualityTests(options?: {
    failFast?: boolean;
    group?: "all" | "app" | "api";
    concurrency?: number;
    lanes?: QualityLane[];
    runner?: (lane: QualityLane) => Promise<LaneResult>;
  }): Promise<{ ok: boolean; failed: LaneResult[]; completed: number; skipped: number }>;
}

async function loadModule(): Promise<RunQualityTestsModule> {
  return (await import("../run-quality-tests.mjs")) as RunQualityTestsModule;
}

function lane(name: string): QualityLane {
  return { name, group: "app", args: ["--heap=6144", "run", "--project", name] };
}

describe("dashboard quality orchestrator", () => {
  it("clamps dashboard quality concurrency to the safe bound", async () => {
    const { resolveConcurrency } = await loadModule();

    expect(resolveConcurrency({})).toBe(2);
    expect(resolveConcurrency({ FUSION_DASHBOARD_TEST_CONCURRENCY: "1" })).toBe(1);
    expect(resolveConcurrency({ FUSION_DASHBOARD_TEST_CONCURRENCY: "5" })).toBe(2);
    expect(resolveConcurrency({ FUSION_DASHBOARD_TEST_CONCURRENCY: "not-a-number" })).toBe(2);
  });

  it("runs only up to the configured concurrency and does not invoke artifact bootstrap per lane", async () => {
    const { runQualityTests } = await loadModule();
    const lanes = [lane("one"), lane("two"), lane("three")];
    const running = new Set<string>();
    let maxRunning = 0;
    const launched: string[] = [];

    const result = await runQualityTests({
      lanes,
      concurrency: 2,
      runner: async (qualityLane) => {
        launched.push(qualityLane.name);
        expect(qualityLane.args.join(" ")).not.toContain("ensure-test-artifacts");
        running.add(qualityLane.name);
        maxRunning = Math.max(maxRunning, running.size);
        await Promise.resolve();
        running.delete(qualityLane.name);
        return { lane: qualityLane, ok: true };
      },
    });

    expect(result).toMatchObject({ ok: true, completed: 3, skipped: 0 });
    expect(result.failed).toEqual([]);
    expect(launched).toEqual(["one", "two", "three"]);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("stops scheduling new lanes after a failed lane", async () => {
    const { runQualityTests } = await loadModule();
    const lanes = [lane("one"), lane("two"), lane("three")];
    const launched: string[] = [];

    const result = await runQualityTests({
      lanes,
      concurrency: 1,
      runner: async (qualityLane) => {
        launched.push(qualityLane.name);
        return { lane: qualityLane, ok: qualityLane.name !== "two", code: qualityLane.name === "two" ? 1 : 0 };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].lane.name).toBe("two");
    expect(result.skipped).toBe(1);
    expect(launched).toEqual(["one", "two"]);
  });

  it("treats signal-terminated lanes as failed", async () => {
    const { runQualityTests } = await loadModule();
    const killedLane = lane("killed");

    const result = await runQualityTests({
      lanes: [killedLane],
      concurrency: 2,
      runner: async (qualityLane) => ({ lane: qualityLane, ok: false, signal: "SIGKILL" }),
    });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ lane: killedLane, ok: false, signal: "SIGKILL" }]);
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  /*
  FNXC:DashboardQualityLanes 2026-07-31-18:10 (u12 — #2784's structural half):
  Fail-fast hid 123 real failures behind one red lane: nine lanes were never run, and the report said
  "skipped 9 lane(s)", which reads like a benign skip rather than "status unknown". These pin BOTH
  halves — the default still stops (fast local feedback), and `--all` reaches every lane — because a
  flag nobody can prove works is the same as no flag.
  */
  it("DEFAULT stops scheduling after the first failing lane", async () => {
    const { runQualityTests } = await loadModule();
    const launched: string[] = [];

    const result = await runQualityTests({
      lanes: [lane("one"), lane("two"), lane("three")],
      concurrency: 1,
      runner: async (qualityLane) => {
        launched.push(qualityLane.name);
        return { lane: qualityLane, ok: qualityLane.name !== "one" };
      },
    });

    expect(launched).toEqual(["one"]);
    expect(result).toMatchObject({ ok: false, skipped: 2 });
  });

  it("parses direct and pnpm-forwarded aggregate aliases while rejecting genuine unknown arguments", async () => {
    const { parseArgs } = await loadModule();

    expect(parseArgs([])).toEqual({ group: "all", list: false, allLanes: false });
    expect(parseArgs(["--all"])).toEqual({ group: "all", list: false, allLanes: true });
    expect(parseArgs(["--no-fail-fast"])).toEqual({ group: "all", list: false, allLanes: true });
    expect(parseArgs(["--", "--all"])).toEqual({ group: "all", list: false, allLanes: true });
    expect(parseArgs(["--", "--no-fail-fast"])).toEqual({ group: "all", list: false, allLanes: true });
    expect(parseArgs(["--group", "app", "--list"])).toEqual({ group: "app", list: true, allLanes: false });
    expect(() => parseArgs(["--", "--not-a-quality-option"])).toThrow("Unknown argument: --not-a-quality-option");
  });

  it("package.json wires the dashboard test script at this orchestrator", () => {
    /* The cases below invoke scripts/run-quality-tests.mjs directly, so this is what proves the
       package command still reaches it — the one assertion the removed pnpm spawn uniquely carried. */
    const pkg = JSON.parse(readFileSync(join(dashboardRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.test).toContain("scripts/run-quality-tests.mjs");
  });

  it.each(["--all", "--no-fail-fast"])("runs package aggregate alias %s through all 15 lanes without hiding failures", async (aggregateAlias) => {
    const { qualityLanes } = await loadModule();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "fn-8714-quality-runner-"));
    const laneLogPath = join(temporaryDirectory, "lanes.log");

    try {
      const result = spawnSync(process.execPath, [orchestratorPath, "--", aggregateAlias], {
        cwd: dashboardRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_ignore_scripts: "true",
          FUSION_DASHBOARD_TEST_CONCURRENCY: "1",
          FUSION_DASHBOARD_QUALITY_TEST_MODE: "1",
          FUSION_DASHBOARD_QUALITY_RUNNER: fixtureRunnerPath,
          FUSION_DASHBOARD_QUALITY_LANE_LOG: laneLogPath,
          FUSION_DASHBOARD_QUALITY_FAIL_PROJECTS: "dashboard-app-quality-foundation-api,dashboard-api-quality",
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const startedLanes = [...output.matchAll(/^\[dashboard-quality\] start ([^:]+:[^:]+):/gm)].map((match) => match[1]);
      const launchedProjects = existsSync(laneLogPath) ? readFileSync(laneLogPath, "utf8").trim().split("\n") : [];

      expect(result.status, output).toBe(1);
      expect(output).not.toContain("Unknown argument: --");
      expect(startedLanes).toEqual(qualityLanes.map((qualityLane) => qualityLane.name));
      expect(new Set(startedLanes).size).toBe(15);
      expect(launchedProjects).toHaveLength(15);
      expect(output).toContain("failed lane(s): app:foundation-api, api:curated");
      expect(output).not.toContain("NOT RUN");
      expect(output).not.toContain("all 15 lane(s) passed");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the no-argument package command fail-fast and labels unrun lanes unknown", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "fn-8714-default-quality-runner-"));
    const laneLogPath = join(temporaryDirectory, "lanes.log");

    try {
      const result = spawnSync(process.execPath, [orchestratorPath], {
        cwd: dashboardRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_ignore_scripts: "true",
          /*
          FNXC:QualityRunnerSelfTest 2026-08-23-19:20:
          These cases spawn the package's OWN `pnpm ... test` command, so the child inherits Corepack.
          Inside a full lane run the child hit Corepack's interactive prompt
          ("! Corepack is about to download .../pnpm-10.33.0.tgz"), never launched, and the lane log
          came back empty — the assertion then read 0 launched projects and failed. It passed when the
          file was run alone only because that shell had already resolved pnpm. Disable the prompt so
          the child resolves pnpm non-interactively; this changes nothing about what is asserted.
          */
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          FUSION_DASHBOARD_TEST_CONCURRENCY: "1",
          FUSION_DASHBOARD_QUALITY_TEST_MODE: "1",
          FUSION_DASHBOARD_QUALITY_RUNNER: fixtureRunnerPath,
          FUSION_DASHBOARD_QUALITY_LANE_LOG: laneLogPath,
          FUSION_DASHBOARD_QUALITY_FAIL_PROJECTS: "dashboard-app-quality-foundation-api",
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const launchedProjects = readFileSync(laneLogPath, "utf8").trim().split("\n");

      expect(result.status, output).toBe(1);
      expect(launchedProjects).toEqual(["dashboard-app-quality-foundation-api"]);
      expect(output).toContain("14 lane(s) were NOT RUN after the first failure — their status is UNKNOWN, not passing.");
      expect(output).not.toContain("all 1 lane(s) passed");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("failFast:false runs EVERY lane and reports every failure, not just the first", async () => {
    const { runQualityTests } = await loadModule();
    const launched: string[] = [];

    const result = await runQualityTests({
      lanes: [lane("one"), lane("two"), lane("three")],
      concurrency: 1,
      failFast: false,
      runner: async (qualityLane) => {
        launched.push(qualityLane.name);
        return { lane: qualityLane, ok: qualityLane.name === "two" };
      },
    });

    // The half that matters: lane three ran even though lane one had already failed.
    expect(launched).toEqual(["one", "two", "three"]);
    expect(result).toMatchObject({ ok: false, completed: 3, skipped: 0 });
    expect(result.failed.map((f: { lane: { name: string } }) => f.lane.name)).toEqual(["one", "three"]);
  });
});
