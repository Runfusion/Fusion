import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEADER_WORKFLOW_SLOT_ID, useHeaderWorkflowSlot } from "../useHeaderWorkflowSlot";

/*
FNXC:WorkflowControls 2026-09-15-01:44:
FN-405 regression coverage for the shared header workflow slot resolver. The defect this guards is a
slot that mounts AFTER the consuming view (or is replaced on a breakpoint swap): the old per-consumer
resolution resolved once and never retried, so Board/List permanently fell back to the inline toolbar
rendered under the header.
*/

let observed: HTMLElement | null = null;
let renderCount = 0;

function Consumer({ enabled }: { enabled: boolean }) {
  observed = useHeaderWorkflowSlot({ enabled });
  renderCount += 1;
  return null;
}

function mountSlot(className = "header-workflow-slot"): HTMLElement {
  const slot = document.createElement("div");
  slot.id = HEADER_WORKFLOW_SLOT_ID;
  slot.className = className;
  document.body.appendChild(slot);
  return slot;
}

/** Lets the MutationObserver microtask deliver its records inside React's act scope. */
async function flushObserver(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  observed = null;
  renderCount = 0;
  document.body.innerHTML = "";
});

afterEach(() => {
  // Unmount before clearing the body: otherwise the observer sees the teardown removal and publishes
  // a state update outside React's act scope.
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useHeaderWorkflowSlot", () => {
  it("returns an already-mounted slot on the first render", () => {
    const slot = mountSlot();
    render(<Consumer enabled />);
    expect(observed).toBe(slot);
  });

  it("returns a slot inserted after mount without any forced consumer re-render", async () => {
    render(<Consumer enabled />);
    expect(observed).toBeNull();

    const slot = mountSlot();
    await flushObserver();

    expect(observed).toBe(slot);
  });

  it("re-resolves when the slot is replaced by another node with the same id", async () => {
    const mobileSlot = mountSlot("header-workflow-slot header-workflow-slot--mobile");
    render(<Consumer enabled />);
    expect(observed).toBe(mobileSlot);

    const desktopSlot = document.createElement("div");
    desktopSlot.id = HEADER_WORKFLOW_SLOT_ID;
    desktopSlot.className = "header-workflow-slot";
    mobileSlot.remove();
    document.body.appendChild(desktopSlot);
    await flushObserver();

    expect(observed).toBe(desktopSlot);
    expect(observed).not.toBe(mobileSlot);
    expect(observed?.isConnected).toBe(true);
  });

  it("drops a cached slot once it is removed from the document", async () => {
    const slot = mountSlot();
    render(<Consumer enabled />);
    expect(observed).toBe(slot);

    slot.remove();
    await flushObserver();

    expect(observed).toBeNull();
  });

  it("resolves nothing and schedules no timer when disabled", () => {
    vi.useFakeTimers();
    mountSlot();
    render(<Consumer enabled={false} />);

    expect(observed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying and stays null when the slot never appears", () => {
    vi.useFakeTimers();
    render(<Consumer enabled />);
    expect(observed).toBeNull();

    act(() => {
      vi.advanceTimersByTime(250 * 25);
    });

    expect(observed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its retry timer on unmount", () => {
    vi.useFakeTimers();
    const view = render(<Consumer enabled />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-render the consumer while the resolved node identity is unchanged", async () => {
    mountSlot();
    render(<Consumer enabled />);
    const rendersAfterResolve = renderCount;

    document.body.appendChild(document.createElement("span"));
    await flushObserver();

    expect(renderCount).toBe(rendersAfterResolve);
  });

  /*
  FNXC:BoardNavigation 2026-09-18-02:12:
  FN-522 — une vue conservée ne se remonte pas : sa réactivation repart de l'état `null` publié lors de sa
  désactivation, et le `useState` initial ne la couvre donc pas. Ces cas décrivent les ORDONNANCEMENTS de cette
  réactivation : cible déjà montée, cible créée dans le même commit, cible remplacée ou réinsérée pendant
  l'inactivité, cible durablement absente, désactivation ou démontage avant une observation, et StrictMode.

  Ils ne prouvent PAS la propriété « avant peinture » : `act` vide aussi les effets passifs, donc un rendu de test
  ne distingue pas les deux phases. Cette preuve vit dans
  `app/components/dashboard/__tests__/MainContent.board-return-layout.test.tsx` (événement hors `act`) et dans
  `src/__tests__/board-return-browser.test.ts` (mesure par frame dans un vrai moteur).
  */
  describe("réactivation d'une vue conservée", () => {
    it("republie une cible déjà montée dès le commit de réactivation", () => {
      const slot = mountSlot();
      const view = render(<Consumer enabled />);
      expect(observed).toBe(slot);

      view.rerender(<Consumer enabled={false} />);
      expect(observed).toBeNull();

      view.rerender(<Consumer enabled />);
      // Aucun `flushObserver` : la cible est publiée sans attendre observateur, minuterie ni effet passif.
      expect(observed).toBe(slot);
    });

    it("résout une cible montée dans le MÊME commit que la réactivation", () => {
      const view = render(
        <>
          <Consumer enabled={false} />
        </>,
      );
      expect(observed).toBeNull();

      /*
      Le Header recrée son slot dans le commit où la vue redevient active. La cible n'existe donc pas pendant le
      rendu, seulement après les mutations DOM — c'est précisément ce que la phase de layout voit.
      */
      function Host({ enabled }: { enabled: boolean }) {
        return (
          <>
            {enabled ? <div id={HEADER_WORKFLOW_SLOT_ID} className="header-workflow-slot" /> : null}
            <Consumer enabled={enabled} />
          </>
        );
      }

      view.rerender(<Host enabled />);
      const slot = document.getElementById(HEADER_WORKFLOW_SLOT_ID);
      expect(slot).not.toBeNull();
      expect(observed).toBe(slot);
    });

    it("adopte la cible remplacée pendant l'inactivité plutôt que l'ancienne", () => {
      const first = mountSlot();
      const view = render(<Consumer enabled />);
      expect(observed).toBe(first);

      view.rerender(<Consumer enabled={false} />);
      first.remove();
      const second = mountSlot();

      view.rerender(<Consumer enabled />);
      expect(observed).toBe(second);
      expect(observed).not.toBe(first);
    });

    it("retrouve une cible retirée puis réinsérée pendant l'inactivité", () => {
      const first = mountSlot();
      const view = render(<Consumer enabled />);
      view.rerender(<Consumer enabled={false} />);
      first.remove();
      const reinserted = mountSlot();

      view.rerender(<Consumer enabled />);
      expect(observed).toBe(reinserted);
      expect(observed?.isConnected).toBe(true);
    });

    it("conserve le repli d'une cible durablement absente et n'installe qu'une reprise bornée", () => {
      vi.useFakeTimers();
      const view = render(<Consumer enabled={false} />);
      expect(vi.getTimerCount()).toBe(0);

      view.rerender(<Consumer enabled />);
      expect(observed).toBeNull();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      act(() => {
        vi.advanceTimersByTime(250 * 25);
      });
      expect(observed).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rend la cible inutilisable dès la désactivation, sans publication tardive vers l'ancien nœud", async () => {
      const slot = mountSlot();
      const view = render(<Consumer enabled />);
      expect(observed).toBe(slot);

      view.rerender(<Consumer enabled={false} />);
      expect(observed).toBeNull();

      // Une mutation de la vue quittée ne doit pas reprendre la propriété du slot depuis une vue inactive.
      document.body.appendChild(document.createElement("section"));
      await flushObserver();
      expect(observed).toBeNull();
    });

    it("ne publie rien après un démontage survenu avant la livraison d'une observation", async () => {
      const view = render(<Consumer enabled />);
      const slot = mountSlot();
      view.unmount();
      const afterUnmount = renderCount;

      await flushObserver();

      expect(renderCount).toBe(afterUnmount);
      expect(slot.isConnected).toBe(true);
    });

    it("reste stable sous StrictMode, où chaque effet est monté, démonté puis remonté", () => {
      const slot = mountSlot();
      const view = render(
        <StrictMode>
          <Consumer enabled />
        </StrictMode>,
      );
      expect(observed).toBe(slot);

      view.rerender(
        <StrictMode>
          <Consumer enabled={false} />
        </StrictMode>,
      );
      expect(observed).toBeNull();

      view.rerender(
        <StrictMode>
          <Consumer enabled />
        </StrictMode>,
      );
      expect(observed).toBe(slot);
    });
  });
});
