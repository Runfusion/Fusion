// U5 — provider integration of the permission floor + cancel-drain.
//
// Exercises `createBridgingClientHandler(callbacks, gate)`: its
// `requestPermission` delegates to the per-category resolver, and `cancelPending`
// drains in-flight requests so the agent never deadlocks on teardown (KTD4a).

import { describe, it, expect } from "vitest";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { createBridgingClientHandler } from "../provider.js";
import type { GateDisposition, PermissionGate } from "../types.js";

const ALL_OPTIONS: PermissionOption[] = [
  { optionId: "allow_once_id", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always_id", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once_id", name: "Reject once", kind: "reject_once" },
  { optionId: "reject_always_id", name: "Reject always", kind: "reject_always" },
];

function req(kind: ToolKind | undefined, id = "tc-1"): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: id, kind } as RequestPermissionRequest["toolCall"],
    options: ALL_OPTIONS,
  };
}

const UNRESTRICTED: Record<string, GateDisposition> = {
  git_write: "allow",
  file_write_delete: "allow",
  command_execution: "allow",
  network_api: "allow",
  task_agent_mutation: "allow",
};

function gate(rules: Record<string, GateDisposition>): PermissionGate {
  return { permissionPolicy: { rules } };
}

function selectedId(res: RequestPermissionResponse): string | undefined {
  return res.outcome.outcome === "selected" ? res.outcome.optionId : undefined;
}

describe("createBridgingClientHandler — requestPermission delegates to the gate", () => {
  it("answers allow_once for an allow category (risk acknowledged)", async () => {
    const { handler } = createBridgingClientHandler(
      {},
      gate({ ...UNRESTRICTED, command_execution: "allow" }),
      undefined,
      { allowUnrestricted: true },
    );
    const res = await handler.requestPermission(req("execute"));
    expect(selectedId(res)).toBe("allow_once_id");
  });

  it("escalates a sensitive allow to deny without the unrestricted acknowledgement (S1)", async () => {
    const { handler } = createBridgingClientHandler(
      {},
      gate({ ...UNRESTRICTED, command_execution: "allow" }),
    );
    const res = await handler.requestPermission(req("execute"));
    expect(selectedId(res)).toBe("reject_once_id");
  });

  it("default-denies (reject_once) when no gate is supplied", async () => {
    const { handler } = createBridgingClientHandler({});
    const res = await handler.requestPermission(req("read"));
    expect(selectedId(res)).toBe("reject_once_id");
  });

  it("honors a per-category block under an otherwise-unrestricted policy", async () => {
    const { handler } = createBridgingClientHandler({}, gate({ ...UNRESTRICTED, command_execution: "block" }));
    const res = await handler.requestPermission(req("execute"));
    expect(selectedId(res)).toBe("reject_once_id");
  });
});

describe("cancel drain (KTD4a — no permission deadlock)", () => {
  it("resolves two in-flight permission requests as cancelled and answers later requests cancelled immediately", async () => {
    // A require-approval category with a pause that NEVER resolves on its own —
    // the only way these complete is the cancel drain.
    let pauseCount = 0;
    const blockingGate: PermissionGate = {
      permissionPolicy: { rules: { ...UNRESTRICTED, command_execution: "require-approval" } },
      createApprovalRequest: async () => ({ id: "appr" }),
      findApprovalByDedupeKey: async () => null,
      pauseForApproval: () =>
        new Promise<void>(() => {
          pauseCount += 1;
          /* never resolves */
        }),
    };

    const { handler, cancelPending } = createBridgingClientHandler({}, blockingGate);

    const p1 = handler.requestPermission(req("execute", "tc-1"));
    const p2 = handler.requestPermission(req("execute", "tc-2"));

    // Let both reach the blocking pause.
    await Promise.resolve();
    await Promise.resolve();
    expect(pauseCount).toBe(2);

    cancelPending();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.outcome.outcome).toBe("cancelled");
    expect(r2.outcome.outcome).toBe("cancelled");

    // A request arriving AFTER cancel is answered cancelled immediately.
    const r3 = await handler.requestPermission(req("execute", "tc-3"));
    expect(r3.outcome.outcome).toBe("cancelled");
  });

  it("cancelPending is idempotent", async () => {
    const { handler, cancelPending } = createBridgingClientHandler(
      {},
      gate({ ...UNRESTRICTED, command_execution: "allow" }),
    );
    cancelPending();
    cancelPending();
    const res = await handler.requestPermission(req("execute"));
    expect(res.outcome.outcome).toBe("cancelled");
  });
});
