import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDED_POSTGRES_FLAGS } from "../../postgres/embedded-lifecycle.js";
import { sanitizePostgresFlags } from "../../postgres/embedded-windows-admin.js";

/*
 * FNXC:PostgresEmbedded 2026-07-16-12:45:
 * The constrained-host shared-memory default must retain its exact `-c` form
 * through the Windows cmd.exe launcher sanitizer. This is pure validation
 * coverage; it does not require an elevated process or a Windows binary.
 */
describe("sanitizePostgresFlags", () => {
  it("preserves the shared-memory default and a caller override unchanged", () => {
    const flags = [...DEFAULT_EMBEDDED_POSTGRES_FLAGS, "-c", "shared_memory_type=sysv"];

    expect(sanitizePostgresFlags(flags)).toEqual(flags);
  });
});
