/*
FNXC:AcpRuntime 2026-07-15-19:10 (FN-8004):
An ACP turn failing server-side arrives as a JSON-RPC error whose `message` is the bare
protocol-standard text — `-32603` renders as literally "Internal error". Rethrowing it unchanged
discarded `code`/`data`, the only evidence the fault was provider-side and retryable. The engine's
transient classifier then saw an unclassifiable string and parked the task permanently, stranding
completed work (FN-8004: a ~20s Grok blip terminally failed an auto-merge).

These tests pin the diagnostic SHAPE, because `transient-error-patterns.ts` and
`transient-merge-error-classifier.ts` match on it. Changing the format here without updating those
regexes silently reintroduces the FN-8004 stranding — the string is a cross-package contract.
*/
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import os from "node:os";
import { describeAcpTurnError, inspectAcpTurnError, newAcpSession, promptAcpSession } from "../provider.js";

/** Flat `{ code, message, data }` — one of two shapes the SDK throws depending on build. */
function flatRpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

/** Nested `{ error: { code, message } }` — the other observed SDK shape. */
function nestedRpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error("request failed"), {
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

describe("inspectAcpTurnError", () => {
  it("extracts code and retryability from a flat JSON-RPC error", () => {
    const detail = inspectAcpTurnError(flatRpcError(-32603, "Internal error"));
    expect(detail).toMatchObject({ message: "Internal error", code: -32603, retryable: true });
  });

  it("extracts code from the nested { error: { ... } } shape", () => {
    const detail = inspectAcpTurnError(nestedRpcError(-32603, "Internal error"));
    expect(detail).toMatchObject({ message: "Internal error", code: -32603, retryable: true });
  });

  it("marks caller-fault codes non-retryable", () => {
    // -32600/-32601/-32602 mean WE sent a bad request; retrying repeats the failure.
    for (const code of [-32600, -32601, -32602]) {
      expect(inspectAcpTurnError(flatRpcError(code, "Invalid request")).retryable).toBe(false);
    }
  });

  it("marks the provider server-error range retryable", () => {
    for (const code of [-32603, -32000, -32001, -32002, -32003]) {
      expect(inspectAcpTurnError(flatRpcError(code, "Server error")).retryable).toBe(true);
    }
  });

  it("degrades gracefully on non-RPC errors and non-Error throws", () => {
    expect(inspectAcpTurnError(new Error("boom"))).toMatchObject({ message: "boom", code: undefined, retryable: false });
    expect(inspectAcpTurnError("plain string")).toMatchObject({ message: "plain string", retryable: false });
    expect(inspectAcpTurnError(null)).toMatchObject({ message: "unknown error", retryable: false });
  });
});

describe("describeAcpTurnError", () => {
  it("renders the rpc code so downstream classifiers can anchor on it", () => {
    expect(describeAcpTurnError(flatRpcError(-32603, "Internal error")))
      .toBe("Internal error (acp rpc code -32603, retryable)");
  });

  it("omits the retryable marker for caller-fault codes", () => {
    expect(describeAcpTurnError(flatRpcError(-32602, "Invalid params")))
      .toBe("Invalid params (acp rpc code -32602)");
  });

  it("appends structured data when the provider supplies a cause", () => {
    const out = describeAcpTurnError(flatRpcError(-32603, "Internal error", { reason: "upstream timeout" }));
    expect(out).toContain("acp rpc code -32603, retryable");
    expect(out).toContain('[data: {"reason":"upstream timeout"}]');
  });

  it("leaves plain errors untouched so unrelated failures are not disguised as ACP faults", () => {
    expect(describeAcpTurnError(new Error("Test suite failed"))).toBe("Test suite failed");
  });

  it("survives unserializable data without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeAcpTurnError(flatRpcError(-32603, "Internal error", circular))).not.toThrow();
  });

  it("bounds oversized data payloads", () => {
    const out = describeAcpTurnError(flatRpcError(-32603, "Internal error", { blob: "x".repeat(5_000) }));
    expect(out.length).toBeLessThan(700);
  });
});

