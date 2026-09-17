# FN-399 — Relevé de préflight (2026-09-15-00:14 UTC)

## Environnement

- Worktree : `.fusion/worktrees/fn-399`, HEAD `a8b19e1f6` (FN-396), contient FN-394/395/396/398/400.
- Dépendances : `node_modules/.modules.yaml` présent et `packages/dashboard/node_modules` résolu → `fn_install_worktree_dependencies` = `action="none"` (les dépendances déclarées sont déjà disponibles ; aucune nouvelle dépendance n'est ajoutée par cette tâche).
- Navigateur : `/usr/bin/google-chrome` (Google Chrome 152.0.7977.64) et le Chromium de `playwright-core`
  (`~/.cache/ms-playwright/chromium-1223/chrome-linux/chrome`) sont présents → la lane
  `dashboard-browser-touch` est exécutable, aucune substitution non bloquante n'est requise a priori.

## Prémisses vérifiées

| Prémisse | État |
| --- | --- |
| `AlphaContext.tsx` contient `createContext<AlphaState>({ enabled: true, surfaceActive: false })` | ✅ présent |
| `useTheme.ts` exporte `getThemeInitScript()` | ✅ présent |
| `TaskDetailModal.tsx` contient `const [planDocumentOpen, setPlanDocumentOpen] = useState(false);` | ✅ présent |
| `taskProgress.ts` exporte `UnifiedTaskProgressStatus` | ✅ présent |

## Cartographie du périmètre Alpha (code de production)

### Mécanique de périmètre

- `app/context/AlphaContext.tsx` — `AlphaProvider` (valeur constante `{enabled:true, surfaceActive:false}`),
  `AlphaBoundary` (`{enabled:true, surfaceActive:true}` + `<div data-alpha-surface="true">`), `useAlphaSurface`.
- Montages de boundary réellement actifs : `App.tsx` (`AlphaProvider`), `Board.tsx`, `ChatView.tsx`,
  `TaskDetailModal.tsx` (4 occurrences : racine + 2 sous-arbres + fermeture).
- **Constat clé** : `surfaceActive` est `false` hors boundary, donc les primitives ont deux variantes
  réellement atteignables. Les quatre lecteurs directs sont `CustomModelDropdown`, `WorkflowSwitcher`,
  `TaskContextMenu`, `QuickEntryBox`, plus `AlphaPrimitives` lui-même.

### Primitives

- `app/components/alpha-ui/AlphaPrimitives.tsx` (304 lignes) + `index.ts`.
- 19 exports `Alpha*` consommés par 30 composants de production (liste complète dans la Surface Enumeration du spec).
- Différences de variantes constatées : marqueur `data-alpha-ui`, portail `document.body` pour
  `AlphaPopoverSurface`, `tabIndex` de collection (roving focus), transfert/restauration de focus de `AlphaMenu`.

### Feuille de style

- `app/alpha-ui.css` (211 lignes) — importée par `app/main.tsx` et la fixture e2e.
  - `[data-alpha-surface] { display: contents }`
  - **Cause racine du symptôme** : deux palettes fixes `--alpha-neutral-*` (light/dark) puis un `@scope`
    qui réécrit `--bg`, `--surface*`, `--card`, `--border`, `--text*`, `--accent`, `--todo`/`--triage`/…,
    `--status-*-bg`, `--badge-*`, `--radius-*`, `--shadow-*`, `--focus-ring*` sur
    `[data-alpha-surface="true"], [data-alpha-portal="true"]`. Tant que ce bloc existe, aucun
    `data-color-theme` ne peut recolorer Board, Chat, Task Detail ni leurs portails.
  - Règle morte constatée : aucune règle `[data-alpha-surface="false"]` ne subsiste dans ce fichier
    (le sélecteur d'attribut nu `[data-alpha-surface]` couvre les deux valeurs) ; la valeur `"false"`
    n'est jamais écrite par le code de production.

### Formes imposées par les thèmes couleur

- `app/public/theme-data.css` (8677 lignes) déclare, en plus des couleurs, des `--space-*`, `--radius-*`,
  `--btn-padding`, `--btn-border-width`, `--card-padding`, `--modal-padding`, `--header-padding`,
  `--column-gap`, `--board-padding`, `--shadow-*` (géométrie), `--transition-*`, et des règles
  descendantes de `font-family`, `font-size`, `font-weight`, `letter-spacing`, `border-width`,
  `animation` sous `[data-color-theme="air"]`, `[data-color-theme^="shadcn"]`, factory, etc.
- Ces déclarations sont incompatibles avec deux axes indépendants : elles migrent vers le catalogue
  `ui-style-tokens.css`, les presets couleur ne conservant que leurs couleurs.

### Shell et classes

- Composants : `AlphaDesktopActionBar.{tsx,css}`, `AlphaMobileDrawer.{tsx,css}`,
  `hooks/useAlphaDesktopViewWindows.ts`.
- Attributs/classes : `data-alpha-mobile-drawers`, `.mobile-nav-bar--alpha`,
  `.project-content--with-alpha-nav`, `--mobile-nav-alpha-system-offset`, `.task-detail-alpha-boundary`,
  `alpha-pilot:*` (clés transitoires), `.alpha-submenu-host`.

### Occurrences SANS rapport avec le déploiement Alpha (à conserver)

- `alphanumeric` / `alphanumérique` (validation d'identifiants) dans `packages/core`.
- Données de test nommées « Alpha » (`Agent Alpha`, `Project Alpha`, `alpha@…`) dans les fixtures core/dashboard.
- `docs/CODE_SIGNING.md`, `docs/plans/*`, `docs/proposals/*` — documents historiques.
- `WhiteboardView` : fonctionnalité indépendante, non concernée.

## Mesures « avant » (géométrie)

La correction de palette est une différence **attendue et documentée** ; seules les mesures de géométrie
du style `classic` doivent être stables. Les relevés navigateur sont produits à l'étape 8 par
`src/__tests__/ui-style-browser.test.ts`, qui compare les formes à palette changée et les palettes à
style changé sur les mêmes composants de production.
