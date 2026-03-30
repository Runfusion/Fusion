import { useState, useEffect, useCallback, useLayoutEffect } from "react";
import type { ThemeMode, ColorTheme } from "@kb/core";

const THEME_MODE_STORAGE_KEY = "kb-dashboard-theme-mode";
const COLOR_THEME_STORAGE_KEY = "kb-dashboard-color-theme";

// Check if we're in a browser environment
const isBrowser = typeof window !== "undefined";

// Use useLayoutEffect on client, useEffect on server (no-op)
const useIsomorphicLayoutEffect = isBrowser ? useLayoutEffect : useEffect;

interface UseThemeReturn {
  themeMode: ThemeMode;
  colorTheme: ColorTheme;
  setThemeMode: (mode: ThemeMode) => void;
  setColorTheme: (theme: ColorTheme) => void;
  isSystemDark: boolean;
}

/**
 * Get the effective theme mode (resolves "system" to actual dark/light value)
 */
function getEffectiveThemeMode(mode: ThemeMode, systemIsDark: boolean): "dark" | "light" {
  if (mode === "system") {
    return systemIsDark ? "dark" : "light";
  }
  return mode;
}

/**
 * Apply theme attributes to document.documentElement
 * Call this immediately to prevent flash of wrong theme
 */
function applyThemeAttributes(themeMode: ThemeMode, colorTheme: ColorTheme, systemIsDark: boolean): void {
  if (!isBrowser) return;

  const effectiveMode = getEffectiveThemeMode(themeMode, systemIsDark);
  document.documentElement.setAttribute("data-theme", effectiveMode);
  document.documentElement.setAttribute("data-color-theme", colorTheme);
}

/**
 * Custom hook for theme management
 * Handles localStorage persistence, system preference detection, and theme application
 */
export function useTheme(): UseThemeReturn {
  // Initialize from localStorage or defaults
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    if (!isBrowser) return "dark";
    try {
      const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
      if (saved === "dark" || saved === "light" || saved === "system") {
        return saved;
      }
    } catch {
      // localStorage not available, use default
    }
    return "dark";
  });

  const [colorTheme, setColorThemeState] = useState<ColorTheme>(() => {
    if (!isBrowser) return "default";
    try {
      const saved = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
      const validThemes: ColorTheme[] = [
        "default",
        "ocean",
        "forest",
        "sunset",
        "berry",
        "monochrome",
        "high-contrast",
        "solarized",
      ];
      if (saved && validThemes.includes(saved as ColorTheme)) {
        return saved as ColorTheme;
      }
    } catch {
      // localStorage not available, use default
    }
    return "default";
  });

  // Track system color scheme preference
  const [isSystemDark, setIsSystemDark] = useState<boolean>(() => {
    if (!isBrowser) return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  // Listen to system color scheme changes
  useEffect(() => {
    if (!isBrowser) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setIsSystemDark(e.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Apply theme immediately on mount and when theme changes
  useIsomorphicLayoutEffect(() => {
    applyThemeAttributes(themeMode, colorTheme, isSystemDark);
  }, [themeMode, colorTheme, isSystemDark]);

  // Persist theme to localStorage
  useEffect(() => {
    if (!isBrowser) return;
    try {
      localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    } catch {
      // localStorage not available, skip persistence
    }
  }, [themeMode]);

  useEffect(() => {
    if (!isBrowser) return;
    try {
      localStorage.setItem(COLOR_THEME_STORAGE_KEY, colorTheme);
    } catch {
      // localStorage not available, skip persistence
    }
  }, [colorTheme]);

  // Wrapper setters
  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
  }, []);

  const setColorTheme = useCallback((theme: ColorTheme) => {
    setColorThemeState(theme);
  }, []);

  return {
    themeMode,
    colorTheme,
    setThemeMode,
    setColorTheme,
    isSystemDark,
  };
}

/**
 * Utility to apply theme before React hydration
 * Call this in a script tag in index.html to prevent theme flash
 */
export function getThemeInitScript(): string {
  return `
    (function() {
      try {
        var mode = localStorage.getItem('${THEME_MODE_STORAGE_KEY}') || 'dark';
        var colorTheme = localStorage.getItem('${COLOR_THEME_STORAGE_KEY}') || 'default';
        var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var effectiveMode = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
        document.documentElement.setAttribute('data-theme', effectiveMode);
        document.documentElement.setAttribute('data-color-theme', colorTheme);
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.documentElement.setAttribute('data-color-theme', 'default');
      }
    })();
  `;
}
