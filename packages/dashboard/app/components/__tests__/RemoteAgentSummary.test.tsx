import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteAgentSummary } from "../RemoteAgentSummary";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));

/*
FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A):
A summary is only trustworthy if its qualifications are visible. These cover the three that matter: what it
covered, that the session has moved past it, and that the last attempt failed while the previous summary is
still on screen.
*/
const sessionId = "a".repeat(64);
const record = (over: Record<string, unknown> = {}) => ({
  summary: "The operator fixed the parser.", provider: "anthropic", model: "model-a",
  throughOrdinal: 2, turnCount: 3, generatedAt: "2026-09-24T01:00:00.000Z",
  status: "ready", failure: null, attemptedAt: "2026-09-24T01:00:00.000Z", ...over,
});
const body = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, summary: record(), stale: false, turnsSince: 0, ...over });

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("remote agent session summary", () => {
  it("shows the summary with the turn range it covered", async () => {
    vi.mocked(api).mockResolvedValue(body() as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    expect(await screen.findByText("The operator fixed the parser.")).toBeInTheDocument();
    expect(screen.getByLabelText("Session summary state")).toHaveTextContent("Covers 3 turns through turn 3");
    expect(screen.getByRole("button")).toHaveTextContent("Regenerate summary");
  });

  it("says the session has moved on rather than presenting a stale summary as current", async () => {
    vi.mocked(api).mockResolvedValue(body({ stale: true, turnsSince: 4 }) as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    expect(await screen.findByText(/4 turns have landed since this summary/)).toBeInTheDocument();
  });

  it("keeps the previous summary on screen when regeneration fails, and says why", async () => {
    vi.mocked(api).mockResolvedValueOnce(body() as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    await screen.findByText("The operator fixed the parser.");
    // The POST rejects (the route answers 502) and the refetch returns the preserved record.
    vi.mocked(api).mockRejectedValueOnce(new Error("AI engine not available"));
    vi.mocked(api).mockResolvedValueOnce(body({ summary: record({ status: "failed",
      failure: "AI engine not available", attemptedAt: "2026-09-24T02:00:00.000Z" }) }) as never);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert", { name: "Session summary error" });
    // The invariant: the older summary is still readable during the outage.
    expect(screen.getByText("The operator fixed the parser.")).toBeInTheDocument();
    expect(screen.getByLabelText("Session summary state")).toHaveTextContent("Last attempt failed");
    expect(screen.getByLabelText("Session summary state")).toHaveTextContent("AI engine not available");
    expect(screen.getByLabelText("Session summary state")).toHaveTextContent("last one that succeeded");
  });

  it("offers generation for a session that has none, without claiming an empty summary", async () => {
    vi.mocked(api).mockResolvedValue({ schemaVersion: 1, summary: null, stale: false, turnsSince: 0 } as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    expect(await screen.findByText(/No summary has been generated/)).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveTextContent("Generate summary");
  });

  it("reports a first-attempt failure with no previous summary to fall back on", async () => {
    vi.mocked(api).mockResolvedValue(body({ summary: record({ summary: null, throughOrdinal: null,
      turnCount: null, generatedAt: null, status: "failed", failure: "Model unavailable" }) }) as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    expect(await screen.findByText(/No summary has been generated/)).toBeInTheDocument();
    expect(screen.getByLabelText("Session summary state")).toHaveTextContent("Model unavailable");
    expect(screen.getByLabelText("Session summary state")).not.toHaveTextContent("last one that succeeded");
  });

  it("surfaces a malformed response as an error instead of rendering an empty pane", async () => {
    vi.mocked(api).mockResolvedValue({ schemaVersion: 1 } as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    expect(await screen.findByRole("alert", { name: "Session summary error" })).toHaveTextContent("malformed");
  });

  it("disables the control while a summary is being generated", async () => {
    vi.mocked(api).mockResolvedValueOnce(body({ summary: null }) as never);
    render(<RemoteAgentSummary sessionId={sessionId} projectId="project-a" />);
    const button = await screen.findByRole("button");
    let settle: (value: unknown) => void = () => {};
    vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { settle = resolve; }) as never);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent("Summarizing…");
    settle(body());
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
