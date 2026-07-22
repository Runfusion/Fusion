import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRootChangelogLines,
  collectDistilledBodies,
  isDistilledChangelogBody,
  normalizeChangelogLines,
  parseChangelog,
  stripArchivePointerFromBody,
} from "../lib/changelog-sync.mjs";

const distilledBody = `### Highlights
- Cool feature

### New
- Cool feature details

### Fixed
- Bug fix
`;

const rawPackageBody = `### @runfusion/fusion

#### Minor Changes

- abc1234: summary: Cool feature.
  category: feature
`;

test("isDistilledChangelogBody accepts Highlights/category sections", () => {
  assert.equal(isDistilledChangelogBody(distilledBody), true);
  assert.equal(isDistilledChangelogBody("### New\n\n- Only new."), true);
  assert.equal(isDistilledChangelogBody("### Fixed\n\n- Only fix."), true);
});

test("isDistilledChangelogBody rejects raw package aggregates", () => {
  assert.equal(isDistilledChangelogBody(rawPackageBody), false);
  assert.equal(
    isDistilledChangelogBody("### @fusion/core\n\n#### Patch Changes\n\n- dep bump"),
    false,
  );
});

test("isDistilledChangelogBody rejects empty and non-category prose", () => {
  assert.equal(isDistilledChangelogBody(""), false);
  assert.equal(isDistilledChangelogBody("Just some notes without headings."), false);
});

test("stripArchivePointerFromBody removes trailing archive pointer", () => {
  const withPointer = `${distilledBody}\n\n> Older releases (before 0.60.0) are archived in [\`CHANGELOG-archive.md\`](./CHANGELOG-archive.md).`;
  assert.equal(stripArchivePointerFromBody(withPointer), distilledBody.trim());
  assert.equal(isDistilledChangelogBody(withPointer), true);
});

test("parseChangelog splits version sections", () => {
  const raw = `# Fusion changelog

## 1.1.0

### Highlights
- One

## 1.0.0

### @runfusion/fusion

#### Patch Changes

- Two
`;
  const { versions, order } = parseChangelog(raw);
  assert.deepEqual(order, ["1.1.0", "1.0.0"]);
  assert.match(versions.get("1.1.0"), /### Highlights/);
  assert.match(versions.get("1.0.0"), /### @runfusion\/fusion/);
});

test("collectDistilledBodies keeps only distilled sections; first wins", () => {
  const current = `# Fusion changelog

## 1.2.0

${distilledBody}

## 1.1.0

${rawPackageBody}
`;
  const archive = `# Archive

## 1.2.0

### Highlights
- Stale older summary that must not win

## 0.9.0

### Fixed
- Archive-only distilled fix
`;
  const bodies = collectDistilledBodies([current, archive]);
  assert.equal(bodies.get("1.2.0"), distilledBody.trim());
  assert.equal(bodies.has("1.1.0"), false);
  assert.match(bodies.get("0.9.0"), /Archive-only distilled fix/);
});

test("buildRootChangelogLines preserves distilled bodies over package aggregate", () => {
  const parsed = [
    {
      pkgName: "@runfusion/fusion",
      versions: new Map([
        ["1.1.0", "### Minor Changes\n\n- raw entry"],
        ["1.0.0", "### Patch Changes\n\n- old raw"],
      ]),
    },
  ];
  const preservedBodies = new Map([["1.0.0", distilledBody.trim()]]);

  const out = normalizeChangelogLines(
    buildRootChangelogLines({
      title: "# Fusion changelog",
      banner: "banner",
      parsed,
      versionOrder: ["1.1.0", "1.0.0"],
      preservedBodies,
    }),
  );

  // New/raw version still package-aggregated.
  assert.match(out, /## 1\.1\.0\n\n### @runfusion\/fusion/);
  assert.match(out, /raw entry/);
  // Prior distilled version kept summarized form, not package heading.
  assert.match(out, /## 1\.0\.0\n\n### Highlights/);
  assert.match(out, /Cool feature/);
  assert.doesNotMatch(out, /## 1\.0\.0[\s\S]*### @runfusion\/fusion/);
  assert.doesNotMatch(out, /old raw/);
});

test("buildRootChangelogLines falls back to package aggregate without preserve", () => {
  const parsed = [
    {
      pkgName: "@fusion/core",
      versions: new Map([["2.0.0", "### Patch Changes\n\n- only raw"]]),
    },
  ];
  const out = normalizeChangelogLines(
    buildRootChangelogLines({
      title: "# Changelog",
      banner: "b",
      parsed,
      versionOrder: ["2.0.0"],
    }),
  );
  assert.match(out, /### @fusion\/core/);
  assert.match(out, /#### Patch Changes/);
  assert.match(out, /only raw/);
});
