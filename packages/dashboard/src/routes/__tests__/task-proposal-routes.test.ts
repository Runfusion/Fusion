// @vitest-environment node

import express from "express";
import { DASHBOARD_USER_ID, type Message, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerMessagingScriptRoutes } from "../register-messaging-scripts.js";
import type { ApiRoutesContext } from "../types.js";

function proposal(status: "pending" | "creating" | "created" = "creating"): Message {
  return {
    id: "message-1", fromId: "agent-1", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user",
    content: "Proposal", type: "agent-to-user", read: false,
    metadata: {
      kind: "task-proposal", proposalStatus: status, proposalIdempotencyKey: "stable-proposal-key",
      proposedTask: { title: "Follow up", description: "Implement it" },
    },
    createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function setup() {
  const app = express();
  app.use(express.json());
  const createdTask = { id: "FN-8265", proposalClaimId: "stable-proposal-key" };
  const messageStore = {
    getMessage: vi.fn(async () => proposal()),
    reconcileProposalCreation: vi.fn(async (_id: string, taskId?: string) => ({ ...proposal("created"), metadata: { ...proposal("created").metadata, createdTaskId: taskId } })),
    claimProposalForCreation: vi.fn(), finalizeProposalCreation: vi.fn(), releaseProposalClaim: vi.fn(),
  };
  const store = {
    getRootDir: () => "/test", listTasks: vi.fn(async () => [createdTask]), getTask: vi.fn(async () => createdTask), createTask: vi.fn(),
  } as unknown as TaskStore;
  const context = {
    router: express.Router(), store,
    getProjectContext: async () => ({ store, engine: { getMessageStore: () => messageStore }, projectId: undefined }),
    rethrowAsApiError: (error: unknown): never => { throw error; }, runtimeLogger: { warn: vi.fn() }, planningLogger: {}, chatLogger: {},
  } as unknown as ApiRoutesContext;
  registerMessagingScriptRoutes(context);
  app.use("/api", context.router);
  return { app, messageStore, store };
}

describe("task proposal materialization route", () => {
  it("reconciles a creating proposal to its already-created task instead of rejecting or creating again", async () => {
    const { app, messageStore, store } = setup();
    const response = await request(app, "POST", "/api/messages/message-1/create-proposed-task");

    expect(response.status).toBe(200);
    expect(response.body.task.id).toBe("FN-8265");
    expect(messageStore.reconcileProposalCreation).toHaveBeenCalledWith("message-1", "FN-8265");
    expect(messageStore.claimProposalForCreation).not.toHaveBeenCalled();
    expect(vi.mocked(store.createTask)).not.toHaveBeenCalled();
  });

  it("leaves a creating claim untouched while its task creation may still be in flight", async () => {
    const { app, messageStore, store } = setup();
    vi.mocked(store.listTasks).mockResolvedValue([]);
    vi.mocked(messageStore.getMessage).mockResolvedValue({
      ...proposal(),
      metadata: { ...proposal().metadata, claimStartedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });

    const response = await request(app, "POST", "/api/messages/message-1/create-proposed-task");

    expect(response.status).toBe(409);
    expect(messageStore.reconcileProposalCreation).not.toHaveBeenCalled();
    expect(messageStore.claimProposalForCreation).not.toHaveBeenCalled();
    expect(vi.mocked(store.createTask)).not.toHaveBeenCalled();
  });

  it("releases an expired crashed claim without rotating its stable key, then reclaims it", async () => {
    const { app, messageStore, store } = setup();
    const stale = {
      ...proposal(),
      metadata: { ...proposal().metadata, claimStartedAt: new Date(Date.now() - 31_000).toISOString() },
      updatedAt: new Date(Date.now() - 31_000).toISOString(),
    };
    const pending = { ...stale, metadata: { ...stale.metadata, proposalStatus: "pending" as const, claimOwnerToken: undefined, claimStartedAt: undefined } };
    let current: Message = stale;
    vi.mocked(messageStore.getMessage).mockImplementation(async () => current);
    vi.mocked(messageStore.reconcileProposalCreation).mockImplementation(async (_id: string, taskId?: string) => {
      current = taskId ? { ...current, metadata: { ...current.metadata, proposalStatus: "created", createdTaskId: taskId } } : pending;
      return current;
    });
    vi.mocked(messageStore.claimProposalForCreation).mockResolvedValue({ claimed: true, idempotencyKey: "stable-proposal-key", claimOwnerToken: "new-owner" });
    vi.mocked(store.listTasks).mockResolvedValue([]);
    vi.mocked(store.createTask).mockResolvedValue({ id: "FN-8265", proposalClaimId: "stable-proposal-key" } as never);
    vi.mocked(messageStore.finalizeProposalCreation).mockResolvedValue({ ...pending, metadata: { ...pending.metadata, proposalStatus: "created", createdTaskId: "FN-8265" } });

    const response = await request(app, "POST", "/api/messages/message-1/create-proposed-task");

    expect(response.status).toBe(201);
    expect(messageStore.reconcileProposalCreation).toHaveBeenCalledWith("message-1", undefined);
    expect(messageStore.claimProposalForCreation).toHaveBeenCalledWith("message-1");
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ proposalClaimId: "stable-proposal-key" }));
  });
});
