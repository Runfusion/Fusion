import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultCentralDbPath, GlobalSettingsStore } from "@fusion/core";

import { isTTYAvailable } from "./dashboard-tui/index.js";
import { isCliOnboardingComplete } from "./onboard.js";

export interface AutoLaunchInput {
  command: string;
  args: string[];
  centralDbExists: boolean;
  projectInitialized: boolean;
  cliOnboardingCompleted: boolean;
  isTTY: boolean;
  env?: NodeJS.ProcessEnv;
  skipOnboarding?: boolean;
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

  if (input.skipOnboarding || input.args.includes("--skip-onboarding")) {
    return { launch: false, reason: "skip-flag" };
  }

  if (isTruthyEnvFlag(env.FUSION_SKIP_ONBOARDING)) {
    return { launch: false, reason: "skip-env" };
  }

  if (input.cliOnboardingCompleted) {
    return { launch: false, reason: "onboarding-complete-marker" };
  }

  if (input.centralDbExists && input.projectInitialized) {
    return { launch: false, reason: "central-db-and-project-exist" };
  }

  if (input.centralDbExists) {
    return { launch: false, reason: "central-db-exists" };
  }

  return { launch: true, reason: "central-db-missing" };
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

interface RunOnboardOptions {
  force?: boolean;
}

type RunOnboard = (options?: RunOnboardOptions) => Promise<void> | void;

export interface MaybeAutoLaunchDeps {
  command: string;
  args: string[];
  skipOnboarding?: boolean;
  centralDbPath?: string;
  projectInitialized?: boolean;
  cwd?: string;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  runOnboard?: RunOnboard;
  pathExists?: (path: string) => boolean;
  cliOnboardingCompleted?: boolean;
  loadOnboardingComplete?: () => Promise<boolean> | boolean;
}

async function loadCliOnboardingComplete(): Promise<boolean> {
  const globalSettingsStore = new GlobalSettingsStore();
  await globalSettingsStore.init();
  const settings = await globalSettingsStore.getSettings();
  return isCliOnboardingComplete(settings);
}

async function resolveCliOnboardingCompleted(deps: MaybeAutoLaunchDeps): Promise<boolean> {
  if (deps.cliOnboardingCompleted !== undefined) {
    return deps.cliOnboardingCompleted;
  }

  const loadOnboardingComplete = deps.loadOnboardingComplete ?? loadCliOnboardingComplete;
  try {
    return await loadOnboardingComplete();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[onboard-autolaunch] onboarding marker probe failed; treating as incomplete: ${message}`);
    return false;
  }
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
    const projectMarkerPath = join(cwd, ".fusion", "project.json");
    const legacyProjectDbPath = join(cwd, ".fusion", "fusion.db");
    centralDbExists = pathExists(centralDbPath);
    // FNXC:ProjectIdentityMarker 2026-07-14-17:20: Onboarding probes the new
    // marker first and recognizes fusion.db only as a pre-cutover project signal.
    projectInitialized = deps.projectInitialized
      ?? (pathExists(projectMarkerPath) || pathExists(legacyProjectDbPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[onboard-autolaunch] central DB probe failed; skipping auto-launch: ${message}`);
    return;
  }

  const baseDecisionInput = {
    command: deps.command,
    args: deps.args,
    centralDbExists,
    projectInitialized,
    cliOnboardingCompleted: false,
    isTTY,
    env,
    skipOnboarding: deps.skipOnboarding,
  };

  const baseDecision = shouldAutoLaunchOnboarding(baseDecisionInput);
  if (!baseDecision.launch) {
    return;
  }

  const cliOnboardingCompleted = await resolveCliOnboardingCompleted(deps);
  const decision = shouldAutoLaunchOnboarding({
    ...baseDecisionInput,
    cliOnboardingCompleted,
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
