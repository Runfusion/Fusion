import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runComputer } from "../computer.js";
import { ComputerSnapshotStore } from "../computer/snapshot-store.js";
import { ComputerUseError } from "../computer/contract.js";
import type { ComputerAdapter } from "../computer/adapter.js";

const app = { bundleId: "com.example.App", name: "App", pid: 1 };
const adapter: ComputerAdapter = {
  platform: "darwin", id: "fake", supported: true,
  capabilities: async () => ({ platform: "darwin", adapterId: "fake", supported: true, actions: ["click", "set-value", "type-text", "press-key", "hotkey", "scroll", "drag"], unsupportedActions: [], features: { screenshot: false, restoreWindow: false, stdinSecrets: true, crossInvocationSnapshots: true } }),
  permissions: async () => ({ platform: "darwin", adapterId: "fake", supported: true, allGranted: true, checks: [] }),
  listApps: async () => ({ apps: [app] }), listWindows: async () => ({ app, windows: [{ windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }] }),
  captureState: async () => ({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, snapshot: { snapshotId: "", targetKey: "", windowKey: "", capturedAt: new Date(0).toISOString(), expiresAt: "", treeText: "tree", elementCount: 1, truncated: false, elements: [{ index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path", path: "button[0]", role: "AXButton", subrole: null, identifier: null, title: "Go" } }] }, screenshot: null }),
  resolveWindow: async () => ({ window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, handle: "w" }), resolveLocator: async (_w, locator) => ({ element: { index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator }, handle: "e" }),
  click: async (x) => ({ action: "click", app: x.app, snapshotId: x.snapshotId, elementIndex: 7, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }), "set-value": async () => { throw new Error("unused"); }, "type-text": async () => { throw new Error("unused"); }, "press-key": async () => { throw new Error("unused"); }, hotkey: async () => { throw new Error("unused"); }, scroll: async () => { throw new Error("unused"); }, drag: async () => { throw new Error("unused"); },
};
describe("computer commands", () => {
  it("emits one JSON envelope and persists a snapshot", async () => { const output: string[] = []; const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-")); try { expect(await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter, projectRoot: root, stdout: (x) => output.push(x) })).toBe(0); const envelope = JSON.parse(output[0]); expect(envelope).toMatchObject({ schemaVersion: 1, ok: true, command: "computer.get-app-state" }); expect(envelope.result.snapshot.snapshotId).toMatch(/^cs_/); } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); } });
  it("keeps snapshots project-local when capture and replay use different directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-project-"));
    const nested = join(root, "pkg");
    const captureOutput: string[] = [];
    const actionOutput: string[] = [];
    const clock = { now: () => new Date("2026-08-13T00:00:00.000Z") };
    const localAdapter: ComputerAdapter = { ...adapter, captureState: async () => {
      const state = await adapter.captureState({ kind: "name", value: "App", raw: "App" }, { screenshot: false });
      state.snapshot.capturedAt = clock.now().toISOString();
      return state;
    } };
    try {
      await mkdir(nested);
      await mkdir(join(root, ".fusion"));
      await writeFile(join(root, ".fusion", "project.json"), JSON.stringify({ id: "proj_0123456789abcdef", createdAt: "2026-08-13T00:00:00.000Z" }));
      expect(await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter: localAdapter, projectRoot: nested, clock, stdout: (text) => captureOutput.push(text) })).toBe(0);
      const snapshotId = JSON.parse(captureOutput[0]!).result.snapshot.snapshotId;
      expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--json"], { adapter: localAdapter, projectRoot: root, clock, stdout: (text) => actionOutput.push(text) })).toBe(0);
      expect(JSON.parse(actionOutput[0]!)).toMatchObject({ ok: true, command: "computer.click", result: { snapshotId } });
      expect(await readdir(join(root, ".fusion", "computer-use", "snapshots"))).toContain(`${snapshotId}.json`);
      expect(await readdir(join(root, ".fusion", "computer-use", "latest"))).not.toHaveLength(0);
      await expect(access(join(nested, ".fusion", "computer-use"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fences stale IDs and replays latest click and set-value targets before actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-fence-"));
    const clock = { now: () => new Date("2026-08-13T00:00:00.000Z") };
    const store = new ComputerSnapshotStore({ projectRoot: root, now: clock.now });
    const snapshotElement = (index: number) => ({ index, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path" as const, path: "button[0]", role: "AXButton", subrole: null, identifier: null, title: "Go" } });
    const first = await store.persist({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, elementCount: 8, elements: [snapshotElement(7)] });
    const latest = await store.persist({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, elementCount: 8, elements: [snapshotElement(7)] });
    const calls: string[] = [];
    const click = vi.fn(async (input: Parameters<ComputerAdapter["click"]>[0]) => { calls.push("click"); return { action: "click" as const, app: input.app, snapshotId: input.snapshotId, elementIndex: input.element.element.index, fromElementIndex: null, toElementIndex: null, performed: true }; });
    const setValue = vi.fn(async (input: Parameters<ComputerAdapter["set-value"]>[0]) => { calls.push("set-value"); return { action: "set-value" as const, app: input.app, snapshotId: input.snapshotId, elementIndex: input.element.element.index, fromElementIndex: null, toElementIndex: null, performed: true }; });
    const replayAdapter: ComputerAdapter = { ...adapter,
      resolveWindow: async () => { calls.push("window"); return { window: { windowId: "w", windowIndex: 0, title: "w", bounds: { x: 1, y: 2, width: 3, height: 4 }, minimized: false }, handle: "live-window" }; },
      resolveLocator: async (_window, locator) => { calls.push("locator"); return { element: { ...snapshotElement(7), bounds: { x: 10, y: 20, width: 30, height: 40 }, locator }, handle: "live-element" }; },
      click, "set-value": setValue,
    };
    const staleOutput: string[] = [];
    try {
      expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--snapshot-id", first.snapshotId, "--json"], { adapter: replayAdapter, store, projectRoot: root, stdout: (text) => staleOutput.push(text) })).toBe(1);
      expect(JSON.parse(staleOutput[0]!)).toMatchObject({ error: { code: "SNAPSHOT_STALE", details: { reason: "superseded" } } });
      expect(click).not.toHaveBeenCalled();
      expect(await runComputer(["set-value", "--app", "App", "--element-index", "7", "--snapshot-id", first.snapshotId, "--value", "safe", "--json"], { adapter: replayAdapter, store, projectRoot: root, stdout: () => undefined })).toBe(1);
      expect(setValue).not.toHaveBeenCalled();
      expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--snapshot-id", latest.snapshotId, "--json"], { adapter: replayAdapter, store, projectRoot: root, stdout: () => undefined })).toBe(0);
      expect(calls).toEqual(["window", "locator", "click"]);
      expect(click).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotId: latest.snapshotId, element: expect.objectContaining({ element: expect.objectContaining({ index: 7, locator: snapshotElement(7).locator, bounds: { x: 10, y: 20, width: 30, height: 40 } }) }) }));
      calls.length = 0;
      expect(await runComputer(["set-value", "--app", "App", "--element-index", "7", "--value", "safe", "--json"], { adapter: replayAdapter, store, projectRoot: root, stdout: () => undefined })).toBe(1);
      expect(calls).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("maps vanished windows and locator replay failures to safe snapshot errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-replay-failure-"));
    const store = new ComputerSnapshotStore({ projectRoot: root, now: () => new Date("2026-08-13T00:00:00.000Z") });
    const snapshot = await store.persist({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, elementCount: 8, elements: [{ index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path", path: "button[0]", role: "AXButton", subrole: null, identifier: null, title: "Go" } }] });
    const output: string[] = [];
    try {
      const missingWindow: ComputerAdapter = { ...adapter, resolveWindow: async () => { throw new ComputerUseError("WINDOW_NOT_FOUND", "gone"); } };
      expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--json"], { adapter: missingWindow, store, projectRoot: root, stdout: (text) => output.push(text) })).toBe(1);
      expect(JSON.parse(output.pop()!)).toMatchObject({ error: { code: "SNAPSHOT_STALE", details: { reason: "window-gone" } } });
      const missingLocator: ComputerAdapter = { ...adapter, resolveLocator: async () => { throw new ComputerUseError("ELEMENT_UNRESOLVABLE", "gone", "Re-run fn computer get-app-state."); } };
      expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--json"], { adapter: missingLocator, store, projectRoot: root, stdout: (text) => output.push(text) })).toBe(1);
      expect(JSON.parse(output.pop()!)).toMatchObject({ error: { code: "ELEMENT_UNRESOLVABLE", details: { snapshotId: snapshot.snapshotId, elementIndex: 7 } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["TIMEOUT", "PERMISSION_UNVERIFIED", "PERMISSION_DENIED"] as const)("preserves %s from element replay without stale-element wrapping", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-replay-code-"));
    const store = new ComputerSnapshotStore({ projectRoot: root, now: () => new Date("2026-08-13T00:00:00.000Z") });
    const snapshot = await store.persist({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, elementCount: 8, elements: [{ index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path", path: "button[0]", role: "AXButton", subrole: null, identifier: null, title: "Go" } }] });
    const output: string[] = [];
    const replayAdapter: ComputerAdapter = { ...adapter, resolveLocator: async () => { throw new ComputerUseError(code, "replay failed", code === "TIMEOUT" ? undefined : "Grant permission.", { replay: true }); } };
    try {
      expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--snapshot-id", snapshot.snapshotId, "--json"], { adapter: replayAdapter, store, projectRoot: root, stdout: (text) => output.push(text) })).toBe(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ error: { code, details: { replay: true } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("wraps either element-drag endpoint when locator replay cannot resolve it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-drag-replay-"));
    const store = new ComputerSnapshotStore({ projectRoot: root, now: () => new Date("2026-08-13T00:00:00.000Z") });
    const element = (index: number) => ({ index, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path" as const, path: `button[${index}]`, role: "AXButton", subrole: null, identifier: null, title: "Go" } });
    const snapshot = await store.persist({ app, window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, elementCount: 9, elements: [element(7), element(8)] });
    const output: string[] = [];
    const replayAdapter: ComputerAdapter = { ...adapter, resolveLocator: async (_window, locator) => { if (locator.path === "button[8]") throw new ComputerUseError("ELEMENT_UNRESOLVABLE", "gone", "Re-run fn computer get-app-state."); return { element: element(7), handle: "live" }; } };
    try {
      expect(await runComputer(["drag", "--app", "App", "--from-element-index", "7", "--to-element-index", "8", "--snapshot-id", snapshot.snapshotId, "--json"], { adapter: replayAdapter, store, projectRoot: root, stdout: (text) => output.push(text) })).toBe(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: "ELEMENT_UNRESOLVABLE", details: { snapshotId: snapshot.snapshotId, elementIndex: 8 } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the snapshot replay path for element-scoped typing", async () => {
    const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-"));
    let resolved = 0;
    let typed = 0;
    const replayAdapter: ComputerAdapter = { ...adapter,
      resolveLocator: async (_window, locator) => { resolved += 1; return { element: { index: 7, role: "AXButton", title: "Go", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator }, handle: "live" }; },
      "type-text": async (input) => { typed += 1; return { action: "type-text", app: input.app, snapshotId: input.snapshotId ?? null, elementIndex: input.element?.element.index ?? null, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }; },
    };
    try {
      await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter: replayAdapter, projectRoot: root, clock: { now: () => new Date(0) }, stdout: () => undefined });
      expect(await runComputer(["type-text", "--app", "App", "--element-index", "7", "--text", "safe", "--json"], { adapter: replayAdapter, projectRoot: root, clock: { now: () => new Date(0) }, stdout: () => undefined })).toBe(0);
      expect(resolved).toBe(1); expect(typed).toBe(1);
    } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
  });
  it("accepts complete coordinate drag without a snapshot", async () => {
    let input: Parameters<ComputerAdapter["drag"]>[0] | undefined;
    const dragAdapter: ComputerAdapter = { ...adapter, drag: async (value) => { input = value; return { action: "drag", app: value.app, snapshotId: null, elementIndex: null, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }; } };
    expect(await runComputer(["drag", "--app", "App", "--from-x", "1", "--from-y", "2", "--to-x", "3", "--to-y", "4", "--json"], { adapter: dragAdapter, stdout: () => undefined })).toBe(0);
    expect(input).toMatchObject({ snapshotId: null, fromX: 1, fromY: 2, toX: 3, toY: 4 });
  });
  it("resolves both element-drag endpoints from one snapshot fence during a concurrent latest update", async () => {
    const from = { index: 7, role: "AXButton", title: "From", value: null, label: null, enabled: true, focused: false, bounds: null, actions: [], locator: { kind: "ax-path" as const, path: "window[0]/AXButton[0]", role: "AXButton", subrole: null, identifier: null, title: "From" } };
    const to = { ...from, index: 9, title: "To", locator: { ...from.locator, path: "window[0]/AXButton[1]", title: "To" } };
    const record = { snapshotId: "cs_0123456789", window: { windowId: "w", windowIndex: 0, title: "w", bounds: null, minimized: false }, app, elements: { "7": from, "9": to } };
    const resolve = vi.fn().mockImplementation(async () => record);
    let input: Parameters<ComputerAdapter["drag"]>[0] | undefined;
    const dragAdapter: ComputerAdapter = { ...adapter,
      resolveLocator: async (_window, locator) => ({ element: locator.path === from.locator.path ? from : to, handle: locator.path }),
      drag: async (value) => { input = value; return { action: "drag", app: value.app, snapshotId: value.snapshotId, elementIndex: null, fromElementIndex: value.from?.element.index ?? null, toElementIndex: value.to?.element.index ?? null, performed: true, snapshotConsumed: false }; },
    };
    const store = { resolve, consume: vi.fn(async () => true), withAppFence: async (_app: typeof app, operation: () => Promise<unknown>) => operation(), getElement: (_record: typeof record, index: number) => _record.elements[String(index)] } as unknown as import("../computer/snapshot-store.js").ComputerSnapshotStore;
    expect(await runComputer(["drag", "--app", "App", "--from-element-index", "7", "--to-element-index", "9", "--json"], { adapter: dragAdapter, store, stdout: () => undefined })).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(input).toMatchObject({ snapshotId: record.snapshotId, from: { element: { index: 7 } }, to: { element: { index: 9 } } });
  });
  it("enforces snapshot → act → snapshot and re-arms after a fresh capture", async () => {
    const output: string[] = [];
    const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-"));
    const clock = { now: () => new Date(0) };
    const run = async (args: string[]) => {
      output.length = 0;
      const code = await runComputer([...args, "--json"], { adapter, projectRoot: root, clock, stdout: (text) => output.push(text) });
      return { code, envelope: JSON.parse(output[0]!) };
    };
    try {
      await run(["get-app-state", "--app", "App", "--no-screenshot"]);
      expect((await run(["click", "--app", "App", "--element-index", "7"])).envelope.result).toMatchObject({ snapshotConsumed: true });
      const stale = await run(["click", "--app", "App", "--element-index", "7"]);
      expect(stale.code).toBe(1);
      expect(stale.envelope).toMatchObject({ ok: false, error: { code: "SNAPSHOT_STALE", details: { reason: "consumed-by-action" } } });
      expect(stale.envelope.error.remediation).toContain("fn computer get-app-state");
      await run(["get-app-state", "--app", "App", "--no-screenshot"]);
      expect((await run(["click", "--app", "App", "--element-index", "7"])).code).toBe(0);
    } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
  });

  it("consumes a captured app pointer after every action form", async () => {
    const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-"));
    const clock = { now: () => new Date(0) };
    const action = (name: string, input: { app: typeof app; snapshotId?: string | null; element?: { element: { index: number } }; from?: { element: { index: number } }; to?: { element: { index: number } } }) => ({ action: name, app: input.app, snapshotId: input.snapshotId ?? null, elementIndex: input.element?.element.index ?? null, fromElementIndex: input.from?.element.index ?? null, toElementIndex: input.to?.element.index ?? null, performed: true as const, snapshotConsumed: false });
    const actions: ComputerAdapter = { ...adapter,
      click: async (input) => action("click", input), "set-value": async (input) => action("set-value", input), "type-text": async (input) => action("type-text", input), "press-key": async (input) => action("press-key", input), hotkey: async (input) => action("hotkey", input), scroll: async (input) => action("scroll", input), drag: async (input) => action("drag", input),
    };
    const cases = [
      ["click", "--app", "App", "--element-index", "7"], ["set-value", "--app", "App", "--element-index", "7", "--value", "x"],
      ["type-text", "--app", "App", "--element-index", "7", "--text", "x"], ["press-key", "--app", "App", "--element-index", "7", "--key", "enter"],
      ["scroll", "--app", "App", "--element-index", "7", "--direction", "down"], ["hotkey", "--app", "App", "--keys", "cmd+k"],
      ["drag", "--app", "App", "--from-x", "1", "--from-y", "2", "--to-x", "3", "--to-y", "4"],
      ["drag", "--app", "App", "--from-element-index", "7", "--to-element-index", "7"],
    ];
    try {
      for (const args of cases) {
        const output: string[] = [];
        await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter: actions, projectRoot: root, clock, stdout: () => undefined });
        expect(await runComputer([...args, "--json"], { adapter: actions, projectRoot: root, clock, stdout: (text) => output.push(text) })).toBe(0);
        expect(JSON.parse(output[0]!).result.snapshotConsumed).toBe(true);
        output.length = 0;
        expect(await runComputer(["click", "--app", "App", "--element-index", "7", "--json"], { adapter: actions, projectRoot: root, clock, stdout: (text) => output.push(text) })).toBe(1);
        expect(JSON.parse(output[0]!).error.details.reason).toBe("consumed-by-action");
      }
    } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
  });

  it("consumes after targetless actions but not after failed actions or reads", async () => {
    const root = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/fusion-computer-"));
    const clock = { now: () => new Date(0) };
    let failClick = true;
    const resilientAdapter: ComputerAdapter = { ...adapter,
      click: async (input) => { if (failClick) { failClick = false; throw new (await import("../computer/contract.js")).ComputerUseError("ACTION_FAILED", "failed"); } return { action: "click", app: input.app, snapshotId: input.snapshotId, elementIndex: 7, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }; },
      "type-text": async (input) => ({ action: "type-text", app: input.app, snapshotId: input.snapshotId ?? null, elementIndex: input.element?.element.index ?? null, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }),
      "press-key": async (input) => ({ action: "press-key", app: input.app, snapshotId: input.snapshotId ?? null, elementIndex: input.element?.element.index ?? null, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }),
      scroll: async (input) => ({ action: "scroll", app: input.app, snapshotId: input.snapshotId ?? null, elementIndex: input.element?.element.index ?? null, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }),
    };
    const run = (args: string[]) => runComputer([...args, "--json"], { adapter: resilientAdapter, projectRoot: root, clock, stdout: () => undefined });
    try {
      await run(["get-app-state", "--app", "App", "--no-screenshot"]);
      await run(["list-apps"]); await run(["list-windows", "--app", "App"]);
      expect(await run(["click", "--app", "App", "--element-index", "7"])).toBe(1);
      expect(await run(["click", "--app", "App", "--element-index", "7"])).toBe(0);
      for (const args of [["type-text", "--app", "App", "--text", "x"], ["press-key", "--app", "App", "--key", "enter"], ["scroll", "--app", "App", "--direction", "down"]]) {
        await run(["get-app-state", "--app", "App", "--no-screenshot"]);
        expect(await run(args)).toBe(0);
        expect(await run(["click", "--app", "App", "--element-index", "7"])).toBe(1);
      }
    } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
  });

  it("holds the command fence through consumption and makes a re-capture wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-computer-command-fence-"));
    const clock = { now: () => new Date(0) };
    let releaseAction!: () => void;
    const actionStarted = new Promise<void>((resolve) => { releaseAction = resolve; });
    let completeAction!: () => void;
    const actionComplete = new Promise<void>((resolve) => { completeAction = resolve; });
    const events: string[] = [];
    let captures = 0;
    const blockingAdapter: ComputerAdapter = { ...adapter, captureState: async (target, options) => { captures += 1; if (captures > 1) events.push("capture"); return adapter.captureState(target, options); }, click: async (input) => { releaseAction(); await actionComplete; events.push("action-consumed"); return { action: "click", app: input.app, snapshotId: input.snapshotId, elementIndex: 7, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }; } };
    try {
      await runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter: blockingAdapter, projectRoot: root, clock, stdout: () => undefined });
      const action = runComputer(["click", "--app", "App", "--element-index", "7", "--json"], { adapter: blockingAdapter, projectRoot: root, clock, stdout: () => undefined });
      await actionStarted;
      let recaptured = false;
      const recapture = runComputer(["get-app-state", "--app", "App", "--no-screenshot", "--json"], { adapter: blockingAdapter, projectRoot: root, clock, stdout: () => { recaptured = true; } });
      completeAction();
      expect(await action).toBe(0);
      expect(await recapture).toBe(0);
      expect(recaptured).toBe(true);
      expect(events).toEqual(["action-consumed", "capture"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses group-level INVALID_ARGUMENTS for unknown commands", async () => { const output: string[] = []; expect(await runComputer(["nope", "--json"], { adapter, stdout: (x) => output.push(x) })).toBe(1); expect(JSON.parse(output[0])).toMatchObject({ command: "computer", error: { code: "INVALID_ARGUMENTS" } }); });
  it("returns the required JSON envelope for a missing subcommand", async () => {
    const output: string[] = [];
    expect(await runComputer(["--json"], { adapter, stdout: (text) => output.push(text) })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, command: "computer", error: { code: "INVALID_ARGUMENTS" } });
  });
  it("validates mutually exclusive text flags before app discovery", async () => {
    const listApps = vi.fn(adapter.listApps);
    const output: string[] = [];
    expect(await runComputer(["type-text", "--app", "Missing", "--text", "a", "--text-stdin", "--json"], { adapter: { ...adapter, listApps }, stdout: (text) => output.push(text) })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    expect(listApps).not.toHaveBeenCalled();
  });
  it("falls back from an unmatched dotted bundle spelling to an exact app name", async () => {
    const dotted = { ...app, bundleId: "com.example.Other", name: "Foo.Bar" };
    const output: string[] = [];
    expect(await runComputer(["hotkey", "--app", "Foo.Bar", "--keys", "cmd+k", "--json"], { adapter: { ...adapter, listApps: async () => ({ apps: [dotted] }), hotkey: async (input) => ({ action: "hotkey", app: input.app, snapshotId: null, elementIndex: null, fromElementIndex: null, toElementIndex: null, performed: true, snapshotConsumed: false }) }, stdout: (text) => output.push(text) })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ result: { app: { name: "Foo.Bar" } } });
  });
});
