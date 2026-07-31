import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40:
A RESOLVED-FLAGS SEAM WITH NO SUPPLIER IS INERT — and nothing else in the repo can see it.

Review caught this TWICE in one session, in my own work, the same way both times:

  worktreeGrouping.ts  gained a `dependencyColumnFlags` parameter; `Column.tsx`, its only board
                       caller, kept passing four arguments. Always `undefined`.
  PrPanel.tsx          declared `taskColumnFlags` and its inner `PrCard` destructured it, but the
                       OUTER exported component destructured only `taskColumn`. Accepted, typed,
                       dropped on the floor.

Both compiled. Both passed every test. Both LOWERED the lifecycle-column census, because the guard
they replaced was genuinely gone — the census counts comparisons, and there is no comparison left to
count. So the instrument that is supposed to measure this work reports the inert version as a win.

WHY THE OBVIOUS CHECKS MISS IT. `tsc` is satisfied: the parameter is optional, so omitting it is
legal. A grep for the symbol finds it in exactly the places the author added it and says nothing
about whether a value flows. Tests pass because the fallback IS the old behaviour — that is the whole
point of the fallback.

WHAT THIS ASSERTS. For every `<Name>Props` interface declaring a prop matching /[Cc]olumnFlags$/,
the function `<Name>` must DESTRUCTURE that prop. That is the precise shape of the PrPanel defect:
declared, passed by the parent, and silently dropped because the component never took it out of its
props.

MY FIRST VERSION OF THIS GUARD COULD NOT FIRE, which is worth recording since it is the same class
again. It checked whether the prop NAME appeared as a JSX attribute anywhere in the app — but
TaskDetailModal *does* render `<PrPanel taskColumnFlags={...} />`, so the name was present and the
check passed while the value was still being dropped one level down. Reproducing the defect against
it produced a green run. A name-level check cannot see a component-level drop.

This does NOT prove the value is correct or that it reaches its use, only that the component accepts
what its callers send — the cheap half, and the half that was silently wrong.
*/

const APP_ROOT = resolve(__dirname, "..");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry === "__mocks__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full)) yield full;
  }
}

const FLAGS_PROP = /[Cc]olumnFlags$/;

interface Orphan { file: string; component: string; prop: string }

/** `<Name>Props` declaring a flags prop, where function `<Name>` does not destructure it. */
function findDroppedProps(): Orphan[] {
  const out: Orphan[] = [];

  for (const file of walk(APP_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!/[Cc]olumnFlags/.test(source)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const declaredByComponent = new Map<string, string[]>();
    const destructuredByComponent = new Map<string, Set<string>>();

    const visit = (node: ts.Node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text.endsWith("Props")) {
        const component = node.name.text.slice(0, -"Props".length);
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || !member.name) continue;
          const name = member.name.getText(sf);
          if (!FLAGS_PROP.test(name)) continue;
          declaredByComponent.set(component, [...(declaredByComponent.get(component) ?? []), name]);
        }
      }

      const fnName = ts.isFunctionDeclaration(node) && node.name ? node.name.text : undefined;
      if (fnName && node.parameters.length > 0) {
        const first = node.parameters[0];
        const taken = new Set<string>();
        if (first && ts.isObjectBindingPattern(first.name)) {
          for (const element of first.name.elements) {
            const source = element.propertyName ?? element.name;
            if (ts.isIdentifier(source)) taken.add(source.text);
          }
        } else if (first && ts.isIdentifier(first.name)) {
          /* `function X(props: XProps)` reaches props by member access; not a drop. */
          taken.add("__whole_props_object__");
        }
        destructuredByComponent.set(fnName, taken);
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const [component, props] of declaredByComponent) {
      const taken = destructuredByComponent.get(component);
      if (!taken) continue;                                   // no matching function in this file
      if (taken.has("__whole_props_object__")) continue;       // props accessed wholesale
      for (const prop of props) {
        if (!taken.has(prop)) out.push({ file: relative(APP_ROOT, file), component, prop });
      }
    }
  }
  return out;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:55 (THE ARITY HALF LIVED HERE AND WAS DELETED):

This file used to also check the SECOND shape — an exported function whose trailing flags parameter
no caller supplies, the `worktreeGrouping` defect. `scripts/check-inert-flag-seams.mjs` now does that
repo-wide, in the merge gate, and does it correctly; the copy here had three holes the script has
since closed, so keeping both meant the weaker one could pass and be believed.

MEASURED, on the same reintroduced defect (dropping the flags argument at `Column.tsx`'s supplied
`isNearDuplicateCanonicalInactive` call): the script reports
`supplied by 5/6 call sites; omitted at .../Column.tsx:1 (of 2)`; this file's version reported
3 passed. Its holes were (1) the `/[Cc]olumnFlags/` prefilter gated CALL-SITE collection, and a
caller that omits the argument mentions no flag name — so it skipped exactly the files containing
the omissions it existed to find; (2) it took the MAX arg count across callers, so one correct call
site cleared a seam every sibling under-supplied; (3) it matched callees by name with no shadow or
import resolution, conflating same-named functions in different modules.

Two guards answering one question, one of them strictly worse, is not redundancy — it is a green
result available to anyone who runs the weaker one. The props-shape check below has no twin in the
script and stays.
*/

describe("resolved column-flag props are not dropped by the component that declares them", () => {
  /* Completeness: vacuous if the scan finds no flags props at all. */
  it("finds components declaring flags props", () => {
    let found = 0;
    for (const file of walk(APP_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (/interface \w+Props/.test(source) && /[Cc]olumnFlags\??:/.test(source)) found += 1;
    }
    expect(found).toBeGreaterThan(3);
  });

  it("every declared *ColumnFlags prop is destructured by its component", () => {
    const dropped = findDroppedProps()
      .map((entry) => `${entry.file}: ${entry.component} declares ${entry.prop} but never takes it`)
      .sort();

    expect(
      dropped,
      "a flags prop the component never destructures is dropped on the floor: callers pass it, tsc "
        + "is satisfied, the census counts the conversion, and the behaviour is the legacy fallback "
        + "forever. Destructure and use it, or delete the prop and leave the literal counted.",
    ).toEqual([]);
  });
});
