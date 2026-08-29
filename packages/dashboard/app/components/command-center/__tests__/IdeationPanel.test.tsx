import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { IdeationPanel } from "../IdeationPanel";

function jsonResponse(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

describe("IdeationPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the empty session state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

    render(<IdeationPanel projectId="project-1" />);

    expect(await screen.findByText("No sessions yet.")).toBeInTheDocument();
  });

  it("renders populated and converged session details", async () => {
    const session = {
      id: "idea-1",
      title: "Improve navigation",
      status: "converged",
      targetMissionId: "M-001",
      candidates: [{ id: "candidate-1", content: "Use a More destination", origin: "human" }],
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: session.id }]))
      .mockResolvedValueOnce(jsonResponse(session)));

    render(<IdeationPanel projectId="project-1" />);

    expect(await screen.findByRole("heading", { name: session.title })).toBeInTheDocument();
    expect(screen.getByText("Converged to Mission")).toBeInTheDocument();
    expect(screen.getByText("M-001")).toBeInTheDocument();
    expect(screen.getByText("Use a More destination")).toBeInTheDocument();
  });

  it("exposes request errors as an alert", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "Ideation unavailable" }));

    render(<IdeationPanel projectId="project-1" />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Ideation unavailable"));
  });
});
