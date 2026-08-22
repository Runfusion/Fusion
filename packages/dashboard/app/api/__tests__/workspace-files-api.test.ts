import { afterEach, describe, expect, it, vi } from "vitest";
import { saveFileContent, saveWorkspaceFileContent } from "../projects/workspace-files";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * FNXC:LargeTextPayloads 2026-08-21-04:35:
 * File-editor clients must keep canonical JSON serialization so the server's finite escaped-file
 * envelope covers every shared editor without introducing client-specific truncation.
 */
describe("workspace file save API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serializes large workspace and compatibility task-file content exactly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ success: true, mtime: "now", size: 1 }));
    const content = "2026-08-21T04:35:00Z INFO repeated file log\n".repeat(3_000);

    await saveWorkspaceFileContent("project", "logs/large.log", content, "project-1");
    await saveFileContent("task-1", "logs/large.log", content, "project-1");

    const [workspaceUrl, workspaceInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(workspaceUrl).toContain("/api/files/logs%2Flarge.log?workspace=project&projectId=project-1");
    expect(workspaceInit.body).toBe(JSON.stringify({ content }));
    const [taskUrl, taskInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(taskUrl).toContain("/api/tasks/task-1/files/logs%2Flarge.log?projectId=project-1");
    expect(taskInit.body).toBe(JSON.stringify({ content }));
  });
});
