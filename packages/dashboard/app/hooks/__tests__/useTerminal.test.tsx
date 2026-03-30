import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTerminal } from "../useTerminal";
import * as apiModule from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  execTerminalCommand: vi.fn(),
  killTerminalSession: vi.fn(),
  getTerminalStreamUrl: vi.fn((id) => `/api/terminal/sessions/${id}/stream`),
}));

// Mock EventSource
class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  url: string;
  private listeners: Map<string, Array<(event: MessageEvent) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    // Simulate connection opening
    setTimeout(() => {
      if (this.onopen) this.onopen();
      // Also emit as event listener
      this.emit("connected", {});
    }, 0);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(handler);
  }

  removeEventListener(type: string, handler: (event: MessageEvent) => void) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private emit(type: string, data: unknown) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      const event = {
        type,
        data: typeof data === "string" ? data : JSON.stringify(data),
        lastEventId: "",
        origin: "",
        ports: [],
        source: null,
        bubbles: false,
        cancelable: false,
        composed: false,
        initEvent: () => {},
        preventDefault: () => {},
        stopImmediatePropagation: () => {},
        stopPropagation: () => {},
        currentTarget: null,
        target: null,
        timeStamp: Date.now(),
        eventPhase: 0,
        isTrusted: true,
        returnValue: true,
        srcElement: null,
        nativeEvent: undefined,
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        persist: () => {},
      } as unknown as MessageEvent;
      handlers.forEach(h => h(event));
    }
  }

  close() {
    // Clean up
  }

  // Helper for tests to simulate messages
  simulateMessage(data: unknown, eventType = "message") {
    // Create a proper MessageEvent-like object
    const event = {
      type: eventType,
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId: "",
      origin: "",
      ports: [],
      source: null,
      bubbles: false,
      cancelable: false,
      composed: false,
      initEvent: () => {},
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
      stopPropagation: () => {},
      currentTarget: null,
      target: null,
      timeStamp: Date.now(),
      eventPhase: 0,
      isTrusted: true,
      returnValue: true,
      srcElement: null,
      nativeEvent: undefined,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      persist: () => {},
    } as unknown as MessageEvent;

    if (this.onmessage) this.onmessage(event);
    
    // Also emit to registered listeners
    const handlers = this.listeners.get(eventType);
    if (handlers) {
      handlers.forEach(h => h(event));
    }
  }

  simulateError() {
    if (this.onerror) this.onerror();
    const handlers = this.listeners.get("error");
    if (handlers) {
      const event = {
        type: "error",
        data: "",
        lastEventId: "",
        origin: "",
        ports: [],
        source: null,
        bubbles: false,
        cancelable: false,
        composed: false,
        initEvent: () => {},
        preventDefault: () => {},
        stopImmediatePropagation: () => {},
        stopPropagation: () => {},
        currentTarget: null,
        target: null,
        timeStamp: Date.now(),
        eventPhase: 0,
        isTrusted: true,
        returnValue: true,
        srcElement: null,
        nativeEvent: undefined,
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        persist: () => {},
      } as unknown as MessageEvent;
      handlers.forEach(h => h(event));
    }
  }
}

global.EventSource = MockEventSource as unknown as typeof EventSource;

const mockExecTerminalCommand = vi.mocked(apiModule.execTerminalCommand);
const mockKillTerminalSession = vi.mocked(apiModule.killTerminalSession);
const mockGetTerminalStreamUrl = vi.mocked(apiModule.getTerminalStreamUrl);

