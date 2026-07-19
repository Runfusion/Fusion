import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFeatureVideo, type FeatureVideoBrowserClient } from "../review-artifacts/feature-video.js";
import { TaskExecutor } from "../executor.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })))); });

describe("TaskExecutor feature-video completion handoff", () => {
  const task = { id: "FN-video", description: "user-facing", column: "in-progress", dependencies: [], steps: [], currentStep: 0 } as any;

  function makeStore() {
    return {
      on: vi.fn(), getSettings: vi.fn().mockResolvedValue({ reviewArtifacts: "on" }), getTask: vi.fn().mockResolvedValue({ ...task, prompt: "**Review Artifacts:** on" }),
      getTaskDocument: vi.fn().mockResolvedValue({ content: JSON.stringify({ baseUrl: "http://127.0.0.1:5173", targetRoute: "/" }) }),
      registerArtifact: vi.fn().mockResolvedValue({ id: "video-1" }),
      handoffToReview: vi.fn().mockResolvedValue({ ...task, column: "in-review" }),
    } as any;
  }

  it("runs the injectable capture seam before handing completed work to review", async () => {
    const store = makeStore();
    const dir = await mkdtemp(join(tmpdir(), "executor-video-test-"));
    cleanup.push(dir);
    const videoPath = join(dir, "recording.webm");
    await writeFile(videoPath, "webm");
    const client: FeatureVideoBrowserClient = { launch: vi.fn().mockResolvedValue({ newContext: async () => ({ newPage: async () => ({ goto: async () => undefined, video: () => ({ path: async () => videoPath }) }), close: async () => undefined }), close: async () => undefined }) };
    const capture = vi.fn((options) => generateFeatureVideo({ ...options, client, sleep: async () => undefined }));
    const executor = new TaskExecutor(store, "/repo", { reviewArtifactGenerator: capture });
    await (executor as any).handoffTaskToReview(task, "fn_task_done");
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: task.id }), settings: { reviewArtifacts: "on" } }));
    expect(store.registerArtifact).toHaveBeenCalledWith(expect.objectContaining({ type: "video", taskId: task.id }));
    expect(store.handoffToReview).toHaveBeenCalledWith(task.id, expect.any(Object));
  });

  it("preserves completion handoff when capture rejects", async () => {
    const store = makeStore();
    const executor = new TaskExecutor(store, "/repo", { reviewArtifactGenerator: vi.fn().mockRejectedValue(new Error("browser crashed")) });
    await expect((executor as any).handoffTaskToReview(task, "fn_task_done")).resolves.toMatchObject({ column: "in-review" });
    expect(store.handoffToReview).toHaveBeenCalledTimes(1);
  });
});
