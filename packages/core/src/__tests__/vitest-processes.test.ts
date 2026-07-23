import { describe, expect, it, vi } from "vitest";
import type { execFile as nodeExecFile } from "node:child_process";
import { findVitestProcessIds } from "../process/vitest-processes.js";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

function makeExecFileMock(responses: { pgrep?: string; ps?: string; pgrepError?: boolean }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const impl = ((cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
    calls.push({ cmd, args });
    if (cmd === "pgrep") {
      if (responses.pgrepError) {
        cb(new Error("pgrep: no matches"), "", "");
      } else {
        cb(null, responses.pgrep ?? "", "");
      }
      return {} as never;
    }
    if (cmd === "ps") {
      cb(null, responses.ps ?? "", "");
      return {} as never;
    }
    cb(new Error(`unexpected command ${cmd}`), "", "");
    return {} as never;
  }) as unknown as typeof nodeExecFile;
  return { impl, calls };
}

describe("findVitestProcessIds", () => {
  it("returns only pids whose executable is node — wrapper shells and monitors are spared", async () => {
    const { impl, calls } = makeExecFileMock({
      // pgrep -f vitest matches the runner, two workers, a zsh wrapper whose
      // command line contains "npx vitest run", and a watch loop grepping for
      // "node (vitest".
      pgrep: "101\n102\n103\n104\n105\n",
      ps: [
        "  101 /opt/homebrew/bin/node",
        "  102 node",
        "  103 /usr/local/bin/node",
        "  104 zsh",
        "  105 /bin/zsh",
      ].join("\n"),
    });

    const pids = await findVitestProcessIds({ execFileImpl: impl });

    expect(pids).toEqual([101, 102, 103]);
    expect(calls[0]).toEqual({ cmd: "pgrep", args: ["-f", "vitest"] });
    expect(calls[1]?.cmd).toBe("ps");
    expect(calls[1]?.args).toEqual(["-o", "pid=,comm=", "-p", "101,102,103,104,105"]);
  });

  it("always excludes the calling process and any caller-supplied pids", async () => {
    const self = process.pid;
    const { impl } = makeExecFileMock({
      pgrep: `${self}\n201\n202\n`,
      ps: [`  ${self} node`, "  201 node", "  202 node"].join("\n"),
    });

    const pids = await findVitestProcessIds({ execFileImpl: impl, excludePids: [202] });

    expect(pids).toEqual([201]);
  });

  it("returns empty when pgrep finds nothing (non-zero exit)", async () => {
    const { impl, calls } = makeExecFileMock({ pgrepError: true });

    const pids = await findVitestProcessIds({ execFileImpl: impl });

    expect(pids).toEqual([]);
    // ps must not run with an empty pid list.
    expect(calls.map((c) => c.cmd)).toEqual(["pgrep"]);
  });

  it("returns empty on win32 without spawning anything", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { impl, calls } = makeExecFileMock({ pgrep: "999\n", ps: "  999 node" });
      const pids = await findVitestProcessIds({ execFileImpl: impl });
      expect(pids).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