describe("promptAcpSession error propagation", () => {
  const session = { conn: { prompt: async () => ({ stopReason: "end_turn" }) } };

  it("returns the stopReason on success", async () => {
    await expect(promptAcpSession(session as never, "s1", [])).resolves.toBe("end_turn");
  });

  it("rethrows provider faults with the rpc code preserved in the message", async () => {
    const failing = { conn: { prompt: async () => { throw flatRpcError(-32603, "Internal error"); } } };
    // The regression: this message previously read only "Internal error".
    await expect(promptAcpSession(failing as never, "s1", [])).rejects.toThrow(
      "Internal error (acp rpc code -32603, retryable)",
    );
  });

  it("retains the original error as `cause` for debugging", async () => {
    const original = flatRpcError(-32603, "Internal error");
    const failing = { conn: { prompt: async () => { throw original; } } };
    await expect(promptAcpSession(failing as never, "s1", [])).rejects.toMatchObject({ cause: original });
  });
});


describe("newAcpSession error propagation", () => {
  // Unpredictable per-run path: avoids CWE-377 (predictable temp path) and
  // matches real usage, where each session scopes to its own worktree.
  const opts = { cwd: `${os.tmpdir()}/acp-session-new-${crypto.randomUUID()}` };
  const cwdPrefix = `session/new failed (cwd ${opts.cwd}):`;

  it("opens a session on success", async () => {
    const conn = { conn: { newSession: async () => ({ sessionId: "abc" }) } };
    await expect(newAcpSession(conn as never, opts)).resolves.toMatchObject({ sessionId: "abc" });
  });

  it("rethrows session/new faults with rpc code AND the scoping cwd in the message", async () => {
    // The regression: a stale acpBinaryPath made every heartbeat fail with bare
    // "Invalid params" -- no hint of which agent binary rejected the request.
    const failing = { conn: { newSession: async () => { throw flatRpcError(-32602, "Invalid params"); } } };
    await expect(newAcpSession(failing as never, opts)).rejects.toThrow(
      `session/new failed (cwd ${opts.cwd}): Invalid params (acp rpc code -32602)`,
    );
  });

  it("retains the original error as `cause`", async () => {
    const original = flatRpcError(-32602, "Invalid params");
    const failing = { conn: { newSession: async () => { throw original; } } };
    await expect(newAcpSession(failing as never, opts)).rejects.toMatchObject({ cause: original });
  });

  it("covers the full inspectAcpTurnError invariant across known RPC shapes", async () => {
    // Each shape asserts: cwd prefix, formatted diagnostic, original cause.
    const cases: Array<{ name: string; error: Error; expected: string; retryable?: boolean }> = [
      {
        name: "nested { error: { code, message } } envelope",
        error: Object.assign(new Error("request failed"), {
          error: { code: -32602, message: "Invalid params" },
        }),
        expected: `${cwdPrefix} Invalid params (acp rpc code -32602)`,
      },
      {
        name: "retryable provider fault (-32603)",
        error: flatRpcError(-32603, "Internal error"),
        expected: `session/new failed (cwd ${opts.cwd}): Internal error (acp rpc code -32603, retryable)`,
      },
      {
        name: "structured data payload from the agent",
        error: flatRpcError(-32000, "Server error", { reason: "unknown session" }),
        expected:
          `${cwdPrefix} Server error (acp rpc code -32000, retryable) [data: {"reason":"unknown session"}]`,
      },
      {
        name: "nested envelope with structured data payload",
        error: Object.assign(new Error("request failed"), {
          error: { code: -32602, message: "Invalid params", data: { foo: "bar" } },
        }),
        expected: `${cwdPrefix} Invalid params (acp rpc code -32602) [data: {"foo":"bar"}]`,
      },
    ];

    for (const c of cases) {
      const failing = { conn: { newSession: async () => { throw c.error; } } };
      await expect(newAcpSession(failing as never, opts)).rejects.toThrow(c.expected);
      await expect(newAcpSession(failing as never, opts)).rejects.toMatchObject({ cause: c.error });
    }
  });

  it("passes plain non-RPC errors through without disguising them as ACP faults", async () => {
    const original = new Error("spawn ENOENT");
    const failing = { conn: { newSession: async () => { throw original; } } };
    await expect(newAcpSession(failing as never, opts)).rejects.toThrow(
      `${cwdPrefix} spawn ENOENT`,
    );
  });
});
