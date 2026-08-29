/*
FNXC:Changelog 2026-07-23-10:40:
Beta releases must show notes for ONLY the changesets new in that beta, not the whole pre cycle.
Changesets pre-mode preserves every consumed .md file on disk (recording consumed names in pre.json's `changesets` array), so a naive read of `.changeset/*.md` re-aggregates the entire cycle into every beta's distilled notes and GitHub prerelease body — v0.73.0-beta.4 shipped the full 0.72.0→0.73.0 aggregate instead of its own handful of fixes.
This module scopes the note-feeding changeset set per channel:
- beta: exclude names already recorded in pre.json (already released in a prior beta of this cycle);
- stable: keep the FULL set — the stable release's notes are intentionally a rollup of every change across all betas in the cycle.
Pure and side-effect free so it is unit-testable outside the release script.
*/

/**
 * Strip the `.md` extension from a changeset filename to get the changeset
 * name as recorded in pre.json's `changesets` array.
 */
export function changesetNameFromFile(file) {
  return file.replace(/\.md$/, "");
}

/**
 * Select which pending changesets feed release notes for the given channel.
 *
 * @param {"beta"|"stable"} channel
 * @param {Array<{file: string}>} summaries - entries from readChangesetSummaries();
 *   only `.file` is inspected, extra fields pass through untouched.
 * @param {string[]} preReleasedNames - pre.json `changesets` array (names of
 *   changesets consumed by prior betas in this pre cycle). Pass [] when there
 *   is no pre.json (first beta of a cycle) or on the stable channel.
 * @returns {{ selected: Array, alreadyReleased: Array }}
 */
export function selectChannelChangesets(channel, summaries, preReleasedNames) {
  if (channel !== "beta") {
    // FNXC:Changelog 2026-07-23-10:40:
    // Stable = full-cycle rollup. Every preserved changeset from every beta
    // (plus any landed after the last beta) is included so the stable
    // changelog and GitHub Release aggregate the whole cycle.
    return { selected: summaries, alreadyReleased: [] };
  }
  const released = new Set(preReleasedNames);
  const selected = [];
  const alreadyReleased = [];
  for (const summary of summaries) {
    if (released.has(changesetNameFromFile(summary.file))) {
      alreadyReleased.push(summary);
    } else {
      selected.push(summary);
    }
  }
  return { selected, alreadyReleased };
}
