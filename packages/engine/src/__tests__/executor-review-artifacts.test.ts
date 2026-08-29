import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTaskOutputLanguage } from "@fusion/core";
import { generateFeatureVideo, type FeatureVideoBrowserClient } from "../review-artifacts/feature-video.js";
import { TaskExecutor } from "../executor.js";
import { handoffTaskToReview } from "../executor/handoff-task-to-review.js";
import { createAuthoritativeWorkflowPrimitivesFromExecutor } from "../executor/create-authoritative-workflow-primitives.js";
import { createAuthoritativeWorkflowSeams } from "../executor/create-authoritative-workflow-seams.js";

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

  it("uses the graph-start language snapshot for a missing review-handoff summary", async () => {
    const updates: Array<{ taskId: string; summary: string }> = [];
    const store = {
      /* FNXC:TaskOutputLanguage 2026-08-19-16:14: This is the later selector state; the fallback must not read it. */
      getSettings: vi.fn().mockResolvedValue({ taskOutputLanguage: "interface", language: "fr" }),
      updateTask: vi.fn(async (taskId, update) => updates.push({ taskId, summary: update.summary })),
      logEntry: vi.fn(),
      handoffToReview: vi.fn().mockResolvedValue({ ...task, column: "in-review" }),
    } as any;
    const outputLanguage = resolveTaskOutputLanguage(
      { taskOutputLanguage: "english" },
      "Déployer le flux.",
    );

    await handoffTaskToReview({
      store,
      getRunContextFor: () => undefined,
      generateCompletionFeatureVideo: vi.fn(),
    }, {
      ...task,
      description: "Déployer le flux.",
      title: "Deploy workflow",
    }, "workflow-graph-review", undefined, outputLanguage);

    expect(updates).toEqual([{
      taskId: task.id,
      summary: expect.stringContaining("Workflow completed: Deploy workflow."),
    }]);
    expect(store.getSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves graph-start input language when review handoff sees edited task settings and description", async () => {
    const started = resolveTaskOutputLanguage(
      { taskOutputLanguage: "input" },
      "Bonjour, ceci est une demande détaillée pour déployer le flux de validation du projet.",
    );
    const live = { ...task, description: "Necesito desplegar el flujo de validación del proyecto en español.", title: "Deploy validation" };
    const handoffTaskToReview = vi.fn().mockResolvedValue({ ...live, column: "in-review" });
    const deps = {
      store: { getTask: vi.fn().mockResolvedValue(live) },
      persistTokenUsage: vi.fn(),
      handoffTaskToReview,
      getRunContextFor: () => undefined,
    } as any;
    // This emulates a graph yielding after its French input snapshot while an operator changes
    // both description and selector to the later Spanish/interface-French state.
    const laterSettings = { taskOutputLanguage: "interface", language: "fr" } as any;

    const primitives = createAuthoritativeWorkflowPrimitivesFromExecutor(deps, laterSettings, started);
    await primitives.runReview({ node: { context: {} } } as any, live, { type: "code" } as any);
    const seams = createAuthoritativeWorkflowSeams(deps, laterSettings, started);
    await seams.review?.(live);
    await seams["review-handoff"]?.(live);

    expect(handoffTaskToReview).toHaveBeenCalledTimes(3);
    for (const args of handoffTaskToReview.mock.calls) {
      expect(args[3]).toBe(started);
      expect(args[3]).toMatchObject({ mode: "input", locale: "fr" });
    }
  });
});
