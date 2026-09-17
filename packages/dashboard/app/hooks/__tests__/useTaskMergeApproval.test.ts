/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P1 remediation — the shared decision hook had no test at all.

What matters here is not that the hook calls a function, but the four rules the operator depends on:

  • each button sends ONE explicit command, and the client never supplies an identity, a destination
    or an approval object;
  • a RETRY of the same command replays the SAME `requestId`, so the server recognises the replay and
    returns its stored receipt instead of acting twice — while a DIFFERENT command always gets a
    fresh id, so no action can inherit another's identity;
  • a failed availability read presents NO decision surface: absence of proof is not permission;
  • a response for a previously selected card never publishes into the currently rendered one.
*/
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalApi = vi.hoisted(() => ({
  fetchTaskMergeApproval: vi.fn(),
  submitTaskMergeDecision: vi.fn(),
  setTaskMergeApprovalLock: vi.fn(),
}));

vi.mock("../../api/tasks/task-merge-approval.js", () => approvalApi);

import { useTaskMergeApproval } from "../useTaskMergeApproval";

const POINT = {
  enabled: true,
  available: true,
  candidateToken: "tok-1",
  capabilities: [
    { action: "create-pr" as const, enabled: true },
    { action: "merge" as const, enabled: true },
    { action: "reject" as const, enabled: true },
  ],
  revision: "2026-09-17T10:00:00Z",
};

describe("FN-514 — useTaskMergeApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(POINT);
    approvalApi.submitTaskMergeDecision.mockResolvedValue({ task: {}, action: "merge", replayed: false });
    approvalApi.setTaskMergeApprovalLock.mockResolvedValue({ task: {}, replayed: false });
  });

  it("sends each of the three commands with the server-issued candidate token and no client identity", async () => {
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.point).toEqual(POINT));

    await act(async () => { await result.current.submit("create-pr", ""); });
    await act(async () => { await result.current.submit("merge", "bon pour livraison"); });
    await act(async () => { await result.current.submit("reject", "refais la navigation"); });

    const payloads = approvalApi.submitTaskMergeDecision.mock.calls.map((call) => call[1]);
    expect(payloads.map((payload) => payload.action)).toEqual(["create-pr", "merge", "reject"]);
    // An empty positive note is simply absent; a rejection carries its mandatory instruction.
    expect(payloads[0]!.message).toBeUndefined();
    expect(payloads[1]!.message).toBe("bon pour livraison");
    expect(payloads[2]!.message).toBe("refais la navigation");
    for (const payload of payloads) {
      expect(payload.candidateToken).toBe("tok-1");
      expect(payload.expectedRevision).toBe("2026-09-17T10:00:00Z");
      // The server derives these; a client that sent them would be refused.
      expect(payload).not.toHaveProperty("decidedBy");
      expect(payload).not.toHaveProperty("deliveryAction");
      expect(payload).not.toHaveProperty("candidate");
    }
    // Three commands, three distinct identities.
    expect(new Set(payloads.map((payload) => payload.requestId)).size).toBe(3);
  });

  it("replays the SAME requestId when the same command is retried after a failure", async () => {
    approvalApi.submitTaskMergeDecision.mockRejectedValueOnce(new Error("backend unavailable"));
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.point).toEqual(POINT));

    await act(async () => { await result.current.submit("merge", "note"); });
    await waitFor(() => expect(result.current.error).toBe("backend unavailable"));

    await act(async () => { await result.current.submit("merge", "note"); });
    const [first, second] = approvalApi.submitTaskMergeDecision.mock.calls.map((call) => call[1]);
    expect(second!.requestId).toBe(first!.requestId);
  });

  it("does not reuse a spent identity for a later command of the same kind", async () => {
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.point).toEqual(POINT));

    await act(async () => { await result.current.submit("merge", ""); });
    await act(async () => { await result.current.submit("merge", ""); });

    const [first, second] = approvalApi.submitTaskMergeDecision.mock.calls.map((call) => call[1]);
    expect(second!.requestId).not.toBe(first!.requestId);
  });

  it("re-reads after a conflict so the operator sees the live situation", async () => {
    approvalApi.submitTaskMergeDecision.mockRejectedValue(new Error("This candidate was already decided"));
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.point).toEqual(POINT));
    const readsBefore = approvalApi.fetchTaskMergeApproval.mock.calls.length;

    await act(async () => { await result.current.submit("merge", ""); });

    expect(result.current.error).toBe("This candidate was already decided");
    expect(approvalApi.fetchTaskMergeApproval.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("presents no decision surface when availability cannot be read", async () => {
    approvalApi.fetchTaskMergeApproval.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.point).toBeNull();
  });

  it("never submits without a server-issued candidate token", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue({ ...POINT, available: false, candidateToken: undefined });
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.point).not.toBeNull());

    let accepted: boolean | undefined;
    await act(async () => { accepted = await result.current.submit("merge", ""); });
    expect(accepted).toBe(false);
    expect(approvalApi.submitTaskMergeDecision).not.toHaveBeenCalled();
  });

  it("does not publish a previous card's answer into the currently rendered one", async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    approvalApi.fetchTaskMergeApproval.mockImplementation(async (taskId: string) => {
      if (taskId === "FN-514") {
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return { ...POINT, candidateToken: "tok-B" };
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useTaskMergeApproval(id, "project-1"),
      { initialProps: { id: "FN-514" } },
    );

    rerender({ id: "FN-515" });
    await waitFor(() => expect(result.current.point?.candidateToken).toBe("tok-B"));

    // The first card's answer arrives late and must be discarded.
    await act(async () => { releaseFirst?.({ ...POINT, candidateToken: "tok-A" }); });
    expect(result.current.point?.candidateToken).toBe("tok-B");
  });

  it("arms and disarms the lock without ever sending an approval object", async () => {
    const { result } = renderHook(() => useTaskMergeApproval("FN-514", "project-1"));
    await waitFor(() => expect(result.current.point).toEqual(POINT));

    await act(async () => { await result.current.setLock(true); });
    const payload = approvalApi.setTaskMergeApprovalLock.mock.calls[0]![1];
    expect(payload).toMatchObject({ enabled: true, expectedRevision: "2026-09-17T10:00:00Z" });
    expect(typeof payload.requestId).toBe("string");
    expect(payload).not.toHaveProperty("decision");
  });

  it("reads nothing at all when there is no task", async () => {
    const { result } = renderHook(() => useTaskMergeApproval(undefined, "project-1"));
    await waitFor(() => expect(result.current.point).toBeNull());
    expect(approvalApi.fetchTaskMergeApproval).not.toHaveBeenCalled();
  });
});
