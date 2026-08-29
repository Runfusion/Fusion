/**
 * Narrow an unknown caught error into a string message.
 *
 * Designed to replace the `catch (err: any) { ... err.message ... }` pattern:
 * prefer `catch (err) { toast(getErrorMessage(err)) }` — keeps the binding
 * typed as `unknown` (TS default with useUnknownInCatchVariables) while
 * still producing a readable message.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/*
FNXC:ErrorCauseChain 2026-08-26-08:14:
DRIZZLE PUTS THE SQL IN `message` AND THE REASON IN `cause`.

A failed query surfaces as `DrizzleQueryError` whose message is
`Failed query: <the entire statement> params: ...`, while the actual `PostgresError` — the one
saying `column "x" does not exist` or `permission denied` — lives in `err.cause`. Any handler that
reports `err.message` alone therefore shows an operator a wall of SQL and NOTHING about what went
wrong. Field reports of exactly that shape were undiagnosable, which is why `startup-factory` grew
its own private chain walker; this is that walker, shared, so every surface stops dropping the half
that matters.
*/
const MAX_CHAIN_DEPTH = 5;

function collectErrorChain(err: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < MAX_CHAIN_DEPTH; depth += 1) {
    messages.push(getErrorMessage(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

function truncateMiddle(message: string, max: number): string {
  if (message.length <= max) return message;
  return `${message.slice(0, Math.floor(max / 2))} … [truncated] … ${message.slice(-Math.floor(max / 4))}`;
}

/** Outer-to-inner rendering of an error and its causes, for LOGS. */
export function describeErrorChain(err: unknown, options: { maxMessageLength?: number } = {}): string {
  const max = options.maxMessageLength ?? 1200;
  return collectErrorChain(err).map((message) => truncateMiddle(message, max)).join(" ⇐ caused by: ");
}

/*
FNXC:ErrorCauseChain 2026-08-26-08:14:
Invert the chain ONLY when the outer frame is machine noise rather than a sentence.

An application error message is deliberate: a handler that throws "task detail load failed" chose
those words for the operator, and the API boundary reports it while the full chain goes to the log.
That contract stays.

A Drizzle query wrapper is the opposite — nobody wrote it for a human. Its message is
`Failed query: <the entire statement> params: …` and the sentence that says what to fix
(`column "x" does not exist`, `permission denied`, `connection terminated`) is in `cause`, dropped by
every handler reading `message`. Reported from the task chat as a screenful of column names with no
reason attached, and undiagnosable from the report itself.

So the rule is narrow and keyed on that known wrapper, never on a guess about which message "looks"
more useful.
*/
const MACHINE_GENERATED_FRAME = /^Failed query:/i;

export function summarizeErrorForOperator(err: unknown, options: { contextLength?: number } = {}): string {
  const chain = collectErrorChain(err).filter((message) => message.trim().length > 0);
  if (chain.length === 0) return getErrorMessage(err);

  const frame = chain[0]!;
  if (chain.length === 1 || !MACHINE_GENERATED_FRAME.test(frame)) return frame;

  const headline = chain[chain.length - 1]!;
  const context = truncateMiddle(frame, options.contextLength ?? 160);
  return context === headline ? headline : `${headline} (while running: ${context})`;
}
