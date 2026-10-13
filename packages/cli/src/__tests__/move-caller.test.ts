import { describe, expect, it } from "vitest";
import { classifyCliMoveCaller, cliMoveCallerOptions } from "../move-caller.js";

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-19:35 (RUFU-406):
Characterization for the CLI move-caller classifier. The motivating measurement is RUFU-389: an agent's
`fn task move` carried `moveSource: "user"` into the terminal lane with no Code Review evidence, and the
durable record could not tell that call apart from a human's. `moveSource` cannot be changed to fix this —
`fn task move` IS a board action and the CLI has exactly one intent class (`"user"`), so re-labelling it
would silently re-classify every real operator move out of the consumers that depend on that stamp
(user-cancel semantics, the approval-hold clear, the human-actor classification).

The asymmetry these tests protect is the whole design: the classifier may UNDER-attribute a machine as an
operator (status quo, no regression), and must never OVER-attribute a human as a machine, because the label
is what an operator reads when deciding whether a refusal was justified. Hence the marker must be a
capability the agent cannot plausibly lack while still being a shell the human does not get, which is why
`PI_SESSION_ID`/`PI_SESSION_FILE` are used (Pi injects them into LLM-callable `bash`/`powershell` and
deletes them from the inherited environment; they are deliberately NOT injected into a user's `!`/`!!`
shell escape) and why a missing marker resolves to `operator-cli`.
*/

describe("classifyCliMoveCaller", () => {
  it("labels a bare shell as operator-cli, because an unset marker proves nothing", () => {
    expect(classifyCliMoveCaller({})).toEqual({ moveCallerSurface: "operator-cli" });
  });

  it("labels an unrelated CI variable as operator-cli rather than guessing at an agent", () => {
    /*
    The classifier reads ONLY the runtime session markers. An env that looks "automation-ish" (CI, GITHUB_*,
    FUSION_*) must not flip the label, or every CI-driven CLI call would be attributed to a model that was
    never there — the exact dishonesty this field exists to remove.
    */
    expect(classifyCliMoveCaller({ CI: "true", GITHUB_ACTIONS: "true", FUSION_TASK_ID: "RUFU-389" })).toEqual({
      moveCallerSurface: "operator-cli",
    });
  });

  it("labels a Pi session id as agent-cli and carries the session as the principal", () => {
    expect(classifyCliMoveCaller({ PI_SESSION_ID: "a1b2c3d4-ef56-7890-abcd-ef1234567890" })).toEqual({
      moveCallerSurface: "agent-cli",
      moveCallerPrincipal: { sessionId: "a1b2c3d4-ef56-7890-abcd-ef1234567890" },
    });
  });

  it("derives the principal from the session FILE basename, never storing the path", () => {
    /*
    Pi's own docs make the file path a first-class clue, but a durable audit row must not carry filesystem
    paths (run-audit metadata is ids/counts/fixed enums). The basename is already an opaque session
    identifier and is the documented filename shape `<timestamp>_<slug>.jsonl`, so the path is dropped and
    the identity is kept.
    */
    expect(
      classifyCliMoveCaller({
        PI_SESSION_FILE: "/home/operator/.fusion/pi-sessions/2026-10-11T09-14-22-000Z_rufu-406-executor.jsonl",
      }),
    ).toEqual({
      moveCallerSurface: "agent-cli",
      moveCallerPrincipal: { sessionId: "2026-10-11T09-14-22-000Z_rufu-406-executor" },
    });
  });

  it("prefers the explicit session id when both markers are present", () => {
    expect(
      classifyCliMoveCaller({
        PI_SESSION_ID: "explicit-id",
        PI_SESSION_FILE: "/var/tmp/2026-10-11T00-00-00-000Z_from-filename.jsonl",
      }),
    ).toEqual({ moveCallerSurface: "agent-cli", moveCallerPrincipal: { sessionId: "explicit-id" } });
  });

  it("treats an empty marker as absent instead of inventing an empty principal", () => {
    expect(classifyCliMoveCaller({ PI_SESSION_ID: "", PI_SESSION_FILE: "" })).toEqual({
      moveCallerSurface: "operator-cli",
    });
  });

  it("records the principal without a session id when the file name carries no usable stem", () => {
    /* A dotfile-shaped value (".jsonl") yields an empty stem; the CLASS is still proven by the marker's
     * presence, so the surface must not be downgraded and the principal must simply carry no id. */
    expect(classifyCliMoveCaller({ PI_SESSION_FILE: "/tmp/.jsonl" })).toEqual({
      moveCallerSurface: "agent-cli",
      moveCallerPrincipal: {},
    });
  });
});

describe("cliMoveCallerOptions", () => {
  it("spreads into moveTask options, adding the principal class without touching moveSource", () => {
    /*
    The shape contract with the store seam: the classifier contributes ONLY the provenance pair.
    `moveSource: "user"` stays whatever the command decided — this is why an agent's CLI move is still
    refused by the complete-column gate-evidence guard (same intent class) while being attributable.
    */
    const options = { moveSource: "user" as const, ...cliMoveCallerOptions({ PI_SESSION_ID: "sess-7" }) };
    expect(options).toEqual({
      moveSource: "user",
      moveCallerSurface: "agent-cli",
      moveCallerPrincipal: { sessionId: "sess-7" },
    });
  });

  it("omits the principal entirely for an operator shell, so no empty object pollutes the option", () => {
    expect(cliMoveCallerOptions({})).toEqual({ moveCallerSurface: "operator-cli" });
  });
});
