import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTruthyEnvFlag,
  maybeAutoLaunchOnboarding,
  shouldAutoLaunchOnboarding,
} from "../onboard-autolaunch.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.FUSION_CLI_SKIP_MAIN;
});

describe("onboard bypass reasons", () => {
  it("uses skip-flag when flag is present", async () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list", "--skip-onboarding"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "skip-flag" });

    const runOnboard = vi.fn();
    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list", "--skip-onboarding"],
      isTTY: true,
      pathExists: () => false,
      cliOnboardingCompleted: false,
      runOnboard,
    });
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("uses skip-env when env is truthy", async () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: false,
        isTTY: true,
        env: { FUSION_SKIP_ONBOARDING: "1" },
      }),
    ).toEqual({ launch: false, reason: "skip-env" });

    const runOnboard = vi.fn();
    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      env: { FUSION_SKIP_ONBOARDING: "1" },
      isTTY: true,
      pathExists: () => false,
      cliOnboardingCompleted: false,
      runOnboard,
    });
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("parses strict truthy env values", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isTruthyEnvFlag(value)).toBe(true);
    }

    for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      expect(isTruthyEnvFlag(value)).toBe(false);
    }
  });

  it("does not bypass without flag or env", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: true, reason: "central-db-missing" });
  });
});

describe("extractGlobalProjectFlag", () => {
  it("strips --skip-onboarding and surfaces skipOnboarding", async () => {
    process.env.FUSION_CLI_SKIP_MAIN = "1";
    const { extractGlobalProjectFlag } = await import("../../bin.js");

    expect(extractGlobalProjectFlag(["task", "list", "--skip-onboarding"])).toEqual({
      cleanedArgs: ["task", "list"],
      projectName: undefined,
      skipOnboarding: true,
    });

    expect(extractGlobalProjectFlag(["task", "list"])).toEqual({
      cleanedArgs: ["task", "list"],
      projectName: undefined,
      skipOnboarding: false,
    });
  });

  it("does not consume next arg after --skip-onboarding", async () => {
    process.env.FUSION_CLI_SKIP_MAIN = "1";
    const { extractGlobalProjectFlag } = await import("../../bin.js");

    expect(extractGlobalProjectFlag(["task", "--skip-onboarding", "list"]).cleanedArgs).toEqual([
      "task",
      "list",
    ]);
  });

  it("drives skip-flag via surfaced skipOnboarding", async () => {
    process.env.FUSION_CLI_SKIP_MAIN = "1";
    const { extractGlobalProjectFlag } = await import("../../bin.js");
    const parsed = extractGlobalProjectFlag(["task", "list", "--skip-onboarding"]);

    const runOnboard = vi.fn();
    await maybeAutoLaunchOnboarding({
      command: "task",
      args: parsed.cleanedArgs,
      skipOnboarding: parsed.skipOnboarding,
      isTTY: true,
      pathExists: () => false,
      cliOnboardingCompleted: false,
      runOnboard,
    });

    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: parsed.cleanedArgs,
        skipOnboarding: parsed.skipOnboarding,
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "skip-flag" });
    expect(runOnboard).not.toHaveBeenCalled();
  });
});
