import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../knowledge-index.js", () => ({
  queryKnowledgePagesAsync: vi.fn(),
}));
vi.mock("../require-async-layer.js", () => ({
  requireAsyncLayer: vi.fn(() => ({})),
}));
vi.mock("../report-pipeline.js", () => ({
  runReportPipeline: vi.fn(),
}));

import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { runReportPipeline } from "../report-pipeline.js";
import { registerReportRoutes } from "../routes/register-report-routes.js";

function setup(projectSettings: Record<string, unknown> = { reportMode: "auto-file" }) {
  const handlers = new Map<string, (req: { body?: unknown }, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    post: vi.fn((path: string, handler: (req: { body?: unknown }, res: { json: (body: unknown) => void }) => Promise<void>) => handlers.set(path, handler)),
  } as unknown as Router;
  const store = {
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ project: projectSettings, global: {} }),
    getRootDir: () => "/Users/alice/private-project",
  };
  registerReportRoutes({
    router,
    getScopedStore: vi.fn().mockResolvedValue(store),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  return handlers;
}

async function invoke(handler: (req: { body?: unknown }, res: { json: (body: unknown) => void }) => Promise<void>, body: unknown) {
  const json = vi.fn();
  await handler({ body }, { json });
  return json.mock.calls[0][0];
}

describe("report routes", () => {
  beforeEach(() => vi.clearAllMocks());
  it("passes an opted-in project roadmap source through both report routes", async () => {
    vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([]);
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "roadmap-match" } as never);
    const handlers = setup({ reportMode: "auto-file", reportRoadmapDedup: true });
    await invoke(handlers.get("/report/draft")!, { actionType: "idea", userPrompt: "Dashboard report controls" });
    await invoke(handlers.get("/report/file")!, { actionType: "idea", report: { userPrompt: "Dashboard report controls", context: {} } });
    for (const [, deps] of vi.mocked(runReportPipeline).mock.calls) expect(deps.roadmapSource).toEqual(expect.any(Function));
  });

  it("does not create a roadmap source while the setting is off", async () => {
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "draft-ready" } as never);
    const handlers = setup();
    await invoke(handlers.get("/report/draft")!, { actionType: "idea", userPrompt: "Dashboard report controls" });
    expect(vi.mocked(runReportPipeline).mock.calls.at(-1)?.[1].roadmapSource).toBeUndefined();
  });

  describe("Help self-check", () => {
  it.each(["/report/draft", "/report/file"]) ("does not let direct Help %s bypass a confident knowledge answer", async (path) => {
    vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([{ title: "Use settings", summary: "Open settings first." }]);
    const handlers = setup();
    const response = await invoke(handlers.get(path)!, path === "/report/file"
      ? { actionType: "help", report: { userPrompt: "How do I use settings?", context: {} } }
      : { actionType: "help", userPrompt: "How do I use settings?" });
    expect(response).toMatchObject({ kind: "help", answer: { title: "Use settings" } });
    expect(runReportPipeline).not.toHaveBeenCalled();
  });
  });
});
