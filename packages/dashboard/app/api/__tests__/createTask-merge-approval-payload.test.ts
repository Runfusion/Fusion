/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P1 remediation — the creation payload had no test.

`createTask` explicitly enumerates the fields it forwards, so a new flag that is accepted by the
composer but omitted from that list is silently dropped: the operator arms the lock, the card is
created without it, and nothing anywhere reports a problem. These assert the SERIALIZED body the
transport actually sends, and the boundary that matters most: a composer may arm the requirement, but
it can never create a decision, a destination or an approval object.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyApi = vi.hoisted(() => vi.fn());

vi.mock("../client/client.js", () => ({ proxyApi }));
vi.mock("../client/health.js", () => ({ withProjectId: (path: string) => path }));

import { createTask } from "../tasks/tasks";

function sentBody(): Record<string, unknown> {
  const init = proxyApi.mock.calls.at(-1)?.[1] as { body: string } | undefined;
  return JSON.parse(init!.body) as Record<string, unknown>;
}

describe("FN-514 — the delivery lock reaches the server at creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyApi.mockResolvedValue({ id: "FN-900" });
  });

  it("forwards the armed flag", async () => {
    await createTask({ description: "verrouillée", humanMergeApproval: true } as never);
    expect(sentBody().humanMergeApproval).toBe(true);
  });

  it("leaves an ordinary creation unlocked — the default is automatic delivery", async () => {
    await createTask({ description: "ordinaire" } as never);
    expect(sentBody().humanMergeApproval).toBeUndefined();
  });

  it("keeps the delivery lock independent of the plan approval lock", async () => {
    await createTask({ description: "plan seul", humanPlanApproval: true } as never);
    expect(sentBody()).toMatchObject({ humanPlanApproval: true });
    expect(sentBody().humanMergeApproval).toBeUndefined();

    await createTask({ description: "livraison seule", humanMergeApproval: true } as never);
    expect(sentBody()).toMatchObject({ humanMergeApproval: true });
    expect(sentBody().humanPlanApproval).toBeUndefined();

    await createTask({ description: "les deux", humanPlanApproval: true, humanMergeApproval: true } as never);
    expect(sentBody()).toMatchObject({ humanPlanApproval: true, humanMergeApproval: true });
  });

  it("stays independent of Fast mode and of an explicit auto-merge override", async () => {
    await createTask({
      description: "rapide et verrouillée",
      executionMode: "fast",
      autoMerge: false,
      humanMergeApproval: true,
    } as never);
    expect(sentBody()).toMatchObject({ executionMode: "fast", autoMerge: false, humanMergeApproval: true });
  });

  it("never lets a composer create a decision, a destination or an approval object", async () => {
    await createTask({
      description: "tentative",
      humanMergeApproval: true,
      // A caller that believes in these fields must not be able to smuggle them through creation.
      deliveryAction: "merge",
      decidedBy: "someone",
      humanMergeApprovalDecision: { action: "merge" },
    } as never);
    const body = sentBody();
    expect(body.humanMergeApproval).toBe(true);
    expect(body).not.toHaveProperty("deliveryAction");
    expect(body).not.toHaveProperty("decidedBy");
    expect(body).not.toHaveProperty("humanMergeApprovalDecision");
  });
});
