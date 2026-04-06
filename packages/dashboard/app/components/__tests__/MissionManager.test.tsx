import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

// Mock data
const mockMissions = [
  {
    id: "M-001",
    title: "Build Auth System",
    description: "Complete authentication flow",
    status: "planning",
    autoAdvance: false,
    milestones: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "M-002",
    title: "API Redesign",
    description: "Redesign the REST API",
    status: "active",
    autoAdvance: true,
    milestones: [],
    summary: {
      totalMilestones: 2,
      completedMilestones: 1,
      totalFeatures: 5,
      completedFeatures: 3,
      progressPercent: 60,
    },
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const mockMissionDetail = {
  id: "M-001",
  title: "Build Auth System",
  description: "Complete authentication flow",
  status: "planning",
  autoAdvance: false,
  milestones: [
    {
      id: "MS-001",
      title: "Database Schema",
      description: "Set up auth tables",
      status: "planning",
      dependencies: [] as string[],
      slices: [
        {
          id: "SL-001",
          title: "User Tables",
          description: "Create user tables",
          status: "pending",
          features: [
            {
              id: "F-001",
              title: "User model",
              description: "Create user model",
              acceptanceCriteria: "Model exists with required fields",
              status: "defined",
              taskId: null,
              sliceId: "SL-001",
              missionId: "M-001",
            },
          ],
          milestoneId: "MS-001",
          missionId: "M-001",
        },
      ],
      missionId: "M-001",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Create a mock Response that matches the real api() function's expectations (text + content-type headers) */
function mockApiResponse(data: unknown) {
  return {
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

/** Fetch mock that returns missions list for /missions and detail for /missions/M-001 */
function createFetchMock() {
  return vi.fn().mockImplementation((_url: string) => {
    return Promise.resolve(mockApiResponse(mockMissions));
  });
}

/** Fetch mock for navigating into a mission detail */
function createDetailFetchMock() {
  let callCount = 0;
  return vi.fn().mockImplementation((_url: string) => {
    callCount++;
    // First call: list, subsequent: detail
    if (callCount === 1) {
      return Promise.resolve(mockApiResponse(mockMissions));
    }
    return Promise.resolve(mockApiResponse(mockMissionDetail));
  });
}

describe("MissionManager", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders nothing when isOpen is false", () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={false} onClose={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByTestId("mission-manager-dialog")).toBeNull();
  });

  it("renders the dialog with accessible attributes when open", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      const dialog = screen.getByTestId("mission-manager-dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-label")).toBe("Mission Manager");
    });
  });

  it("renders the modal overlay with open class", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      const overlay = screen.getByTestId("mission-manager-overlay");
      expect(overlay).toBeDefined();
      expect(overlay.className).toContain("open");
    });
  });

  it("shows the Missions title in list view", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Missions")).toBeDefined();
    });
  });

  it("renders mission items in the list", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
      expect(screen.getByText("API Redesign")).toBeDefined();
    });
  });

  it("shows mission status badges", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("planning")).toBeDefined();
      expect(screen.getByText("active")).toBeDefined();
    });
  });

  it("shows summary stats when mission has summary data", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      // M-002 has summary: { totalMilestones: 2, completedMilestones: 1, totalFeatures: 5, completedFeatures: 3 }
      expect(screen.getByText("1/2 milestones")).toBeDefined();
      expect(screen.getByText("3/5 features")).toBeDefined();
    });
  });

  it("hides summary section for missions without summary data", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      // M-001 has no summary — no stats should appear for it
      expect(screen.queryByText("0/0 milestones")).toBeNull();
    });
    // M-002 has summary so these should exist
    expect(screen.getByText("1/2 milestones")).toBeDefined();
  });

  it("renders progress bar for missions with summary", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      // Progress bar element should exist for M-002 (has summary with progressPercent: 60)
      const progressBar = document.querySelector(".mission-list__item-progress-bar") as HTMLElement;
      expect(progressBar).toBeDefined();
      expect(progressBar?.style.width).toBe("60%");
    });
  });

  it("shows empty state when no missions exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No missions yet. Create one to start planning.")).toBeDefined();
    });
  });

  it("calls onClose when close button is clicked", async () => {
    globalThis.fetch = createFetchMock();
    const onClose = vi.fn();
    render(<MissionManager isOpen={true} onClose={onClose} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-close-btn")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("mission-close-btn"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay background is clicked", async () => {
    globalThis.fetch = createFetchMock();
    const onClose = vi.fn();
    render(<MissionManager isOpen={true} onClose={onClose} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-manager-overlay")).toBeDefined();
    });

    const overlay = screen.getByTestId("mission-manager-overlay");
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("navigates to detail view when a mission is clicked", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Wait for list to load
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });

    // Click on a mission to open detail
    fireEvent.click(screen.getByText("Build Auth System"));

    // Wait for detail view to render
    await waitFor(() => {
      // Back button should appear in detail view
      expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      // Milestone should be visible (auto-expanded)
      expect(screen.getByText("Database Schema")).toBeDefined();
    });
  });

  it("navigates back to list view when back button is clicked", async () => {
    // call 1: list load, call 2: detail load, call 3: re-list load after back
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.resolve(mockApiResponse(mockMissionDetail));
      }
      return Promise.resolve(mockApiResponse(mockMissions));
    });

    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByTestId("mission-back-btn")).toBeDefined();
    });

    // Click back
    fireEvent.click(screen.getByTestId("mission-back-btn"));

    // Should return to list view
    await waitFor(() => {
      expect(screen.getByText("Missions")).toBeDefined();
      expect(screen.getByText("API Redesign")).toBeDefined();
    });
  });

  it("calls onClose on Escape key press", async () => {
    globalThis.fetch = createFetchMock();
    const onClose = vi.fn();
    render(<MissionManager isOpen={true} onClose={onClose} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mission-manager-dialog")).toBeDefined();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows close button with accessible label", async () => {
    globalThis.fetch = createFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Close Mission Manager")).toBeDefined();
    });
  });

  it("shows back button with accessible label in detail view", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      expect(screen.getByLabelText("Back to missions list")).toBeDefined();
    });
  });

  it("shows New Mission button in list view", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse([]));
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("New Mission")).toBeDefined();
    });
  });

  it("shows milestone hierarchy in detail view", async () => {
    globalThis.fetch = createDetailFetchMock();
    render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

    // Navigate to detail
    await waitFor(() => {
      expect(screen.getByText("Build Auth System")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Build Auth System"));

    await waitFor(() => {
      // Milestone is auto-expanded, slice and feature visible
      expect(screen.getByText("Database Schema")).toBeDefined();
      expect(screen.getByText("User Tables")).toBeDefined();
      expect(screen.getByText("User model")).toBeDefined();
    });
  });

  // ── Regression: Generated mission ID format in edit/delete flows ──────────
  //
  // MissionStore generates IDs like M-LZ7DN0-A2B5 (base36 timestamp + random).
  // The MissionManager must successfully edit and delete missions with these IDs
  // without surfacing "invalid ID format" errors.
  describe("generated mission ID format regression", () => {
    // Use realistic generated-style IDs matching what MissionStore produces
    const generatedMissionId = "M-LZ7DN0-A2B5";
    const generatedMilestoneId = "MS-M3N8QR-C9F1";
    const generatedSliceId = "SL-P4T2WX-D5E8";
    const generatedFeatureId = "F-J6K9AB-G7H3";

    const generatedMockMissions = [
      {
        id: generatedMissionId,
        title: "Generated Mission",
        description: "Mission with realistic generated ID",
        status: "planning",
        autoAdvance: false,
        milestones: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const generatedMockDetail = {
      id: generatedMissionId,
      title: "Generated Mission",
      description: "Mission with realistic generated ID",
      status: "planning",
      autoAdvance: false,
      milestones: [
        {
          id: generatedMilestoneId,
          title: "Generated Milestone",
          description: "Milestone with generated ID",
          status: "planning",
          dependencies: [] as string[],
          slices: [
            {
              id: generatedSliceId,
              title: "Generated Slice",
              description: "Slice with generated ID",
              status: "pending",
              features: [
                {
                  id: generatedFeatureId,
                  title: "Generated Feature",
                  description: "Feature with generated ID",
                  acceptanceCriteria: "Works correctly",
                  status: "defined",
                  taskId: null,
                  sliceId: generatedSliceId,
                  missionId: generatedMissionId,
                },
              ],
              milestoneId: generatedMilestoneId,
              missionId: generatedMissionId,
            },
          ],
          missionId: generatedMissionId,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("renders missions with generated IDs in the list", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockApiResponse(generatedMockMissions));
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });
    });

    it("navigates to detail view for a mission with generated ID", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(mockApiResponse(generatedMockMissions));
        }
        return Promise.resolve(mockApiResponse(generatedMockDetail));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Generated Mission"));

      await waitFor(() => {
        expect(screen.getByText("Generated Milestone")).toBeDefined();
        expect(screen.getByText("Generated Slice")).toBeDefined();
        expect(screen.getByText("Generated Feature")).toBeDefined();
      });
    });

    it("edits a mission with generated ID without error", async () => {
      const addToast = vi.fn();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
        callCount++;
        if (callCount <= 1) {
          // Initial list load
          return Promise.resolve(mockApiResponse(generatedMockMissions));
        }
        if (_url && _url.includes("/api/missions/" + generatedMissionId) && !_url.includes("milestones")) {
          // Detail or PATCH for the generated ID mission
          if (_url.includes("/api/missions/" + generatedMissionId) && callCount > 2) {
            // PATCH response — return updated mission
            return Promise.resolve(mockApiResponse({
              ...generatedMockDetail,
              title: "Updated Generated Mission",
              status: "active",
            }));
          }
          return Promise.resolve(mockApiResponse(generatedMockDetail));
        }
        return Promise.resolve(mockApiResponse(generatedMockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={addToast} />);

      // Wait for list, click to enter detail
      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Generated Mission"));

      await waitFor(() => {
        expect(screen.getByText("Generated Milestone")).toBeDefined();
      });
    });

    it("deletes a mission with generated ID without surfacing invalid-ID error", async () => {
      const addToast = vi.fn();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
        callCount++;
        // DELETE request — return 204 empty
        if (options?.method === "DELETE") {
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            text: () => Promise.resolve(""),
          });
        }
        // Initial list load and subsequent reloads
        return Promise.resolve(mockApiResponse(generatedMockMissions));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Generated Mission")).toBeDefined();
      });

      // Click the delete button for the mission (uses title attribute)
      const deleteButton = screen.getByTitle("Delete mission");
      fireEvent.click(deleteButton);

      // After clicking delete, a confirmation dialog should appear
      await waitFor(() => {
        // Find and click the confirm delete button
        const confirmBtn = screen.getByText("Delete");
        fireEvent.click(confirmBtn);
      });

      // Verify no "invalid ID format" toast was shown
      await waitFor(() => {
        const errorToasts = addToast.mock.calls.filter(
          (call: any[]) => call[1] === "error" && typeof call[0] === "string" && call[0].toLowerCase().includes("invalid")
        );
        expect(errorToasts).toHaveLength(0);
      });
    });
  });

  // ── Step 2: Detail hierarchy, action layout, confirm panels ──────────
  describe("detail view hierarchy and action layout", () => {
    it("renders full milestone → slice → feature hierarchy in detail", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        // Milestone auto-expanded
        expect(screen.getByText("Database Schema")).toBeDefined();
        // Slice auto-expanded
        expect(screen.getByText("User Tables")).toBeDefined();
        // Feature visible
        expect(screen.getByText("User model")).toBeDefined();
        // Feature status badge
        expect(screen.getByText("defined")).toBeDefined();
        // Acceptance criteria
        expect(screen.getByText(/Model exists with required fields/)).toBeDefined();
      });
    });

    it("shows edit and delete mission buttons in detail header", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      });

      // Detail header should have edit/delete buttons
      const editBtns = screen.getAllByLabelText("Edit mission");
      const deleteBtns = screen.getAllByLabelText("Delete mission");
      // At least one of each in the detail header area
      expect(editBtns.length).toBeGreaterThanOrEqual(1);
      expect(deleteBtns.length).toBeGreaterThanOrEqual(1);
    });

    it("opens inline edit form when edit mission is clicked in detail view", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mockApiResponse(mockMissions));
        return Promise.resolve(mockApiResponse(mockMissionDetail));
      });

      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      });

      // Click edit mission in detail header
      const editBtns = screen.getAllByLabelText("Edit mission");
      fireEvent.click(editBtns[0]);

      // Should show inline form with pre-filled title
      await waitFor(() => {
        const input = screen.getByDisplayValue("Build Auth System");
        expect(input).toBeDefined();
        expect(screen.getByText("Update")).toBeDefined();
        expect(screen.getByText("Cancel")).toBeDefined();
      });
    });

    it("shows delete confirmation with danger variant class", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByTestId("mission-back-btn")).toBeDefined();
      });

      // Click delete mission in detail header
      const deleteBtns = screen.getAllByLabelText("Delete mission");
      fireEvent.click(deleteBtns[0]);

      // Confirmation panel should show
      await waitFor(() => {
        const confirmPanel = screen.getByText(/Delete this mission/).closest(".mission-confirm-panel");
        expect(confirmPanel).toBeDefined();
        expect(confirmPanel!.className).toContain("mission-confirm-panel--danger");
      });
    });

    it("shows milestone count in detail header meta", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByText("1 milestones")).toBeDefined();
      });
    });

    it("shows slice and feature counts in hierarchy headers", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByText("1 slices")).toBeDefined();
        expect(screen.getByText("1 features")).toBeDefined();
      });
    });

    it("renders milestone expand/collapse chevrons", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        // Milestone is auto-expanded — should see the title visible
        expect(screen.getByText("Database Schema")).toBeDefined();
        // Slice visible (auto-expanded)
        expect(screen.getByText("User Tables")).toBeDefined();
      });
    });

    it("shows add milestone button in detail view", async () => {
      globalThis.fetch = createDetailFetchMock();
      render(<MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} />);

      // Navigate to detail
      await waitFor(() => {
        expect(screen.getByText("Build Auth System")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Build Auth System"));

      await waitFor(() => {
        expect(screen.getByText("Add Milestone")).toBeDefined();
      });
    });
  });
});
