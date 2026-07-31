import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
FNXC:TerminalScrollback 2026-07-26-14:05:
The two xterm scrollback caps are load-bearing and were, until this test, completely uncovered.

A previous memory-pressure pass cut both to 2000 lines, justified by the claim that "the server replays its own scrollback on reconnect, so reachable history is unchanged". That claim is FALSE in two independent ways:

1. Server replay happens ONLY AT ATTACH TIME (one `scrollback` frame on connect). While a session stays attached, the client ring is the only history that exists; nothing re-fetches a line the client ring has evicted. Evicted history is permanently unreachable, not merely uncached.
2. Even at attach time the server ring is SMALLER than the client ring, so it cannot back-stop it. TerminalModal's PTY ring is `MAX_SCROLLBACK_SIZE` (CHARACTERS, not lines) in `packages/dashboard/src/terminal-service.ts`; SessionTerminal's CLI-agent ring is `DEFAULT_SCROLLBACK_BYTES` in `packages/engine/src/cli-agent/session-manager.ts`.

So this test encodes the RELATIONSHIP, not the literals: each client ring must hold more lines than its own server ring could ever replay. Both server capacities are read from their real source files, so shrinking a server ring relaxes this guard honestly and growing one tightens it — a future optimizer cannot satisfy it by editing a copied number here.

Why source-text parsing instead of imports: importing TerminalModal.tsx / SessionTerminal.tsx pulls xterm and the WebGL addon into the worker, and importing terminal-service.ts pulls node-pty via @fusion/engine. This is a constants/invariant test and must stay a few milliseconds with no DOM and no terminal. `MAX_SCROLLBACK_SIZE` is module-private anyway. Each read below FAILS LOUDLY if its constant is renamed or moved, so the guard cannot decay into a silent no-op.
*/

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const DASHBOARD_ROOT = resolve(HERE, "../../..");
const REPO_PACKAGES = resolve(DASHBOARD_ROOT, "..");

/*
FNXC:TerminalScrollback 2026-07-26-14:05:
Character/byte capacity converts to a LINE count only through an assumed density. 64 bytes/line is the conservative end of "typical terminal line" — conservative here means it yields a HIGHER server line count, which makes the requirement on the client ring STRICTER. It also reproduces the ~600-800-line estimate previously recorded for the 50000-character PTY ring (50000/64 = 781). Raising this constant to weaken a failing assertion is the appeasement this guard exists to prevent; if a real measurement says lines are wider, change it with the measurement cited.
*/
const TYPICAL_LINE_BYTES = 64;

/*
FNXC:TerminalScrollback 2026-07-26-14:05:
Absolute floor, independent of the server-ring relationship. Even if someone shrinks a server ring to near zero (which would make the relational assertion trivially satisfiable), a terminal surface with less than this much scrollback is not a usable debugging surface for agent sessions. 2000 is the value the FALSE-premise memory pass landed on; treat it as the hard floor beneath which no optimization may go.
*/
const ABSOLUTE_MIN_CLIENT_SCROLLBACK_LINES = 2000;

function readSource(absolutePath: string): string {
  const source = readFileSync(absolutePath, "utf8");
  expect(
    source.length,
    `terminal-scrollback-floor: ${absolutePath} is empty or unreadable. This guard cannot verify the scrollback invariant; fix the path rather than deleting the test.`,
  ).toBeGreaterThan(0);
  return source;
}

/** Extract a numeric constant, evaluating a simple `A * B` product form. */
function extractNumericConstant(source: string, name: string, absolutePath: string): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)(?:\\s*\\*\\s*([0-9_]+))?`).exec(source);
  expect(
    match,
    `terminal-scrollback-floor: could not find \`${name}\` in ${absolutePath}. It was renamed, moved, or made non-literal. Do NOT delete this guard — re-point it. It is the only thing asserting that the client-side xterm scrollback ring exceeds what the server can replay, and the server replays ONLY at attach time.`,
  ).not.toBeNull();
  const parsed = Number(match![1].replace(/_/g, "")) * (match![2] ? Number(match![2].replace(/_/g, "")) : 1);
  expect(
    Number.isFinite(parsed) && parsed > 0,
    `terminal-scrollback-floor: parsed a non-positive value for \`${name}\` in ${absolutePath}.`,
  ).toBe(true);
  return parsed;
}

