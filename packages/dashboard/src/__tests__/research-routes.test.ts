// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import express from "express";
import { get as performGet, request as performRequest } from "../test-request.js";
import { ResearchLifecycleError } from "@fusion/core";
import { createResearchRouter } from "../research-routes.js";

function createMockStore(options?: {
  taskColumn?: string;
  runId?: string;
  runStatus?: string;
  runLifecycle?: Record<string, unknown>;
  missingRun?: boolean;
  missingFinding?: boolean;
  missingTask?: boolean;
  existingAttachmentOriginalName?: string;
  addAttachmentError?: string;
}) {
  const run = {
    id: options?.runId ?? "RR-1",
    query: "test",
    topic: "test",
    status: options?.runStatus ?? "queued",
    sources: [],
    events: [],
    tags: [],
    results: {
      summary: "Run summary",
      findings: options?.missingFinding
        ? []
        : [
        {
          id: "finding-1",
          heading: "Finding One",
          content: "Important actionable result.",
          sources: ["https://example.com/citation"],
        },
      ],
    },
    lifecycle: options?.runLifecycle,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let revision = 0;

  const researchStore = {
    listRuns: vi.fn(() => [run]),
    createRun: vi.fn(() => run),
    getRun: vi.fn(() => (options?.missingRun ? null : run)),
    updateStatus: vi.fn(),
    updateRun: vi.fn(),
    requestCancellation: vi.fn(() => ({ ...run, status: "cancelling" })),
    createRetryRun: vi.fn(() => {
      if (run.status === "retry_exhausted") {
        throw new ResearchLifecycleError(`Run ${run.id} exhausted retries`, "not_retryable");
      }
      if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "queued") {
        throw new ResearchLifecycleError(`Run ${run.id} is not retryable from status ${run.status}`, "invalid_transition");
      }
      return { ...run, id: "RR-2", status: "retry_waiting" };
    }),
    appendEvent: vi.fn(),
    addSource: vi.fn(),
    searchRuns: vi.fn(() => []),
  };

  return {
    getResearchStore: () => researchStore,
    createTask: vi.fn(async (input) => ({ id: "FN-1", title: input.title, description: input.description, attachments: [] })),
    getTask: vi.fn(async (taskId: string) => {
      if (options?.missingTask) return null;
      return {
        id: taskId,
        column: options?.taskColumn ?? "todo",
        attachments: options?.existingAttachmentOriginalName
          ? [{ filename: `123-${options.existingAttachmentOriginalName}`, originalName: options.existingAttachmentOriginalName }]
          : [],
      };
    }),
    upsertTaskDocument: vi.fn(async () => ({ key: "research-RR-1", revision: ++revision })),
    addAttachment: vi.fn(async () => {
      if (options?.addAttachmentError) {
        throw new Error(options.addAttachmentError);
      }
      return { filename: "RR-1-finding-1.md" };
    }),
    log: vi.fn(async () => undefined),
  };
}

