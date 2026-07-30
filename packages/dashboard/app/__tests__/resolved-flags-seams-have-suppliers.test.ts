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
FNXC:WorkflowResolvedColumns 2026-07-30-22:20:
THE SECOND SHAPE: a plain FUNCTION whose trailing flags parameter no caller supplies.

That is the `worktreeGrouping` defect, and the props check above cannot see it — there is no
interface and no JSX. It is also the shape the core and engine batches will hit most, since utils and
hooks take parameters rather than props.

Detection is by ARITY: find exported functions whose last parameter matches the flags pattern, then
require at least one call somewhere in the app to pass that many arguments. An optional trailing
parameter that every caller omits is exactly the inert seam.
*/
function findUnsuppliedTrailingFlagParams(): string[] {
  const declared = new Map<string, { file: string; index: number }>();
  const maxArgsByCallee = new Map<string, number>();

  for (const file of walk(APP_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!/[Cc]olumnFlags/.test(source)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length > 0) {
        const last = node.parameters[node.parameters.length - 1];
        const name = last.name.getText(sf);
        /* Only object-destructured components have Props interfaces; this targets plain params. */
        if (FLAGS_PROP.test(name) && ts.isIdentifier(last.name)) {
          declared.set(node.name.text, { file: relative(APP_ROOT, file), index: node.parameters.length });
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        if (callee) {
          maxArgsByCallee.set(callee, Math.max(maxArgsByCallee.get(callee) ?? 0, node.arguments.length));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const out: string[] = [];
  for (const [fn, { file, index }] of declared) {
    const best = maxArgsByCallee.get(fn) ?? 0;
    if (best < index) out.push(`${file}: ${fn}() takes a trailing flags param no caller supplies (best call passes ${best} of ${index})`);
  }
  return out.sort();
}

describe("resolved column-flag FUNCTION params have a supplier", () => {
  it("every trailing *ColumnFlags parameter is supplied by at least one caller", () => {
    expect(
      findUnsuppliedTrailingFlagParams(),
      "an optional trailing flags parameter that every caller omits is inert: the literal it "
        + "replaced is gone, the census counts the conversion, and the behaviour is the fallback "
        + "forever. This is the `worktreeGrouping` shape, and the one utils and hooks hit.",
    ).toEqual([]);
  });
});

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
