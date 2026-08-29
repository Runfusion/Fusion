/**
 * Canonical @fusion/core mock helper for engine tests.
 *
 * Prefer extending this helper over suite-local full export lists; this is the
 * first place to update when new @fusion/core exports are consumed by engine tests.
 */
import { vi, type Mock } from "vitest";

type AnyModule = Record<string, unknown>;

const fallbackFns = new Map<string, Mock>();

function getFallback(name: string): Mock {
  if (!fallbackFns.has(name)) fallbackFns.set(name, vi.fn());
  return fallbackFns.get(name)!;
}

export async function createEngineCoreMock(
  importActual: () => Promise<AnyModule>,
  overrides: AnyModule = {},
): Promise<AnyModule> {
  const actual = await importActual();
  const merged = { ...actual, ...overrides };
  return new Proxy(merged, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (["then", "catch", "finally"].includes(prop)) return undefined;

      const actualValue = actual[prop];
      if (typeof actualValue === "function" || actualValue === undefined) {
        const fn = getFallback(prop);
        target[prop] = fn;
        return fn;
      }
      return actualValue;
    },
  });
}

export function resetEngineCoreMockState(): void {
  for (const fn of fallbackFns.values()) fn.mockReset();
}

export type MockFn = Mock;
