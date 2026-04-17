import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSetupReadiness, __test_clearCache } from "../useSetupReadiness";
import * as api from "../../api";
import type { AuthProvider } from "../../api";

vi.mock("../../api", () => ({
  fetchAuthStatus: vi.fn(),
}));

const mockFetchAuthStatus = vi.mocked(api.fetchAuthStatus);

function makeProvider(
  id: string,
  authenticated: boolean,
  name = id,
  type: AuthProvider["type"] = "oauth",
): AuthProvider {
  return {
    id,
    name,
    authenticated,
    type,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSetupReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __test_clearCache();
  });

  it("returns hasAiProvider=true when at least one non-GitHub provider is authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("anthropic", true), makeProvider("github", false)],
    });

    const { result } = renderHook(() => useSetupReadiness());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasAiProvider).toBe(true);
  });

  it("returns hasAiProvider=false when no non-GitHub providers are authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("anthropic", false), makeProvider("github", true)],
    });

    const { result } = renderHook(() => useSetupReadiness());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasAiProvider).toBe(false);
  });

  it("returns hasGithub=true when GitHub provider is authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("anthropic", true), makeProvider("github", true)],
    });

    const { result } = renderHook(() => useSetupReadiness());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasGithub).toBe(true);
  });

  it("returns hasGithub=false when GitHub is missing or not authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("anthropic", true)],
    });

    const { result: missingGithub } = renderHook(() => useSetupReadiness("project-a"));

    await waitFor(() => expect(missingGithub.current.loading).toBe(false));
    expect(missingGithub.current.hasGithub).toBe(false);

    __test_clearCache();
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("github", false)],
    });

    const { result: unauthenticatedGithub } = renderHook(() => useSetupReadiness("project-b"));

    await waitFor(() => expect(unauthenticatedGithub.current.loading).toBe(false));
    expect(unauthenticatedGithub.current.hasGithub).toBe(false);
  });

  it("returns hasWarnings=true when AI provider is missing", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("github", true)],
    });

    const { result } = renderHook(() => useSetupReadiness());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasWarnings).toBe(true);
  });

  it("returns hasWarnings=true when GitHub is missing", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("anthropic", true), makeProvider("github", false)],
    });

    const { result } = renderHook(() => useSetupReadiness());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasWarnings).toBe(true);
  });

  it("returns hasWarnings=false when both AI provider and GitHub are connected", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [makeProvider("anthropic", true), makeProvider("github", true)],
    });

    const { result } = renderHook(() => useSetupReadiness());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasWarnings).toBe(false);
  });

  it("returns loading=true during initial fetch and false after completion", async () => {
    const pending = deferred<{ providers: AuthProvider[] }>();
    mockFetchAuthStatus.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useSetupReadiness());

    expect(result.current.loading).toBe(true);

    await act(async () => {
      pending.resolve({
        providers: [makeProvider("anthropic", true), makeProvider("github", true)],
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("cache prevents duplicate fetches across multiple consumers", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [makeProvider("anthropic", true), makeProvider("github", true)],
    });

    const { result: first } = renderHook(() => useSetupReadiness());
    await waitFor(() => expect(first.current.loading).toBe(false));

    const { result: second } = renderHook(() => useSetupReadiness());
    await waitFor(() => expect(second.current.loading).toBe(false));

    expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
  });
});
