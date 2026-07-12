import { afterEach, describe, expect, it } from "vitest";
import { resolveSupervisorRespawnCommand, shouldSuperviseDashboard } from "../dashboard.js";

/*
FNXC:SystemPanel 2026-07-12-14:25:
Supervision must be the DEFAULT for the dashboard across install shapes (bare
`fn`/`fusion`, npx, packaged binary) so the System panel restart works out of
the box, while never nesting supervisors (FUSION_RESTART_SUPERVISED=1 set by
the supervisor itself and by scripts/dev-with-memory.mjs), never fighting an
attached debugger, and honoring the --no-supervise opt-out.
*/
describe("shouldSuperviseDashboard", () => {
  it("defaults to supervised for a plain dashboard invocation", () => {
    expect(shouldSuperviseDashboard(["dashboard"], {}, [])).toBe(true);
  });

  it("defaults to supervised for a bare invocation (no explicit command)", () => {
    expect(shouldSuperviseDashboard([], {}, [])).toBe(true);
  });

  it("is disabled by --no-supervise", () => {
    expect(shouldSuperviseDashboard(["dashboard", "--no-supervise"], {}, [])).toBe(false);
  });

  it("never nests: disabled when a supervising parent already exists", () => {
    expect(shouldSuperviseDashboard(["dashboard"], { FUSION_RESTART_SUPERVISED: "1" }, [])).toBe(false);
  });

  it("is disabled when an inspector is attached (child would fight over the port)", () => {
    expect(shouldSuperviseDashboard(["dashboard"], {}, ["--inspect=9230"])).toBe(false);
    expect(shouldSuperviseDashboard(["dashboard"], {}, ["--inspect-brk"])).toBe(false);
  });
});

describe("resolveSupervisorRespawnCommand", () => {
  const originalBun = (globalThis as { Bun?: unknown }).Bun;

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as { Bun?: unknown }).Bun;
    } else {
      (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("re-execs the node entry script with execArgv preserved outside a compiled binary", () => {
    const respawn = resolveSupervisorRespawnCommand();
    expect(respawn).not.toBeNull();
    expect(respawn!.command).toBe(process.execPath);
    // Under a plain-node/vitest run, argv[1] is the entry script and must be
    // the last respawn arg, after any loader flags from execArgv.
    expect(respawn!.args[respawn!.args.length - 1]).toBe(process.argv[1]);
    expect(respawn!.args.slice(0, -1)).toEqual(process.execArgv);
  });

  it("re-execs the compiled binary itself (no args) under a bun-compiled build", () => {
    // A bun-compiled single-file `fn` binary exposes `Bun.embeddedFiles`; argv[1]
    // is then a virtual embedded path, so the binary must re-exec process.execPath
    // alone (empty args) rather than passing a bogus entry script.
    (globalThis as { Bun?: { embeddedFiles: unknown[] } }).Bun = { embeddedFiles: [{}] };
    const respawn = resolveSupervisorRespawnCommand();
    expect(respawn).toEqual({ command: process.execPath, args: [] });
  });
});
