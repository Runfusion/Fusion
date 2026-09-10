/*
FNXC:Identity 2026-08-14-05:32 (review finding — the matcher needs its own control):

`ANY_MUTATION_CONTEXT` is asserted by hundreds of lane tests, so if IT stops discriminating, all of
them keep passing while proving nothing. It previously matched the actor id with `expect.any(String)`,
which accepts `"system:unattributed"` — the exact value the attribution ratchet exists to catch.

These are the matcher's own proven-failing controls: the first fails if the matcher ever stops
rejecting the unattributed marker, the second fails if a tightened matcher starts rejecting real
actors (over-tightening would be just as wrong, and would show up as unrelated suite-wide breakage).
*/

import { describe, expect, it, vi } from "vitest";
import { ANY_MUTATION_CONTEXT, UNATTRIBUTED_CONTEXT_MATCHER } from "./mutation-context-matchers.js";

const ctx = (id: string) => ({ actor: { actor: { id } } });

describe("ANY_MUTATION_CONTEXT", () => {
  it("rejects the explicit unattributed marker", () => {
    const fn = vi.fn();
    fn(ctx("system:unattributed"));
    expect(() => expect(fn).toHaveBeenCalledWith(ANY_MUTATION_CONTEXT)).toThrow();
  });

  it("accepts a real attributed actor", () => {
    const fn = vi.fn();
    fn(ctx("agent-executor-1"));
    expect(fn).toHaveBeenCalledWith(ANY_MUTATION_CONTEXT);
  });

  // An un-threaded call site passes no context at all; that must still fail the assertion.
  it("rejects a missing or empty context", () => {
    const fn = vi.fn();
    fn(undefined);
    expect(() => expect(fn).toHaveBeenCalledWith(ANY_MUTATION_CONTEXT)).toThrow();
    const bare = vi.fn();
    bare({});
    expect(() => expect(bare).toHaveBeenCalledWith(ANY_MUTATION_CONTEXT)).toThrow();
  });

  // The known-unwired sites assert this instead, which keeps the remaining gaps countable.
  it("leaves the unattributed marker assertable by its own matcher", () => {
    const fn = vi.fn();
    fn(ctx("system:unattributed"));
    expect(fn).toHaveBeenCalledWith(UNATTRIBUTED_CONTEXT_MATCHER);
  });
});
