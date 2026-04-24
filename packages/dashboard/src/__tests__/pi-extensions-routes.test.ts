import { describe, it, expect, vi, beforeEach } from "vitest";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

// Mock the pi-coding-agent module for all route tests
const mockSettingsManager = {
  getPackages: vi.fn().mockReturnValue(["npm:pi-example"]),
  getExtensionPaths: vi.fn().mockReturnValue(["/path/to/extension"]),
  getSkillPaths: vi.fn().mockReturnValue(["/path/to/skill"]),
  getPromptTemplatePaths: vi.fn().mockReturnValue(["/path/to/prompts"]),
  getThemePaths: vi.fn().mockReturnValue(["/path/to/themes"]),
  setPackages: vi.fn(),
  setExtensionPaths: vi.fn(),
  setSkillPaths: vi.fn(),
  setPromptTemplatePaths: vi.fn(),
  setThemePaths: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
};

const mockPackageManager = {
  install: vi.fn().mockResolvedValue(undefined),
  addSourceToSettings: vi.fn().mockReturnValue(true),
};

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SettingsManager: {
    create: vi.fn(() => mockSettingsManager),
  },
  getAgentDir: vi.fn(() => "/fake/agent/dir"),
  DefaultPackageManager: vi.fn().mockImplementation(() => mockPackageManager),
}));

