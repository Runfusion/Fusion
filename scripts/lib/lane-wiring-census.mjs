/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:10:
Count CALL SITES that do not pass a resolved-lane argument to a function that accepts one.

WHY THIS EXISTS, and why it is a census rather than a guard.

`unwired-lane-parameter.mjs` catches a parameter that reaches NO caller. It is deliberately satisfied
by a mention anywhere, so PARTIAL wiring — some call sites pass the lane answer, others do not — is
invisible to it. Three defects reached `main` through that gap in one day:

  #2956  getInReviewStallReason wired at 0 of its 4 call sites while its two siblings were wired
  #2963  both merge entry points unwired -> "Cannot merge FN-x: task is in 'signoff', must be in
         'in-review'" — merging was impossible on a board with a renamed review lane
  #2964  merge-confirmed finalization unwired -> ALREADY-LANDED work parked `failed`

Each was a fix that added an optional parameter without the call-site sweep that has to follow it.

NOT A HARD GUARD, on purpose. Auditing the seven sites this finds showed FOUR were legitimately
unwired: `skipColumnIdentityCheck` callers have already proven lane identity by a stronger means, a
sentinel-column caller wants the identity check satisfied by construction, and a dead export has no
caller to wire. A check failing on all of them would be ~57% false positives, and the sibling guard's
header says why that is worse than a miss: it teaches people to disable the check.

So this ratchets like the lifecycle census: a baseline of known-unwired sites that may only shrink. A
NEW unwired call site raises the count and fails; wiring one lowers it and re-records. The recurrence —
adding a caller without the lane answer — is the thing caught.
*/
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Lane-answer argument names, kept in step with unwired-lane-parameter.mjs. */
export const LANE_ARGUMENT_NAMES = new Set([
  "reviewColumns",
  "terminalColumns",
  "completeColumns",
  "activeColumns",
  "escalationColumns",
  "columnFlags",
  "isReviewColumn",
  "isWipColumn",
  "holdColumn",
  /* FNXC:WorkflowLifecycleColumns 2026-07-30-22:00: the MEMBERSHIP form, added with the surfacing
     family's split-role fix — without it the gate cannot see a dropped `holdColumns`. */
  "holdColumns",
  /*
  FNXC:LaneWiring 2026-07-31-00:50:
  The per-TASK trait index, the shape the dashboard threads (`columnFlagsByTaskId`). It is how three
  dashboard surfaces answer every lane question at once, so a call site that drops it goes back to
  the legacy vocabulary wholesale — exactly what this census exists to notice. It was missing, so all
  three of those newly-wired sites still counted as unwired and the gate could not have caught a
  regression at any of them.
  */
  "columnFlagsByTaskId",
]);

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/**
 * Exported functions that ACCEPT a lane argument, as `name -> Set(argument names)`.
 *
 * Exported only: an internal helper's callers are all in one file and visible without a tool.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:30:
NAMED context types are resolved, not just inline literals — without this the census could not see
the defect it was built for.

The first version matched a lane parameter only when `param.type` was a `TypeLiteralNode`. Every
`*Context` interface therefore slipped through, including the motivating case:

  export function getInReviewStallReason(task: …, context: InReviewStallContext = {})

`InReviewStallContext` is a TypeReference, so `getInReviewStallReason` never entered `accepting` and
none of its call sites were examined. MEASURED: removing `reviewColumns` from one of them — i.e.
re-introducing #2956, the first case in this file's own header — left the check reporting
"34 known unwired call site(s), none added."

Five core files declare lane-carrying context interfaces (`in-review-stall`, `in-review-stalled`,
`stale-paused-review`, `stale-paused-todo`, `task-priority`), so the gap was structural rather than
one awkward signature.

Resolved by NAME across the whole corpus rather than through a type-checker `Program`: these are
plain source scans and a checker would cost a full type-resolution pass for one lookup.

FNXC:WorkflowLifecycleColumns 2026-07-30-22:55 (#2974 review — coderabbitai, "resolve named type
references by declaration identity"): THE MERGE IS NOT SAFE IN THE DIRECTION THE OLD NOTE CLAIMED.

That note argued a same-name merge was acceptable because a false member "only widens what counts as
wired". Widening is precisely the unsafe direction HERE: every extra member makes MORE call sites count
as wired, so unwired sites disappear from the census and the ratchet goes green while the seam it
watches is unsupplied. A gate whose errors land on "nothing to report" is the one failure mode a
ratchet must not have — the same reasoning that keeps the sibling SQL gate from pretending it can read
`.sql`.

A type checker is still the wrong price (a full `Program` over ~1950 files for one lookup, against a
~2s scan). Instead the unsound case is made IMPOSSIBLE TO HIT SILENTLY: two files declaring
lane-carrying types under one name is a hard error naming both paths, not a quiet union. Measured at
the time of writing: 2 lane-carrying types, 0 collisions — so this throws for nobody today and
converts a silent wrong answer into a loud one the moment it would matter.
*/
function findLaneCarryingTypes(files) {
  const byName = new Map();
  for (const file of files) {
    const sf = parse(file);
    ts.forEachChild(sf, (node) => {
      const members = ts.isInterfaceDeclaration(node)
        ? node.members
        : (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type) ? node.type.members : null);
      if (!members || !node.name) return;
      const names = new Set();
      for (const member of members) {
        if (member.name && ts.isIdentifier(member.name) && LANE_ARGUMENT_NAMES.has(member.name.text)) {
          names.add(member.name.text);
        }
      }
      if (names.size > 0) {
        const existing = byName.get(node.name.text);
        if (existing && existing.file !== file) {
          throw new Error(
            `[lane-wiring] two files declare a lane-carrying type named "${node.name.text}": `
              + `${existing.file} and ${file}. Resolving by name would merge their lane members and `
              + `silently mark unwired call sites as wired. Rename one, or resolve by declaration.`,
          );
        }
        if (existing) for (const n of names) existing.names.add(n);
        else byName.set(node.name.text, { file, names });
      }
    });
  }
  return byName;
}

