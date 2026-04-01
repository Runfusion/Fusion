import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:readline/promises before importing the module under test
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

// Mock @fusion/core before importing the module under test
vi.mock("@fusion/core", () => {
  return {
    MissionStore: vi.fn(),
    COLUMNS: ["triage", "todo", "in-progress", "in-review", "done", "archived"],
    COLUMN_LABELS: {
      triage: "Triage",
      todo: "Todo",
      "in-progress": "In Progress",
      "in-review": "In Review",
      done: "Done",
      archived: "Archived",
    },
  };
});

// Mock project-resolver
vi.mock("../project-resolver.js", () => ({
  getStore: vi.fn().mockResolvedValue({
    getMissionStore: vi.fn().mockReturnValue({}),
  }),
}));

import { createInterface } from "node:readline/promises";
import { getStore } from "../project-resolver.js";

// Import after mocks
const {
  runMissionCreate,
  runMissionList,
  runMissionShow,
  runMissionDelete,
  runMissionActivateSlice,
} = await import("./mission.js");

// Helper to mock console output
function captureConsole() {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  return {
    logs,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// Helper to create mock MissionStore
function createMockMissionStore(overrides = {}) {
  return {
    createMission: vi.fn().mockReturnValue({
      id: "M-001",
      title: "Test Mission",
      status: "planning",
      description: "Test description",
    }),
    listMissions: vi.fn().mockReturnValue([
      { id: "M-001", title: "Mission 1", status: "active" },
      { id: "M-002", title: "Mission 2", status: "planning" },
    ]),
    getMissionWithHierarchy: vi.fn().mockReturnValue({
      id: "M-001",
      title: "Test Mission",
      status: "active",
      description: "Test description",
      milestones: [
        {
          id: "MS-001",
          title: "Milestone 1",
          status: "active",
          slices: [
            {
              id: "SL-001",
              title: "Slice 1",
              status: "active",
              features: [
                { id: "F-001", title: "Feature 1", status: "done", taskId: "FN-001" },
              ],
            },
          ],
        },
      ],
    }),
    getMission: vi.fn().mockReturnValue({
      id: "M-001",
      title: "Test Mission",
      status: "active",
    }),
    deleteMission: vi.fn(),
    getSlice: vi.fn().mockReturnValue({
      id: "SL-001",
      title: "Test Slice",
      status: "pending",
    }),
    activateSlice: vi.fn().mockReturnValue({
      id: "SL-001",
      title: "Test Slice",
      status: "active",
      activatedAt: "2026-04-01T00:00:00Z",
    }),
    ...overrides,
  };
}

describe("mission commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runMissionCreate", () => {
    it("creates mission with correct data", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        await runMissionCreate("Test Mission", "Test description");

        expect(mockMissionStore.createMission).toHaveBeenCalledWith({
          title: "Test Mission",
          description: "Test description",
        });
        expect(consoleCapture.logs).toContain("  ✓ Created M-001: Test Mission");
      } finally {
        consoleCapture.restore();
      }
    });

    it("creates mission with title only (no description)", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        await runMissionCreate("Test Mission", undefined);

        expect(mockMissionStore.createMission).toHaveBeenCalledWith({
          title: "Test Mission",
          description: undefined,
        });
      } finally {
        consoleCapture.restore();
      }
    });

    it("prompts interactively when title not provided", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockRl = {
        question: vi.fn()
          .mockResolvedValueOnce("Interactive Title")
          .mockResolvedValueOnce("Interactive Description"),
        close: vi.fn(),
      };
      vi.mocked(createInterface).mockReturnValue(mockRl as any);

      const consoleCapture = captureConsole();

      try {
        await runMissionCreate(undefined, undefined);

        expect(createInterface).toHaveBeenCalled();
        expect(mockRl.question).toHaveBeenCalledWith("Mission title: ");
        expect(mockMissionStore.createMission).toHaveBeenCalledWith({
          title: "Interactive Title",
          description: "Interactive Description",
        });
      } finally {
        consoleCapture.restore();
      }
    });

    it("exits with error when interactive title is empty", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockRl = {
        question: vi.fn().mockResolvedValueOnce(""), // Empty title
        close: vi.fn(),
      };
      vi.mocked(createInterface).mockReturnValue(mockRl as any);

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await runMissionCreate(undefined, undefined);
      } catch (e) {
        // Expected
      }

      expect(mockError).toHaveBeenCalledWith("Title is required");
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });

  describe("runMissionList", () => {
    it("displays missions in formatted output", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        // Override process.exit for this test
        const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
          throw new Error("process.exit");
        });

        try {
          await runMissionList();
        } catch (e) {
          // Expected process.exit(0)
        }

        expect(mockMissionStore.listMissions).toHaveBeenCalled();
        expect(consoleCapture.logs.some(log => log.includes("Mission 1"))).toBe(true);
        expect(consoleCapture.logs.some(log => log.includes("Mission 2"))).toBe(true);

        mockExit.mockRestore();
      } finally {
        consoleCapture.restore();
      }
    });

    it("shows empty message when no missions", async () => {
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([]),
      });
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
          throw new Error("process.exit");
        });

        try {
          await runMissionList();
        } catch (e) {
          // Expected
        }

        expect(consoleCapture.logs.some(log => log.includes("No missions yet"))).toBe(true);

        mockExit.mockRestore();
      } finally {
        consoleCapture.restore();
      }
    });
  });

  describe("runMissionShow", () => {
    it("displays hierarchy correctly", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        await runMissionShow("M-001");

        expect(mockMissionStore.getMissionWithHierarchy).toHaveBeenCalledWith("M-001");
        expect(consoleCapture.logs.some(log => log.includes("Test Mission"))).toBe(true);
        expect(consoleCapture.logs.some(log => log.includes("Milestone 1"))).toBe(true);
        expect(consoleCapture.logs.some(log => log.includes("Slice 1"))).toBe(true);
        expect(consoleCapture.logs.some(log => log.includes("Feature 1"))).toBe(true);
      } finally {
        consoleCapture.restore();
      }
    });

    it("exits with error when mission not found", async () => {
      const mockMissionStore = createMockMissionStore({
        getMissionWithHierarchy: vi.fn().mockReturnValue(undefined),
      });
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await runMissionShow("M-999");
      } catch (e) {
        // Expected
      }

      expect(mockError).toHaveBeenCalledWith("Mission M-999 not found");
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });

    it("exits with error when id not provided", async () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await runMissionShow("");
      } catch (e) {
        // Expected
      }

      expect(mockError).toHaveBeenCalledWith("Usage: fn mission show <id>");
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });

  describe("runMissionDelete", () => {
    it("requires confirmation without --force", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockRl = {
        question: vi.fn().mockResolvedValueOnce("n"), // User says no
        close: vi.fn(),
      };
      vi.mocked(createInterface).mockReturnValue(mockRl as any);

      const consoleCapture = captureConsole();
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        try {
          await runMissionDelete("M-001", false);
        } catch (e) {
          // Expected
        }

        expect(mockRl.question).toHaveBeenCalledWith(
          expect.stringContaining("Are you sure you want to delete")
        );
        expect(mockMissionStore.deleteMission).not.toHaveBeenCalled();
      } finally {
        consoleCapture.restore();
        mockExit.mockRestore();
      }
    });

    it("deletes mission with --force", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        await runMissionDelete("M-001", true);

        expect(mockMissionStore.deleteMission).toHaveBeenCalledWith("M-001");
        expect(consoleCapture.logs.some(log => log.includes("Deleted M-001"))).toBe(true);
      } finally {
        consoleCapture.restore();
      }
    });

    it("exits with error when mission not found", async () => {
      const mockMissionStore = createMockMissionStore({
        getMission: vi.fn().mockReturnValue(undefined),
      });
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await runMissionDelete("M-999", true);
      } catch (e) {
        // Expected
      }

      expect(mockError).toHaveBeenCalledWith("✗ Mission M-999 not found");
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });

  describe("runMissionActivateSlice", () => {
    it("calls MissionStore.activateSlice()", async () => {
      const mockMissionStore = createMockMissionStore();
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const consoleCapture = captureConsole();

      try {
        await runMissionActivateSlice("SL-001");

        expect(mockMissionStore.getSlice).toHaveBeenCalledWith("SL-001");
        expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-001");
        expect(consoleCapture.logs.some(log => log.includes("Activated SL-001"))).toBe(true);
      } finally {
        consoleCapture.restore();
      }
    });

    it("exits with error when slice not found", async () => {
      const mockMissionStore = createMockMissionStore({
        getSlice: vi.fn().mockReturnValue(undefined),
      });
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await runMissionActivateSlice("SL-999");
      } catch (e) {
        // Expected
      }

      expect(mockError).toHaveBeenCalledWith("✗ Slice SL-999 not found");
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });

    it("exits with error when slice is not pending", async () => {
      const mockMissionStore = createMockMissionStore({
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", status: "active" }),
      });
      vi.mocked(getStore).mockResolvedValue({
        getMissionStore: () => mockMissionStore,
      } as any);

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await runMissionActivateSlice("SL-001");
      } catch (e) {
        // Expected
      }

      expect(mockError).toHaveBeenCalledWith("✗ Slice SL-001 is not pending (status: active)");
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });
});
