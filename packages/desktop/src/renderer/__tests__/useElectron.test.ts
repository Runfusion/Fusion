// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useElectron } from "../hooks/useElectron";

describe("useElectron", () => {
  afterEach(() => {
    cleanup();
    window.electronAPI = undefined;
  });

  it("returns electron context when electronAPI exists", () => {
    window.electronAPI = {
      getServerPort: async () => 4040,
    };

    const { result } = renderHook(() => useElectron());

    expect(result.current.isElectron).toBe(true);
    expect(result.current.electronAPI).toBe(window.electronAPI);
  });

  it("returns web defaults when electronAPI is absent", () => {
    window.electronAPI = undefined;

    const { result } = renderHook(() => useElectron());

    expect(result.current.isElectron).toBe(false);
    expect(result.current.electronAPI).toBeNull();
  });
});