export function findLaneAcceptingFunctions(files) {
  const accepting = new Map();
  const laneTypes = findLaneCarryingTypes(files);
  for (const file of files) {
    const sf = parse(file);
    ts.forEachChild(sf, (node) => {
      if (!ts.isFunctionDeclaration(node) || !node.name) return;
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-20:15 (POSITIONAL lane parameters count too):
      The first version only understood the options-bag spelling, so a function taking the lane answer
      POSITIONALLY — `isRecoverable...(task, reviewColumns)`, `isNearDuplicateCanonicalInactive(c, flags)`
      — had every one of its wired call sites reported as unwired. Six of the eight hits in
      `self-healing.ts` alone were that false positive, which would have inflated the baseline with
      sites that are already correct and taught the next reader to distrust the number.

      Both spellings are tracked: option names by name, positional ones by INDEX, so a call is wired if
      it passes an accepted option key OR supplies an argument in the positional slot.
      */
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-23:05 (#2974 review — coderabbitai, "retain the
      options-bag parameter index"): A LANE KEY ONLY COUNTS IN THE ARGUMENT THAT DECLARES IT.

      `names` was a flat set with the parameter index thrown away, and the call-site check then
      accepted a matching property in ANY argument. So a call could put `reviewColumns` on an earlier
      `task` object and pass `{}` as the actual options bag, and the census would score it wired while
      the function received nothing — a FALSE GREEN, the same direction as the type-merge above.

      Keyed by index instead: `namesByIndex[i]` are the keys that count when they appear in argument
      `i`. Measured before changing it: 0 call sites in the tree match on a mismatched index, so this
      is behaviour-preserving today and exists to keep it that way.
      */
      const namesByIndex = new Map();
      const positions = new Set();
      const addName = (index, name) => {
        if (!namesByIndex.has(index)) namesByIndex.set(index, new Set());
        namesByIndex.get(index).add(name);
      };
      node.parameters.forEach((param, index) => {
        if (ts.isIdentifier(param.name) && LANE_ARGUMENT_NAMES.has(param.name.text)) positions.add(index);
        if (param.type && ts.isTypeLiteralNode(param.type)) {
          for (const member of param.type.members) {
            if (member.name && ts.isIdentifier(member.name) && LANE_ARGUMENT_NAMES.has(member.name.text)) {
              addName(index, member.name.text);
            }
          }
        }
        /* `context: InReviewStallContext` — see findLaneCarryingTypes for why this arm exists. */
        if (param.type && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName)) {
          for (const member of laneTypes.get(param.type.typeName.text)?.names ?? []) addName(index, member);
        }
      });
      if (namesByIndex.size > 0 || positions.size > 0) {
        /*
        FNXC:LaneWiring 2026-07-31-01:05:
        MERGE on a name collision; a plain `set` let the last declaration win.

        Two different functions legitimately share a name here — core's `computeBlockerFanoutMap` and
        the dashboard wrapper that calls it — and their lane options sit at DIFFERENT argument
        indices (2 and 1). Overwriting meant core's callers were checked against the wrapper's
        signature, so a call passing `terminalColumns` at index 2 was reported unwired. That is the
        false positive that makes a ratchet's number noise, and the first person to open one of these
        sites learns not to trust it.

        The census keys by name because it has no type resolution, so a collision cannot be told
        apart from an overload — union both, and a call satisfying EITHER shape counts.
        */
        const existing = accepting.get(node.name.text);
        if (existing) {
          existing.files.add(file);
          for (const [index, names] of namesByIndex) {
            if (!existing.namesByIndex.has(index)) existing.namesByIndex.set(index, new Set());
            for (const name of names) existing.namesByIndex.get(index).add(name);
          }
          for (const position of positions) existing.positions.add(position);
        } else {
          accepting.set(node.name.text, { namesByIndex, positions, files: new Set([file]) });
        }
      }
    });
  }
  return accepting;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:20:
`{ … } satisfies SomeContext` IS an options bag — a bare `isObjectLiteralExpression` check says no.

`satisfies` (and `as`, and parentheses) wrap the literal in another node, so the plain check reported
a fully-wired call as unwired. That is not hypothetical: #2956 wired four `getInReviewStalledSignal`
call sites in `reads.ts` and annotated each with `satisfies InReviewStalledContext`, and the census
counted every one of them as missing its lane argument.

The bug predates the named-type arm but was INVISIBLE behind it: functions typed by an interface were
never detected, so their call sites were never inspected and the false positives never surfaced.
Fixing detection exposed six of them at once, which is how this was found.

A census that reports correct code as unwired is worse than one that misses cases — it inflates the
baseline with sites nobody can "fix", and the first person to check one learns the number is noise.
*/
function unwrapObjectLiteral(node) {
  let current = node;
  while (
    ts.isSatisfiesExpression(current)
    || ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isObjectLiteralExpression(current) ? current : null;
}

/*
FNXC:LaneWiring 2026-07-31-00:55:
CONDITIONAL shapes, the third way a wired call site stayed invisible.

Passing lanes only when they resolved is the CORRECT way to write these — an empty trait index means
"not loaded yet", not "nothing is terminal", so the caller must fall through to the documented legacy
default rather than fabricate one. Both idioms it produces were invisible:

    computeBlockerFanoutMap(tasks, flags ? { columnFlagsByTaskId: flags } : {})   // ternary argument
    computeBlockerFanoutMapCore(tasks, N, { ...(flags ? { classify } : {}) })     // conditional spread

The first is a ConditionalExpression, not an object literal. The second is a SpreadAssignment, whose
`p.name` is undefined. So the census scored three call sites I had just wired as unwired — and would
equally have stayed silent had someone deleted the argument.

Answer YES if EITHER branch supplies the lane. A branch that omits it is the deliberate
fall-through-to-legacy path, not an unwired call; a call site that supplies it in neither branch is
still counted.
*/
function objectLiteralsFrom(node) {
  let current = node;
  while (
    ts.isSatisfiesExpression(current)
    || ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isConditionalExpression(current)) {
    return [...objectLiteralsFrom(current.whenTrue), ...objectLiteralsFrom(current.whenFalse)];
  }
  return ts.isObjectLiteralExpression(current) ? [current] : [];
}

/** Does this object literal supply one of `wanted`, looking through conditional spreads? */
function suppliesLane(bag, wanted) {
  return bag.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) {
      return objectLiteralsFrom(p.expression).some((inner) => suppliesLane(inner, wanted));
    }
    return p.name && ts.isIdentifier(p.name) && wanted.has(p.name.text) && suppliesAValue(p);
  });
}

