import { afterEach, describe, expect, it } from "vitest";
import { artifactMediaUrl } from "../api";
import { clearAuthToken, setAuthToken } from "../auth";

afterEach(() => {
  clearAuthToken();
  window.localStorage.clear();
});

describe("artifactMediaUrl", () => {
  it("appends the daemon token for image and link navigation", () => {
    setAuthToken("daemon-token");

    expect(artifactMediaUrl("artifact/with spaces", "project-1")).toBe(
      "/api/artifacts/artifact%2Fwith%20spaces/media?projectId=project-1&fn_token=daemon-token",
    );
  });
});
