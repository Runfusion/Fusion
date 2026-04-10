import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPluginCreate } from "../commands/plugin-scaffold.js";

describe("plugin-scaffold", () => {
  const tmpBase = join(tmpdir(), `fn-scaffold-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => {
    // Ensure temp directory exists
    mkdirSync(tmpBase, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("runPluginCreate", () => {
    it("should reject invalid plugin name (uppercase)", async () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation();

      await expect(
        runPluginCreate("Test-Plugin", { output: join(tmpBase, "test1") }),
      ).rejects.toThrow("exit");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid plugin name"),
      );
      exitMock.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it("should reject invalid plugin name (spaces)", async () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation();

      await expect(
        runPluginCreate("test plugin", { output: join(tmpBase, "test2") }),
      ).rejects.toThrow("exit");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid plugin name"),
      );
      exitMock.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it("should reject invalid plugin name (special characters)", async () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation();

      await expect(
        runPluginCreate("test@plugin", { output: join(tmpBase, "test3") }),
      ).rejects.toThrow("exit");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid plugin name"),
      );
      exitMock.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it("should reject empty plugin name", async () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation();

      await expect(
        runPluginCreate("", { output: join(tmpBase, "test4") }),
      ).rejects.toThrow("exit");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid plugin name"),
      );
      exitMock.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
