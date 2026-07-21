import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { countInlineRouteRegistrations, evaluate, formatFailureMessage, main } from "../check-routes-modular.mjs";

describe("check-routes-modular", () => {
  it("ignores comments and strings while counting executable inline registrations", () => {
    assert.equal(countInlineRouteRegistrations('// router.get("/example", handler)\nconst x = "router.post(";\nrouter.get("/live", handler);'), 1);
  });
  it("passes at or below baseline and fails above it", () => {
    assert.equal(evaluate(4, { inlineRouteRegistrations: 4 }).passes, true);
    const failure = evaluate(5, { inlineRouteRegistrations: 4 });
    assert.equal(failure.passes, false);
    assert.match(formatFailureMessage(failure), /packages\/dashboard\/src\/routes\/ registrars/);
    assert.equal(evaluate(3, { inlineRouteRegistrations: 4 }).passes, true);
  });
  it("rewrites the baseline with --update", () => {
    const directory = mkdtempSync(join(tmpdir(), "routes-modular-"));
    const routesPath = join(directory, "routes.ts");
    const baselinePath = join(directory, "baseline.json");
    writeFileSync(routesPath, 'router.get("/one", handler);\nrouter.post("/two", handler);\n');
    writeFileSync(baselinePath, '{"inlineRouteRegistrations": 99}\n');
    assert.equal(main(["--update"], { routesPath, baselinePath }), 0);
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { inlineRouteRegistrations: 2 });
  });
});
