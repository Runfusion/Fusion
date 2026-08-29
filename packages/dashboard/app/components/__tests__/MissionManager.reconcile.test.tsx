import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { MissionManager } from "../MissionManager";

const fetchMissions = vi.fn();
const fetchMission = vi.fn();
const reconcileMission = vi.fn();
const fetchMissionsHealth = vi.fn();
const fetchMissionEvents = vi.fn();
const fetchAssertions = vi.fn();
const fetchMilestoneValidation = vi.fn();
const fetchMilestoneValidationTelemetry = vi.fn();
const fetchValidationLoopState = vi.fn();
const fetchValidationRuns = vi.fn();
const fetchAiSessions = vi.fn();
const fetchAiSession = vi.fn();
const fetchMissionInterviewDrafts = vi.fn();

vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => vi.fn()) }));
vi.mock("../MissionInterviewModal", () => ({ MissionInterviewModal: () => null }));
vi.mock("../MilestoneSliceInterviewModal", () => ({ MilestoneSliceInterviewModal: () => null }));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  fetchMissions: (...args: unknown[]) => fetchMissions(...args),
  fetchMission: (...args: unknown[]) => fetchMission(...args),
  reconcileMission: (...args: unknown[]) => reconcileMission(...args),
  fetchMissionsHealth: (...args: unknown[]) => fetchMissionsHealth(...args),
  fetchMissionEvents: (...args: unknown[]) => fetchMissionEvents(...args),
  fetchAssertions: (...args: unknown[]) => fetchAssertions(...args),
  fetchMilestoneValidation: (...args: unknown[]) => fetchMilestoneValidation(...args),
  fetchMilestoneValidationTelemetry: (...args: unknown[]) => fetchMilestoneValidationTelemetry(...args),
  fetchValidationLoopState: (...args: unknown[]) => fetchValidationLoopState(...args),
  fetchValidationRuns: (...args: unknown[]) => fetchValidationRuns(...args),
  fetchAiSessions: (...args: unknown[]) => fetchAiSessions(...args),
  fetchAiSession: (...args: unknown[]) => fetchAiSession(...args),
  fetchMissionInterviewDrafts: (...args: unknown[]) => fetchMissionInterviewDrafts(...args),
  fetchGoals: vi.fn().mockResolvedValue([]),
  api: vi.fn().mockResolvedValue({ goals: [] }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
}));

function mission(id = "M-1") {
  return {
    id, title: id === "M-1" ? "Mission one" : "Mission two", description: "", status: "active", interviewState: "completed",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    milestones: [{ id: `${id}-MS`, missionId: id, title: "Milestone", status: "active", interviewState: "completed", orderIndex: 0, dependencies: [], createdAt: "", updatedAt: "", slices: [{ id: `${id}-SL`, milestoneId: `${id}-MS`, title: "Slice", status: "active", orderIndex: 0, dependencies: [], createdAt: "", updatedAt: "", features: [{ id: "F-1", title: "Feature title", status: "in-progress", createdAt: "", updatedAt: "" }] }] }],
  };
}
const result = (planned = [{ featureId: "F-1", action: "status" as const }]) => ({ missionsScanned: 1, featuresScanned: 1, statusUpdates: 1, badgeRepairs: 0, badgeRepairsSkipped: 0, terminalRepairs: 0, terminalSkipped: 0, conflicts: 0, failures: 0, planned });

