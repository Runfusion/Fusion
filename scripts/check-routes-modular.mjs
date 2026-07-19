#!/usr/bin/env node
/*
FNXC:RouteModularity 2026-07-19-12:00:
New dashboard endpoints live in packages/dashboard/src/routes registrars and
createApiRoutes is an orchestrator. Grandfathered inline registrations may shrink
but must not grow; registrar mount order is separately enforced at runtime by the
mount-sequence seam and its contract tests.
*/
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const ROUTES_PATH = fileURLToPath(new URL("../packages/dashboard/src/routes.ts", import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL("./lib/routes-modular-baseline.json", import.meta.url));
const ROUTE_REGISTRATION = /\brouter\.(?:get|post|put|delete|patch|use|all)\s*\(/g;

/** Replace comments and string literals without counting illustrative route calls. */
export function stripCommentsAndStrings(source) {
  let result = "";
  let index = 0;
  let state = "code";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line-comment"; result += "  "; index += 2; continue; }
      if (char === "/" && next === "*") { state = "block-comment"; result += "  "; index += 2; continue; }
      if (char === "'" || char === '"' || char === "`") { state = char; result += " "; index += 1; continue; }
      result += char; index += 1; continue;
    }
    if (state === "line-comment") { if (char === "\n") { state = "code"; result += "\n"; } else result += " "; index += 1; continue; }
    if (state === "block-comment") { if (char === "*" && next === "/") { state = "code"; result += "  "; index += 2; } else { result += char === "\n" ? "\n" : " "; index += 1; } continue; }
    if (char === "\\") { result += "  "; index += 2; continue; }
    if (char === state) state = "code";
    result += " "; index += 1;
  }
  return result;
}

export function countInlineRouteRegistrations(source) {
  return (stripCommentsAndStrings(source).match(ROUTE_REGISTRATION) ?? []).length;
}

export function evaluate(count, baseline) {
  return { count, baseline, passes: count <= baseline.inlineRouteRegistrations };
}

export function formatFailureMessage({ count, baseline }) {
  return `[check-routes-modular] routes.ts has ${count} inline router registrations, above its pinned baseline of ${baseline.inlineRouteRegistrations}. Add new endpoints under packages/dashboard/src/routes/ registrars, not inline in routes.ts. Extract existing handlers to lower the ratchet; only use --update to record that decrease.`;
}

export function main(argv = process.argv.slice(2), { routesPath = ROUTES_PATH, baselinePath = BASELINE_PATH } = {}) {
  const count = countInlineRouteRegistrations(readFileSync(routesPath, "utf8"));
  if (argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify({ inlineRouteRegistrations: count }, null, 2)}\n`);
    console.error(`[check-routes-modular] baseline rewritten at ${count} inline route registrations.`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = evaluate(count, baseline);
  if (result.passes) return 0;
  console.error(formatFailureMessage(result));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
