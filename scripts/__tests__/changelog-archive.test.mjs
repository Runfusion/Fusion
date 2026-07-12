import test from "node:test";
import assert from "node:assert/strict";

import {
  archivePointerLine,
  CHANGELOG_ARCHIVE_CUTOFF,
  CHANGELOG_ARCHIVE_FILE,
  partitionVersionsByCutoff,
} from "../lib/changelog-archive.mjs";

test("partitions versions at the pre-0.50 archive cutoff", () => {
  assert.deepEqual(
    partitionVersionsByCutoff(["0.58.0", "0.50.0", "0.49.0", "0.11.1"]),
    {
      current: ["0.58.0", "0.50.0"],
      archived: ["0.49.0", "0.11.1"],
    },
  );
});

test("keeps the 0.50.0 boundary and newer patch versions current", () => {
  const partitioned = partitionVersionsByCutoff(["0.53.1", "0.50.0", "0.49.0"]);

  assert.deepEqual(partitioned.current, ["0.53.1", "0.50.0"]);
  assert.deepEqual(partitioned.archived, ["0.49.0"]);
});

test("preserves input order and archives non-parseable version keys", () => {
  const partitioned = partitionVersionsByCutoff([
    "0.51.0",
    "legacy notes",
    "0.50.0 (pre-release, unpublished)",
    "0.49.9",
    "0.53.0",
  ]);

  assert.deepEqual(partitioned.current, [
    "0.51.0",
    "0.50.0 (pre-release, unpublished)",
    "0.53.0",
  ]);
  assert.deepEqual(partitioned.archived, ["legacy notes", "0.49.9"]);
});

test("supports a custom cutoff with release.mjs semver-ish parsing", () => {
  assert.deepEqual(partitionVersionsByCutoff(["1.2.0", "1.1.9", "not semver"], "1.2.0"), {
    current: ["1.2.0"],
    archived: ["1.1.9", "not semver"],
  });
});

test("archive pointer references the archive file and cutoff", () => {
  const pointer = archivePointerLine();

  assert.ok(pointer.includes(CHANGELOG_ARCHIVE_FILE));
  assert.ok(pointer.includes(CHANGELOG_ARCHIVE_CUTOFF));
  assert.match(pointer, /\.\/CHANGELOG-archive\.md/);
});
