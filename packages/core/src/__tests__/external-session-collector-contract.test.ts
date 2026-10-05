import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { externalSessionTurnIngestionSchema } from "../external-sessions/turn-contract.js";

/*
FNXC:RemoteAgents 2026-10-04-13:00:
The host collectors are standard-library Python and this contract is zod, so nothing type-checks one against
the other. They drifted twice in one day: usage entries without the pricing band flags, then entries with a
null model. Fusion rejected every such turn with 400 and collectors that set rejected turns aside dropped
thousands of them. This test runs the real Python parser over fixture transcripts that carry the known edge
cases and requires every turn it would send to pass the server's strict schema.
*/
const remoteAgents = fileURLToPath(new URL("../../../../scripts/remote-agents/", import.meta.url));

function emitted(provider: "claude" | "codex"): Array<Record<string, unknown>> {
  // The request goes on stdin: the suite's child-process guard blocks any command line naming an AI CLI, and this
  // runs only the standard-library parser, never a CLI.
  const out = execFileSync("python3", ["emit_turns.py"], { cwd: remoteAgents, encoding: "utf8",
    input: JSON.stringify({ provider, path: `fixtures/${provider}.jsonl` }) });
  return JSON.parse(out) as Array<Record<string, unknown>>;
}

describe("Python collector output matches the external-session turn contract", () => {
  it.each(["claude", "codex"] as const)("every %s turn the collector would send is accepted", provider => {
    const turns = emitted(provider);
    expect(turns.length).toBeGreaterThan(3);
    expect(turns.filter(turn => Array.isArray(turn.usage) && turn.usage.length > 0).length).toBeGreaterThan(0);
    for (const turn of turns) {
      const parsed = externalSessionTurnIngestionSchema.safeParse({ schemaVersion: 1, eventId: "event", sessionId: "a".repeat(64), turn });
      expect(parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`), JSON.stringify(turn).slice(0, 400)).toEqual([]);
    }
  });

  it("marks accounting incomplete instead of sending usage it cannot attribute", () => {
    for (const provider of ["claude", "codex"] as const) {
      expect(emitted(provider).some(turn => turn.usageComplete === false)).toBe(true);
    }
  });
});
