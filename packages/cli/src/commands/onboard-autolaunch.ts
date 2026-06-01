import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultCentralDbPath } from "@fusion/core";

import { isTTYAvailable } from "./dashboard-tui/index.js";

export interface AutoLaunchInput {
  command: string;
  args: string[];
  centralDbExists: boolean;
  projectInitialized: boolean;
  isTTY: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface AutoLaunchDecision {
  launch: boolean;
  reason: string;
}

export function shouldAutoLaunchOnboarding(input: AutoLaunchInput): AutoLaunchDecision {
  const env = input.env ?? process.env;

  if (input.command === "serve" || input.command === "daemon") {
    return { launch: false, reason: "command-skip" };
  }

  if (input.command === "onboard") {
    return { launch: false, reason: "onboard-command" };
  }

  if (
    input.args.includes("--help") ||
    input.args.includes("-h") ||
    input.args.includes("--version") ||
    input.args.includes("-v")
  ) {
    return { launch: false, reason: "help-or-version" };
  }

  if (!input.isTTY) {
    return { launch: false, reason: "non-tty" };
  }

  if (input.args.includes("--skip-onboarding")) {
    return { launch: false, reason: "skip-flag" };
  }

  if (isTruthy(env.FUSION_SKIP_ONBOARDING)) {
    return { launch: false, reason: "skip-env" };
  }

  if (input.centralDbExists && input.projectInitialized) {
    return { launch: false, reason: "central-db-and-project-exist" };
  }

  if (input.centralDbExists) {
    return { launch: false, reason: "central-db-exists" };
  }

  return { launch: true, reason: "central-db-missing" };
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

interface RunOnboardOptions {
  force?: boolean;
}

type RunOnboard = (options?: RunOnboardOptions) => Promise<void> | void;

export interface MaybeAutoLaunchDeps {
  command: string;
  args: string[];
  centralDbPath?: string;
  projectInitialized?: boolean;
  cwd?: string;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  runOnboard?: RunOnboard;
  pathExists?: (path: string) => boolean;
}

export async function maybeAutoLaunchOnboarding(deps: MaybeAutoLaunchDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const isTTY = deps.isTTY ?? isTTYAvailable();

  let centralDbExists = true;
  let projectInitialized = false;
  try {
    const pathExists = deps.pathExists ?? existsSync;
    const centralDbPath = deps.centralDbPath ?? getDefaultCentralDbPath();
    const cwd = deps.cwd ?? process.cwd();
    const projectDbPath = join(cwd, ".fusion", "fusion.db");
    centralDbExists = pathExists(centralDbPath);
    projectInitialized = deps.projectInitialized ?? pathExists(projectDbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[onboard-autolaunch] central DB probe failed; skipping auto-launch: ${message}`);
    return;
  }

  const decision = shouldAutoLaunchOnboarding({
    command: deps.command,
    args: deps.args,
    centralDbExists,
    projectInitialized,
    isTTY,
    env,
  });

  if (!decision.launch) {
    return;
  }

  try {
    const runOnboard = deps.runOnboard ?? (await import("./onboard.js")).runOnboard;
    await runOnboard();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[onboard-autolaunch] non-fatal onboard launch failure: ${message}`);
  }
}
