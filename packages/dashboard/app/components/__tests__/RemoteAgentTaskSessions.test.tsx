import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RemoteAgentTaskSessions } from "../RemoteAgentTaskSessions";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

// FNXC:RemoteAgents 2026-09-26-23:39: task detail shows a proven run's turns with the panel's own turn UI.
const session = { id: "a".repeat(64), hostId: "j", provider: "codex", nativeSessionId: "native-1",
  observation: { title: "Fix parser", activity: "completed", model: "gpt-5", observedAt: "2026-09-26T00:00:00Z" } };
const turn = { nativeTurnId: "t1", revision: 1, ordinal: 0, state: "completed", prompts: [{ at: null, text: "Fix the parser" }],
  response: "Fixed it", startedAt: null, endedAt: null, durationMs: null, durationSource: null, toolCallCount: 1, fileChanges: [] };

describe("collected sessions in task detail", () => {
  it("renders each proven session with its collected turns", async () => {
    vi.mocked(api).mockImplementation(async path => path.includes("/turns")
      ? { schemaVersion: 1, turns: [turn], nextCursor: null } as never
      : { schemaVersion: 1, taskId: "FN-7", sessions: [session] } as never);
    render(<RemoteAgentTaskSessions taskId="FN-7" projectId="project-a" />);
    const card = (await screen.findByRole("heading", { name: "Fix parser" })).closest("article")!;
    expect(card).toHaveTextContent("j · codex · gpt-5 · completed");
    expect(await within(card).findByText("Fix the parser")).toBeInTheDocument();
    expect(within(card).getByText("Fixed it")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(expect.stringContaining("/external-sessions/by-task/FN-7"), expect.anything());
    // The link opens this exact session in the Remote agents panel of this project.
    const link = new URL(within(card).getByRole("link", { name: "Open in Remote agents" }).getAttribute("href")!);
    expect(Object.fromEntries(link.searchParams)).toMatchObject({ project: "project-a", view: "agents", remoteSession: "a".repeat(64) });
    // Already-counted runs must not read as extra cost on top of the task's figures.
    expect(screen.getByText(/already counted in this task's token and cost figures/)).toBeInTheDocument();
  });

  it("says no run is proven, rather than that none exists, and surfaces failures", async () => {
    vi.mocked(api).mockResolvedValueOnce({ schemaVersion: 1, taskId: "FN-8", sessions: [] } as never);
    render(<RemoteAgentTaskSessions taskId="FN-8" projectId="project-a" />);
    expect(await screen.findByText("No collected session is proven to be a run of this task.")).toBeInTheDocument();
    cleanup();
    vi.mocked(api).mockRejectedValueOnce(new Error("External session project storage unavailable"));
    render(<RemoteAgentTaskSessions taskId="FN-8" projectId="project-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("External session project storage unavailable");
  });
});
