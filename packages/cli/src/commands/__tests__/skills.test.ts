/**
 * Tests for skills CLI commands
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

// ─── Mock setup ────────────────────────────────────────────────────────────────

type Listener = (...args: any[]) => void;

interface MockChild extends MockEmitter {
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  stdout?: MockEmitter;
  stderr?: MockEmitter;
}

interface MockEmitter {
  on(event: string, listener: Listener): MockEmitter;
  once(event: string, listener: Listener): MockEmitter;
  off(event: string, listener: Listener): MockEmitter;
  emit(event: string, ...args: any[]): boolean;
}

const mocks = vi.hoisted(() => {
  function createEmitter(): MockEmitter {
    const listeners = new Map<string, Set<Listener>>();

    const add = (event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    };

    const remove = (event: string, listener: Listener) => {
      const eventListeners = listeners.get(event);
      if (!eventListeners) return;
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        listeners.delete(event);
      }
    };

    return {
      on(event: string, listener: Listener) {
        add(event, listener);
        return this;
      },
      once(event: string, listener: Listener) {
        const wrapped: Listener = (...args: any[]) => {
          remove(event, wrapped);
          listener(...args);
        };
        add(event, wrapped);
        return this;
      },
      off(event: string, listener: Listener) {
        remove(event, listener);
        return this;
      },
      emit(event: string, ...args: any[]) {
        const eventListeners = listeners.get(event);
        if (!eventListeners || eventListeners.size === 0) {
          return false;
        }

        for (const listener of [...eventListeners]) {
          listener(...args);
        }
        return true;
      },
    };
  }

  function createMockChild(): MockChild {
    const emitter = createEmitter();
    const child = emitter as MockChild;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    // Mock stdout/stderr streams
    child.stdout = createEmitter();
    child.stderr = createEmitter();
    return child;
  }

  const mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);

  const spawnMock = vi.fn((command: string) => {
    const child = createMockChild();
    // Auto-resolve with success by default for npx
    if (command === "npx") {
      // Use setTimeout instead of queueMicrotask for more predictable timing
      setTimeout(() => {
        child.emit("exit", 0);
      }, 10);
    }
    return child;
  });

  return {
    mockFetch,
    spawn: spawnMock,
    createMockChild,
  };
});

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

// ─── Spies setup ──────────────────────────────────────────────────────────────

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// ─── Import after mocks and spies ────────────────────────────────────────────

import { searchSkills, formatInstalls, runSkillsSearch, runSkillsInstall } from "../skills.js";

// ─── formatInstalls tests ──────────────────────────────────────────────────────

describe("formatInstalls", () => {
  it("formats millions correctly", () => {
    expect(formatInstalls(1_500_000)).toBe("1.5M installs");
    expect(formatInstalls(2_000_000)).toBe("2M installs");
    expect(formatInstalls(1_000_000)).toBe("1M installs");
  });

  it("formats thousands correctly", () => {
    expect(formatInstalls(32_000)).toBe("32K installs");
    expect(formatInstalls(10_000)).toBe("10K installs");
    expect(formatInstalls(1_500)).toBe("1.5K installs");
  });

  it("formats hundreds correctly", () => {
    expect(formatInstalls(500)).toBe("500 installs");
    expect(formatInstalls(100)).toBe("100 installs");
    expect(formatInstalls(1)).toBe("1 installs");
  });

  it("returns empty string for zero", () => {
    expect(formatInstalls(0)).toBe("");
  });
});

// ─── searchSkills tests ───────────────────────────────────────────────────────

describe("searchSkills", () => {
  beforeEach(() => {
    mocks.mockFetch.mockReset();
  });

  it("returns skills sorted by installs descending", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "firebase",
        searchType: "skills",
        skills: [
          { id: "firebase/agent-skills/firebase-basics", skillId: "firebase-basics", name: "firebase-basics", installs: 24095, source: "firebase/agent-skills" },
          { id: "firebase/agent-skills/firebase-auth", skillId: "firebase-auth", name: "firebase-auth", installs: 18000, source: "firebase/agent-skills" },
          { id: "firebase/agent-skills/firebase-firestore", skillId: "firebase-firestore", name: "firebase-firestore", installs: 35000, source: "firebase/agent-skills" },
        ],
      }),
    } as unknown as Response);

    const results = await searchSkills("firebase");

    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe("firebase-firestore"); // Most installs
    expect(results[1]!.name).toBe("firebase-basics");
    expect(results[2]!.name).toBe("firebase-auth"); // Least installs
    expect(mocks.mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("q=firebase"),
      expect.any(Object),
    );
  });

  it("returns empty array when no skills found", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "nonexistent",
        searchType: "skills",
        skills: [],
      }),
    } as unknown as Response);

    const results = await searchSkills("nonexistent");

    expect(results).toHaveLength(0);
  });

  it("returns empty array on network error", async () => {
    mocks.mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    const results = await searchSkills("firebase");

    expect(results).toHaveLength(0);
  });

  it("returns empty array on non-200 status", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as unknown as Response);

    const results = await searchSkills("firebase");

    expect(results).toHaveLength(0);
  });

  it("returns empty array on invalid JSON response", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error("Parse error"); },
    } as unknown as Response);

    const results = await searchSkills("firebase");

    expect(results).toHaveLength(0);
  });
});

// ─── runSkillsSearch tests ────────────────────────────────────────────────────

describe("runSkillsSearch", () => {
  beforeEach(() => {
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
    mocks.mockFetch.mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  it("prints usage when no query provided", async () => {
    await runSkillsSearch([]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: fn skills search"),
    );
  });

  it("prints usage when query is only whitespace", async () => {
    await runSkillsSearch(["  "]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: fn skills search"),
    );
  });

  it("prints skills with correct format", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "firebase",
        searchType: "skills",
        skills: [
          { id: "firebase/agent-skills/firebase-basics", skillId: "firebase-basics", name: "firebase-basics", installs: 24095, source: "firebase/agent-skills" },
          { id: "firebase/agent-skills/firebase-auth", skillId: "firebase-auth", name: "firebase-auth", installs: 18000, source: "firebase/agent-skills" },
          { id: "firebase/agent-skills/firebase-firestore", skillId: "firebase-firestore", name: "firebase-firestore", installs: 35000, source: "firebase/agent-skills" },
        ],
      }),
    } as unknown as Response);

    await runSkillsSearch(["firebase"]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skills matching 'firebase' (3 results)"),
    );
    // Check install count formatting
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("24.1K installs"),
    );
    // Check install hint
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("fn skills install <source> --skill <name>"),
    );
  });

  it("prints no skills found message", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "nonexistent",
        searchType: "skills",
        skills: [],
      }),
    } as unknown as Response);

    await runSkillsSearch(["nonexistent"]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("No skills found for 'nonexistent'"),
    );
  });

  it("passes limit option through to searchSkills", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "react",
        searchType: "skills",
        skills: [],
      }),
    } as unknown as Response);

    await runSkillsSearch(["react"], { limit: 5 });

    expect(mocks.mockFetch.mock.calls[0]![0]).toContain("limit=5");
  });

  it("uses default limit of 10", async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "react",
        searchType: "skills",
        skills: [],
      }),
    } as unknown as Response);

    await runSkillsSearch(["react"]);

    expect(mocks.mockFetch.mock.calls[0]![0]).toContain("limit=10");
  });
});

// ─── runSkillsInstall tests ────────────────────────────────────────────────────

describe("runSkillsInstall", () => {
  beforeEach(() => {
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
    mocks.spawn.mockReset();

    // Create a new child for each test with default success exit
    const child = mocks.createMockChild();
    // Override the on method to emit exit after a short delay
    const originalOn = child.on.bind(child);
    child.on = vi.fn((event: string, handler: Listener) => {
      if (event === "exit") {
        // Emit exit after a short delay to simulate async spawn
        setTimeout(() => {
          handler(0);
        }, 10);
        return child;
      }
      return originalOn(event, handler);
    });
    mocks.spawn.mockReturnValue(child);
  });

  afterEach(() => {
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  it("prints usage when no source provided", async () => {
    await runSkillsInstall([]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: fn skills install"),
    );
  });

  it("prints error for invalid source format", async () => {
    await runSkillsInstall(["not-a-repo"]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid source format"),
    );
  });

  it("prints usage for empty string source (treated as no source)", async () => {
    // Empty string is falsy, so it's treated as "no source" and prints usage
    await runSkillsInstall([""]);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: fn skills install"),
    );
  });

  it("spawns npx with correct args for install all skills", async () => {
    await runSkillsInstall(["firebase/agent-skills"]);

    // Wait for async spawn to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(mocks.spawn).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "firebase/agent-skills", "-y", "-a", "pi"],
      expect.any(Object),
    );
  });

  it("spawns npx with correct args for specific skill", async () => {
    await runSkillsInstall(["firebase/agent-skills"], { skill: "firebase-basics" });

    // Wait for async spawn to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(mocks.spawn).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "firebase/agent-skills", "--skill", "firebase-basics", "-y", "-a", "pi"],
      expect.any(Object),
    );
  });

  it("prints success message on successful install", async () => {
    await runSkillsInstall(["firebase/agent-skills"]);

    // Wait for async spawn to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Installed skill from firebase/agent-skills"),
    );
  });

  it("prints error on non-zero exit code", async () => {
    // Create a child that exits with error
    const errorChild = mocks.createMockChild();
    errorChild.on = vi.fn((event: string, handler: Listener) => {
      if (event === "exit") {
        setTimeout(() => handler(1), 10);
        return errorChild;
      }
      return errorChild;
    });
    mocks.spawn.mockReturnValueOnce(errorChild);

    await runSkillsInstall(["firebase/agent-skills"]);

    // Wait for async spawn to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to install skill"),
    );
  });
});
