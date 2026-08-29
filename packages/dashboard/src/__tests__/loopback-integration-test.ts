import http from "node:http";
import { it } from "vitest";

type IntegrationTestCase = (name: string, fn: () => unknown | Promise<unknown>, timeout?: number) => ReturnType<typeof it>;

const LOOPBACK_SKIP_REASON = "loopback binding to 127.0.0.1 is unavailable in this environment";

/**
 * Ensure skip output is auditable with both the standardized reason and the suite scope.
 *
 * Example: "... (skipped: loopback binding to 127.0.0.1 is unavailable in this environment; scope: websocket integration)"
 */
function formatLoopbackSkipName(testName: string, scope: string): string {
  return `${testName} (skipped: ${LOOPBACK_SKIP_REASON}; scope: ${scope})`;
}

let loopbackBindingAvailablePromise: Promise<boolean> | null = null;

async function detectLoopbackBinding(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Memoize loopback probe results so all integration suites share a single bind check.
 * This avoids creating redundant probe listeners during test startup.
 */
async function isLoopbackBindingAvailable(): Promise<boolean> {
  if (!loopbackBindingAvailablePromise) {
    loopbackBindingAvailablePromise = detectLoopbackBinding();
  }

  return await loopbackBindingAvailablePromise;
}

/**
 * Canonical gate for dashboard integration tests that require loopback binding.
 *
 * When loopback is unavailable, every skipped test name includes a standardized
 * reason string and the provided suite scope for auditability in test output.
 */
export async function createLoopbackIntegrationTest(scope: string): Promise<IntegrationTestCase> {
  const loopbackBindingAvailable = await isLoopbackBindingAvailable();

  if (loopbackBindingAvailable) {
    return (name, fn, timeout) => it(name, fn, timeout);
  }

  return (name, fn, timeout) => it.skip(formatLoopbackSkipName(name, scope), fn, timeout);
}
