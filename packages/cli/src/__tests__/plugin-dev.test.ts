import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const pluginCommandMocks = vi.hoisted(() => {
  const store = {
    registerPlugin: vi.fn(async () => ({ id: "fusion-plugin-dev-test", enabled: true })),
  };
  const loader = {
    loadPlugin: vi.fn(async () => undefined),
    reloadPlugin: vi.fn(async () => undefined),
    stopPlugin: vi.fn(async () => undefined),
  };

  return {
    store,
    loader,
    createPluginStore: makeConstructibleMock(async () => store),
    createPluginLoader: makeConstructibleMock(async () => ({ store, loader })),
    resolvePluginEntryFile: vi.fn(async (dir: string) => join(dir, "dist", "index.js")),
    loadManifestFromPath: vi.fn(async () => ({
      manifest: {
        id: "fusion-plugin-dev-test",
        name: "Dev Test",
        version: "0.1.0",
      },
      path: "/tmp/fusion-plugin-dev-test",
    })),
  };
});

vi.mock("../commands/plugin.js", () => ({
  createPluginStore: pluginCommandMocks.createPluginStore,
  createPluginLoader: pluginCommandMocks.createPluginLoader,
  resolvePluginEntryFile: pluginCommandMocks.resolvePluginEntryFile,
  loadManifestFromPath: pluginCommandMocks.loadManifestFromPath,
}));

const { runPluginDev } = await import("../commands/plugin-dev.js");

describe("runPluginDev", () => {
  let tmpBase: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpBase = join(tmpdir(), `fn-plugin-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpBase, { recursive: true });
    mkdirSync(join(tmpBase, "dist"), { recursive: true });
    writeFileSync(join(tmpBase, "dist", "index.js"), "export default {};\n");

    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("builds before installing and loads the plugin in once mode", async () => {
    const buildFn = vi.fn(async () => undefined);
    const watchFn = vi.fn(() => ({ close: vi.fn() }));

    await runPluginDev(tmpBase, { once: true, buildFn, watchFn });

    expect(buildFn).toHaveBeenCalledOnce();
    expect(buildFn).toHaveBeenCalledWith(tmpBase);
    expect(pluginCommandMocks.resolvePluginEntryFile).toHaveBeenCalledWith(tmpBase);
    expect(pluginCommandMocks.loadManifestFromPath).toHaveBeenCalledWith(tmpBase);
    expect(pluginCommandMocks.store.registerPlugin).toHaveBeenCalledWith({
      manifest: {
        id: "fusion-plugin-dev-test",
        name: "Dev Test",
        version: "0.1.0",
      },
      path: join(tmpBase, "dist", "index.js"),
      aiScanOnLoad: false,
    });
    expect(pluginCommandMocks.loader.loadPlugin).toHaveBeenCalledWith("fusion-plugin-dev-test");
    expect(pluginCommandMocks.loader.stopPlugin).toHaveBeenCalledWith("fusion-plugin-dev-test");
    expect(watchFn).not.toHaveBeenCalled();
  });

  it("rebuilds and reloads on a watched source change", async () => {
    vi.useFakeTimers();
    exitSpy.mockImplementation((() => undefined) as typeof process.exit);
    const buildFn = vi.fn(async () => undefined);
    const close = vi.fn();
    let onChange: (() => void) | undefined;
    const watchFn = vi.fn((_dir: string, callback: () => void) => {
      onChange = callback;
      return { close };
    });

    const devPromise = runPluginDev(tmpBase, { buildFn, watchFn });

    await vi.waitFor(() => expect(watchFn).toHaveBeenCalledWith(tmpBase, expect.any(Function)));
    expect(onChange).toBeDefined();

    onChange?.();
    await vi.advanceTimersByTimeAsync(121);
    await vi.waitFor(() => expect(pluginCommandMocks.loader.reloadPlugin).toHaveBeenCalledTimes(1));
    expect(buildFn).toHaveBeenCalledTimes(2);
    expect(pluginCommandMocks.loader.reloadPlugin).toHaveBeenCalledWith("fusion-plugin-dev-test");

    process.emit("SIGINT", "SIGINT");
    await devPromise;
    expect(close).toHaveBeenCalledOnce();
    expect(pluginCommandMocks.loader.stopPlugin).toHaveBeenCalledWith("fusion-plugin-dev-test");
  });

  it("exits non-zero when the plugin path is missing", async () => {
    const missingPath = join(tmpBase, "missing");
    expect(existsSync(missingPath)).toBe(false);

    await expect(runPluginDev(missingPath, { once: true, buildFn: vi.fn() })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(`Plugin path does not exist: ${missingPath}`);
  });

  it("exits non-zero when manifest loading fails", async () => {
    pluginCommandMocks.loadManifestFromPath.mockRejectedValueOnce(new Error("Plugin manifest not found"));

    await expect(runPluginDev(tmpBase, { once: true, buildFn: vi.fn(async () => undefined) })).rejects.toThrow(
      "process.exit:1",
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Plugin manifest not found"));
  });
});
