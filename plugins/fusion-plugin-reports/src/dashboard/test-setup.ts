import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// @testing-library/react only auto-registers cleanup when vitest globals are
// enabled. We don't enable globals here, so we wire it manually — otherwise
// React leaves the test tree mounted, its scheduler fires a deferred update
// via setImmediate after the jsdom environment is torn down, and the suite
// fails with "ReferenceError: window is not defined".
afterEach(() => cleanup());

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
