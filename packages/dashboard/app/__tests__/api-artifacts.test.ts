import { afterEach, describe, expect, it } from "vitest";
import { artifactMediaUrl } from "../api";
import { clearAuthToken, setAuthToken } from "../auth";

afterEach(() => {
  clearAuthToken();
});

describe("artifactMediaUrl", () => {
  /*
   * FNXC:ArtifactMediaAuth 2026-07-15-14:24:
   * Browser-native image, video, and link requests cannot attach the dashboard's Authorization header. Keep this regression focused on the generated URL contract: encoded artifact id and project scope survive while the existing same-origin fn_token fallback is appended.
   */
  it("appends the daemon token for image and link navigation", () => {
    setAuthToken("daemon-token");

    expect(artifactMediaUrl("artifact/with spaces", "project-1")).toBe(
      "/api/artifacts/artifact%2Fwith%20spaces/media?projectId=project-1&fn_token=daemon-token",
    );
  });
});
