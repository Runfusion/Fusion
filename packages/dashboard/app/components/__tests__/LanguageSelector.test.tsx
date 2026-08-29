import { SUPPORTED_LOCALES } from "@fusion/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLanguage } from "../../hooks/useLanguage";

vi.mock("../../hooks/useLanguage", () => ({ useLanguage: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));

const { LanguageSelector } = await import("../LanguageSelector");
const mockUseLanguage = vi.mocked(useLanguage);
const setLanguage = vi.fn();
const clearLanguage = vi.fn();

describe("LanguageSelector", () => {
  beforeEach(() => {
    setLanguage.mockClear();
    clearLanguage.mockClear();
    mockUseLanguage.mockReturnValue({
      language: "en",
      supportedLocales: SUPPORTED_LOCALES,
      setLanguage,
      clearLanguage,
      hasExplicitChoice: true,
    });
  });

  it("renders all seven language endonyms", () => {
    render(<LanguageSelector />);
    for (const name of ["English", "简体中文", "繁體中文", "Français", "Español", "한국어", "Português (Brasil)"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("marks the active locale as pressed", () => {
    render(<LanguageSelector />);
    expect(screen.getByText("English").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Français").getAttribute("aria-pressed")).toBe("false");
  });

  it("calls setLanguage with the selected locale code", () => {
    render(<LanguageSelector />);
    fireEvent.click(screen.getByText("简体中文"));
    expect(setLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("offers an Auto option that clears the explicit choice", () => {
    render(<LanguageSelector />);
    const auto = screen.getByText("Auto");
    expect(auto.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(auto);
    expect(clearLanguage).toHaveBeenCalledTimes(1);
  });

  it("marks Auto as pressed (and no locale) when no explicit choice exists", () => {
    mockUseLanguage.mockReturnValue({
      language: "fr", // detected, not chosen
      supportedLocales: SUPPORTED_LOCALES,
      setLanguage,
      clearLanguage,
      hasExplicitChoice: false,
    });
    render(<LanguageSelector />);
    expect(screen.getByText("Auto").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Français").getAttribute("aria-pressed")).toBe("false");
  });
});
