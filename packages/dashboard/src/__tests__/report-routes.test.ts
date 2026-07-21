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
vi.mock("../artifact-media.js", () => ({
  readArtifactMediaBytes: vi.fn(),
}));

import { queryKnowledgePagesAsync } from "../knowledge-index.js";
import { runReportPipeline } from "../report-pipeline.js";
import { readArtifactMediaBytes } from "../artifact-media.js";
import { ARTIFACT_ID_PATTERN, MAX_SCREENSHOT_BYTES, registerReportRoutes } from "../routes/register-report-routes.js";

type TestRequest = { body?: unknown; file?: { buffer: Buffer; mimetype?: string } };
type TestResponse = { json: (body: unknown) => void };
type TestHandler = (req: TestRequest, res: TestResponse, next?: (error?: unknown) => void) => unknown;

function setup(projectSettings: Record<string, unknown> = { reportMode: "auto-file" }) {
  const handlers = new Map<string, TestHandler[]>();
  let uploadFile: TestRequest["file"];
  const single = vi.fn(() => async (req: TestRequest, _res: TestResponse, next: (error?: unknown) => void) => {
    req.file = uploadFile;
    next();
  });
  const router = {
    post: vi.fn((path: string, ...routeHandlers: TestHandler[]) => handlers.set(path, routeHandlers)),
    get: vi.fn((path: string, ...routeHandlers: TestHandler[]) => handlers.set(path, routeHandlers)),
  } as unknown as Router;
  const store = {
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ project: projectSettings, global: {} }),
    getRootDir: () => "/Users/alice/private-project",
    getArtifact: vi.fn().mockResolvedValue({ id: "123e4567-e89b-42d3-a456-426614174000", type: "image", title: "Report screenshot", mimeType: "image/png", uri: "artifacts/report.png", taskId: "FN-1", metadata: { source: "report-attachment" } }),
    registerArtifact: vi.fn().mockResolvedValue({ id: "123e4567-e89b-42d3-a456-426614174000" }),
  };
  registerReportRoutes({
    router,
    getScopedStore: vi.fn().mockResolvedValue(store),
    rethrowAsApiError: (error: unknown) => { throw error; },
    reportUpload: { single },
  } as never);
  return { handlers, store, single, setUploadFile: (file: TestRequest["file"]) => { uploadFile = file; } };
}

async function invoke(handlers: TestHandler[], body: unknown) {
  const json = vi.fn();
  const req: TestRequest = { body };
  const res: TestResponse = { json };
  let index = 0;
  let nextHandler: Promise<unknown> | undefined;
  const next = (error?: unknown): void => {
    if (error) throw error;
    const handler = handlers[index++];
    if (handler) nextHandler = Promise.resolve(handler(req, res, next));
  };
  const first = handlers[index++];
  if (first) await first(req, res, next);
  // The upload middleware calls next synchronously, so await the separately
  // captured route promise to prove the handler sees the injected file.
  await nextHandler;
  return { body: json.mock.calls[0]?.[0], json, req };
}

