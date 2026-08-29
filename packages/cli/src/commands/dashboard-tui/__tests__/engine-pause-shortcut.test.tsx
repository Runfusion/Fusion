import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { I18nextProvider } from "react-i18next";
import { DashboardApp } from "../app.js";
import { DashboardTUI } from "../controller.js";
import { initCliI18n } from "../../../i18n/index.js";
import type { SettingsValues, SystemInfo, TUICallbacks } from "../state.js";

const testI18n = initCliI18n("en");

function renderNode(controller: DashboardTUI) {
  return React.createElement(
    I18nextProvider,
    { i18n: testI18n },
    React.createElement(DashboardApp, { controller }),
  );
}

function makeSystemInfo(engineMode: "active" | "paused" = "active"): SystemInfo {
  return {
    host: "localhost",
    port: 4040,
    baseUrl: "http://localhost:4040",
    authEnabled: false,
    engineMode,
    fileWatcher: true,
    startTimeMs: Date.now(),
  } as SystemInfo;
}

function makeSettings(enginePaused: boolean): SettingsValues {
  return {
    maxConcurrent: 1,
    maxWorktrees: 2,
    autoMerge: false,
    mergeStrategy: "direct",
    pollIntervalMs: 60000,
    enginePaused,
    globalPause: false,
    remoteActiveProvider: null,
    remoteShortLivedEnabled: false,
    remoteShortLivedTtlMs: 900000,
  };
}

/**
 * Wire the minimum callback surface `handleUtilityAction` needs, echoing the
 * requested pause back through settings the way dashboard.ts's onTogglePause does.
 */
function attachCallbacks(controller: DashboardTUI) {
  const onTogglePause = vi.fn(async (paused: boolean) => makeSettings(paused));
  controller.setCallbacks({
    onTogglePause,
    onRefreshStats: async () => {},
    onClearLogs: () => {},
  } as unknown as TUICallbacks);
  return onTogglePause;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/*
FNXC:DashboardTui 2026-07-24-18:40:
Two defects covered here, both found while diagnosing an engine that sat paused
with no visible cause:

1. Routing — the global `t` (Git view) branch returned before the Utilities
   dispatch in the same key handler, so the Utilities panel's advertised
   "[t] Toggle Engine Pause" was unreachable dead UI.
2. Safety — once reachable, one unmodified keystroke would silently stop triage,
   planning, and dispatch. Pausing now takes two presses inside a short window;
   resuming is not destructive and stays single-press.
*/
describe("Utilities [t] engine pause shortcut", () => {
  it("still opens the Git view when Utilities does not own input", async () => {
    const controller = new DashboardTUI();
    controller.setSystemInfo(makeSystemInfo());
    const onTogglePause = attachCallbacks(controller);
    controller.setActiveSection("system");

    const { stdin, unmount } = render(renderNode(controller));
    stdin.write("t");
    await settle();

    const snapshot = controller.getSnapshot();
    expect(snapshot.mode).toBe("interactive");
    expect(snapshot.interactiveView).toBe("git");
    expect(onTogglePause).not.toHaveBeenCalled();
    unmount();
  });

  it("routes to the pause action instead of the Git view when Utilities is focused", async () => {
    const controller = new DashboardTUI();
    controller.setSystemInfo(makeSystemInfo());
    attachCallbacks(controller);
    controller.setActiveSection("utilities");

    const { stdin, unmount } = render(renderNode(controller));
    stdin.write("t");
    await settle();

    // First press arms the confirmation; it must not have escaped to Git view.
    expect(controller.getSnapshot().mode).toBe("status");
    expect(controller.getSnapshot().interactiveView).not.toBe("git");
    unmount();
  });

  it("requires a second press to pause, and does not pause on the first", async () => {
    const controller = new DashboardTUI();
    controller.setSystemInfo(makeSystemInfo());
    const onTogglePause = attachCallbacks(controller);
    controller.setActiveSection("utilities");

    const { stdin, unmount } = render(renderNode(controller));

    stdin.write("t");
    await settle();
    expect(onTogglePause).not.toHaveBeenCalled();

    stdin.write("t");
    await settle();
    expect(onTogglePause).toHaveBeenCalledTimes(1);
    expect(onTogglePause).toHaveBeenCalledWith(true);
    expect(controller.getSnapshot().systemInfo?.engineMode).toBe("paused");
    unmount();
  });

  it("resumes on a single press without confirmation", async () => {
    const controller = new DashboardTUI();
    controller.setSystemInfo(makeSystemInfo("paused"));
    const onTogglePause = attachCallbacks(controller);
    controller.setActiveSection("utilities");

    const { stdin, unmount } = render(renderNode(controller));

    stdin.write("t");
    await settle();
    expect(onTogglePause).toHaveBeenCalledTimes(1);
    expect(onTogglePause).toHaveBeenCalledWith(false);
    expect(controller.getSnapshot().systemInfo?.engineMode).toBe("active");
    unmount();
  });

  it("re-arms rather than pausing twice when pressed a third time", async () => {
    const controller = new DashboardTUI();
    controller.setSystemInfo(makeSystemInfo());
    const onTogglePause = attachCallbacks(controller);
    controller.setActiveSection("utilities");

    const { stdin, unmount } = render(renderNode(controller));

    stdin.write("t"); // arm
    await settle();
    stdin.write("t"); // confirm -> paused
    await settle();
    stdin.write("t"); // engine is paused now: resume is single-press
    await settle();

    expect(onTogglePause).toHaveBeenCalledTimes(2);
    expect(onTogglePause).toHaveBeenNthCalledWith(1, true);
    expect(onTogglePause).toHaveBeenNthCalledWith(2, false);
    unmount();
  });
});
