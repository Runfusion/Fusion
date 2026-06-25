/**
 * Shared helpers for SSE-driven hook tests. Builds a synthetic MessageEvent
 * whose `data` is the JSON-stringified payload, matching the shape these hooks
 * parse inside their event handlers.
 *
 * NOTE: each consuming test still owns its own `vi.mock("../../sse-bus", …)`
 * factory — vitest hoists `vi.mock` and resolves the path relative to the
 * caller, so the mock cannot be shared from here.
 */
export const msg = (data: object): MessageEvent =>
  ({ data: JSON.stringify(data) } as MessageEvent);

export const message = msg;