describe.skip("useTerminal", () => {
  beforeEach(() => {
    mockExecTerminalCommand.mockReset();
    mockKillTerminalSession.mockReset();
    mockKillTerminalSession.mockResolvedValue({ killed: true, sessionId: "test-id" });
    mockGetTerminalStreamUrl.mockReset();
    mockGetTerminalStreamUrl.mockReturnValue("/api/terminal/sessions/test-id/stream");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with empty state", () => {
    const { result } = renderHook(() => useTerminal());

    expect(result.current.history).toEqual([]);
    expect(result.current.input).toBe("");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.currentSessionId).toBeNull();
    expect(result.current.currentDirectory).toBe("~");
  });

  it("sets input value", () => {
    const { result } = renderHook(() => useTerminal());

    act(() => {
      result.current.setInput("ls -la");
    });

    expect(result.current.input).toBe("ls -la");
  });

  it("executes command and adds to history", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("ls");
    });

    expect(mockExecTerminalCommand).toHaveBeenCalledWith("ls");
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]?.command).toBe("ls");

    // Wait for isRunning to be set
    await waitFor(() => {
      expect(result.current.isRunning).toBe(true);
    });

    expect(result.current.currentSessionId).toBe("test-id");
  });

  it("does not execute empty commands", async () => {
    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("   ");
    });

    expect(mockExecTerminalCommand).not.toHaveBeenCalled();
    expect(result.current.history).toHaveLength(0);
  });

  it("does not execute while another command is running", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("sleep 10");
    });

    // Try to execute another command while first is running
    await act(async () => {
      await result.current.executeCommand("ls");
    });

    expect(mockExecTerminalCommand).toHaveBeenCalledTimes(1);
  });

  it("clears command history", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("ls");
    });

    expect(result.current.history).toHaveLength(1);

    act(() => {
      result.current.clearHistory();
    });

    expect(result.current.history).toHaveLength(0);
  });

  it("handles cd command locally", async () => {
    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("cd /some/path");
    });

    expect(mockExecTerminalCommand).not.toHaveBeenCalled();
    expect(result.current.currentDirectory).toBe("/some/path");
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]?.exitCode).toBe(0);
  });

  it("handles cd without args as going to home", async () => {
    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("cd /some/path");
    });

    expect(result.current.currentDirectory).toBe("/some/path");

    await act(async () => {
      await result.current.executeCommand("cd");
    });

    expect(result.current.currentDirectory).toBe("~");
  });

  it("handles clear command locally", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("ls");
    });

    expect(result.current.history).toHaveLength(1);

    await act(async () => {
      await result.current.executeCommand("clear");
    });

    await waitFor(() => {
      expect(result.current.history).toHaveLength(0);
    });

    expect(mockExecTerminalCommand).toHaveBeenCalledTimes(1); // Only for ls
  });

  it("handles cls command as clear", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("ls");
    });

    await act(async () => {
      await result.current.executeCommand("cls");
    });

    await waitFor(() => {
      expect(result.current.history).toHaveLength(0);
    });
  });

  it("clears input after executing command", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    act(() => {
      result.current.setInput("ls -la");
    });

    await act(async () => {
      await result.current.executeCommand(result.current.input);
    });

    expect(result.current.input).toBe("");
  });

  it("handles command execution error", async () => {
    mockExecTerminalCommand.mockRejectedValue(new Error("Command not allowed"));

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("rm -rf /");
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]?.exitCode).toBe(1);
    expect(result.current.history[0]?.output).toContain("Command not allowed");
    expect(result.current.isRunning).toBe(false);
  });

  it("kills current command", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });
    mockKillTerminalSession.mockResolvedValue({ killed: true, sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("sleep 10");
    });

    // Wait for isRunning to be true
    await waitFor(() => {
      expect(result.current.isRunning).toBe(true);
    });

    await act(async () => {
      await result.current.killCurrentCommand();
    });

    expect(mockKillTerminalSession).toHaveBeenCalledWith("test-id");

    // Wait for isRunning to be false after killing
    await waitFor(() => {
      expect(result.current.isRunning).toBe(false);
    });

    expect(result.current.history[0]?.exitCode).toBe(130);
  });

  it("does not kill if no command is running", async () => {
    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.killCurrentCommand();
    });

    expect(mockKillTerminalSession).not.toHaveBeenCalled();
  });

  it("navigates history with up arrow", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("first");
    });

    await act(async () => {
      await result.current.executeCommand("second");
    });

    // Simulate up arrow - should return most recent command (second)
    let historyCmd: string | null = null;
    act(() => {
      historyCmd = result.current.navigateHistory("up", result.current.input);
    });

    expect(historyCmd).toBe("second");

    // Another up arrow - should go to older command (first)
    act(() => {
      historyCmd = result.current.navigateHistory("up", result.current.input);
    });

    expect(historyCmd).toBe("first");
  });

  it("navigates history with down arrow", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("first");
    });

    await act(async () => {
      await result.current.executeCommand("second");
    });

    // Type something before navigating history (need to set it explicitly since executeCommand clears input)
    act(() => {
      result.current.setInput("typing...");
    });

    // Navigate up twice to get to oldest command
    act(() => {
      result.current.navigateHistory("up", result.current.input);
    });
    act(() => {
      result.current.navigateHistory("up", result.current.input);
    });

    // Navigate down - should return more recent command (second)
    let historyCmd: string | null = null;
    act(() => {
      historyCmd = result.current.navigateHistory("down", result.current.input);
    });

    expect(historyCmd).toBe("second");

    // Navigate down past start - should restore original input that was typed
    act(() => {
      historyCmd = result.current.navigateHistory("down", result.current.input);
    });

    expect(historyCmd).toBe("typing...");
  });

  it("returns null when navigating empty history", () => {
    const { result } = renderHook(() => useTerminal());

    let historyCmd: string | null = "not-null";
    act(() => {
      historyCmd = result.current.navigateHistory("up");
    });

    expect(historyCmd).toBeNull();
  });

  it("trims commands before execution", async () => {
    mockExecTerminalCommand.mockResolvedValue({ sessionId: "test-id" });

    const { result } = renderHook(() => useTerminal());

    await act(async () => {
      await result.current.executeCommand("  ls  ");
    });

    expect(mockExecTerminalCommand).toHaveBeenCalledWith("ls");
    expect(result.current.history[0]?.command).toBe("ls");
  });
});