describe("research-routes", () => {
  it("lists runs with availability envelope", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore() as any));

    const response = await performGet(app, "/runs");
    expect(response.status).toBe(200);
    expect(response.body.availability.available).toBe(true);
    expect(Array.isArray(response.body.runs)).toBe(true);
  });

  it("supports run status actions, detail fetch, and export formats", async () => {
    const store = createMockStore();
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(store as any));

    const getRun = await performGet(app, "/runs/RR-1");
    expect(getRun.status).toBe(200);
    expect(getRun.body.run.id).toBe("RR-1");

    const cancel = await performRequest(app, "POST", "/runs/RR-1/cancel");
    expect(cancel.status).toBe(200);
    expect(cancel.body.run.status).toBe("cancelling");

    const retry = await performRequest(app, "POST", "/runs/RR-1/retry");
    expect(retry.status).toBe(200);
    expect(retry.body.run.status).toBe("retry_waiting");

    const markdownExport = await performGet(app, "/runs/RR-1/export?format=markdown");
    expect(markdownExport.status).toBe(200);
    expect(markdownExport.body.format).toBe("markdown");

    const jsonExport = await performGet(app, "/runs/RR-1/export?format=json");
    expect(jsonExport.status).toBe(200);
    expect(jsonExport.body.format).toBe("json");

    const htmlExport = await performGet(app, "/runs/RR-1/export?format=html");
    expect(htmlExport.status).toBe(200);
    expect(htmlExport.body.format).toBe("html");

    expect(store.getResearchStore().requestCancellation).toHaveBeenCalledWith("RR-1");
    expect(store.getResearchStore().createRetryRun).toHaveBeenCalledWith("RR-1");
  });

  it.each(["completed", "cancelled", "timed_out", "retry_exhausted"])(
    "returns INVALID_TRANSITION when cancelling terminal run status %s",
    async (status) => {
      const app = express();
      app.use(express.json());
      app.use(createResearchRouter(createMockStore({ runStatus: status }) as any));

      const response = await performRequest(app, "POST", "/runs/RR-1/cancel");

      expect(response.status).toBe(409);
      expect(response.body.details?.code).toBe("INVALID_TRANSITION");
    },
  );

  it("returns RETRY_EXHAUSTED when retry limit is exhausted", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ runStatus: "retry_exhausted", runLifecycle: { errorCode: "RETRY_EXHAUSTED", retryable: false } }) as any));

    const response = await performRequest(app, "POST", "/runs/RR-1/retry");

    expect(response.status).toBe(409);
    expect(response.body.details?.code).toBe("RETRY_EXHAUSTED");
  });

  it("returns INVALID_TRANSITION when retrying from a non-retryable status", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ runStatus: "completed" }) as any));

    const response = await performRequest(app, "POST", "/runs/RR-1/retry");

    expect(response.status).toBe(409);
    expect(response.body.details?.code).toBe("INVALID_TRANSITION");
  });

  it("creates task from finding with research provenance", async () => {
    const store = createMockStore();
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(store as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({ attachExport: true }),
      { "content-type": "application/json" },
    );
    expect(response.status).toBe(201);
    expect(response.body.documentKey).toBe("research-RR-1");
    expect(response.body.task.id).toBe("FN-1");
    expect(store.addAttachment).toHaveBeenCalledWith(
      "FN-1",
      "RR-1-finding-1.md",
      expect.any(Buffer),
      "text/markdown",
    );
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          sourceType: "research",
          sourceMetadata: expect.objectContaining({ runId: "RR-1", findingId: "finding-1" }),
        }),
      }),
    );
  });

  it("enriches existing task from finding and returns revision", async () => {
    const store = createMockStore();
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(store as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: false }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe("FN-42");
    expect(response.body.documentKey).toBe("research-RR-1");
    expect(response.body.revision).toBe(1);
  });

  it("skips duplicate attachment when original name already exists", async () => {
    const store = createMockStore({ existingAttachmentOriginalName: "RR-1-finding-1.md" });
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(store as any));

    await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: true }),
      { "content-type": "application/json" },
    );

    expect(store.addAttachment).not.toHaveBeenCalled();
  });

  it("increments document revision on repeated enrichment", async () => {
    const store = createMockStore();
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(store as any));

    const first = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: false }),
      { "content-type": "application/json" },
    );
    const second = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: false }),
      { "content-type": "application/json" },
    );

    expect(first.body.revision).toBe(1);
    expect(second.body.revision).toBe(2);
  });

  it("returns 404 when run is missing", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ missingRun: true }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Run not found");
  });

  it("returns 404 when finding is missing", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ missingFinding: true }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Finding not found");
  });

  it("returns 404 when enrich target task is missing", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ missingTask: true }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: false }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Task not found");
  });

  it("returns 409 when enriching an archived task", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ taskColumn: "archived" }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: false }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Cannot enrich archived task");
  });

  it("returns 400 when run id sanitizes to an empty document key", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ runId: "!!!" }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/!!!/findings/finding-1/task",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid run id for research document key");
  });

  it("returns 400 when create payload priority is invalid", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore() as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({ priority: "p0" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("priority must be one of");
  });

  it("returns 400 when create payload attachExport is not boolean", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore() as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({ attachExport: "yes" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("attachExport must be a boolean");
  });

  it("returns 400 when enrich payload attachExport is not boolean", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore() as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/tasks/FN-42/enrich",
      JSON.stringify({ attachExport: "yes" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("attachExport must be a boolean");
  });

  it("returns 400 when attachment exceeds size limit", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ addAttachmentError: "File too large: max 5242880 bytes" }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({ attachExport: true }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("File too large");
  });

  it("returns 400 when attachment mime type is invalid", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore({ addAttachmentError: "Invalid mime type: text/plain" }) as any));

    const response = await performRequest(
      app,
      "POST",
      "/runs/RR-1/findings/finding-1/task",
      JSON.stringify({ attachExport: true }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid mime type");
  });

  it("supports search endpoint", async () => {
    const app = express();
    app.use(express.json());
    app.use(createResearchRouter(createMockStore() as any));

    const search = await performGet(app, "/search?q=test");
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body.runs)).toBe(true);
  });
});
