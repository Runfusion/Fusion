import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiRequestError } from "../../api/client/client";
import { normalizeMissionBlockers } from "../../api/missions/missions";
import { MissionManager } from "../MissionManager";

const fetchMissions = vi.fn();
const fetchMission = vi.fn();
const fetchMissionsHealth = vi.fn();
const fetchMissionBlockedDiagnostics = vi.fn();
const clearMissionBlockedStatus = vi.fn();
const resumeMission = vi.fn();

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../hooks/useNavigationHistory")>(),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  fetchMissions: (...args: unknown[]) => fetchMissions(...args),
  fetchMission: (...args: unknown[]) => fetchMission(...args),
  fetchMissionsHealth: (...args: unknown[]) => fetchMissionsHealth(...args),
  fetchMissionBlockedDiagnostics: (...args: unknown[]) => fetchMissionBlockedDiagnostics(...args),
  clearMissionBlockedStatus: (...args: unknown[]) => clearMissionBlockedStatus(...args),
  resumeMission: (...args: unknown[]) => resumeMission(...args),
}));

const blockedMission = {
  id: "M-1", title: "Blocked mission", description: "", status: "blocked" as const,
  interviewState: "completed", autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive",
  createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z", milestones: [],
};
const blockedSummary = { ...blockedMission, summary: { totalMilestones: 0, totalFeatures: 0, completedMilestones: 0, completedFeatures: 0, progressPercent: 0 } };
const canonicalBlockers = [
  { schemaVersion: 1 as const, kind: "mission-resume-conflict" as const, rootFeatureId: "F-1", reason: "budget-exhausted" as const, source: "feature-row" as const },
  { schemaVersion: 1 as const, kind: "mission-resume-conflict" as const, rootFeatureId: "F-1", reason: "budget-exhausted" as const, source: "lineage-stop" as const },
];

function renderBlocked() {
  return render(<MissionManager isOpen isInline onClose={() => {}} addToast={() => {}} projectId="P-1" targetMissionId="M-1" />);
}

describe("MissionManager blocked repair", () => {
  it("keeps linked-mission status in GoalsView read-only", () => {
    const goalsView = fs.readFileSync(path.resolve(import.meta.dirname, "../GoalsView.tsx"), "utf8");
    const linkedStatusRegion = goalsView.slice(goalsView.indexOf("goals-linked-mission-status"), goalsView.indexOf("goals-linked-mission-status") + 800);
    expect(linkedStatusRegion).not.toContain("Clear blocked status");
    expect(linkedStatusRegion).not.toContain("clearMissionBlockedStatus");
  });

  it("keeps canonical entries and drops v0 or malformed blocker inputs", () => {
    expect(normalizeMissionBlockers([{ schemaVersion: 1, kind: "mission-resume-conflict", rootFeatureId: "F-2", reason: "budget-exhausted", source: "lineage-stop" }, { id: "F-1", reason: "legacy" }, { nope: true }])).toEqual([
      expect.objectContaining({ rootFeatureId: "F-2", reason: "budget-exhausted", source: "lineage-stop" }),
    ]);
    expect(normalizeMissionBlockers(undefined)).toEqual([]);
    expect(normalizeMissionBlockers(null)).toEqual([]);
    expect(normalizeMissionBlockers({ blockers: [] })).toEqual([]);
  });

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    fetchMissions.mockResolvedValue([blockedSummary]);
    fetchMission.mockResolvedValue(blockedMission);
    fetchMissionsHealth.mockResolvedValue({});
    fetchMissionBlockedDiagnostics.mockResolvedValue({ blockers: canonicalBlockers });
    clearMissionBlockedStatus.mockResolvedValue({ mission: { ...blockedMission, status: "planning" }, blockers: [] });
  });

  it("renders the clear control on both owning blocked badge surfaces and refreshes it away", async () => {
    renderBlocked();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Clear blocked status" })).toHaveLength(2));
    await waitFor(() => expect(screen.getByLabelText("Why blocked")).toHaveTextContent("F-1: budget-exhausted (feature-row)"));
    const rows = screen.getByLabelText("Why blocked").querySelectorAll("li");
    expect(rows).toHaveLength(canonicalBlockers.length);
    expect(new Set(canonicalBlockers.map((blocker) => `${blocker.rootFeatureId}\u0000${blocker.source}\u0000${blocker.reason}`)).size).toBe(rows.length);
    fetchMission.mockResolvedValueOnce({ ...blockedMission, status: "planning" });
    fetchMissions.mockResolvedValueOnce([{ ...blockedSummary, status: "planning" }]);
    fireEvent.click(screen.getAllByRole("button", { name: "Clear blocked status" })[0]);
    await waitFor(() => expect(clearMissionBlockedStatus).toHaveBeenCalledWith("M-1", {}, "P-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear blocked status" })).not.toBeInTheDocument());
  });

  it.each(["planning", "active", "complete", "archived"] as const)("does not render an orphan repair shell for %s", async (status) => {
    fetchMissions.mockResolvedValue([{ ...blockedSummary, status }]);
    fetchMission.mockResolvedValue({ ...blockedMission, status });
    renderBlocked();
    await waitFor(() => expect(fetchMission).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Clear blocked status" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Why blocked")).not.toBeInTheDocument();
  });

  it("keeps clearing available when diagnostics fail or are malformed and renders canonical resume conflicts", async () => {
    fetchMissionBlockedDiagnostics.mockRejectedValueOnce(new Error("offline"));
    renderBlocked();
    await waitFor(() => expect(screen.getByText("Blocker diagnostics are unavailable.")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Clear blocked status" })).toHaveLength(2);
    resumeMission.mockRejectedValueOnce(new ApiRequestError("conflict", 409, { code: "MISSION_RESUME_CONFLICT", blockerSchemaVersion: 1, blockers: canonicalBlockers }));
    fireEvent.click(screen.getAllByRole("button", { name: "Resume mission" })[0]);
    await waitFor(() => expect(screen.getByLabelText("Why blocked")).toHaveTextContent("F-1: budget-exhausted"));
    expect(screen.getByLabelText("Why blocked").querySelectorAll("li")).toHaveLength(canonicalBlockers.length);
    expect(screen.getByLabelText("Why blocked")).not.toHaveTextContent("undefined");
  });

  it("treats a malformed diagnostics payload as unavailable while leaving clear operable", async () => {
    fetchMissionBlockedDiagnostics.mockResolvedValueOnce({ blockers: { malformed: true } });
    renderBlocked();
    await waitFor(() => expect(screen.getByText("Blocker diagnostics are unavailable.")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Clear blocked status" })).toHaveLength(2);
  });
});
