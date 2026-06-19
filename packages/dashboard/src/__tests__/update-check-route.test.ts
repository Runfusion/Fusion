// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { get as performGet, request as performRequest } from "../test-request.js";

const updateCheckMocks = vi.hoisted(() => ({
  performUpdateCheck: vi.fn(),
  performUpdateInstall: vi.fn(),
}));

vi.mock("../update-check.js", async () => {
  const actual = await vi.importActual<typeof import("../update-check.js")>("../update-check.js");
  return {
    ...actual,
    performUpdateCheck: updateCheckMocks.performUpdateCheck,
    performUpdateInstall: updateCheckMocks.performUpdateInstall,
  };
});

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    resolveGlobalDir: () => "/tmp/fusion-update-check-route-test",
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_VERSION = (() => {
  const packageJsonPath = join(__dirname, "..", "..", "..", "cli", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version?: unknown;
  };

  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
})();

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

afterEach(() => {
  updateCheckMocks.performUpdateCheck.mockReset();
  updateCheckMocks.performUpdateInstall.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/update-check/install", () => {
  it("installs when a newer version is available", async () => {
    updateCheckMocks.performUpdateCheck.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
      lastChecked: 123,
    });
    updateCheckMocks.performUpdateInstall.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updated: true,
    });

    const app = createServer(createMockStore());
    const response = await performRequest(app, "POST", "/api/update-check/install");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateCheck).toHaveBeenCalledWith(expect.any(String), CLI_PACKAGE_VERSION, {
      force: true,
    });
    expect(updateCheckMocks.performUpdateInstall).toHaveBeenCalledWith(CLI_PACKAGE_VERSION, "99.0.0", {
      fusionDir: expect.any(String),
    });
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updated: true,
    });
  });

  it("returns updated=false without installing when already up to date", async () => {
    updateCheckMocks.performUpdateCheck.mockResolvedValueOnce({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: CLI_PACKAGE_VERSION,
      updateAvailable: false,
      lastChecked: 123,
    });

    const app = createServer(createMockStore());
    const response = await performRequest(app, "POST", "/api/update-check/install");

    expect(response.status).toBe(200);
    expect(updateCheckMocks.performUpdateInstall).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: CLI_PACKAGE_VERSION,
      updated: false,
    });
  });
});

describe("GET /api/updates/check", () => {
  it("returns updateAvailable=true when npm has a newer version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "99.0.0" }),
      }),
    );

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/updates/check");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
    });
  });

  it("returns updateAvailable=false when already up to date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: CLI_PACKAGE_VERSION }),
      }),
    );

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/updates/check");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: CLI_PACKAGE_VERSION,
      updateAvailable: false,
    });
  });

  it("gracefully returns an error payload when npm registry is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const app = createServer(createMockStore());
    const response = await performGet(app, "/api/updates/check");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      currentVersion: CLI_PACKAGE_VERSION,
      latestVersion: null,
      updateAvailable: false,
      error: "Failed to check for updates",
    });
  });
});
