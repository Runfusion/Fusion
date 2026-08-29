/*
FNXC:CliRuntimeRouting 2026-08-15-13:51:
The dashboard owns picker admission and engine deliberately cannot import it.
Parse the explicit `configuredProviders.add(...)` forms instead, so a new
selectable provider cannot become executable only through pi by accident.
Unrecognised syntax is a violation: this guard must fail closed, not quietly
skip a catalog form it no longer understands.
*/

const ADD = /configuredProviders\.add\(([^\n;]+)\)/g;
const STRING = /^\s*["']([^"']+)["']\s*$/;
const PICKER = /^\s*([A-Z][A-Z0-9_]*_PICKER_PROVIDER_ID)\s*$/;
const DYNAMIC = /^\s*customProviderRegistryKey\(/;

function censusEntries(source) {
  const entries = [];
  const object = /\{\s*providerId:\s*["']([^"']+)["']([\s\S]*?)\}/g;
  for (const match of source.matchAll(object)) {
    const body = match[2];
    const value = (name) => new RegExp(`${name}:\\s*["']([^"']+)["']`).exec(body)?.[1];
    entries.push({
      providerId: match[1],
      classification: value("classification"),
      autoDerive: value("autoDerive"),
      guardNotApplicable: value("guardNotApplicable"),
      onExplicitHint: value("onExplicitHint"),
      hasBuilder: /missingRuntimeError\s*:/.test(body),
      externalFailFastOwner: value("externalFailFastOwner"),
    });
  }
  return entries;
}

function constantsFromSources(sources) {
  const constants = new Map();
  for (const source of sources) {
    for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]*_PICKER_PROVIDER_ID)\s*=\s*["']([^"']+)["']\s+as const/g)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/** @param {{routeSource:string,censusSource:string,constantSources?:string[]}} input */
export function checkCliRuntimeRouting(input) {
  const violations = [];
  const constants = constantsFromSources(input.constantSources ?? []);
  const admitted = new Set();
  let calls = 0;
  for (const match of input.routeSource.matchAll(ADD)) {
    calls += 1;
    const expression = match[1].trim();
    const literal = STRING.exec(expression)?.[1];
    if (literal) { admitted.add(literal); continue; }
    const name = PICKER.exec(expression)?.[1];
    if (name) {
      const provider = constants.get(name);
      if (!provider) violations.push(`could not resolve ${name} to a picker provider string literal`);
      else admitted.add(provider);
      continue;
    }
    if (DYNAMIC.test(expression)) continue;
    violations.push(`unrecognised configuredProviders.add expression: ${expression}`);
  }
  if (calls === 0) violations.push("zero configuredProviders.add call sites found");

  const census = censusEntries(input.censusSource);
  if (census.length === 0) violations.push("CLI provider routing census is empty or unparseable");
  const byProvider = new Map(census.map((entry) => [entry.providerId, entry]));
  for (const provider of admitted) {
    if (!byProvider.has(provider)) violations.push(`admitted provider ${provider} has no CLI routing census entry (valid classifications: registry-native, runtime-routed, non-cli, withheld-unsupported)`);
  }
  for (const entry of census) {
    if (!admitted.has(entry.providerId) && entry.classification !== "withheld-unsupported") violations.push(`stale census entry ${entry.providerId} is no longer admitted by the catalog`);
    for (const field of ["autoDerive", "guardNotApplicable", "onExplicitHint"]) {
      if (!entry[field]) violations.push(`census entry ${entry.providerId} is missing ${field} policy`);
    }
    const policies = [entry.autoDerive, entry.guardNotApplicable, entry.onExplicitHint];
    if (policies.includes("fail-fast") && !entry.hasBuilder && !entry.externalFailFastOwner) {
      violations.push(`fail-fast census entry ${entry.providerId} has neither an error builder nor externalFailFastOwner`);
    }
  }
  return violations;
}
