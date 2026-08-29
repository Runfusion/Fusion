// @vitest-environment node

/*
FNXC:LaneModelResolution 2026-07-24-17:40:
Ratchet for the "silent runtime default model" bug class.

`createFnAgent` / `createResolvedAgentSession` forward NO model to the runtime unless BOTH
`defaultProvider` and `defaultModelId` are present (`resolveConfiguredModel` in pi.ts returns
undefined for a half-set pair, and `createSessionWithModel` spreads `model` only when truthy).
pi-coding-agent then selects its OWN built-in default — `anthropic/claude-opus-4-8` — so a
call site that passes no pair silently leaves the operator's configured provider and issues a
direct Anthropic call. Symptoms: `401 invalid x-api-key` for custom-provider, subscription, and
CLI-runtime operators on a model they never selected, plus a hole in `testMode` forcing.

This scans dashboard source for session-construction call sites and requires each to make a
model decision visible — either passing a pair, spreading one in, or appearing on the
allowlist below with a reason. It scans the dashboard package, where every instance of this
class was found; the engine task lanes (executor, reviewer, merger, triage, heartbeat) all
resolve through `resolve*SettingsModel` helpers and were audited clean. It is a source ratchet, not a behavior test: it exists so a new
lane cannot quietly re-introduce the pattern, which is how this bug reached three separate
lanes before anyone noticed.
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(fileURLToPath(new URL("../", import.meta.url)));
const CONSTRUCTORS = ["createFnAgent(", "createResolvedAgentSession("];

/**
 * Call sites that deliberately pass no model pair. Each entry needs a reason; an entry whose
 * file no longer contains a bare call site is reported as stale so the list cannot rot.
 */
const ALLOWLIST: Record<string, string> = {};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Slice from a call's opening paren to its matching close, so nested objects stay inside. */
function callArgumentText(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return source.slice(openParenIndex);
}

interface BareCallSite {
  file: string;
  line: number;
}

function findBareCallSites(): BareCallSite[] {
  const bare: BareCallSite[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf-8");
    for (const constructor of CONSTRUCTORS) {
      let index = source.indexOf(constructor);
      while (index !== -1) {
        const openParen = index + constructor.length - 1;
        const args = callArgumentText(source, openParen);
        /*
        A site is satisfied when the model decision is visible at the call:
        - an explicit `defaultProvider` key (including the conditional-assignment shape where
          it is set on a prepared options object in the same file);
        - `...laneModelOptions(model)`, the shared helper;
        - any spread, which hands a prepared options object through — the pair is then the
          responsibility of whoever built it (chat.ts's `sessionOptions`, for example);
        - a non-literal argument (`createFnAgent(agentOptions)`), which cannot be checked
          statically from the call site alone.
        This is deliberately permissive about HOW the pair arrives and strict only about the
        shape this bug class actually took: an inline object literal with no model at all.
        */
        const isInlineLiteral = args.replace(/\s/g, "").startsWith("({");
        const declaresModel = !isInlineLiteral
          || args.includes("defaultProvider")
          || args.includes("laneModelOptions(")
          || args.includes("...");
        if (!declaresModel) {
          bare.push({
            file: file.slice(SRC_DIR.length),
            line: source.slice(0, index).split("\n").length,
          });
        }
        index = source.indexOf(constructor, index + constructor.length);
      }
    }
  }
  return bare;
}

describe("AI session construction always makes a model decision", () => {
  it("has no unallowlisted call site that omits the provider/model pair", () => {
    const offenders = findBareCallSites().filter(
      (site) => !Object.keys(ALLOWLIST).some((allowed) => site.file.endsWith(allowed)),
    );

    expect(
      offenders.map((site) => `${site.file}:${site.line}`),
      "These sites reach the runtime with no provider/model pair, so pi substitutes its own "
        + "built-in anthropic default and the operator's configured provider is bypassed. "
        + "Resolve a pair (see lane-session-model.ts) or add an allowlist entry with a reason.",
    ).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    const bareFiles = new Set(findBareCallSites().map((site) => site.file));
    const stale = Object.keys(ALLOWLIST).filter(
      (allowed) => ![...bareFiles].some((file) => file.endsWith(allowed)),
    );

    expect(stale, "Allowlisted files no longer have a bare call site — drop them.").toEqual([]);
  });
});
