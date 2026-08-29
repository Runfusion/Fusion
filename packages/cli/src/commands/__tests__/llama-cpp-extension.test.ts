import { describe, expect, it } from "vitest";
import {
  resolveLlamaCppExtension,
  resolveLlamaCppExtensionPaths,
} from "../llama-cpp-extension.js";

describe("resolveLlamaCppExtension", () => {
  it("finds the bundled @fusion/pi-llama-cpp package", () => {
    const result = resolveLlamaCppExtension();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.path).toMatch(/pi-llama-cpp[\\/]index\.ts$/);
      expect(result.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("resolveLlamaCppExtensionPaths", () => {
  it("returns empty when useLlamaCpp is off", () => {
    const result = resolveLlamaCppExtensionPaths({});
    expect(result.paths).toEqual([]);
    expect(result.warning).toBeUndefined();
    expect(result.resolution).toBeNull();
  });

  it("returns extension path when useLlamaCpp is on", () => {
    const result = resolveLlamaCppExtensionPaths({ useLlamaCpp: true });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatch(/pi-llama-cpp[\\/]index\.ts$/);
    expect(result.resolution?.status).toBe("ok");
  });
});

describe("cached resolution roundtrip", () => {
  it("set/get preserves snapshot", async () => {
    const { setCachedLlamaCppResolution, getCachedLlamaCppResolution } =
      await import("../llama-cpp-extension.js");
    setCachedLlamaCppResolution({ status: "not-installed" });
    expect(getCachedLlamaCppResolution()).toEqual({ status: "not-installed" });
    setCachedLlamaCppResolution(null);
    expect(getCachedLlamaCppResolution()).toBeNull();
  });
});
