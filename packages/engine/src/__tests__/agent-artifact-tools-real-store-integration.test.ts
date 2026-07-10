// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import {
  createArtifactRegisterTool,
  createArtifactListTool,
  createArtifactViewTool,
} from "../agent-tools.js";

/*
 * FNXC:ArtifactRegistry 2026-07-08-20:15:
 * FN-7693: the operator reported "I don't think artifacts work" — no confidence that an agent
 * generating an image and registering it via `fn_artifact_register` actually surfaces anywhere.
 * `agent-artifact-tools.test.ts` only exercises the tool layer against a MOCKED TaskStore, so it
 * cannot prove the real disk-write + SQLite-row + list/view round trip. This file pins the
 * register -> list -> view invariant for a real image artifact end-to-end through the actual
 * `fn_artifact_register`/`fn_artifact_list`/`fn_artifact_view` tool factories bound to a REAL
 * TaskStore (inMemoryDb: true, real filesystem writes under a temp task dir) — the same store
 * class the dashboard `/api/artifacts` routes and Documents "Artifacts" tab consume. It also
 * pins the invalid-base64-payload rejection path and the empty-task-list data state so the
 * invariant holds across the enumerated register/list/view surfaces, not just the single repro.
 */
describe("FN-7693: agent artifact tools against a real TaskStore (image register -> list -> view)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  const AUTHOR_ID = "fn7693-verification-agent";
  const PNG_IMAGE_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn7693-agent-tools-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "fn7693-agent-tools-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  function getText(result: any): string {
    const first = result?.content?.[0];
    return first?.type === "text" ? first.text : "";
  }

  it("registers a real base64 PNG image artifact and surfaces it via list and view", async () => {
    const task = await store.createTask({
      title: "FN-7693 real artifact pipeline check",
      description: "Reproduces the operator-reported artifact pipeline concern with a real store",
    });

    const registerTool = createArtifactRegisterTool(store, AUTHOR_ID);
    const registerResult = await registerTool.execute("call-register", {
      type: "image",
      title: "FN-7693 e2e verification screenshot",
      mimeType: "image/png",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
      taskId: task.id,
    } as any, undefined as any, undefined as any, undefined as any);

    expect(getText(registerResult)).toContain("Registered artifact");
    expect(getText(registerResult)).not.toContain("ERROR:");
    const artifactId = (registerResult as { details?: { artifactId?: string } }).details?.artifactId;
    expect(artifactId).toBeTruthy();

    // Real store row: confirm the binary was actually persisted to disk with the expected size.
    const stored = await store.getArtifact(artifactId!);
    expect(stored?.type).toBe("image");
    expect(stored?.mimeType).toBe("image/png");
    expect(stored?.sizeBytes).toBe(PNG_IMAGE_BYTES.length);
    expect(stored?.uri).toBeTruthy();
    expect(stored?.taskId).toBe(task.id);

    // List surface: task-scoped listing carries task association.
    const listTool = createArtifactListTool(store);
    const listResult = await listTool.execute("call-list", { taskId: task.id } as any, undefined as any, undefined as any, undefined as any);
    const listText = getText(listResult);
    expect(listText).toContain(`${artifactId} [image] FN-7693 e2e verification screenshot`);
    expect(listText).toContain(`${task.id} (`);

    // View surface: resolvable uri/media reference plus correct byte size.
    const viewTool = createArtifactViewTool(store);
    const viewResult = await viewTool.execute("call-view", { id: artifactId } as any, undefined as any, undefined as any, undefined as any);
    const viewText = getText(viewResult);
    expect(viewText).toContain("Artifact: FN-7693 e2e verification screenshot");
    expect(viewText).toContain(`URI: ${stored?.uri}`);
    expect(viewText).toContain(`Size: ${PNG_IMAGE_BYTES.length} bytes`);
  });

  it("rejects a non-image byte payload for an image-typed artifact without persisting a row", async () => {
    const task = await store.createTask({
      title: "FN-7693 invalid payload check",
      description: "Confirms signature validation still guards the real store path",
    });

    const registerTool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await registerTool.execute("call-register-invalid", {
      type: "image",
      title: "Not a real PNG",
      mimeType: "image/png",
      dataBase64: Buffer.from("definitely-not-image-bytes").toString("base64"),
      taskId: task.id,
    } as any, undefined as any, undefined as any, undefined as any);

    expect(getText(result)).toContain("dataBase64 must decode to valid image bytes matching mimeType");

    const listTool = createArtifactListTool(store);
    const listResult = await listTool.execute("call-list-empty", { taskId: task.id } as any, undefined as any, undefined as any, undefined as any);
    expect(getText(listResult)).toBe("No artifacts found.");
  });

  it("lists an empty array (empty-state text) for a task with no artifacts", async () => {
    const task = await store.createTask({
      title: "FN-7693 empty state check",
      description: "No artifacts registered on this task",
    });

    const listTool = createArtifactListTool(store);
    const listResult = await listTool.execute("call-list-empty-task", { taskId: task.id } as any, undefined as any, undefined as any, undefined as any);
    expect(getText(listResult)).toBe("No artifacts found.");
  });
});
