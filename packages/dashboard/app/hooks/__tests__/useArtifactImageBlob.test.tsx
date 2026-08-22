import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useArtifactImageBlob } from "../useArtifactImageBlob";
import { artifactMediaUrl } from "../../api";
import { withTokenHeader } from "../../auth";

vi.mock("../../api", () => ({
  artifactMediaUrl: vi.fn((id: string, projectId?: string) => `/api/artifacts/${id}/media${projectId ? `?projectId=${projectId}` : ""}`),
}));
vi.mock("../../auth", () => ({ withTokenHeader: vi.fn(() => ({ Authorization: "Bearer dashboard-secret" })) }));

const mockArtifactMediaUrl = vi.mocked(artifactMediaUrl);
const mockWithTokenHeader = vi.mocked(withTokenHeader);
const createObjectUrl = vi.fn(() => "blob:artifact-preview");
const revokeObjectUrl = vi.fn();

function imageResponse() {
  return {
    ok: true,
    headers: new Headers({ "content-type": "image/png" }),
    blob: async () => new Blob(["png"], { type: "image/png" }),
  } as Response;
}

function textResponse() {
  return {
    ok: true,
    headers: new Headers({ "content-type": "text/plain" }),
    blob: async () => new Blob(["not an image"], { type: "text/plain" }),
  } as Response;
}

describe("useArtifactImageBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
  });

  it("fetches a token-free media URL with Authorization and returns only a blob URL", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useArtifactImageBlob("image-1", "project-1"));

    await waitFor(() => expect(result.current.url).toBe("blob:artifact-preview"));
    expect(mockArtifactMediaUrl).toHaveBeenCalledWith("image-1", "project-1");
    expect(mockWithTokenHeader).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/image-1/media?projectId=project-1", expect.objectContaining({ headers: { Authorization: "Bearer dashboard-secret" } }));
    expect(result.current.url).not.toContain("fn_token");
    expect(result.current.url).not.toContain("dashboard-secret");
  });

  it("aborts and revokes the previous object URL when the artifact changes or unmounts", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender, unmount } = renderHook(({ id }) => useArtifactImageBlob(id), { initialProps: { id: "image-1" } });

    await waitFor(() => expect(result.current.url).toBe("blob:artifact-preview"));
    rerender({ id: "image-2" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith("blob:artifact-preview"));
    unmount();
    expect(revokeObjectUrl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps non-image and failed responses out of DOM URLs", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse()));
    const { result } = renderHook(() => useArtifactImageBlob("not-image"));

    await waitFor(() => expect(result.current.error).toBe("Failed to load image artifact."));
    expect(result.current.url).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("retries a failed request without exposing its source URL", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArtifactImageBlob("retry-image"));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.url).toBe("blob:artifact-preview"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
