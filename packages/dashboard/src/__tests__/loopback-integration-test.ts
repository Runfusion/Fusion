import http from "node:http";
import { it } from "vitest";

type IntegrationTestCase = (name: string, fn: () => unknown | Promise<unknown>, timeout?: number) => ReturnType<typeof it>;

const LOOPBACK_SKIP_REASON = "loopback binding to 127.0.0.1 is unavailable in this environment";

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

async function isLoopbackBindingAvailable(): Promise<boolean> {
  if (!loopbackBindingAvailablePromise) {
    loopbackBindingAvailablePromise = detectLoopbackBinding();
  }

  return await loopbackBindingAvailablePromise;
}

export async function createLoopbackIntegrationTest(scope: string): Promise<IntegrationTestCase> {
  const loopbackBindingAvailable = await isLoopbackBindingAvailable();

  if (loopbackBindingAvailable) {
    return (name, fn, timeout) => it(name, fn, timeout);
  }

  return (name, fn, timeout) => it.skip(`${name} (skipped: ${LOOPBACK_SKIP_REASON}; scope: ${scope})`, fn, timeout);
}
