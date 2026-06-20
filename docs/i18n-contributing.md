# Localization (i18n) contributor guide

Fusion's UI is localized with [react-i18next]. English (`en`) is the
source-of-truth language; everything else is a translation of it. Both UI
surfaces — the React dashboard and the Ink terminal UI — share one set of
catalogs and config in the `@fusion/i18n` package.

## Where things live

| Path | What it is |
| ---- | ---------- |
| `packages/i18n/locales/{locale}/{namespace}.json` | Authored catalogs (translators edit here). `en` is the source. |
| `packages/i18n/src/config.ts` | Shared i18next config: namespaces, fallback chain, plural setup. |
| `packages/core` (`SUPPORTED_LOCALES`, `Locale`) | The single list of supported locale codes. |
| `i18next.config.ts` (repo root) | `i18next-cli` workflow config. |

Namespaces: `common` (shared), `app` (dashboard-only), `errors`, and `cli`
(terminal-only). The dashboard loads `common`/`app`/`errors`; the CLI loads
`common`/`cli`/`errors`.

## The workflow

All commands run from the repo root:

```bash
pnpm i18n:extract   # pull t()/<Trans> keys from source into the en catalogs
pnpm i18n:sync      # propagate the en key structure to every other locale
pnpm i18n:types     # regenerate key types from the en catalogs
pnpm i18n:status    # per-locale completion report
pnpm i18n:lint      # flag hardcoded user-facing strings
pnpm i18n:gen-cli   # regenerate the CLI static catalog import map
```

## Lint baseline policy

`pnpm i18n:lint` is the hardcoded user-facing string guardrail and must stay
green. Its file scope intentionally matches extraction: tests and stories are
excluded because they are non-shipping fixtures and `extract` already ignores
them. Suppress non-translatable token categories with narrow
`lint.ignoredTags` / `lint.ignoredAttributes` entries, such as keyboard-key
content in `<kbd>`, instead of hiding source directories.

Any remaining user-facing copy must be localized with `t()` / `<Trans>` and an
`en` catalog entry. A temporary deferral is only acceptable when it is scoped to
specific files or a small cluster in `lint.ignore`, includes an `FNXC` rationale,
and has a filed follow-up task that removes the ignore.

## Translating an existing language

1. Run `pnpm i18n:sync` so every catalog has the current `en` keys (untranslated
   entries are empty strings).
2. Fill the empty strings in `packages/i18n/locales/{locale}/*.json`.
3. Keep interpolation placeholders verbatim: `{{brand}}`, `{{detail}}`,
   `{{key}}`. Never translate a `[{{key}}]` keybinding accelerator — only the
   words around it.
4. `pnpm i18n:status` to confirm the locale is complete.

`zh-CN` and `zh-TW` are independent — different script **and** vocabulary. Do
not machine-convert one into the other.

## Adding a new language (near-zero code)

1. Add the locale code to `SUPPORTED_LOCALES` in `packages/core/src/types.ts`
   and to `locales` in `i18next.config.ts`.
2. `pnpm i18n:sync` — scaffolds a full set of catalog files for the new locale
   with the correct plural categories.
3. `pnpm i18n:gen-cli` — adds the locale to the CLI's static import map.
4. Translate the new catalogs, then `pnpm i18n:status` to verify.

No feature code changes are required: the dashboard discovers the locale through
the generated `app/locales/` tree, and the CLI through the regenerated import
map. Add the language's endonym to `ENDONYMS` in
`packages/dashboard/app/components/LanguageSelector.tsx` so it appears in the
Settings switcher.

## Using a non-English locale

- **Dashboard / mobile:** Settings → Appearance → Language. The choice persists
  to `localStorage` and to server settings.
- **Terminal UI:** resolved from `--lang <code>` → the saved dashboard language
  setting → the `LC_ALL`/`LC_MESSAGES`/`LANG`/`LANGUAGE` environment → `en`.

  ```bash
  fusion dashboard --lang zh-TW
  ```

[react-i18next]: https://react.i18next.com/