describe("report routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readArtifactMediaBytes).mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("passes roadmap settings and a roadmap endorsement target to the pipeline", async () => {
    vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([]);
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "duplicate-found" } as never);
    const { handlers } = setup({ reportMode: "auto-file", reportRoadmapDedupeEnabled: true, reportRoadmapLabel: "roadmap" });
    await invoke(handlers.get("/report/file")!, { actionType: "idea", endorseRoadmapIssueNumber: 30, report: { userPrompt: "Dashboard report controls", body: "/Users/alice/private-project", context: {} } });
    const [input, deps, options] = vi.mocked(runReportPipeline).mock.calls.at(-1)!;
    expect(deps.projectSettings).toMatchObject({ reportRoadmapDedupeEnabled: true, reportRoadmapLabel: "roadmap" });
    expect(options).toMatchObject({ endorseRoadmapIssueNumber: 30 });
    expect((options!.report as { body: string }).body).not.toContain("private-project");
    expect(input.actionType).toBe("idea");
  });

  it("scrubs top-level activityTrace before runReportPipeline on /report/file", async () => {
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "filed" } as never);
    const { handlers } = setup();
    await invoke(handlers.get("/report/file")!, {
      actionType: "bug",
      activityTrace: ["Saw crash at /Users/alice/private-project/src/a.ts in private-project with ghp_abcdefghijk1234567890"],
      report: { userPrompt: "It crashes", body: "clean body", context: {} },
    });

    expect(runReportPipeline).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(runReportPipeline).mock.calls[0]!;
    const trace = JSON.stringify(input.activityTrace);
    expect(trace).not.toMatch(/\/Users\/alice|private-project|ghp_/);
    expect(trace).toMatch(/\[REDACTED(?:_PATH)?\]/);
  });

  it("preserves absent traces and scrubs the nested activityTrace fallback", async () => {
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "filed" } as never);
    const { handlers } = setup();
    const route = handlers.get("/report/file")!;
    await invoke(route, { actionType: "bug", report: { userPrompt: "It crashes", context: {} } });
    expect(vi.mocked(runReportPipeline).mock.calls[0]![0].activityTrace).toBeUndefined();

    await invoke(route, {
      actionType: "bug",
      report: {
        userPrompt: "It crashes",
        context: { activityTrace: ["Saw crash at /Users/alice/private-project/src/a.ts in private-project with ghp_abcdefghijk1234567890"] },
      },
    });
    const nestedTrace = JSON.stringify(vi.mocked(runReportPipeline).mock.calls[1]![0].activityTrace);
    expect(nestedTrace).not.toMatch(/\/Users\/alice|private-project|ghp_/);
    expect(nestedTrace).toMatch(/\[REDACTED(?:_PATH)?\]/);
  });

  describe("report screenshot references", () => {
    it("runs the multipart middleware before storing only signature-validated artifacts", async () => {
      const { handlers, single, store, setUploadFile } = setup();
      const route = handlers.get("/report/attachment")!;
      expect(route).toHaveLength(2);
      expect(single).toHaveBeenCalledWith("screenshot");

      setUploadFile({ buffer: Buffer.from("not an image"), mimetype: "image/png" });
      await expect(invoke(route, {})).rejects.toThrow("PNG or JPEG");
      // FNXC:ReportPipeline 2026-07-20-09:35: Size validation must follow a valid image signature so this test cannot pass by failing the earlier magic-byte guard.
      const oversizedPng = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng);
      setUploadFile({ buffer: oversizedPng, mimetype: "image/png" });
      await expect(invoke(route, {})).rejects.toThrow();

      setUploadFile({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimetype: "text/plain" });
      const result = await invoke(route, {});
      expect(result.body).toEqual({ artifactId: "123e4567-e89b-42d3-a456-426614174000" });
      expect(store.registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
        type: "image", authorType: "system", authorId: "report-attachment", metadata: { source: "report-attachment" }, mimeType: "image/png",
      }));
    });

    it("accepts UUID references and rejects malformed or invalid provenance on both draft and file", async () => {
      vi.mocked(runReportPipeline).mockResolvedValue({ kind: "draft-ready", mode: "draft-review", report: {} } as never);
      const { handlers, store } = setup();
      const id = "123e4567-e89b-42d3-a456-426614174000";
      expect(ARTIFACT_ID_PATTERN.test(id)).toBe(true);
      expect(ARTIFACT_ID_PATTERN.test("bad-id")).toBe(false);

      for (const path of ["/report/draft", "/report/file"]) {
        const body = path === "/report/file"
          ? { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } }
          : { actionType: "bug", userPrompt: "It crashes", screenshotArtifactId: id };
        await invoke(handlers.get(path)!, body);
      }
      expect(runReportPipeline).toHaveBeenCalledWith(expect.objectContaining({ screenshotArtifactId: id }), expect.anything(), expect.anything());

      for (const path of ["/report/draft", "/report/file"]) {
        const malformed = path === "/report/file"
          ? { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: "bad-id" } }
          : { actionType: "bug", userPrompt: "It crashes", screenshotArtifactId: "bad-id" };
        await expect(invoke(handlers.get(path)!, malformed)).rejects.toThrow("Screenshot artifact reference is invalid");
      }

      for (const artifact of [
        { type: "image", metadata: { source: "other-source" } },
        { type: "document", metadata: { source: "report-attachment" } },
      ]) {
        store.getArtifact.mockResolvedValue(artifact);
        for (const path of ["/report/draft", "/report/file"]) {
          const body = path === "/report/file"
            ? { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } }
            : { actionType: "bug", userPrompt: "It crashes", screenshotArtifactId: id };
          await expect(invoke(handlers.get(path)!, body)).rejects.toThrow("Screenshot artifact is unavailable or invalid");
        }
      }
    });

    it("resolves the single persisted screenshot server-side before filing", async () => {
      vi.mocked(runReportPipeline).mockResolvedValue({ kind: "filed" } as never);
      const { handlers, store } = setup();
      const id = "123e4567-e89b-42d3-a456-426614174000";
      await invoke(handlers.get("/report/file")!, { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } });

      expect(readArtifactMediaBytes).toHaveBeenCalledWith(store, expect.objectContaining({ id, metadata: { source: "report-attachment" } }));
      expect(runReportPipeline).toHaveBeenCalledWith(expect.objectContaining({ attachment: expect.objectContaining({ artifactId: id, mimeType: "image/png", bytes: expect.any(Buffer) }) }), expect.anything(), expect.anything());
    });

    it("rejects invalid artifact bytes before the filing pipeline", async () => {
      const id = "123e4567-e89b-42d3-a456-426614174000";
      const { handlers, store } = setup();
      store.getArtifact.mockResolvedValue({ id, type: "image", mimeType: "image/png", uri: "../../etc/passwd", taskId: "FN-1", metadata: { source: "report-attachment" } });
      vi.mocked(readArtifactMediaBytes).mockRejectedValueOnce(new Error("Invalid artifact media path"));

      await expect(invoke(handlers.get("/report/file")!, { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } })).rejects.toThrow("Invalid artifact media path");
      expect(runReportPipeline).not.toHaveBeenCalled();

      store.getArtifact.mockResolvedValue({ id, type: "image", mimeType: "image/png", uri: "artifacts/report.png", taskId: "FN-1", metadata: { source: "report-attachment" } });
      vi.mocked(readArtifactMediaBytes).mockResolvedValueOnce(Buffer.alloc(MAX_SCREENSHOT_BYTES + 1));
      await expect(invoke(handlers.get("/report/file")!, { actionType: "bug", report: { userPrompt: "It crashes", context: {}, screenshotArtifactId: id } })).rejects.toThrow("Screenshot artifact is unavailable or invalid");
      expect(runReportPipeline).not.toHaveBeenCalled();
    });
  });

  it.each(["/report/draft", "/report/file"])("passes target and category inputs through the filing pipeline on %s", async (path) => {
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "draft-ready" } as never);
    const { handlers } = setup();
    await invoke(handlers.get(path)!, path === "/report/file"
      ? { actionType: "bug", targetType: "discussion", discussionCategoryId: "DC_ideas", report: { userPrompt: "Dashboard report controls", context: {} } }
      : { actionType: "bug", targetType: "discussion", discussionCategoryId: "DC_ideas", userPrompt: "Dashboard report controls" });
    expect(vi.mocked(runReportPipeline).mock.calls.at(-1)?.[2]).toMatchObject({ targetType: "discussion", discussionCategoryId: "DC_ideas", ...(path === "/report/file" ? { file: true } : {}) });
  });

  it("returns the pipeline's Issue fallback destination unchanged", async () => {
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "filed", url: "https://github.com/Runfusion/Fusion/issues/42", destination: "issue", report: {} } as never);
    const { handlers } = setup();
    const response = await invoke(handlers.get("/report/file")!, { actionType: "feedback", report: { userPrompt: "Dashboard report controls", context: {} } });
    expect(response.body).toMatchObject({ kind: "filed", destination: "issue" });
  });

  /*
   * FNXC:ReportPipeline 2026-07-19-20:45:
   * The file endpoint receives an editable draft and must re-scrub trace text
   * before the shared egress pipeline sees it; malformed traces fail closed.
   */
  // FNXC:ReportPipeline 2026-07-19-20:45: The file route must preserve this regression as a passing assertion: untrusted edited traces are re-scrubbed before egress.
  it("bounds activity trace input and re-scrubs an edited file trace before egress", async () => {
    vi.mocked(runReportPipeline).mockResolvedValue({ kind: "filed" } as never);
    const { handlers } = setup();
    const malicious = "private-project /Users/alice/private-project ghp_abcdefghijk1234567890 sk-abcdefghijklmnopqrstuvwxyz";

    await invoke(handlers.get("/report/file")!, {
      actionType: "bug",
      activityTrace: [malicious],
      report: { userPrompt: "Report capture regression", context: { activityTrace: [malicious] } },
    });
    const [input, _deps, options] = vi.mocked(runReportPipeline).mock.calls.at(-1)!;
    expect(input.activityTrace?.[0]).not.toMatch(/private-project|\/Users\/alice|ghp_|sk-/);
    expect((options?.report as { context: { activityTrace: string[] } }).context.activityTrace[0]).not.toMatch(/private-project|\/Users\/alice|ghp_|sk-/);

    await expect(invoke(handlers.get("/report/draft")!, {
      actionType: "bug", userPrompt: "Report capture regression", activityTrace: Array.from({ length: 21 }, () => "trace"),
    })).rejects.toThrow("Activity trace is invalid");
    await expect(invoke(handlers.get("/report/draft")!, {
      actionType: "bug", userPrompt: "Report capture regression", activityTrace: ["valid", 12],
    })).rejects.toThrow("Activity trace is invalid");
  });

  describe("Help self-check", () => {
    it.each(["/report/draft", "/report/file"])("does not let direct Help %s bypass a confident knowledge answer", async (path) => {
      vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([{ title: "Use settings", summary: "Open settings first." }]);
      const { handlers } = setup();
      const response = await invoke(handlers.get(path)!, path === "/report/file"
        ? { actionType: "help", report: { userPrompt: "How do I use settings?", context: {} } }
        : { actionType: "help", userPrompt: "How do I use settings?" });
      expect(response.body).toMatchObject({ kind: "help", answer: { title: "Use settings" } });
      expect(runReportPipeline).not.toHaveBeenCalled();
    });

    it.each(["/report/draft", "/report/file"])("rejects invalid targetType before Help returns locally on %s", async (path) => {
      vi.mocked(queryKnowledgePagesAsync).mockResolvedValue([{ title: "Use settings", summary: "Open settings first." }]);
      const { handlers } = setup();
      await expect(invoke(handlers.get(path)!, path === "/report/file"
        ? { actionType: "help", targetType: "invalid", report: { userPrompt: "How do I use settings?", context: {} } }
        : { actionType: "help", targetType: "invalid", userPrompt: "How do I use settings?" })).rejects.toThrow("Report target must be issue or discussion");
      expect(runReportPipeline).not.toHaveBeenCalled();
    });
  });
});
