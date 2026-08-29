import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPUTER_ACTIONS, type CapabilitiesResult } from "../computer/contract.js";
import type { ComputerAdapter } from "../computer/adapter.js";
import { resolveComputerAdapter } from "../computer/adapter-registry.js";
import { MacosComputerAdapter } from "../computer/adapter-macos.js";

const projectRoot = "/not-a-real-project";
const seam = { run: vi.fn() };
const clock = { now: () => new Date("2026-08-11T03:34:00.000Z") };
const testApp = { bundleId: "com.example.App", name: "App", pid: 4 };
const testWindow = { window: { windowId: "window-7", windowIndex: 0, title: "Window", bounds: null, minimized: false }, handle: { appTarget: "App", windowId: "window-7", windowIndex: 0 } };
const testLocator = { kind: "ax-path" as const, path: "window[0]/AXButton[3]", role: "AXButton", subrole: null, identifier: null, title: "Go" };
const testElement = { element: { index: 3, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: { x: 1, y: 2, width: 3, height: 4 }, actions: [], locator: testLocator }, handle: testLocator.path };

function fakeMacosAdapter(): ComputerAdapter {
  return {
    platform: "darwin", id: "macos", supported: true,
    capabilities: async (): Promise<CapabilitiesResult> => ({
      platform: "darwin", adapterId: "macos", supported: true,
      actions: [...COMPUTER_ACTIONS], unsupportedActions: [],
      features: { screenshot: true, restoreWindow: true, stdinSecrets: true, crossInvocationSnapshots: true },
    }),
  } as ComputerAdapter;
}

function resolve(platform: string, macosAdapterFactory = vi.fn(fakeMacosAdapter)) {
  return {
    adapter: resolveComputerAdapter({ platform, seam, clock, projectRoot, macosAdapterFactory }),
    macosAdapterFactory,
  };
}

