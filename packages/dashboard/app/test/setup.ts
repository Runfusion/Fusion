import { vi } from "vitest";

// Extend localStorage mock for multi-project tests
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
}

// Mock fetch for project API tests
const _originalFetch = globalThis.fetch;

globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
  const urlString = url.toString();
  
  // Mock project API responses
  if (urlString.includes("/api/projects")) {
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "[]",
      headers: new Headers({ "content-type": "application/json" }),
    } as Response;
  }
  
  // Default: return empty successful response
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}",
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}) as typeof fetch;

// Cleanup
afterEach(() => {
  // Clear localStorage mock
  Object.keys(localStorageMock).forEach((key) => delete localStorageMock[key]);
  
  // Reset fetch mock
  vi.mocked(globalThis.fetch).mockClear();
});

export { localStorageMock };
