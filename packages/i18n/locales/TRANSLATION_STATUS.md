# Translation status

`en` is the authored source-of-truth. The non-English locales below were
**machine-drafted and have NOT been reviewed by a human translator.** They are
shipped so the feature is end-to-end exercisable, but each string should be
reviewed (and corrected where needed) by a fluent speaker before being treated
as production-quality.

| Locale | Script / region          | Status              |
| ------ | ------------------------ | ------------------- |
| `en`   | English (source)         | Authored            |
| `zh-CN`| Simplified Chinese       | Machine-drafted ⚠️  |
| `zh-TW`| Traditional Chinese (TW) | Machine-drafted ⚠️  |
| `fr`   | French                   | Machine-drafted ⚠️  |
| `es`   | Spanish                  | Machine-drafted ⚠️  |
| `ko`   | Korean                   | Machine-drafted ⚠️  |
| `pt-BR`| Brazilian Portuguese     | Machine-drafted ⚠️  |

Notes for reviewers:

- `zh-CN` and `zh-TW` are **independent** catalogs — different script *and*
  vocabulary (e.g. zh-CN 项目/任务/加载 vs zh-TW 專案/工作/載入). Do not machine-convert
  one into the other.
- Preserve interpolation placeholders verbatim: `{{brand}}`, `{{detail}}`,
  `{{key}}`. The `{{brand}}` token is filled at runtime so the kb→fn rename can
  sweep the product name without touching catalogs.
- Keybinding accelerators inside hints (e.g. `[{{key}}]`) must stay as the
  literal key — translate only the surrounding words.
- `pt-BR` is Brazilian Portuguese specifically. European Portuguese (pt-PT)
  differs in vocabulary, orthography, and register — do not machine-convert one
  into the other.
