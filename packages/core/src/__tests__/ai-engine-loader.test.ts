import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCreateAiSessionFactory,
  getFnAgent,
  setCreateAiSessionFactory,
  setCreateFnAgent,
} from "../ai-engine-loader.js";
import type { CreateAiSessionFactory } from "../plugin-types.js";

describe("ai-engine-loader", () => {
  beforeEach(() => {
    setCreateFnAgent(undefined);
    setCreateAiSessionFactory(undefined);
  });

  it("returns undefined createAiSession factory before registration", async () => {
    await expect(getCreateAiSessionFactory()).resolves.toBeUndefined();
  });

  it("stores and returns createAiSession factory", async () => {
    const factory: CreateAiSessionFactory = vi.fn(async () => ({
      session: {
        prompt: async () => {},
        state: { messages: [] },
      },
    }));

    setCreateAiSessionFactory(factory);

    await expect(getCreateAiSessionFactory()).resolves.toBe(factory);
  });

  it("clears createAiSession factory when set to undefined", async () => {
    setCreateAiSessionFactory(async () => ({
      session: {
        prompt: async () => {},
        state: { messages: [] },
      },
    }));

    setCreateAiSessionFactory(undefined);

    await expect(getCreateAiSessionFactory()).resolves.toBeUndefined();
  });

  it("does not interfere with createFnAgent registration", async () => {
    const fnAgent = vi.fn();
    const factory: CreateAiSessionFactory = vi.fn(async () => ({
      session: {
        prompt: async () => {},
        state: { messages: [] },
      },
    }));

    setCreateFnAgent(fnAgent);
    setCreateAiSessionFactory(factory);

    await expect(getFnAgent()).resolves.toBe(fnAgent);
    await expect(getCreateAiSessionFactory()).resolves.toBe(factory);

    setCreateAiSessionFactory(undefined);

    await expect(getFnAgent()).resolves.toBe(fnAgent);
    await expect(getCreateAiSessionFactory()).resolves.toBeUndefined();
  });
});
