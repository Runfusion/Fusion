#!/usr/bin/env node
/*
FNXC:PluginInteropDrift 2026-07-31-07:10:
A PLUGIN'S `dashboard-interop.d.ts` IS A HAND-MAINTAINED COPY OF ANOTHER PACKAGE'S API, and nothing
tied the two together until this check.

Six plugins declare `@fusion/dashboard/...` modules locally and wire them in through tsconfig
`paths`, because the dashboard package ships no consumable types. Those declarations are written by
hand and never verified, so the real function can change and the mirror keeps compiling — against a
signature that no longer exists.

MOTIVATING DEFECT (#3003 / #3028): `isTaskStuck` grew a fourth `columnFlags` parameter during the
lane conversion. `fusion-plugin-dependency-graph`'s mirror kept the three-argument shape, so the
plugin could not pass the argument even deliberately — the compiler said it did not exist. The
graph's stuck indicator answered for the legacy vocabulary on every renamed board, through an entire
conversion programme, and the reason looked like a build-plumbing problem from outside. Measured at
the time: one of five mirrored functions had drifted.

SCOPE, deliberately narrow: PARAMETER COUNT of exported functions. Arity is unambiguous and a
mismatch is always a defect, whereas comparing full types across two files needs a real program and
would produce arguments about structural equivalence — the kind of noise that gets a check ignored.
A mirror the real module does not export at all is also reported: that is a rename nobody propagated.
*/

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PREFIX = "@fusion/dashboard/";

