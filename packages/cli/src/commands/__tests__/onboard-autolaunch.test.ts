import { afterEach, describe, expect, it, vi } from "vitest";

import {
  maybeAutoLaunchOnboarding,
  shouldAutoLaunchOnboarding,
} from "../onboard-autolaunch.js";

describe("shouldAutoLaunchOnboarding", () => {
  it("returns launch true for interactive command when central DB missing", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: true, reason: "central-db-missing" });
  });

  it("returns launch true for default dashboard path", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "dashboard",
        args: ["dashboard"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: true, reason: "central-db-missing" });
  });

  it("skips when skip flag is present in args", () => {
    const args = ["task", "list", "--skip-onboarding"];
    expect(args).toContain("--skip-onboarding");
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args,
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "skip-flag" });
  });

  it("skips when central DB exists", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: true,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "central-db-exists" });
  });

  it("skips on non-TTY", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: false,
      }),
    ).toEqual({ launch: false, reason: "non-tty" });
  });

  it("skips for serve and daemon", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "serve",
        args: ["serve"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "command-skip" });

    expect(
      shouldAutoLaunchOnboarding({
        command: "daemon",
        args: ["daemon"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "command-skip" });
  });

  it("skips for onboard command", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "onboard",
        args: ["onboard"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "onboard-command" });
  });

  it("skips when FUSION_SKIP_ONBOARDING is truthy", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        isTTY: true,
        env: { FUSION_SKIP_ONBOARDING: "1" },
      }),
    ).toEqual({ launch: false, reason: "skip-env" });
  });
});

describe("maybeAutoLaunchOnboarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes runOnboard when gate passes", async () => {
    const runOnboard = vi.fn();

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/fusion-central.db",
      isTTY: true,
      pathExists: () => false,
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledTimes(1);
  });

  it("does not invoke runOnboard when gate fails", async () => {
    const runOnboard = vi.fn();

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/fusion-central.db",
      isTTY: true,
      pathExists: () => true,
      runOnboard,
    });

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("swallows runOnboard errors and emits diagnostic", async () => {
    const runOnboard = vi.fn().mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/fusion-central.db",
        isTTY: true,
        pathExists: () => false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[onboard-autolaunch] non-fatal onboard launch failure: boom"),
    );
  });
});
