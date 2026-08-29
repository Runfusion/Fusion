#!/usr/bin/env node
/* global console, process */

import { spawn } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const HEAP_MB = 6144;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 2;
const VITEST_WRAPPER = "scripts/run-vitest-with-heap.mjs";
const TEST_RUNNER_ENV = "FUSION_DASHBOARD_QUALITY_RUNNER";
const TEST_MODE_ENV = "FUSION_DASHBOARD_QUALITY_TEST_MODE";
const EXCLUDE_BUILD_OUTPUT = ["--exclude", "**/build-output.test.ts"];

export const qualityLanes = [
  {
    name: "app:foundation-api",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-foundation-api", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:foundation-ui",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-foundation-ui", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:foundation-hooks-utils",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-foundation-hooks-utils", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:components-a",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-components-a", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:components-b",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-components-b", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:app",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-app", "--reporter=default", "--silent=passed-only", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:chat",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-chat", "--reporter=default", "--silent=passed-only", ...EXCLUDE_BUILD_OUTPUT],
  },
  {
    name: "app:settings",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-settings", "--reporter=default", "--silent=passed-only", ...EXCLUDE_BUILD_OUTPUT],
  },
  ...[1, 2, 3, 4].map((shard) => ({
    name: `app:backfill-${shard}`,
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-backfill", "--silent=passed-only", "--reporter=dot", `--shard=${shard}/4`],
  })),
  {
    name: "api:curated",
    group: "api",
    args: ["--heap=6144", "run", "--project", "dashboard-api-quality", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
  ...[1, 2].map((shard) => ({
    name: `api:backfill-${shard}`,
    group: "api",
    args: ["--heap=6144", "run", "--project", "dashboard-api-quality-backfill", "--silent=passed-only", "--reporter=dot", `--shard=${shard}/2`],
  })),
];

function parsePositiveInt(value) {
  if (value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveConcurrency(env = process.env) {
  const requested = parsePositiveInt(env.FUSION_DASHBOARD_TEST_CONCURRENCY) ?? DEFAULT_CONCURRENCY;
  return Math.min(requested, MAX_CONCURRENCY);
}

/*
FNXC:DashboardQualityLanes 2026-08-01-17:15:
FN-8714 follows FN-8699/#2784: pnpm forwards package-script arguments as a leading standalone
`--`, so remove only that boundary marker before validating the runner's own options. Remaining
arguments still fail closed; aggregate mode must not turn unknown options or failed lanes into a
false passing quality report.
*/
export function parseArgs(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  let group = "all";
  let list = false;
  let allLanes = false;

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === "--group") {
      group = normalizedArgv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--all" || arg === "--no-fail-fast") {
      allLanes = true;
      continue;
    }
    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }
    if (arg === "--list") {
      list = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["all", "app", "api"].includes(group)) {
    throw new Error(`Invalid --group value ${JSON.stringify(group)}; expected all, app, or api`);
  }

  return { group, list, allLanes };
}

function selectLanes(group) {
  return group === "all" ? qualityLanes : qualityLanes.filter((lane) => lane.group === group);
}

function formatLaneCommand(lane) {
  return `node ${VITEST_WRAPPER} ${lane.args.join(" ")}`;
}

function runLane(lane) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // FNXC:DashboardQualityLanes 2026-08-01-17:15: The child-process regression runs the exact pnpm
    // command with a deterministic lane fixture; production always retains the heap wrapper.
    const runnerPath = process.env[TEST_MODE_ENV] === "1" ? process.env[TEST_RUNNER_ENV] || VITEST_WRAPPER : VITEST_WRAPPER;
    console.log(`[dashboard-quality] start ${lane.name}: ${formatLaneCommand(lane)}`);
    // process-supervisor-allowlist: foreground test orchestrator runs bounded child processes and waits for each to finish
    const child = spawn(process.execPath, [runnerPath, ...lane.args], {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`[dashboard-quality] ${lane.name} failed to launch after ${durationSeconds}s`);
      resolve({ lane, ok: false, error });
    });

    child.on("close", (code, signal) => {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0 && signal === null) {
        console.log(`[dashboard-quality] pass ${lane.name} (${durationSeconds}s)`);
        resolve({ lane, ok: true });
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
      console.error(`[dashboard-quality] fail ${lane.name} (${durationSeconds}s, ${suffix})`);
      resolve({ lane, ok: false, code: code ?? 1, signal });
    });
  });
}

export async function runQualityTests({
  group = "all",
  concurrency = resolveConcurrency(),
  lanes = selectLanes(group),
  runner = runLane,
  failFast = true,
} = {}) {
  const queue = [...lanes];
  const failed = [];
  let running = 0;
  let completed = 0;
  let stopScheduling = false;

  console.log(
    `[dashboard-quality] running ${queue.length} lane(s), group=${group}, concurrency=${concurrency}, heap=${HEAP_MB}MiB per lane`,
  );

  return new Promise((resolve) => {
    const schedule = () => {
      while (!stopScheduling && running < concurrency && queue.length > 0) {
        const lane = queue.shift();
        running += 1;
        void runner(lane).then((result) => {
          running -= 1;
          completed += 1;
          if (!result.ok) {
            failed.push(result);
            /* FNXC:DashboardQualityLanes 2026-07-31-18:05 (u12 — #2784's structural half):
               Fail-fast stays the DEFAULT so a broken lane still gives fast local feedback, but it is
               now switchable. Stopping hid 123 real failures behind one red lane (#2784): nine lanes
               were never run, and "skipped 9 lane(s)" reads exactly like a benign skip. */
            if (failFast) stopScheduling = true;
          }
          if ((queue.length === 0 || stopScheduling) && running === 0) {
            resolve({ ok: failed.length === 0, failed, completed, skipped: queue.length });
            return;
          }
          schedule();
        });
      }
      if (queue.length === 0 && running === 0) {
        resolve({ ok: failed.length === 0, failed, completed, skipped: 0 });
      }
    };

    schedule();
  });
}

async function main() {
  const { group, list, allLanes } = parseArgs(process.argv.slice(2));
  const lanes = selectLanes(group);

  if (list) {
    for (const lane of lanes) {
      console.log(`${lane.name}\t${formatLaneCommand(lane)}`);
    }
    return;
  }

  const result = await runQualityTests({ group, lanes, failFast: !allLanes });
  if (!result.ok) {
    console.error(`[dashboard-quality] failed lane(s): ${result.failed.map(({ lane }) => lane.name).join(", ")}`);
    if (result.skipped > 0) {
      console.error(
        `[dashboard-quality] ${result.skipped} lane(s) were NOT RUN after the first failure — their status is UNKNOWN, not passing.`
        + `\n[dashboard-quality] re-run with --all (or --no-fail-fast) to execute every lane and see the full failure set.`,
      );
    }
    process.exit(1);
  }
  console.log(`[dashboard-quality] all ${result.completed} lane(s) passed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
