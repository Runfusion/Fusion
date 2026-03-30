import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalService } from "./terminal-service";

// Mock node-pty
const mockPtyProcess = {
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    mockPtyProcess._onDataCallback = cb;
    return { dispose: vi.fn() };
  }),
  onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
    mockPtyProcess._onExitCallback = cb;
    return { dispose: vi.fn() };
  }),
  _onDataCallback: null as ((data: string) => void) | null,
  _onExitCallback: null as ((e: { exitCode: number }) => void) | null,
};

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

describe("TerminalService", () => {
  let service: TerminalService;
  const projectRoot = "/test/project";

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TerminalService(projectRoot, 10);
    mockPtyProcess._onDataCallback = null;
    mockPtyProcess._onExitCallback = null;
  });

  afterEach(() => {
    service.cleanup();
  });

  describe("createSession", () => {
    it("creates session with detected shell", async () => {
      const session = await service.createSession();
      
      expect(session).toBeTruthy();
      expect(session?.id).toMatch(/^term-\d+-/);
      expect(session?.cwd).toBe(projectRoot);
    });

    it("returns null when session limit reached", async () => {
      const limitedService = new TerminalService(projectRoot, 1);
      
      const session1 = await limitedService.createSession();
      expect(session1).toBeTruthy();
      
      const session2 = await limitedService.createSession();
      expect(session2).toBeNull();
      
      limitedService.cleanup();
    });

    it("rejects shells not in allowlist", async () => {
      const session = await service.createSession({ shell: "/tmp/evil-shell" });
      expect(session).toBeNull();
    });
  });

  describe("write", () => {
    it("sends data to PTY", async () => {
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      const result = service.write(session!.id, "ls -la\n");
      
      expect(result).toBe(true);
      expect(mockPtyProcess.write).toHaveBeenCalledWith("ls -la\n");
    });

    it("returns false for invalid session", () => {
      const result = service.write("invalid-session", "test");
      expect(result).toBe(false);
    });

    it("rejects data with null bytes", async () => {
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      const result = service.write(session!.id, "test\0malicious");
      expect(result).toBe(false);
    });
  });

  describe("resize", () => {
    it("updates PTY dimensions", async () => {
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      const result = service.resize(session!.id, 120, 40);
      
      expect(result).toBe(true);
      expect(mockPtyProcess.resize).toHaveBeenCalledWith(120, 40);
    });

    it("returns false for invalid session", () => {
      const result = service.resize("invalid-session", 80, 24);
      expect(result).toBe(false);
    });
  });

  describe("killSession", () => {
    it("terminates session", async () => {
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      const result = service.killSession(session!.id);
      
      expect(result).toBe(true);
      expect(mockPtyProcess.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("returns false for non-existent session", () => {
      const result = service.killSession("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("session management", () => {
    it("enforces session limit", async () => {
      const limitedService = new TerminalService(projectRoot, 2);
      
      const session1 = await limitedService.createSession();
      const session2 = await limitedService.createSession();
      const session3 = await limitedService.createSession();
      
      expect(session1).toBeTruthy();
      expect(session2).toBeTruthy();
      expect(session3).toBeNull();
      
      limitedService.cleanup();
    });

    it("lists active sessions", async () => {
      const session1 = await service.createSession();
      const session2 = await service.createSession();
      
      const sessions = service.getAllSessions();
      
      expect(sessions).toHaveLength(2);
      expect(sessions.some((s) => s.id === session1?.id)).toBe(true);
      expect(sessions.some((s) => s.id === session2?.id)).toBe(true);
    });

    it("cleans up all sessions", async () => {
      await service.createSession();
      await service.createSession();
      
      expect(service.getSessionCount()).toBe(2);
      
      service.cleanup();
      
      expect(service.getSessionCount()).toBe(0);
    });
  });

  describe("scrollback buffer", () => {
    it("maintains scrollback buffer", async () => {
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      mockPtyProcess._onDataCallback?.("output line 1\n");
      mockPtyProcess._onDataCallback?.("output line 2\n");
      
      const scrollback = service.getScrollback(session!.id);
      
      expect(scrollback).toContain("output line 1");
      expect(scrollback).toContain("output line 2");
    });

    it("returns null for invalid session", () => {
      const scrollback = service.getScrollback("invalid-session");
      expect(scrollback).toBeNull();
    });
  });

  describe("event handling", () => {
    it("emits data events", async () => {
      const dataMock = vi.fn();
      service.onData(dataMock);
      
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      mockPtyProcess._onDataCallback?.("test data");
      
      expect(dataMock).toHaveBeenCalledWith(session!.id, "test data");
    });

    it("emits exit events", async () => {
      const exitMock = vi.fn();
      service.onExit(exitMock);
      
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      mockPtyProcess._onExitCallback?.({ exitCode: 0 });
      
      expect(exitMock).toHaveBeenCalledWith(session!.id, 0);
    });

    it("allows unsubscribing from events", async () => {
      const dataMock = vi.fn();
      const unsub = service.onData(dataMock);
      
      unsub();
      
      const session = await service.createSession();
      expect(session).toBeTruthy();
      
      mockPtyProcess._onDataCallback?.("test");
      
      expect(dataMock).not.toHaveBeenCalled();
    });
  });

  describe("maxSessions configuration", () => {
    it("returns default max sessions", () => {
      expect(service.getMaxSessions()).toBe(10);
    });

    it("allows updating max sessions", () => {
      service.setMaxSessions(5);
      expect(service.getMaxSessions()).toBe(5);
    });

    it("enforces minimum session limit", () => {
      service.setMaxSessions(0);
      expect(service.getMaxSessions()).toBe(1);
    });

    it("enforces maximum session limit", () => {
      service.setMaxSessions(200);
      expect(service.getMaxSessions()).toBe(100);
    });
  });

  describe("session validation", () => {
    it("returns undefined for invalid session IDs", () => {
      const session = service.getSession("invalid<id>");
      expect(session).toBeUndefined();
    });

    it("returns null scrollback for invalid session IDs", () => {
      const scrollback = service.getScrollback("invalid<id>");
      expect(scrollback).toBeNull();
    });

    it("returns false for write with invalid session ID", () => {
      const result = service.write("invalid<id>", "data");
      expect(result).toBe(false);
    });
  });
});
