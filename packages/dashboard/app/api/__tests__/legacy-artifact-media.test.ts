import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadLegacyApi() {
  vi.resetModules();
  return import("../legacy");
}

describe("artifactMediaUrlWithToken", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("adds the daemon token for dashboard-owned browser media loads", async () => {
    window.localStorage.setItem("fn.authToken", "daemon-abc");
    const { artifactMediaUrl, artifactMediaUrlWithToken } = await loadLegacyApi();

    expect(artifactMediaUrl("artifact 1", "project-1")).toBe("/api/artifacts/artifact%201/media?projectId=project-1");
    expect(artifactMediaUrlWithToken("artifact 1", "project-1")).toBe("/api/artifacts/artifact%201/media?projectId=project-1&fn_token=daemon-abc");
  });

  it("leaves media URLs unchanged when dashboard authentication is disabled", async () => {
    const { artifactMediaUrlWithToken } = await loadLegacyApi();

    expect(artifactMediaUrlWithToken("artifact-1")).toBe("/api/artifacts/artifact-1/media");
  });
});