/** `@fusion/dashboard/app/utils/taskStuck` -> `packages/dashboard/app/utils/taskStuck.ts(x)` */
function resolveRealFile(moduleName) {
  const rel = moduleName.slice(MODULE_PREFIX.length);
  for (const ext of [".ts", ".tsx"]) {
    const candidate = join(REPO, "packages/dashboard", rel + ext);
    try { readFileSync(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

const paramCounts = (node) => ({
  total: node.parameters.length,
  required: node.parameters.filter((p) => !p.questionToken && !p.initializer && !p.dotDotDotToken).length,
});

/*
FNXC:PluginInteropDrift 2026-07-31-07:25:
A NON-FUNCTION EXPORT IS NOT A MISSING ONE — the first version reported `TaskCard` as renamed.

`export const TaskCard = memo(TaskCardComponent, ...)` is a value whose parameter list belongs to a
wrapped component, not to the export. Arity is not comparable there, so those are recorded as PRESENT
but not compared. Reporting them would have been a false positive on the very first run, and a check
whose debut finding is wrong does not get a second reading.
*/
export function declaredInterfacesForTest(sourceText, fileName) {
  return declaredInterfaces(sourceText, fileName, ts.ScriptKind.TSX);
}

export function exportedFunctions(sourceText, fileName) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  const isExported = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      found.set(node.name.text, paramCounts(node));
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          found.set(decl.name.text, paramCounts(init));
        } else {
          /* Present, but its arity is not the export's — see the note above. */
          found.set(decl.name.text, null);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Declared functions per `declare module "@fusion/dashboard/..."` block. */
function mirroredFunctions(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith(MODULE_PREFIX)) {
      const moduleName = node.name.text;
      const walk = (n) => {
        if (ts.isFunctionDeclaration(n) && n.name) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          out.push({ moduleName, name: n.name.text, line, ...paramCounts(n) });
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/*
FNXC:PluginInteropDrift 2026-07-31-08:10:
INTERFACES ARE CHECKED ONE DIRECTION ONLY: a mirror may declare FEWER properties, never unknown ones.

A subset is the normal and correct state — a plugin mirrors the handful of context fields it uses,
and all six do exactly that (6, 8, 7, 7, 3, 6 properties against the real nine). Demanding equality
would fail every plugin for the crime of not using everything.

A property the real type does NOT have is the drift that matters: a rename nobody propagated, or a
typo. The plugin keeps compiling and reads a field the host never sends, which is the same silent
failure the function-arity case produced — code that looks wired and receives nothing.

Measured when added: zero across all six mirrors. The rule is here because these files provably
drift, not because they currently do.
*/
function declaredInterfaces(sourceText, fileName, kind) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const out = new Map();
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      const props = new Map();
      for (const member of node.members) {
        if (member.name && ts.isIdentifier(member.name)) {
          props.set(member.name.text, sf.getLineAndCharacterOfPosition(member.getStart()).line + 1);
        }
      }
      out.set(node.name.text, props);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Interfaces a `declare module` block mirrors, keyed by module then interface name. */
function mirroredInterfaces(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith(MODULE_PREFIX)) {
      const moduleName = node.name.text;
      const walk = (n) => {
        if (ts.isInterfaceDeclaration(n)) {
          const props = new Map();
          for (const member of n.members) {
            if (member.name && ts.isIdentifier(member.name)) {
              props.set(member.name.text, sf.getLineAndCharacterOfPosition(member.getStart()).line + 1);
            }
          }
          out.push({ moduleName, name: n.name.text, props });
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const mirrors = globSync("plugins/*/src/dashboard-interop.d.ts", { cwd: REPO }).sort();
const problems = [];
let compared = 0;
let comparedInterfaces = 0;

for (const rel of mirrors) {
  const file = join(REPO, rel);
  for (const decl of mirroredFunctions(file)) {
    const realFile = resolveRealFile(decl.moduleName);
    if (!realFile) {
      problems.push(`${rel}:${decl.line}  mirrors ${decl.moduleName}, which resolves to no file in packages/dashboard`);
      continue;
    }
    const exports = exportedFunctions(readFileSync(realFile, "utf8"), realFile);
    if (!exports.has(decl.name)) {
      problems.push(`${rel}:${decl.line}  declares ${decl.name}(), which ${decl.moduleName} does not export`);
      continue;
    }
    const real = exports.get(decl.name);
    if (real === null) continue;  /* exported, but not as a plain function — arity not comparable */
    compared += 1;
    if (real.total !== decl.total || real.required !== decl.required) {
      problems.push(
        `${rel}:${decl.line}  ${decl.name}() declares ${decl.total} param(s) (${decl.required} required); `
        + `the real one takes ${real.total} (${real.required} required)`,
      );
    }
  }

  for (const decl of mirroredInterfaces(file)) {
    const realFile = resolveRealFile(decl.moduleName);
    if (!realFile) continue;  /* already reported by the function pass */
    const real = declaredInterfaces(readFileSync(realFile, "utf8"), realFile, ts.ScriptKind.TSX).get(decl.name);
    if (!real) continue;      /* the mirror may name a local shape the module does not export */
    comparedInterfaces += 1;
    for (const [prop, line] of decl.props) {
      if (!real.has(prop)) {
        problems.push(`${rel}:${line}  ${decl.name}.${prop} is not a property of the real ${decl.name}`);
      }
    }
  }
}

/*
ANTI-VACUITY: a resolver change or a rename could leave this walking nothing and reporting success
forever, which is the failure mode a ratchet must not have.
*/
if (mirrors.length === 0 || compared === 0 || comparedInterfaces === 0) {
  console.error(`[check-plugin-interop-drift] scanned ${mirrors.length} mirror(s), compared ${compared} function(s) and ${comparedInterfaces} interface(s) — refusing to report success on an empty comparison.`);
  process.exit(1);
}

if (problems.length > 0) {
  console.error(`\n[check-plugin-interop-drift] plugin interop declarations disagree with the real dashboard API:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nThese files are hand-maintained copies wired in via tsconfig \`paths\`; nothing else checks them.`);
  console.error(`Update the declaration to match the real signature — a stale one silently blocks callers`);
  console.error(`from passing arguments that exist (#3003).\n`);
  process.exit(1);
}

console.log(`[check-plugin-interop-drift] ${compared} mirrored function(s) and ${comparedInterfaces} interface(s) across ${mirrors.length} plugin(s) match the real dashboard API.`);
