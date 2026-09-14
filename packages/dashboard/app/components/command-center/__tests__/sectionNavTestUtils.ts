import { fireEvent, screen } from "@testing-library/react";

export function openCommandCenterSectionNav() {
  const rail = document.querySelector<HTMLElement>(".cc-section-nav--rail");
  if (rail) return rail;
  const trigger = screen.getByTestId("command-center-section-nav-trigger");
  if (!screen.queryByTestId("command-center-section-nav-menu")) fireEvent.click(trigger);
  return screen.getByTestId("command-center-section-nav-menu");
}

export function selectCommandCenterSection(id: string) {
  const navigation = openCommandCenterSectionNav();
  fireEvent.click(screen.getByTestId(`command-center-section-option-${id}`));
  if (!navigation.classList.contains("cc-section-nav--rail")) {
    expect(screen.queryByTestId("command-center-section-nav-menu")).toBeNull();
  }
}
