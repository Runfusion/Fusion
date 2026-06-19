/**
 * FNXC:ReleaseScript 2026-06-14-23:08:
 * Dry-run releases must be non-interactive by default because FN-6469 showed non-TTY agent shells can hang on unsettled top-level await and exit 13 when the version prompt reads stdin.
 * `--interactive` is the explicit dry-run opt-in for maintainers who intentionally want to exercise the version prompt; real releases keep prompting unless `--yes` is passed.
 *
 * @param {{ dryRun: boolean, autoYes: boolean, interactive: boolean }} options
 * @returns {boolean} true when the release script should prompt for a version override.
 */
export function shouldPromptForVersion({ dryRun, autoYes, interactive }) {
  if (autoYes) return false;
  if (dryRun) return interactive;
  return true;
}
