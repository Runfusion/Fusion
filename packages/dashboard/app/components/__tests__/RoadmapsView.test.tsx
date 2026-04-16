import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoadmapsView } from "../RoadmapsView";
import * as api from "../../api";
import type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapWithHierarchy,
} from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchRoadmaps: vi.fn(),
  fetchRoadmap: vi.fn(),
  createRoadmap: vi.fn(),
  updateRoadmap: vi.fn(),
  deleteRoadmap: vi.fn(),
  createRoadmapMilestone: vi.fn(),
  updateRoadmapMilestone: vi.fn(),
  deleteRoadmapMilestone: vi.fn(),
  createRoadmapFeature: vi.fn(),
  updateRoadmapFeature: vi.fn(),
  deleteRoadmapFeature: vi.fn(),
  reorderRoadmapMilestones: vi.fn(),
  reorderRoadmapFeatures: vi.fn(),
  moveRoadmapFeature: vi.fn(),
  generateFeatureSuggestions: vi.fn(),
  generateMilestoneSuggestions: vi.fn(),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Plus: ({ size, ...props }: { size?: number }) => (
    <svg data-testid="plus-icon" {...props}>{`Plus ${size || 16}`}</svg>
  ),
  Pencil: (props: unknown) => <span data-testid="pencil-icon" {...props}>Edit</span>,
  Trash2: (props: unknown) => <span data-testid="trash-icon" {...props}>Delete</span>,
  Check: (props: unknown) => <span data-testid="check-icon" {...props}>Check</span>,
  X: (props: unknown) => <span data-testid="x-icon" {...props}>X</span>,
  GripVertical: (props: unknown) => <span data-testid="grip-icon" {...props}>Grip</span>,
  Sparkles: (props: unknown) => <span data-testid="sparkles-icon" {...props}>Sparkles</span>,
  Download: (props: unknown) => <span data-testid="download-icon" {...props}>Download</span>,
  Copy: (props: unknown) => <span data-testid="copy-icon" {...props}>Copy</span>,
  Loader: (props: unknown) => <span data-testid="loader-icon" {...props}>Loader</span>,
  ArrowLeft: (props: unknown) => <span data-testid="arrow-left-icon" {...props}>ArrowLeft</span>,
  ChevronLeft: (props: unknown) => <span data-testid="chevron-left-icon" {...props}>ChevronLeft</span>,
  ChevronUp: (props: unknown) => <span data-testid="chevron-up-icon" {...props}>ChevronUp</span>,
}));

// Viewport mode mock helper
function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

