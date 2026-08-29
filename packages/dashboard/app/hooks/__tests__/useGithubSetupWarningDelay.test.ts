import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_SETUP_WARNING_DELAY_MS,
  GITHUB_SETUP_WARNING_MISSING_SINCE_KEY,
  useGithubSetupWarningDelay,
} from "../useGithubSetupWarningDelay";
import { scopedKey } from "../../utils/projectStorage";

function renderDelay(options: {
  projectId?: string;
  hasGithub?: boolean;
  loading?: boolean;
  nowMs?: number;
}) {
  const now = vi.fn(() => options.nowMs ?? 1_000_000);
  return renderHook(
    ({ projectId, hasGithub, loading, nowMs }) => useGithubSetupWarningDelay({
      projectId,
      hasGithub: hasGithub ?? false,
      loading: loading ?? false,
      now: () => nowMs ?? now(),
    }),
    { initialProps: options },
  );
}

describe("useGithubSetupWarningDelay", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("does not show immediately and records the first missing timestamp for the project", () => {
    const { result } = renderDelay({ projectId: "proj-a", hasGithub: false, nowMs: 10_000 });

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"))).toBe("10000");
  });

  it("shows after GitHub has been missing for the full 24-hour threshold", () => {
    window.localStorage.setItem(
      scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"),
      String(10_000),
    );

    const { result } = renderDelay({
      projectId: "proj-a",
      hasGithub: false,
      nowMs: 10_000 + GITHUB_SETUP_WARNING_DELAY_MS,
    });

    expect(result.current).toBe(true);
  });

  it("keeps separate timestamps when switching projects", () => {
    window.localStorage.setItem(
      scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"),
      String(10_000),
    );

    const { result, rerender } = renderDelay({
      projectId: "proj-a",
      hasGithub: false,
      nowMs: 10_000 + GITHUB_SETUP_WARNING_DELAY_MS,
    });

    expect(result.current).toBe(true);

    rerender({ projectId: "proj-b", hasGithub: false, loading: false, nowMs: 20_000 });

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-b"))).toBe("20000");
  });

  it("clears the missing timestamp and hides the warning when GitHub becomes connected", () => {
    window.localStorage.setItem(
      scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"),
      String(10_000),
    );

    const { result, rerender } = renderDelay({
      projectId: "proj-a",
      hasGithub: false,
      nowMs: 10_000 + GITHUB_SETUP_WARNING_DELAY_MS,
    });
    expect(result.current).toBe(true);

    rerender({ projectId: "proj-a", hasGithub: true, loading: false, nowMs: 10_000 + GITHUB_SETUP_WARNING_DELAY_MS });

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"))).toBeNull();
  });

  it("does not start the grace period while readiness is loading", () => {
    const { result } = renderDelay({ projectId: "proj-a", hasGithub: false, loading: true, nowMs: 10_000 });

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"))).toBeNull();
  });

  it("does not leak undefined project state into project-scoped storage", () => {
    const { result } = renderDelay({ hasGithub: false, nowMs: 10_000 });

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY)).toBeNull();
  });

  it("keeps a young missing timestamp hidden before the threshold", () => {
    window.localStorage.setItem(
      scopedKey(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, "proj-a"),
      String(10_000),
    );

    const { result } = renderDelay({
      projectId: "proj-a",
      hasGithub: false,
      nowMs: 10_000 + GITHUB_SETUP_WARNING_DELAY_MS - 1,
    });

    expect(result.current).toBe(false);
  });

  it("falls back without crashing when scoped storage reads fail", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });

    const { result } = renderDelay({ projectId: "proj-a", hasGithub: false, nowMs: 10_000 });

    expect(result.current).toBe(false);
    getItemSpy.mockRestore();
  });
});
