/**
 * Shared lazy accessor for `@fusion/engine`'s `createFnAgent`.
 *
 * Core can't import engine statically (engine depends on core, so a static
 * import would create a cycle). Instead, engine wires its `createFnAgent` in
 * via `setCreateFnAgent` when its module loads, and consumers in core read it
 * back through `getFnAgent`.
 *
 * If engine never loads (e.g. tests that only import core), `getFnAgent`
 * returns `undefined` and callers degrade gracefully.
 */

// Engine exports a function type we intentionally don't pull in here — importing
// the type would reintroduce the cycle this module is designed to avoid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateFnAgent = any;

let createFnAgent: CreateFnAgent | undefined;

/** Shape of a message in an agent session's state. */
export interface AgentMessage {
  role: string;
  content?: string | Array<{ type: string; text: string }>;
}

/**
 * Wire engine's `createFnAgent` into core. Called by `@fusion/engine` at module
 * load. Tests can also call this with a stub.
 */
export function setCreateFnAgent(fn: CreateFnAgent | undefined): void {
  createFnAgent = fn;
}

/**
 * Returns `createFnAgent` from `@fusion/engine`, or `undefined` if engine has
 * not registered itself yet (typical in tests).
 */
export async function getFnAgent(): Promise<CreateFnAgent> {
  return createFnAgent;
}
