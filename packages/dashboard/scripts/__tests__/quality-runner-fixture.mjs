#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";

const projectIndex = process.argv.indexOf("--project");
const project = process.argv[projectIndex + 1] ?? "unknown-project";

if (process.env.FUSION_DASHBOARD_QUALITY_LANE_LOG) {
  appendFileSync(process.env.FUSION_DASHBOARD_QUALITY_LANE_LOG, `${project}\n`);
}

if (process.env.FUSION_DASHBOARD_QUALITY_SIGNAL_PROJECT === project) {
  process.kill(process.pid, "SIGTERM");
}

const failedProjects = new Set((process.env.FUSION_DASHBOARD_QUALITY_FAIL_PROJECTS ?? "").split(",").filter(Boolean));
process.exitCode = failedProjects.has(project) ? 1 : 0;
