import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/**
 * Viewport chrome alignment (mobile shell vs desktop shell).
 *
 * Surface enumeration:
 * - Left sidebar visibility (LeftSidebarNav.css)
 * - Mobile navigation pill visibility (MobileNavBar.css)
 * - Executor footer bottom stacking above the pill (ExecutorStatusBar.css)
 * - Footer height token on project-content (ProjectSelector.css + ExecutorStatusBar.css)
 * - Right dock hide/show (RightDock.css)
 * - data-viewport-mode publisher (useViewportMode.ts)
 *
 * FN-468 : la frontière « interface mobile / interface ordinateur » est à 1024 px. Le shell mobile couvre donc
 * 0–1023.98 px, TABLETTE COMPRISE : la pill flottante s'y affiche et les trois surfaces larges (colonne de gauche,
 * pied de page large, dock droit) n'existent qu'à partir de 1024 px. Ce bras CSS est le second de DEUX verrous ;
 * le premier est le prédicat de montage de `MobileNavBar`, couvert par ses propres tests de composant.
 */

const css = loadAllAppCss();

const MOBILE_SHELL_ARM = String.raw`html:is\(\[data-viewport-mode="mobile"\],\s*\[data-viewport-mode="tablet"\]\)`;
const DESKTOP_ARM = String.raw`html\[data-viewport-mode="desktop"\]`;

describe("viewport chrome mode alignment", () => {
  // Cas (k) : le bras incluant `tablet` masque la colonne de gauche et affiche la pill.
  it("hides the left column across the whole mobile shell and keeps it on desktop", () => {
    expect(css).toMatch(new RegExp(String.raw`${DESKTOP_ARM}\s*\.left-sidebar-nav\s*\{[^}]*display:\s*flex`));
    expect(css).toMatch(new RegExp(String.raw`${MOBILE_SHELL_ARM}\s*\.left-sidebar-nav\s*\{[^}]*display:\s*none`));
    // Le repli sans JS / premier rendu suit la même frontière que le classificateur mesuré.
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*1023\.98px\s*\)\s*\{[\s\S]*?\.left-sidebar-nav\s*\{[^}]*display:\s*none/);
  });

  it("shows the navigation pill across the whole mobile shell and never on desktop", () => {
    expect(css).toMatch(new RegExp(String.raw`${MOBILE_SHELL_ARM}\s*\.mobile-nav-bar\s*\{[^}]*display:\s*flex`));
    expect(css).toMatch(new RegExp(String.raw`${DESKTOP_ARM}\s*\.mobile-nav-bar\s*\{[^}]*display:\s*none`));
    // Repli sans JS / premier rendu : la pill s'affiche jusqu'à 1023.98px.
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*1023\.98px\s*\)\s*\{[\s\S]*?\.mobile-nav-bar\s*\{[^}]*display:\s*flex/);
  });

  // Cas (l) : le bras `desktop` conserve le pied de page à sa position basse et son gabarit.
  it("pins the executor footer to the true bottom on desktop mode only", () => {
    expect(css).toMatch(
      new RegExp(String.raw`${DESKTOP_ARM}\s*\.executor-status-bar\s*\{[^}]*bottom:\s*var\(--icb-bottom-offset,\s*0px\)`),
    );
    expect(css).toMatch(new RegExp(String.raw`${DESKTOP_ARM}\s*\.executor-status-bar\s*\{[^}]*height:\s*36px`));
    // Le shell mobile (téléphone ET tablette) empile toujours la barre au-dessus de la pill.
    expect(css).toMatch(
      new RegExp(String.raw`${MOBILE_SHELL_ARM}\s*\.executor-status-bar\s*\{[\s\S]*?bottom:\s*calc\([^)]*var\(--mobile-nav-height\)`),
    );
  });

  it("keeps the desktop footer-height token for desktop mode after mobile-shell overrides", () => {
    // May share a declaration block with .dashboard-project-shell (comma selector).
    expect(css).toMatch(
      new RegExp(String.raw`${DESKTOP_ARM}\s*\.project-content--with-footer[\s\S]{0,180}?\{[^}]*--executor-footer-height:\s*36px`),
    );
    expect(css).toMatch(
      new RegExp(
        String.raw`${MOBILE_SHELL_ARM}\s*\.project-content--with-footer\s*\{[^}]*--executor-footer-height:\s*calc\(var\(--space-lg\)\s*\*\s*2\s*\+\s*var\(--space-xs\)\)`,
      ),
    );
  });

  it("aligns the right dock with the mobile shell boundary", () => {
    expect(css).toMatch(new RegExp(String.raw`${MOBILE_SHELL_ARM}\s*\.right-dock\s*\{[^}]*display:\s*none`));
    expect(css).toMatch(new RegExp(String.raw`${DESKTOP_ARM}\s*\.right-dock\s*\{[^}]*display:\s*flex`));
  });

  /*
   * FN-468 : le sélecteur de projet n'est PAS une surface de navigation primaire. Le Header continue de le rendre
   * au-dessus de la bande téléphone, donc la tablette doit le conserver — sinon le changement de projet deviendrait
   * inatteignable sur tablette.
   */
  it("keeps the project selector reachable on tablet", () => {
    expect(css).toMatch(
      /html:is\(\[data-viewport-mode="tablet"\],\s*\[data-viewport-mode="desktop"\]\)\s*\.project-selector\s*\{[^}]*display:\s*inline-flex/,
    );
  });
});
