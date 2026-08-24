import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { I18nextProvider } from "react-i18next";
import { initCliI18n } from "../../../i18n/index.js";

/*
FNXC:DashboardTUI 2026-08-19-04:45:
Pressing Enter on the System panel opens the dashboard URL with a detached `spawn`. A MISSING opener
(`xdg-open` on any slim Linux container — precisely where Fusion runs headless) is reported
asynchronously as an 'error' event, not a synchronous throw, so the try/catch around spawn never saw
it: Node re-throws an 'error' with no listener and the whole TUI died.

This fake reproduces that exact shape — spawn returns, then emits 'error' on the next tick — and
asserts nothing escapes. Without the listener the emit throws out of the timer callback and fails
this test, which is why it is asserted through a real emit rather than by inspecting handlers.
*/
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const { DashboardApp } = await import("../app.js");
const { DashboardTUI } = await import("../controller.js");

const testI18n = initCliI18n("en");

function makeSystemInfo() {
  return {
    host: "localhost",
    port: 4040,
    baseUrl: "http://localhost:4040",
    authEnabled: false,
    engineMode: "active" as const,
    fileWatcher: true,
    startTimeMs: Date.now(),
  };
}

describe("System panel Enter with no browser opener", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("survives a spawn that fails asynchronously", async () => {
    // Mimics ENOENT from a missing xdg-open: the call returns a child, the failure lands later.
    const failing = new EventEmitter() as EventEmitter & { unref: () => void };
    failing.unref = () => undefined;
    spawnMock.mockImplementation(() => {
      setTimeout(() => failing.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })), 0);
      return failing;
    });

    const controller = new DashboardTUI();
    controller.setSystemInfo(makeSystemInfo());
    const { stdin, unmount, rerender } = render(
      React.createElement(I18nextProvider, { i18n: testI18n }, React.createElement(DashboardApp, { controller })),
    );
    rerender(React.createElement(I18nextProvider, { i18n: testI18n }, React.createElement(DashboardApp, { controller })));

    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawnMock).toHaveBeenCalled();
    // An 'error' with no listener would have thrown out of the timer and taken the process down.
    expect(failing.listenerCount("error")).toBeGreaterThan(0);
    unmount();
  });
});
