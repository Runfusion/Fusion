import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDED_POSTGRES_FLAGS } from "../../postgres/embedded-lifecycle.js";
import {
  buildPgCtlOptionsString,
  buildPgCtlStartArgs,
  sanitizePostgresFlags,
} from "../../postgres/embedded-windows-elevated.js";

/*
 * FNXC:PostgresEmbedded 2026-07-16-12:45 (retained):
 * The constrained-host shared-memory default must retain its exact `-c` form
 * through the elevated launcher sanitizer. Pure validation coverage; no
 * elevated process or Windows binary required.
 */
describe("sanitizePostgresFlags", () => {
  it("preserves the shared-memory default and a caller override unchanged", () => {
    const flags = [...DEFAULT_EMBEDDED_POSTGRES_FLAGS, "-c", "shared_memory_type=sysv"];

    expect(sanitizePostgresFlags(flags)).toEqual(flags);
  });

  it("rejects flags with quoting-sensitive characters", () => {
    expect(() => sanitizePostgresFlags(['-c "evil"'])).toThrow(/quoting-sensitive/);
    expect(() => sanitizePostgresFlags([""])).toThrow(/invalid postgresFlags/);
  });
});

/*
 * FNXC:WindowsDesktopPackaging 2026-07-17-22:30:
 * The elevated path must boot postgres via pg_ctl's restricted-token re-exec —
 * NOT via a created local user account (operator complaint: Fusion created a
 * 'fusion-pg' account) and NOT via Start-Process -Credential (which failed on
 * end-user boxes with "The directory name is invalid" and held wrapper logs
 * open, causing EBUSY). These assertions pin the pg_ctl invariants: no-wait
 * launch, per-launch log file, port + flags carried in the -o option string.
 */
describe("pg_ctl elevated launch composition", () => {
  it("carries the port and sanitized flags in the -o option string", () => {
    expect(buildPgCtlOptionsString(55499, ["-c", "shared_memory_type=sysv"])).toBe(
      "-p 55499 -c shared_memory_type=sysv",
    );
  });

  it("double-quotes option tokens containing spaces", () => {
    expect(buildPgCtlOptionsString(5432, ["-c", "work_mem=64 MB"])).toBe(
      '-p 5432 -c "work_mem=64 MB"',
    );
  });

  it("builds a no-wait start with a dedicated log file", () => {
    const args = buildPgCtlStartArgs("C:\\data", "C:\\data\\.pgrunner\\pgctl-1.log", "-p 5432");

    expect(args).toEqual([
      "-D",
      "C:\\data",
      "-o",
      "-p 5432",
      "-l",
      "C:\\data\\.pgrunner\\pgctl-1.log",
      "-W",
      "start",
    ]);
  });
});
