import { describe, expect, it } from "vitest";
import { buildOperatorLanguageDirective } from "../config/operator-language.js";

/*
FNXC:OperatorLanguage 2026-09-15-07:18:
The directive is the single mechanism that makes autonomously generated operator text (heartbeat
mailbox reports, task logs, chat replies) arrive in the operator's language. These tests pin the
two properties every consuming lane depends on: a concrete code produces the named directive, and
auto/unset produce NOTHING — the pre-feature prompts must stay byte-identical for operators who
never opened the setting.
*/
describe("buildOperatorLanguageDirective", () => {
  it("emits a named-language directive for a concrete code", () => {
    const directive = buildOperatorLanguageDirective({ operatorLanguage: "sk" });
    expect(directive).toBeDefined();
    expect(directive).toContain("## Operator Language");
    expect(directive).toContain("Slovak (slovenčina)");
    // Prose-only translation: the keep-verbatim clause is part of the contract.
    expect(directive).toContain("verbatim");
  });

  it("is case-insensitive on the language code", () => {
    expect(buildOperatorLanguageDirective({ operatorLanguage: "SK" }))
      .toBe(buildOperatorLanguageDirective({ operatorLanguage: "sk" }));
  });

  it.each([undefined, null, {}, { operatorLanguage: "" }, { operatorLanguage: "   " }, { operatorLanguage: "auto" }])(
    "injects nothing for auto/unset shapes (%j)",
    (settings) => {
      expect(buildOperatorLanguageDirective(settings as { operatorLanguage?: string })).toBeUndefined();
    },
  );

  it("passes unknown codes through verbatim so unlisted languages still work", () => {
    const directive = buildOperatorLanguageDirective({ operatorLanguage: "日本語" });
    expect(directive).toContain("**日本語**");
  });
});