const mockRoadmaps: Roadmap[] = [
  {
    id: "RM-001",
    title: "Q2 Roadmap",
    description: "Q2 product roadmap",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "RM-002",
    title: "Q3 Roadmap",
    description: "Q3 product roadmap",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const mockRoadmapHierarchy: RoadmapWithHierarchy = {
  id: "RM-001",
  title: "Q2 Roadmap",
  description: "Q2 product roadmap",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  milestones: [
    {
      id: "RMS-001",
      roadmapId: "RM-001",
      title: "Milestone 1",
      description: "First milestone",
      orderIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      features: [
        {
          id: "RF-001",
          milestoneId: "RMS-001",
          title: "Feature 1",
          description: "First feature",
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    {
      id: "RMS-002",
      roadmapId: "RM-001",
      title: "Milestone 2",
      description: "Second milestone",
      orderIndex: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      features: [],
    },
  ],
};

const mockAddToast = vi.fn();

describe("RoadmapsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewport("desktop");
    (api.fetchRoadmaps as ReturnType<typeof vi.fn>).mockResolvedValue(mockRoadmaps);
    (api.fetchRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(mockRoadmapHierarchy);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders roadmap list in sidebar", async () => {
    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });
    expect(screen.getByText("Q3 Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Roadmaps")).toBeInTheDocument();
  });

  it("shows empty state when no roadmaps exist", async () => {
    (api.fetchRoadmaps as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("No roadmaps yet. Click + to create one.")).toBeInTheDocument();
    });
  });

  it("shows loading state initially", async () => {
    render(<RoadmapsView addToast={mockAddToast} />);

    expect(screen.getByText("Loading roadmaps...")).toBeInTheDocument();
  });

  it("selects a roadmap and shows its content", async () => {
    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      expect(screen.getByTestId("edit-roadmap-btn")).toBeInTheDocument();
    });

    // Should show milestones
    expect(screen.getByText("Milestone 1")).toBeInTheDocument();
    expect(screen.getByText("Milestone 2")).toBeInTheDocument();
  });

  it("creates a new roadmap", async () => {
    const newRoadmap = {
      id: "RM-003",
      title: "New Roadmap",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    (api.createRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(newRoadmap);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    // Click create button
    const createBtn = screen.getByTestId("create-roadmap-btn");
    fireEvent.click(createBtn);

    // Fill in the form
    const titleInput = screen.getByTestId("create-roadmap-title");
    await userEvent.type(titleInput, "New Roadmap");

    // Submit
    const submitBtn = screen.getByTestId("create-roadmap-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.createRoadmap).toHaveBeenCalledWith(
        { title: "New Roadmap" },
        undefined
      );
      expect(mockAddToast).toHaveBeenCalledWith("Roadmap created", "success");
    });
  });

  it("edits a roadmap title inline", async () => {
    (api.updateRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockRoadmaps[0],
      title: "Updated Title",
    });

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    // Select the roadmap first
    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("edit-roadmap-btn")).toBeInTheDocument();
    });

    // Click edit button
    const editBtn = screen.getByTestId("edit-roadmap-btn");
    fireEvent.click(editBtn);

    // Should show input field
    const titleInput = screen.getByTestId("roadmap-title-input");
    expect(titleInput).toBeInTheDocument();

    // Type new title
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Updated Title");

    // Save
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(api.updateRoadmap).toHaveBeenCalledWith("RM-001", { title: "Updated Title" }, undefined);
    });
  });

  it("deletes a roadmap after confirmation", async () => {
    (api.deleteRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    // Select the roadmap first
    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("delete-roadmap-btn")).toBeInTheDocument();
    });

    // Click delete button
    const deleteBtn = screen.getByTestId("delete-roadmap-btn");
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(api.deleteRoadmap).toHaveBeenCalledWith("RM-001", undefined);
      expect(mockAddToast).toHaveBeenCalledWith("Roadmap deleted", "success");
    });
  });

  it("cancels roadmap deletion when not confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("delete-roadmap-btn")).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTestId("delete-roadmap-btn");
    fireEvent.click(deleteBtn);

    expect(api.deleteRoadmap).not.toHaveBeenCalled();
  });

  it("shows empty milestones state", async () => {
    const emptyHierarchy: RoadmapWithHierarchy = {
      ...mockRoadmapHierarchy,
      milestones: [],
    };
    (api.fetchRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(emptyHierarchy);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByText("This roadmap has no milestones.")).toBeInTheDocument();
    });
  });

  it("shows empty features state for a milestone", async () => {
    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByText("Milestone 2")).toBeInTheDocument();
    });

    // Milestone 2 has no features
    const milestone2 = screen.getByTestId("add-feature-RMS-002").closest(".roadmaps-view__milestone");
    expect(milestone2?.textContent).toContain("No features yet.");
  });

  it("creates a milestone", async () => {
    const newMilestone: RoadmapMilestone = {
      id: "RMS-003",
      roadmapId: "RM-001",
      title: "New Milestone",
      orderIndex: 2,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    (api.createRoadmapMilestone as ReturnType<typeof vi.fn>).mockResolvedValue(newMilestone);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("add-milestone-btn")).toBeInTheDocument();
    });

    // Click add milestone button
    const addBtn = screen.getByTestId("add-milestone-btn");
    fireEvent.click(addBtn);

    // Fill in the form
    const titleInput = screen.getByTestId("create-milestone-title");
    await userEvent.type(titleInput, "New Milestone");

    // Submit
    const submitBtn = screen.getByTestId("create-milestone-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.createRoadmapMilestone).toHaveBeenCalledWith("RM-001", { title: "New Milestone" }, undefined);
      expect(mockAddToast).toHaveBeenCalledWith("Milestone created", "success");
    });
  });

  it("deletes a milestone after confirmation", async () => {
    (api.deleteRoadmapMilestone as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("milestone-delete-RMS-001")).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTestId("milestone-delete-RMS-001");
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(api.deleteRoadmapMilestone).toHaveBeenCalledWith("RMS-001", undefined);
      expect(mockAddToast).toHaveBeenCalledWith("Milestone deleted", "success");
    });
  });

  it("creates a feature in a milestone", async () => {
    const newFeature: RoadmapFeature = {
      id: "RF-002",
      milestoneId: "RMS-001",
      title: "New Feature",
      orderIndex: 1,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    (api.createRoadmapFeature as ReturnType<typeof vi.fn>).mockResolvedValue(newFeature);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("add-feature-RMS-001")).toBeInTheDocument();
    });

    // Click add feature button
    const addBtn = screen.getByTestId("add-feature-RMS-001");
    fireEvent.click(addBtn);

    // Fill in the form
    const titleInput = screen.getByTestId("create-feature-title");
    await userEvent.type(titleInput, "New Feature");

    // Submit
    const submitBtn = screen.getByTestId("create-feature-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.createRoadmapFeature).toHaveBeenCalledWith("RMS-001", { title: "New Feature" }, undefined);
      expect(mockAddToast).toHaveBeenCalledWith("Feature created", "success");
    });
  });

  it("deletes a feature after confirmation", async () => {
    (api.deleteRoadmapFeature as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("feature-delete-RF-001")).toBeInTheDocument();
    });

    // Hover over feature to show actions
    const featureItem = screen.getByTestId("feature-delete-RF-001").closest(".roadmaps-view__feature-item");
    fireEvent.mouseEnter(featureItem!);

    const deleteBtn = screen.getByTestId("feature-delete-RF-001");
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(api.deleteRoadmapFeature).toHaveBeenCalledWith("RF-001", undefined);
      expect(mockAddToast).toHaveBeenCalledWith("Feature deleted", "success");
    });
  });

  it("cancels inline edit on Escape", async () => {
    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
    fireEvent.click(roadmapItem);

    await waitFor(() => {
      expect(screen.getByTestId("edit-roadmap-btn")).toBeInTheDocument();
    });

    // Start editing
    const editBtn = screen.getByTestId("edit-roadmap-btn");
    fireEvent.click(editBtn);

    const titleInput = screen.getByTestId("roadmap-title-input");
    expect(titleInput).toBeInTheDocument();

    // Type something
    await userEvent.type(titleInput, "Changed");

    // Cancel with Escape
    fireEvent.keyDown(titleInput, { key: "Escape" });

    // Edit should be cancelled
    await waitFor(() => {
      expect(screen.queryByTestId("roadmap-title-input")).not.toBeInTheDocument();
    });
    expect(api.updateRoadmap).not.toHaveBeenCalled();
  });

  it("shows empty main state when no roadmap selected", async () => {
    render(<RoadmapsView addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
    });

    expect(screen.getByText("Select a roadmap from the sidebar to view its milestones.")).toBeInTheDocument();
  });

  describe("Feature suggestions", () => {
    it("shows AI Suggestions button when roadmap is selected", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      // Wait for roadmap to load
      await waitFor(() => {
        expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      });

      // Select roadmap
      const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
      fireEvent.click(roadmapItem);

      // Wait for milestone to load and button to appear
      await waitFor(() => {
        expect(screen.getByTestId("generate-features-RMS-001")).toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });

  describe("Suggestion editing", () => {
    it("can edit milestone suggestion before accepting", async () => {
      // Mock milestone suggestion generation
      (api.generateMilestoneSuggestions as ReturnType<typeof vi.fn>).mockResolvedValue({
        suggestions: [
          { title: "Original Title", description: "Original description" },
        ],
      });

      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      });

      // Select roadmap
      const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
      fireEvent.click(roadmapItem);

      // Wait for roadmap to load
      await waitFor(() => {
        expect(screen.getByText("Generate Milestone Ideas")).toBeInTheDocument();
      });

      // Generate suggestions
      const goalInput = screen.getByTestId("goal-prompt-input");
      await userEvent.type(goalInput, "Build an app");

      const generateBtn = screen.getByTestId("generate-suggestions-btn");
      fireEvent.click(generateBtn);

      // Wait for suggestion to appear
      await waitFor(() => {
        expect(screen.getByText("Original Title")).toBeInTheDocument();
      });

      // This test verifies the suggestion appears after generation
      expect(screen.getByText("Original Title")).toBeInTheDocument();
    });

    it("can edit feature suggestion before accepting", async () => {
      // Mock feature suggestion generation
      (api.generateFeatureSuggestions as ReturnType<typeof vi.fn>).mockResolvedValue({
        suggestions: [
          { title: "Feature Suggestion", description: "Feature description" },
        ],
      });

      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      });

      // Select roadmap
      const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
      fireEvent.click(roadmapItem);

      // Wait for milestone to load
      await waitFor(() => {
        expect(screen.getByTestId("generate-features-RMS-001")).toBeInTheDocument();
      });

      // Generate feature suggestions
      const suggestBtn = screen.getByTestId("generate-features-RMS-001");
      fireEvent.click(suggestBtn);

      // Wait for suggestion to appear
      await waitFor(() => {
        expect(screen.getByText("Feature Suggestion")).toBeInTheDocument();
      });

      // Verify the suggestion card is rendered
      expect(screen.getByText("Feature Suggestion")).toBeInTheDocument();
      expect(screen.getByText("Feature description")).toBeInTheDocument();
    });

    it("shows edit button on suggestion cards", async () => {
      // Mock milestone suggestion generation
      (api.generateMilestoneSuggestions as ReturnType<typeof vi.fn>).mockResolvedValue({
        suggestions: [
          { title: "Test Milestone" },
        ],
      });

      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      });

      // Select roadmap
      const roadmapItem = screen.getByTestId("roadmap-item-RM-001");
      fireEvent.click(roadmapItem);

      // Generate suggestions
      const goalInput = screen.getByTestId("goal-prompt-input");
      await userEvent.type(goalInput, "Build something");

      const generateBtn = screen.getByTestId("generate-suggestions-btn");
      fireEvent.click(generateBtn);

      // Wait for suggestion to appear
      await waitFor(() => {
        expect(screen.getByText("Test Milestone")).toBeInTheDocument();
      });

      // Look for edit button - it should have data-testid
      // The edit button is a pencil icon with testId like "suggestion-{id}-edit"
      const editButtons = screen.queryAllByRole("button", { name: /edit/i });
      expect(editButtons.length).toBeGreaterThan(0);
    });

    it("sidebar edit pencil selects the roadmap and shows inline edit", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      });

      // No roadmap selected yet — main content shows empty state
      expect(screen.getByText("Select a roadmap from the sidebar to view its milestones.")).toBeInTheDocument();

      // Click the edit pencil on RM-001 in the sidebar
      const editBtn = screen.getByTestId("roadmap-edit-RM-001");
      fireEvent.click(editBtn);

      // Roadmap should be selected and inline edit should appear
      await waitFor(() => {
        expect(screen.getByTestId("roadmap-title-input")).toBeInTheDocument();
      });
    });
  });

  describe("Mobile roadmap controls", () => {
    beforeEach(() => {
      mockViewport("mobile");
    });

    afterEach(() => {
      mockViewport("desktop");
    });

    it("shows mobile roadmap list when no roadmap selected on mobile", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-list")).toBeInTheDocument();
      });

      expect(screen.getByText("Q2 Roadmap")).toBeInTheDocument();
      expect(screen.getByText("Q3 Roadmap")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-create-roadmap-btn")).toBeInTheDocument();
    });

    it("shows mobile roadmap items when roadmaps exist on mobile", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      expect(screen.getByTestId("mobile-roadmap-item-RM-002")).toBeInTheDocument();
    });

    it("can select a roadmap from mobile list", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Click on a roadmap item
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // Should show the mobile header with the roadmap title
      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-header")).toBeInTheDocument();
        expect(screen.getByText("Q2 Roadmap", { selector: ".roadmaps-view__mobile-header-title" })).toBeInTheDocument();
      });
    });

    it("mobile back button deselects roadmap", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select a roadmap
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-header")).toBeInTheDocument();
      });

      // Click back button
      fireEvent.click(screen.getByTestId("mobile-back-btn"));

      // Should show mobile list again
      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-list")).toBeInTheDocument();
      });
    });

    it("mobile create button shows create form", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-create-roadmap-btn")).toBeInTheDocument();
      });

      // Click create button
      fireEvent.click(screen.getByTestId("mobile-create-roadmap-btn"));

      // Should show create form
      await waitFor(() => {
        expect(screen.getByTestId("create-roadmap-form")).toBeInTheDocument();
        expect(screen.getByTestId("create-roadmap-title")).toBeInTheDocument();
      });
    });

    it("mobile can create roadmap via form", async () => {
      const newRoadmap = {
        id: "RM-003",
        title: "New Roadmap",
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      };
      (api.createRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(newRoadmap);

      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-create-roadmap-btn")).toBeInTheDocument();
      });

      // Click create button
      fireEvent.click(screen.getByTestId("mobile-create-roadmap-btn"));

      // Fill in the form using userEvent for better React integration
      await waitFor(() => {
        const titleInput = screen.getByTestId("create-roadmap-title");
        expect(titleInput).toBeInTheDocument();
      });

      const titleInput = screen.getByTestId("create-roadmap-title");
      await userEvent.type(titleInput, "New Roadmap");

      // Submit the form using fireEvent.submit
      const form = screen.getByTestId("create-roadmap-form").querySelector("form");
      expect(form).toBeTruthy();
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(api.createRoadmap).toHaveBeenCalledWith(
          { title: "New Roadmap" },
          undefined
        );
        expect(mockAddToast).toHaveBeenCalledWith("Roadmap created", "success");
      });
    });

    it("mobile edit and delete buttons are visible on roadmap items", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Edit and delete buttons should be visible (not hidden behind hover on mobile)
      expect(screen.getByTestId("mobile-roadmap-edit-RM-001")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-roadmap-delete-RM-001")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-roadmap-export-RM-001")).toBeInTheDocument();
    });

    it("shows empty state on mobile when no roadmaps", async () => {
      (api.fetchRoadmaps as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-list")).toBeInTheDocument();
      });

      expect(screen.getByText("No roadmaps yet.")).toBeInTheDocument();
      expect(screen.getByTestId("roadmaps-view__mobile-list").textContent).toContain("Create Roadmap");
    });

    it("mobile header shows action buttons when roadmap selected", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select a roadmap
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-header")).toBeInTheDocument();
      });

      // Action buttons should be visible in header
      expect(screen.getByTestId("mobile-header-create-btn")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-header-edit-btn")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-header-delete-btn")).toBeInTheDocument();
      expect(screen.getByTestId("mobile-back-btn")).toBeInTheDocument();
    });

    it("mobile edit pencil selects the roadmap and shows inline edit", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Click the edit pencil on RM-001 in mobile list
      const editBtn = screen.getByTestId("mobile-roadmap-edit-RM-001");
      fireEvent.click(editBtn);

      // Should show the mobile header (roadmap selected) and inline edit
      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-header")).toBeInTheDocument();
        expect(screen.getByTestId("roadmap-title-input")).toBeInTheDocument();
      });
    });

    it("mobile roadmap list has scrollable container structure", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-list")).toBeInTheDocument();
      });

      // The mobile list should have the scrollable container
      const mobileList = screen.getByTestId("roadmaps-view__mobile-list");
      expect(mobileList).toBeInTheDocument();

      // The list items container should exist and be scrollable
      const listItems = mobileList.querySelector(".roadmaps-view__mobile-list-items");
      expect(listItems).toBeInTheDocument();
    });

    it("selecting roadmap on mobile shows detail view with header and milestone content", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Click on a roadmap item
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // Should show the mobile header with back button
      await waitFor(() => {
        expect(screen.getByTestId("roadmaps-view__mobile-header")).toBeInTheDocument();
        expect(screen.getByTestId("mobile-back-btn")).toBeInTheDocument();
      });

      // Should show milestone content
      expect(screen.getByText("Milestone 1")).toBeInTheDocument();
      expect(screen.getByText("Milestone 2")).toBeInTheDocument();
    });
  });

  describe("Mobile suggestion panel collapse", () => {
    beforeEach(() => {
      mockViewport("mobile");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("shows expand button instead of suggestion section on mobile", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select roadmap
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // On mobile, should show the expand button instead of the goal prompt input
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("goal-prompt-input")).not.toBeInTheDocument();
    });

    it("expands suggestion panel on mobile when button is clicked", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select roadmap
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // Expand the panel
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("expand-suggestion-panel-btn"));

      // Panel should now be visible
      await waitFor(() => {
        expect(screen.getByTestId("goal-prompt-input")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("expand-suggestion-panel-btn")).not.toBeInTheDocument();
    });

    it("can collapse suggestion panel on mobile", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select roadmap
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // Expand the panel
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("expand-suggestion-panel-btn"));

      // Wait for panel to expand
      await waitFor(() => {
        expect(screen.getByTestId("goal-prompt-input")).toBeInTheDocument();
      });

      // Collapse the panel
      fireEvent.click(screen.getByTestId("collapse-suggestion-panel-btn"));

      // Panel should be hidden, expand button should be back
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("goal-prompt-input")).not.toBeInTheDocument();
    });

    it("persists goal prompt and suggestions across collapse/expand on mobile", async () => {
      // Mock milestone suggestion generation
      (api.generateMilestoneSuggestions as ReturnType<typeof vi.fn>).mockResolvedValue({
        suggestions: [
          { title: "Persisted Milestone", description: "Persisted description" },
        ],
      });

      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select roadmap
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // Expand the panel
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("expand-suggestion-panel-btn"));

      // Type into goal prompt
      await waitFor(() => {
        expect(screen.getByTestId("goal-prompt-input")).toBeInTheDocument();
      });
      const goalInput = screen.getByTestId("goal-prompt-input");
      await userEvent.type(goalInput, "Build an app");

      // Generate suggestions
      fireEvent.click(screen.getByTestId("generate-suggestions-btn"));

      // Wait for suggestions to appear
      await waitFor(() => {
        expect(screen.getByText("Persisted Milestone")).toBeInTheDocument();
      });

      // Collapse the panel
      fireEvent.click(screen.getByTestId("collapse-suggestion-panel-btn"));

      // Wait for expand button to appear
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });

      // Re-expand the panel
      fireEvent.click(screen.getByTestId("expand-suggestion-panel-btn"));

      // Goal prompt and suggestions should persist
      await waitFor(() => {
        expect(screen.getByTestId("goal-prompt-input")).toBeInTheDocument();
      });
      expect(screen.getByTestId("goal-prompt-input")).toHaveValue("Build an app");
      expect(screen.getByText("Persisted Milestone")).toBeInTheDocument();
    });

    it("resets suggestion panel when switching roadmaps on mobile", async () => {
      render(<RoadmapsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-001")).toBeInTheDocument();
      });

      // Select RM-001
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-001"));

      // Expand the panel
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("expand-suggestion-panel-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("goal-prompt-input")).toBeInTheDocument();
      });

      // Go back to roadmap list
      fireEvent.click(screen.getByTestId("mobile-back-btn"));

      // Wait for list to appear
      await waitFor(() => {
        expect(screen.getByTestId("mobile-roadmap-item-RM-002")).toBeInTheDocument();
      });

      // Switch to RM-002
      fireEvent.click(screen.getByTestId("mobile-roadmap-item-RM-002"));

      // Panel should be collapsed (expand button visible)
      await waitFor(() => {
        expect(screen.getByTestId("expand-suggestion-panel-btn")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("goal-prompt-input")).not.toBeInTheDocument();
    });
  });
});
