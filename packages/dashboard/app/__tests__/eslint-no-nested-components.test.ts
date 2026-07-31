import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { noNestedComponentDefinitions } from "../../../../eslint.config.mjs";

/*
FNXC:LintConfig 2026-07-26-21:05:
Guards the `fusion-react/no-nested-component-definitions` rule that keeps components out of other
components' render bodies. The rule exists because that pattern shipped three times (FN-8606's
ModalShell left Planning Mode and Settings untypable; MailboxModal's ReplyContextExpandable collapsed
expanded reply rows), so the rule itself needs coverage — a silently-broken guard is worse than none.
Both halves matter: it must flag real nested components AND leave the sanctioned escapes alone, or
the codebase routes around it.
*/

const linter = new Linter();

function lint(code: string): string[] {
  const config = {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { "fusion-react": { rules: { "no-nested-component-definitions": noNestedComponentDefinitions } } },
    rules: { "fusion-react/no-nested-component-definitions": "error" },
  } as unknown as Linter.Config;
  const messages = linter.verify(code, config, "probe.tsx");
  return messages.map((message) => message.message);
}

describe("fusion-react/no-nested-component-definitions", () => {
  it("flags a PascalCase arrow component declared inside a component", () => {
    const messages = lint(`
      export function Parent() {
        const Badge = ({ label }: { label: string }) => <span>{label}</span>;
        return <div><Badge label="x" /></div>;
      }
    `);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Component "Badge" is defined inside another component');
  });

  it("flags a nested function declaration component", () => {
    const messages = lint(`
      export function Parent() {
        function Row() {
          return <li>row</li>;
        }
        return <ul><Row /></ul>;
      }
    `);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Component "Row" is defined inside another component');
  });

  it("flags memo()/forwardRef()-wrapped nested components", () => {
    const messages = lint(`
      import { memo } from "react";
      export function Parent() {
        const Row = memo(() => <li>row</li>);
        return <ul><Row /></ul>;
      }
    `);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Component "Row" is defined inside another component');
  });

  /*
  The sanctioned fixes. A lowercase render function returns elements without introducing an element
  type, so the subtree reconciles in place — that is exactly the shape PlanningModeModal/SettingsModal
  were moved to (`renderModalShell(children)`), and it must never be reported.
  */
  it("allows lowercase render helpers, inline callbacks, and module-scope components", () => {
    expect(lint(`
      function Badge({ label }: { label: string }) {
        return <span>{label}</span>;
      }
      export function Parent({ items }: { items: string[] }) {
        const renderShell = (children: unknown) => <div className="shell">{children}</div>;
        return (
          <div onClick={() => console.log("noop")}>
            {renderShell(items.map((item) => <Badge key={item} label={item} />))}
          </div>
        );
      }
    `)).toEqual([]);
  });

  it("honors the nested-component-allowlist escape hatch", () => {
    expect(lint(`
      export function Parent() {
        // nested-component-allowlist: deliberate, documented exception
        const Badge = () => <span>x</span>;
        return <div><Badge /></div>;
      }
    `)).toEqual([]);
  });
});
