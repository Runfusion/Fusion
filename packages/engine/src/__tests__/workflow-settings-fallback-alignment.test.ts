import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BUILTIN_WORKFLOW_SETTINGS, DEFAULT_PROJECT_SETTINGS } from "@fusion/core";

/**
 * U3 fallback-alignment guard (KTD-3, plan item 4).
 *
 * Each engine read site of a moved key has a hardcoded `?? <literal>` (or
 * default-true `!== false`) fallback that fires when the effective-settings map
 * carries no value for that key (a custom workflow that does not declare it). That
 * fallback is TODAY's behavior and MUST equal the built-in declaration default —
 * otherwise effective resolution returning "absent" would silently change behavior
 * for an undeclared key. This test pins:
 *
 *   (a) built-in declaration default === legacy DEFAULT_PROJECT_SETTINGS literal
 *       (the parity anchor), and
 *   (b) the literal `?? <n>` fallbacks actually present in engine source equal the
 *       declaration default, scanned from source so a future edit that introduces a
 *       drifting fallback fails here.
 *
 * The audited read-site table (key → literal) is encoded below; the source scan
 * asserts no NEW literal fallback for these keys drifts from the declaration.
 */

const SRC_DIR = join(__dirname, "..");

function readEngineSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const name of readdirSync(SRC_DIR)) {
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".d.ts")) continue;
    out.push({ file: name, text: readFileSync(join(SRC_DIR, name), "utf-8") });
  }
  return out;
}

const declDefault = new Map(BUILTIN_WORKFLOW_SETTINGS.map((s) => [s.id, s.default]));

describe("workflow-settings fallback alignment (KTD-3, item 4)", () => {
  it("(a) the moved-key catalog has left DEFAULT_PROJECT_SETTINGS (U4 hard-move)", () => {
    // Post-U4 hard-move: the moved keys were REMOVED from DEFAULT_PROJECT_SETTINGS
    // (the parity literal is gone — the declaration default is now the single
    // source of truth). The legacy object must no longer carry any catalog key.
    const legacy = DEFAULT_PROJECT_SETTINGS as Record<string, unknown>;
    for (const s of BUILTIN_WORKFLOW_SETTINGS) {
      expect(Object.prototype.hasOwnProperty.call(legacy, s.id)).toBe(false);
    }
  });

  it("(b) every numeric/string `settings.<key> ?? <literal>` fallback in engine source matches the declaration default", () => {
    const sources = readEngineSources();
    const mismatches: string[] = [];

    for (const [id, def] of declDefault) {
      if (def === undefined) continue; // absent-default lanes: no `??` literal to check
      // Match `settings.<id> ?? <literal>` with numeric (incl. 360_000) or quoted-string literals.
      const re = new RegExp(
        String.raw`\.${id}\s*\?\?\s*([0-9][0-9_]*|"[^"]*"|'[^']*'|true|false)`,
        "g",
      );
      for (const { file, text } of sources) {
        if (file.endsWith(".test.ts")) continue;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const raw = m[1];
          let literal: unknown;
          if (/^[0-9][0-9_]*$/.test(raw)) literal = Number(raw.replace(/_/g, ""));
          else if (raw === "true") literal = true;
          else if (raw === "false") literal = false;
          else literal = raw.slice(1, -1); // strip quotes
          if (literal !== def) {
            mismatches.push(`${file}: settings.${id} ?? ${raw} (decl default ${JSON.stringify(def)})`);
          }
        }
      }
    }

    expect(mismatches, `misaligned read-site fallbacks:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("documents the audited read-site fallbacks (key → literal → aligned)", () => {
    // This table is the human-readable record from the U3 fallback audit. The
    // VALUES here are the audited read-site literals; the assertion ties each to
    // the declaration default so the table cannot silently drift.
    const audited: Record<string, unknown> = {
      workflowStepTimeoutMs: 360_000, // executor.ts: ?? 360_000
      workflowStepScopeEnforcement: "block", // executor.ts: ?? "block"
      planOnlyScopeLeakEnforcement: "warn", // executor.ts: ?? "warn"
      workflowRevisionForkOnScopeMismatch: true, // executor.ts: !== false (default-true)
      strictScopeEnforcement: false, // merger.ts: passed truthy/undefined → false
      runStepsInNewSessions: false, // executor.ts: truthy check → false
      maxParallelSteps: 2, // executor.ts / step-session-executor.ts: ?? 2
      buildRetryCount: 0, // merger.ts: ?? 0
      verificationFixRetries: 3, // executor.ts: ?? 3; merger.ts aligned to ?? 3 (was ?? 2, dead)
      maxPostReviewFixes: 3, // self-healing.ts + executor.ts: ?? 3
      requirePrApproval: false, // no engine read; default-false elsewhere
      requirePlanApproval: false, // triage.ts: truthy check → false
      reviewHandoffPolicy: "disabled", // executor.ts: === "comment-triggered" → "disabled"
      maxReviewerContextRetries: 2, // retry-burned-logger.ts: returned directly
      maxReviewerFallbackRetries: 2, // retry-burned-logger.ts: returned directly
      reflectionEnabled: false, // executor.ts: truthy check → false
    };
    for (const [id, lit] of Object.entries(audited)) {
      expect(declDefault.get(id)).toStrictEqual(lit);
    }
  });
});
