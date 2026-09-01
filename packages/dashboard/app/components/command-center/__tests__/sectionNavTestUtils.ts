import { fireEvent, screen } from "@testing-library/react";

export function openCommandCenterSectionNav() {
  const trigger = screen.getByTestId("command-center-section-nav-trigger");
  if (!screen.queryByTestId("command-center-section-nav-menu")) fireEvent.click(trigger);
  return screen.getByTestId("command-center-section-nav-menu");
}

export function selectCommandCenterSection(id: string) {
  openCommandCenterSectionNav();
  fireEvent.click(screen.getByTestId(`command-center-section-option-${id}`));
  expect(screen.queryByTestId("command-center-section-nav-menu")).toBeNull();
}