/*
FNXC:LaneWiring 2026-07-30-23:40:
`undefined` IS NOT AN ANSWER, in either position this census checks.

Both arms asked whether the lane argument was PRESENT, not whether it carried anything:

    isThing(task, { reviewColumns: undefined });   // property present -> counted as wired
    isThing(task, undefined);                      // arity satisfied  -> counted as wired

The callee receives exactly what it received before — nothing — so the seam is still inert and the
board still reads the legacy vocabulary. The census just stops saying so, which is the one failure a
ratchet must not have.

Same defect as the positional one fixed in #2981 for check-inert-flag-seams, one level in. The two
gates are complementary by design (this one owns the options-object and default-valued shapes), so
the hole had to be closed in both — neither covered it, confirmed by probing each with a control.

SHORTHAND STILL COUNTS. `{ reviewColumns }` forwards a variable whose value is not knowable here, and
treating it as unwired would flag every correct forwarding wrapper in the tree. Only a literal
`undefined` / `void 0` is provably empty.

TRAILING ONLY for the positional arm: a middle `undefined` still positions the arguments after it.
*/
const isUndefinedExpression = (node) =>
  !!node && ((ts.isIdentifier(node) && node.text === "undefined") || ts.isVoidExpression(node));

/** A property assignment carries a value unless it is spelled `undefined`. Shorthand always does. */
export function suppliesAValue(property) {
  if (!ts.isPropertyAssignment(property)) return true;
  return !isUndefinedExpression(property.initializer);
}

