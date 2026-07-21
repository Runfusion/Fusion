import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanFileContent } from "../check-no-node-only-core-imports-in-dashboard.mjs";

const file = "packages/dashboard/app/components/Fixture.tsx";
const allowlist = [
  "types",
  "near-duplicate-canonical",
  "task-merge",
  "model-pricing",
  "mobile-nav-primary-items",
  "active-merge-status",
  "workflow-settings-resolver",
  "settings-schema",
  "session-advisor",
  "blocker-fanout",
  "detect-content-language",
];

function violations(content) {
  return scanFileContent(content, file, { allowlist });
}

describe("check-no-node-only-core-imports-in-dashboard", () => {
  it("flags the near-duplicate browser-bundle regression and store imports", () => {
    const nearDuplicate = 'import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate";';
    const store = 'import { TaskStore } from "../../../core/src/store";';

    assert.equal(violations(nearDuplicate).length, 1);
    assert.equal(violations(store).length, 1);
  });

  it("allows whole-statement and inline type-only imports", () => {
    const wholeStatement = 'import type { Foo } from "../../../core/src/near-duplicate";';
    const inlineSpecifier = 'import { type Foo } from "../../../core/src/near-duplicate";';

    assert.deepEqual(violations(wholeStatement), []);
    assert.deepEqual(violations(inlineSpecifier), []);
  });

  it("flags a mixed value and type import", () => {
    const source = 'import { type Foo, bar } from "../../../core/src/near-duplicate";';

    assert.equal(violations(source).length, 1);
  });

  it("flags dynamic template imports, including Vite-ignore imports", () => {
    const direct = 'await import(`../../../core/src/store`);';
    const viteIgnored = 'await import(/* @vite-ignore */ `../../../core/src/store`);';

    assert.equal(violations(direct).length, 1);
    assert.equal(violations(viteIgnored).length, 1);
  });

  it("distinguishes type re-exports from value re-exports", () => {
    const typeExport = 'export type { Foo } from "../../../core/src/near-duplicate";';
    const valueExport = 'export { bar } from "../../../core/src/near-duplicate";';

    assert.deepEqual(violations(typeExport), []);
    assert.equal(violations(valueExport).length, 1);
  });

  it("allows reviewed relative and package-subpath leaves", () => {
    const relativeLeaf = 'import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";';
    const packageLeaf = 'import { detectContentLanguage } from "@fusion/core/detect-content-language";';

    assert.deepEqual(violations(relativeLeaf), []);
    assert.deepEqual(violations(packageLeaf), []);
  });

  it("ignores comment and string mentions of a forbidden specifier", () => {
    const source = [
      '// import { TaskStore } from "../../../core/src/store";',
      'const example = "import { TaskStore } from \\"../../../core/src/store\\"";',
      'const template = `export { TaskStore } from "../../../core/src/store"`; ',
    ].join("\n");

    assert.deepEqual(violations(source), []);
  });
});
