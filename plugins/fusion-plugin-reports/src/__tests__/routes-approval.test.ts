import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/core";
import type { Report } from "../store/report-types.js";
import { createReportApprovalRoutes } from "../routes/report-approval-routes.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "rep_1",
    cadence: "daily",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-01",
    title: "Report",
    status: "review_complete",
    generationStartedAt: "2026-05-01T00:00:00.000Z",
    generationCompletedAt: null,
    reviewStartedAt: null,
    reviewCompletedAt: null,
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    archivedAt: null,
    failureReason: null,
    approvalState: "awaiting_approval",
    approvalHistory: [],
    draftMarkdown: null,
    renderedHtmlPath: null,
    renderedHtml: null,
    renderedHtmlGeneratedAt: null,
    metadata: {},
    combinedReview: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctxWithStore(store: { getReportAsync: (id: string) => Promise<Report | null>; updateReportAsync: (id: string, patch: Partial<Report>) => Promise<Report> }, settings: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "fusion-plugin-reports",
    taskStore: { getDatabase: () => ({}), getReportStore: () => store } as any,
    settings,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
  } as PluginContext;
}

function route(path: string, method: string) {
  return createReportApprovalRoutes().find((entry) => entry.path === path && entry.method === method)!;
}

describe("report approval routes", () => {
  it("approve then publish happy path", async () => {
    let current = makeReport({ approvalState: "awaiting_approval" });
    const store = {
      getReportAsync: vi.fn(async () => current),
      updateReportAsync: vi.fn(async (_id: string, patch: Partial<Report>) => {
        current = { ...current, ...patch };
        return current;
      }),
    };
    const ctx = ctxWithStore(store, { approvalRequired: true, autoPublishOnApproval: false, approverAgentIds: ["agent-1"] });

    const approve = await route("/reports/:id/approve", "POST").handler({ params: { id: "rep_1" }, headers: { "x-fusion-actor-type": "agent", "x-fusion-user": "agent-1" } }, ctx as any) as any;
    expect(approve.status).toBe(200);
    expect(approve.body.report.approvalState).toBe("approved");

    const publish = await route("/reports/:id/publish", "POST").handler({ params: { id: "rep_1" }, headers: { "x-fusion-actor-type": "agent", "x-fusion-user": "agent-1" } }, ctx as any) as any;
    expect(publish.status).toBe(200);
    expect(publish.body.report.approvalState).toBe("published");
  });

  it("supports reject path", async () => {
    const store = {
      getReportAsync: vi.fn(async () => makeReport()),
      updateReportAsync: vi.fn(async (_id: string, patch: Partial<Report>) => ({ ...makeReport(), ...patch })),
    };
    const ctx = ctxWithStore(store, { approvalRequired: true, autoPublishOnApproval: false, approverAgentIds: ["agent-1"] });
    const reject = await route("/reports/:id/reject", "POST").handler({ params: { id: "rep_1" }, headers: { "x-fusion-actor-type": "agent", "x-fusion-user": "agent-1" } }, ctx as any) as any;
    expect(reject.status).toBe(200);
    expect(reject.body.report.approvalState).toBe("rejected");
  });

  it("returns 403 for unauthorized approver", async () => {
    const store = {
      getReportAsync: vi.fn(async () => makeReport()),
      updateReportAsync: vi.fn(),
    };
    const ctx = ctxWithStore(store, { approvalRequired: true, autoPublishOnApproval: false, approverAgentIds: ["agent-1"] });
    const res = await route("/reports/:id/approve", "POST").handler({ params: { id: "rep_1" }, headers: { "x-fusion-actor-type": "agent", "x-fusion-user": "agent-2" } }, ctx as any) as any;
    expect(res.status).toBe(403);
  });

  it("share-blocks returns 409 before approval and 200 after", async () => {
    const current = makeReport({ approvalState: "awaiting_approval", combinedReview: { overallVerdict: "approve", consensusSummary: "ok", mergedHighlights: ["a"], mergedLowlights: [], mergedSuggestions: [], individual: [], failures: [] } });
    const store = {
      getReportAsync: vi.fn(async () => current),
      updateReportAsync: vi.fn(),
    };
    const ctx = ctxWithStore(store);
    const locked = await route("/reports/:id/share-blocks", "GET").handler({ params: { id: "rep_1" } }, ctx as any) as any;
    expect(locked.status).toBe(409);

    const openStore = { ...store, getReportAsync: vi.fn(async () => ({ ...current, approvalState: "approved" as const })) };
    const openCtx = ctxWithStore(openStore);
    const open = await route("/reports/:id/share-blocks", "GET").handler({ params: { id: "rep_1" } }, openCtx as any) as any;
    expect(open.status).toBe(200);
    expect(open.body).toHaveProperty("plainText");
  });
});
