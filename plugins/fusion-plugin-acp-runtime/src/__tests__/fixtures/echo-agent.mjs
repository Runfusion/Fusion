#!/usr/bin/env node
// Minimal runnable ACP *agent* fixture for U2 handshake tests.
//
// Modeled on the SDK's dist/examples/agent.js. For an AGENT, ndJsonStream's
// output is process.stdout and its input is process.stdin (the mirror of the
// client side). Later units extend this fixture; U2 only needs a real peer that
// completes `initialize`, opens a session, and runs a trivial prompt turn.
//
// Test knobs (env):
//   ACP_FIXTURE_PROTOCOL_VERSION  — override the protocolVersion returned by
//                                   initialize (e.g. "999" for mismatch tests).
//   ACP_FIXTURE_HANG_INITIALIZE=1 — never respond to initialize (timeout test).
//   ACP_FIXTURE_LEAK_TOKEN=1      — write a fake auth token to stderr (redaction
//                                   test).
//   ACP_FIXTURE_REQUIRE_AUTH=1    — advertise a non-empty authMethods list.
//   ACP_FIXTURE_RICH_PROMPT=1     — prompt emits the full U4 update vocabulary
//                                   (agent_message_chunk, agent_thought_chunk,
//                                   tool_call, tool_call_update[completed], plan)
//                                   before resolving the turn.

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

class EchoAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
    // Resolver for the in-flight prompt when ACP_FIXTURE_HANG_PROMPT is set:
    // the turn stays open until cancel() fires, then resolves "cancelled".
    this._cancelTurn = undefined;
  }

  async initialize(_params) {
    if (process.env.ACP_FIXTURE_LEAK_TOKEN === "1") {
      process.stderr.write(
        "auth failed: Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n",
      );
    }
    if (process.env.ACP_FIXTURE_HANG_INITIALIZE === "1") {
      // Never resolve — the client's handshake timeout must fire.
      return new Promise(() => {});
    }
    const versionOverride = process.env.ACP_FIXTURE_PROTOCOL_VERSION;
    const protocolVersion =
      versionOverride !== undefined ? Number(versionOverride) : PROTOCOL_VERSION;
    const response = {
      protocolVersion,
      agentCapabilities: { loadSession: process.env.ACP_FIXTURE_LOAD_SESSION === "1" },
    };
    if (process.env.ACP_FIXTURE_REQUIRE_AUTH === "1") {
      response.authMethods = [{ id: "api-key", name: "API Key", description: null }];
    }
    return response;
  }

  async authenticate(_params) {
    return {};
  }

  async newSession(_params) {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.sessions.set(sessionId, {});
    return { sessionId };
  }

  async loadSession(params) {
    // Resume path: acknowledge the existing session id (history replay would
    // happen here in a real agent). Mark that this session was loaded, not new.
    this.sessions.set(params.sessionId, { loaded: true });
    return {};
  }

  async setSessionMode(_params) {
    return {};
  }

  async prompt(params) {
    if (process.env.ACP_FIXTURE_RICH_PROMPT === "1") {
      const sessionId = params.sessionId;
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Working on it." },
        },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me think about this." },
        },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Run tests",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "pnpm test" },
        },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          rawOutput: { exitCode: 0 },
        },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the code", priority: "high", status: "completed" },
            { content: "Fix the bug", priority: "medium", status: "pending" },
          ],
        },
      });
      return { stopReason: "end_turn" };
    }
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "echo: hello" },
      },
    });
    // Cancel-mid-prompt test: keep the turn open until cancel() arrives, then
    // resolve with the "cancelled" stop reason (mirrors a real agent).
    if (process.env.ACP_FIXTURE_HANG_PROMPT === "1") {
      // Race-proof: cancel() can be dispatched while this handler is suspended
      // on the sessionUpdate write above (JSON-RPC notifications are handled
      // concurrently). If the cancel already landed, resolve immediately
      // instead of registering a hang nobody will release — this exact race
      // made the cancel-mid-prompt test time out on loaded CI shards.
      if (this._cancelRequested) {
        this._cancelRequested = false;
        return { stopReason: "cancelled" };
      }
      return await new Promise((resolve) => {
        this._cancelTurn = () => resolve({ stopReason: "cancelled" });
      });
    }
    return { stopReason: "end_turn" };
  }

  async cancel(_params) {
    // Release any in-flight hung turn with a "cancelled" stop reason. If the
    // prompt handler hasn't reached its hang point yet, record the cancel so
    // it resolves immediately when it does (see prompt()).
    if (this._cancelTurn) {
      const release = this._cancelTurn;
      this._cancelTurn = undefined;
      release();
    } else {
      this._cancelRequested = true;
    }
  }
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = ndJsonStream(output, input);
new AgentSideConnection((conn) => new EchoAgent(conn), stream);
