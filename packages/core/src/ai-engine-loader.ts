/**
 * Shared lazy loader for `@fusion/engine`'s `createKbAgent`.
 *
 * @fusion/engine must be imported dynamically (not statically) so that:
 *   - core can be consumed in test environments where engine isn't resolvable
 *   - a missing engine package fails soft instead of breaking module load
 *
 * Using a variable module specifier also prevents bundlers (Vite) from
 * statically analysing and trying to resolve the import at build time.
 */

// Engine exports a function type we intentionally don't pull in here — importing
// the type would reintroduce the static resolution this module is designed to avoid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateKbAgent = any;

let createKbAgent: CreateKbAgent | undefined;

async function initEngine(): Promise<void> {
  try {
    const engineModule = "@fusion/engine";
    const engine = await import(/* @vite-ignore */ engineModule);
    createKbAgent = engine.createKbAgent;
  } catch {
    createKbAgent = undefined;
  }
}

/** Shape of a message in an agent session's state. */
export interface AgentMessage {
  role: string;
  content?: string | Array<{ type: string; text: string }>;
}

/** Promise that resolves once the initial load attempt has completed. */
const engineReady: Promise<void> = initEngine();

/**
 * Returns `createKbAgent` from `@fusion/engine`, or `undefined` if the engine
 * could not be loaded (typical in tests or when engine isn't installed).
 */
export async function getKbAgent(): Promise<CreateKbAgent> {
  await engineReady;
  return createKbAgent;
}
