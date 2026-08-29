import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import realEnApp from "../../../../i18n/locales/en/app.json";
import { MailboxRelatedWorkLink } from "../MailboxRelatedWorkLink";

async function createRealCatalogInstance() {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: ["app"],
    defaultNS: "app",
    returnNull: false,
    returnEmptyString: false,
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
    resources: { en: { app: realEnApp } },
  });
  return instance;
}

describe("MailboxRelatedWorkLink", () => {
  it("opens a task when task metadata and its handler are available", () => {
    const onOpenTask = vi.fn();
    render(<MailboxRelatedWorkLink metadata={{ taskId: "FN-8428" }} onOpenTask={onOpenTask} />);

    fireEvent.click(screen.getByTestId("mailbox-view-task"));
    expect(onOpenTask).toHaveBeenCalledWith("FN-8428");
  });

  it("interpolates task and planning-session destinations against the shipping English catalog", async () => {
    const instance = await createRealCatalogInstance();
    const onOpenTask = vi.fn();
    const onOpenPlanningSession = vi.fn();
    const { rerender, container } = render(
      <I18nextProvider i18n={instance}>
        <MailboxRelatedWorkLink metadata={{ taskId: "FN-8428" }} onOpenTask={onOpenTask} />
      </I18nextProvider>,
    );

    const taskLink = screen.getByTestId("mailbox-view-task");
    expect(taskLink).toHaveTextContent("View task FN-8428");
    expect(taskLink).toHaveAccessibleName("View task: FN-8428");
    expect(container.textContent).not.toContain("{{");
    fireEvent.click(taskLink);
    expect(onOpenTask).toHaveBeenCalledWith("FN-8428");

    rerender(
      <I18nextProvider i18n={instance}>
        <MailboxRelatedWorkLink
          metadata={{ kind: "planning-clarification", sessionId: "planning-8428" }}
          onOpenPlanningSession={onOpenPlanningSession}
        />
      </I18nextProvider>,
    );
    expect(screen.getByTestId("mailbox-open-planning-session")).toHaveAccessibleName("Open planning session: planning-8428");
  });

  it("opens a planning clarification session when no task target is available", () => {
    const onOpenPlanningSession = vi.fn();
    render(
      <MailboxRelatedWorkLink
        metadata={{ kind: "planning-clarification", sessionId: "planning-8428" }}
        onOpenPlanningSession={onOpenPlanningSession}
      />,
    );

    fireEvent.click(screen.getByTestId("mailbox-open-planning-session"));
    expect(onOpenPlanningSession).toHaveBeenCalledWith("planning-8428");
  });

  it("renders no control for ordinary messages or unavailable handlers", () => {
    const { rerender } = render(<MailboxRelatedWorkLink metadata={{ taskId: "FN-8428" }} />);
    expect(screen.queryByTestId("mailbox-view-task")).toBeNull();

    rerender(<MailboxRelatedWorkLink metadata={{ kind: "planning-clarification", sessionId: "planning-8428" }} />);
    expect(screen.queryByTestId("mailbox-open-planning-session")).toBeNull();

    rerender(<MailboxRelatedWorkLink metadata={{ taskId: "   " }} onOpenTask={vi.fn()} />);
    expect(screen.queryByTestId("mailbox-view-task")).toBeNull();

    rerender(<MailboxRelatedWorkLink metadata={{ kind: "ordinary" }} onOpenTask={vi.fn()} onOpenPlanningSession={vi.fn()} />);
    expect(screen.queryByTestId("mailbox-view-task")).toBeNull();
    expect(screen.queryByTestId("mailbox-open-planning-session")).toBeNull();
  });

  it("prefers the task destination when both valid targets exist", () => {
    const onOpenTask = vi.fn();
    const onOpenPlanningSession = vi.fn();
    render(
      <MailboxRelatedWorkLink
        metadata={{ kind: "planning-clarification", taskId: "FN-8428", sessionId: "planning-8428" }}
        onOpenTask={onOpenTask}
        onOpenPlanningSession={onOpenPlanningSession}
      />,
    );

    fireEvent.click(screen.getByTestId("mailbox-view-task"));
    expect(onOpenTask).toHaveBeenCalledWith("FN-8428");
    expect(onOpenPlanningSession).not.toHaveBeenCalled();
  });
});
