/**
 * Resolution stub for @fusion/engine in plugin test mode.
 *
 * Vitest resolves mocked module IDs before applying vi.mock factories. The
 * real @fusion/engine workspace package points to dist outputs that are not
 * built for plugin-local test runs, so we alias to this stub in vitest config.
 *
 * Any direct import of @fusion/engine in plugin tests should still fail fast.
 */
const guardError = () =>
  new Error(
    "Guard: @fusion/engine was imported without an explicit mock. Runtime plugin tests must mock '../pi-module.js' to prevent loading the real engine.",
  );

export const createFnAgent = () => {
  throw guardError();
};

export const promptWithFallback = async () => {
  throw guardError();
};

export const describeModel = () => {
  throw guardError();
};
