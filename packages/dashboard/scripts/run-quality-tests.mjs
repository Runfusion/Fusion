#!/usr/bin/env node
/* global console, process */

import { spawn } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const HEAP_MB = 6144;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 2;
const VITEST_WRAPPER = "scripts/run-vitest-with-heap.mjs";
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
  /*
  FNXC:DashboardTests 2026-07-14-21:25:
  Vitest --shard=N/4 for dashboard-app-quality-backfill shard 2 finished every test then never exited (open-handle hang until the 900s watchdog). Explicit file lists of the same specs exit cleanly. Run one unsharded backfill lane instead of four shard processes so the quality suite always terminates; curated shards remain the fast path.
  */
  {
    name: "app:backfill",
    group: "app",
    args: ["--heap=6144", "run", "--project", "dashboard-app-quality-backfill", "--silent=passed-only", "--reporter=dot", ...EXCLUDE_BUILD_OUTPUT],
  },
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

function parseArgs(argv) {
  let group = "all";
  let list = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--group") {
      group = argv[index + 1] ?? "";
      index += 1;
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

  return { group, list };
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
    console.log(`[dashboard-quality] start ${lane.name}: ${formatLaneCommand(lane)}`);
    // process-supervisor-allowlist: foreground test orchestrator runs bounded child processes and waits for each to finish
    const child = spawn(process.execPath, [VITEST_WRAPPER, ...lane.args], {
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
            stopScheduling = true;
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
  const { group, list } = parseArgs(process.argv.slice(2));
  const lanes = selectLanes(group);

  if (list) {
    for (const lane of lanes) {
      console.log(`${lane.name}\t${formatLaneCommand(lane)}`);
    }
    return;
  }

  const result = await runQualityTests({ group, lanes });
  if (!result.ok) {
    console.error(`[dashboard-quality] failed lane(s): ${result.failed.map(({ lane }) => lane.name).join(", ")}`);
    if (result.skipped > 0) {
      console.error(`[dashboard-quality] skipped ${result.skipped} lane(s) after first failure`);
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
