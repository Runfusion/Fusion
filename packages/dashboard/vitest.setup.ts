import "@testing-library/jest-dom";
import { vi } from "vitest";

const noisyOutputMarkers = [
  "Subagent result watcher failed",
  "pi-async-subagent-results",
  "[pi] createKbAgent called",
  "[pi] Session created successfully",
  "[pi-claude-cli] Claude CLI is not authenticated",
  "Terminal WebSocket server mounted at /api/terminal/ws",
  "[api:error]",
  "[models] Failed to load models:",
  "[routes] failed to trigger",
];

function isNoisyTestOutput(value: unknown): boolean {
  const text = typeof value === "string" || value instanceof Buffer ? String(value) : "";
  return noisyOutputMarkers.some((marker) => text.includes(marker));
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
  if (isNoisyTestOutput(chunk)) {
    return true;
  }
  return originalStdoutWrite(chunk as any, ...(args as any));
}) as typeof process.stdout.write;

const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
  if (isNoisyTestOutput(chunk)) {
    return true;
  }
  return originalStderrWrite(chunk as any, ...(args as any));
}) as typeof process.stderr.write;

const originalConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (args.some(isNoisyTestOutput)) {
    return;
  }
  originalConsoleLog(...args);
};

const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (args.some(isNoisyTestOutput)) {
    return;
  }
  originalConsoleError(...args);
};

// Mock localStorage
const localStorageMock: Record<string, string> = {};
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => localStorageMock[key] || null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value;
      },
      removeItem: (key: string) => {
        delete localStorageMock[key];
      },
      clear: () => {
        Object.keys(localStorageMock).forEach((key) => delete localStorageMock[key]);
      },
    },
    writable: true,
  });

  // Mock matchMedia
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? true : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Global MockEventSource for tests
class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  
  url: string;
  listeners: Record<string, ((e: any) => void)[]> = {};
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = MockEventSource.OPEN;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (e: any) => void) {
    this.listeners[event] = (this.listeners[event] || []).filter((listener) => listener !== fn);
  }

  // Helper to simulate a server event
  _emit(event: string, data?: unknown) {
    for (const fn of this.listeners[event] || []) {
      fn(data === undefined ? ({ } as { data: string }) : { data: JSON.stringify(data) });
    }
  }
}

// Set up before each test
beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
});

// Clean up after each test
afterEach(() => {
  // Close all lingering EventSource instances
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.instances = [];
  delete (globalThis as any).EventSource;
});

export { MockEventSource };
