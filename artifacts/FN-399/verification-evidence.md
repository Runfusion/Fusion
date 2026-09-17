# FN-399 — Relevé de vérification (2026-09-15 UTC)

## Symptôme original et sa disparition

**Symptôme.** Le périmètre Alpha épinglait Board, Chat, Task Detail et leurs overlays portalisés sur une
palette neutre fixe (`--alpha-neutral-*` + un bloc `@scope` dans `alpha-ui.css`). Un changement de
`data-color-theme` ne pouvait donc pas les recolorer, et les anciennes suites affirmaient même cette
invariance (`AlphaBoundary.test.tsx`, `AlphaBoard.test.tsx`, `AlphaChat.test.tsx`).

**Preuve de la correction**, mesurée dans un vrai moteur de rendu par
`packages/dashboard/src/__tests__/ui-style-browser.test.ts` sur des composants de production
(`TaskDetailContent` + primitives natives) :

À style fixé (`clean`), en passant de `cozy-cartoon` à `shadcn-purple` :

| Valeur composée | cozy-cartoon | shadcn-purple |
| --- | --- | --- |
| `bodyBackground` | `rgba(255, 255, 255, 0.992)` | `rgba(255, 255, 255, 0.925)` |
| `surfaceColor` | `rgb(23, 26, 30)` | `rgb(11, 12, 14)` |
| `buttonColor` | `rgb(23, 26, 30)` | `rgb(11, 12, 14)` |
| `optionColor` | `rgb(15, 16, 19)` | `rgb(0, 0, 0)` |

…tandis que **toutes** les mesures de forme restent identiques (`shape identical: true`).

## Indépendance des deux axes

À thème fixé (`shadcn-purple`), en passant de `classic` à `clean`, seules les **formes** bougent :
`surfacePadding`, `buttonPadding`, `tabPadding`, `tabsGap`. Les surfaces peintes (fond du corps, fond et
bordure de carte, fond de bouton) gardent exactement la même teinte.

**Différence mesurée et assumée :** le style épuré attribue des *rôles de texte* plus discrets issus de la
même palette (muted plutôt que primaire) au chrome secondaire — onglets inactifs et texte hérité. C'est une
décision d'emphase qui appartient à l'axe style, pas une décision de palette ; chaque valeur reste une
couleur résolue depuis le thème, jamais une couleur littérale (le catalogue n'en contient aucune, ce que
prouve séparément `app/__tests__/ui-style-contract.test.ts`).

## Matrice capturée

`artifacts/FN-399/browser/` contient **16 captures réelles** couvrant
`classic|clean × cozy-cartoon|shadcn-purple × light|dark × desktop(1440×900)|mobile(390×844)`,
plus `matrix.json` (toutes les valeurs composées, chacune vérifiée non vide).

`preset-shape-invariance.json` mesure huit presets couleur (`default`, `ocean`, `factory`, `brutalist`,
`terminal`, `cozy-cartoon`, `shadcn-purple`, `air`) à style fixé : ils rendent tous **exactement la même
géométrie**, ce qui prouve qu'aucun preset n'impose plus de forme.

## Portes de qualité

| Vérification | Résultat |
| --- | --- |
| `pnpm lint` | ✅ 0 erreur, 0 avertissement |
| `pnpm typecheck` | ✅ |
| `pnpm build` | ✅ |
| `pnpm check:changesets` | ✅ |
| `pnpm i18n:sync` / `i18n:types` / `i18n:status` | ✅ parité intacte, 7 catalogues |
| Lane navigateur `ui-style-browser` | ✅ 4/4 |

## Échecs préexistants (non causés par cette tâche, vérifiés par comparaison avec la base)

Mesurés en restaurant `packages/dashboard` à l'état d'avant la tâche puis en relançant :

- `app/components/__tests__/App.test.tsx` — 8 échecs avant comme après (recherche desktop, bascule de vue).
- `src/__tests__/task-modal-touch-resize-browser.test.ts` — 26 échecs avant (géométrie de fenêtres, FN-394).
- `app/components/settings/sections/ModelPricingSection.test.tsx`,
  `settings-search-index.test.ts`, `SystemControlsArea.test.tsx` — 4 échecs avant.
- `app/components/__tests__/TaskDetailModal.css.test.ts` — 1 échec avant.
- `app/__tests__/space-token-defined.test.ts` — corrigé au passage (`--space-2xs` non défini dans ChatView).

Ces suites ne sont pas élargies par cette tâche ; leurs échecs sont enregistrés ici plutôt que masqués.
