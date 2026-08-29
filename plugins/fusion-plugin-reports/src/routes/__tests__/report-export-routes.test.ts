import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/core";
import type { Report } from "../../store/report-types.js";
import { createReportExportRoutes } from "../report-export-routes.js";

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: "rep_1",
    cadence: "daily",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-02",
    title: "Demo",
    status: "review_complete",
    generationStartedAt: "2026-05-02T00:00:00.000Z",
    generationCompletedAt: "2026-05-02T00:01:00.000Z",
    reviewStartedAt: null,
    reviewCompletedAt: null,
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    archivedAt: null,
    failureReason: null,
    approvalState: "not_required",
    approvalHistory: [],
    draftMarkdown: null,
    renderedHtmlPath: null,
    renderedHtml: null,
    renderedHtmlGeneratedAt: null,
    metadata: {},
    combinedReview: null,
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:01:00.000Z",
    ...overrides,
  };
}

function ctxWithStore(store: { getReportAsync: (id: string) => Promise<Report | null>; setRenderedHtmlAsync: (id: string, html: string) => Promise<unknown> }): PluginContext {
  return {
    pluginId: "fusion-plugin-reports",
    taskStore: { getDatabase: () => ({}), getReportStore: () => store } as any,
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    createAiSession: undefined,
    resolveProjectTaskStore: undefined,
    ...({} as any),
  } as PluginContext;
}

describe("report export routes", () => {
  it("returns export html with attachment header", async () => {
    const routes = createReportExportRoutes();
    const route = routes.find((r) => r.path.endsWith("export.html"))!;
    const record = report();
    const getReportAsync = vi.fn().mockResolvedValue(record);
    const setRenderedHtmlAsync = vi.fn().mockResolvedValue(undefined);
    const ctx = ctxWithStore({ getReportAsync, setRenderedHtmlAsync });
    const res = await route.handler({ params: { id: "rep_1" } }, ctx as any) as any;
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.headers["Content-Disposition"]).toContain("attachment;");
  });

  it("returns 404 for missing id", async () => {
    const route = createReportExportRoutes().find((r) => r.path.endsWith("export.html"))!;
    const ctx = ctxWithStore({ getReportAsync: vi.fn().mockResolvedValue(null), setRenderedHtmlAsync: vi.fn().mockResolvedValue(undefined) });
    const res = await route.handler({ params: { id: "missing" } }, ctx as any) as any;
    expect(res.status).toBe(404);
  });

  it("returns 409 for generating report", async () => {
    const route = createReportExportRoutes().find((r) => r.path.endsWith("export.html"))!;
    const ctx = ctxWithStore({ getReportAsync: vi.fn().mockResolvedValue(report({ status: "generating" })), setRenderedHtmlAsync: vi.fn().mockResolvedValue(undefined) });
    const res = await route.handler({ params: { id: "rep_1" } }, ctx as any) as any;
    expect(res.status).toBe(409);
  });

  it("returns body-only preview html", async () => {
    const route = createReportExportRoutes().find((r) => r.path.endsWith("preview.html"))!;
    const ctx = ctxWithStore({ getReportAsync: vi.fn().mockResolvedValue(report()), setRenderedHtmlAsync: vi.fn().mockResolvedValue(undefined) });
    const res = await route.handler({ params: { id: "rep_1" } }, ctx as any) as any;
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("<article");
    expect(res.body).not.toContain("<!doctype html>");
  });

  it("caches rendered html after first export", async () => {
    const route = createReportExportRoutes().find((r) => r.path.endsWith("export.html"))!;
    const mutable = report();
    const getReportAsync = vi.fn().mockImplementation(async () => mutable);
    const setRenderedHtmlAsync = vi.fn().mockImplementation(async (_id: string, html: string) => {
      mutable.renderedHtml = html;
    });
    const ctx = ctxWithStore({ getReportAsync, setRenderedHtmlAsync });

    const first = await route.handler({ params: { id: "rep_1" } }, ctx as any) as any;
    const second = await route.handler({ params: { id: "rep_1" } }, ctx as any) as any;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(setRenderedHtmlAsync).toHaveBeenCalledTimes(1);
  });
});
