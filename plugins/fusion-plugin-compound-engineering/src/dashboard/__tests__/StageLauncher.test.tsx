import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiscoveryResult } from "../../artifacts/discovery.js";
import type { CeSession } from "../../session/session-store.js";
import * as LucideIcons from "lucide-react";
import { getStage, listStages } from "../../session/stage-registry.js";

// Mock the whole api module: artifacts (so the view renders empty) + session.
const startSession = vi.fn<(stage: string, opts?: unknown) => Promise<CeSession>>();
vi.mock("../hooks/api.js", () => ({
  listArtifacts: async (): Promise<DiscoveryResult> => ({
    groups: [],
    totalArtifacts: 0,
    totalErrors: 0,
  }),
  getArtifactPreviewUrl: (id: string) => `/preview/${id}`,
  startSession: (stage: string, opts?: unknown) => startSession(stage, opts),
  answerSession: vi.fn(),
  resumeSession: vi.fn(),
  getSession: vi.fn(),
}));

import { CompoundEngineeringView } from "../CompoundEngineeringView.js";
import { __test_clearArtifactsCache } from "../hooks/useArtifacts.js";

afterEach(() => {
  __test_clearArtifactsCache();
  startSession.mockReset();
});

function mkSession(over: Partial<CeSession>): CeSession {
  return {
    id: "s1",
    stage: "brainstorm",
    status: "awaiting_input",
    currentQuestion: { id: "q1", type: "text", question: "What's the topic?" },
    conversationHistory: [],
    projectId: null,
    artifactPath: null,
    error: null,
    turnIntervalMs: 1000,
    lastActivityAt: Date.now(),
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

describe("Stage launcher (R4)", () => {
  it("lists exactly the registered stages", async () => {
    render(<CompoundEngineeringView enabledOverride projectId="p1" />);
    // Empty-state start affordance opens the launcher.
    await waitFor(() => screen.getByTestId("ce-empty-state"));
    fireEvent.click(screen.getByTestId("ce-start-action"));

    const tiles = await screen.findAllByTestId("ce-launcher-stage");
    const expected = listStages();
    expect(tiles).toHaveLength(expected.length);
    const renderedStages = tiles.map((t) => t.getAttribute("data-stage")).sort();
    expect(renderedStages).toEqual(expected.map((s) => s.stageId).sort());
    // And the labels match the registry.
    for (const stage of expected) {
      expect(screen.getByText(stage.label)).toBeInTheDocument();
    }
    const debugTiles = tiles.filter((t) => t.getAttribute("data-stage") === "debug");
    expect(debugTiles).toHaveLength(1);
    expect(debugTiles[0]).toHaveTextContent("Debug");
    expect((LucideIcons as unknown as Record<string, unknown>)[getStage("debug")!.icon]).toBeTruthy();
  });

  it("launching a stage starts its session and renders CeFlow", async () => {
    startSession.mockResolvedValue(mkSession({ stage: "plan" }));
    render(<CompoundEngineeringView enabledOverride projectId="p1" />);
    await waitFor(() => screen.getByTestId("ce-empty-state"));
    fireEvent.click(screen.getByTestId("ce-start-action"));

    const planTile = (await screen.findAllByTestId("ce-launcher-stage")).find(
      (t) => t.getAttribute("data-stage") === "plan",
    )!;
    await act(async () => {
      fireEvent.click(planTile);
    });

    expect(startSession).toHaveBeenCalledWith("plan", expect.objectContaining({ projectId: "p1" }));
    expect(await screen.findByTestId("ce-flow")).toBeInTheDocument();
    expect(screen.getByTestId("ce-flow-text-input")).toBeInTheDocument();
  });
});
