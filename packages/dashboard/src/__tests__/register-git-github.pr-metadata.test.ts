import { EventEmitter } from "node:events";
import type { Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generatePrMetadata: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

vi.mock("../pr-metadata-generator.js", () => ({
  generatePrMetadata: mocks.generatePrMetadata,
}));

import { registerGitGitHubRoutes } from "../routes/register-git-github.js";

const task = {
  id: "FN-9524",
  title: "Preserve PR metadata generation",
  description: "A populated task used by the route contract.",
};

function createRoute() {
  const posts = new Map<string, (req: any, res: any) => Promise<void>>();
  const router = {
    get: vi.fn(),
    post: vi.fn((path: string, handler: (req: any, res: any) => Promise<void>) => posts.set(path, handler)),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  } as unknown as Router;
  const store = {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue(process.cwd()),
  };
  registerGitGitHubRoutes({
    router,
    store,
    options: {},
    registerDispose: vi.fn(),
    getProjectContext: vi.fn(async () => ({ store })),
    rethrowAsApiError: (error: unknown): never => { throw error; },
  } as never);
  return posts.get("/tasks/:id/pr/generate-metadata")!;
}

function createRequest() {
  return Object.assign(new EventEmitter(), { params: { id: task.id } });
}

function createResponse() {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    json: vi.fn(),
  });
}

describe("PR metadata route fallback diagnostics", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns generated metadata without a fallback warning", async () => {
    mocks.generatePrMetadata.mockResolvedValue({
      title: "fix: preserve metadata generation",
      body: "Generated body",
      templateUsed: false,
      fallback: false,
      fallbackReason: null,
      timedOut: false,
    });
    const handler = createRoute();
    const response = createResponse();

    await handler(createRequest(), response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ fallback: false }));
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("returns one safe timeout warning for a shared-budget fallback", async () => {
    mocks.generatePrMetadata.mockResolvedValue({
      title: task.title,
      body: "Fallback body",
      templateUsed: false,
      fallback: true,
      fallbackReason: "timeout",
      timedOut: true,
    });
    const handler = createRoute();
    const response = createResponse();

    await handler(createRequest(), response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ fallback: true, fallbackReason: "timeout", timedOut: true }));
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringMatching(/taskId=FN-9524 fallbackReason=timeout timedOut=true elapsedMs=\d+/));
  });

  it("returns one safe parse-validation warning for an unusable model response", async () => {
    mocks.generatePrMetadata.mockResolvedValue({
      title: task.title,
      body: "Fallback body",
      templateUsed: false,
      fallback: true,
      fallbackReason: "parse-validation",
      timedOut: false,
    });
    const handler = createRoute();
    const response = createResponse();

    await handler(createRequest(), response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ fallbackReason: "parse-validation", timedOut: false }));
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringMatching(/taskId=FN-9524 fallbackReason=parse-validation timedOut=false elapsedMs=\d+/));
  });

  it("does not respond or warn after a genuine caller disconnect", async () => {
    let resolveMetadata: ((value: object) => void) | undefined;
    mocks.generatePrMetadata.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));
    const handler = createRoute();
    const request = createRequest();
    const response = createResponse();

    const handling = handler(request, response);
    request.emit("aborted");
    resolveMetadata?.({
      title: task.title,
      body: "Fallback body",
      templateUsed: false,
      fallback: true,
      fallbackReason: "timeout",
      timedOut: true,
    });
    await handling;

    expect(response.json).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