/** Arguments carrying a value, ignoring trailing `undefined` / `void 0` placeholders. */
export function effectiveArgCount(args) {
  let count = args.length;
  while (count > 0 && isUndefinedExpression(args[count - 1])) count -= 1;
  return count;
}

/** Call sites of those functions that pass none of the accepted lane arguments. */
export function findUnwiredCallSites(files, accepting) {
  const unwired = [];
  for (const file of files) {
    const sf = parse(file);
    /*
    FNXC:LaneWiring 2026-07-31-09:25:
    A call means the declaration it can actually SEE.

    The census keys by name because it has no type resolution, and merging same-named declarations
    (added when core's and the dashboard's `computeBlockerFanoutMap` collided) fixed a false NEGATIVE
    at the cost of a false POSITIVE: `ModelSelectorTab` declares its own two-parameter
    `resolveEffectiveExecutor(task, settings)` — a pass-through with nothing lane-related — while an
    UNRELATED exported function of the same name in effective-model-resolution.ts takes `columnFlags`.
    Every call to the local one was reported unwired against a signature it has never had.

    Only EXPORTED declarations enter the accepting map, so the rule is exact: if the calling file
    declares the name itself and the map entry came from a different file, the call resolves to the
    local declaration and is not a lane call here.

    Deliberately NOT done by re-running the detector over the single file: that pass cannot resolve an
    imported options interface, so a locally-declared function with an imported context type would
    quietly stop being lane-accepting — a false negative, which is the one failure a ratchet must not
    have. The global pass still does all type resolution; only the CHOICE of declaration is local.
    */
    const declaredLocally = new Set();
    {
      const collect = (node) => {
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
          declaredLocally.add(node.name.text);
        }
        if (ts.isVariableStatement(node)) {
          for (const d of node.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) declaredLocally.add(d.name.text);
          }
        }
        ts.forEachChild(node, collect);
      };
      ts.forEachChild(sf, collect);
    }
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const entry = accepting.get(node.expression.text);
        const shadowed = entry !== undefined
          && declaredLocally.has(node.expression.text)
          && !entry.files.has(file);
        const accepted = shadowed ? undefined : entry;
        if (accepted) {
          const passesOption = node.arguments.some((arg, index) => {
            const wanted = accepted.namesByIndex.get(index);
            if (wanted === undefined) return false;
            return objectLiteralsFrom(arg).some((bag) => suppliesLane(bag, wanted));
          });
          const passesPositional = [...accepted.positions].some(
            (index) => effectiveArgCount(node.arguments) > index,
          );
          const passes = passesOption || passesPositional;
          if (!passes) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            unwired.push({ file, line: line + 1, fn: node.expression.text });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return unwired;
}
