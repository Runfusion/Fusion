import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("node:child_process");
  vi.unmock("node:fs");
  vi.unmock("node:os");
});

function createSpawnMock(options: {
  lookupPath: string;
  lookupCommand: "which" | "where";
  versionStdout?: string;
  versionExitCode?: number;
}) {
  return vi.fn((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    queueMicrotask(() => {
      if (command === options.lookupCommand) {
        child.stdout.emit("data", Buffer.from(`${options.lookupPath}\n`));
        child.emit("close", 0);
        return;
      }

      if (args.includes("--version")) {
        if (options.versionStdout) {
          child.stdout.emit("data", Buffer.from(options.versionStdout));
        }
        child.emit("close", options.versionExitCode ?? 0);
        return;
      }

      child.emit("close", 1);
    });

    return child;
  });
}

async function importWithMocks(options: {
  lookupPath: string;
  realPath: string;
  platform?: "darwin" | "linux" | "win32";
  packageJsons?: Record<string, { name: string; version: string }>;
  scriptContents?: Record<string, string>;
  versionStdout?: string;
  versionExitCode?: number;
}) {
  const lookupCommand = options.platform === "win32" ? "where" : "which";
  const spawnMock = createSpawnMock({
    lookupPath: options.lookupPath,
    lookupCommand,
    versionStdout: options.versionStdout,
    versionExitCode: options.versionExitCode,
  });

  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      platform: () => options.platform ?? "darwin",
    };
  });
  const readFileSyncMock = vi.fn((path: string) => {
    const manifest = options.packageJsons?.[String(path)];
    if (manifest) {
      return JSON.stringify(manifest);
    }

    const script = options.scriptContents?.[String(path)];
    if (script !== undefined) {
      return script;
    }

    throw new Error(`Unexpected readFileSync(${path})`);
  });

  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      realpathSync: vi.fn(() => options.realPath),
      existsSync: vi.fn((path: string) => !!options.packageJsons?.[String(path)]),
      /*
      FNXC:FnBinaryProbe 2026-07-15-10:05:
      resolveShimTargets now stats the resolved path and refuses multi‑MB native binaries.
      Tests must report small sizes for text shims so package-target extraction still runs.
      */
      statSync: vi.fn((path: string) => {
        const key = String(path);
        const script = options.scriptContents?.[key];
        if (script !== undefined) {
          return { isFile: () => true, size: Buffer.byteLength(script, "utf-8") };
        }
        if (options.packageJsons?.[key]) {
          return { isFile: () => true, size: 128 };
        }
        // Default: small path so non-shim probes still walk package parents without binary thrash.
        return { isFile: () => true, size: 256 };
      }),
      readFileSync: readFileSyncMock,
    };
  });

  const mod = await import("../fn-binary.js");
  return { mod, spawnMock, readFileSyncMock };
}

