import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useViewportMode } from "./useViewportMode";

/*
FNXC:WorkflowControls 2026-09-15-01:44:
FN-405: Board, List, Graph, and the Planning/Missions header slot all portal their workflow selector
into the single `#header-workflow-slot` node Header mounts immediately left of the search button.
Each surface used to resolve that node its own way; Board and List resolved it exactly once per
`[active, workflowControlsInHeader, viewportMode]` change and never retried, so a header shell mounted
after the view — or a breakpoint swap that REPLACES the slot with a different node carrying the same
id — left the state `null` forever and the selector fell back to the inline `.board-workflow-toolbar`
rendered UNDER the header. A cached-then-detached node was the mirror defect: the portal targeted a
node outside the document, so the selector vanished.

This hook is the single resolution path. It resolves synchronously, re-resolves on viewport-mode
changes, retries on a bounded 20 × 250ms timer while no slot exists, and watches `document.body` for a
late-mounted or replaced slot. A cached node is abandoned as soon as `isConnected` is false. The inline
fallback is preserved ONLY for a genuinely absent slot; it must never be the resting state of a slot
that simply had not mounted yet.

FNXC:BoardNavigation 2026-09-18-02:12:
FN-522 — « en revenant de Planning ou Missions le board n'apparaît pas comme je l'ai laissé, comme s'il était
poussé par le header des éléments des autres vues ». Le `useState` initial ne couvre que le PREMIER montage : une
vue conservée reste montée, donc sa réactivation repart de l'état `null` publié quand `enabled` est passé à faux.
Avec un `useEffect` passif la résolution arrivait APRÈS la peinture, si bien que la première frame du retour
rendait le repli en ligne `.board-workflow-toolbar` sous le Header — mesuré dans un vrai Chromium : `#board` à
top=116/h=684 puis top=75/h=725 à la frame suivante, soit une bande parasite et un tableau raccourci.

La résolution appartient donc au cycle de LAYOUT : `useLayoutEffect` s'exécute après les mutations DOM du même
commit — le slot que le Header vient de monter est déjà là — et avant la peinture, donc aucune frame n'expose le
repli. La désactivation devient symétriquement synchrone : la cible est inutilisable avant la peinture suivante.
Aucun timer supplémentaire n'est introduit ; la reprise bornée et l'observation des remplacements tardifs restent
inchangées. `useEffect` reste utilisé hors navigateur, où les effets de layout n'existent pas.
*/

export const HEADER_WORKFLOW_SLOT_ID = "header-workflow-slot";

const RESOLVE_RETRY_INTERVAL_MS = 250;
const RESOLVE_MAX_ATTEMPTS = 20;

/**
 * Layout-phase resolution in the browser (pre-paint, so no frame can expose the inline fallback of a
 * reactivated keep-alive view); plain effect elsewhere, where layout effects do not run.
 */
const useResolveSlotEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

function readSlot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(HEADER_WORKFLOW_SLOT_ID);
}

export interface UseHeaderWorkflowSlotOptions {
  /** When false the hook resolves nothing and installs no timer/observer. */
  enabled: boolean;
}

/**
 * Resolves the shared header workflow portal slot, surviving a late-mounted, replaced, or detached
 * slot node. Returns `null` only when the header genuinely renders no slot.
 */
export function useHeaderWorkflowSlot({ enabled }: UseHeaderWorkflowSlotOptions): HTMLElement | null {
  const viewportMode = useViewportMode();
  const [slot, setSlot] = useState<HTMLElement | null>(() => (enabled ? readSlot() : null));
  // Mirrors the published node so an unchanged resolution never calls setState at all: the observer
  // fires on every unrelated body mutation, and a no-op setState would still schedule React work.
  const slotRef = useRef<HTMLElement | null>(slot);

  useResolveSlotEffect(() => {
    if (!enabled || typeof document === "undefined") {
      if (slotRef.current !== null) {
        slotRef.current = null;
        setSlot(null);
      }
      return;
    }

    let interval: number | undefined;
    let observer: MutationObserver | undefined;
    let attempts = 0;

    // Identity-only publication: re-rendering on an unchanged node would loop with the observer.
    const resolve = (): HTMLElement | null => {
      const next = readSlot();
      if (slotRef.current !== next) {
        slotRef.current = next;
        setSlot(next);
      }
      return next;
    };

    const stopRetrying = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };

    const resolved = resolve();

    if (!resolved) {
      interval = window.setInterval(() => {
        attempts += 1;
        if (resolve() || attempts >= RESOLVE_MAX_ATTEMPTS) stopRetrying();
      }, RESOLVE_RETRY_INTERVAL_MS);
    }

    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        // A replaced slot resolves to the new node; a removed slot resolves to null (and a detached
        // cached node is abandoned because `getElementById` can no longer return it).
        if (resolve()) stopRetrying();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      stopRetrying();
      observer?.disconnect();
    };
  }, [enabled, viewportMode]);

  // Defensive: never hand a detached node to `createPortal`.
  if (slot && !slot.isConnected) return null;
  return slot;
}
