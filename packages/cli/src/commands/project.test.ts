/**
 * Tests for project.ts commands
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("project commands", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.resetModules();
  });

  describe("exports", () => {
    it("should export all project command functions", async () => {
      const project = await import("./project.js");
      expect(typeof project.runProjectList).toBe("function");
      expect(typeof project.runProjectAdd).toBe("function");
      expect(typeof project.runProjectRemove).toBe("function");
      expect(typeof project.runProjectShow).toBe("function");
      expect(typeof project.runProjectSetDefault).toBe("function");
      expect(typeof project.runProjectDetect).toBe("function");
    });
  });

  describe("validation errors", () => {
    it("runProjectAdd should exit when name is empty", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const { runProjectAdd } = await import("./project.js");
      await expect(runProjectAdd("", "/tmp")).rejects.toThrow("process.exit");
      exitSpy.mockRestore();
    });

    it("runProjectAdd should exit when path is empty", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const { runProjectAdd } = await import("./project.js");
      await expect(runProjectAdd("name", "")).rejects.toThrow("process.exit");
      exitSpy.mockRestore();
    });

    it("runProjectRemove should exit when name is empty", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const { runProjectRemove } = await import("./project.js");
      await expect(runProjectRemove("")).rejects.toThrow("process.exit");
      exitSpy.mockRestore();
    });

    it("runProjectShow should exit when name is empty", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const { runProjectShow } = await import("./project.js");
      await expect(runProjectShow("")).rejects.toThrow("process.exit");
      exitSpy.mockRestore();
    });

    it("runProjectSetDefault should exit when name is empty", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const { runProjectSetDefault } = await import("./project.js");
      await expect(runProjectSetDefault("")).rejects.toThrow("process.exit");
      exitSpy.mockRestore();
    });
  });
});
