import { afterEach, describe, expect, it } from "vitest";
import { classifyDashboardFatalExit, hasLiveSupervisingParent, resolveSupervisorRespawnCommand, shouldSuperviseDashboard } from "../dashboard.js";
import { FUSION_NON_RETRYABLE_EXIT_CODE } from "@fusion/core";

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

  /*
  FNXC:SystemPanel 2026-07-25-10:05:
  FUSION_RESTART_SUPERVISED is inherited by every process the dashboard spawns
  (agent terminals, dev servers). Running `fn dashboard` from one of those must
  still start a real supervisor — otherwise the new dashboard advertises restart
  support it does not have and a restart request kills it for good. The pid stamp
  distinguishes a real parent from an inherited copy.
  */
  it("never nests under the real supervising parent (pid matches)", () => {
    expect(
      shouldSuperviseDashboard(["dashboard"], { FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "4242" }, [], 4242),
    ).toBe(false);
  });

  it("supervises itself when the supervised flag was merely inherited from a non-parent", () => {
    expect(
      shouldSuperviseDashboard(["dashboard"], { FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "4242" }, [], 99),
    ).toBe(true);
  });
});

describe("hasLiveSupervisingParent", () => {
  it("requires the supervised flag", () => {
    expect(hasLiveSupervisingParent({}, 1)).toBe(false);
  });

  it("accepts a parent that predates the pid stamp (legacy dev wrapper)", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1" }, 1)).toBe(true);
  });

  it("accepts the stamped supervisor when it is our actual parent", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "77" }, 77)).toBe(true);
  });

  it("rejects a stamped pid that is not our parent (leaked env / dead supervisor)", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "77" }, 1)).toBe(false);
  });

  it("rejects an unparseable pid stamp", () => {
    expect(hasLiveSupervisingParent({ FUSION_RESTART_SUPERVISED: "1", FUSION_SUPERVISOR_PID: "nope" }, 1)).toBe(false);
  });

  it("is disabled when an inspector is attached (child would fight over the port)", () => {
    expect(shouldSuperviseDashboard(["dashboard"], {}, ["--inspect=9230"])).toBe(false);
    expect(shouldSuperviseDashboard(["dashboard"], {}, ["--inspect-brk"])).toBe(false);
  });
});

describe("classifyDashboardFatalExit", () => {
  it("stops unique-constraint failures without consuming restart attempts", () => {
    expect(classifyDashboardFatalExit({ cause: { code: "23505" } })).toEqual({
      exitCode: FUSION_NON_RETRYABLE_EXIT_CODE,
      nonRetryable: true,
    });
  });

  it("leaves ordinary startup failures retryable", () => {
    expect(classifyDashboardFatalExit(new Error("port unavailable"))).toEqual({ exitCode: 1, nonRetryable: false });
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
