import type { Settings } from "@fusion/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGlobalSettings, updateGlobalSettings } from "../../api";

vi.mock("../../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

// Mock the i18n module so importing the hook does not boot the real i18next
// instance (which would fire the dynamic catalog backend, unavailable in jsdom).
vi.mock("../../i18n", () => ({
  LANGUAGE_STORAGE_KEY: "kb-dashboard-language",
  default: {},
}));

type Handler = (lng: string) => void;
const listeners: Record<string, Handler[]> = {};
const i18nMock = {
  resolvedLanguage: "en",
  language: "en",
  changeLanguage: vi.fn(async (lng: string) => {
    i18nMock.resolvedLanguage = lng;
    i18nMock.language = lng;
    (listeners.languageChanged ?? []).forEach((h) => h(lng));
  }),
  on: vi.fn((event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
  }),
  off: vi.fn((event: string, handler: Handler) => {
    listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
  }),
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: i18nMock, t: (key: string, def?: string) => def ?? key }),
}));

const mockFetch = vi.mocked(fetchGlobalSettings);
const mockUpdate = vi.mocked(updateGlobalSettings);

// Import after mocks are registered.
const { useLanguage } = await import("../useLanguage");

const LANGUAGE_STORAGE_KEY = "kb-dashboard-language";

describe("useLanguage", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    for (const k of Object.keys(listeners)) delete listeners[k];
    i18nMock.resolvedLanguage = "en";
    i18nMock.language = "en";
    i18nMock.changeLanguage.mockClear();
    mockFetch.mockReset();
    mockUpdate.mockReset();
    mockFetch.mockImplementation(() => new Promise(() => {})); // hydration pending by default
    mockUpdate.mockResolvedValue({} as Settings);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  it("changes language in place and writes through to localStorage + server", () => {
    const { result } = renderHook(() => useLanguage());
    act(() => result.current.setLanguage("fr"));

    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("fr");
    expect(store[LANGUAGE_STORAGE_KEY]).toBe("fr");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ language: "fr" });
    expect(result.current.language).toBe("fr");
  });

  it("exposes the supported locale list", () => {
    const { result } = renderHook(() => useLanguage());
    expect([...result.current.supportedLocales]).toEqual(["en", "zh-CN", "zh-TW", "fr", "es", "ko", "pt-BR"]);
  });

  it("hydrates from server settings when no local choice exists", async () => {
    mockFetch.mockResolvedValue({ language: "es" } as Settings);
    renderHook(() => useLanguage());
    await waitFor(() => expect(i18nMock.changeLanguage).toHaveBeenCalledWith("es"));
  });

  it("does not let server settings override a local choice", async () => {
    store[LANGUAGE_STORAGE_KEY] = "fr";
    mockFetch.mockResolvedValue({ language: "es" } as Settings);
    renderHook(() => useLanguage());
    await new Promise((r) => setTimeout(r, 0));
    expect(i18nMock.changeLanguage).not.toHaveBeenCalledWith("es");
  });

  it("does not let in-flight server hydration override a concurrent user choice", async () => {
    let resolveFetch!: (s: Settings) => void;
    mockFetch.mockImplementation(() => new Promise<Settings>((r) => { resolveFetch = r; }));
    const { result } = renderHook(() => useLanguage());
    // User picks fr while the hydration fetch is still pending (sets userSetRef).
    act(() => result.current.setLanguage("fr"));
    i18nMock.changeLanguage.mockClear();
    // Now the server responds with a different locale — must be ignored.
    resolveFetch({ language: "es" } as Settings);
    await new Promise((r) => setTimeout(r, 0));
    expect(i18nMock.changeLanguage).not.toHaveBeenCalledWith("es");
  });

  it("adopts a language change made in another tab via the storage event", () => {
    renderHook(() => useLanguage());
    i18nMock.changeLanguage.mockClear();
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "zh-TW" }),
      );
    });
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("zh-TW");
  });

  it("clearLanguage removes the local key, clears the server setting, and re-detects", () => {
    store[LANGUAGE_STORAGE_KEY] = "fr";
    vi.stubGlobal("navigator", { languages: ["es-419", "en-US"], language: "es-419" });
    const { result } = renderHook(() => useLanguage());
    expect(result.current.hasExplicitChoice).toBe(true);

    act(() => result.current.clearLanguage());

    expect(store[LANGUAGE_STORAGE_KEY]).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith({ language: null });
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("es"); // re-detected
    expect(result.current.hasExplicitChoice).toBe(false);
  });

  it("setLanguage marks the choice explicit; clearLanguage unmarks it", () => {
    const { result } = renderHook(() => useLanguage());
    expect(result.current.hasExplicitChoice).toBe(false);
    act(() => result.current.setLanguage("fr"));
    expect(result.current.hasExplicitChoice).toBe(true);
    act(() => result.current.clearLanguage());
    expect(result.current.hasExplicitChoice).toBe(false);
  });

  it("degrades gracefully when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    });
    const { result } = renderHook(() => useLanguage());
    expect(() => act(() => result.current.setLanguage("zh-TW"))).not.toThrow();
    expect(mockUpdate).toHaveBeenCalledWith({ language: "zh-TW" });
  });
});
