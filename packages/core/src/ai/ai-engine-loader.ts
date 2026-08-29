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

import type { CreateAiSessionFactory, CreateInteractiveAiSessionFactory } from "../plugins/plugin-types.js";

// Engine exports a function type we intentionally don't pull in here — importing
// the type would reintroduce the cycle this module is designed to avoid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateFnAgent = any;

let createFnAgent: CreateFnAgent | undefined;
let createAiSessionFactory: CreateAiSessionFactory | undefined;
let createInteractiveAiSessionFactory: CreateInteractiveAiSessionFactory | undefined;

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

/**
 * Wire engine's plugin-facing AI session factory into core.
 * Called by `@fusion/engine` at module load; tests may register stubs.
 */
export function setCreateAiSessionFactory(fn: CreateAiSessionFactory | undefined): void {
  createAiSessionFactory = fn;
}

/**
 * Returns engine-registered plugin AI session factory, or `undefined` when
 * engine hasn't registered it (common in isolated core tests).
 */
export async function getCreateAiSessionFactory(): Promise<CreateAiSessionFactory | undefined> {
  return createAiSessionFactory;
}

/**
 * Wire engine's plugin-facing interactive AI session factory into core.
 * Called by `@fusion/engine` at module load; tests may register stubs.
 */
export function setCreateInteractiveAiSessionFactory(
  fn: CreateInteractiveAiSessionFactory | undefined,
): void {
  createInteractiveAiSessionFactory = fn;
}

/**
 * Returns engine-registered plugin interactive AI session factory, or
 * `undefined` when engine hasn't registered it (common in isolated core tests).
 */
export async function getCreateInteractiveAiSessionFactory(): Promise<
  CreateInteractiveAiSessionFactory | undefined
> {
  return createInteractiveAiSessionFactory;
}
