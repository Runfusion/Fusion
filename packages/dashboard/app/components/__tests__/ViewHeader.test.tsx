import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { History } from "lucide-react";
import { ViewHeader } from "../ViewHeader";

function headerWithActions(actions?: ReactNode) {
  return render(<ViewHeader icon={History} title="History" actions={actions} />);
}

describe("ViewHeader", () => {
  it("rend une seule action Close accessible pour une vue flottante", () => {
    const onClose = vi.fn();
    render(<ViewHeader icon={History} title="History" titleId="history-title" onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "History" })).toHaveAttribute("id", "history-title");
    fireEvent.click(screen.getByRole("button", { name: "Close History" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ne réserve aucun groupe lorsque les actions sont absentes", () => {
    const { container, rerender } = headerWithActions();
    expect(container.querySelector(".view-header__actions")).toBeNull();
    rerender(<ViewHeader icon={History} title="History" actions={null} />);
    expect(container.querySelector(".view-header__actions")).toBeNull();
  });

  it("conserve zéro, une et plusieurs actions dans un seul groupe", () => {
    const { container, rerender } = headerWithActions(<button type="button">Une</button>);
    expect(container.querySelectorAll(".view-header__actions")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Une" })).toBeInTheDocument();
    rerender(<ViewHeader icon={History} title="History" actions={<><button type="button">Une</button><button type="button">Deux</button></>} />);
    expect(container.querySelectorAll(".view-header__actions button")).toHaveLength(2);
  });

  it("place le retour tactile avant un titre riche sans wrapper cliquable", async () => {
    const onBack = vi.fn();
    render(
      <ViewHeader
        icon={History}
        title={<><span>Historique</span><strong>FN-379</strong></>}
        titleTestId="rich-title"
        backAction={{ label: "Retour à la liste", onClick: onBack, "data-testid": "shared-back" }}
      />,
    );
    const header = screen.getByRole("banner");
    const back = screen.getByTestId("shared-back");
    const heading = screen.getByRole("heading", { name: /HistoriqueFN-379/ });
    expect(back.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(back.parentElement).toBe(header);
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
