/**
 * FNXC:CodeOrganization 2026-07-22-17:00:
 * Domain folder layout for @fusion/core source (mirrors types/* organization).
 *
 * Root keepers (stable public entry):
 *   index.ts / index.gate.ts / types.ts / store.ts
 *   gh-cli.ts + detect-content-language.ts (package subpath shims)
 *
 * Domain folders:
 *   agents/ ai/ async-stores/ automation/ backup/ board/ branch/
 *   central/ chat/ cli/ config/ db/ docker/ duplicates/ eval/ git/
 *   goals/ i18n/ ideation/ insights/ memory/ merge/ mesh/ missions/
 *   planner/ plugins/ postgres/ process/ research/ sandbox/ secrets/
 *   stores/ task-store/ tasks/ types/ workflows/
 *
 * Import via @fusion/core barrel when possible; deep paths use domain folders.
 */
export {};
