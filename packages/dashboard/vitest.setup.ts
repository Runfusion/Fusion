import "@testing-library/jest-dom";
import { vi } from "vitest";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

// Initialize a minimal real i18next instance for component tests. Components
// call useTranslation() without a provider in tests; react-i18next's
// uninitialized fallback returns inline defaults WITHOUT interpolation
// (literal "{{count}}" in output). A backend-less en instance keeps t(key,
// default, options) returning the interpolated English default, so tests
// keep asserting the same strings as before the i18n migration. Tests that
// vi.mock("react-i18next") or "../i18n" are unaffected.
await i18next.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  // Each namespace present (empty) so hasLoadedNamespace() is true — an
  // unloaded namespace makes useTranslation() suspend (no Suspense boundary
  // in component tests) even with useSuspense disabled belt-and-braces below.
  //
  // FNXC:TestI18n 2026-06-22-21:40:
  // Pluralized count keys must resolve from resources, not the singular inline
  // default. t("taskChat.entryCount", "{{count}} entry", { count }) renders the
  // singular default for ALL counts when the key is absent — so count=2 became
  // "2 entry". Provide the _one/_other forms (as the real en locale does) so the
  // correct plural ("2 entries", "7 tool calls") renders in tests too. Only these
  // keys resolve from the bundle; every other key still falls back to its inline
  // default, preserving existing assertions.
  resources: {
    en: {
      common: {},
      app: {
        taskChat: {
          entryCount_one: "{{count}} entry",
          entryCount_other: "{{count}} entries",
          toolCallCount_one: "{{count}} tool call",
          toolCallCount_other: "{{count}} tool calls",
        },
      },
      errors: {},
    },
  },
  ns: ["common", "app", "errors"],
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

// Ensure dashboard route/server tests start in no-auth mode unless they
// explicitly opt in. CI/agent shells may export daemon tokens globally,
// which would otherwise force 401s across unrelated endpoint tests.
const clearDaemonAuthEnv = () => {
  delete process.env.FUSION_DAEMON_TOKEN;
  delete process.env.FUSION_BEARER_TOKEN;
};

clearDaemonAuthEnv();

const noisyOutputMarkers = [
  "ExperimentalWarning: SQLite is an experimental feature",
  "Subagent result watcher failed",
  "pi-async-subagent-results",
  "[pi] createFnAgent called",
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

  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }

  (window as typeof window & { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver = MockResizeObserver;
  (globalThis as typeof globalThis & { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver = MockResizeObserver;
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
  clearDaemonAuthEnv();
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
  clearDaemonAuthEnv();
});

export { MockEventSource };