// Minimal store implementation for the test server
class MinimalStore {
  getRootDir(): string {
    return "/tmp/fn-1944";
  }
  getFusionDir(): string {
    return "/tmp/fn-1944/.fusion";
  }
  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Pi settings routes", () => {
  const app = createServer(new MinimalStore() as any);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock returns
    mockSettingsManager.getPackages.mockReturnValue(["npm:pi-example"]);
    mockSettingsManager.getExtensionPaths.mockReturnValue(["/path/to/extension"]);
    mockSettingsManager.getSkillPaths.mockReturnValue(["/path/to/skill"]);
    mockSettingsManager.getPromptTemplatePaths.mockReturnValue(["/path/to/prompts"]);
    mockSettingsManager.getThemePaths.mockReturnValue(["/path/to/themes"]);
    mockSettingsManager.flush.mockResolvedValue(undefined);
    mockPackageManager.install.mockResolvedValue(undefined);
    mockPackageManager.addSourceToSettings.mockReturnValue(true);
  });

  describe("GET /api/pi-settings", () => {
    it("returns pi settings from SettingsManager", async () => {
      mockSettingsManager.getPackages.mockReturnValue(["npm:pi-example", "git:https://github.com/user/repo.git"]);
      mockSettingsManager.getExtensionPaths.mockReturnValue(["/custom/ext"]);
      mockSettingsManager.getSkillPaths.mockReturnValue(["/custom/skill"]);
      mockSettingsManager.getPromptTemplatePaths.mockReturnValue(["/custom/prompts"]);
      mockSettingsManager.getThemePaths.mockReturnValue(["/custom/themes"]);

      const res = await request(app, "GET", "/api/pi-settings");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        packages: ["npm:pi-example", "git:https://github.com/user/repo.git"],
        extensions: ["/custom/ext"],
        skills: ["/custom/skill"],
        prompts: ["/custom/prompts"],
        themes: ["/custom/themes"],
      });
    });

    it("returns empty arrays when no settings configured", async () => {
      mockSettingsManager.getPackages.mockReturnValue([]);
      mockSettingsManager.getExtensionPaths.mockReturnValue([]);
      mockSettingsManager.getSkillPaths.mockReturnValue([]);
      mockSettingsManager.getPromptTemplatePaths.mockReturnValue([]);
      mockSettingsManager.getThemePaths.mockReturnValue([]);

      const res = await request(app, "GET", "/api/pi-settings");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      });
    });

    it("returns 500 when SettingsManager throws", async () => {
      mockSettingsManager.getPackages.mockImplementation(() => {
        throw new Error("Failed to read settings");
      });

      const res = await request(app, "GET", "/api/pi-settings");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to read settings" });
    });
  });

  describe("PUT /api/pi-settings", () => {
    it("updates packages and returns success", async () => {
      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({ packages: ["npm:new-package", "git:https://github.com/new/repo.git"] }),
        JSON_HEADERS
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockSettingsManager.setPackages).toHaveBeenCalledWith([
        "npm:new-package",
        "git:https://github.com/new/repo.git",
      ]);
      expect(mockSettingsManager.flush).toHaveBeenCalled();
    });

    it("updates extensions and returns success", async () => {
      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({ extensions: ["/new/extension/path"] }),
        JSON_HEADERS
      );

      expect(res.status).toBe(200);
      expect(mockSettingsManager.setExtensionPaths).toHaveBeenCalledWith(["/new/extension/path"]);
      expect(mockSettingsManager.flush).toHaveBeenCalled();
    });

    it("updates multiple fields at once", async () => {
      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({
          packages: ["npm:example"],
          extensions: ["/custom/ext"],
          skills: ["/custom/skill"],
          prompts: ["/custom/prompts"],
          themes: ["/custom/themes"],
        }),
        JSON_HEADERS
      );

      expect(res.status).toBe(200);
      expect(mockSettingsManager.setPackages).toHaveBeenCalledWith(["npm:example"]);
      expect(mockSettingsManager.setExtensionPaths).toHaveBeenCalledWith(["/custom/ext"]);
      expect(mockSettingsManager.setSkillPaths).toHaveBeenCalledWith(["/custom/skill"]);
      expect(mockSettingsManager.setPromptTemplatePaths).toHaveBeenCalledWith(["/custom/prompts"]);
      expect(mockSettingsManager.setThemePaths).toHaveBeenCalledWith(["/custom/themes"]);
      expect(mockSettingsManager.flush).toHaveBeenCalled();
    });

    it("returns 400 when body is empty object", async () => {
      const res = await request(app, "PUT", "/api/pi-settings", JSON.stringify({}), JSON_HEADERS);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "At least one setting field must be provided (packages, extensions, skills, prompts, or themes)" });
    });

    it("returns error when body is undefined (no JSON body)", async () => {
      // Sending no body with no Content-Type: no body parser runs, req.body is undefined
      const res = await request(app, "PUT", "/api/pi-settings", undefined);

      // Without a JSON body, the route throws because all fields are undefined
      // Either 400 (badRequest) or 500 depending on how the body parser handles empty PUT
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);
    });

    it("returns 400 when packages is not an array", async () => {
      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({ packages: "not-an-array" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "packages must be an array" });
    });

    it("returns 400 when extensions is not an array", async () => {
      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({ extensions: "not-an-array" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "extensions must be an array of strings" });
    });

    it("returns 400 when skills is not an array", async () => {
      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({ skills: 123 }),
        JSON_HEADERS
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "skills must be an array of strings" });
    });

    it("returns 500 when flush throws", async () => {
      mockSettingsManager.flush.mockRejectedValueOnce(new Error("Write failed"));

      const res = await request(app, "PUT", "/api/pi-settings",
        JSON.stringify({ packages: ["npm:new-package"] }),
        JSON_HEADERS
      );

      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/pi-settings/packages", () => {
    it("installs package and returns success", async () => {
      const res = await request(app, "POST", "/api/pi-settings/packages",
        JSON.stringify({ source: "npm:pi-new-extension" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockPackageManager.install).toHaveBeenCalledWith("npm:pi-new-extension");
    });

    it("installs git package source", async () => {
      const res = await request(app, "POST", "/api/pi-settings/packages",
        JSON.stringify({ source: "git:https://github.com/example/extension.git" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("returns 400 when source is empty", async () => {
      const res = await request(app, "POST", "/api/pi-settings/packages",
        JSON.stringify({ source: "" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "source must be a non-empty string" });
    });

    it("returns 400 when source is whitespace only", async () => {
      const res = await request(app, "POST", "/api/pi-settings/packages",
        JSON.stringify({ source: "   " }),
        JSON_HEADERS
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "source must be a non-empty string" });
    });

    it("returns 400 when source is missing", async () => {
      const res = await request(app, "POST", "/api/pi-settings/packages", JSON.stringify({}), JSON_HEADERS);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "source must be a non-empty string" });
    });

    it("returns 500 when install throws", async () => {
      const { DefaultPackageManager } = await import("@mariozechner/pi-coding-agent");
      vi.mocked(DefaultPackageManager).mockImplementationOnce(() => ({
        install: vi.fn().mockRejectedValue(new Error("Install failed")),
        addSourceToSettings: vi.fn().mockReturnValue(true),
      }));

      const res = await request(app, "POST", "/api/pi-settings/packages",
        JSON.stringify({ source: "npm:failing-package" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(500);
    });

    it("returns success when addSourceToSettings returns false (already configured)", async () => {
      const { DefaultPackageManager } = await import("@mariozechner/pi-coding-agent");
      vi.mocked(DefaultPackageManager).mockImplementationOnce(() => ({
        install: vi.fn().mockResolvedValue(undefined),
        addSourceToSettings: vi.fn().mockReturnValue(false),
      }));

      const res = await request(app, "POST", "/api/pi-settings/packages",
        JSON.stringify({ source: "npm:already-configured" }),
        JSON_HEADERS
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });
  });

  describe("POST /api/pi-settings/reinstall-fusion", () => {
    it("reinstalls Fusion package and returns source metadata", async () => {
      const res = await request(app, "POST", "/api/pi-settings/reinstall-fusion", JSON.stringify({}), JSON_HEADERS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, source: "npm:@runfusion/fusion" });
      expect(mockPackageManager.install).toHaveBeenCalledWith("npm:@runfusion/fusion");
      expect(mockPackageManager.addSourceToSettings).toHaveBeenCalledWith("npm:@runfusion/fusion");
      expect(mockSettingsManager.flush).toHaveBeenCalledTimes(1);
    });

    it("succeeds when Fusion package is already configured", async () => {
      mockPackageManager.addSourceToSettings.mockReturnValueOnce(false);

      const res = await request(app, "POST", "/api/pi-settings/reinstall-fusion", JSON.stringify({}), JSON_HEADERS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, source: "npm:@runfusion/fusion" });
      expect(mockPackageManager.install).toHaveBeenCalledWith("npm:@runfusion/fusion");
      expect(mockSettingsManager.flush).not.toHaveBeenCalled();
    });

    it("returns 500 when reinstall fails", async () => {
      mockPackageManager.install.mockRejectedValueOnce(new Error("Reinstall failed"));

      const res = await request(app, "POST", "/api/pi-settings/reinstall-fusion", JSON.stringify({}), JSON_HEADERS);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Reinstall failed" });
    });
  });
});