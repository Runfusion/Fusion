import { afterEach, describe, expect, it, vi } from "vitest";

import { maybeAutoLaunchOnboarding } from "../onboard-autolaunch.js";

describe("maybeAutoLaunchOnboarding backward-compat e2e guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not prompt onboarded interactive users with central and project DB present", async () => {
    const runOnboard = vi.fn();
    const pathExists = vi.fn((path: string) =>
      path === "/virtual/central.db" || path.endsWith("/.fusion/fusion.db"),
    );

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        cwd: "/repo/demo",
        isTTY: true,
        pathExists,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("never blocks agent-run non-TTY task commands when nothing is initialized", async () => {
    const runOnboard = vi.fn();

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        isTTY: false,
        pathExists: () => false,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("skips serve and daemon commands even with missing DB", async () => {
    for (const command of ["serve", "daemon"]) {
      const runOnboard = vi.fn();

      await expect(
        maybeAutoLaunchOnboarding({
          command,
          args: [command],
          centralDbPath: "/virtual/central.db",
          isTTY: true,
          pathExists: () => false,
          runOnboard,
        }),
      ).resolves.toBeUndefined();

      expect(runOnboard).not.toHaveBeenCalled();
    }
  });

  it("honors --skip-onboarding end-to-end", async () => {
    const runOnboard = vi.fn();

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list", "--skip-onboarding"],
        centralDbPath: "/virtual/central.db",
        isTTY: true,
        pathExists: () => false,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("honors FUSION_SKIP_ONBOARDING end-to-end", async () => {
    const runOnboard = vi.fn();

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        isTTY: true,
        env: { FUSION_SKIP_ONBOARDING: "true" },
        pathExists: () => false,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("isolates runOnboard failures as non-fatal with one diagnostic", async () => {
    const runOnboard = vi.fn().mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        isTTY: true,
        pathExists: () => false,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[onboard-autolaunch] non-fatal onboard launch failure: boom"),
    );
  });

  it("launches onboarding once for legitimate first-run interactive commands", async () => {
    const runOnboard = vi.fn();

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        isTTY: true,
        pathExists: () => false,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(runOnboard).toHaveBeenCalledTimes(1);
  });

  it("derives projectInitialized from cwd/pathExists seam without real filesystem", async () => {
    const runOnboard = vi.fn();
    const pathExists = vi.fn((path: string) =>
      path === "/virtual/central.db" || path === "/workspace/demo/.fusion/fusion.db",
    );

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        cwd: "/workspace/demo",
        isTTY: true,
        pathExists,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(pathExists).toHaveBeenCalledWith("/workspace/demo/.fusion/fusion.db");
    expect(runOnboard).not.toHaveBeenCalled();
  });
});