/*
FNXC:MissionReconcileControl 2026-08-11-06:49:
Exercise the rendered control rather than an exported handler so dry-run gating, explicit apply,
and selection-boundary response suppression remain user-visible contracts.
*/
describe("MissionManager reconcile control", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    window.dispatchEvent(new Event("resize"));
    vi.clearAllMocks();
    fetchMissions.mockResolvedValue([mission("M-1"), mission("M-2")].map((item) => ({ ...item, milestones: [] })));
    fetchMission.mockImplementation(async (id: string) => mission(id));
    fetchMissionsHealth.mockResolvedValue({}); fetchMissionEvents.mockResolvedValue([]); fetchAssertions.mockResolvedValue([]);
    fetchMilestoneValidation.mockResolvedValue(null); fetchMilestoneValidationTelemetry.mockResolvedValue({ rollup: null, validationTelemetry: { validationRounds: [], totalRuns: 0 }, validationContract: null, fixFeatures: [] });
    fetchValidationLoopState.mockResolvedValue(null); fetchValidationRuns.mockResolvedValue([]); fetchAiSessions.mockResolvedValue([]); fetchAiSession.mockResolvedValue(null); fetchMissionInterviewDrafts.mockResolvedValue([]);
  });
  afterEach(cleanup);

  function renderManager(addToast = vi.fn(), targetMissionId = "M-1") {
    const rendered = render(<ConfirmDialogProvider><MissionManager isOpen isInline onClose={() => {}} addToast={addToast} projectId="p1" targetMissionId={targetMissionId} /></ConfirmDialogProvider>);
    return { ...rendered, addToast };
  }

  it.each([1280, 640])("previews at %ipx without applying", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); window.dispatchEvent(new Event("resize"));
    reconcileMission.mockResolvedValue(result()); renderManager();
    await screen.findByText("Feature title"); fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    await screen.findByText(/Feature title — status/);
    expect(reconcileMission).toHaveBeenCalledTimes(1);
    expect(reconcileMission).toHaveBeenCalledWith("M-1", { dryRun: true }, "p1");
  });

  it("applies only after explicit confirmation and refreshes", async () => {
    reconcileMission.mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result(), planned: undefined });
    const { container, addToast } = renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await screen.findByTestId("mission-reconcile-apply");
    fireEvent.click(screen.getByTestId("mission-reconcile-apply"));
    await waitFor(() => expect(reconcileMission).toHaveBeenLastCalledWith("M-1", { dryRun: false }, "p1"));
    await waitFor(() => expect(container.querySelector(".mission-detail__reconcile-panel")).toBeNull());
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Reconciled:"), "success");
  });

  it("keeps preview for an apply failure", async () => {
    reconcileMission.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("apply failed"));
    const { addToast } = renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await screen.findByTestId("mission-reconcile-apply");
    fireEvent.click(screen.getByTestId("mission-reconcile-apply"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("apply failed", "error"));
    expect(screen.getByTestId("mission-reconcile-apply")).toBeEnabled();
  });

  it("renders empty and archived dry runs without an apply action", async () => {
    reconcileMission.mockResolvedValueOnce({ ...result([]), statusUpdates: 0 }).mockResolvedValueOnce({ ...result([]), statusUpdates: 0, skippedReason: "archived" });
    renderManager(); await screen.findByText("Feature title"); fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    await screen.findByText("Already up to date"); expect(screen.queryByTestId("mission-reconcile-apply")).toBeNull();
    fireEvent.click(screen.getByText("Dismiss")); fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    await screen.findByText("Mission is archived — nothing reconciled"); expect(screen.queryByTestId("mission-reconcile-apply")).toBeNull();
  });

  it("keeps the affordance out of mission list controls", async () => {
    reconcileMission.mockResolvedValue(result()); const { container } = renderManager(); await screen.findByText("Feature title");
    expect(screen.getAllByTestId("mission-reconcile-now")).toHaveLength(1);
    expect(container.querySelector(".mission-list__item-run-controls [data-testid=mission-reconcile-now]")).toBeNull();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  async function openM2() {
    fireEvent.click(screen.getByRole("button", { name: "Open mission Mission two" }));
    await screen.findByText("Mission two");
  }

  it("updates reconcile intent when a target mission deep link changes", async () => {
    reconcileMission.mockResolvedValue(result());
    const { rerender } = renderManager();
    await screen.findByText("Mission one");
    rerender(<ConfirmDialogProvider><MissionManager isOpen isInline onClose={() => {}} addToast={vi.fn()} projectId="p1" targetMissionId="M-2" /></ConfirmDialogProvider>);
    await screen.findByText("Mission two");
    expect(screen.getByTestId("mission-reconcile-now")).toBeEnabled();
    fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    await waitFor(() => expect(reconcileMission).toHaveBeenCalledWith("M-2", { dryRun: true }, "p1"));
  });

  it("makes the retained header inert and refuses an attribute-stripped preview click during a switch", async () => {
    const m2 = deferred<ReturnType<typeof mission>>();
    fetchMission.mockImplementation((id: string) => id === "M-2" ? m2.promise : Promise.resolve(mission(id)));
    const { container } = renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByRole("button", { name: "Open mission Mission two" }));
    const button = screen.getByTestId("mission-reconcile-now") as HTMLButtonElement;
    expect(button).toBeDisabled();
    // Remove the DOM gate without a React render: this click reaches the production handler.
    button.removeAttribute("disabled"); button.disabled = false;
    await act(async () => { fireEvent.click(button); });
    expect(reconcileMission).not.toHaveBeenCalled();
    expect(container.querySelector(".mission-detail__reconcile-panel")).toBeNull();
    m2.resolve(mission("M-2")); await screen.findByText("Mission two");
    expect(screen.getByTestId("mission-reconcile-now")).toBeEnabled();
  });

  it("refuses a same-batch retained-header click while switching missions", async () => {
    const m2 = deferred<ReturnType<typeof mission>>();
    fetchMission.mockImplementation((id: string) => id === "M-2" ? m2.promise : Promise.resolve(mission(id)));
    renderManager(); await screen.findByText("Feature title");
    const row = screen.getByRole("button", { name: "Open mission Mission two" });
    const button = screen.getByTestId("mission-reconcile-now");
    await act(async () => { fireEvent.click(row); fireEvent.click(button); });
    expect(reconcileMission).not.toHaveBeenCalledWith("M-1", expect.anything(), "p1");
    m2.resolve(mission("M-2")); await screen.findByText("Mission two");
  });

  it("silently discards preview resolution and rejection in the pre-commit switch window", async () => {
    const preview = deferred<ReturnType<typeof result>>(); const m2 = deferred<ReturnType<typeof mission>>();
    reconcileMission.mockReturnValue(preview.promise);
    fetchMission.mockImplementation((id: string) => id === "M-2" ? m2.promise : Promise.resolve(mission(id)));
    const { addToast, container } = renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await waitFor(() => expect(reconcileMission).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Open mission Mission two" }));
    preview.resolve(result()); await act(async () => {});
    expect(container.querySelector(".mission-detail__reconcile-panel")).toBeNull(); expect(addToast).not.toHaveBeenCalled();
    m2.resolve(mission("M-2")); await screen.findByText("Mission two");

    const rejected = deferred<ReturnType<typeof result>>(); reconcileMission.mockReturnValueOnce(rejected.promise);
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await waitFor(() => expect(reconcileMission).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Open mission Mission one" }));
    rejected.reject(new Error("stale preview")); await act(async () => {});
    expect(addToast).not.toHaveBeenCalledWith("stale preview", "error");
  });

  it("refuses a same-batch retained-panel apply click so no write reaches the abandoned mission", async () => {
    const m2 = deferred<ReturnType<typeof mission>>();
    reconcileMission.mockResolvedValue(result());
    fetchMission.mockImplementation((id: string) => id === "M-2" ? m2.promise : Promise.resolve(mission(id)));
    renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await screen.findByTestId("mission-reconcile-apply");
    const row = screen.getByRole("button", { name: "Open mission Mission two" });
    const apply = screen.getByTestId("mission-reconcile-apply");
    // The panel is synchronously released after the row event; this same-batch click is the
    // reachable production path that still invokes the old handler before React re-renders it.
    await act(async () => { fireEvent.click(row); fireEvent.click(apply); });
    expect(reconcileMission).not.toHaveBeenCalledWith("M-1", { dryRun: false }, "p1");
    m2.resolve(mission("M-2")); await screen.findByText("Mission two");
  });

  it("releases abandoned busy state but does not let a stale finally clobber a newer request", async () => {
    const oldRequest = deferred<ReturnType<typeof result>>(); const newRequest = deferred<ReturnType<typeof result>>();
    reconcileMission.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    expect(screen.getByTestId("mission-reconcile-now")).toBeDisabled();
    await openM2();
    // The boundary, rather than the old request's finally, releases M-2 immediately.
    expect(screen.getByTestId("mission-reconcile-now")).toBeEnabled();
    fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    expect(screen.getByTestId("mission-reconcile-now")).toBeDisabled();
    oldRequest.resolve(result()); await act(async () => {});
    expect(screen.getByTestId("mission-reconcile-now")).toBeDisabled();
    newRequest.resolve(result()); await screen.findByText(/Feature title — status/);
    expect(screen.getByTestId("mission-reconcile-now")).toBeEnabled();
  });

  it("does not refresh or toast when an abandoned apply resolves or rejects", async () => {
    const apply = deferred<ReturnType<typeof result>>();
    reconcileMission.mockResolvedValueOnce(result()).mockReturnValueOnce(apply.promise);
    const { addToast } = renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await screen.findByTestId("mission-reconcile-apply");
    fireEvent.click(screen.getByTestId("mission-reconcile-apply")); await openM2();
    const callsBefore = fetchMission.mock.calls.filter(([id]) => id === "M-1").length;
    apply.resolve({ ...result(), planned: undefined }); await act(async () => {});
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("Reconciled:"), "success");
    expect(fetchMission.mock.calls.filter(([id]) => id === "M-1")).toHaveLength(callsBefore);

    const rejected = deferred<ReturnType<typeof result>>(); reconcileMission.mockResolvedValueOnce(result()).mockReturnValueOnce(rejected.promise);
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); await screen.findByTestId("mission-reconcile-apply");
    fireEvent.click(screen.getByTestId("mission-reconcile-apply"));
    fireEvent.click(screen.getByRole("button", { name: "Open mission Mission one" }));
    rejected.reject(new Error("stale apply")); await act(async () => {});
    expect(addToast).not.toHaveBeenCalledWith("stale apply", "error");
  });

  it("prevents duplicate preview and apply requests while either request is busy", async () => {
    const preview = deferred<ReturnType<typeof result>>(); const apply = deferred<ReturnType<typeof result>>();
    reconcileMission.mockReturnValueOnce(preview.promise).mockReturnValueOnce(apply.promise);
    renderManager(); await screen.findByText("Feature title"); const button = screen.getByTestId("mission-reconcile-now");
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(button);
    expect(reconcileMission).toHaveBeenCalledTimes(1); expect(button).toBeDisabled();
    preview.resolve(result()); await screen.findByTestId("mission-reconcile-apply");
    const applyButton = screen.getByTestId("mission-reconcile-apply"); fireEvent.click(applyButton); fireEvent.click(applyButton); fireEvent.click(applyButton);
    expect(reconcileMission).toHaveBeenCalledTimes(2); expect(applyButton).toBeDisabled();
    apply.resolve({ ...result(), planned: undefined }); await waitFor(() => expect(screen.queryByTestId("mission-reconcile-apply")).toBeNull());
  });

  it("renders unknown and duplicate planned features without key warnings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reconcileMission.mockResolvedValue(result([{ featureId: "F-missing", action: "status" }, { featureId: "F-1", action: "status" }, { featureId: "F-1", action: "badge-clear" }]));
    renderManager(); await screen.findByText("Feature title"); fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    await screen.findByText(/F-missing — status/); expect(screen.getAllByText(/F-1|Feature title/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Feature title — badge-clear/)).toBeTruthy();
    expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/unique "key"/i)); error.mockRestore();
  });

  it("discards a pending reconcile after deselect and unmount without React warnings", async () => {
    const request = deferred<ReturnType<typeof result>>(); reconcileMission.mockReturnValue(request.promise);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rendered = renderManager(); await screen.findByText("Feature title"); fireEvent.click(screen.getByTestId("mission-reconcile-now"));
    fireEvent.click(screen.getByTestId("mission-back-btn")); request.resolve(result()); await act(async () => {});
    expect(screen.queryByTestId("mission-reconcile-apply")).toBeNull();
    rendered.unmount(); expect(error.mock.calls.join(" ")).not.toMatch(/state update on an unmounted|not wrapped in act/i); error.mockRestore();
  });

  it("does not update or warn after preview or apply promises settle following unmount", async () => {
    const preview = deferred<ReturnType<typeof result>>(); const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reconcileMission.mockReturnValueOnce(preview.promise); const first = renderManager(); await screen.findByText("Feature title");
    fireEvent.click(screen.getByTestId("mission-reconcile-now")); first.unmount(); preview.reject(new Error("gone")); await act(async () => {});
    cleanup();
    const apply = deferred<ReturnType<typeof result>>();
    reconcileMission.mockResolvedValueOnce(result()).mockReturnValueOnce(apply.promise);
    const second = renderManager(); await screen.findByText("Feature title"); fireEvent.click(screen.getByTestId("mission-reconcile-now")); await screen.findByTestId("mission-reconcile-apply");
    fireEvent.click(screen.getByTestId("mission-reconcile-apply")); second.unmount(); apply.resolve({ ...result(), planned: undefined }); await act(async () => {});
    expect(error.mock.calls.join(" ")).not.toMatch(/state update on an unmounted|not wrapped in act/i); error.mockRestore();
  });
});
