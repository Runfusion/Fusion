import { describe, expect, it } from "vitest";
import { decoratePgProvisioningError } from "../__test-utils__/pg-provisioning-diagnostics.js";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("decoratePgProvisioningError", () => {
  it.each([
    [pgError("58P01", 'could not access file "$libdir/plpgsql"'), "pnpm pg:test:up -- --replace"],
    [pgError("28000", 'role "node" does not exist'), "pnpm pg:test:up"],
    [pgError("3D000", 'database "node" does not exist'), "role name"],
    [pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"), "pnpm pg:test:up"],
  ])("decorates supported PostgreSQL failures", (error, expected) => {
    const decorated = decoratePgProvisioningError(error, "postgresql://localhost:5432");
    expect(decorated).toBeInstanceOf(Error);
    expect(decorated).not.toBe(error);
    expect((decorated as Error).message).toContain(error.message);
    expect((decorated as Error).message).toContain(expected);
  });

  it("preserves unrelated and non-Error throwables by identity", () => {
    const ordinary = new Error("ordinary failure");
    const nonError = { code: "28000" };
    const unrelatedPg = pgError("58P01", "some other library is missing");
    expect(decoratePgProvisioningError(ordinary, "postgresql://localhost:5432")).toBe(ordinary);
    expect(decoratePgProvisioningError(nonError, "postgresql://localhost:5432")).toBe(nonError);
    expect(decoratePgProvisioningError(unrelatedPg, "postgresql://localhost:5432")).toBe(unrelatedPg);
  });
});
