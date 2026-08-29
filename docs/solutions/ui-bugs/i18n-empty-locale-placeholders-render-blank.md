---
title: Empty-string locale placeholders render blank UI (i18next returnEmptyString default)
date: 2026-06-05
category: ui-bugs
module: i18n
problem_type: ui_bug
component: frontend
symptoms:
  - "Buttons, labels, and dialog copy render completely blank in non-English locales"
  - "Inline English defaults passed to t(\"key\", \"Default\") are ignored — blank wins"
  - "No console errors; en locale looks perfect; only translated locales affected"
root_cause: wrong_api
resolution_type: config_fix
severity: high
related_components:
  - dashboard
  - tooling
tags: [i18next, returnEmptyString, locale-placeholders, translation-fallback, i18n-extract, catalog-pruning]
---

# Empty-string locale placeholders render blank UI (i18next returnEmptyString default)

## Problem

The repo's translator workflow backfills `""` placeholders into non-en catalogs for untranslated keys, on the assumption that empty values fall back to English at runtime. They don't: i18next's default `returnEmptyString: true` treats `""` as a *found* value, so es/fr/ko/zh users saw blank buttons, nav labels, and dialog copy for every new key — even though components pass inline English defaults (`t("key", "Default")`).

## Symptoms

- New UI strings render blank in any non-English locale while en looks correct.
- The inline second-argument default to `t()` does not rescue it — `""` short-circuits the fallback chain entirely.
- Verified empirically (i18next 26.x): `t("empty", "InlineDefault")` returns `""` when the active locale defines the key as `""`.

## What Didn't Work

- Assuming the standing convention was safe because hundreds of `""` placeholders pre-existed — the convention had been silently rendering blanks all along for any key reached in a non-en locale.
- Relying on inline `t()` defaults as a safety net — they only apply when the key is *missing*, not empty.

## Solution

One config line in the shared i18next init (`packages/i18n/src/config.ts`, `baseInitOptions()`):

```ts
returnEmptyString: false,
```

With this set, `""` values are treated as missing and fall through the fallback chain (`fallbackLng` → en, or the inline default). Locale files stay untouched, the `""`-placeholder translator convention keeps working, and every existing empty placeholder is fixed at once.

Empirical check that settles the question in seconds (run against `node_modules` i18next, initialized like the app):

```js
// lng: "fr", resources: { fr: { empty: "" }, en: { empty: "EnglishValue" } }
t("empty", "InlineDefault")
// returnEmptyString true  (default) → ""           ← blank UI
// returnEmptyString false           → "EnglishValue"
```

## Why This Works

i18next resolution asks "does the key exist with a usable value?" — `returnEmptyString` defines whether `""` is usable. The default (`true`) is meant for apps where empty is a legitimate translation; in a placeholder-backfill workflow it's exactly wrong, because every placeholder is an intentional "not translated yet" marker.

## Prevention

- When adopting any `""`-placeholder catalog convention, set `returnEmptyString: false` in the same commit — the two are a package deal.
- Don't trust the inline-`t()`-default mental model; prove fallback behavior with a 5-line init script before relying on it.
- **Related catalog trap (hit twice in the same PR):** `pnpm i18n:extract` prunes keys whose usages it cannot see (CLI/TUI surfaces, dynamic keys) — it deleted live keys like `taskFields.*` and `common.cancel` from `en/app.json`. After running extract, semantically diff catalogs against the base ref (flatten both JSONs, assert zero removed/changed keys vs upstream, only intended additions) before committing. The content sanity test `packages/i18n/src/__tests__/config.test.ts` ("has real en content") exists because of this; prefer hand-adding keys + `i18n:sync`/`i18n:types` over trusting `i18n:extract` output wholesale.
