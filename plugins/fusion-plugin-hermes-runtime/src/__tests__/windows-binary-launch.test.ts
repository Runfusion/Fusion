import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHermesLaunchCacheForTests,
  escapeWindowsShellArgument,
  escapeWindowsShellCommand,
  resolveHermesBinaryPath,
  resolveHermesLaunch,
} from "../windows-binary-launch.js";

const windows = { platform: "win32" as const, env: { PATH: "C:\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" } };

afterEach(() => __resetHermesLaunchCacheForTests());

describe("Windows Hermes launch resolution", () => {
  it("keeps POSIX launches direct and does not invoke where", async () => {
    let calls = 0;
    await expect(resolveHermesLaunch("hermes", ["chat"], {
      platform: "linux", runWhere: async () => { calls += 1; return "C:\\shims\\hermes.cmd"; },
    })).resolves.toEqual({ command: "hermes", args: ["chat"] });
    expect(calls).toBe(0);
  });

  it("selects PATHEXT-preferred candidates in the first Windows directory on a POSIX host", async () => {
    const launch = await resolveHermesLaunch("hermes", ["chat", "hi"], {
      ...windows,
      runWhere: async () => "C:\\Shims\\hermes.CMD\r\nc:\\shims\\hermes.EXE\r\nC:\\later\\hermes.COM\r\n",
    });
    expect(launch).toMatchObject({ command: "c:\\shims\\hermes.EXE", args: ["chat", "hi"], resolvedBinaryPath: "c:\\shims\\hermes.EXE" });
  });

  it("wraps cmd shims in a hardened cmd.exe payload", async () => {
    const launch = await resolveHermesLaunch("hermes.cmd", ["chat", "hi\" & calc.exe", ""], {
      ...windows,
      env: { ...windows.env, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      runWhere: async () => "C:\\Users\\A User\\hermes.cmd",
    });
    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.resolvedBinaryPath).toBe("C:\\Users\\A User\\hermes.cmd");
    expect(launch.args[3]).toContain("^&");
  });

  it("short-circuits Windows paths and preserves the Hermes resolved path", async () => {
    for (const binary of ["C:\\dir\\hermes.cmd", "\\\\server\\share\\hermes.cmd", "C:hermes", "C:/dir/hermes.exe"]) {
      const launch = await resolveHermesLaunch(binary, ["--version"], windows);
      expect(launch.resolvedBinaryPath).toBe(binary);
    }
  });

  it("escapes quote, trailing slash, and cmd metacharacter data", () => {
    expect(escapeWindowsShellCommand("C:\\A User\\hermes.cmd")).toContain("^ ");
    expect(escapeWindowsShellArgument("hi\" & | < > ^ ( ) % !\\")).toMatch(/^".*"$/);
    expect(escapeWindowsShellArgument("")).toBe('""');
  });

  it("does not cache injected where runners", async () => {
    let calls = 0;
    const deps = { ...windows, runWhere: async () => { calls += 1; return "C:\\shims\\hermes.exe"; } };
    await resolveHermesBinaryPath("hermes", deps);
    await resolveHermesBinaryPath("hermes", deps);
    expect(calls).toBe(2);
  });
});
