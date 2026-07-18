import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFeatureVideo, type FeatureVideoBrowserClient } from "./feature-video.js";

const task = { id: "FN-8289", title: "Feature demo", prompt: "**Review Artifacts:** on" } as const;
const scenario = { id: "doc", taskId: task.id, key: "review-artifact-scenario", content: JSON.stringify({ baseUrl: "http://127.0.0.1:5173", targetRoute: "/settings" }), revision: 1, author: "agent", createdAt: "", updatedAt: "" };
const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })))); });

async function videoClient(bytes = Buffer.from("webm")): Promise<FeatureVideoBrowserClient> {
  const dir = await mkdtemp(join(tmpdir(), "feature-video-test-"));
  tempDirs.push(dir);
  const path = join(dir, "video.webm");
  await writeFile(path, bytes);
  return {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({ goto: vi.fn().mockResolvedValue(undefined), video: () => ({ path: async () => path }) }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function store(document: typeof scenario | null = scenario) {
  return {
    getTaskDocument: vi.fn().mockResolvedValue(document),
    registerArtifact: vi.fn().mockResolvedValue({ id: "artifact-1" }),
  };
}

describe("generateFeatureVideo", () => {
  it("registers a WebM video linked to its task through the existing registry", async () => {
    const artifactStore = store();
    const result = await generateFeatureVideo({ store: artifactStore, task, settings: { reviewArtifacts: "on" }, client: await videoClient(), sleep: async () => undefined });
    expect(result).toEqual({ status: "captured", artifactId: "artifact-1" });
    expect(artifactStore.registerArtifact).toHaveBeenCalledWith(expect.objectContaining({ type: "video", taskId: task.id, mimeType: "video/webm", data: Buffer.from("webm") }));
  });

  it("short-circuits before reading a scenario or browser when policy is off", async () => {
    const artifactStore = store();
    const client = await videoClient();
    await expect(generateFeatureVideo({ store: artifactStore, task: { ...task, prompt: undefined }, settings: { reviewArtifacts: "off" }, client })).resolves.toEqual({ status: "skipped", reason: "gated-off" });
    expect(artifactStore.getTaskDocument).not.toHaveBeenCalled();
    expect(client.launch).not.toHaveBeenCalled();
  });

  it.each([
    [null, "no-scenario"],
    [{ ...scenario, content: "not json" }, "no-scenario"],
    [{ ...scenario, content: JSON.stringify({ baseUrl: "https://example.com", targetRoute: "/" }) }, "scenario-url-not-local"],
  ])("skips missing or unsafe scenario contracts (%s)", async (document, reason) => {
    const artifactStore = store(document as typeof scenario | null);
    await expect(generateFeatureVideo({ store: artifactStore, task, settings: { reviewArtifacts: "on" }, client: await videoClient() })).resolves.toEqual({ status: "skipped", reason });
    expect(artifactStore.registerArtifact).not.toHaveBeenCalled();
  });

  it("swallows browser and navigation failures without registering partial artifacts", async () => {
    const artifactStore = store();
    const unavailable: FeatureVideoBrowserClient = { launch: vi.fn().mockRejectedValue(new Error("missing chromium")) };
    await expect(generateFeatureVideo({ store: artifactStore, task, settings: { reviewArtifacts: "on" }, client: unavailable })).resolves.toEqual({ status: "skipped", reason: "browser-unavailable" });
    const navigation: FeatureVideoBrowserClient = { launch: vi.fn().mockResolvedValue({ newContext: async () => ({ newPage: async () => ({ goto: async () => { throw new Error("offline"); }, video: () => null }), close: async () => undefined }), close: async () => undefined }) };
    await expect(generateFeatureVideo({ store: artifactStore, task, settings: { reviewArtifacts: "on" }, client: navigation })).resolves.toEqual({ status: "skipped", reason: "navigation-failed" });
    expect(artifactStore.registerArtifact).not.toHaveBeenCalled();
  });

  it("rejects oversize output without registration", async () => {
    const artifactStore = store();
    await expect(generateFeatureVideo({ store: artifactStore, task, settings: { reviewArtifacts: "on" }, client: await videoClient(Buffer.alloc(11)), maxBytes: 10, sleep: async () => undefined })).resolves.toEqual({ status: "failed", reason: "size-cap-exceeded" });
    expect(artifactStore.registerArtifact).not.toHaveBeenCalled();
  });
});
