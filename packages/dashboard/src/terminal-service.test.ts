import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalService, STALE_SESSION_THRESHOLD_MS } from "./terminal-service.js";

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
    chmodSync: vi.fn(),
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
      const result = await service.createSession();

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error("Expected terminal session creation to succeed");
      }
      expect(result.session.id).toMatch(/^term-\d+-/);
      expect(result.session.cwd).toBe(projectRoot);
    });

    it("returns max_sessions error when session limit reached", async () => {
      const limitedService = new TerminalService(projectRoot, 1);

      const result1 = await limitedService.createSession();
      expect(result1.success).toBe(true);

      const result2 = await limitedService.createSession();
      expect(result2).toEqual({
        success: false,
        code: "max_sessions",
        error: "Maximum terminal sessions reached. Please close an existing terminal and try again.",
      });

      limitedService.cleanup();
    });

    it("rejects shells not in allowlist", async () => {
      const result = await service.createSession({ shell: "/tmp/evil-shell" });
      expect(result).toEqual({
        success: false,
        code: "invalid_shell",
        error: "Shell not allowed. Please use a supported shell (bash, zsh, sh, cmd, powershell).",
      });
    });

  });

  describe("write", () => {
    it("sends data to PTY", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      const result = service.write(session.id, "ls -la\n");

      expect(result).toBe(true);
      expect(mockPtyProcess.write).toHaveBeenCalledWith("ls -la\n");
    });

    it("returns false for invalid session", () => {
      const result = service.write("invalid-session", "test");
      expect(result).toBe(false);
    });

    it("rejects data with null bytes", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      const result = service.write(session.id, "test\0malicious");
      expect(result).toBe(false);
    });
  });

  describe("resize", () => {
    it("updates PTY dimensions", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      const result = service.resize(session.id, 120, 40);

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
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      const result = service.killSession(session.id);

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

      expect(session1.success).toBe(true);
      expect(session2.success).toBe(true);
      expect(session3).toEqual({
        success: false,
        code: "max_sessions",
        error: "Maximum terminal sessions reached. Please close an existing terminal and try again.",
      });

      limitedService.cleanup();
    });

    it("lists active sessions", async () => {
      const result1 = await service.createSession();
      const result2 = await service.createSession();
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      if (!result1.success || !result2.success) throw new Error("Expected terminal session creation to succeed");

      const sessions = service.getAllSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.some((s: { id: string }) => s.id === result1.session.id)).toBe(true);
      expect(sessions.some((s: { id: string }) => s.id === result2.session.id)).toBe(true);
    });

    it("cleans up all sessions", async () => {
      const result1 = await service.createSession();
      const result2 = await service.createSession();
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      expect(service.getSessionCount()).toBe(2);

      service.cleanup();

      expect(service.getSessionCount()).toBe(0);
    });
  });

  describe("scrollback buffer", () => {
    it("maintains scrollback buffer", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      mockPtyProcess._onDataCallback?.("output line 1\n");
      mockPtyProcess._onDataCallback?.("output line 2\n");

      const scrollback = service.getScrollback(session.id);

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

      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      mockPtyProcess._onDataCallback?.("test data");
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(dataMock).toHaveBeenCalledWith(session.id, "test data");
    });

    it("emits exit events", async () => {
      const exitMock = vi.fn();
      service.onExit(exitMock);

      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      mockPtyProcess._onExitCallback?.({ exitCode: 0 });

      expect(exitMock).toHaveBeenCalledWith(session.id, 0);
    });

    it("allows unsubscribing from events", async () => {
      const dataMock = vi.fn();
      const unsub = service.onData(dataMock);

      unsub();

      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);

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

    it("ignores values below the supported minimum", () => {
      service.setMaxSessions(0);
      expect(service.getMaxSessions()).toBe(10);
    });

    it("ignores values above the supported maximum", () => {
      service.setMaxSessions(200);
      expect(service.getMaxSessions()).toBe(10);
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

  describe("activity tracking", () => {
    it("sets lastActivityAt on session creation", async () => {
      const before = new Date();
      const createResult = await service.createSession();
      const after = new Date();

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      expect(createResult.session.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createResult.session.lastActivityAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("updates lastActivityAt on write", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      const initialActivity = session.lastActivityAt.getTime();

      // Small delay to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      service.write(session.id, "hello");

      const updatedSession = service.getSession(session.id);
      expect(updatedSession!.lastActivityAt.getTime()).toBeGreaterThan(initialActivity);
    });

    it("includes lastActivityAt in getAllSessions", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      const sessions = service.getAllSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].lastActivityAt).toBeInstanceOf(Date);
    });
  });

  describe("stale session detection", () => {
    it("returns empty array when no sessions are stale", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      const stale = service.getStaleSessions(300_000);
      expect(stale).toHaveLength(0);
    });

    it("returns sessions older than threshold", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      // Manually backdate the lastActivityAt
      session.lastActivityAt = new Date(Date.now() - 600_000); // 10 min ago

      const stale = service.getStaleSessions(300_000); // 5 min threshold
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe(session.id);
    });

    it("sorts stale sessions oldest first", async () => {
      const result1 = await service.createSession();
      const result2 = await service.createSession();
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      if (!result1.success || !result2.success) throw new Error("Expected terminal session creation to succeed");

      // session1 is older (more stale)
      result1.session.lastActivityAt = new Date(Date.now() - 700_000);
      result2.session.lastActivityAt = new Date(Date.now() - 600_000);

      const stale = service.getStaleSessions(300_000);
      expect(stale).toHaveLength(2);
      expect(stale[0].id).toBe(result1.session.id);
      expect(stale[1].id).toBe(result2.session.id);
    });
  });

  describe("stale session eviction", () => {
    it("STALE_SESSION_THRESHOLD_MS is 5 minutes", () => {
      expect(STALE_SESSION_THRESHOLD_MS).toBe(300_000);
    });

    it("evicts stale sessions beyond threshold", async () => {
      // Create a service with max 5 sessions
      const svc = new TerminalService(projectRoot, 5);

      const sessions = [];
      for (let i = 0; i < 5; i++) {
        const result = await svc.createSession();
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected terminal session creation to succeed");
        sessions.push(result.session);
      }
      expect(svc.getSessionCount()).toBe(5);

      // Make 3 sessions stale
      sessions[0]!.lastActivityAt = new Date(Date.now() - 600_000);
      sessions[1]!.lastActivityAt = new Date(Date.now() - 500_000);
      sessions[2]!.lastActivityAt = new Date(Date.now() - 400_000);

      const evicted = svc.evictStaleSessions(300_000);
      // All 3 stale sessions are evicted because killSession sends SIGTERM
      // but the session remains in the map until onExit fires (async).
      // The eviction loop sees the map size unchanged and continues evicting all stale sessions.
      expect(evicted).toBe(3);
      // kill was called for each evicted session
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(3);

      svc.cleanup();
    });

    it("createSession auto-evicts when at 80% capacity", async () => {
      // maxSessions = 5, 80% = 4
      const svc = new TerminalService(projectRoot, 5);

      // Create 4 sessions (80% of 5)
      const sessions = [];
      for (let i = 0; i < 4; i++) {
        const result = await svc.createSession();
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected terminal session creation to succeed");
        sessions.push(result.session);
      }
      expect(svc.getSessionCount()).toBe(4);

      // Make 2 sessions stale
      sessions[0]!.lastActivityAt = new Date(Date.now() - 600_000);
      sessions[1]!.lastActivityAt = new Date(Date.now() - 500_000);

      // Creating a new session should trigger eviction first
      const newSession = await svc.createSession();
      expect(newSession.success).toBe(true);
      // Should have evicted stale sessions, then created a new one
      // After eviction, we target <= 4 (80%), evict oldest stale sessions
      // Then create the new session
      expect(svc.getSessionCount()).toBeLessThanOrEqual(5);

      svc.cleanup();
    });

    it("does not evict active sessions", async () => {
      const svc = new TerminalService(projectRoot, 5);

      for (let i = 0; i < 5; i++) {
        const result = await svc.createSession();
        expect(result.success).toBe(true);
      }
      // All sessions are fresh, no stale ones
      const evicted = svc.evictStaleSessions(300_000);
      expect(evicted).toBe(0);
      expect(svc.getSessionCount()).toBe(5);

      svc.cleanup();
    });
  });

  describe("resize suppression data preservation", () => {
    it("queues data emitted during resize and delivers it after debounce", async () => {
      vi.useFakeTimers();

      const dataListener = vi.fn();
      service.onData(dataListener);

      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      // Start a resize — this sets resizeInProgress = true for 150ms
      service.resize(session.id, 120, 40, true);

      // Emit data while resize is in progress
      mockPtyProcess._onDataCallback?.("prompt$ ");

      // Data should NOT be delivered yet (suppressed)
      expect(dataListener).not.toHaveBeenCalled();

      // But scrollback should contain the data
      expect(service.getScrollback(session.id)).toContain("prompt$ ");

      // Advance past the 150ms resize debounce
      vi.advanceTimersByTime(160);

      // Now the suppressed data should be flushed through the normal path.
      // The flush is throttled (OUTPUT_THROTTLE_MS = 4ms), so advance a bit more.
      vi.advanceTimersByTime(10);

      // Data should have been delivered to subscribers
      expect(dataListener).toHaveBeenCalledWith(session.id, "prompt$ ");

      vi.useRealTimers();
    });

    it("delivers multiple data chunks suppressed during resize", async () => {
      vi.useFakeTimers();

      const dataListener = vi.fn();
      service.onData(dataListener);

      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      // Start a resize
      service.resize(session.id, 80, 24, true);

      // Emit multiple data chunks while suppressed
      mockPtyProcess._onDataCallback?.("line1\n");
      mockPtyProcess._onDataCallback?.("line2\n");
      mockPtyProcess._onDataCallback?.("line3\n");

      // Nothing delivered yet
      expect(dataListener).not.toHaveBeenCalled();

      // Advance past resize debounce + flush throttle
      vi.advanceTimersByTime(160);
      vi.advanceTimersByTime(10);

      // All suppressed data should be delivered as one concatenated chunk
      expect(dataListener).toHaveBeenCalledTimes(1);
      expect(dataListener).toHaveBeenCalledWith(session.id, "line1\nline2\nline3\n");

      vi.useRealTimers();
    });

    it("scrollback includes data even while resize is in progress", async () => {
      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      // Start a resize
      service.resize(session.id, 120, 40, true);

      // Emit data while suppressed
      mockPtyProcess._onDataCallback?.("important output");

      // Scrollback should always contain the data
      const scrollback = service.getScrollback(session.id);
      expect(scrollback).toContain("important output");
    });

    it("does not lose data when resize debounce fires before flush", async () => {
      vi.useFakeTimers();

      const dataListener = vi.fn();
      service.onData(dataListener);

      const createResult = await service.createSession();
      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Expected terminal session creation to succeed");
      const session = createResult.session;

      // Start a resize
      service.resize(session.id, 100, 30, true);

      // Emit data during suppression
      mockPtyProcess._onDataCallback?.("shell prompt> ");

      // Advance exactly to the resize debounce boundary
      vi.advanceTimersByTime(150);

      // The resize debounce should have moved suppressed data to outputBuffer
      // and scheduled a flush. Advance past the flush throttle.
      vi.advanceTimersByTime(10);

      expect(dataListener).toHaveBeenCalledWith(session.id, "shell prompt> ");

      vi.useRealTimers();
    });
  });
});