describe("detectFnBinary", () => {
  it("reads the installed version from the resolved package manifest without executing fn --version", async () => {
    const lookupPath = "/opt/homebrew/bin/fn";
    const realPath = "/opt/homebrew/lib/node_modules/runfusion.ai/index.js";
    const packageJsonPath = "/opt/homebrew/lib/node_modules/runfusion.ai/package.json";
    const { mod, spawnMock } = await importWithMocks({
      lookupPath,
      realPath,
      packageJsons: {
        [packageJsonPath]: {
          name: "runfusion.ai",
          version: "0.13.0",
        },
      },
    });

    const result = await mod.detectFnBinary();

    expect(result).toMatchObject({
      installed: true,
      binary: "fn",
      path: lookupPath,
      version: "0.13.0",
      invocation: "fn",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("which", ["fn"], expect.any(Object));
  });

  it("does not parse a JavaScript entrypoint when its realpath has the package manifest", async () => {
    const lookupPath = "/opt/homebrew/bin/fn";
    const realPath = "/opt/homebrew/lib/node_modules/runfusion.ai/index.js";
    const packageJsonPath = "/opt/homebrew/lib/node_modules/runfusion.ai/package.json";
    const { mod, readFileSyncMock } = await importWithMocks({
      lookupPath,
      realPath,
      packageJsons: {
        [packageJsonPath]: { name: "runfusion.ai", version: "0.60.0" },
      },
      scriptContents: {
        [lookupPath]: "entrypoint text that must not be parsed as an npm shim",
      },
    });

    await expect(mod.detectFnBinary()).resolves.toMatchObject({ version: "0.60.0" });
    expect(readFileSyncMock).not.toHaveBeenCalledWith(lookupPath, "utf-8");
  });

  it("resolves the installed version from an npm-generated Windows cmd shim without executing fn --version", async () => {
    const lookupPath = "C:\\Users\\test\\AppData\\Roaming\\npm\\fn.cmd";
    const packageJsonPath = "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\runfusion.ai\\package.json";
    const { mod, spawnMock } = await importWithMocks({
      lookupPath,
      realPath: lookupPath,
      platform: "win32",
      packageJsons: {
        [packageJsonPath]: {
          name: "runfusion.ai",
          version: "0.14.2",
        },
      },
      scriptContents: {
        [lookupPath]: "\"%~dp0\\node_modules\\runfusion.ai\\index.js\" %*",
      },
    });

    const result = await mod.detectFnBinary();

    expect(result.version).toBe("0.14.2");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("where", ["fn"], expect.any(Object));
  });

  it("resolves the installed version from an npm-generated Windows PowerShell shim without executing fn --version", async () => {
    const lookupPath = "C:\\Users\\test\\AppData\\Roaming\\npm\\fn.ps1";
    const packageJsonPath = "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\runfusion.ai\\package.json";
    const { mod, spawnMock } = await importWithMocks({
      lookupPath,
      realPath: lookupPath,
      platform: "win32",
      packageJsons: {
        [packageJsonPath]: {
          name: "runfusion.ai",
          version: "0.14.3",
        },
      },
      scriptContents: {
        [lookupPath]: "& \"$basedir\\node_modules\\runfusion.ai\\index.js\" $args",
      },
    });

    const result = await mod.detectFnBinary();

    expect(result.version).toBe("0.14.3");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("where", ["fn"], expect.any(Object));
  });

  it("falls back to fn --version when no package manifest can be derived from the resolved path", async () => {
    const lookupPath = "/usr/local/bin/fn";
    const { mod, spawnMock } = await importWithMocks({
      lookupPath,
      realPath: lookupPath,
      versionStdout: "fn v0.15.0\n",
    });

    const result = await mod.detectFnBinary();

    expect(result.version).toBe("0.15.0");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(1, "which", ["fn"], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(2, "fn", ["--version"], expect.any(Object));
  });

  it("does not read multi-MB native binaries when resolving shim package targets", async () => {
    /*
    FNXC:FnBinaryProbe 2026-07-15-10:05:
    Host installs can place an 80MB+ Mach-O at the resolved path. Reading and
    regex-scanning that file hung detectFnBinary (~77s) and failed the default
    core suite under vitest's 15s testTimeout. Assert we never readFileSync a
    large non-shim binary during version resolution.
    */
    const lookupPath = "/Users/test/.local/bin/fn";
    const realPath = "/Users/test/.local/share/fusion/fn";
    const readFileSync = vi.fn((path: string) => {
      throw new Error(`Unexpected readFileSync(${path}) on native binary`);
    });
    const statSync = vi.fn((path: string) => {
      if (String(path) === realPath || String(path) === lookupPath) {
        return { isFile: () => true, size: 81 * 1024 * 1024 };
      }
      return { isFile: () => false, size: 0 };
    });
    const existsSync = vi.fn(() => false);
    const realpathSync = vi.fn(() => realPath);
    const lookupCommand = "which" as const;
    const spawnMock = createSpawnMock({
      lookupPath,
      lookupCommand,
      versionStdout: "fn v0.60.0\n",
    });

    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "darwin" as const };
    });
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        realpathSync,
        existsSync,
        readFileSync,
        statSync,
      };
    });

    const mod = await import("../fn-binary.js");
    const result = await mod.detectFnBinary();

    expect(result).toMatchObject({
      installed: true,
      binary: "fn",
      path: lookupPath,
      version: "0.60.0",
      invocation: "fn",
    });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith("fn", ["--version"], expect.any(Object));
  });
});
