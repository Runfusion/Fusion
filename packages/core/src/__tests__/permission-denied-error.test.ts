import { describe, expect, it } from "vitest";

import {
  PERMISSION_DENIED_ERROR_CODE,
  PermissionDeniedError,
  isPermissionDeniedError,
} from "../task-store/errors.js";
import {
  PERMISSION_DENIED_ERROR_CODE as barrelCode,
  PermissionDeniedError as BarrelPermissionDeniedError,
  isPermissionDeniedError as barrelIsPermissionDeniedError,
} from "../index.js";

/*
FNXC:Authorization 2026-08-09-03:04:
The value of this error is entirely in its DISCRIMINANT surviving the trip out of the frame that
threw it. A permission denial crosses package boundaries (core -> engine -> dashboard) and, on the
workflow path, is flattened to a string before anyone downstream reads it. These tests pin the two
properties that make the downstream carve-outs legal: the `code` field exists and is stable, and
the guard recognises it structurally rather than by prototype identity (`instanceof` is unreliable
across duplicate module instances, which is exactly the shape a monorepo with a separate gate
barrel produces).
*/
describe("PermissionDeniedError", () => {
  it("carries the code discriminant and a human-readable message", () => {
    const error = new PermissionDeniedError("actor-7", "tasks:delete");

    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.code).toBe(PERMISSION_DENIED_ERROR_CODE);
    expect(error.name).toBe("PermissionDeniedError");
    expect(error).toBeInstanceOf(Error);
    expect(error.actorId).toBe("actor-7");
    expect(error.permission).toBe("tasks:delete");
    expect(error.message).toBe("actor-7 is not permitted to tasks:delete");
  });

  it("names the resource and reason when supplied, and degrades honestly with no actor", () => {
    expect(new PermissionDeniedError("actor-7", "tasks:delete", "FN-1234").message).toBe(
      "actor-7 is not permitted to tasks:delete on FN-1234",
    );
    expect(
      new PermissionDeniedError("actor-7", "tasks:delete", "FN-1234", "actor suspended").message,
    ).toBe("actor-7 is not permitted to tasks:delete on FN-1234 (actor suspended)");
    // An unresolved actor is denied too (R14) — the message must not read as if nobody was denied.
    expect(new PermissionDeniedError(null, "tasks:delete").message).toBe(
      "unresolved actor is not permitted to tasks:delete",
    );
  });

  /*
  FNXC:Authorization 2026-08-09-03:04:
  MEASURED, NOT ASSUMED: the discriminant does NOT survive `structuredClone`. HTML's structured
  serialization of an Error carries only name/message/stack/cause and DROPS every own property, so
  a cloned denial arrives as an ordinary Error whose only remaining evidence is its prose — the
  exact thing this typed error exists to stop callers matching on.
  This test pins that as a known boundary rather than a surprise, and it is the reason the workflow
  graph path carries the code in its own explicit `node:<id>:errorCode` context key
  (packages/engine/src/workflows/workflow-graph-executor.ts) instead of assuming the error object
  reaches the far side intact. Any future transport that must preserve a denial has to serialize
  the code EXPLICITLY; nothing does it transparently.
  */
  it("loses its discriminant through structuredClone — transports must carry the code explicitly", () => {
    const error = new PermissionDeniedError("actor-7", "tasks:delete", "FN-1234", "grant absent");

    const cloned = structuredClone(error);

    expect(cloned).toBeInstanceOf(Error);
    expect(cloned.message).toBe(error.message);
    expect((cloned as { code?: unknown }).code).toBeUndefined();
    expect(isPermissionDeniedError(cloned)).toBe(false);

    // An explicitly-carried code is recognised on the far side; that is the supported pattern.
    const carried = Object.assign(structuredClone(error), { code: PERMISSION_DENIED_ERROR_CODE });
    expect(isPermissionDeniedError(carried)).toBe(true);
  });

  it("survives a plain-object round trip when the code is serialized explicitly", () => {
    const error = new PermissionDeniedError("actor-7", "tasks:delete", "FN-1234");

    const wire = structuredClone({
      code: error.code,
      message: error.message,
      actorId: error.actorId,
      permission: error.permission,
      resource: error.resource,
    });

    expect(wire.code).toBe(PERMISSION_DENIED_ERROR_CODE);
    expect(wire.message).toBe("actor-7 is not permitted to tasks:delete on FN-1234");
    expect(wire.permission).toBe("tasks:delete");
  });

  it("is exported from the package root barrel, not just the store module", () => {
    // Engine/dashboard import from `@fusion/core`; a store-only export is unreachable for them.
    expect(BarrelPermissionDeniedError).toBe(PermissionDeniedError);
    expect(barrelIsPermissionDeniedError).toBe(isPermissionDeniedError);
    expect(barrelCode).toBe(PERMISSION_DENIED_ERROR_CODE);
  });
});

describe("isPermissionDeniedError", () => {
  it("accepts a permission denial", () => {
    expect(isPermissionDeniedError(new PermissionDeniedError("actor-7", "tasks:delete"))).toBe(true);
  });

  it("rejects a plain Error and other non-denials", () => {
    expect(isPermissionDeniedError(new Error("actor-7 is not permitted to tasks:delete"))).toBe(false);
    expect(isPermissionDeniedError(new TypeError("boom"))).toBe(false);
    expect(isPermissionDeniedError(undefined)).toBe(false);
    expect(isPermissionDeniedError(null)).toBe(false);
    expect(isPermissionDeniedError("PERMISSION_DENIED")).toBe(false);
    // A bare object wearing the code is NOT an Error — the guard narrows to Error deliberately.
    expect(isPermissionDeniedError({ code: "PERMISSION_DENIED" })).toBe(false);
  });

  it("matches on the code discriminant rather than prototype identity", () => {
    /*
    Simulates the duplicate-module-instance case: an error produced by a SECOND copy of this class
    (a separately-bundled @fusion/core) fails `instanceof` against our copy but must still be
    recognised, because that is the case a cross-package guard exists for.
    */
    class ForeignPermissionDeniedError extends Error {
      readonly code = "PERMISSION_DENIED" as const;
    }
    const foreign = new ForeignPermissionDeniedError("denied elsewhere");

    expect(foreign instanceof PermissionDeniedError).toBe(false);
    expect(isPermissionDeniedError(foreign)).toBe(true);
  });
});