const SURFACES = [
  {
    label: "TerminalModal (project PTY terminal)",
    clientFile: resolve(DASHBOARD_ROOT, "app/components/TerminalModal.tsx"),
    clientConstant: "TERMINAL_SCROLLBACK_LINES",
    serverFile: resolve(DASHBOARD_ROOT, "src/terminal-service.ts"),
    serverConstant: "MAX_SCROLLBACK_SIZE",
    serverUnit: "characters",
  },
  {
    label: "SessionTerminal (CLI-agent session terminal)",
    clientFile: resolve(DASHBOARD_ROOT, "app/components/SessionTerminal.tsx"),
    clientConstant: "TERMINAL_SCROLLBACK_LINES",
    serverFile: resolve(REPO_PACKAGES, "engine/src/cli-agent/session-manager.ts"),
    serverConstant: "DEFAULT_SCROLLBACK_BYTES",
    serverUnit: "bytes",
  },
] as const;

describe("terminal scrollback floor", () => {
  for (const surface of SURFACES) {
    describe(surface.label, () => {
      const clientLines = extractNumericConstant(
        readSource(surface.clientFile),
        surface.clientConstant,
        surface.clientFile,
      );
      const serverCapacity = extractNumericConstant(
        readSource(surface.serverFile),
        surface.serverConstant,
        surface.serverFile,
      );
      const serverReplayableLines = Math.floor(serverCapacity / TYPICAL_LINE_BYTES);

      it("keeps a client ring larger than the server can ever replay", () => {
        expect(
          clientLines,
          [
            `SCROLLBACK REGRESSION — ${surface.label}.`,
            `${surface.clientConstant} is ${clientLines} lines, but the server ring (${surface.serverConstant} = ${serverCapacity} ${surface.serverUnit} in ${surface.serverFile}) can replay about ${serverReplayableLines} lines at ~${TYPICAL_LINE_BYTES} ${surface.serverUnit}/line.`,
            "The client ring MUST exceed that, because the server replays its scrollback ONLY AT ATTACH TIME — while a session stays attached, the client ring is the only history that exists, and every line it evicts is permanently unreachable to the user.",
            "If you are lowering this to reduce mobile memory pressure: that trade was already made once on the false premise that the server backs up the client. It does not. Lower the SERVER-side cap first, or find memory elsewhere.",
          ].join(" "),
        ).toBeGreaterThan(serverReplayableLines);
      });

      it("stays above the absolute usability floor", () => {
        expect(
          clientLines,
          `SCROLLBACK REGRESSION — ${surface.label}: ${surface.clientConstant} is ${clientLines}, below the hard floor of ${ABSOLUTE_MIN_CLIENT_SCROLLBACK_LINES} lines. This floor holds even if the server ring shrinks; a terminal with less scrollback than this cannot be used to debug an agent session. See the FNXC block at the top of ${surface.clientFile}.`,
        ).toBeGreaterThanOrEqual(ABSOLUTE_MIN_CLIENT_SCROLLBACK_LINES);
      });

      it("actually passes the constant to xterm (the cap is wired, not vestigial)", () => {
        expect(
          readSource(surface.clientFile),
          `terminal-scrollback-floor: ${surface.clientFile} no longer passes \`scrollback: ${surface.clientConstant}\` to the xterm Terminal constructor. The constant would then be dead and the real ring would silently fall back to xterm's 1000-line default.`,
        ).toContain(`scrollback: ${surface.clientConstant}`);
      });
    });
  }
});
