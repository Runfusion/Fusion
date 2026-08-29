import { afterEach, describe, expect, it } from "vitest";
import { artifactMediaUrl, artifactMediaUrlWithToken } from "../api";
import { clearAuthToken, setAuthToken } from "../auth";

afterEach(() => {
  clearAuthToken();
});

describe("artifactMediaUrl", () => {
  /*
   * FNXC:ArtifactMediaAuth 2026-07-15-14:24:
   * Browser-native image, video, and link requests cannot attach the dashboard's Authorization header.
   *
   * FNXC:ArtifactRegistry 2026-07-15-12:00:
   * FN-7976 keeps the base media URL token-free (fetch + HTML previews) and routes element/link auth through artifactMediaUrlWithToken so script-capable previews never receive a tokenized src.
   */
  it("keeps the base media URL token-free and tokenizes element/link loads separately", () => {
    setAuthToken("daemon-token");

    expect(artifactMediaUrl("artifact/with spaces", "project-1")).toBe(
      "/api/artifacts/artifact%2Fwith%20spaces/media?projectId=project-1",
    );
    expect(artifactMediaUrlWithToken("artifact/with spaces", "project-1")).toBe(
      "/api/artifacts/artifact%2Fwith%20spaces/media?projectId=project-1&fn_token=daemon-token",
    );
  });
});