describe("computer adapter registry", () => {
  it("resolves the injected macOS adapter with the injected I/O dependencies", () => {
    const { adapter, macosAdapterFactory } = resolve("darwin");
    expect(adapter.supported).toBe(true);
    expect(adapter.id).toBe("macos");
    expect(macosAdapterFactory).toHaveBeenCalledWith({ platform: "darwin", seam, clock, projectRoot });
  });

  it.each(["linux", "win32"])("uses an honest unsupported adapter on %s", async (platform) => {
    const { adapter, macosAdapterFactory } = resolve(platform);
    expect(macosAdapterFactory).not.toHaveBeenCalled();
    await expect(adapter.capabilities()).resolves.toMatchObject({
      platform, supported: false, actions: [], unsupportedActions: [...COMPUTER_ACTIONS],
      features: { crossInvocationSnapshots: false },
    });
    await expect(adapter.permissions()).resolves.toMatchObject({
      platform, supported: false, allGranted: false, checks: [],
    });
  });

  it("posts a real CoreGraphics press-move-release program for coordinate drag", async () => {
    const dragSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: '{"ok":true}', stderr: "", exitCode: 0, timedOut: false }) };
    const adapter = new MacosComputerAdapter({ seam: dragSeam, clock, projectRoot });
    await adapter.drag({ app: { bundleId: "com.example.App", name: "App", pid: 4 }, snapshotId: null, fromX: 1, fromY: 2, toX: 3, toY: 4 });
    const [file, args, options] = dragSeam.run.mock.calls[1]!;
    expect(file).toBe("osascript");
    expect(args).toEqual(expect.arrayContaining(["drag-coordinates", "App", "1", "2", "3", "4"]));
    expect(args[3]).toContain("CGEventCreateMouseEvent");
    expect(args[3]).toContain("CGEventPost");
    expect(args[3]).not.toContain("se.mouseMove");
    expect(options).toMatchObject({ timeoutMs: 10_000 });
  });

  it.each(["hotkey", "drag"])("does not automate %s when Accessibility is denied", async (action) => {
    const denied = { stdout: '{"accessibility":false,"screenRecording":false}', stderr: "", exitCode: 0, timedOut: false };
    const deniedSeam = { run: vi.fn().mockResolvedValue(denied) };
    const adapter = new MacosComputerAdapter({ seam: deniedSeam, clock, projectRoot });
    const app = { bundleId: "com.example.App", name: "App", pid: 4 };
    const run = action === "hotkey"
      ? adapter.hotkey({ app, keys: ["cmd", "k"] })
      : adapter.drag({ app, snapshotId: null, fromX: 1, fromY: 2, toX: 3, toY: 4 });
    await expect(run).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(deniedSeam.run).toHaveBeenCalledTimes(1);
  });

  it("maps a vanished locator path to ELEMENT_UNRESOLVABLE without automating", async () => {
    const locatorSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: "", stderr: "locator-not-found", exitCode: 1, timedOut: false }) };
    const adapter = new MacosComputerAdapter({ seam: locatorSeam, clock, projectRoot });
    await expect(adapter.resolveLocator({ window: { windowId: "window-7", windowIndex: 0, title: "Window", bounds: null, minimized: false }, handle: { appTarget: "App", windowId: "window-7", windowIndex: 0 } }, { kind: "ax-path", path: "window[0]/AXButton[3]", role: "AXButton", subrole: null, identifier: null, title: "Go" })).rejects.toMatchObject({ code: "ELEMENT_UNRESOLVABLE", remediation: expect.stringContaining("get-app-state") });
    expect(locatorSeam.run.mock.calls).toHaveLength(2);
    expect(locatorSeam.run.mock.calls[1]![1]).toEqual(expect.arrayContaining(["resolve-locator", "window-7", "window[0]/AXButton[3]"]));
  });

  it.each([
    ["TIMEOUT", { stdout: "", stderr: "", exitCode: 0, timedOut: true }],
    ["PERMISSION_UNVERIFIED", { stdout: "", stderr: "not allowed assistive access", exitCode: 1, timedOut: false }],
  ])("preserves %s from locator replay instead of reporting an unresolvable element", async (code, replay) => {
    const locatorSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce(replay) };
    const adapter = new MacosComputerAdapter({ seam: locatorSeam, clock, projectRoot });
    await expect(adapter.resolveLocator(testWindow, testLocator)).rejects.toMatchObject({ code });
  });

  it("preserves a missing osascript denial from locator replay", async () => {
    const missing = Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" });
    const locatorSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockRejectedValueOnce(missing) };
    const adapter = new MacosComputerAdapter({ seam: locatorSeam, clock, projectRoot });
    await expect(adapter.resolveLocator(testWindow, testLocator)).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { missingBinary: "osascript" } });
  });

  it.each([
    ["identity drift", { element: { role: "AXTextField", locator: { path: testLocator.path, subrole: null, identifier: null } } }],
    ["non-live element", { element: null }],
  ])("maps locator replay %s to ELEMENT_UNRESOLVABLE without another automation call", async (_name, replay) => {
    const locatorSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: JSON.stringify(replay), stderr: "", exitCode: 0, timedOut: false }) };
    const adapter = new MacosComputerAdapter({ seam: locatorSeam, clock, projectRoot });
    await expect(adapter.resolveLocator(testWindow, testLocator)).rejects.toMatchObject({ code: "ELEMENT_UNRESOLVABLE", remediation: expect.stringContaining("get-app-state") });
    expect(locatorSeam.run).toHaveBeenCalledTimes(2);
  });

  it.each([["left", 123], ["right", 124], ["up", 126], ["down", 125]] as const)("passes %s scroll direction to the static four-way JXA mapping", async (direction, keyCode) => {
    const scrollSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: '{"ok":true}', stderr: "", exitCode: 0, timedOut: false }) };
    const adapter = new MacosComputerAdapter({ seam: scrollSeam, clock, projectRoot });
    const element = { element: { index: 3, role: "AXScrollArea", title: null, value: null, label: null, enabled: true, focused: true, bounds: null, actions: [], locator: { kind: "ax-path" as const, path: "window[0]", role: "AXScrollArea", subrole: null, identifier: null, title: null } }, handle: "window[0]" };
    await adapter.scroll({ app: { bundleId: "com.example.App", name: "App", pid: 4 }, window: { window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, handle: { appTarget: "App", windowId: "w", windowIndex: 0 } }, element, snapshotId: "cs_0123456789", direction, amount: 2 });
    const args = scrollSeam.run.mock.calls[1]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(["scroll", "App", `${direction}:2`]));
    expect(args[3]).toContain(`direction==='${direction}'`);
    expect(args[3]).toContain(`return ${keyCode}`);
  });

  it("degrades a rejected screencapture spawn without discarding the state tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-screenshot-"));
    const missingCapture = Object.assign(new Error("spawn screencapture ENOENT"), { code: "ENOENT" });
    const captureSeam = {
      run: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "screencapture") throw missingCapture;
        const operation = args[4];
        if (operation === "list-apps") return { stdout: '{"apps":[{"bundleId":"com.example.App","name":"App","pid":4}]}', stderr: "", exitCode: 0, timedOut: false };
        if (operation === "list-windows") return { stdout: '{"windows":[{"windowId":"w","windowIndex":0,"title":"Window","bounds":null,"minimized":false,"captureWindowId":42}]}', stderr: "", exitCode: 0, timedOut: false };
        if (operation === "state") return { stdout: '{"treeText":"captured tree","elements":[],"truncated":false}', stderr: "", exitCode: 0, timedOut: false };
        return { stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false };
      }),
    };
    try {
      const adapter = new MacosComputerAdapter({ seam: captureSeam, clock, projectRoot: root });
      const state = await adapter.captureState({ kind: "name", raw: "App", value: "App" }, { screenshot: true, restoreWindow: false });
      expect(state.snapshot.treeText).toBe("captured tree");
      expect(state.screenshot).toBeNull();
      expect(state.screenshotError).toEqual({ code: "SCREENSHOT_FAILED", message: "Screenshot capture failed." });
      expect(captureSeam.run).toHaveBeenCalledWith("screencapture", expect.any(Array), { timeoutMs: 15_000 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing osascript as unknown permissions", async () => {
    const missing = Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" });
    const missingSeam = { run: vi.fn().mockRejectedValue(missing) };
    const adapter = new MacosComputerAdapter({ seam: missingSeam, clock, projectRoot });
    await expect(adapter.permissions()).resolves.toMatchObject({ allGranted: false, checks: [{ id: "accessibility", status: "unknown", granted: false, probed: false }, { id: "screen-recording", status: "unknown", granted: false, probed: false }] });
  });

  it.each([
    ["list apps", (adapter: MacosComputerAdapter) => adapter.listApps()],
    ["list windows", (adapter: MacosComputerAdapter) => adapter.listWindows({ kind: "name", raw: "App", value: "App" })],
    ["capture state", (adapter: MacosComputerAdapter) => adapter.captureState({ kind: "name", raw: "App", value: "App" }, { screenshot: true, restoreWindow: false })],
    ["resolve locator", (adapter: MacosComputerAdapter) => adapter.resolveLocator(testWindow, testLocator)],
    ["click", (adapter: MacosComputerAdapter) => adapter.click({ app: testApp, window: testWindow, element: testElement, snapshotId: "cs_0123456789" })],
    ["set value", (adapter: MacosComputerAdapter) => adapter["set-value"]({ app: testApp, window: testWindow, element: testElement, snapshotId: "cs_0123456789", value: "value" })],
    ["type text", (adapter: MacosComputerAdapter) => adapter["type-text"]({ app: testApp, text: "text" })],
    ["press key", (adapter: MacosComputerAdapter) => adapter["press-key"]({ app: testApp, key: "enter" })],
    ["scroll", (adapter: MacosComputerAdapter) => adapter.scroll({ app: testApp, direction: "down", amount: 1 })],
    ["hotkey", (adapter: MacosComputerAdapter) => adapter.hotkey({ app: testApp, keys: ["cmd", "k"] })],
    ["coordinate drag", (adapter: MacosComputerAdapter) => adapter.drag({ app: testApp, snapshotId: null, fromX: 1, fromY: 2, toX: 3, toY: 4 })],
    ["element drag", (adapter: MacosComputerAdapter) => adapter.drag({ app: testApp, snapshotId: "cs_0123456789", window: testWindow, from: testElement, to: testElement })],
  ])("blocks %s before automation when osascript is missing", async (_name, invoke) => {
    const missing = Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" });
    const missingSeam = { run: vi.fn().mockRejectedValue(missing) };
    const adapter = new MacosComputerAdapter({ seam: missingSeam, clock, projectRoot });
    await expect(invoke(adapter)).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { missingBinary: "osascript" } });
    expect(missingSeam.run).toHaveBeenCalledTimes(1);
  });

  it("maps osascript disappearing after a successful probe to a missing-binary denial", async () => {
    const missing = Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" });
    const lateFailureSeam = { run: vi.fn()
      .mockResolvedValueOnce({ stdout: '{"accessibility":true,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false })
      .mockRejectedValueOnce(missing) };
    const adapter = new MacosComputerAdapter({ seam: lateFailureSeam, clock, projectRoot });
    await expect(adapter.listApps()).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { missingBinary: "osascript" } });
  });

  it.each([
    ["timeout", { stdout: "", stderr: "", exitCode: 0, timedOut: true }],
    ["non-zero exit", { stdout: "", stderr: "probe failed", exitCode: 1, timedOut: false }],
    ["malformed JSON", { stdout: "not-json", stderr: "", exitCode: 0, timedOut: false }],
  ])("keeps a %s permission probe unknown without treating it as a missing binary", async (_name, probe) => {
    const probeSeam = { run: vi.fn()
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce({ stdout: '{"apps":[]}', stderr: "", exitCode: 0, timedOut: false }) };
    const adapter = new MacosComputerAdapter({ seam: probeSeam, clock, projectRoot });
    await expect(adapter.listApps()).resolves.toEqual({ apps: [] });
    expect(probeSeam.run).toHaveBeenCalledTimes(2);
  });

  it("preserves a genuinely denied Accessibility result without a missing-binary marker", async () => {
    const deniedSeam = { run: vi.fn().mockResolvedValue({ stdout: '{"accessibility":false,"screenRecording":true}', stderr: "", exitCode: 0, timedOut: false }) };
    const adapter = new MacosComputerAdapter({ seam: deniedSeam, clock, projectRoot });
    await expect(adapter.listApps()).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "accessibility" } });
  });

  it("rejects every unsupported operation, including both replay resolvers", async () => {
    const { adapter } = resolve("linux");
    const expectUnsupported = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toMatchObject({
        code: "UNSUPPORTED_PLATFORM",
        remediation: expect.stringContaining("macOS"),
      });
    };

    await expectUnsupported(adapter.listApps());
    await expectUnsupported(adapter.listWindows({ kind: "name", raw: "Notes", value: "Notes" }));
    await expectUnsupported(adapter.captureState({ kind: "name", raw: "Notes", value: "Notes" }, { screenshot: false, restoreWindow: false }));
    await expectUnsupported(adapter.resolveWindow({ kind: "name", raw: "Notes", value: "Notes" }, {}));
    await expectUnsupported(adapter.resolveLocator({} as never, {} as never));
    for (const action of COMPUTER_ACTIONS) {
      await expectUnsupported((adapter as unknown as Record<string, (input: unknown) => Promise<unknown>>)[action]({}));
    }
  });
});
