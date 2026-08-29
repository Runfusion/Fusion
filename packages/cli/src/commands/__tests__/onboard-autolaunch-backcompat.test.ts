import { afterEach, describe, expect, it, vi } from "vitest";

import {
  maybeAutoLaunchOnboarding,
  shouldAutoLaunchOnboarding,
} from "../onboard-autolaunch.js";

describe("onboard autolaunch backward-compat guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips with explicit reason when central DB and project both exist", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: true,
        projectInitialized: true,
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "central-db-and-project-exist" });
  });

  it("keeps central-db-exists skip when only central DB exists", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: true,
        projectInitialized: false,
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "central-db-exists" });
  });

  it("still launches when central DB is missing even if project is initialized", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: true,
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: true, reason: "central-db-missing" });
  });

  it("never launches on non-TTY agent/headless path", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: false,
        isTTY: false,
      }),
    ).toEqual({ launch: false, reason: "non-tty" });
  });

  it("never launches for serve/daemon", () => {
    for (const command of ["serve", "daemon"]) {
      expect(
        shouldAutoLaunchOnboarding({
          command,
          args: [command],
          centralDbExists: false,
          projectInitialized: false,
          cliOnboardingCompleted: false,
          isTTY: true,
        }),
      ).toEqual({ launch: false, reason: "command-skip" });
    }
  });

  it("agent-run simulation: non-TTY task list resolves and does not prompt", async () => {
    const runOnboard = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    await expect(
      maybeAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbPath: "/virtual/central.db",
        pathExists: () => false,
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(runOnboard).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("derives projectInitialized from cwd/pathExists seam", async () => {
    const runOnboard = vi.fn();
    const pathExists = vi.fn((path: string) => path.endsWith(".fusion/fusion.db"));

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/central.db",
      cwd: "/workspace/demo",
      isTTY: true,
      pathExists,
      cliOnboardingCompleted: false,
      runOnboard,
    });

    expect(pathExists).toHaveBeenCalledWith("/virtual/central.db");
    expect(pathExists).toHaveBeenCalledWith("/workspace/demo/.fusion/fusion.db");
    expect(runOnboard).toHaveBeenCalledTimes(1);
  });

  it("isolates onboard launch failures as non-fatal diagnostics", async () => {
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
});
