/**
 * Plugin step-parser adapter (U12, KTD-12).
 *
 * Bridges plugin-contributed step parsers into core's {@link StepParserRegistry},
 * mirroring {@link import("./plugin-trait-adapter.js")} for traits. Plugins
 * register parsers under namespaced ids (`plugin:<pluginId>:<parserId>`) so they
 * can never collide with or override the built-ins (`step-headings`,
 * `json-steps`) — the registry enforces builtin-namespace protection and the
 * `plugin:` id shape on registration.
 *
 * Contract (KTD-12): a plugin parser is `(artifactContent) => { steps }`. The
 * adapter wraps each contributed parser so that:
 *   - a throw is re-thrown as a {@link PluginParserError} (fail-closed): the
 *     engine's `parse-steps` handler maps any throw to a routable
 *     `outcome:parse-error` (audited) — never a crash;
 *   - an unavailable parser (the plugin provides no usable `parse` function) is
 *     likewise a fail-closed throw;
 *   - a result that is not a `{ steps: [...] }` object is rejected (fail-closed).
 *
 * Timeout posture (documented deviation): the core registry's `parse` is
 * synchronous (the engine handler calls it inline), so a plugin parser cannot be
 * pre-empted mid-call by a timer the way an async runtime hook (trait adapter)
 * can. Plugin parsers run with the same trust tier as project-local script steps
 * (KTD-15 framing). The adapter therefore enforces the timeout BUDGET it is
 * given by measuring wall time AROUND the synchronous call and failing closed
 * (throw → parse-error) when the parser overran — the result is discarded so a
 * slow parser can never silently feed a stale/partial step list. A truly
 * runaway synchronous parser is a plugin bug bounded by the same posture as a
 * runaway script step.
 */

import { StepParserRegistry, getStepParserRegistry } from "@fusion/core";
import type { ParsedStep, StepParseResult, StepParser } from "@fusion/core";

/** Default budget for a plugin parser invocation (ms). */
export const PLUGIN_PARSER_TIMEOUT_MS = 5_000;

/** Build the registry-facing id for a plugin parser. */
export function pluginParserRegistryId(pluginId: string, parserId: string): string {
  return `plugin:${pluginId}:${parserId}`;
}

/** A plugin's step-parser contribution. `parse` is synchronous (project-local
 *  trust tier); the adapter wraps it fail-closed. */
export interface PluginStepParserContribution {
  parserId: string;
  /** `(artifactContent) => { steps }`. May throw on malformed input. */
  parse: (content: string) => StepParseResult;
}

/** Fail-closed error the wrapped parser throws; the parse-steps handler maps any
 *  throw to a routable `outcome:parse-error` (audited). */
export class PluginParserError extends Error {
  readonly parserId: string;
  readonly reason: "unavailable" | "throw" | "timeout" | "bad-result";
  constructor(parserId: string, reason: PluginParserError["reason"], message: string) {
    super(message);
    this.name = "PluginParserError";
    this.parserId = parserId;
    this.reason = reason;
  }
}

/** Validate that a value matches the `{ steps: ParsedStep[] }` contract. */
function assertStepParseResult(registryId: string, value: unknown): StepParseResult {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { steps?: unknown }).steps)) {
    throw new PluginParserError(registryId, "bad-result", `plugin parser '${registryId}' returned a non-{steps} result`);
  }
  const steps = (value as { steps: unknown[] }).steps;
  for (const s of steps) {
    if (typeof s !== "object" || s === null || typeof (s as { name?: unknown }).name !== "string") {
      throw new PluginParserError(registryId, "bad-result", `plugin parser '${registryId}' returned a step without a string name`);
    }
  }
  return { steps: steps as ParsedStep[] };
}

/**
 * Wrap a plugin contribution into a registry {@link StepParser} (fail-closed).
 * The wrapped `parse` re-throws every failure as a {@link PluginParserError};
 * the engine's parse-steps handler maps the throw to `outcome:parse-error`.
 */
export function pluginParserToRegistryParser(
  pluginId: string,
  contribution: PluginStepParserContribution,
  timeoutMs: number = PLUGIN_PARSER_TIMEOUT_MS,
): StepParser {
  const registryId = pluginParserRegistryId(pluginId, contribution.parserId);
  return {
    id: registryId,
    parse(content: string): StepParseResult {
      if (typeof contribution.parse !== "function") {
        throw new PluginParserError(registryId, "unavailable", `plugin parser '${registryId}' has no parse function`);
      }
      const started = Date.now();
      let raw: StepParseResult;
      try {
        raw = contribution.parse(content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new PluginParserError(registryId, "throw", `plugin parser '${registryId}' threw: ${message}`);
      }
      // Wall-time budget enforcement (documented sync-timeout posture): discard a
      // result produced after the budget rather than feed a stale step list.
      if (Date.now() - started > timeoutMs) {
        throw new PluginParserError(
          registryId,
          "timeout",
          `plugin parser '${registryId}' exceeded ${timeoutMs}ms budget`,
        );
      }
      return assertStepParseResult(registryId, raw);
    },
  };
}

/**
 * Register a plugin's step-parser contributions into the registry. Idempotent
 * per id (a re-register of an already-present id is skipped). Returns the
 * registry ids registered so the caller can later unregister them. Mirrors
 * {@link import("./plugin-trait-adapter.js").registerPluginTraits}.
 */
export function registerPluginStepParsers(params: {
  registry?: StepParserRegistry;
  pluginId: string;
  contributions: PluginStepParserContribution[];
  timeoutMs?: number;
}): string[] {
  const registry = params.registry ?? getStepParserRegistry();
  const registered: string[] = [];
  for (const contribution of params.contributions) {
    const parser = pluginParserToRegistryParser(params.pluginId, contribution, params.timeoutMs);
    if (!registry.has(parser.id)) {
      // Registration enforces the `plugin:` id shape + builtin protection.
      registry.register(parser, { builtin: false });
    }
    registered.push(parser.id);
  }
  return registered;
}

/**
 * Unregister a plugin's step parsers (plugin teardown / reload). Built-ins are
 * never removed (the registry refuses). Returns the removed registry ids.
 */
export function unregisterPluginStepParsers(
  pluginId: string,
  parserIds: string[],
  registry: StepParserRegistry = getStepParserRegistry(),
): string[] {
  const removed: string[] = [];
  for (const parserId of parserIds) {
    const id = pluginParserRegistryId(pluginId, parserId);
    if (registry.unregister(id)) removed.push(id);
  }
  return removed;
}
