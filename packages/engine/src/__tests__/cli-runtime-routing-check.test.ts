import { describe, expect, it } from "vitest";
import { checkCliRuntimeRouting } from "../../../../scripts/lib/cli-runtime-routing-check.mjs";

const constants = ['export const FOO_PICKER_PROVIDER_ID = "foo-cli" as const;'];
const route = 'if (enabled) configuredProviders.add(FOO_PICKER_PROVIDER_ID);\nconfiguredProviders.add("native");\nfor (const provider of customProviders) configuredProviders.add(customProviderRegistryKey(provider, customProviders));';
const entry = (providerId: string, classification = "runtime-routed", extra = "") => `{ providerId: "${providerId}", classification: "${classification}", autoDerive: "fail-fast", guardNotApplicable: "pinned-pi-fallback", onExplicitHint: "assert-available", fallbackPolicy: "none", missingRuntimeError: buildError ${extra} },`;
const census = (entries = `${entry("foo-cli")}${entry("native", "non-cli")}`) => `export const CLI_PROVIDER_ROUTING_CENSUS = [${entries}];`;
const check = (routeSource = route, censusSource = census(), constantSources = constants) => checkCliRuntimeRouting({ routeSource, censusSource, constantSources });

describe("check-cli-runtime-routing", () => {
  it("accepts a complete static catalog and ignores named dynamic custom providers", () => expect(check()).toEqual([]));
  it("rejects an admitted provider without a census entry", () => expect(check('configuredProviders.add("fake-cli");', census(entry("native", "non-cli")), [])).toContainEqual(expect.stringContaining("fake-cli has no")));
  it("rejects stale non-withheld entries but permits deliberate withheld entries", () => {
    expect(check('configuredProviders.add("native");', census(`${entry("native", "non-cli")}${entry("old")}`), [])).toContainEqual(expect.stringContaining("stale census entry old"));
    expect(check('configuredProviders.add("native");', census(`${entry("native", "non-cli")}${entry("old", "withheld-unsupported")}`), [])).toEqual([]);
  });
  it("rejects missing path policies and builder-less fail-fast entries", () => {
    expect(check('configuredProviders.add("native");', census('{ providerId: "native", classification: "non-cli", autoDerive: "fail-fast" },'), [])).toEqual(expect.arrayContaining([expect.stringContaining("missing guardNotApplicable"), expect.stringContaining("neither an error builder")]));
  });
  it("rejects unresolved constants, unknown expressions, and empty call sites", () => {
    expect(check('configuredProviders.add(MISSING_PICKER_PROVIDER_ID);', census(), [])).toContainEqual(expect.stringContaining("could not resolve"));
    expect(check('configuredProviders.add(provider);', census(), [])).toContainEqual(expect.stringContaining("unrecognised"));
    expect(check('', census(), [])).toContainEqual(expect.stringContaining("zero"));
  });
});
