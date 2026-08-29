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
        cliOnboardingCompleted: false,
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
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: true, reason: "central-db-missing" });
  });

  it("skips when onboarding completion marker is present", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: true,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "onboarding-complete-marker" });
  });

  it("keeps non-TTY precedence over onboarding completion marker", () => {
    expect(
      shouldAutoLaunchOnboarding({
        command: "task",
        args: ["task", "list"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: true,
        isTTY: false,
      }),
    ).toEqual({ launch: false, reason: "non-tty" });
  });

  it("keeps command skip precedence over onboarding completion marker", () => {
    for (const command of ["serve", "daemon"]) {
      expect(
        shouldAutoLaunchOnboarding({
          command,
          args: [command],
          centralDbExists: false,
          projectInitialized: false,
          cliOnboardingCompleted: true,
          isTTY: true,
        }),
      ).toEqual({ launch: false, reason: "command-skip" });
    }
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
        cliOnboardingCompleted: false,
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
        cliOnboardingCompleted: false,
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
        cliOnboardingCompleted: false,
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
        cliOnboardingCompleted: false,
        isTTY: true,
      }),
    ).toEqual({ launch: false, reason: "command-skip" });

    expect(
      shouldAutoLaunchOnboarding({
        command: "daemon",
        args: ["daemon"],
        centralDbExists: false,
        projectInitialized: false,
        cliOnboardingCompleted: false,
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
        cliOnboardingCompleted: false,
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
        cliOnboardingCompleted: false,
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
      cliOnboardingCompleted: false,
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledTimes(1);
    // FNXC:Onboarding 2026-08-19-03:38: auto-launch never interrogates the operator — it fires while
    // they are starting something else, and a dev server stopped on a prompt never listens.
    expect(runOnboard).toHaveBeenCalledWith({ interactive: false });
  });

  /*
  FNXC:Onboarding 2026-08-19-03:38:
  A Postgres install has no `fusion-central.db`; SQLite central was removed. Probing only that path
  left centralDbExists permanently false, so onboarding auto-launched on every interactive start of
  a fully working Fusion. The embedded Postgres data directory counts as an initialized install.
  */
  it("treats an embedded-postgres install as initialized", async () => {
    const runOnboard = vi.fn();

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/fusion-central.db",
      isTTY: true,
      // No SQLite file, but the Postgres data directory is present.
      pathExists: (candidate: string) => candidate === "/virtual/embedded-postgres",
      cliOnboardingCompleted: false,
      runOnboard,
    });

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("does not invoke runOnboard when gate fails", async () => {
    const runOnboard = vi.fn();

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/fusion-central.db",
      isTTY: true,
      pathExists: () => true,
      cliOnboardingCompleted: false,
      runOnboard,
    });

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("does not invoke runOnboard when injected marker is complete", async () => {
    const runOnboard = vi.fn();

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/fusion-central.db",
      isTTY: true,
      pathExists: () => false,
      loadOnboardingComplete: () => true,
      runOnboard,
    });

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("treats marker resolver failure as incomplete and emits diagnostic", async () => {
    const runOnboard = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await maybeAutoLaunchOnboarding({
      command: "task",
      args: ["task", "list"],
      centralDbPath: "/virtual/fusion-central.db",
      isTTY: true,
      pathExists: () => false,
      loadOnboardingComplete: () => {
        throw new Error("settings unavailable");
      },
      runOnboard,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[onboard-autolaunch] onboarding marker probe failed; treating as incomplete: settings unavailable",
      ),
    );
    expect(runOnboard).toHaveBeenCalledTimes(1);
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
        cliOnboardingCompleted: false,
        runOnboard,
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[onboard-autolaunch] non-fatal onboard launch failure: boom"),
    );
  });
});
