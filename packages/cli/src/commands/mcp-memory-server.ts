import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  MemoryMcpHandler,
  createMemoryMcpBackends,
  type MemoryMcpBackends,
  type MemoryMcpBudgetProvider,
} from "@fusion/core/memory-mcp";
import { createLocalStore, closeProjectStore, asLocalProjectContext } from "../project-context.js";
import { retryOnLock } from "../lock-retry.js";

export async function runMemoryMcpServerLoop(options: {
  input: Readable;
  output: Writable;
  projectRoot: string;
  backends?: MemoryMcpBackends;
  budgetProvider?: MemoryMcpBudgetProvider;
  onClose?: () => Promise<void> | void;
}): Promise<void> {
  const handler = new MemoryMcpHandler(
    options.backends ?? createMemoryMcpBackends(options.projectRoot, null),
    options.budgetProvider,
  );
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let request: unknown;
      try { request = JSON.parse(line); } catch { continue; }
      const response = await handler.handle(request);
      if (response) options.output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    await options.onClose?.();
  }
}

/**
 * FNXC:MemoryMcp 2026-08-10-20:32:
 * FN-8926 opens the project store once on the first tool call because the output
 * budget and recall layer are store-resident. A failed open preserves graph access
 * with the handler's finite fallback budget while recall reports an actionable tool error.
 */
export async function runMcpMemoryServer(projectRoot: string): Promise<void> {
  let store: Awaited<ReturnType<typeof createLocalStore>> | undefined;
  let opened = false;
  let openFailureLogged = false;
  const openStore = async () => {
    if (opened) return store;
    opened = true;
    try {
      store = await createLocalStore(projectRoot);
      return store;
    } catch {
      if (!openFailureLogged) {
        openFailureLogged = true;
        console.error("fusion-memory MCP store unavailable");
      }
      return undefined;
    }
  };
  const budgetProvider: MemoryMcpBudgetProvider = async () => {
    const resolved = await openStore();
    if (!resolved) return null;
    try {
      const settings = await retryOnLock(() => resolved.getSettings(), {
        id: "memory-mcp-settings",
        action: "read memory MCP settings",
      });
      return { settings };
    } catch {
      return null;
    }
  };
  const lazyBackends: MemoryMcpBackends = {
    graphQuery: async (args) => createMemoryMcpBackends(projectRoot, (await openStore())?.getAsyncLayer() ?? null).graphQuery(args),
    graphNeighbors: async (args) => createMemoryMcpBackends(projectRoot, (await openStore())?.getAsyncLayer() ?? null).graphNeighbors(args),
    graphShortestPath: async (args) => createMemoryMcpBackends(projectRoot, (await openStore())?.getAsyncLayer() ?? null).graphShortestPath(args),
    recallSearch: async (args) => createMemoryMcpBackends(projectRoot, (await openStore())?.getAsyncLayer() ?? null).recallSearch(args),
    recallAppend: async (args) => createMemoryMcpBackends(projectRoot, (await openStore())?.getAsyncLayer() ?? null).recallAppend(args),
  };
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      if (store) await closeProjectStore(asLocalProjectContext(store));
    })();
    return closePromise;
  };
  const stop = () => {
    /*
    FNXC:MemoryMcpLifecycle 2026-08-10-20:34:
    Signal listeners replace Node's default exit behavior. Close the owned store once and destroy stdin so the JSON-RPC loop terminates rather than retaining a live process.
    */
    void close().finally(() => process.stdin.destroy());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await runMemoryMcpServerLoop({ input: process.stdin, output: process.stdout, projectRoot, backends: lazyBackends, budgetProvider, onClose: close });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await close();
  }
}
