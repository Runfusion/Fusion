/**
 * Canonical @fusion/core and @fusion/engine mock helpers for CLI command tests.
 *
 * When a new commonly-mocked export is added, update defaults here instead of
 * copying large inline export lists into command suites.
 */
import { vi, type Mock } from "vitest";

type AnyModule = Record<string, unknown>;
type AnyMock = Mock;

const fallbackFns = new Map<string, AnyMock>();

function getFallback(name: string): AnyMock {
  if (!fallbackFns.has(name)) {
    fallbackFns.set(name, vi.fn());
  }
  return fallbackFns.get(name)!;
}

function withFallbackFunctions(actual: AnyModule, mocked: AnyModule): AnyModule {
  return new Proxy(mocked, {
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

export async function createCliCoreMock(
  importActual: () => Promise<AnyModule>,
  defaults: AnyModule = {},
  overrides: AnyModule = {},
): Promise<AnyModule> {
  const actual = await importActual();
  return withFallbackFunctions(actual, { ...actual, ...defaults, ...overrides });
}

export async function createCliEngineMock(
  importActual: () => Promise<AnyModule>,
  defaults: AnyModule = {},
  overrides: AnyModule = {},
): Promise<AnyModule> {
  const actual = await importActual();
  return withFallbackFunctions(actual, { ...actual, ...defaults, ...overrides });
}

export function resetCliCoreEngineMockState(): void {
  for (const fn of fallbackFns.values()) fn.mockReset();
}
